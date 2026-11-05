// Discord supervisor (task 7fd44c30): one gateway child per connected bot,
// driven through a fake child, a fake clock, a fake token check and a real
// temp STATE_ROOT. Pins connect and its refusals, the child's start and
// environment, the status, the guild snapshot and the bot view, the backoff
// and give-up, the fatal closes, the memory watchdog, disconnect and member
// removal, the boot, shutdown, redaction, and that no callback throws.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DISCORD_BACKOFF_FIRST_MS,
  DISCORD_BACKOFF_MAX_MS,
  DISCORD_FAILURE_WINDOW_MS,
  DISCORD_MAX_FAILURES,
  DISCORD_RSS_LIMIT,
  DISCORD_RSS_SAMPLE_MS,
  createDiscordSupervisor,
  type DiscordSupervisor,
  type GatewayChild,
  type GatewaySpawnSpec,
} from "./supervisor.ts";
import {
  discordMemberDir,
  readBots,
  readCursors,
  writeBots,
  writeCursors,
} from "./store.ts";
import {
  GATEWAY_CLOSE,
  type DiscordMessage,
  type GatewayCommand,
  type GatewayEvent,
} from "./protocol.ts";
import type { DiscordMe } from "./rest.ts";
import {
  DISCORD_BOTS_MAX,
  type DiscordBot,
  type DiscordGuildSeen,
} from "../../shared/discord.ts";

const U = "u-alice";
const V = "u-bob";
const MINUTE = 60_000;
const BOT = "1100000000000000001";
const GUILD = "1200000000000000001";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const LOOSE = "1300000000000000004";
const THREAD = "1300000000000000009";
const ROLE = "1500000000000000001";
const TOKEN = "fake.Token+0001/x";
const GATEWAY_URL = "ws://127.0.0.1:9/gateway";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class FakeClock {
  t = 1_800_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    await settle();
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers)
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at))
          next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

// A gateway child that answers stop and kill with an exit, as the real one.
class FakeChild implements GatewayChild {
  sent: GatewayCommand[] = [];
  kills = 0;
  exited = false;
  private eventListeners: ((event: GatewayEvent) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  constructor(readonly pid: number) {}
  send(cmd: GatewayCommand): void {
    this.sent.push(cmd);
    if (cmd.op === "stop" && !this.exited) queueMicrotask(() => this.exit(0));
  }
  kill(): void {
    this.kills++;
    queueMicrotask(() => this.exit(null));
  }
  onEvent(listener: (event: GatewayEvent) => void): void {
    this.eventListeners.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }
  emit(event: GatewayEvent): void {
    if (this.exited) return;
    for (const l of this.eventListeners) l(event);
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitListeners) l(code);
  }
  get token(): string | null {
    const start = this.sent[0];
    return start?.op === "start" ? start.token : null;
  }
}

const BASE_ENV = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/office",
  TZ: "Europe/Madrid",
  LANG: "en_US.UTF-8",
  ISOMUX_AGENT_TOKEN: "agent-token-must-not-leak",
  ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
  DISCORD_BOT_TOKEN: "office-var-must-not-leak",
};

interface Harness {
  sup: DiscordSupervisor;
  stateRoot: string;
  clock: FakeClock;
  spawns: { spec: GatewaySpawnSpec; child: FakeChild }[];
  // The token check: each token's answer.
  me: Map<string, DiscordMe>;
  emits: { userId: string; bots: DiscordBot[] }[];
  rss: Map<number, number | null>;
  spawnFailures: number;
  hookCalls: string[];
  hookThrows: boolean;
  // The removal and shutdown hooks throw.
  lifecycleThrows: boolean;
  emitThrows: boolean;
  childrenOf(token: string): FakeChild[];
}

let current: Harness | null = null;
afterEach(async () => {
  if (!current) return;
  const h = current;
  current = null;
  const done = h.sup.shutdown();
  await h.clock.advance(10 * MINUTE);
  await done;
  rmSync(h.stateRoot, { recursive: true, force: true });
});

const meOf = (id: string, name = "Office Bot", bot = true): DiscordMe => ({
  ok: true,
  id,
  name,
  bot,
});

function harness(root?: string): Harness {
  const stateRoot = root ?? mkdtempSync(join(tmpdir(), "t-7fd44c30-sup-"));
  const clock = new FakeClock();
  let pid = 5000;
  const h: Harness = {
    sup: undefined as unknown as DiscordSupervisor,
    stateRoot,
    clock,
    spawns: [],
    me: new Map([[TOKEN, meOf(BOT)]]),
    emits: [],
    rss: new Map(),
    spawnFailures: 0,
    hookCalls: [],
    hookThrows: false,
    lifecycleThrows: false,
    emitThrows: false,
    childrenOf: (token) =>
      h.spawns.filter((s) => s.child.token === token).map((s) => s.child),
  };
  h.sup = createDiscordSupervisor({
    stateRoot,
    gatewayEntry: "/opt/isomux/server/discord/gateway.ts",
    bunPath: "/opt/bun/bin/bun",
    baseEnv: BASE_ENV,
    spawner: (spec) => {
      if (h.spawnFailures > 0) {
        h.spawnFailures--;
        throw new Error("spawn ENOENT");
      }
      const child = new FakeChild(++pid);
      h.spawns.push({ spec, child });
      return child;
    },
    clock,
    readRss: (p) => h.rss.get(p) ?? null,
    rest: {
      me: async (token) =>
        h.me.get(token) ?? {
          ok: false,
          reason: "unauthorized",
          error: "401",
        },
    },
    gatewayUrl: GATEWAY_URL,
    emitStatus: (userId, bots) => {
      if (h.emitThrows) throw new Error("socket gone");
      h.emits.push({ userId, bots: structuredClone(bots) });
    },
    hooks: {
      onMessage: (userId, botId, msg) => {
        if (h.hookThrows) throw new Error("inbound failed");
        h.hookCalls.push(`message:${userId}:${botId}:${msg.id}`);
      },
      onReady: (userId, botId) => {
        if (h.hookThrows) throw new Error("catch-up failed");
        h.hookCalls.push(`ready:${userId}:${botId}`);
      },
      onBotRemoved: (userId, botId) => {
        if (h.lifecycleThrows) throw new Error("routes gone");
        h.hookCalls.push(`removed:${userId}:${botId}`);
      },
      onShutdown: () => {
        if (h.lifecycleThrows) throw new Error("flush failed");
        h.hookCalls.push(
          `shutdown:${h.spawns.filter((s) => !s.child.exited).length}`,
        );
      },
    },
  });
  current = h;
  return h;
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

async function connected(h: Harness, token = TOKEN): Promise<FakeChild> {
  const res = await h.sup.connect(U, token);
  if (!res.ok) throw new Error(`connect failed: ${res.error}`);
  await until(() => h.childrenOf(token).length > 0, "the spawn");
  return last(h.childrenOf(token));
}

const SEEN: DiscordGuildSeen = {
  id: GUILD,
  name: "Isomux",
  channels: [
    { id: CAT, name: "Talk", kind: "category", parentId: null },
    { id: GENERAL, name: "general", kind: "text", parentId: CAT },
    { id: LOOSE, name: "random", kind: "text", parentId: null },
  ],
};

describe("discord supervisor: connect", () => {
  it("checks the token, stores the bot, starts one child with only the allowed env, and sends the token in the start command only", async () => {
    const h = harness();
    const res = await h.sup.connect(U, TOKEN);
    expect(res).toMatchObject({
      ok: true,
      bot: { id: BOT, name: "Office Bot", status: { state: "connecting" } },
    });
    if (!res.ok) return;
    expect("token" in res.bot).toBe(false);
    expect(readBots(h.stateRoot, U)).toEqual([
      { id: BOT, name: "Office Bot", token: TOKEN, addedAt: h.clock.now() },
    ]);
    await until(() => h.spawns.length === 1, "the spawn");
    const { spec, child } = h.spawns[0];
    expect(spec.env).toEqual({
      PATH: BASE_ENV.PATH,
      HOME: BASE_ENV.HOME,
      TZ: BASE_ENV.TZ,
      LANG: BASE_ENV.LANG,
    });
    expect(spec.argv[0]).toBe("/opt/bun/bin/bun");
    expect(spec.argv).toContain("/opt/isomux/server/discord/gateway.ts");
    expect(JSON.stringify(spec)).not.toContain(TOKEN);
    expect(child.sent).toEqual([
      { op: "start", token: TOKEN, url: GATEWAY_URL },
    ]);
    expect(h.sup.list(U)).toEqual([res.bot]);
    expect(h.sup.list(V)).toEqual([]);
    expect(last(h.emits)).toEqual({ userId: U, bots: [res.bot] });
  });

  it("refuses a token Discord refuses, a user account, a bot another member has, and one bot over the cap", async () => {
    const h = harness();
    expect(await h.sup.connect(U, "nope")).toMatchObject({
      ok: false,
      status: 400,
    });
    h.me.set("user-token", meOf("1600000000000000001", "Nelly", false));
    expect(await h.sup.connect(U, "user-token")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect((await h.sup.connect(V, TOKEN)).ok).toBe(true);
    expect(await h.sup.connect(U, TOKEN)).toMatchObject({
      ok: false,
      status: 409,
    });
    for (let i = 0; i < DISCORD_BOTS_MAX; i++) {
      const token = `token-${i}`;
      h.me.set(token, meOf(`11000000000000001${String(i).padStart(2, "0")}`));
      expect((await h.sup.connect(U, token)).ok).toBe(true);
    }
    h.me.set("one-more", meOf("1100000000000000199"));
    expect(await h.sup.connect(U, "one-more")).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(h.sup.list(U)).toHaveLength(DISCORD_BOTS_MAX);
    expect(readBots(h.stateRoot, U)).toHaveLength(DISCORD_BOTS_MAX);
  });

  it("the same bot again replaces the token and restarts the child, which heals a dead bot", async () => {
    const h = harness();
    const first = await connected(h);
    first.emit({ ev: "closed", code: GATEWAY_CLOSE.authenticationFailed });
    first.exit(1);
    await until(() => h.sup.list(U)[0]?.status.state === "dead", "dead");
    h.me.set("new-token", meOf(BOT));
    expect((await h.sup.connect(U, "new-token")).ok).toBe(true);
    expect(readBots(h.stateRoot, U).map((b) => b.token)).toEqual(["new-token"]);
    await until(() => h.childrenOf("new-token").length === 1, "the new child");
    expect(h.sup.list(U)).toHaveLength(1);
    expect(h.sup.list(U)[0].status).toEqual({ state: "connecting" });
    last(h.childrenOf("new-token")).emit({
      ev: "ready",
      user: { id: BOT, name: "Office Bot" },
    });
    await until(
      () => h.sup.list(U)[0].status.state === "connected",
      "connected",
    );
    // One child runs.
    expect(h.spawns.filter((s) => !s.child.exited)).toHaveLength(1);
  });
});

describe("discord supervisor: a running child", () => {
  it("ready connects the bot and runs the catch-up; resumed connects it with no catch-up", async () => {
    const h = harness();
    const child = await connected(h);
    child.emit({ ev: "ready", user: { id: BOT, name: "Office Bot" } });
    await until(
      () => h.sup.list(U)[0].status.state === "connected",
      "connected",
    );
    expect(last(h.emits).bots[0].status).toEqual({ state: "connected" });
    expect(h.hookCalls).toEqual([`ready:${U}:${BOT}`]);
    child.emit({ ev: "resumed" });
    await settle();
    expect(h.hookCalls).toEqual([`ready:${U}:${BOT}`]);
  });

  it("keeps the servers and channels the bot sees, and gives the inbound path a view of them", async () => {
    const h = harness();
    const child = await connected(h);
    expect(h.sup.guilds(U, BOT)).toBeNull();
    child.emit({ ev: "ready", user: { id: BOT, name: "Office Bot" } });
    child.emit({ ev: "guild", guild: SEEN, botRoleIds: [ROLE] });
    child.emit({ ev: "thread", guildId: GUILD, id: THREAD, parentId: GENERAL });
    await settle();
    expect(h.sup.guilds(U, BOT)).toEqual([SEEN]);
    expect(h.sup.guilds(V, BOT)).toBeNull();

    const view = h.sup.view(U, BOT);
    expect(view).not.toBeNull();
    expect(h.sup.view(V, BOT)).toBeNull();
    expect(view!.botUserId).toBe(BOT);
    expect(view!.token).toBe(TOKEN);
    expect(view!.roleIds(GUILD)).toEqual([ROLE]);
    expect(view!.place(GUILD, GENERAL)).toEqual({
      botId: BOT,
      guildId: GUILD,
      channelId: GENERAL,
      categoryId: CAT,
      channelName: "general",
    });
    expect(view!.place(GUILD, THREAD)).toMatchObject({
      channelId: GENERAL,
      categoryId: CAT,
    });
    expect(view!.place(GUILD, "1300000000000000077")).toBeNull();
    const route = {
      id: "r",
      botId: BOT,
      guildId: GUILD,
      targetId: GENERAL,
      name: "x",
      agentId: "a",
      trigger: "all" as const,
      replyMode: "bot" as const,
      createdAt: 1,
    };
    expect(view!.textChannels({ ...route, scope: "channel" })).toEqual([
      GENERAL,
    ]);
    expect(
      view!.textChannels({ ...route, scope: "category", targetId: CAT }),
    ).toEqual([GENERAL]);
    expect(
      view!.textChannels({ ...route, scope: "server", targetId: GUILD }).sort(),
    ).toEqual([GENERAL, LOOSE].sort());

    // A renamed channel, a channel gone, a server gone.
    child.emit({
      ev: "channel",
      guildId: GUILD,
      channel: { id: LOOSE, name: "off-topic", kind: "text", parentId: CAT },
    });
    child.emit({ ev: "channel-gone", guildId: GUILD, channelId: GENERAL });
    await settle();
    expect(h.sup.guilds(U, BOT)![0].channels).toEqual([
      SEEN.channels[0],
      { id: LOOSE, name: "off-topic", kind: "text", parentId: CAT },
    ]);
    child.emit({ ev: "guild-gone", guildId: GUILD });
    await settle();
    expect(h.sup.guilds(U, BOT)).toEqual([]);
  });

  it("a message goes to the inbound hook; a hook or an emit that throws never escapes, and the next event still goes", async () => {
    const h = harness();
    const child = await connected(h);
    const msg = (id: string): DiscordMessage => ({
      ev: "message",
      id,
      guildId: GUILD,
      channelId: GENERAL,
      author: { id: "1600000000000000001", name: "Nelly", bot: false },
      webhook: false,
      type: 0,
      content: "hi",
      mentionsBot: false,
      replyToBot: false,
      attachments: [],
      ts: h.clock.now(),
    });
    h.hookThrows = true;
    h.emitThrows = true;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      child.emit(msg("1700000000000000001"));
      child.emit({ ev: "ready", user: { id: BOT, name: "Office Bot" } });
      await settle();
    } finally {
      error.mockRestore();
    }
    h.hookThrows = false;
    h.emitThrows = false;
    child.emit(msg("1700000000000000002"));
    await settle();
    expect(h.hookCalls).toEqual([`message:${U}:${BOT}:1700000000000000002`]);
  });
});

describe("discord supervisor: failures", () => {
  it("a crash loop backs off, doubling, then shows dead; it keeps trying at the longest backoff, and a ready heals it", async () => {
    const h = harness();
    await connected(h);
    for (let failure = 1; failure <= DISCORD_MAX_FAILURES; failure++) {
      last(h.childrenOf(TOKEN)).exit(1);
      if (failure === DISCORD_MAX_FAILURES) break;
      if (failure <= 2) {
        const wait = DISCORD_BACKOFF_FIRST_MS * 2 ** (failure - 1);
        await h.clock.advance(wait - 1);
        expect(h.childrenOf(TOKEN)).toHaveLength(failure);
        await h.clock.advance(1);
      } else {
        await h.clock.advance(DISCORD_BACKOFF_MAX_MS);
      }
      expect(h.childrenOf(TOKEN)).toHaveLength(failure + 1);
      expect(h.sup.list(U)[0].status.state).not.toBe("dead");
    }
    await until(() => h.sup.list(U)[0].status.state === "dead", "dead");
    expect(h.sup.list(U)[0].status).toEqual({
      state: "dead",
      reason: "crash_loop",
    });
    await h.clock.advance(DISCORD_BACKOFF_MAX_MS - 1);
    expect(h.childrenOf(TOKEN)).toHaveLength(DISCORD_MAX_FAILURES);
    await h.clock.advance(1);
    expect(h.childrenOf(TOKEN)).toHaveLength(DISCORD_MAX_FAILURES + 1);
    // The token stays: the bot was not removed.
    expect(readBots(h.stateRoot, U)).toHaveLength(1);
    last(h.childrenOf(TOKEN)).emit({
      ev: "ready",
      user: { id: BOT, name: "Office Bot" },
    });
    await until(() => h.sup.list(U)[0].status.state === "connected", "healed");
  });

  it("failures further apart than the window never give up", async () => {
    const h = harness();
    await connected(h);
    const crashes = DISCORD_MAX_FAILURES * 2;
    for (let i = 0; i < crashes; i++) {
      last(h.childrenOf(TOKEN)).exit(1);
      await h.clock.advance(DISCORD_FAILURE_WINDOW_MS + MINUTE);
    }
    expect(h.childrenOf(TOKEN)).toHaveLength(crashes + 1);
    expect(h.sup.list(U)[0].status.state).not.toBe("dead");
  });

  it("a refused token or the Message Content intent off: dead with the reason, no restart", async () => {
    for (const [code, reason] of [
      [GATEWAY_CLOSE.authenticationFailed, "token_invalid"],
      [GATEWAY_CLOSE.disallowedIntents, "intent_off"],
    ] as const) {
      const h = harness();
      const child = await connected(h);
      child.emit({ ev: "closed", code });
      child.exit(1);
      await until(() => h.sup.list(U)[0].status.state === "dead", "dead");
      expect({ code, status: h.sup.list(U)[0].status }).toEqual({
        code,
        status: { state: "dead", reason },
      });
      await h.clock.advance(DISCORD_FAILURE_WINDOW_MS);
      expect({ code, children: h.childrenOf(TOKEN).length }).toEqual({
        code,
        children: 1,
      });
      expect(readBots(h.stateRoot, U)).toHaveLength(1);
      const done = h.sup.shutdown();
      await h.clock.advance(MINUTE);
      await done;
      current = null;
      rmSync(h.stateRoot, { recursive: true, force: true });
    }
  });

  it("a child above the memory limit is killed and restarted with the backoff; at or under it, or unknown, it runs on", async () => {
    const h = harness();
    const child = await connected(h);
    h.rss.set(child.pid, DISCORD_RSS_LIMIT);
    await h.clock.advance(DISCORD_RSS_SAMPLE_MS);
    h.rss.set(child.pid, null);
    await h.clock.advance(DISCORD_RSS_SAMPLE_MS);
    expect(child.kills).toBe(0);
    expect(child.exited).toBe(false);
    h.rss.set(child.pid, DISCORD_RSS_LIMIT + 1);
    await h.clock.advance(DISCORD_RSS_SAMPLE_MS);
    expect(child.kills).toBeGreaterThan(0);
    expect(child.exited).toBe(true);
    await h.clock.advance(DISCORD_BACKOFF_FIRST_MS - 1);
    expect(h.childrenOf(TOKEN)).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.childrenOf(TOKEN)).toHaveLength(2);
  });

  it("a spawn that throws on a restart counts as a failure and is tried again; it escapes no timer", async () => {
    const h = harness();
    await connected(h);
    h.spawnFailures = 1;
    last(h.childrenOf(TOKEN)).exit(1);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.clock.advance(DISCORD_BACKOFF_FIRST_MS);
      expect(h.spawns).toHaveLength(1);
      await h.clock.advance(DISCORD_BACKOFF_MAX_MS);
    } finally {
      error.mockRestore();
    }
    expect(h.spawns).toHaveLength(2);
  });
});

describe("discord supervisor: removal, boot and shutdown", () => {
  it("disconnect stops the child, deletes the token and the bot's cursors, and tells the hooks; another member's bot is false", async () => {
    const h = harness();
    const child = await connected(h);
    const cursors = { [GENERAL]: "1400000000000000001" };
    const OTHER_BOT = "1100000000000000002";
    writeCursors(h.stateRoot, U, BOT, cursors);
    writeCursors(h.stateRoot, U, OTHER_BOT, cursors);
    expect(await h.sup.disconnect(V, BOT)).toBe(false);
    expect(readCursors(h.stateRoot, U, BOT)).toEqual(cursors);
    expect(await h.sup.disconnect(U, BOT)).toBe(true);
    expect(child.exited).toBe(true);
    expect(readBots(h.stateRoot, U)).toEqual([]);
    expect(readCursors(h.stateRoot, U, BOT)).toEqual({});
    expect(readCursors(h.stateRoot, U, OTHER_BOT)).toEqual(cursors);
    expect(h.sup.list(U)).toEqual([]);
    expect(h.hookCalls).toContain(`removed:${U}:${BOT}`);
    await h.clock.advance(DISCORD_FAILURE_WINDOW_MS);
    expect(h.spawns).toHaveLength(1);
    expect(await h.sup.disconnect(U, BOT)).toBe(false);
  });

  it("removing a member stops every bot of theirs and deletes their directory", async () => {
    const h = harness();
    const child = await connected(h);
    h.me.set("bob-token", meOf("1100000000000000002"));
    await h.sup.connect(V, "bob-token");
    await h.sup.removeMember(U);
    expect(child.exited).toBe(true);
    expect(existsSync(discordMemberDir(h.stateRoot, U))).toBe(false);
    expect(h.sup.list(U)).toEqual([]);
    expect(h.hookCalls).toContain(`removed:${U}:${BOT}`);
    expect(h.sup.list(V)).toHaveLength(1);
  });

  it("boot starts a child for every stored bot of every member", async () => {
    const h = harness();
    writeBots(h.stateRoot, U, [
      { id: BOT, name: "Office Bot", token: TOKEN, addedAt: 1 },
    ]);
    writeBots(h.stateRoot, V, [
      { id: "1100000000000000002", name: "B", token: "bob-token", addedAt: 2 },
    ]);
    await h.sup.boot();
    await until(() => h.spawns.length === 2, "two spawns");
    expect(h.spawns.map((s) => s.child.token).sort()).toEqual(
      ["bob-token", TOKEN].sort(),
    );
    expect(h.sup.list(U)).toEqual([
      {
        id: BOT,
        name: "Office Bot",
        addedAt: 1,
        status: { state: "connecting" },
      },
    ]);
  });

  it("shutdown tells the hooks while the children run, then stops them all, with no restart", async () => {
    const h = harness();
    const child = await connected(h);
    const done = h.sup.shutdown();
    await h.clock.advance(MINUTE);
    await done;
    current = null;
    expect(h.hookCalls).toContain("shutdown:1");
    expect(child.exited).toBe(true);
    await h.clock.advance(DISCORD_FAILURE_WINDOW_MS);
    expect(h.spawns).toHaveLength(1);
    expect(readBots(h.stateRoot, U)).toHaveLength(1);
    rmSync(h.stateRoot, { recursive: true, force: true });
  });
});

describe("discord supervisor: a hook that throws at a removal or a shutdown", () => {
  it("disconnect still deletes the token and says true; shutdown still stops the children", async () => {
    const h = harness();
    const child = await connected(h);
    h.lifecycleThrows = true;
    expect(await h.sup.disconnect(U, BOT)).toBe(true);
    expect(child.exited).toBe(true);
    expect(readBots(h.stateRoot, U)).toEqual([]);

    const again = await connected(h);
    const done = h.sup.shutdown();
    await h.clock.advance(MINUTE);
    await done;
    current = null;
    expect(again.exited).toBe(true);
    await h.clock.advance(DISCORD_FAILURE_WINDOW_MS);
    expect(h.spawns).toHaveLength(2);
    rmSync(h.stateRoot, { recursive: true, force: true });
  });
});

describe("discord supervisor: redaction", () => {
  it("removes every stored token, raw, URL-encoded and base64, from a text and from the child's log lines", async () => {
    const h = harness();
    const child = await connected(h);
    const forms = [
      TOKEN,
      encodeURIComponent(TOKEN),
      Buffer.from(TOKEN).toString("base64"),
    ];
    expect(new Set(forms).size).toBe(3);
    for (const form of forms) {
      const out = h.sup.redact(`before ${form} after`);
      expect({ form, leaks: out.includes(form) }).toEqual({
        form,
        leaks: false,
      });
      expect(out.startsWith("before ")).toBe(true);
    }
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    const warn = spyOn(console, "warn").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    const error = spyOn(console, "error").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    try {
      child.emit({ ev: "log", text: `gateway said ${TOKEN} and ${forms[2]}` });
      await settle();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
    expect(lines.join("\n")).toContain("gateway said");
    for (const form of forms) expect(lines.join("\n")).not.toContain(form);
    // The token file is the only place the token is written.
    expect(
      readFileSync(join(discordMemberDir(h.stateRoot, U), "bots.json"), "utf8"),
    ).toContain(TOKEN);
  });
});
