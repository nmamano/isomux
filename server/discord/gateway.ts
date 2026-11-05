// The Discord gateway child (task 7fd44c30): one process per connected bot,
// spawned by server/discord/supervisor.ts with a minimal environment. It
// holds the gateway WebSocket (Bun's own, no package): HELLO and heartbeat,
// IDENTIFY, RESUME after a drop or an op 7, a fresh IDENTIFY after an op 9.
// It passes guilds, channels, threads and messages on as protocol.ts events
// and exits after a fatal close. The token arrives in the start command and
// never reaches its output.
//
// It runs apart from the office server because a throw in a WebSocket or a
// timer callback ends the process that holds it.

import {
  GATEWAY_CLOSE,
  channelKind,
  normaliseApiMessage,
  parseGatewayCommand,
  type GatewayCommand,
  type GatewayEvent,
} from "./protocol.ts";

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT.
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

// Closes after which the child exits with 1: the token, the intents, the
// shard or the API version is wrong, and a retry cannot fix it.
const FATAL_CLOSES = new Set<number>([
  GATEWAY_CLOSE.authenticationFailed,
  4010,
  4011,
  4012,
  4013,
  GATEWAY_CLOSE.disallowedIntents,
]);
// Closes after which the session cannot be resumed.
const FRESH_CLOSES = new Set<number>([4007, 4009]);
// Reconnects in a row with no ready or resumed: the child gives up and the
// supervisor's backoff takes over.
const MAX_RECONNECTS = 8;
const RECONNECT_WAIT_MAX_MS = 30_000;

export interface GatewayIO {
  // The commands from the server, one per line, until stdin ends.
  commands: AsyncIterable<GatewayCommand>;
  // Writes one event line.
  write(line: string): void;
  // Waits that are not heartbeats (before a fresh IDENTIFY, between
  // reconnects). Bun.sleep when absent.
  sleep?(ms: number): Promise<void>;
}

interface Payload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// The resume URL Discord gives carries no query.
function withQuery(url: string): string {
  return url.includes("?") ? url : `${url}?v=10&encoding=json`;
}

// Runs until a stop command, the end of stdin or a fatal close. The exit
// code: 0 after a stop or the end of stdin, 1 after a fatal close or too many
// reconnects.
export async function runGateway(io: GatewayIO): Promise<number> {
  const sleep = (ms: number) => (io.sleep ? io.sleep(ms) : Bun.sleep(ms));
  const emit = (event: GatewayEvent) => {
    try {
      io.write(JSON.stringify(event) + "\n");
    } catch {
      // The server is gone; the end of stdin stops the child.
    }
  };
  const log = (text: string) => emit({ ev: "log", text });

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));
  let done = false;

  let token = "";
  let url = "";
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let firstBeat: ReturnType<typeof setTimeout> | null = null;
  let acked = true;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let botUserId = "";
  const roleIds = new Map<string, string[]>();
  let reconnects = 0;

  function stopBeats(): void {
    if (heartbeat) clearInterval(heartbeat);
    if (firstBeat) clearTimeout(firstBeat);
    heartbeat = null;
    firstBeat = null;
  }

  function end(code: number): void {
    if (done) return;
    done = true;
    stopBeats();
    const open = ws;
    ws = null;
    try {
      open?.close(1000);
    } catch {
      // Already closed.
    }
    finish(code);
  }

  function send(socket: WebSocket, p: Payload): void {
    try {
      socket.send(JSON.stringify(p));
    } catch {
      // A closed socket: its close event reconnects.
    }
  }

  function beat(socket: WebSocket): void {
    if (!acked) {
      // No ack since the last beat: the connection is a zombie.
      // Bun gives no close event for a peer that answers nothing: drop the
      // socket and reconnect without waiting for one.
      log("gateway: no heartbeat ack, reconnecting");
      drop(socket, 4000);
      return;
    }
    acked = false;
    send(socket, { op: 1, d: seq });
  }

  function dispatch(t: string, d: unknown): void {
    if (!isObj(d)) return;
    switch (t) {
      case "READY": {
        const user = d.user;
        if (!isObj(user) || !isStr(user.id) || !isStr(user.username)) return;
        sessionId = isStr(d.session_id) ? d.session_id : null;
        resumeUrl = isStr(d.resume_gateway_url) ? d.resume_gateway_url : null;
        botUserId = user.id;
        reconnects = 0;
        emit({ ev: "ready", user: { id: user.id, name: user.username } });
        return;
      }
      case "RESUMED":
        reconnects = 0;
        emit({ ev: "resumed" });
        return;
      case "GUILD_CREATE": {
        if (!isStr(d.id) || !isStr(d.name)) return;
        const guildId = d.id;
        const channels = Array.isArray(d.channels) ? d.channels : [];
        const roles = Array.isArray(d.roles) ? d.roles : [];
        const botRoleIds = roles
          .filter(
            (r): r is Obj =>
              isObj(r) &&
              isStr(r.id) &&
              isObj(r.tags) &&
              r.tags.bot_id === botUserId,
          )
          .map((r) => r.id as string);
        roleIds.set(guildId, botRoleIds);
        emit({
          ev: "guild",
          guild: {
            id: guildId,
            name: d.name,
            channels: channels.flatMap((c) => {
              const channel = channelOf(c);
              return channel ? [channel] : [];
            }),
          },
          botRoleIds,
        });
        const threads = Array.isArray(d.threads) ? d.threads : [];
        for (const th of threads) threadEvent(guildId, th);
        return;
      }
      case "GUILD_DELETE":
        // unavailable: an outage, the bot is still in the server.
        if (isStr(d.id) && d.unavailable !== true) {
          roleIds.delete(d.id);
          emit({ ev: "guild-gone", guildId: d.id });
        }
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE": {
        if (!isStr(d.guild_id) || !isStr(d.id)) return;
        const channel = channelOf(d);
        if (channel) emit({ ev: "channel", guildId: d.guild_id, channel });
        else emit({ ev: "channel-gone", guildId: d.guild_id, channelId: d.id });
        return;
      }
      case "CHANNEL_DELETE":
        if (isStr(d.guild_id) && isStr(d.id))
          emit({ ev: "channel-gone", guildId: d.guild_id, channelId: d.id });
        return;
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        if (isStr(d.guild_id)) threadEvent(d.guild_id, d);
        return;
      case "THREAD_DELETE":
        if (isStr(d.guild_id) && isStr(d.id))
          emit({ ev: "thread-gone", guildId: d.guild_id, id: d.id });
        return;
      case "THREAD_LIST_SYNC":
        if (isStr(d.guild_id) && Array.isArray(d.threads))
          for (const th of d.threads) threadEvent(d.guild_id, th);
        return;
      case "MESSAGE_CREATE": {
        // A DM has no guild: not in this build.
        if (!isStr(d.guild_id)) return;
        const msg = normaliseApiMessage(d, {
          guildId: d.guild_id,
          botUserId,
          botRoleIds: roleIds.get(d.guild_id) ?? [],
        });
        if (msg) emit(msg);
        return;
      }
    }
  }

  function channelOf(c: unknown) {
    if (!isObj(c) || !isStr(c.id) || !isStr(c.name)) return null;
    const kind = channelKind(c.type);
    if (!kind) return null;
    return {
      id: c.id,
      name: c.name,
      kind,
      parentId: isStr(c.parent_id) ? c.parent_id : null,
    };
  }

  function threadEvent(guildId: string, th: unknown): void {
    if (isObj(th) && isStr(th.id) && isStr(th.parent_id))
      emit({ ev: "thread", guildId, id: th.id, parentId: th.parent_id });
  }

  function connect(resume: boolean): void {
    if (done) return;
    const target = resume && resumeUrl ? withQuery(resumeUrl) : url;
    let socket: WebSocket;
    try {
      socket = new WebSocket(target);
    } catch {
      log("gateway: could not open the connection");
      void reconnect(false);
      return;
    }
    ws = socket;
    acked = true;
    socket.onmessage = (event) => {
      try {
        onPayload(socket, resume, JSON.parse(String(event.data)) as Payload);
      } catch {
        log("gateway: dropped a payload it could not read");
      }
    };
    socket.onclose = (event) => {
      try {
        onClose(socket, event.code);
      } catch {
        log("gateway: a close failed");
      }
    };
  }

  function onPayload(socket: WebSocket, resume: boolean, p: Payload): void {
    if (socket !== ws) return;
    if (typeof p.s === "number") seq = p.s;
    switch (p.op) {
      case 10: {
        const interval =
          isObj(p.d) && typeof p.d.heartbeat_interval === "number"
            ? p.d.heartbeat_interval
            : 41_250;
        stopBeats();
        firstBeat = setTimeout(
          () => {
            beat(socket);
            heartbeat = setInterval(() => beat(socket), interval);
          },
          Math.floor(interval * Math.random()),
        );
        if (resume && sessionId)
          send(socket, {
            op: 6,
            d: { token, session_id: sessionId, seq },
          });
        else
          send(socket, {
            op: 2,
            d: {
              token,
              intents: DISCORD_INTENTS,
              properties: { os: "linux", browser: "isomux", device: "isomux" },
            },
          });
        return;
      }
      case 11:
        acked = true;
        return;
      case 1:
        send(socket, { op: 1, d: seq });
        return;
      case 7:
        log("gateway: Discord asked for a reconnect");
        drop(socket, 4000);
        return;
      case 9:
        if (p.d !== true) {
          sessionId = null;
          seq = null;
        }
        log("gateway: invalid session");
        drop(socket, p.d === true ? 4000 : 1000, true);
        return;
      case 0:
        if (typeof p.t === "string") dispatch(p.t, p.d);
        return;
    }
  }

  // Closes this socket and reconnects, without waiting for its close event.
  function drop(socket: WebSocket, code: number, invalid = false): void {
    stopBeats();
    ws = null;
    try {
      socket.close(code);
    } catch {
      // Already closed.
    }
    void reconnect(invalid);
  }

  function onClose(socket: WebSocket, code: number): void {
    if (socket !== ws || done) return;
    ws = null;
    stopBeats();
    if (FATAL_CLOSES.has(code)) {
      emit({ ev: "closed", code });
      end(1);
      return;
    }
    if (FRESH_CLOSES.has(code)) {
      sessionId = null;
      seq = null;
    }
    log(`gateway: closed with ${code}, reconnecting`);
    void reconnect(false);
  }

  async function reconnect(invalid: boolean): Promise<void> {
    if (done) return;
    reconnects++;
    if (reconnects > MAX_RECONNECTS) {
      log("gateway: too many reconnects");
      end(1);
      return;
    }
    // Discord asks for a wait of 1 to 5 s after an invalid session.
    const wait = invalid
      ? 1000 + Math.floor(Math.random() * 4000)
      : reconnects > 1
        ? Math.min(RECONNECT_WAIT_MAX_MS, 1000 * 2 ** (reconnects - 2))
        : 0;
    if (wait > 0) await sleep(wait);
    if (done) return;
    connect(sessionId !== null);
  }

  void (async () => {
    try {
      for await (const cmd of io.commands) {
        if (cmd.op === "stop") break;
        if (cmd.op === "start" && !token) {
          token = cmd.token;
          url = cmd.url;
          connect(false);
        }
      }
    } catch {
      // stdin failed: the same as its end.
    }
    end(0);
  })();

  return finished;
}

// The child's own entry: stdin lines in, stdout lines out.
if (import.meta.main) {
  async function* commands(): AsyncGenerator<GatewayCommand> {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const cmd = parseGatewayCommand(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (cmd) yield cmd;
      }
    }
  }
  const code = await runGateway({
    commands: commands(),
    write: (line) => void process.stdout.write(line),
  });
  process.exit(code);
}
