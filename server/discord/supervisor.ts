// One Discord gateway child per connected bot (task 7fd44c30). The
// supervisor checks a token at connect, keeps the tokens, starts the
// children, follows their events, restarts them with a backoff, and keeps
// each bot's status and its servers and channels for the Integrations card.
//
//   exit after a fatal close (4004, 4014) - dead (token_invalid, intent_off),
//                 no restart until the member connects the bot again
//   any other exit - a failure: restart with a backoff; after
//                 DISCORD_MAX_FAILURES within DISCORD_FAILURE_WINDOW_MS, dead
//                 (crash_loop), and it keeps restarting every
//                 DISCORD_BACKOFF_MAX_MS; a ready heals it
// A child above DISCORD_RSS_LIMIT is killed, which counts as a failure.
// A 401 on a REST call (tokenRefused) is dead token_invalid too, and stops
// the child. Each dead state raises one page to the bot's member.
//
// It runs from timers and child exits in the office server, where a throw
// ends the server: every callback has its own try/catch. Every text from a
// child, from REST or from an exception passes through redact() (each stored
// token in raw, URL-encoded and base64 form) before it reaches a log.

import { dirname } from "path";
import {
  DISCORD_BOTS_MAX,
  type DiscordBot,
  type DiscordBotReason,
  type DiscordBotStatus,
  type DiscordChannelSeen,
  type DiscordGuildSeen,
  type DiscordRoute,
} from "../../shared/discord.ts";
import { scrubPatterns, scrubText } from "../secret-proxy/scrub.ts";
import type { DiscordBotView } from "./inbound.ts";
import {
  GATEWAY_CLOSE,
  type DiscordMessage,
  type GatewayCommand,
  type GatewayEvent,
} from "./protocol.ts";
import type { DiscordRest } from "./rest.ts";
import {
  listDiscordMembers,
  readBots,
  removeCursors,
  removeDiscordMember,
  writeBots,
  type StoredBot,
} from "./store.ts";

export const DISCORD_RSS_LIMIT = 256 * 1024 * 1024;
export const DISCORD_RSS_SAMPLE_MS = 30_000;
export const DISCORD_MAX_FAILURES = 6;
export const DISCORD_FAILURE_WINDOW_MS = 30 * 60_000;
export const DISCORD_BACKOFF_FIRST_MS = 1_000;
export const DISCORD_BACKOFF_MAX_MS = 5 * 60_000;
export const DISCORD_GATEWAY_URL =
  "wss://gateway.discord.gg/?v=10&encoding=json";
// How long a stop waits for the child's exit before it kills it.
export const DISCORD_STOP_WAIT_MS = 5_000;

export interface GatewayChild {
  readonly pid: number;
  send(cmd: GatewayCommand): void;
  kill(): void;
  onEvent(listener: (event: GatewayEvent) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

// What the supervisor asks the spawner to start. The env is minimal (PATH,
// HOME, TZ, LANG): no office token, provider key or office variable.
export interface GatewaySpawnSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type GatewaySpawner = (spec: GatewaySpawnSpec) => GatewayChild;

export interface DiscordClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DiscordHooks {
  onMessage(userId: string, botId: string, msg: DiscordMessage): void;
  // A fresh gateway session (not a resume): the catch-up.
  onReady(userId: string, botId: string): void;
  // The bot was disconnected or its member removed: its routes and pending
  // bursts go. The supervisor deletes its token and cursors itself.
  onBotRemoved(userId: string, botId: string): void;
  // The office stops, before the children are stopped.
  onShutdown(): void;
}

export interface DiscordSupervisorDeps {
  stateRoot: string;
  // The gateway entry (server/discord/gateway.ts) and the runtime that runs it.
  gatewayEntry: string;
  bunPath: string;
  // The server's environment; the child gets only its allowed keys.
  baseEnv: Record<string, string | undefined>;
  spawner: GatewaySpawner;
  clock: DiscordClock;
  readRss(pid: number): number | null;
  rest: Pick<DiscordRest, "me">;
  // The gateway URL a child connects to (DISCORD_GATEWAY_URL; a fake in tests).
  gatewayUrl: string;
  // The member's bots changed (status, a connect, a removal).
  emitStatus(userId: string, bots: DiscordBot[]): void;
  // A page to the bot's member when the bot goes dead (slice 2). The key is
  // stable per (member, bot, reason), so one dead state raises one page.
  pager?: DiscordPager;
  hooks?: DiscordHooks;
}

export interface DiscordPager {
  raise(userId: string, key: string, title: string, body: string): void;
}

export type DiscordConnectResult =
  | { ok: true; bot: DiscordBot }
  | { ok: false; status: 400 | 409; error: string };

export interface DiscordSupervisor {
  // Starts a child for each stored bot.
  boot(): Promise<void>;
  list(userId: string): DiscordBot[];
  // Checks the token (GET /users/@me): refused -> 400; not a bot -> 400; the
  // bot is another member's -> 409; DISCORD_BOTS_MAX -> 409. The same bot of
  // the same member: the token is replaced and the child restarted (it heals
  // a dead bot).
  connect(userId: string, token: string): Promise<DiscordConnectResult>;
  // Stops the child and deletes the token. False when no such bot.
  disconnect(userId: string, botId: string): Promise<boolean>;
  // The member was deleted: every bot stops and the directory goes.
  removeMember(userId: string): Promise<void>;
  shutdown(): Promise<void>;
  // The servers and channels the bot saw in this session; null when the
  // bot is not the member's or has not connected yet.
  guilds(userId: string, botId: string): DiscordGuildSeen[] | null;
  // The same for a bot whoever holds it (a bot is one member's).
  guildsOfBot(botId: string): DiscordGuildSeen[] | null;
  // The live view of a bot for the inbound path.
  view(userId: string, botId: string): DiscordBotView | null;
  // The text with every stored token removed.
  redact(text: string): string;
  // Discord refused the bot's token on a REST call (401): the bot goes dead
  // token_invalid, its child stops with no restart, and one page is raised.
  // Idempotent with the gateway's own 4004 path.
  tokenRefused(userId: string, botId: string): void;
}

// The only environment keys a gateway child gets.
const CHILD_ENV_KEYS = ["PATH", "HOME", "TZ", "LANG"] as const;

interface ChildRecord {
  child: GatewayChild;
  // The code of the child's `closed` event; undefined when it exited
  // without one.
  closeCode: number | undefined;
  exited: boolean;
  exitWaiters: (() => void)[];
  rssTimer: unknown;
}

interface GuildState {
  guild: DiscordGuildSeen;
  roleIds: string[];
  // Thread id -> the channel it belongs to.
  threads: Map<string, string>;
}

interface BotRecord {
  userId: string;
  stored: StoredBot;
  status: DiscordBotStatus;
  child: ChildRecord | null;
  restartTimer: unknown;
  // Failure times within DISCORD_FAILURE_WINDOW_MS.
  failures: number[];
  // The servers of the current session; null before its first ready.
  guilds: Map<string, GuildState> | null;
  botUserId: string;
  // A disconnect, a replacement or a shutdown ends the child: no restart.
  removed: boolean;
  // Dead with no restart until the member connects the bot again: Discord
  // refused the token on a REST call.
  halted: boolean;
}

const recordKey = (userId: string, botId: string) => `${userId}\n${botId}`;

const INTEGRATIONS_HINT = "To connect it again, open Integrations › Messaging.";

// The page body's first sentence per reason, for the bot `name`.
const DEAD_TEXT: Record<DiscordBotReason, (name: string) => string> = {
  token_invalid: (name) => `Discord refused the token of the bot ${name}.`,
  intent_off: (name) =>
    `The bot ${name} needs the Message Content intent: turn it on in the Discord Developer Portal.`,
  crash_loop: (name) => `The connection of the bot ${name} kept failing.`,
};

export function createDiscordSupervisor(
  deps: DiscordSupervisorDeps,
): DiscordSupervisor {
  const { clock } = deps;
  const bots = new Map<string, BotRecord>();
  let patterns: string[] = [];
  let shuttingDown = false;

  const redact = (text: string) => scrubText(text, patterns);

  function refreshPatterns(): void {
    patterns = scrubPatterns([...bots.values()].map((r) => r.stored.token));
  }

  // Every callback runs in the office server: a throw is logged, redacted.
  function guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.error(`[discord] ${what} failed: ${redact(String(err))}`);
    }
  }

  const botOf = (r: BotRecord): DiscordBot => ({
    id: r.stored.id,
    name: r.stored.name,
    addedAt: r.stored.addedAt,
    status: r.status,
  });

  function membersBots(userId: string): BotRecord[] {
    return [...bots.values()].filter((r) => r.userId === userId);
  }

  function emit(userId: string): void {
    guard("a Discord status push", () =>
      deps.emitStatus(userId, membersBots(userId).map(botOf)),
    );
  }

  function setStatus(r: BotRecord, status: DiscordBotStatus): void {
    r.status = status;
    emit(r.userId);
  }

  // The bot goes dead for `reason`, with one page per dead state: a bot
  // that is dead for this reason already raises none.
  function die(r: BotRecord, reason: DiscordBotReason): void {
    const again = r.status.state === "dead" && r.status.reason === reason;
    setStatus(r, { state: "dead", reason });
    if (again) return;
    const pager = deps.pager;
    if (!pager) return;
    try {
      pager.raise(
        r.userId,
        `discord:${r.userId}:${r.stored.id}:${reason}`,
        "Discord bot stopped",
        `${DEAD_TEXT[reason](JSON.stringify(r.stored.name))} ${INTEGRATIONS_HINT}`,
      );
    } catch {
      console.error("[discord] a Discord page was not raised");
    }
  }

  function hook(what: string, run: (hooks: DiscordHooks) => void): void {
    const hooks = deps.hooks;
    if (hooks) guard(what, () => run(hooks));
  }

  function childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of CHILD_ENV_KEYS) {
      const value = deps.baseEnv[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  function start(r: BotRecord): void {
    if (r.removed || r.halted || shuttingDown || r.child) return;
    let child: GatewayChild;
    try {
      child = deps.spawner({
        argv: [deps.bunPath, deps.gatewayEntry],
        cwd: dirname(deps.gatewayEntry),
        env: childEnv(),
      });
    } catch (err) {
      console.error(
        `[discord] a gateway child did not start: ${redact(String(err))}`,
      );
      fail(r);
      return;
    }
    const rec: ChildRecord = {
      child,
      closeCode: undefined,
      exited: false,
      exitWaiters: [],
      rssTimer: null,
    };
    r.child = rec;
    r.guilds = null;
    child.onEvent((event) =>
      guard("a gateway event", () => onEvent(r, rec, event)),
    );
    child.onExit((code) => guard("a gateway exit", () => onExit(r, rec, code)));
    child.send({ op: "start", token: r.stored.token, url: deps.gatewayUrl });
    sampleRss(r, rec);
  }

  function sampleRss(r: BotRecord, rec: ChildRecord): void {
    rec.rssTimer = clock.setTimeout(() => {
      guard("a memory check", () => {
        if (rec.exited) return;
        const rss = deps.readRss(rec.child.pid);
        if (rss !== null && rss > DISCORD_RSS_LIMIT) {
          console.warn("[discord] a gateway child used too much memory");
          rec.child.kill();
          return;
        }
        sampleRss(r, rec);
      });
    }, DISCORD_RSS_SAMPLE_MS);
  }

  function onEvent(r: BotRecord, rec: ChildRecord, event: GatewayEvent): void {
    if (r.child !== rec) return;
    switch (event.ev) {
      case "ready":
        r.botUserId = event.user.id;
        r.guilds = new Map();
        r.failures = [];
        if (event.user.name !== r.stored.name) {
          r.stored = { ...r.stored, name: event.user.name };
          saveBot(r);
        }
        setStatus(r, { state: "connected" });
        hook("the catch-up", (h) => h.onReady(r.userId, r.stored.id));
        return;
      case "resumed":
        r.failures = [];
        if (r.status.state !== "connected")
          setStatus(r, { state: "connected" });
        return;
      case "guild":
        r.guilds?.set(event.guild.id, {
          guild: event.guild,
          roleIds: event.botRoleIds,
          threads:
            r.guilds.get(event.guild.id)?.threads ?? new Map<string, string>(),
        });
        return;
      case "guild-gone":
        r.guilds?.delete(event.guildId);
        return;
      case "channel": {
        const g = r.guilds?.get(event.guildId);
        if (!g) return;
        const channels = g.guild.channels.filter(
          (c) => c.id !== event.channel.id,
        );
        const at = g.guild.channels.findIndex((c) => c.id === event.channel.id);
        if (at >= 0) channels.splice(at, 0, event.channel);
        else channels.push(event.channel);
        g.guild = { ...g.guild, channels };
        return;
      }
      case "channel-gone": {
        const g = r.guilds?.get(event.guildId);
        if (!g) return;
        g.guild = {
          ...g.guild,
          channels: g.guild.channels.filter((c) => c.id !== event.channelId),
        };
        return;
      }
      case "thread":
        r.guilds?.get(event.guildId)?.threads.set(event.id, event.parentId);
        return;
      case "thread-gone":
        r.guilds?.get(event.guildId)?.threads.delete(event.id);
        return;
      case "closed":
        rec.closeCode = event.code;
        return;
      case "log":
        console.log(`[discord] ${redact(event.text)}`);
        return;
      case "message":
        hook("a Discord message", (h) =>
          h.onMessage(r.userId, r.stored.id, event),
        );
        return;
    }
  }

  function onExit(r: BotRecord, rec: ChildRecord, code: number | null): void {
    rec.exited = true;
    clock.clearTimeout(rec.rssTimer);
    for (const w of rec.exitWaiters.splice(0)) guard("a stop", w);
    if (r.child !== rec) return;
    r.child = null;
    if (r.removed || r.halted || shuttingDown) return;
    void code;
    if (rec.closeCode === GATEWAY_CLOSE.authenticationFailed) {
      die(r, "token_invalid");
      return;
    }
    if (rec.closeCode === GATEWAY_CLOSE.disallowedIntents) {
      die(r, "intent_off");
      return;
    }
    fail(r);
  }

  // A failure: restart with a backoff; too many in the window is dead, and
  // it keeps trying at the longest backoff.
  function fail(r: BotRecord): void {
    if (r.removed || r.halted || shuttingDown) return;
    const now = clock.now();
    r.failures = r.failures.filter((t) => now - t < DISCORD_FAILURE_WINDOW_MS);
    r.failures.push(now);
    let wait: number;
    if (r.failures.length >= DISCORD_MAX_FAILURES) {
      if (r.status.state !== "dead") die(r, "crash_loop");
      wait = DISCORD_BACKOFF_MAX_MS;
    } else {
      if (r.status.state !== "connecting")
        setStatus(r, { state: "connecting" });
      wait = Math.min(
        DISCORD_BACKOFF_MAX_MS,
        DISCORD_BACKOFF_FIRST_MS * 2 ** (r.failures.length - 1),
      );
    }
    clock.clearTimeout(r.restartTimer);
    r.restartTimer = clock.setTimeout(() => {
      r.restartTimer = null;
      guard("a gateway restart", () => start(r));
    }, wait);
  }

  // Asks the child to stop, and kills it after DISCORD_STOP_WAIT_MS.
  function stopChild(r: BotRecord): Promise<void> {
    clock.clearTimeout(r.restartTimer);
    r.restartTimer = null;
    const rec = r.child;
    if (!rec || rec.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = clock.setTimeout(() => {
        guard("a kill", () => rec.child.kill());
      }, DISCORD_STOP_WAIT_MS);
      rec.exitWaiters.push(() => {
        clock.clearTimeout(timer);
        resolve();
      });
      try {
        rec.child.send({ op: "stop" });
      } catch {
        rec.child.kill();
      }
    });
  }

  function saveBot(r: BotRecord): void {
    const stored = readBots(deps.stateRoot, r.userId).filter(
      (b) => b.id !== r.stored.id,
    );
    writeBots(deps.stateRoot, r.userId, [...stored, r.stored]);
  }

  function track(userId: string, stored: StoredBot): BotRecord {
    const r: BotRecord = {
      userId,
      stored,
      status: { state: "connecting" },
      child: null,
      restartTimer: null,
      failures: [],
      guilds: null,
      botUserId: stored.id,
      removed: false,
      halted: false,
    };
    bots.set(recordKey(userId, stored.id), r);
    refreshPatterns();
    return r;
  }

  async function removeRecord(r: BotRecord): Promise<void> {
    r.removed = true;
    await stopChild(r);
    bots.delete(recordKey(r.userId, r.stored.id));
    refreshPatterns();
    hook("a bot removal", (h) => h.onBotRemoved(r.userId, r.stored.id));
  }

  function textChannels(g: GuildState | undefined, route: DiscordRoute) {
    if (!g) return [];
    const text = g.guild.channels.filter((c) => c.kind === "text");
    if (route.scope === "server") return text.map((c) => c.id);
    if (route.scope === "category")
      return text.filter((c) => c.parentId === route.targetId).map((c) => c.id);
    return text.some((c) => c.id === route.targetId) ? [route.targetId] : [];
  }

  function makeView(r: BotRecord): DiscordBotView {
    const guilds = () => r.guilds ?? new Map<string, GuildState>();
    return {
      userId: r.userId,
      botUserId: r.botUserId,
      botName: r.stored.name,
      token: r.stored.token,
      roleIds: (guildId) => guilds().get(guildId)?.roleIds ?? [],
      place(guildId, channelId) {
        const g = guilds().get(guildId);
        if (!g) return null;
        const find = (id: string): DiscordChannelSeen | undefined =>
          g.guild.channels.find((c) => c.id === id);
        const parent = g.threads.get(channelId);
        const channel = find(parent ?? channelId);
        if (!channel || channel.kind === "category") return null;
        return {
          botId: r.stored.id,
          guildId,
          channelId: channel.id,
          categoryId: channel.parentId,
          channelName: channel.name,
        };
      },
      textChannels: (route) => textChannels(guilds().get(route.guildId), route),
      kindOf: (guildId, channelId) =>
        guilds()
          .get(guildId)
          ?.guild.channels.find((c) => c.id === channelId)?.kind ?? null,
    };
  }

  return {
    async boot() {
      for (const userId of listDiscordMembers(deps.stateRoot))
        for (const stored of readBots(deps.stateRoot, userId))
          if (!bots.has(recordKey(userId, stored.id))) track(userId, stored);
      for (const r of bots.values()) guard("a gateway start", () => start(r));
    },

    list: (userId) => membersBots(userId).map(botOf),

    async connect(userId, token) {
      if (typeof token !== "string" || token.trim() === "")
        return { ok: false, status: 400, error: "token is required" };
      token = token.trim();
      const me = await deps.rest.me(token);
      if (!me.ok)
        return {
          ok: false,
          status: 400,
          error:
            me.reason === "unauthorized"
              ? "Discord refused this token"
              : "Discord could not check this token; try again",
        };
      if (!me.bot)
        return { ok: false, status: 400, error: "this is not a bot token" };
      const others = [...bots.values()].find(
        (r) => r.stored.id === me.id && r.userId !== userId,
      );
      if (others)
        return {
          ok: false,
          status: 409,
          error: "another member has connected this bot",
        };
      const existing = bots.get(recordKey(userId, me.id));
      if (existing) {
        // The same bot again: a new token, and a new child.
        existing.removed = true;
        await stopChild(existing);
        // A disconnect while the old child stopped: nothing to restart.
        if (bots.get(recordKey(userId, me.id)) !== existing)
          return { ok: false, status: 409, error: "the bot was disconnected" };
        existing.removed = false;
        existing.halted = false;
        existing.child = null;
        existing.failures = [];
        existing.stored = { ...existing.stored, token, name: me.name };
        refreshPatterns();
        saveBot(existing);
        setStatus(existing, { state: "connecting" });
        start(existing);
        return { ok: true, bot: botOf(existing) };
      }
      if (membersBots(userId).length >= DISCORD_BOTS_MAX)
        return {
          ok: false,
          status: 409,
          error: `at most ${DISCORD_BOTS_MAX} bots`,
        };
      const r = track(userId, {
        id: me.id,
        name: me.name,
        token,
        addedAt: clock.now(),
      });
      saveBot(r);
      emit(userId);
      start(r);
      return { ok: true, bot: botOf(r) };
    },

    async disconnect(userId, botId) {
      const r = bots.get(recordKey(userId, botId));
      if (!r) return false;
      await removeRecord(r);
      writeBots(
        deps.stateRoot,
        userId,
        readBots(deps.stateRoot, userId).filter((b) => b.id !== botId),
      );
      removeCursors(deps.stateRoot, userId, botId);
      emit(userId);
      return true;
    },

    async removeMember(userId) {
      await Promise.all(membersBots(userId).map((r) => removeRecord(r)));
      try {
        removeDiscordMember(deps.stateRoot, userId);
      } catch {
        console.error("[discord] a member's Discord directory was not removed");
      }
    },

    async shutdown() {
      hook("the shutdown", (h) => h.onShutdown());
      shuttingDown = true;
      await Promise.all([...bots.values()].map((r) => stopChild(r)));
    },

    guilds(userId, botId) {
      const r = bots.get(recordKey(userId, botId));
      if (!r?.guilds) return null;
      return [...r.guilds.values()].map((g) => g.guild);
    },

    guildsOfBot(botId) {
      const r = [...bots.values()].find((b) => b.stored.id === botId);
      return r?.guilds ? [...r.guilds.values()].map((g) => g.guild) : null;
    },

    view(userId, botId) {
      const r = bots.get(recordKey(userId, botId));
      return r?.guilds ? makeView(r) : null;
    },

    redact,

    tokenRefused(userId, botId) {
      guard("a refused token", () => {
        const r = bots.get(recordKey(userId, botId));
        if (!r || r.removed || shuttingDown) return;
        r.halted = true;
        die(r, "token_invalid");
        void stopChild(r);
      });
    },
  };
}
