// Discord replies (task 7fd44c30, slice 2): an agent answers on its route in
// each reply mode. Who may reply, where the reply goes (the channel or thread
// the route covers now), the order of the checks, the text limit with the
// prefix, the send cap, the errors, the draft and the member's Send. A real
// temp STATE_ROOT, real routes, a real ask store and the real sent ring; the
// bot's view and Discord's post are fakes whose answers the test picks (the
// post's own wire shape is pinned in rest.test.ts).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type {
  DiscordChannelSeen,
  DiscordGuildSeen,
  DiscordRoute,
  DiscordRouteCreateReq,
} from "../../shared/discord.ts";
import { createAskStore } from "../asks.ts";
import type { DiscordBotView } from "./inbound.ts";
import {
  DISCORD_DONT_SEND_OPTION,
  DISCORD_DRAFTS_PER_ROUTE_MAX,
  DISCORD_NONCE_MAX,
  DISCORD_REPLY_MAX_CHARS,
  DISCORD_SENDS_MAX,
  DISCORD_SENDS_WINDOW_MS,
  DISCORD_SEND_OPTION,
  createDiscordReplies,
  nonceForAsk,
} from "./replies.ts";
import type { DiscordPostReq, DiscordPostResult } from "./rest.ts";
import { createDiscordRoutes } from "./routes.ts";
import { openDiscordSentRing } from "./store.ts";

const U = "u-alice";
const V = "u-bob";
const BOT = "1100000000000000001";
const GUILD = "1200000000000000001";
const GUILD2 = "1200000000000000002";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const SIDE = "1300000000000000003";
const FORUM = "1300000000000000004";
const LOOSE = "1300000000000000005";
const G2_CHAN = "1300000000000000006";
// A thread under GENERAL, and a forum post under FORUM.
const THREAD = "1300000000000000009";
const POST = "1300000000000000010";
const MSG = "1700000000000000001";
const T0 = 1_800_000_000_000;

const channel = (
  id: string,
  name: string,
  kind: DiscordChannelSeen["kind"],
  parentId: string | null,
): DiscordChannelSeen => ({ id, name, kind, parentId });

const GUILDS: DiscordGuildSeen[] = [
  {
    id: GUILD,
    name: "Isomux",
    channels: [
      channel(CAT, "Talk", "category", null),
      channel(GENERAL, "general", "text", CAT),
      channel(SIDE, "side", "text", CAT),
      channel(FORUM, "help", "forum", CAT),
      channel(LOOSE, "random", "text", null),
    ],
  },
  {
    id: GUILD2,
    name: "Elsewhere",
    channels: [channel(G2_CHAN, "chat", "text", null)],
  },
];
const THREADS = new Map([
  [THREAD, GENERAL],
  [POST, FORUM],
]);

// The bot's view as the supervisor builds it (supervisor.ts makeView).
function viewOf(): DiscordBotView {
  const guild = (id: string) => GUILDS.find((g) => g.id === id);
  return {
    userId: U,
    botUserId: BOT,
    botName: "Office Bot",
    token: "fake-token",
    roleIds: () => [],
    place(guildId, channelId) {
      const g = guild(guildId);
      if (!g) return null;
      const parent = THREADS.get(channelId);
      const c = g.channels.find((x) => x.id === (parent ?? channelId));
      if (!c || c.kind === "category") return null;
      return {
        botId: BOT,
        guildId,
        channelId: c.id,
        categoryId: c.parentId,
        channelName: c.name,
      };
    },
    kindOf: (guildId, channelId) =>
      guild(guildId)?.channels.find((c) => c.id === channelId)?.kind ?? null,
    textChannels: () => [],
  };
}

interface FakeAgent {
  userId: string | null;
  access: AgentAccess;
  name: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "t-7fd44c30-replies-"));
  roots.push(root);
  const agents = new Map<string, FakeAgent>([
    ["agent-a", { userId: U, access: "office", name: "Helper" }],
    ["agent-b", { userId: U, access: "office", name: "Other" }],
    ["agent-bob", { userId: V, access: "office", name: "Bob's" }],
  ]);
  let n = 0;
  const routes = createDiscordRoutes({
    stateRoot: root,
    now: () => T0,
    newId: () => `d_${(++n).toString(16).padStart(8, "0")}`,
    agent: (id) => agents.get(id) ?? null,
    botIds: (userId) => (userId === U ? [BOT] : []),
    guilds: () => GUILDS,
  });
  const asks = createAskStore({
    persistence: {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    },
  });
  const h = {
    root,
    agents,
    routes,
    asks,
    connected: true,
    clock: { t: T0 },
    // What reached Discord, and its answers in order (default: posted).
    posts: [] as { token: string; channelId: string; req: DiscordPostReq }[],
    answers: [] as DiscordPostResult[],
    refused: [] as string[],
    nonces: 0,
  };
  const make = () =>
    createDiscordReplies({
      routes,
      agent: (id) => {
        const a = agents.get(id);
        return a ? { userId: a.userId, name: a.name } : null;
      },
      bot: (userId, botId) =>
        userId === U && botId === BOT && h.connected ? viewOf() : null,
      rest: {
        postMessage: async (token, channelId, req) => {
          h.posts.push({ token, channelId, req: { ...req } });
          return (
            h.answers.shift() ?? {
              ok: true,
              id: `18000000000000000${String(h.posts.length).padStart(2, "0")}`,
            }
          );
        },
      },
      asks,
      sent: (userId) => openDiscordSentRing(root, userId),
      tokenRefused: (userId, botId) =>
        void h.refused.push(`${userId}:${botId}`),
      now: () => h.clock.t,
      newNonce: () => `nonce-${++h.nonces}`,
    });
  const replies = make();
  const add = (over: Partial<DiscordRouteCreateReq> = {}): DiscordRoute => {
    const r = routes.create(U, {
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: GENERAL,
      name: "general",
      agentId: "agent-a",
      replyMode: "bot",
      ...over,
    });
    if (!r.ok) throw new Error(`route not made: ${r.error}`);
    return r.route;
  };
  return { h, replies, make, add };
}

type Harness = ReturnType<typeof harness>;

const sendAnswer = { dismissed: false, text: "Send" };

// The status and code of a refusal, or "ok".
const outcome = (r: { ok: boolean; status?: number; code?: string }) =>
  r.ok ? "ok" : `${r.status} ${r.code}`;
const statusOf = (r: { ok: boolean; status?: number }) =>
  r.ok ? 200 : r.status;

async function drafted(
  t: Harness,
  route: DiscordRoute,
  body: { text: string; channelId?: string; replyTo?: string },
) {
  const r = await t.replies.reply("agent-a", route.id, body);
  if (!r.ok || !("askId" in r)) throw new Error(`draft refused: ${outcome(r)}`);
  const entry = t.h.asks.get(r.askId);
  if (!entry) throw new Error("no ask");
  return entry;
}

describe("discord replies: where a reply goes", () => {
  it("a channel route on a text channel posts to its channel by default, or to a thread under it; anything else is 400 and nothing goes out", async () => {
    const t = harness();
    const route = t.add();
    const sent = await t.replies.reply("agent-a", route.id, { text: "hi" });
    expect(sent).toEqual({
      ok: true,
      sent: true,
      messageId: expect.any(String),
    });
    expect(
      (
        await t.replies.reply("agent-a", route.id, {
          text: "in the thread",
          channelId: THREAD,
        })
      ).ok,
    ).toBe(true);
    expect(t.h.posts.map((p) => [p.token, p.channelId, p.req.content])).toEqual(
      [
        ["fake-token", GENERAL, "hi"],
        ["fake-token", THREAD, "in the thread"],
      ],
    );
    // Another channel of the server, the category, a channel of another
    // server, an id the bot does not know, and ids that are not snowflakes.
    for (const channelId of [
      SIDE,
      LOOSE,
      CAT,
      G2_CHAN,
      "1300000000000000099",
      "general",
      "",
      5,
    ]) {
      const r = await t.replies.reply("agent-a", route.id, {
        text: "no",
        channelId,
      });
      expect({ channelId, status: statusOf(r) }).toEqual({
        channelId,
        status: 400,
      });
    }
    expect(t.h.posts).toHaveLength(2);
  });

  it("a forum, category or server route needs a channelId, and it must be a text channel or thread that route covers now", async () => {
    const t = harness();
    const forum = t.add({ targetId: FORUM, name: "help" });
    const cat = t.add({ scope: "category", targetId: CAT, name: "talk" });
    const server = t.add({ scope: "server", targetId: GUILD, name: "all" });
    // GENERAL has its own route: the category and the server do not cover it.
    t.add({ targetId: GENERAL, name: "general" });
    for (const route of [forum, cat, server]) {
      const r = await t.replies.reply("agent-a", route.id, { text: "hi" });
      expect({ route: route.name, outcome: outcome(r) }).toEqual({
        route: route.name,
        outcome: "400 messaging_channel_required",
      });
    }
    const cases: [DiscordRoute, string, boolean][] = [
      // A forum takes posts only: the forum itself is not a place to post.
      [forum, POST, true],
      [forum, FORUM, false],
      [forum, GENERAL, false],
      [cat, SIDE, true],
      // The forum has its own route: it owns its posts.
      [cat, POST, false],
      [cat, FORUM, false],
      [cat, CAT, false],
      [cat, GENERAL, false],
      [cat, THREAD, false],
      [cat, LOOSE, false],
      [server, LOOSE, true],
      [server, SIDE, false],
      [server, GENERAL, false],
      [server, G2_CHAN, false],
    ];
    for (const [route, channelId, goes] of cases) {
      const before = t.h.posts.length;
      const r = await t.replies.reply("agent-a", route.id, {
        text: "hi",
        channelId,
      });
      expect({
        route: route.name,
        channelId,
        status: statusOf(r),
        posted: t.h.posts.length - before,
      }).toEqual({
        route: route.name,
        channelId,
        status: goes ? 200 : 400,
        posted: goes ? 1 : 0,
      });
      if (goes) expect(t.h.posts.at(-1)!.channelId).toBe(channelId);
    }
  });

  it("replyTo goes with the post as given; one that is not a snowflake is 400", async () => {
    const t = harness();
    const route = t.add();
    expect(
      (await t.replies.reply("agent-a", route.id, { text: "a", replyTo: MSG }))
        .ok,
    ).toBe(true);
    expect(t.h.posts[0].req.replyTo).toBe(MSG);
    expect((await t.replies.reply("agent-a", route.id, { text: "b" })).ok).toBe(
      true,
    );
    expect(t.h.posts[1].req.replyTo).toBeUndefined();
    for (const replyTo of ["abc", "", 17, "-1"]) {
      const r = await t.replies.reply("agent-a", route.id, {
        text: "c",
        replyTo,
      });
      expect({ replyTo, status: statusOf(r) }).toEqual({
        replyTo,
        status: 400,
      });
    }
    expect(t.h.posts).toHaveLength(2);
  });
});

describe("discord replies: the checks before a reply, in order", () => {
  it("every agent but the route's gets the same 404 as a miss, before any field check", async () => {
    const t = harness();
    const route = t.add({ scope: "category", targetId: CAT, name: "talk" });
    const miss = await t.replies.reply("agent-a", "d_ffffffff", { text: "hi" });
    expect(outcome(miss)).toBe("404 not_found");
    // Fields that would each be a 400 for the route's own agent.
    for (const agentId of ["agent-b", "agent-bob", "agent-gone"])
      for (const body of [
        { text: "hi" },
        { text: "", channelId: "x" },
        { text: 5, replyTo: "y" },
      ]) {
        const r = await t.replies.reply(agentId, route.id, body);
        expect({ agentId, body, r }).toEqual({ agentId, body, r: miss });
      }
    expect(t.h.posts).toEqual([]);
    expect(t.h.asks.listForAgent("agent-b")).toEqual([]);
  });

  it("a route whose agent fails its check is 409 messaging_route_dead before the fields; a read-only route is 409 messaging_read_only", async () => {
    const t = harness();
    const route = t.add();
    const read = t.add({ targetId: LOOSE, name: "random", replyMode: "read" });
    expect(
      outcome(await t.replies.reply("agent-a", read.id, { text: "hi" })),
    ).toBe("409 messaging_read_only");
    t.h.agents.set("agent-a", { userId: U, access: "chat", name: "Helper" });
    for (const body of [{ text: "hi" }, { text: "", channelId: "bad" }])
      expect(outcome(await t.replies.reply("agent-a", route.id, body))).toBe(
        "409 messaging_route_dead",
      );
    expect(t.h.posts).toEqual([]);
    expect(t.h.asks.listForAgent("agent-a")).toEqual([]);
  });

  it("a text that is not a string or is blank is 400; the cap counts the prefix and one space, in UTF-16 units", async () => {
    const t = harness();
    const plain = t.add();
    const prefixed = t.add({
      targetId: LOOSE,
      name: "random",
      prefix: "[Helper]",
    });
    const room = DISCORD_REPLY_MAX_CHARS - "[Helper]".length - 1;
    const cases: [string, unknown, boolean][] = [
      [plain.id, undefined, false],
      [plain.id, 42, false],
      [plain.id, "   \n ", false],
      [plain.id, "x".repeat(DISCORD_REPLY_MAX_CHARS), true],
      [plain.id, "x".repeat(DISCORD_REPLY_MAX_CHARS + 1), false],
      // A surrogate pair is two units.
      [plain.id, "😀".repeat(DISCORD_REPLY_MAX_CHARS / 2), true],
      [plain.id, "😀".repeat(DISCORD_REPLY_MAX_CHARS / 2) + "a", false],
      [prefixed.id, "x".repeat(room), true],
      [prefixed.id, "x".repeat(room + 1), false],
    ];
    for (const [routeId, text, fits] of cases) {
      const r = await t.replies.reply("agent-a", routeId, { text });
      expect({
        routeId,
        length: typeof text === "string" ? text.length : text,
        status: statusOf(r),
      }).toEqual({
        routeId,
        length: typeof text === "string" ? text.length : text,
        status: fits ? 200 : 400,
      });
    }
    expect(t.h.posts.map((p) => p.req.content.length)).toEqual([
      DISCORD_REPLY_MAX_CHARS,
      DISCORD_REPLY_MAX_CHARS,
      DISCORD_REPLY_MAX_CHARS,
    ]);
    expect(t.h.posts[2].req.content).toBe(`[Helper] ${"x".repeat(room)}`);
  });
});

describe("discord replies: a route that posts as the bot", () => {
  it("each reply is one post with the route's prefix as it is now and a fresh nonce that fits Discord's limit", async () => {
    const t = harness();
    const route = t.add();
    await t.replies.reply("agent-a", route.id, { text: "one" });
    t.h.routes.update(U, route.id, { prefix: "🤖" });
    await t.replies.reply("agent-a", route.id, { text: "two" });
    expect(t.h.posts.map((p) => p.req.content)).toEqual(["one", "🤖 two"]);
    const nonces = t.h.posts.map((p) => p.req.nonce);
    expect(new Set(nonces).size).toBe(2);
    for (const nonce of nonces)
      expect(nonce.length).toBeLessThanOrEqual(DISCORD_NONCE_MAX);
    expect(t.h.asks.listForAgent("agent-a")).toEqual([]);
  });

  it("answers the posted message's id", async () => {
    const t = harness();
    const route = t.add();
    t.h.answers.push({ ok: true, id: "1800000000000000777" });
    expect(await t.replies.reply("agent-a", route.id, { text: "hi" })).toEqual({
      ok: true,
      sent: true,
      messageId: "1800000000000000777",
    });
  });

  it("Discord's refusals are 502, a network error or timeout is 504; only a refused token tells the supervisor", async () => {
    const cases: [DiscordPostResult, string, boolean][] = [
      [
        { ok: false, reason: "unauthorized", error: "401" },
        "502 messaging_send_failed",
        true,
      ],
      [
        { ok: false, reason: "forbidden", error: "403" },
        "502 messaging_send_failed",
        false,
      ],
      [
        { ok: false, reason: "not_found", error: "404" },
        "502 messaging_send_failed",
        false,
      ],
      [
        { ok: false, reason: "rejected", error: "400 archived" },
        "502 messaging_send_failed",
        false,
      ],
      [
        { ok: false, reason: "rate_limited", error: "429" },
        "502 messaging_send_failed",
        false,
      ],
      [
        { ok: false, reason: "failed", error: "500" },
        "502 messaging_send_failed",
        false,
      ],
      [
        { ok: false, reason: "unknown", error: "timeout" },
        "504 messaging_send_unknown",
        false,
      ],
    ];
    for (const [answer, expected, refused] of cases) {
      const t = harness();
      const route = t.add();
      t.h.answers.push(answer);
      const r = await t.replies.reply("agent-a", route.id, { text: "hi" });
      expect({
        reason: answer.ok || answer.reason,
        r: outcome(r),
        refused: t.h.refused,
      }).toEqual({
        reason: answer.ok || answer.reason,
        r: expected,
        refused: refused ? [`${U}:${BOT}`] : [],
      });
    }
  });

  it("a bot that is not connected is 502 messaging_not_linked and reaches no post", async () => {
    const t = harness();
    const route = t.add();
    t.h.connected = false;
    expect(
      outcome(await t.replies.reply("agent-a", route.id, { text: "hi" })),
    ).toBe("502 messaging_not_linked");
    expect(t.h.posts).toEqual([]);
  });

  it("at most the cap of posts per route in the window: one more is 429 and does not go out; another route still posts; the oldest leaving the window frees a place; a refusal before Discord takes no place", async () => {
    const t = harness();
    const route = t.add();
    const other = t.add({ targetId: LOOSE, name: "random" });
    // Not connected: answered before Discord, so it takes no place.
    t.h.connected = false;
    await t.replies.reply("agent-a", route.id, { text: "not linked" });
    t.h.connected = true;
    // A failed post may still have gone out: it counts.
    t.h.answers.push({ ok: false, reason: "unknown", error: "timeout" });
    for (let i = 0; i < DISCORD_SENDS_MAX; i++) {
      t.h.clock.t = T0 + i * 1000;
      await t.replies.reply("agent-a", route.id, { text: `m${i}` });
    }
    expect(t.h.posts).toHaveLength(DISCORD_SENDS_MAX);
    const over = await t.replies.reply("agent-a", route.id, { text: "over" });
    expect(outcome(over)).toBe("429 too_many_sends");
    expect(t.h.posts).toHaveLength(DISCORD_SENDS_MAX);
    expect((await t.replies.reply("agent-a", other.id, { text: "x" })).ok).toBe(
      true,
    );
    t.h.clock.t = T0 + DISCORD_SENDS_WINDOW_MS;
    expect((await t.replies.reply("agent-a", route.id, { text: "y" })).ok).toBe(
      true,
    );
    expect(
      outcome(await t.replies.reply("agent-a", route.id, { text: "z" })),
    ).toBe("429 too_many_sends");
  });
});

describe("discord replies: a draft", () => {
  it("the route's agent opens one ask to the route's member with the text, the channel and the message it answers; Send and Don't send; nothing goes out", async () => {
    const t = harness();
    const route = t.add({
      scope: "category",
      targetId: CAT,
      name: "talk",
      replyMode: "ask",
    });
    const text = "see `you` at 5\n```\nbring the cake";
    const r = await t.replies.reply("agent-a", route.id, {
      text,
      channelId: SIDE,
      replyTo: MSG,
    });
    expect(r.ok).toBe(true);
    const all = t.h.asks.listForAgent("agent-a");
    expect(all).toHaveLength(1);
    const [entry] = all;
    expect("askId" in r && r.askId).toBe(entry.id);
    expect(entry.memberUserId).toBe(U);
    expect(entry.messaging).toEqual({
      app: "discord",
      routeId: route.id,
      text,
      channelId: SIDE,
      replyTo: MSG,
    });
    expect(entry.options).toEqual([
      DISCORD_SEND_OPTION,
      DISCORD_DONT_SEND_OPTION,
    ]);
    expect(entry.recommended).toBeUndefined();
    // The text sits in a fence longer than any run of backticks in it.
    expect(entry.prompt).toContain(`\`\`\`\`\n${text}\n\`\`\`\``);
    expect(entry.prompt).toContain("talk");
    expect(t.h.posts).toEqual([]);
  });

  it("a draft gets the same field checks as a post: no channel on a category route, or one it does not cover, is 400 and nothing opens", async () => {
    const t = harness();
    const route = t.add({
      scope: "category",
      targetId: CAT,
      name: "talk",
      replyMode: "ask",
    });
    for (const body of [
      { text: "hi" },
      { text: "hi", channelId: LOOSE },
      { text: "hi", channelId: SIDE, replyTo: "x" },
      { text: "" },
    ]) {
      const r = await t.replies.reply("agent-a", route.id, body);
      expect({ body, status: statusOf(r) }).toEqual({ body, status: 400 });
    }
    expect(t.h.asks.listForAgent("agent-a")).toEqual([]);
  });

  it("at most the cap of open drafts per route: one more is 429, another route still takes one, and an answered one frees a place", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    const other = t.add({ targetId: LOOSE, name: "random", replyMode: "ask" });
    const ids: string[] = [];
    for (let i = 0; i < DISCORD_DRAFTS_PER_ROUTE_MAX; i++) {
      const r = await t.replies.reply("agent-a", route.id, { text: `d${i}` });
      if (!r.ok || !("askId" in r)) throw new Error(`draft ${i} refused`);
      ids.push(r.askId);
    }
    expect(
      outcome(await t.replies.reply("agent-a", route.id, { text: "more" })),
    ).toBe("429 too_many_drafts");
    expect((await t.replies.reply("agent-a", other.id, { text: "x" })).ok).toBe(
      true,
    );
    t.h.asks.remove(ids[0], { outcome: "dismissed" });
    expect(
      (await t.replies.reply("agent-a", route.id, { text: "fits" })).ok,
    ).toBe(true);
  });
});

describe("discord replies: the member's answer", () => {
  it("Send: one post to the draft's channel with the prefix as it is now, its replyTo, and the ask's own nonce; the agent is told", async () => {
    const t = harness();
    const route = t.add({
      scope: "category",
      targetId: CAT,
      name: "talk",
      replyMode: "ask",
    });
    const entry = await drafted(t, route, {
      text: "on my way",
      channelId: SIDE,
      replyTo: MSG,
    });
    t.h.routes.update(U, route.id, { prefix: "[Helper]" });
    const result = await t.replies.answer(entry, {
      dismissed: false,
      text: "send\nthanks",
    });
    expect(t.h.posts).toEqual([
      {
        token: "fake-token",
        channelId: SIDE,
        req: {
          content: "[Helper] on my way",
          replyTo: MSG,
          nonce: nonceForAsk(entry.id),
        },
      },
    ]);
    expect(result).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(result.kind === "deliver" && result.refusal).toBeUndefined();
    expect(result.kind === "deliver" && result.text.includes("thanks")).toBe(
      true,
    );
  });

  it("a channel route's draft with no channelId posts to the route's channel", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    const entry = await drafted(t, route, { text: "hi" });
    await t.replies.answer(entry, sendAnswer);
    expect(t.h.posts.map((p) => [p.channelId, p.req.replyTo])).toEqual([
      [GENERAL, undefined],
    ]);
  });

  it("Don't send, other words or a dismiss: nothing goes out, and the agent gets the member's words", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    for (const input of [
      { dismissed: false, text: DISCORD_DONT_SEND_OPTION },
      { dismissed: false, text: "say it nicer please" },
      { dismissed: true, text: undefined },
    ]) {
      const entry = await drafted(t, route, { text: "hi" });
      const result = await t.replies.answer(entry, input);
      expect({ input, kind: result.kind }).toEqual({ input, kind: "deliver" });
      if (input.text === "say it nicer please")
        expect(result.kind === "deliver" && result.text).toContain(input.text);
      if (input.dismissed)
        expect(result.kind === "deliver" && result.outcome).toBe("dismissed");
    }
    expect(t.h.posts).toEqual([]);
  });

  it("a post that fails keeps the ask open (502, 504); a refused token tells the supervisor; Send again posts under the same nonce", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    const entry = await drafted(t, route, { text: "hi" });
    t.h.answers.push(
      { ok: false, reason: "unknown", error: "timeout" },
      { ok: false, reason: "unauthorized", error: "401" },
    );
    const first = await t.replies.answer(entry, sendAnswer);
    expect(first.kind === "fail" && `${first.status} ${first.code}`).toBe(
      "504 messaging_send_unknown",
    );
    const second = await t.replies.answer(entry, sendAnswer);
    expect(second.kind === "fail" && `${second.status} ${second.code}`).toBe(
      "502 messaging_send_failed",
    );
    expect(t.h.refused).toEqual([`${U}:${BOT}`]);
    const third = await t.replies.answer(entry, sendAnswer);
    expect(third.kind).toBe("deliver");
    expect(t.h.posts.map((p) => p.req.nonce)).toEqual([
      nonceForAsk(entry.id),
      nonceForAsk(entry.id),
      nonceForAsk(entry.id),
    ]);
  });

  it("a bot that is not connected at Send keeps the ask open with 502 messaging_not_linked", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    const entry = await drafted(t, route, { text: "hi" });
    t.h.connected = false;
    const result = await t.replies.answer(entry, sendAnswer);
    expect(result.kind === "fail" && `${result.status} ${result.code}`).toBe(
      "502 messaging_not_linked",
    );
    expect(t.h.posts).toEqual([]);
  });

  it("a Send after one that went out posts nothing more, after a restart too, and the agent is told again", async () => {
    const t = harness();
    const route = t.add({ replyMode: "ask" });
    const entry = await drafted(t, route, { text: "hi" });
    expect((await t.replies.answer(entry, sendAnswer)).kind).toBe("deliver");
    const again = await t.replies.answer(entry, sendAnswer);
    expect(again).toMatchObject({ kind: "deliver", outcome: "replied" });
    // A restart: a new instance over the same STATE_ROOT reads the ring on
    // disk.
    const restarted = await t.make().answer(entry, sendAnswer);
    expect(restarted).toMatchObject({ kind: "deliver", outcome: "replied" });
    expect(t.h.posts).toHaveLength(1);
  });

  it("the route at Send time decides: gone, dead, another agent's, or the channel no longer its own: nothing goes out, the agent is told and the member gets 409", async () => {
    const changes: [string, (t: Harness, route: DiscordRoute) => void][] = [
      ["route deleted", (t, r) => void t.h.routes.remove(U, r.id)],
      [
        "agent at Chat stop",
        (t) =>
          t.h.agents.set("agent-a", {
            userId: U,
            access: "chat",
            name: "Helper",
          }),
      ],
      [
        "route re-pointed",
        (t, r) => void t.h.routes.update(U, r.id, { agentId: "agent-b" }),
      ],
      ["agent gone", (t) => void t.h.agents.delete("agent-a")],
      [
        "the channel got its own route",
        (t) => void t.add({ targetId: SIDE, name: "side", agentId: "agent-b" }),
      ],
    ];
    for (const [label, change] of changes) {
      const t = harness();
      const route = t.add({
        scope: "category",
        targetId: CAT,
        name: "talk",
        replyMode: "ask",
      });
      const entry = await drafted(t, route, { text: "hi", channelId: SIDE });
      change(t, route);
      const result = await t.replies.answer(entry, sendAnswer);
      expect([label, t.h.posts.length]).toEqual([label, 0]);
      expect([
        label,
        result.kind === "deliver" && result.refusal?.status,
      ]).toEqual([label, 409]);
      expect(result.kind === "deliver" && result.text.length > 0).toBe(true);
    }
  });
});

describe("discord replies: the nonce of a Send", () => {
  it("is the same for one ask, differs between asks, and fits Discord's limit", () => {
    const t = harness();
    const ids = [1, 2, 3].map((i) => {
      const r = t.h.asks.create({
        agentId: "agent-a",
        memberUserId: U,
        prompt: `q${i}`,
      });
      if (!r.ok) throw new Error("no ask");
      return r.entry.id;
    });
    // Long ids that differ only at the end too.
    ids.push(`${"a".repeat(60)}1`, `${"a".repeat(60)}2`);
    const nonces = ids.map(nonceForAsk);
    expect(ids.map(nonceForAsk)).toEqual(nonces);
    expect(new Set(nonces).size).toBe(ids.length);
    for (const nonce of nonces) {
      expect(nonce.length).toBeGreaterThan(0);
      expect(nonce.length).toBeLessThanOrEqual(DISCORD_NONCE_MAX);
    }
  });
});
