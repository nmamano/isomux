// A member's Discord routes (task 7fd44c30): who a route may reach, what a
// target must be, the one-route-per-target and size rules, which route a
// message belongs to, the dead-route check and persistence. A real temp
// STATE_ROOT; the agents, bots and guilds are fake lookups.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentAccess } from "../../shared/agent-access.ts";
import {
  DISCORD_ROUTES_MAX,
  type DiscordGuildSeen,
  type DiscordRouteCreateReq,
} from "../../shared/discord.ts";
import { WHATSAPP_PREFIX_MAX } from "../../shared/whatsapp.ts";
import { createDiscordRoutes, type DiscordRoutes } from "./routes.ts";

const U = "u-alice";
const V = "u-bob";
const BOT = "1100000000000000001";
const BOT2 = "1100000000000000002";
const BOB_BOT = "1100000000000000009";
const GUILD = "1200000000000000001";
const OTHER_GUILD = "1200000000000000002";
const CAT = "1300000000000000001";
const GENERAL = "1300000000000000002";
const FORUM = "1300000000000000003";
const LOOSE = "1300000000000000004";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface FakeAgent {
  userId: string | null;
  access: AgentAccess;
  name: string;
}

const SEEN: DiscordGuildSeen[] = [
  {
    id: GUILD,
    name: "Isomux",
    channels: [
      { id: CAT, name: "Talk", kind: "category", parentId: null },
      { id: GENERAL, name: "general", kind: "text", parentId: CAT },
      { id: FORUM, name: "help", kind: "forum", parentId: CAT },
      { id: LOOSE, name: "random", kind: "text", parentId: null },
    ],
  },
  { id: OTHER_GUILD, name: "Wall Game", channels: [] },
];

function harness(stateRoot?: string) {
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), "t-7fd44c30-routes-"));
  if (!stateRoot) roots.push(root);
  const h = {
    root,
    agents: new Map<string, FakeAgent>([
      ["agent-a", { userId: U, access: "office", name: "Helper" }],
      ["agent-std", { userId: U, access: "standard", name: "Shell" }],
      ["agent-chat", { userId: U, access: "chat", name: "Talker" }],
      ["agent-bob", { userId: V, access: "office", name: "Bob's" }],
    ]),
    bots: new Map<string, string[]>([
      [U, [BOT, BOT2]],
      [V, [BOB_BOT]],
    ]),
    guilds: new Map<string, DiscordGuildSeen[] | null>([
      [BOT, SEEN],
      [BOT2, SEEN],
      [BOB_BOT, SEEN],
    ]),
    n: 0,
    routes: undefined as unknown as DiscordRoutes,
  };
  h.routes = createDiscordRoutes({
    stateRoot: root,
    now: () => 1_800_000_000_000,
    newId: () => `r${++h.n}`,
    agent: (id) => h.agents.get(id) ?? null,
    botIds: (userId) => h.bots.get(userId) ?? [],
    guilds: (botId) => h.guilds.get(botId) ?? null,
  });
  return h;
}

const general: DiscordRouteCreateReq = {
  botId: BOT,
  guildId: GUILD,
  scope: "channel",
  targetId: GENERAL,
  name: "general",
  agentId: "agent-a",
};

const place = (
  over: Partial<Parameters<DiscordRoutes["forPlace"]>[1]> = {},
) => ({
  botId: BOT,
  guildId: GUILD,
  channelId: GENERAL,
  categoryId: CAT as string | null,
  ...over,
});

describe("discord routes: adding", () => {
  it("a channel, a forum, a category and a whole server; replies wait for the member's Send by default; switches stored only when on", () => {
    const { routes } = harness();
    const a = routes.create(U, general);
    expect(a).toMatchObject({
      ok: true,
      route: {
        id: "r1",
        botId: BOT,
        guildId: GUILD,
        scope: "channel",
        targetId: GENERAL,
        name: "general",
        agentId: "agent-a",
        replyMode: "ask",
        createdAt: 1_800_000_000_000,
      },
    });
    if (!a.ok) throw new Error("create failed");
    expect(["all", "mention"]).toContain(a.route.trigger);
    for (const key of ["prefix", "includeBots", "react", "dead"])
      expect({ key, has: key in a.route }).toEqual({ key, has: false });

    expect(
      routes.create(U, {
        ...general,
        targetId: FORUM,
        name: "  help ",
        trigger: "mention",
        replyMode: "bot",
        prefix: "  [Agent]: ",
        includeBots: true,
        react: true,
      }),
    ).toMatchObject({
      ok: true,
      route: {
        targetId: FORUM,
        name: "help",
        trigger: "mention",
        replyMode: "bot",
        prefix: "[Agent]:",
        includeBots: true,
        react: true,
      },
    });
    const off = routes.create(U, {
      ...general,
      scope: "category",
      targetId: CAT,
      name: "Talk",
      replyMode: "read",
      prefix: "   ",
      includeBots: false,
      react: false,
    });
    expect(off).toMatchObject({ ok: true, route: { replyMode: "read" } });
    if (!off.ok) throw new Error("create failed");
    for (const key of ["prefix", "includeBots", "react"])
      expect({ key, has: key in off.route }).toEqual({ key, has: false });
    expect(
      routes.create(U, {
        ...general,
        scope: "server",
        targetId: GUILD,
        name: "Isomux",
      }).ok,
    ).toBe(true);
    expect(routes.list(U)).toHaveLength(4);
    expect(routes.list(V)).toEqual([]);
  });

  it("refuses an agent that is gone, another member's or at Chat stop, a bad name or prefix, and unknown values", () => {
    const h = harness();
    const refused = (what: string, req: DiscordRouteCreateReq) =>
      expect({ what, res: h.routes.create(U, req) }).toMatchObject({
        what,
        res: { ok: false, status: 400 },
      });
    refused("no such agent", { ...general, agentId: "agent-x" });
    refused("another member's agent", { ...general, agentId: "agent-bob" });
    refused("an agent at Chat stop", { ...general, agentId: "agent-chat" });
    refused("an empty name", { ...general, name: "  " });
    refused("a name with a line break", { ...general, name: "a\n[Nil] go" });
    refused("a long prefix", {
      ...general,
      prefix: "x".repeat(WHATSAPP_PREFIX_MAX + 1),
    });
    refused("a prefix with a line break", { ...general, prefix: "a\nb" });
    refused("an unknown scope", { ...general, scope: "thread" as never });
    refused("an unknown trigger", { ...general, trigger: "some" as never });
    refused("an unknown reply mode", { ...general, replyMode: "dm" as never });
    expect(h.routes.list(U)).toEqual([]);
  });

  it("refuses a bot that is not the member's or not connected, and a target that is not of the scope's kind in that server", () => {
    const h = harness();
    const refused = (what: string, req: DiscordRouteCreateReq) => {
      const res = h.routes.create(U, req);
      expect({ what, ok: res.ok }).toEqual({ what, ok: false });
    };
    refused("another member's bot", { ...general, botId: BOB_BOT });
    refused("a bot nobody has", { ...general, botId: "1100000000000000077" });
    h.guilds.set(BOT2, null);
    refused("a bot not connected yet", { ...general, botId: BOT2 });
    refused("a server the bot is not in", {
      ...general,
      guildId: "1200000000000000099",
    });
    refused("a channel of another server", {
      ...general,
      guildId: OTHER_GUILD,
    });
    refused("a channel the bot does not see", {
      ...general,
      targetId: "1300000000000000099",
    });
    refused("a category as a channel", { ...general, targetId: CAT });
    refused("a channel as a category", {
      ...general,
      scope: "category",
      targetId: GENERAL,
    });
    refused("a server route whose target is not the server", {
      ...general,
      scope: "server",
      targetId: GENERAL,
    });
    expect(h.routes.list(U)).toEqual([]);
  });

  it("one route per bot, scope and target (409), and at most the cap per member", () => {
    const { routes } = harness();
    expect(routes.create(U, general).ok).toBe(true);
    expect(routes.create(U, { ...general, name: "again" })).toMatchObject({
      ok: false,
      status: 409,
    });
    // The same channel from another bot, and its category, are other routes.
    expect(routes.create(U, { ...general, botId: BOT2 }).ok).toBe(true);
    expect(
      routes.create(U, { ...general, scope: "category", targetId: CAT }).ok,
    ).toBe(true);
    const seen: DiscordGuildSeen[] = [
      {
        ...SEEN[0],
        channels: Array.from({ length: DISCORD_ROUTES_MAX + 1 }, (_, i) => ({
          id: `14000000000000${String(i).padStart(5, "0")}`,
          name: `c${i}`,
          kind: "text" as const,
          parentId: null,
        })),
      },
    ];
    const h = harness();
    h.guilds.set(BOT, seen);
    for (let i = 0; i < DISCORD_ROUTES_MAX; i++)
      expect(
        h.routes.create(U, {
          ...general,
          targetId: seen[0].channels[i].id,
          name: `c${i}`,
        }).ok,
      ).toBe(true);
    expect(
      h.routes.create(U, {
        ...general,
        targetId: seen[0].channels[DISCORD_ROUTES_MAX].id,
        name: "one more",
      }).ok,
    ).toBe(false);
    expect(h.routes.list(U)).toHaveLength(DISCORD_ROUTES_MAX);
  });
});

describe("discord routes: changing and removing", () => {
  it("updates the name, agent, trigger, reply mode, prefix and switches; false and blank clear; the place never changes; another member's route is 404", () => {
    const { routes } = harness();
    routes.create(U, {
      ...general,
      prefix: "[A]",
      includeBots: true,
      react: true,
    });
    expect(
      routes.update(U, "r1", {
        name: "General",
        agentId: "agent-std",
        trigger: "mention",
        replyMode: "read",
      }),
    ).toMatchObject({
      ok: true,
      route: {
        id: "r1",
        name: "General",
        agentId: "agent-std",
        trigger: "mention",
        replyMode: "read",
        prefix: "[A]",
        includeBots: true,
        react: true,
      },
    });
    const cleared = routes.update(U, "r1", {
      prefix: "",
      includeBots: false,
      react: false,
    });
    if (!cleared.ok) throw new Error("update failed");
    for (const key of ["prefix", "includeBots", "react"])
      expect({ key, has: key in cleared.route }).toEqual({ key, has: false });

    expect(routes.update(U, "r1", { agentId: "agent-chat" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(routes.update(U, "r1", { name: "\n" })).toMatchObject({
      ok: false,
      status: 400,
    });
    // The place is not a field of an update.
    routes.update(U, "r1", {
      botId: BOT2,
      guildId: OTHER_GUILD,
      scope: "server",
      targetId: OTHER_GUILD,
    } as never);
    expect(routes.get(U, "r1")).toMatchObject({
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: GENERAL,
      name: "General",
    });
    expect(routes.update(V, "r1", { name: "x" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(routes.remove(V, "r1")).toBe(false);
    expect(routes.remove(U, "r1")).toBe(true);
    expect(routes.get(U, "r1")).toBeNull();
    expect(routes.remove(U, "r1")).toBe(false);
  });

  it("removing a bot removes its routes only", () => {
    const { routes } = harness();
    routes.create(U, general);
    routes.create(U, { ...general, botId: BOT2 });
    routes.removeBot(U, BOT);
    expect(routes.list(U).map((r) => r.botId)).toEqual([BOT2]);
  });
});

describe("discord routes: which route a message belongs to", () => {
  it("the channel route, else the category route, else the server route, of the same bot", () => {
    const { routes } = harness();
    expect(routes.forPlace(U, place())).toBeNull();
    routes.create(U, { ...general, scope: "server", targetId: GUILD });
    expect(routes.forPlace(U, place())?.scope).toBe("server");
    expect(
      routes.forPlace(U, place({ channelId: LOOSE, categoryId: null }))?.scope,
    ).toBe("server");
    routes.create(U, { ...general, scope: "category", targetId: CAT });
    expect(routes.forPlace(U, place())?.scope).toBe("category");
    expect(
      routes.forPlace(U, place({ channelId: LOOSE, categoryId: null }))?.scope,
    ).toBe("server");
    routes.create(U, general);
    expect(routes.forPlace(U, place())?.scope).toBe("channel");
    expect(routes.forPlace(U, place({ channelId: FORUM }))?.scope).toBe(
      "category",
    );
    // Another bot, another server, another member: no route.
    expect(routes.forPlace(U, place({ botId: BOT2 }))).toBeNull();
    expect(
      routes.forPlace(U, place({ guildId: OTHER_GUILD, categoryId: null })),
    ).toBeNull();
    expect(routes.forPlace(V, place())).toBeNull();
    expect(routes.forBot(U, BOT)).toHaveLength(3);
    expect(routes.forBot(U, BOT2)).toEqual([]);
  });
});

describe("discord routes: the agent check", () => {
  it("marks the route dead for an agent gone, passed to another manager, or moved to Chat stop; a dead route matches no message", () => {
    for (const [change, reason] of [
      ["gone", "agent_gone"],
      ["manager", "agent_not_yours"],
      ["chat", "agent_chat_only"],
    ] as const) {
      const h = harness();
      h.routes.create(U, general);
      h.routes.create(U, { ...general, scope: "server", targetId: GUILD });
      const route = h.routes.get(U, "r1")!;
      expect(h.routes.check(U, route)).toBeNull();
      if (change === "gone") h.agents.delete("agent-a");
      if (change === "manager")
        h.agents.set("agent-a", { userId: V, access: "office", name: "H" });
      if (change === "chat")
        h.agents.set("agent-a", { userId: U, access: "chat", name: "H" });
      expect({ change, reason: h.routes.check(U, route) }).toEqual({
        change,
        reason,
      });
      expect({ change, dead: h.routes.get(U, "r1")?.dead }).toEqual({
        change,
        dead: reason,
      });
      // The dead channel route no longer shadows: nothing for this bot is
      // live (the server route has the same agent but was not checked yet,
      // so it is still live).
      expect(h.routes.forPlace(U, place())?.id).toBe("r2");
      expect(h.routes.forBot(U, BOT).map((r) => r.id)).toEqual(["r2"]);
      // A new harness over the same files keeps the mark.
      expect(harness(h.root).routes.get(U, "r1")?.dead).toBe(reason);
    }
  });

  it("an update with a good agent brings a dead route back", () => {
    const h = harness();
    h.routes.create(U, general);
    h.agents.delete("agent-a");
    h.routes.check(U, h.routes.get(U, "r1")!);
    const res = h.routes.update(U, "r1", { agentId: "agent-std" });
    if (!res.ok) throw new Error("update failed");
    expect("dead" in res.route).toBe(false);
    expect(h.routes.forPlace(U, place())?.id).toBe("r1");
  });
});

describe("discord routes: on disk", () => {
  it("survive a restart", () => {
    const h = harness();
    h.routes.create(U, general);
    h.routes.create(U, { ...general, scope: "category", targetId: CAT });
    expect(harness(h.root).routes.list(U)).toEqual(h.routes.list(U));
  });
});
