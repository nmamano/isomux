// Whose agent a Discord route may reach (task 386ec4d6), through the real
// server: an agent the member manages, or any agent for an office owner, as
// for a WhatsApp row. A route of an owner to another member's agent stays
// live, and that agent's reply finds the owner's route: on a route whose
// replies wait for Send, the draft is in the owner's Inbox. When the owner
// is no longer an owner, the route is dead.
//
// Seam: startTestServer(). Bots written after boot are stored with no
// gateway child; the supervisor's guild reads and the bot's view are
// stubbed, as the gateway holds them in memory.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { discordSupervisor } from "../office-managers.ts";
import { writeBots, writeDiscordRoutes } from "../discord/store.ts";
import type { DiscordBotView } from "../discord/inbound.ts";
import type { AgentInfo } from "../../shared/types.ts";
import type { DiscordGuildSeen, DiscordRoute } from "../../shared/discord.ts";

let server: TestServer | null = null;
const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await server?.stop();
  server = null;
});

const MORGAN_BOT = "1100000000000000001";
const CASEY_BOT = "1100000000000000002";
const GUILD = "1200000000000000001";
const GENERAL = "1300000000000000001";
const SIDE = "1300000000000000002";

const GUILDS: DiscordGuildSeen[] = [
  {
    id: GUILD,
    name: "Akido HQ",
    channels: [
      { id: GENERAL, name: "general", kind: "text", parentId: null },
      { id: SIDE, name: "side", kind: "text", parentId: null },
    ],
  },
];

async function api(
  srv: TestServer,
  path: string,
  rawSessionId: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers:
      init.body !== undefined ? { "Content-Type": "application/json" } : {},
    rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A connected bot as the gateway would show it: every channel of GUILDS is
// a text channel the bot sees.
function viewOf(userId: string, botId: string): DiscordBotView {
  const channel = (id: string) =>
    GUILDS[0].channels.find((c) => c.id === id) ?? null;
  return {
    userId,
    botUserId: botId,
    botName: "Bot",
    token: `token-${botId}`,
    roleIds: () => [],
    place: (guildId, channelId) => {
      const c = channel(channelId);
      return guildId === GUILD && c
        ? { botId, guildId, channelId, categoryId: null, channelName: c.name }
        : null;
    },
    kindOf: (guildId, channelId) =>
      guildId === GUILD ? (channel(channelId)?.kind ?? null) : null,
    textChannels: () => GUILDS[0].channels.map((c) => c.id),
  };
}

// Morgan and Dana own the office; Casey is a member with its first room.
async function office() {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  const dana = await srv.seedMember("Dana");
  const casey = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  // Dana becomes the second owner.
  expect(
    (
      await api(srv, `/api/users/${dana.username}`, morgan.rawSessionId, {
        method: "PATCH",
        body: { role: "owner" },
      })
    ).status,
  ).toBe(200);
  const ids = {
    morgan: getUserByName(morgan.username)!.id,
    casey: getUserByName(casey.username)!.id,
  };
  expect(
    (
      await api(
        srv,
        `/api/users/${casey.username}/access`,
        morgan.rawSessionId,
        {
          method: "PUT",
          body: { allowedRooms: [room] },
        },
      )
    ).status,
  ).toBe(200);
  const spawn = async (name: string, who: "morgan" | "casey") => {
    const user = who === "morgan" ? morgan : casey;
    const a = await srv.agentManager.spawn(
      name,
      srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      user.username,
      "claude",
      undefined,
      ids[who],
    );
    if (!a) throw new Error(`spawn ${name} failed`);
    return a;
  };
  const owners: Record<string, string> = {};
  // The member's bot, stored with these routes, and seeing GUILDS.
  const botOf = (
    userId: string,
    botId: string,
    routes: DiscordRoute[] = [],
  ) => {
    writeBots(srv.stateRoot, userId, [
      { id: botId, name: "Bot", token: `token-${botId}`, addedAt: 1 },
    ]);
    writeDiscordRoutes(srv.stateRoot, userId, routes);
    owners[botId] = userId;
  };
  spies.push(
    spyOn(discordSupervisor, "guilds").mockImplementation(
      (userId: string, botId: string) =>
        owners[botId] === userId ? GUILDS : null,
    ),
    spyOn(discordSupervisor, "guildsOfBot").mockImplementation(
      (botId: string) => (owners[botId] ? GUILDS : null),
    ),
    spyOn(discordSupervisor, "view").mockImplementation(
      (userId: string, botId: string) =>
        owners[botId] === userId ? viewOf(userId, botId) : null,
    ),
  );
  return { srv, morgan, dana, casey, ids, spawn, botOf };
}

const route = (
  id: string,
  botId: string,
  agent: AgentInfo,
  targetId = GENERAL,
): DiscordRoute => ({
  id,
  botId,
  guildId: GUILD,
  scope: "channel",
  targetId,
  name: "general",
  agentId: agent.id,
  trigger: "mention",
  replyMode: "ask",
  createdAt: 1,
});

const deadOf = async (o: Awaited<ReturnType<typeof office>>, session: string) =>
  (
    (await api(o.srv, "/api/discord/routes", session)).body as DiscordRoute[]
  ).map((r) => [r.id, r.dead ?? null]);

describe("a Discord route's agent", () => {
  it("an owner adds a route to another member's agent and it stays live; a member cannot add one to an owner's agent", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const helper = await o.spawn("Helper", "morgan");
    o.botOf(o.ids.morgan, MORGAN_BOT);
    o.botOf(o.ids.casey, CASEY_BOT);

    const added = await api(
      o.srv,
      "/api/discord/routes",
      o.morgan.rawSessionId,
      {
        method: "POST",
        body: {
          botId: MORGAN_BOT,
          guildId: GUILD,
          scope: "channel",
          targetId: GENERAL,
          name: "general",
          agentId: pm.id,
        },
      },
    );
    expect(added.status).toBe(200);
    const id = (added.body as DiscordRoute).id;
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([[id, null]]);

    // An owner may also move a route to another member's agent.
    const own = await api(o.srv, "/api/discord/routes", o.morgan.rawSessionId, {
      method: "POST",
      body: {
        botId: MORGAN_BOT,
        guildId: GUILD,
        scope: "channel",
        targetId: SIDE,
        name: "side",
        agentId: helper.id,
      },
    });
    expect(own.status).toBe(200);
    const ownId = (own.body as DiscordRoute).id;
    const moved = await api(
      o.srv,
      `/api/discord/routes/${ownId}`,
      o.morgan.rawSessionId,
      { method: "PATCH", body: { agentId: pm.id } },
    );
    expect(moved.status).toBe(200);
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([
      [id, null],
      [ownId, null],
    ]);

    const refused = await api(
      o.srv,
      "/api/discord/routes",
      o.casey.rawSessionId,
      {
        method: "POST",
        body: {
          botId: CASEY_BOT,
          guildId: GUILD,
          scope: "channel",
          targetId: GENERAL,
          name: "general",
          agentId: helper.id,
        },
      },
    );
    expect(refused.status).toBe(400);
    expect(await deadOf(o, o.casey.rawSessionId)).toEqual([]);
  });

  it("an owner's route to another member's agent goes dead when the owner becomes a member; the route to their own agent stays live", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const helper = await o.spawn("Helper", "morgan");
    o.botOf(o.ids.morgan, MORGAN_BOT, [
      route("d_1", MORGAN_BOT, pm),
      route("d_2", MORGAN_BOT, helper, SIDE),
    ]);
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([
      ["d_1", null],
      ["d_2", null],
    ]);
    const demoted = await api(
      o.srv,
      `/api/users/${o.morgan.username}`,
      o.dana.rawSessionId,
      { method: "PATCH", body: { role: "member" } },
    );
    expect(demoted.status).toBe(200);
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([
      ["d_1", "agent_not_yours"],
      ["d_2", null],
    ]);
  });
});

describe("a reply on an owner's Discord route to another member's agent", () => {
  const post = (
    o: Awaited<ReturnType<typeof office>>,
    agent: AgentInfo,
    routeId: string,
  ) =>
    o.srv.http(`/api/messaging/routes/${routeId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${mintAgentToken(agent.id, agent.userId!)}`,
      },
      body: "Read it, thanks.",
    });
  const asksOf = async (
    o: Awaited<ReturnType<typeof office>>,
    session: string,
  ) =>
    (
      (await api(o.srv, "/api/asks", session)).body as {
        agentId: string;
        memberUserId: string;
      }[]
    ).map((e) => [e.agentId, e.memberUserId]);

  it("is a draft in the owner's Inbox; another agent of the same manager gets 404", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const other = await o.spawn("Other", "casey");
    o.botOf(o.ids.morgan, MORGAN_BOT, [route("d_1", MORGAN_BOT, pm)]);
    // Casey has a bot and no route: the PM's manager holds no d_1.
    o.botOf(o.ids.casey, CASEY_BOT);

    expect((await post(o, other, "d_1")).status).toBe(404);
    expect(await asksOf(o, o.morgan.rawSessionId)).toEqual([]);

    const drafted = await post(o, pm, "d_1");
    expect(drafted.status).toBe(202);
    expect(await asksOf(o, o.morgan.rawSessionId)).toEqual([
      [pm.id, o.ids.morgan],
    ]);
    expect(await asksOf(o, o.casey.rawSessionId)).toEqual([]);
  });

  it("a member who is not an owner holds no route to another member's agent: a stored one is not found for that agent", async () => {
    const o = await office();
    const helper = await o.spawn("Helper", "morgan");
    o.botOf(o.ids.morgan, MORGAN_BOT);
    // Written to disk as no route call would write it.
    o.botOf(o.ids.casey, CASEY_BOT, [route("d_9", CASEY_BOT, helper)]);

    expect((await post(o, helper, "d_9")).status).toBe(404);
    expect(await asksOf(o, o.casey.rawSessionId)).toEqual([]);
    expect(await asksOf(o, o.morgan.rawSessionId)).toEqual([]);
  });
});
