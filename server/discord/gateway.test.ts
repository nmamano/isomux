// The Discord gateway child (task 7fd44c30), run in process against a fake
// gateway on Bun.serve: HELLO, IDENTIFY with the intents, heartbeats, the
// events it passes on, RESUME after a reconnect request or a drop, a fresh
// IDENTIFY after an invalid session, the fatal closes, the stop, and that
// the token never reaches its output.

import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createHash } from "crypto";
import { DISCORD_INTENTS, runGateway, type GatewayIO } from "./gateway.ts";
import {
  GATEWAY_CLOSE,
  parseGatewayEvent,
  type GatewayCommand,
  type GatewayEvent,
} from "./protocol.ts";

const TOKEN = "fake.Token-0001";
const BOT = "1100000000000000001";
const GUILD = "1200000000000000001";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const FORUM = "1300000000000000003";
const VOICE = "1300000000000000005";
const THREAD = "1300000000000000009";
const ROLE = "1500000000000000001";
const HEARTBEAT_MS = 40;

interface Payload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface Conn {
  ws: ServerWebSocket<{ n: number }>;
  path: string;
  received: Payload[];
}

// A gateway that says HELLO on every connection and records what it hears.
function fakeGateway() {
  const conns: Conn[] = [];
  let seq = 0;
  const server = Bun.serve<{ n: number; path: string }, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (srv.upgrade(req, { data: { n: conns.length, path } })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({
          ws: ws as unknown as ServerWebSocket<{ n: number }>,
          path: ws.data.path,
          received: [],
        });
        ws.send(
          JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS } }),
        );
      },
      message(ws, text) {
        const conn = conns[ws.data.n];
        const p = JSON.parse(String(text)) as Payload;
        conn.received.push(p);
        if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/gateway`;
  return {
    conns,
    url,
    resumeUrl: `ws://127.0.0.1:${server.port}/resume`,
    dispatch(conn: Conn, t: string, d: unknown) {
      conn.ws.send(JSON.stringify({ op: 0, t, s: ++seq, d }));
      return seq;
    },
    send(conn: Conn, p: Payload) {
      conn.ws.send(JSON.stringify(p));
    },
    stop: () => server.stop(true),
  };
}

// The child's stdin: commands pushed one at a time, ended on demand.
function commandQueue() {
  const waiting: ((r: IteratorResult<GatewayCommand>) => void)[] = [];
  const queued: IteratorResult<GatewayCommand>[] = [];
  const push = (r: IteratorResult<GatewayCommand>) => {
    const w = waiting.shift();
    if (w) w(r);
    else queued.push(r);
  };
  const iterable: AsyncIterable<GatewayCommand> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        queued.length > 0
          ? Promise.resolve(queued.shift()!)
          : new Promise((resolve) => waiting.push(resolve)),
    }),
  };
  return {
    iterable,
    send: (cmd: GatewayCommand) => push({ value: cmd, done: false }),
    end: () => push({ value: undefined, done: true }),
  };
}

async function until(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function start() {
  const gw = fakeGateway();
  const cmds = commandQueue();
  const lines: string[] = [];
  const events: GatewayEvent[] = [];
  const waits: number[] = [];
  // sleep: the child's waits that are not heartbeats (the 1 to 5 s before a
  // fresh IDENTIFY after an invalid session), recorded and skipped.
  const io = {
    commands: cmds.iterable,
    write: (line: string) => {
      lines.push(line);
      const ev = parseGatewayEvent(line.trimEnd());
      if (ev) events.push(ev);
    },
    sleep: async (ms: number) => void waits.push(ms),
  } as GatewayIO;
  const exit = runGateway(io);
  let done = false;
  void exit.then(() => (done = true));
  cleanups.push(() => {
    if (!done) {
      cmds.send({ op: "stop" });
      cmds.end();
    }
    gw.stop();
  });
  cmds.send({ op: "start", token: TOKEN, url: gw.url });
  return { gw, cmds, lines, events, waits, exit, isDone: () => done };
}

type Started = ReturnType<typeof start>;

async function identified(s: Started) {
  await until(
    () => s.gw.conns[0]?.received.some((p) => p.op === 2) ?? false,
    "IDENTIFY",
  );
  const conn = s.gw.conns[0];
  s.gw.dispatch(conn, "READY", {
    v: 10,
    session_id: "session-1",
    resume_gateway_url: s.gw.resumeUrl,
    user: { id: BOT, username: "Office Bot", bot: true },
    guilds: [{ id: GUILD, unavailable: true }],
  });
  await until(() => s.events.some((e) => e.ev === "ready"), "ready");
  return conn;
}

describe("discord gateway child", () => {
  it("identifies with the token and the intents, heartbeats, and says ready with the bot user", async () => {
    const s = start();
    const conn = await identified(s);
    const identify = conn.received.find((p) => p.op === 2)!.d as {
      token: string;
      intents: number;
    };
    expect(identify.token).toBe(TOKEN);
    expect(identify.intents).toBe(DISCORD_INTENTS);
    expect(DISCORD_INTENTS & (1 << 15)).toBeTruthy();
    expect(s.events.filter((e) => e.ev === "ready")).toEqual([
      { ev: "ready", user: { id: BOT, name: "Office Bot" } },
    ]);
    await until(
      () => conn.received.filter((p) => p.op === 1).length >= 2,
      "two heartbeats",
    );
    for (const line of s.lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line).not.toContain(TOKEN);
    }
  });

  it("passes on a server with its text, forum and category channels and the bot's role, its threads, and messages", async () => {
    const s = start();
    const conn = await identified(s);
    s.gw.dispatch(conn, "GUILD_CREATE", {
      id: GUILD,
      name: "Isomux",
      channels: [
        { id: CAT, name: "Talk", type: 4, parent_id: null },
        { id: GENERAL, name: "general", type: 0, parent_id: CAT },
        { id: FORUM, name: "help", type: 15, parent_id: CAT },
        { id: VOICE, name: "Lounge", type: 2, parent_id: CAT },
      ],
      roles: [
        { id: GUILD, name: "@everyone", managed: false },
        { id: ROLE, name: "Office Bot", managed: true, tags: { bot_id: BOT } },
        {
          id: "1500000000000000002",
          name: "Other",
          managed: true,
          tags: { bot_id: "1100000000000000009" },
        },
      ],
      threads: [{ id: THREAD, name: "q", parent_id: GENERAL, type: 11 }],
    });
    await until(() => s.events.some((e) => e.ev === "guild"), "guild");
    const guild = s.events.find((e) => e.ev === "guild");
    expect(guild).toEqual({
      ev: "guild",
      guild: {
        id: GUILD,
        name: "Isomux",
        channels: [
          { id: CAT, name: "Talk", kind: "category", parentId: null },
          { id: GENERAL, name: "general", kind: "text", parentId: CAT },
          { id: FORUM, name: "help", kind: "forum", parentId: CAT },
        ],
      },
      botRoleIds: [ROLE],
    });
    await until(() => s.events.some((e) => e.ev === "thread"), "thread");
    expect(s.events.find((e) => e.ev === "thread")).toEqual({
      ev: "thread",
      guildId: GUILD,
      id: THREAD,
      parentId: GENERAL,
    });

    const base = {
      channel_id: THREAD,
      guild_id: GUILD,
      author: { id: "1600000000000000001", username: "nelly", bot: false },
      type: 0,
      mentions: [],
      mention_roles: [],
      attachments: [],
      timestamp: "2026-11-05T10:00:00.000+00:00",
    };
    s.gw.dispatch(conn, "MESSAGE_CREATE", {
      ...base,
      id: "1700000000000000001",
      content: "<@&role> look",
      mention_roles: [ROLE],
    });
    s.gw.dispatch(conn, "MESSAGE_CREATE", {
      ...base,
      id: "1700000000000000002",
      type: 19,
      content: "answer",
      referenced_message: {
        ...base,
        id: "1700000000000000000",
        author: { id: BOT, username: "Office Bot", bot: true },
        content: "q",
      },
      attachments: [{ id: "9", filename: "a.png", url: "https://x/a.png" }],
    });
    s.gw.dispatch(conn, "MESSAGE_CREATE", {
      ...base,
      id: "1700000000000000003",
      content: "plain",
      webhook_id: "1800000000000000001",
    });
    await until(
      () => s.events.filter((e) => e.ev === "message").length === 3,
      "three messages",
    );
    const messages = s.events.filter((e) => e.ev === "message");
    expect(messages[0]).toEqual({
      ev: "message",
      id: "1700000000000000001",
      guildId: GUILD,
      channelId: THREAD,
      author: { id: "1600000000000000001", name: "nelly", bot: false },
      webhook: false,
      type: 0,
      content: "<@&role> look",
      mentionsBot: true,
      replyToBot: false,
      attachments: [],
      ts: Date.parse("2026-11-05T10:00:00.000+00:00"),
    });
    expect(
      messages.map((m) =>
        m.ev === "message"
          ? [m.mentionsBot, m.replyToBot, m.webhook, m.attachments.length]
          : null,
      ),
    ).toEqual([
      [true, false, false, 0],
      [false, true, false, 1],
      [false, false, true, 0],
    ]);
  });

  it("a reconnect request resumes the session on the resume URL with the last sequence: resumed, not ready again", async () => {
    const s = start();
    const conn = await identified(s);
    const seq = s.gw.dispatch(conn, "TYPING_START", {});
    s.gw.send(conn, { op: 7, d: null });
    await until(() => s.gw.conns.length === 2, "the second connection");
    const second = s.gw.conns[1];
    expect(second.path).toBe("/resume");
    await until(() => second.received.some((p) => p.op === 6), "RESUME");
    expect(second.received.find((p) => p.op === 6)!.d).toEqual({
      token: TOKEN,
      session_id: "session-1",
      seq,
    });
    expect(second.received.some((p) => p.op === 2)).toBe(false);
    s.gw.dispatch(second, "RESUMED", {});
    await until(() => s.events.some((e) => e.ev === "resumed"), "resumed");
    expect(s.events.filter((e) => e.ev === "ready")).toHaveLength(1);
    expect(s.isDone()).toBe(false);
  });

  it("a dropped connection resumes too", async () => {
    const s = start();
    const conn = await identified(s);
    conn.ws.close(4000, "unknown error");
    await until(() => s.gw.conns.length === 2, "the second connection");
    await until(() => s.gw.conns[1].received.some((p) => p.op === 6), "RESUME");
    expect(s.isDone()).toBe(false);
  });

  it("an invalid session that cannot resume starts a fresh one with IDENTIFY", async () => {
    const s = start();
    const conn = await identified(s);
    s.gw.send(conn, { op: 9, d: false });
    const identifies = () =>
      s.gw.conns.flatMap((c) => c.received).filter((p) => p.op === 2).length;
    await until(() => identifies() === 2, "a second IDENTIFY");
    // Discord asks for a wait of 1 to 5 s first.
    expect(s.waits.some((ms) => ms >= 1000 && ms <= 5000)).toBe(true);
    expect(
      s.gw.conns.flatMap((c) => c.received).filter((p) => p.op === 6),
    ).toEqual([]);
  });

  for (const code of [
    GATEWAY_CLOSE.authenticationFailed,
    GATEWAY_CLOSE.disallowedIntents,
  ])
    it(`a fatal close (${code}) is passed on and ends the child with 1, with no reconnect`, async () => {
      const s = start();
      await until(() => s.gw.conns.length === 1, "the connection");
      s.gw.conns[0].ws.close(code, "fatal");
      expect(await s.exit).toBe(1);
      expect(s.events.filter((e) => e.ev === "closed")).toEqual([
        { ev: "closed", code },
      ]);
      await Bun.sleep(100);
      expect(s.gw.conns).toHaveLength(1);
    });

  it("a connection that stops answering (no heartbeat ack, no close) is left for a new one", async () => {
    // A zombie: the peer completes the upgrade, says HELLO, then reads and
    // answers nothing - not the heartbeats, not a close frame - so a close
    // event never comes.
    let upgrades = 0;
    const silent = Bun.listen<{ upgraded: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(sock) {
          sock.data = { upgraded: false };
        },
        data(sock, data) {
          if (sock.data.upgraded) return;
          const key = /Sec-WebSocket-Key: (.*)\r\n/i.exec(String(data))?.[1];
          if (!key) return;
          sock.data.upgraded = true;
          upgrades++;
          const accept = createHash("sha1")
            .update(key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          const hello = Buffer.from(
            JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS } }),
          );
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
              `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          sock.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]));
        },
      },
    });
    const cmds = commandQueue();
    const exit = runGateway({
      commands: cmds.iterable,
      write: () => {},
      sleep: async () => {},
    });
    cleanups.push(() => {
      cmds.send({ op: "stop" });
      cmds.end();
      silent.stop(true);
    });
    cmds.send({
      op: "start",
      token: TOKEN,
      url: `ws://127.0.0.1:${silent.port}/gateway`,
    });
    await until(() => upgrades === 1, "the first connection");
    await until(() => upgrades >= 2, "a new connection after the missed ack");
    void exit;
  });

  it("a stop ends the child with 0, and so does the end of its input", async () => {
    const s = start();
    await identified(s);
    s.cmds.send({ op: "stop" });
    expect(await s.exit).toBe(0);
    const t = start();
    await identified(t);
    t.cmds.end();
    expect(await t.exit).toBe(0);
  });
});
