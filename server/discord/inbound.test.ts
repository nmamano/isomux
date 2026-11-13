// Discord messages from routed channels to agents (task 7fd44c30): what is
// dropped, what is only context, how a burst makes one delivery, the cursor,
// and the catch-up after a fresh gateway session (order, no duplicate, no
// flush while it runs, the gap line), and (slice 2) the head that says a
// reply needs a channel and the 👀 reaction on what was delivered. Fake
// clock, fake REST and fake delivery; the block is the real one, parsed back.
//
// The stored cursor of the main channel is an 18-digit id from 2022, below
// every message here: compared as strings it is above them all, so every
// delivery in this file also checks that snowflakes compare as BigInt.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  DISCORD_EPOCH_MS,
  type DiscordRoute,
  type DiscordRouteDead,
} from "../../shared/discord.ts";
import { buildDiscordBlock } from "./block.ts";
import {
  DISCORD_BURST_MAX_MS,
  DISCORD_BURST_QUIET_MS,
  DISCORD_CATCHUP_PAGES,
  DISCORD_CATCHUP_PAGE_SIZE,
  DISCORD_CONTEXT_MAX,
  DISCORD_MAX_AGE_MS,
  createDiscordInbound,
  type DiscordBotView,
} from "./inbound.ts";
import type { DiscordMessage } from "./protocol.ts";
import type {
  DiscordMessagesPage,
  DiscordReactResult,
  DiscordRest,
} from "./rest.ts";
import type { DiscordMessagePlace } from "./routes.ts";

const U = "u-alice";
const BOT = "1100000000000000001";
const BOT_USER = "1100000000000000001";
// A second bot of the same member.
const BOT2 = "1100000000000000002";
const GUILD = "1200000000000000001";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const OTHER = "1300000000000000004";
const THREAD = "1300000000000000009";
const FORUM = "1300000000000000003";
// A post under FORUM.
const POST = "1300000000000000010";
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000;
// Below every id in this file by value, above them all as a string.
const OLD_18 = "999999999999999999";
const OPEN = "<messaging-data>";

// The id Discord gives the n-th message made at ms (n < 2^22).
const sf = (ms: number, n = 0) =>
  ((BigInt(ms - DISCORD_EPOCH_MS) << 22n) + BigInt(n)).toString();

// Synchronous timers; promises settle between steps.
class Clock {
  t = T0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers)
        if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const route = (over: Partial<DiscordRoute> = {}): DiscordRoute => ({
  id: "r-general",
  botId: BOT,
  guildId: GUILD,
  scope: "channel",
  targetId: GENERAL,
  name: "general",
  agentId: "agent-a",
  trigger: "all",
  replyMode: "bot",
  createdAt: T0 - HOUR,
  ...over,
});

interface Line {
  from: string;
  authorId: string;
  channel: string;
  channelId: string;
  messageId: string;
  link: string;
  text: string;
  attachments: { name: string; url: string }[];
  context?: true;
}

const PLACES: Record<string, DiscordMessagePlace & { channelName: string }> = {
  [GENERAL]: {
    botId: BOT,
    guildId: GUILD,
    channelId: GENERAL,
    categoryId: CAT,
    channelName: "general",
  },
  [OTHER]: {
    botId: BOT,
    guildId: GUILD,
    channelId: OTHER,
    categoryId: CAT,
    channelName: "other",
  },
  [THREAD]: {
    botId: BOT,
    guildId: GUILD,
    channelId: GENERAL,
    categoryId: CAT,
    channelName: "a thread",
  },
  [POST]: {
    botId: BOT,
    guildId: GUILD,
    channelId: FORUM,
    categoryId: CAT,
    channelName: "a post",
  },
};
const KINDS: Record<string, "text" | "forum" | "category"> = {
  [CAT]: "category",
  [GENERAL]: "text",
  [OTHER]: "text",
  [FORUM]: "forum",
};

function harness() {
  const clock = new Clock();
  const h = {
    clock,
    // Routes by the channel they cover.
    routes: { [GENERAL]: route() } as Record<string, DiscordRoute>,
    // The second bot's routes and cursors.
    routes2: {} as Record<string, DiscordRoute>,
    cursors2: {} as Record<string, string>,
    dead: null as DiscordRouteDead | null,
    connected: true,
    cursors: { [GENERAL]: OLD_18 } as Record<string, string>,
    cursorWrites: 0,
    deliverThrows: false,
    // Delivery attempts, and an agent that refuses them.
    delivered: 0,
    refuse: false,
    deliveries: [] as { routeId: string; head: string; lines: Line[] }[],
    // The channel history the fake REST pages through.
    history: new Map<string, DiscordMessage[]>(),
    threads: [] as { id: string; parentId: string }[],
    restCalls: [] as { channelId: string; before?: string; limit: number }[],
    threadCalls: [] as string[],
    // Replaces a page answer when set (a hold, a failure or a throw).
    page: null as
      null | ((channelId: string) => Promise<DiscordMessagesPage> | null),
    // The reactions asked for, and how each one answers (default: ok).
    reactions: [] as {
      token: string;
      channelId: string;
      messageId: string;
      emoji: string;
    }[],
    react: null as null | (() => Promise<DiscordReactResult>),
  };
  const view: DiscordBotView = {
    userId: U,
    botUserId: BOT_USER,
    botName: "Office Bot",
    token: "fake-token",
    roleIds: () => [],
    place: (guildId, channelId) =>
      guildId === GUILD ? (PLACES[channelId] ?? null) : null,
    textChannels: (r) =>
      r.scope === "channel" ? [r.targetId] : [GENERAL, OTHER],
    kindOf: (guildId, channelId) =>
      guildId === GUILD ? (KINDS[channelId] ?? null) : null,
  };
  const rest: DiscordRest = {
    me: async () => ({ ok: false, reason: "failed", error: "" }),
    messages: async (_token, req) => {
      h.restCalls.push({
        channelId: req.channelId,
        ...(req.before ? { before: req.before } : {}),
        limit: req.limit,
      });
      const special = h.page?.(req.channelId);
      if (special) return special;
      const all = (h.history.get(req.channelId) ?? [])
        .filter((m) => !req.before || BigInt(m.id) < BigInt(req.before))
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      return { ok: true, messages: all.slice(0, req.limit) };
    },
    activeThreads: async (_token, guildId) => {
      h.threadCalls.push(guildId);
      return { ok: true, threads: h.threads };
    },
    postMessage: async () => ({ ok: false, reason: "failed", error: "" }),
    addReaction: (token, channelId, messageId, emoji) => {
      h.reactions.push({ token, channelId, messageId, emoji });
      return h.react ? h.react() : Promise.resolve({ ok: true });
    },
  };
  const inbound = createDiscordInbound({
    clock,
    rest,
    bot: (userId, botId) =>
      userId !== U || !h.connected
        ? null
        : botId === BOT
          ? view
          : botId === BOT2
            ? { ...view, botUserId: BOT2 }
            : null,
    forPlace: (userId, place) =>
      userId !== U
        ? null
        : place.botId === BOT
          ? (h.routes[place.channelId] ?? null)
          : place.botId === BOT2
            ? (h.routes2[place.channelId] ?? null)
            : null,
    forBot: (userId, botId) =>
      userId !== U
        ? []
        : botId === BOT
          ? [...new Set(Object.values(h.routes))]
          : botId === BOT2
            ? [...new Set(Object.values(h.routes2))]
            : [],
    check: () => h.dead,
    readCursors: (_u, botId) => ({
      ...(botId === BOT2 ? h.cursors2 : botId === BOT ? h.cursors : {}),
    }),
    writeCursors: (_u, botId, cursors) => {
      h.cursorWrites++;
      if (botId === BOT2) h.cursors2 = { ...cursors };
      else if (botId === BOT) h.cursors = { ...cursors };
    },
    memberName: () => "Morgan",
    deliver: (_u, r, text) => {
      h.delivered++;
      if (h.deliverThrows) throw new Error("queue full");
      if (h.refuse) return false;
      const json = text.split(`${OPEN}\n`)[1].split("\n</messaging-data>")[0];
      h.deliveries.push({
        routeId: r.id,
        head: text.split(OPEN)[0],
        lines: (JSON.parse(json) as { messages: Line[] }).messages,
      });
      return true;
    },
  });
  let n = 0;
  const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => {
    n++;
    return {
      ev: "message",
      id: sf(clock.now(), n),
      guildId: GUILD,
      channelId: GENERAL,
      author: { id: "1600000000000000001", name: "Nelly", bot: false },
      webhook: false,
      type: 0,
      content: `text ${n}`,
      mentionsBot: false,
      replyToBot: false,
      attachments: [],
      ts: clock.now(),
      ...over,
    };
  };
  const texts = () => h.deliveries.map((d) => d.lines.map((l) => l.text));
  // The head a delivery of route r has, with or without the gap line and
  // the line that says a reply needs a channel.
  const headOf = (r: DiscordRoute, gap: boolean, channelRequired = false) =>
    buildDiscordBlock({
      routeId: r.id,
      routeName: r.name,
      memberName: "Morgan",
      replyMode: r.replyMode,
      ...(gap ? { gap: true } : {}),
      ...(channelRequired ? { channelRequired: true } : {}),
      lines: [],
      reservedChars: 0,
    }).split(OPEN)[0];
  return { h, inbound, msg, texts, headOf };
}

describe("discord inbound: delivery", () => {
  it("one message is delivered once the channel is quiet, with its author, channel and link, and the cursor moves then", () => {
    const { h, inbound, msg, headOf } = harness();
    const m = msg({
      content: "can the bot look?",
      attachments: [{ name: "a.png", url: "https://cdn.discordapp.com/a.png" }],
    });
    inbound.onMessage(U, BOT, m);
    h.clock.advance(DISCORD_BURST_QUIET_MS - 1);
    expect(h.deliveries).toEqual([]);
    expect(h.cursors[GENERAL]).toBe(OLD_18);
    h.clock.advance(1);
    expect(h.deliveries).toEqual([
      {
        routeId: "r-general",
        head: headOf(route(), false),
        lines: [
          {
            from: "Nelly",
            authorId: "1600000000000000001",
            channel: "general",
            channelId: GENERAL,
            messageId: m.id,
            link: `https://discord.com/channels/${GUILD}/${GENERAL}/${m.id}`,
            text: "can the bot look?",
            attachments: [
              { name: "a.png", url: "https://cdn.discordapp.com/a.png" },
            ],
          },
        ],
      },
    ]);
    expect(h.cursors[GENERAL]).toBe(m.id);
  });

  it("a message in a thread goes to its channel's route, links to the thread and moves the thread's cursor", () => {
    const { h, inbound, msg } = harness();
    const m = msg({ channelId: THREAD });
    inbound.onMessage(U, BOT, m);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0].routeId).toBe("r-general");
    expect(h.deliveries[0].lines[0]).toMatchObject({
      channel: "a thread",
      channelId: THREAD,
      messageId: m.id,
      link: `https://discord.com/channels/${GUILD}/${THREAD}/${m.id}`,
    });
    expect(h.cursors[THREAD]).toBe(m.id);
  });

  it("a burst within the quiet time is one delivery in id order with no repeat; a longer gap makes two", () => {
    const { h, inbound, msg, texts } = harness();
    const a = msg({ content: "a" });
    const b = msg({ content: "b" });
    const c = msg({ content: "c" });
    inbound.onMessage(U, BOT, c);
    inbound.onMessage(U, BOT, a);
    h.clock.advance(2_000);
    inbound.onMessage(U, BOT, b);
    inbound.onMessage(U, BOT, a);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    h.clock.advance(1_000);
    inbound.onMessage(U, BOT, msg({ content: "d" }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(texts()).toEqual([["a", "b", "c"], ["d"]]);
    // A message already delivered is not delivered again.
    inbound.onMessage(U, BOT, c);
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(texts()).toHaveLength(2);
  });

  it("a channel that never goes quiet is delivered at the longest wait after its first message", () => {
    const { h, inbound, msg } = harness();
    const step = DISCORD_BURST_QUIET_MS - 1_000;
    const start = h.clock.now();
    while (
      h.deliveries.length === 0 &&
      h.clock.now() - start < 2 * DISCORD_BURST_MAX_MS
    ) {
      inbound.onMessage(U, BOT, msg({ content: "x" }));
      h.clock.advance(step);
    }
    expect(h.deliveries).toHaveLength(1);
    expect(h.clock.now() - start).toBeLessThanOrEqual(
      DISCORD_BURST_MAX_MS + step,
    );
    expect(h.clock.now() - start).toBeGreaterThanOrEqual(DISCORD_BURST_MAX_MS);
  });

  it("two channels make two deliveries", () => {
    const { h, inbound, msg } = harness();
    h.routes[OTHER] = route({ id: "r-other", targetId: OTHER, name: "other" });
    inbound.onMessage(U, BOT, msg());
    inbound.onMessage(U, BOT, msg({ channelId: OTHER }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.routeId).sort()).toEqual([
      "r-general",
      "r-other",
    ]);
  });

  it("drops the bot's own message, a system message, a bot or webhook post, an id at or below the cursor, a message from before the route or over a day old, an unknown or unrouted place", () => {
    const { h, inbound, msg } = harness();
    const dropped = (what: string, m: DiscordMessage, before?: () => void) => {
      before?.();
      inbound.onMessage(U, BOT, m);
      h.clock.advance(DISCORD_BURST_MAX_MS);
      expect({ what, delivered: h.deliveries.length }).toEqual({
        what,
        delivered: 0,
      });
    };
    dropped(
      "the bot's own",
      msg({ author: { id: BOT_USER, name: "Office Bot", bot: true } }),
    );
    dropped("a member joined", msg({ type: 7 }));
    dropped("a pin notice", msg({ type: 6 }));
    dropped(
      "another bot",
      msg({ author: { id: "1700000000000000001", name: "Spidey", bot: true } }),
    );
    dropped("a webhook", msg({ webhook: true }));
    const cursor = sf(h.clock.now(), 900);
    dropped("at the cursor", msg({ id: cursor }), () => {
      h.cursors[GENERAL] = cursor;
    });
    dropped("below the cursor", msg({ id: (BigInt(cursor) - 1n).toString() }));
    h.cursors[GENERAL] = OLD_18;
    dropped(
      "before the route",
      msg({ id: sf(T0 - HOUR - 1), ts: T0 - HOUR - 1 }),
    );
    dropped(
      "over a day old",
      msg({
        id: sf(h.clock.now() - DISCORD_MAX_AGE_MS - 1),
        ts: h.clock.now() - DISCORD_MAX_AGE_MS - 1,
      }),
      () => {
        h.routes[GENERAL] = route({ createdAt: T0 - 3 * DISCORD_MAX_AGE_MS });
      },
    );
    dropped("an unknown channel", msg({ channelId: "1300000000000000077" }));
    dropped("an unrouted channel", msg({ channelId: OTHER }));
    dropped("another server", msg({ guildId: "1200000000000000002" }));
    expect(h.cursors[GENERAL]).toBe(OLD_18);

    // The condition: the same harness delivers a fresh routed message, and
    // a bot post on a route that takes them.
    inbound.onMessage(U, BOT, msg({ content: "fresh" }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    h.routes[GENERAL] = route({ includeBots: true });
    inbound.onMessage(
      U,
      BOT,
      msg({
        content: "a bot post",
        author: { id: "1700000000000000001", name: "Spidey", bot: true },
      }),
    );
    inbound.onMessage(U, BOT, msg({ content: "a hook", webhook: true }));
    inbound.onMessage(U, BOT, msg({ content: "a reply", type: 19 }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines.map((l) => l.text))).toEqual([
      ["fresh"],
      ["a bot post", "a hook", "a reply"],
    ]);
  });

  it("a message for a bot that is not connected, or for another bot, is dropped", () => {
    const { h, inbound, msg } = harness();
    inbound.onMessage(U, "1100000000000000002", msg());
    h.connected = false;
    inbound.onMessage(U, BOT, msg());
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);
  });
});

describe("discord inbound: the mention trigger", () => {
  it("a message that neither mentions nor answers the bot is context for the next delivery, never one of its own, the newest kept", () => {
    const { h, inbound, msg } = harness();
    h.routes[GENERAL] = route({ trigger: "mention" });
    const chatter = DISCORD_CONTEXT_MAX + 3;
    for (let i = 0; i < chatter; i++)
      inbound.onMessage(U, BOT, msg({ content: `c${i}` }));
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);
    inbound.onMessage(U, BOT, msg({ content: "@bot?", mentionsBot: true }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries).toHaveLength(1);
    const lines = h.deliveries[0].lines;
    expect(lines.map((l) => l.text)).toEqual([
      ...Array.from(
        { length: DISCORD_CONTEXT_MAX },
        (_, i) => `c${chatter - DISCORD_CONTEXT_MAX + i}`,
      ),
      "@bot?",
    ]);
    expect(lines.map((l) => l.context ?? false)).toEqual([
      ...Array(DISCORD_CONTEXT_MAX).fill(true),
      false,
    ]);
    // A reply to the bot counts too; the context went with the first.
    inbound.onMessage(U, BOT, msg({ content: "re", replyToBot: true }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries[1].lines).toHaveLength(1);
    expect(h.deliveries[1].lines[0].text).toBe("re");
  });
});

describe("discord inbound: failures", () => {
  it("a dead route delivers nothing, checked at the delivery", () => {
    const { h, inbound, msg } = harness();
    inbound.onMessage(U, BOT, msg());
    h.dead = "agent_gone";
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);
  });

  it("a delivery that throws never escapes the timer", () => {
    const { h, inbound, msg } = harness();
    h.deliverThrows = true;
    inbound.onMessage(U, BOT, msg());
    h.clock.advance(DISCORD_BURST_MAX_MS);
    h.deliverThrows = false;
    inbound.onMessage(U, BOT, msg({ content: "after" }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries.at(-1)?.lines.at(-1)?.text).toBe("after");
  });

  it("a removed bot's waiting messages are dropped; at shutdown the waiting ones are delivered at once", () => {
    const { h, inbound, msg, texts } = harness();
    inbound.onMessage(U, BOT, msg({ content: "gone" }));
    inbound.dropBot(U, BOT);
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);
    inbound.onMessage(U, BOT, msg({ content: "now" }));
    inbound.flushAll();
    expect(texts()).toEqual([["now"]]);
  });
});

// A channel's history, oldest first: count messages, one second apart,
// ending at `end`.
function historyOf(channelId: string, count: number, end: number) {
  return Array.from({ length: count }, (_, i): DiscordMessage => {
    const ts = end - (count - 1 - i) * 1_000;
    return {
      ev: "message",
      id: sf(ts, i),
      guildId: GUILD,
      channelId,
      author: { id: "1600000000000000001", name: "Nelly", bot: false },
      webhook: false,
      type: 0,
      content: `h${i}`,
      mentionsBot: false,
      replyToBot: false,
      attachments: [],
      ts,
    };
  });
}

describe("discord inbound: catch-up after a fresh session", () => {
  it("reads each covered channel back to the cursor and delivers what was missed, oldest first, with no gap line", async () => {
    const { h, inbound, headOf } = harness();
    // Two before the route was made (not missed), three after.
    const before = historyOf(GENERAL, 2, T0 - HOUR - 10_000);
    const missed = historyOf(GENERAL, 3, T0 - 60_000);
    h.history.set(GENERAL, [...before, ...missed]);
    await inbound.onReady(U, BOT);
    await settle();
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0].lines.map((l) => l.text)).toEqual(
      missed.map((m) => m.content),
    );
    expect(h.deliveries[0].head).toBe(headOf(route(), false));
    expect(h.restCalls.filter((c) => c.channelId === GENERAL)).toHaveLength(1);
    expect(h.cursors[GENERAL]).toBe(missed.at(-1)!.id);
    // A second session finds nothing new.
    await inbound.onReady(U, BOT);
    await settle();
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toHaveLength(1);
  });

  it("reads the active threads under a covered channel, once per server", async () => {
    const { h, inbound } = harness();
    h.routes[OTHER] = route({ id: "r-other", targetId: OTHER, name: "other" });
    h.threads = [
      { id: THREAD, parentId: GENERAL },
      { id: "1300000000000000099", parentId: "1300000000000000098" },
    ];
    h.history.set(THREAD, historyOf(THREAD, 2, T0 - 30_000));
    await inbound.onReady(U, BOT);
    await settle();
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(h.threadCalls).toEqual([GUILD]);
    const read = new Set(h.restCalls.map((c) => c.channelId));
    expect(read.has(THREAD)).toBe(true);
    expect(read.has("1300000000000000099")).toBe(false);
    expect(h.deliveries.flatMap((d) => d.lines.map((l) => l.text))).toEqual([
      "h0",
      "h1",
    ]);
    expect(h.cursors[THREAD]).toBe(h.history.get(THREAD)!.at(-1)!.id);
  });

  it("stops at the page cap, delivers the newest, and says the rest went unread", async () => {
    const { h, inbound, headOf } = harness();
    const count = DISCORD_CATCHUP_PAGES * DISCORD_CATCHUP_PAGE_SIZE + 20;
    const all = historyOf(GENERAL, count, T0 - 60_000);
    h.history.set(GENERAL, all);
    await inbound.onReady(U, BOT);
    await settle();
    h.clock.advance(DISCORD_BURST_MAX_MS);
    const calls = h.restCalls.filter((c) => c.channelId === GENERAL);
    expect(calls).toHaveLength(DISCORD_CATCHUP_PAGES);
    expect(calls[0].before).toBeUndefined();
    // Each page starts below the oldest of the one before.
    expect(calls[1].before).toBe(all[count - DISCORD_CATCHUP_PAGE_SIZE].id);
    expect(h.deliveries.length).toBeGreaterThan(0);
    expect(h.deliveries[0].head).toBe(headOf(route(), true));
    const delivered = h.deliveries.flatMap((d) => d.lines.map((l) => l.text));
    // The oldest twenty were not read.
    expect(delivered).not.toContain("h0");
    expect(delivered).not.toContain("h19");
    expect(h.cursors[GENERAL]).toBe(all.at(-1)!.id);
  });

  it("says so when the age limit left messages above the cursor unread", async () => {
    const { h, inbound, headOf } = harness();
    const r = route({ createdAt: T0 - 3 * DISCORD_MAX_AGE_MS });
    h.routes[GENERAL] = r;
    h.cursors[GENERAL] = sf(T0 - 2 * DISCORD_MAX_AGE_MS);
    const old = historyOf(GENERAL, 1, T0 - DISCORD_MAX_AGE_MS - HOUR);
    const fresh = historyOf(GENERAL, 1, T0 - 60_000);
    h.history.set(GENERAL, [...old, ...fresh]);
    await inbound.onReady(U, BOT);
    await settle();
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(texts(h)).toEqual([[fresh[0].content]]);
    expect(h.deliveries[0].head).toBe(headOf(r, true));
  });

  it("two bots of one member in one channel keep their own cursors: one bot's delivery hides nothing from the other's catch-up", async () => {
    const { h, inbound, msg } = harness();
    h.routes2[GENERAL] = route({ id: "r-general-2", botId: BOT2 });
    h.cursors2 = { [GENERAL]: OLD_18 };
    const first = msg({ content: "both saw this" });
    h.history.set(GENERAL, [first]);
    inbound.onMessage(U, BOT, first);
    inbound.onMessage(U, BOT2, first);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    // The second bot is away: only the first sees the next message.
    const missed = msg({ content: "only the first bot saw this" });
    h.history.set(GENERAL, [first, missed]);
    inbound.onMessage(U, BOT, missed);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect([h.cursors[GENERAL], h.cursors2[GENERAL]]).toEqual([
      missed.id,
      first.id,
    ]);
    await inbound.onReady(U, BOT2);
    await settle();
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(
      h.deliveries.map((d) => [d.routeId, d.lines.map((l) => l.text)]),
    ).toEqual([
      ["r-general", ["both saw this"]],
      ["r-general-2", ["both saw this"]],
      ["r-general", ["only the first bot saw this"]],
      ["r-general-2", ["only the first bot saw this"]],
    ]);
    expect(h.cursors2[GENERAL]).toBe(missed.id);
  });

  it("holds the channel's delivery while its catch-up runs, then delivers the late and the live messages once, in order", async () => {
    const { h, inbound, msg } = harness();
    const missed = historyOf(GENERAL, 2, T0 - 60_000);
    let release: () => void = () => {};
    h.page = (channelId) =>
      channelId === GENERAL
        ? new Promise<DiscordMessagesPage>((resolve) => {
            release = () =>
              resolve({
                ok: true,
                messages: [live, ...missed].sort((a, b) =>
                  BigInt(b.id) > BigInt(a.id) ? 1 : -1,
                ),
              });
          })
        : null;
    const live = msg({ content: "live" });
    const ready = inbound.onReady(U, BOT);
    await settle();
    inbound.onMessage(U, BOT, live);
    h.clock.advance(2 * DISCORD_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);
    expect(h.cursors[GENERAL]).toBe(OLD_18);
    release();
    await ready;
    await settle();
    h.clock.advance(DISCORD_BURST_MAX_MS);
    expect(texts(h)).toEqual([["h0", "h1", "live"]]);
    expect(h.cursors[GENERAL]).toBe(live.id);
  });

  it("a channel whose catch-up is done delivers while another channel is still read", async () => {
    const { h, inbound, msg } = harness();
    h.routes[OTHER] = route({ id: "r-other", targetId: OTHER, name: "other" });
    let release: () => void = () => {};
    let reads = 0;
    // The second channel read stays out until released.
    h.page = () =>
      ++reads === 2
        ? new Promise<DiscordMessagesPage>((resolve) => {
            release = () => resolve({ ok: true, messages: [] });
          })
        : null;
    const ready = inbound.onReady(U, BOT);
    await settle();
    expect(h.restCalls).toHaveLength(2);
    const done = h.restCalls[0].channelId;
    expect(h.restCalls[1].channelId).not.toBe(done);
    inbound.onMessage(U, BOT, msg({ channelId: done, content: "live" }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(texts(h)).toEqual([["live"]]);
    release();
    await ready;
  });

  it("a channel whose read failed says so in its next delivery, and the catch-up never rejects", async () => {
    const { h, inbound, msg, headOf } = harness();
    h.page = (channelId) =>
      channelId === GENERAL
        ? Promise.resolve({
            ok: false as const,
            reason: "rate_limited" as const,
            error: "429",
          })
        : null;
    await inbound.onReady(U, BOT);
    await settle();
    inbound.onMessage(U, BOT, msg({ content: "after" }));
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    expect(texts(h)).toEqual([["after"]]);
    expect(h.deliveries[0].head).toBe(headOf(route(), true));

    // A REST that throws, and a bot not connected: onReady still resolves.
    h.page = () => Promise.reject(new Error("boom"));
    await expect(inbound.onReady(U, BOT)).resolves.toBeUndefined();
    h.connected = false;
    await expect(inbound.onReady(U, BOT)).resolves.toBeUndefined();
  });
});

function texts(h: { deliveries: { lines: Line[] }[] }) {
  return h.deliveries.map((d) => d.lines.map((l) => l.text));
}

describe("discord inbound: what a reply needs to know (slice 2)", () => {
  it("the head says a reply needs a channel for a forum, category or server route, and not for a channel route on a text channel", () => {
    const cases: [DiscordRoute, string, boolean][] = [
      [route(), GENERAL, false],
      [route({ id: "r-forum", targetId: FORUM, name: "help" }), POST, true],
      [
        route({ id: "r-cat", scope: "category", targetId: CAT, name: "talk" }),
        OTHER,
        true,
      ],
      [
        route({ id: "r-all", scope: "server", targetId: GUILD, name: "all" }),
        OTHER,
        true,
      ],
    ];
    for (const [r, channelId, required] of cases) {
      const { h, inbound, msg, headOf } = harness();
      h.routes = { [channelId === POST ? FORUM : channelId]: r };
      inbound.onMessage(U, BOT, msg({ channelId }));
      h.clock.advance(DISCORD_BURST_QUIET_MS);
      expect({ route: r.id, head: h.deliveries[0]?.head }).toEqual({
        route: r.id,
        head: headOf(r, false, required),
      });
    }
  });
});

describe("discord inbound: the 👀 reaction (slice 2)", () => {
  const logs: ReturnType<typeof spyOn>[] = [];
  afterEach(() => {
    for (const l of logs.splice(0)) l.mockRestore();
  });

  it("on a route with react, each line that counts gets 👀 where it was posted after the delivery; context lines do not; a route without react gets none", async () => {
    const { h, inbound, msg } = harness();
    h.routes[GENERAL] = route({ trigger: "mention", react: true });
    const context = msg({ content: "chat" });
    const asked = msg({ content: "@bot look", mentionsBot: true });
    const inThread = msg({ channelId: THREAD, replyToBot: true });
    for (const m of [context, asked, inThread]) inbound.onMessage(U, BOT, m);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    await settle();
    expect(h.deliveries).toHaveLength(2);
    expect(
      h.reactions
        .map((r) => [r.token, r.channelId, r.messageId, r.emoji])
        .sort(),
    ).toEqual(
      [
        ["fake-token", GENERAL, asked.id, "👀"],
        ["fake-token", THREAD, inThread.id, "👀"],
      ].sort(),
    );

    const plain = harness();
    plain.inbound.onMessage(U, BOT, plain.msg());
    plain.h.clock.advance(DISCORD_BURST_QUIET_MS);
    await settle();
    expect(plain.h.deliveries).toHaveLength(1);
    expect(plain.h.reactions).toEqual([]);
  });

  it("at most 10 reactions per delivery, all on delivered lines", async () => {
    const { h, inbound, msg } = harness();
    h.routes[GENERAL] = route({ react: true });
    const sent = Array.from({ length: 12 }, () => msg());
    for (const m of sent) inbound.onMessage(U, BOT, m);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    await settle();
    expect(h.deliveries[0].lines).toHaveLength(12);
    expect(h.reactions).toHaveLength(10);
    const ids = new Set(sent.map((m) => m.id));
    for (const r of h.reactions) expect(ids.has(r.messageId)).toBe(true);
    expect(new Set(h.reactions.map((r) => r.messageId)).size).toBe(10);
  });

  it("a delivery the agent refused gets no reaction", async () => {
    const { h, inbound, msg } = harness();
    h.routes[GENERAL] = route({ react: true });
    h.refuse = true;
    inbound.onMessage(U, BOT, msg());
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    await settle();
    expect(h.delivered).toBe(1);
    expect(h.reactions).toEqual([]);
  });

  it("reactions go one at a time and never hold the delivery or the cursor", async () => {
    const { h, inbound, msg } = harness();
    h.routes[GENERAL] = route({ react: true });
    const waiting: (() => void)[] = [];
    h.react = () =>
      new Promise((resolve) => waiting.push(() => resolve({ ok: true })));
    const sent = [msg(), msg(), msg()];
    for (const m of sent) inbound.onMessage(U, BOT, m);
    h.clock.advance(DISCORD_BURST_QUIET_MS);
    // Delivered and the cursor moved while the first reaction is still out.
    expect(h.deliveries).toHaveLength(1);
    expect(h.cursors[GENERAL]).toBe(sent[2].id);
    await settle();
    expect(h.reactions).toHaveLength(1);
    waiting.shift()!();
    await settle();
    expect(h.reactions).toHaveLength(2);
    waiting.shift()!();
    await settle();
    waiting.shift()!();
    await settle();
    expect(h.reactions).toHaveLength(3);
  });

  it("reactions that fail, reject or throw never escape: at most one log line per delivery, and the next delivery still goes", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error"] as const)
      logs.push(
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        }),
      );
    const answers: (() => Promise<DiscordReactResult>)[] = [
      () =>
        Promise.resolve({
          ok: false,
          reason: "forbidden",
          error: "403 fake-token",
        }),
      () => Promise.reject(new Error("socket fake-token")),
      () => {
        throw new Error("sync fake-token");
      },
    ];
    for (const answer of answers) {
      const { h, inbound, msg } = harness();
      h.routes[GENERAL] = route({ react: true });
      h.react = answer;
      lines.length = 0;
      for (let i = 0; i < 10; i++) inbound.onMessage(U, BOT, msg());
      h.clock.advance(DISCORD_BURST_QUIET_MS);
      await settle();
      expect(h.deliveries).toHaveLength(1);
      expect(lines.length).toBeLessThanOrEqual(1);
      for (const line of lines) expect(line).not.toContain("fake-token");
      const next = msg();
      inbound.onMessage(U, BOT, next);
      h.clock.advance(DISCORD_BURST_QUIET_MS);
      await settle();
      expect(h.deliveries).toHaveLength(2);
      expect(h.cursors[GENERAL]).toBe(next.id);
    }
  });
});
