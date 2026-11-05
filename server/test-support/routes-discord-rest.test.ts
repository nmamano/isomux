// Discord routes (opIds discord.* and discordRoutes.*, task 7fd44c30) through
// the real route table and server: a member's own empty lists, a connect
// refused on its body before any call to Discord, and a route or bot that is
// not the member's. Who may call them is pinned in routes-table.test.ts; the
// rules in server/discord/routes.test.ts and supervisor.test.ts.
//
// Seam: startTestServer(). No bot is stored at boot, so no child starts and
// nothing reaches Discord.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import type { DiscordRoute } from "../../shared/discord.ts";
import { mintApiToken } from "../api-tokens.ts";
import { readDiscordRoutes, writeDiscordRoutes } from "../discord/store.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function api(
  srv: TestServer,
  path: string,
  rawSessionId: string | null,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    ...(rawSessionId ? { rawSessionId } : {}),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("discord routes", () => {
  it("a member's bots and routes start empty; a connect with no token is refused before any call; another bot or route is not found", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    for (const path of ["/api/discord", "/api/discord/routes"])
      expect(await api(srv, path, mia.rawSessionId)).toEqual({
        status: 200,
        body: [],
      });

    for (const body of [{}, { token: "" }, { token: 5 }])
      expect({
        body,
        status: (
          await api(srv, "/api/discord/bots", mia.rawSessionId, {
            method: "POST",
            body,
          })
        ).status,
      }).toEqual({ body, status: 400 });
    expect(existsSync(join(srv.stateRoot, "discord"))).toBe(false);

    const bot = "1100000000000000001";
    expect(
      (await api(srv, `/api/discord/bots/${bot}/guilds`, mia.rawSessionId))
        .status,
    ).toBe(404);
    expect(
      (
        await api(srv, `/api/discord/bots/${bot}`, mia.rawSessionId, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    const created = await api(srv, "/api/discord/routes", mia.rawSessionId, {
      method: "POST",
      body: {
        botId: bot,
        guildId: "1200000000000000001",
        scope: "channel",
        targetId: "1300000000000000002",
        name: "general",
        agentId: "agent-x",
      },
    });
    expect([400, 404]).toContain(created.status);
    for (const method of ["PATCH", "DELETE"])
      expect({
        method,
        status: (
          await api(srv, "/api/discord/routes/r-none", mia.rawSessionId, {
            method,
            ...(method === "PATCH" ? { body: { name: "x" } } : {}),
          })
        ).status,
      }).toEqual({ method, status: 404 });
    expect(
      (await api(srv, "/api/discord/routes", mia.rawSessionId)).body,
    ).toEqual([]);
  });
});

// Who may call them (task c92d60f4): the member by cookie, or the member's
// PRIVILEGED agent acting for them, on the member's own bots and routes. A
// standard agent and an API token get 403; an office owner's agent does not
// reach another member's. Only the member connects a bot with a raw token:
// an agent connects one through a discord-bot value request.
describe("discord routes: the member's privileged agent", () => {
  const BOT = "1100000000000000001";
  const route = (id: string, agentId: string): DiscordRoute => ({
    id,
    botId: BOT,
    guildId: "1200000000000000001",
    scope: "channel",
    targetId: "1300000000000000001",
    name: "general",
    agentId,
    trigger: "all",
    replyMode: "ask",
    createdAt: 1,
  });

  async function office() {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const ned = await srv.seedMember("Ned");
    const roomId = srv.agentManager.getRooms()[0].id;
    const ids = {
      morgan: getUserByName(morgan.username)!.id,
      mia: getUserByName(mia.username)!.id,
      ned: getUserByName(ned.username)!.id,
    };
    const spawn = async (name: string, username: string, userId: string) => {
      const agent = await srv.agentManager.spawn(
        name,
        srv.stateRoot,
        "default",
        undefined,
        undefined,
        roomId,
        undefined,
        undefined,
        undefined,
        username,
        "claude",
        undefined,
        userId,
      );
      if (!agent) throw new Error("spawn returned null");
      return agent;
    };
    const helper = await spawn("Helper", mia.username, ids.mia);
    const plain = await spawn("Plain", mia.username, ids.mia);
    const nedBot = await spawn("NedBot", ned.username, ids.ned);
    // One route each, written as the routes write them: no bot is connected
    // in a test office, so no route can be added through the API.
    writeDiscordRoutes(srv.stateRoot, ids.mia, [route("r-mia", helper.id)]);
    writeDiscordRoutes(srv.stateRoot, ids.ned, [route("r-ned", nedBot.id)]);
    return {
      srv,
      morgan,
      mia,
      ids,
      helper,
      plain,
      nedBot,
      miaAgent: mintAgentToken(helper.id, ids.mia, true),
      miaStandard: mintAgentToken(plain.id, ids.mia, false),
      ownerAgent: mintAgentToken("morgan-privileged", ids.morgan, true),
      miaApi: (
        await mintApiToken({
          userId: ids.mia,
          name: "Mia API",
          expiresInDays: null,
        })
      ).token,
    };
  }
  type Office = Awaited<ReturnType<typeof office>>;

  // Every Discord route, with a body that passes the guard and is refused
  // (or answered) by the handler without a call to Discord.
  const CALLS = [
    ["GET", "/api/discord", undefined],
    ["POST", "/api/discord/bots", {}],
    ["DELETE", `/api/discord/bots/${BOT}`, undefined],
    ["GET", `/api/discord/bots/${BOT}/guilds`, undefined],
    ["GET", "/api/discord/routes", undefined],
    ["POST", "/api/discord/routes", { name: "x" }],
    ["PATCH", "/api/discord/routes/r-mia", { name: "renamed" }],
    ["DELETE", "/api/discord/routes/r-none", undefined],
  ] as const;
  const statuses = async (o: Office, bearer: string) =>
    Promise.all(
      CALLS.map(async ([method, path, body]) => [
        method,
        path,
        (
          await api(o.srv, path, null, {
            method,
            bearer,
            ...(body !== undefined ? { body } : {}),
          })
        ).status,
      ]),
    );
  const routesOf = (o: Office, userId: string) =>
    readDiscordRoutes(o.srv.stateRoot, userId).map((r) => [
      r.id,
      r.name,
      r.agentId,
    ]);

  it("lists, changes and removes its manager's routes and sees their bots; a connect with a token stays the member's", async () => {
    const o = await office();
    const as = (path: string, init: { method?: string; body?: unknown } = {}) =>
      api(o.srv, path, null, { ...init, bearer: o.miaAgent });

    expect(await as("/api/discord")).toEqual({ status: 200, body: [] });
    const listed = await as("/api/discord/routes");
    expect(listed.status).toBe(200);
    expect(
      (listed.body as DiscordRoute[]).map((r) => [r.id, r.agentId, r.dead]),
    ).toEqual([["r-mia", o.helper.id, undefined]]);
    // No bot of Mia's: the handler's answer, not the guard's.
    expect((await as(`/api/discord/bots/${BOT}/guilds`)).status).toBe(404);
    expect(
      (await as(`/api/discord/bots/${BOT}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (
        await as("/api/discord/routes", {
          method: "POST",
          body: { ...route("r-new", o.plain.id), name: "second" },
        })
      ).status,
    ).toBe(400);

    const renamed = await as("/api/discord/routes/r-mia", {
      method: "PATCH",
      body: { name: "renamed", agentId: o.plain.id },
    });
    expect(renamed.status).toBe(200);
    expect(routesOf(o, o.ids.mia)).toEqual([["r-mia", "renamed", o.plain.id]]);
    // An agent its manager does not manage is refused, as for the member.
    expect(
      (
        await as("/api/discord/routes/r-mia", {
          method: "PATCH",
          body: { agentId: o.nedBot.id },
        })
      ).status,
    ).toBe(400);
    expect(routesOf(o, o.ids.mia)).toEqual([["r-mia", "renamed", o.plain.id]]);

    // Ned's route is not Mia's: not found, and untouched.
    for (const method of ["PATCH", "DELETE"])
      expect({
        method,
        status: (
          await as("/api/discord/routes/r-ned", {
            method,
            ...(method === "PATCH" ? { body: { name: "taken" } } : {}),
          })
        ).status,
      }).toEqual({ method, status: 404 });
    expect(routesOf(o, o.ids.ned)).toEqual([["r-ned", "general", o.nedBot.id]]);

    expect(
      (await as("/api/discord/routes/r-mia", { method: "DELETE" })).status,
    ).toBe(204);
    expect(routesOf(o, o.ids.mia)).toEqual([]);

    // The raw-token connect: refused by the guard, before the body check.
    expect(
      (await as("/api/discord/bots", { method: "POST", body: {} })).status,
    ).toBe(403);
    expect(
      (
        await api(o.srv, "/api/discord/bots", o.mia.rawSessionId, {
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(400);
  });

  it("a standard agent and an API token get 403 on every Discord route, and change nothing", async () => {
    const o = await office();
    for (const bearer of [o.miaStandard, o.miaApi])
      expect(await statuses(o, bearer)).toEqual(
        CALLS.map(([method, path]) => [method, path, 403]),
      );
    expect(routesOf(o, o.ids.mia)).toEqual([["r-mia", "general", o.helper.id]]);
  });

  it("an office owner's privileged agent sees its owner's routes only, and does not reach a member's", async () => {
    const o = await office();
    const as = (path: string, init: { method?: string; body?: unknown } = {}) =>
      api(o.srv, path, null, { ...init, bearer: o.ownerAgent });
    expect(await as("/api/discord/routes")).toEqual({ status: 200, body: [] });
    for (const method of ["PATCH", "DELETE"])
      expect({
        method,
        status: (
          await as("/api/discord/routes/r-mia", {
            method,
            ...(method === "PATCH" ? { body: { name: "taken" } } : {}),
          })
        ).status,
      }).toEqual({ method, status: 404 });
    expect(routesOf(o, o.ids.mia)).toEqual([["r-mia", "general", o.helper.id]]);
  });

  it("a privileged agent opens a discord-bot request for its manager; a standard agent is refused before the member sees a form", async () => {
    const o = await office();
    // Mia sees the agents' room, so the ask reaches her list.
    expect(
      (
        await api(o.srv, "/api/users/Mia/access", o.morgan.rawSessionId, {
          method: "PUT",
          body: { allowedRooms: [o.helper.roomId] },
        })
      ).status,
    ).toBe(200);
    const open = (agentId: string, bearer: string) =>
      api(o.srv, `/api/agents/${agentId}/secret-requests`, null, {
        method: "POST",
        bearer,
        body: { kind: "discord-bot", reason: "To answer on Discord." },
      });
    const refused = await open(o.plain.id, o.miaStandard);
    expect([
      refused.status,
      (refused.body as { error?: { code?: string } }).error?.code,
    ]).toEqual([403, "forbidden"]);
    const made = await open(o.helper.id, o.miaAgent);
    expect(made.status).toBeLessThan(300);
    expect(typeof (made.body as { requestId?: unknown }).requestId).toBe(
      "string",
    );
    const asks = await api(o.srv, "/api/asks", o.mia.rawSessionId);
    expect(JSON.stringify(asks.body)).toContain('"kind":"discord-bot"');
    expect(JSON.stringify(asks.body)).not.toContain(o.plain.id);
  });
});
