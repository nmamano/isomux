// Room limits on a personal API token (task 23339bea, slice 2). A token
// limited to some rooms reaches (its member's live room access) ∩ (its
// rooms): never the lobby, never an owner's every-room reach. Office-wide
// data stays reachable by area. The area check itself is
// routes-api-tokens-rest.test.ts and route-executor.test.ts; the parse is
// shared/api-token-limits.test.ts. All requests drive the real HTTP server.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  code?: string;
  body: unknown;
}

async function call(
  srv: TestServer,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  init: { method?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: auth.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    status: res.status,
    code: (body as { error?: { code?: string } } | null)?.error?.code,
    body,
  };
}

async function spawn(
  srv: TestServer,
  name: string,
  roomId: string,
  userId?: string,
) {
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
    undefined,
    "claude",
    undefined,
    userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function mint(
  srv: TestServer,
  session: string,
  limits?: unknown,
): Promise<Res & { token: string; tokenId: string }> {
  const res = await call(
    srv,
    "/api/me/api-tokens",
    { rawSessionId: session },
    {
      method: "POST",
      body: {
        name: "Script",
        expiresInDays: 30,
        ...(limits === undefined ? {} : { limits }),
      },
    },
  );
  const created = res.body as ApiTokenCreateRes;
  return {
    ...res,
    token: created?.token,
    tokenId: created?.apiToken?.id,
  };
}

const ids = (r: Res): string[] =>
  (r.body as { id: string }[]).map((entry) => entry.id).sort();

// Mia is a member who reaches rooms A and B; her agents sit in A, B and the
// lobby. Morgan owns the office.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const ownerId = getUserByName("Morgan")!.id;
  const mia = await srv.seedMember("Mia");
  const miaId = getUserByName("Mia")!.id;
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const roomC = srv.agentManager.createRoom("Gamma");
  srv.agentManager.ensureLobby();
  expect(updateUserById(miaId, { allowedRooms: [roomA, roomB] }).ok).toBe(true);
  return { srv, owner, ownerId, mia, miaId, roomA, roomB, roomC };
}

describe("API token room limits: mint", () => {
  it("takes rooms the member reaches, and refuses another room, the lobby, an unknown id and an empty limits value", async () => {
    const { srv, owner, mia, roomA, roomC } = await office();
    for (const limits of [
      { rooms: [roomC] },
      { rooms: [LOBBY_ROOM_ID] },
      { rooms: ["no-such-room"] },
      { rooms: [roomA, roomA] },
      { rooms: null },
      {},
    ]) {
      const refused = await mint(srv, mia.rawSessionId, limits);
      expect({ limits, status: refused.status, code: refused.code }).toEqual({
        limits,
        status: 422,
        code: "invalid_limits",
      });
    }
    expect(
      (
        (
          await call(srv, "/api/me/api-tokens", {
            rawSessionId: mia.rawSessionId,
          })
        ).body as { apiTokens: unknown[] }
      ).apiTokens,
    ).toEqual([]);

    // No areas: every area, limited to the rooms.
    const minted = await mint(srv, mia.rawSessionId, { rooms: [roomA] });
    expect(minted.status).toBe(201);
    expect((minted.body as ApiTokenCreateRes).apiToken.limits).toEqual({
      rooms: [roomA],
    });
    const listed = await call(srv, "/api/me/api-tokens", {
      rawSessionId: mia.rawSessionId,
    });
    expect((listed.body as { apiTokens: unknown[] }).apiTokens).toEqual([
      (minted.body as ApiTokenCreateRes).apiToken,
    ]);
    // No rooms at all is a value: office-wide data only.
    expect((await mint(srv, mia.rawSessionId, { rooms: [] })).status).toBe(201);
    // An owner reaches every ordinary room, so Gamma is fine for Morgan.
    expect(
      (await mint(srv, owner.rawSessionId, { rooms: [roomC] })).status,
    ).toBe(201);
  });
});

describe("API token room limits: a member's token", () => {
  it("reaches agents, logs, tasks, asks, memory and its inbox only in its rooms, and loses a room its member loses", async () => {
    const { srv, mia, miaId, roomA, roomB } = await office();
    const inA = await spawn(srv, "AlphaBot", roomA, miaId);
    const inB = await spawn(srv, "BetaBot", roomB, miaId);
    const inLobby = await spawn(srv, "LobbyBot", LOBBY_ROOM_ID, miaId);
    const gone = await spawn(srv, "GoneBot", roomB, miaId);
    await srv.agentManager.kill(gone.id);

    const full = await mint(srv, mia.rawSessionId);
    const limited = await mint(srv, mia.rawSessionId, { rooms: [roomA] });
    expect([full.status, limited.status]).toEqual([201, 201]);
    const asFull = { bearer: full.token };
    const asLimited = { bearer: limited.token };

    // The directory: the full token sees B and the lobby, the limited one
    // only A. Killed agents follow their last room.
    const roster = async (who: { bearer: string }, query = "") => {
      const r = await call(srv, `/agents${query}`, who);
      expect(r.status).toBe(200);
      return (r.body as { id: string }[]).map((e) => e.id);
    };
    const fullRoster = await roster(asFull);
    expect(fullRoster).toEqual(
      expect.arrayContaining([inA.id, inB.id, inLobby.id]),
    );
    const limitedRoster = await roster(asLimited);
    expect(limitedRoster).toContain(inA.id);
    expect(limitedRoster).not.toContain(inB.id);
    expect(limitedRoster).not.toContain(inLobby.id);
    expect(await roster(asFull, "?killed=1")).toContain(gone.id);
    expect(await roster(asLimited, "?killed=1")).not.toContain(gone.id);

    // Send and logs: A answers, B and the lobby are refused before any write.
    const send = (who: { bearer: string }, agentId: string) =>
      call(srv, `/api/agents/${agentId}/messages`, who, {
        method: "POST",
        body: { text: "hello" },
      });
    expect((await send(asLimited, inA.id)).status).toBe(200);
    for (const target of [inB, inLobby]) {
      const logsBefore = srv.agentManager.getAgentLogs(target.id).length;
      const refused = await send(asLimited, target.id);
      expect({ name: target.name, status: refused.status }).toEqual({
        name: target.name,
        status: 403,
      });
      expect(srv.agentManager.getAgentLogs(target.id)).toHaveLength(logsBefore);
    }
    expect((await send(asFull, inB.id)).status).toBe(200);
    expect((await call(srv, `/api/agents/${inB.id}/logs`, asFull)).status).toBe(
      200,
    );
    expect(
      (await call(srv, `/api/agents/${inB.id}/logs`, asLimited)).status,
    ).toBe(403);
    // A killed agent's log follows its last room too.
    expect(
      (await call(srv, `/api/agents/${gone.id}/logs`, asFull)).status,
    ).toBe(200);
    expect(
      (await call(srv, `/api/agents/${gone.id}/logs`, asLimited)).status,
    ).toBe(403);

    // A hook the token makes cannot point at an agent outside its rooms.
    const hookOn = (who: { bearer: string }, agentId: string) =>
      call(srv, "/api/webhooks", who, {
        method: "POST",
        body: {
          name: `hook-${agentId}`,
          scheme: "github-hmac-sha256",
          rules: [{ event: "pull_request", match: {}, args: {} }],
          target: { kind: "agent", agentId },
        },
      });
    expect((await hookOn(asFull, inB.id)).status).toBe(201);
    expect((await hookOn(asLimited, inA.id)).status).toBe(201);
    const hooksBefore = ids(await call(srv, "/api/webhooks", asFull)).length;
    expect((await hookOn(asLimited, inB.id)).status).toBe(403);
    expect(ids(await call(srv, "/api/webhooks", asFull))).toHaveLength(
      hooksBefore,
    );

    // Tasks: a task in B is not listed, and a create in B files nothing.
    const filed = async (who: { bearer: string }, roomId: string) =>
      call(srv, "/api/tasks", who, {
        method: "POST",
        body: { title: `in ${roomId}`, roomId },
      });
    const taskB = await filed(asFull, roomB);
    expect(taskB.status).toBe(201);
    const taskA = await filed(asLimited, roomA);
    expect(taskA.status).toBe(201);
    const tasksBefore = srv.agentManager.getTasks().length;
    const intoB = await filed(asLimited, roomB);
    expect([403, 404]).toContain(intoB.status);
    expect(srv.agentManager.getTasks()).toHaveLength(tasksBefore);
    const taskId = (r: Res) => (r.body as { id: string }).id;
    expect(ids(await call(srv, "/api/tasks?status=all", asFull))).toEqual(
      expect.arrayContaining([taskId(taskA), taskId(taskB)]),
    );
    const limitedTasks = ids(
      await call(srv, "/api/tasks?status=all", asLimited),
    );
    expect(limitedTasks).toContain(taskId(taskA));
    expect(limitedTasks).not.toContain(taskId(taskB));
    expect(
      (await call(srv, `/api/tasks/${taskId(taskB)}`, asLimited)).status,
    ).toBe(404);

    // Asks: Mia's asks from A and B; the limited token lists only A's.
    const ask = async (agentId: string) => {
      const r = await call(
        srv,
        `/api/agents/${agentId}/asks`,
        { bearer: mintAgentToken(agentId, miaId) },
        { method: "POST", body: { text: `question from ${agentId}` } },
      );
      expect(r.status).toBe(201);
      return (r.body as { id: string }).id;
    };
    const askA = await ask(inA.id);
    const askB = await ask(inB.id);
    expect(ids(await call(srv, "/api/asks", asFull))).toEqual(
      [askA, askB].sort(),
    );
    expect(ids(await call(srv, "/api/asks", asLimited))).toEqual([askA]);

    // Memory: room B and BetaBot's scope read as missing; A answers.
    const memory = (who: { bearer: string }, scope: string, scopeId: string) =>
      call(srv, `/api/memory?scope=${scope}&scopeId=${scopeId}`, who);
    expect((await memory(asLimited, "room", roomA)).status).toBe(200);
    expect((await memory(asLimited, "agent", inA.id)).status).toBe(200);
    expect((await memory(asFull, "room", roomB)).status).toBe(200);
    expect((await memory(asFull, "agent", inB.id)).status).toBe(200);
    const roomRefused = await memory(asLimited, "room", roomB);
    expect([roomRefused.status, roomRefused.code]).toEqual([
      404,
      "room_not_found",
    ]);
    const agentRefused = await memory(asLimited, "agent", inB.id);
    expect([agentRefused.status, agentRefused.code]).toEqual([
      404,
      "agent_not_found",
    ]);

    // Inbox: an agent outside the rooms cannot write to the token; the same
    // agent may write to the full token.
    const reply = (agentId: string, tokenId: string) =>
      call(
        srv,
        `/api/api-token-inboxes/${tokenId}/messages`,
        { bearer: mintAgentToken(agentId, miaId) },
        { method: "POST", body: { text: "result" } },
      );
    expect((await reply(inA.id, limited.tokenId)).status).toBe(200);
    expect((await reply(inB.id, full.tokenId)).status).toBe(200);
    const outside = await reply(inB.id, limited.tokenId);
    expect([outside.status, outside.code]).toEqual([
      404,
      "api_token_unavailable",
    ]);

    // Live: Mia loses room A, and the token loses it on the next call.
    expect(updateUserById(miaId, { allowedRooms: [roomB] }).ok).toBe(true);
    expect((await send(asLimited, inA.id)).status).toBe(403);
    expect(await roster(asLimited)).not.toContain(inA.id);
  });
});

describe("API token room limits: an office owner's token", () => {
  it("has no office-owner reach: no closed rooms, no other room's hooks or schedules, no owner-only surfaces", async () => {
    const { srv, owner, ownerId, mia, roomA, roomB, roomC } = await office();
    const inA = await spawn(srv, "AlphaBot", roomA, ownerId);
    const inB = await spawn(srv, "BetaBot", roomB, ownerId);
    const inLobby = await spawn(srv, "LobbyBot", LOBBY_ROOM_ID, ownerId);
    const asOwner = { rawSessionId: owner.rawSessionId };

    // A task in B, and one in Gamma, which then closes.
    const task = async (roomId: string) => {
      const r = await call(srv, "/api/tasks", asOwner, {
        method: "POST",
        body: { title: `in ${roomId}`, roomId },
      });
      expect(r.status).toBe(201);
      return (r.body as { id: string }).id;
    };
    const taskB = await task(roomB);
    const taskC = await task(roomC);
    expect(srv.agentManager.closeRoom(roomC)).toBe(true);

    // Morgan's hook on BetaBot, and Morgan's schedule in B.
    const hook = await call(srv, "/api/webhooks", asOwner, {
      method: "POST",
      body: {
        name: "pr-review",
        scheme: "github-hmac-sha256",
        rules: [{ event: "pull_request", match: {}, args: {} }],
        target: { kind: "agent", agentId: inB.id },
      },
    });
    expect(hook.status).toBe(201);
    const hookId = (hook.body as { id: string }).id;
    const job = srv.cronjobManager.addCronjob({
      name: "Beta Report",
      schedule: { type: "none" },
      prompt: "Report.",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Morgan",
      userId: ownerId,
      roomId: roomB,
    });

    const full = await mint(srv, owner.rawSessionId);
    const limited = await mint(srv, owner.rawSessionId, { rooms: [roomA] });
    expect([full.status, limited.status]).toEqual([201, 201]);
    const asFull = { bearer: full.token };
    const asLimited = { bearer: limited.token };

    // Each read: the full token gets it, the limited one does not.
    const allTasks = (who: { bearer: string }) =>
      call(srv, "/api/tasks?status=all", who);
    expect(ids(await allTasks(asFull))).toEqual(
      expect.arrayContaining([taskB, taskC]),
    );
    const limitedTasks = ids(await allTasks(asLimited));
    expect(limitedTasks).not.toContain(taskB);
    expect(limitedTasks).not.toContain(taskC);

    expect(ids(await call(srv, "/api/webhooks", asFull))).toEqual([hookId]);
    expect(ids(await call(srv, "/api/webhooks", asLimited))).toEqual([]);
    expect((await call(srv, `/api/webhooks/${hookId}`, asFull)).status).toBe(
      200,
    );
    expect((await call(srv, `/api/webhooks/${hookId}`, asLimited)).status).toBe(
      403,
    );

    // An edit or delete of the hook: refused to the limited token.
    const disable = (who: { bearer: string }) =>
      call(srv, `/api/webhooks/${hookId}`, who, {
        method: "PATCH",
        body: { enabled: false },
      });
    expect((await disable(asLimited)).status).toBe(403);
    expect(
      (
        await call(srv, `/api/webhooks/${hookId}`, asLimited, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        (await call(srv, `/api/webhooks/${hookId}`, asFull)).body as {
          enabled: boolean;
        }
      ).enabled,
    ).toBe(true);
    expect((await disable(asFull)).status).toBe(200);

    // Usage: the limited token gets a member's view of room A.
    const usage = async (who: { bearer: string }) => {
      const r = await call(srv, "/api/usage", who);
      expect(r.status).toBe(200);
      return r.body as { agents: { id: string }[]; cronjobs?: unknown };
    };
    const fullUsage = await usage(asFull);
    expect(fullUsage.agents.map((a) => a.id)).toEqual(
      expect.arrayContaining([inA.id, inB.id, inLobby.id]),
    );
    expect(fullUsage.cronjobs).toBeDefined();
    const limitedUsage = await usage(asLimited);
    expect(limitedUsage.agents.map((a) => a.id)).toEqual([inA.id]);
    expect(limitedUsage.cronjobs).toBeUndefined();

    expect(ids(await call(srv, "/api/cronjobs", asFull))).toContain(job.id);
    expect(ids(await call(srv, "/api/cronjobs", asLimited))).not.toContain(
      job.id,
    );

    // Owner-only surfaces: the full token passes each guard, the limited one
    // is refused by it.
    for (const path of [
      "/api/audit-log",
      "/api/terminal-recordings",
      "/api/office/env",
    ]) {
      const fullRes = await call(srv, path, asFull);
      const limitedRes = await call(srv, path, asLimited);
      expect({
        path,
        full: fullRes.status,
        limited: limitedRes.status,
      }).toEqual({ path, full: 200, limited: 403 });
    }
    // Members chat moderation is an owner power too: a member's message stays.
    const posted = await call(
      srv,
      "/api/members-chat",
      { rawSessionId: mia.rawSessionId },
      { method: "POST", body: { text: "hello all" } },
    );
    expect(posted.status).toBe(201);
    const messageId = (posted.body as { id: string }).id;
    const removeMessage = (who: { bearer: string }) =>
      call(srv, `/api/members-chat/${messageId}`, who, { method: "DELETE" });
    expect((await removeMessage(asLimited)).status).toBe(403);
    expect((await removeMessage(asFull)).status).toBe(204);

    const reManage = (who: { bearer: string }, agentId: string) =>
      call(srv, `/api/agents/${agentId}/manager`, who, {
        method: "PUT",
        body: { userId: ownerId },
      });
    expect((await reManage(asLimited, inB.id)).status).toBe(403);
    expect((await reManage(asLimited, inA.id)).status).toBe(403);
    expect((await reManage(asFull, inB.id)).status).not.toBe(403);
  });
});
