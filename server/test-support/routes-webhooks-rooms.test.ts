// Webhooks follow rooms, like cronjobs (task fe0c21fd). A hook belongs to its
// target's room: the target agent's room, or the target cronjob's room. Who
// sees what, on the REST reads and the WebSocket deltas:
//
//   SEE    - the hook owner, office owners, and members of the hook's live
//            room: the hook, its rules, its delivery log and the dry run.
//   MANAGE - edit, delete and the secret stay with the hook owner and office
//            owners. Room access never widens it.
//
// Seam: startTestServer(). Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, Cronjob, WebhookWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface Res {
  status: number;
  body: unknown;
  text: string;
}
interface Caller {
  rawSessionId?: string;
  bearer?: string;
}

async function api(
  srv: TestServer,
  path: string,
  caller: Caller,
  init: { method?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (caller.bearer) headers["Authorization"] = `Bearer ${caller.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: caller.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
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
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

function seedJob(srv: TestServer, username: string, roomId: string): Cronjob {
  return srv.cronjobManager.addCronjob({
    name: "Review",
    schedule: { type: "none" },
    prompt: "Review the pull request.",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
    roomId,
  });
}

const hookBody = (target: unknown) => ({
  name: "pr-review",
  scheme: "github-hmac-sha256",
  rules: [
    {
      event: "pull_request",
      match: { action: "opened" },
      args: { pr: "{{payload.pull_request.number}}" },
    },
  ],
  target,
});

// Alice owns the hooks and reaches rooms A and B. Carol reaches room A only,
// Dan room B only.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const alice = await srv.seedMember("Alice");
  const carol = await srv.seedMember("Carol");
  const dan = await srv.seedMember("Dan");
  const idOf = (name: string) => getUserByName(name)!.id;
  expect(
    updateUserById(idOf("Alice"), { allowedRooms: [roomA, roomB] }).ok,
  ).toBe(true);
  expect(updateUserById(idOf("Carol"), { allowedRooms: [roomA] }).ok).toBe(
    true,
  );
  expect(updateUserById(idOf("Dan"), { allowedRooms: [roomB] }).ok).toBe(true);
  return {
    srv,
    owner,
    asAlice: { rawSessionId: alice.rawSessionId },
    asCarol: { rawSessionId: carol.rawSessionId },
    asDan: { rawSessionId: dan.rawSessionId },
    alice,
    carol,
    dan,
    idOf,
    roomA,
    roomB,
  };
}

async function createHook(
  srv: TestServer,
  caller: Caller,
  target: unknown,
): Promise<WebhookWire> {
  const made = await api(srv, "/api/webhooks", caller, {
    method: "POST",
    body: hookBody(target),
  });
  expect(made.status).toBe(201);
  return made.body as WebhookWire;
}

const listIds = async (srv: TestServer, caller: Caller) =>
  ((await api(srv, "/api/webhooks", caller)).body as WebhookWire[]).map(
    (h) => h.id,
  );

// Every webhook route on one hook, with the status each answered.
async function statusesOn(srv: TestServer, caller: Caller, id: string) {
  const calls = [
    ["GET", `/api/webhooks/${id}`, undefined],
    ["GET", `/api/webhooks/${id}/deliveries`, undefined],
    [
      "POST",
      `/api/webhooks/${id}/dry-run`,
      { event: "pull_request", payload: { action: "opened" } },
    ],
    ["PATCH", `/api/webhooks/${id}`, { enabled: false }],
    ["GET", `/api/webhooks/${id}/secret`, undefined],
    ["POST", `/api/webhooks/${id}/secret`, undefined],
    ["DELETE", `/api/webhooks/${id}`, undefined],
  ] as const;
  const out: Record<string, number> = {};
  for (const [method, path, body] of calls) {
    const res = await api(srv, path, caller, { method, body });
    out[`${method} ${path.replace(id, ":id")}`] = res.status;
  }
  return out;
}

const READS_ONLY = {
  "GET /api/webhooks/:id": 200,
  "GET /api/webhooks/:id/deliveries": 200,
  "POST /api/webhooks/:id/dry-run": 200,
  "PATCH /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/secret": 403,
  "POST /api/webhooks/:id/secret": 403,
  "DELETE /api/webhooks/:id": 403,
};
const NOTHING = {
  "GET /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/deliveries": 403,
  "POST /api/webhooks/:id/dry-run": 403,
  "PATCH /api/webhooks/:id": 403,
  "GET /api/webhooks/:id/secret": 403,
  "POST /api/webhooks/:id/secret": 403,
  "DELETE /api/webhooks/:id": 403,
};

const framesOf = (sock: TestSocket, type: string, id: string) =>
  sock.messages.filter((m) => {
    const frame = m as {
      type?: string;
      id?: string;
      webhook?: { id?: string };
    };
    return frame.type === type && (frame.id ?? frame.webhook?.id) === id;
  });

describe("webhook rooms: REST", () => {
  it("a member of the hook's room reads it but not the secret; a member without the room gets nothing", async () => {
    const { srv, asAlice, asCarol, asDan, roomA } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const secret = (
      (await api(srv, `/api/webhooks/${hook.id}/secret`, asAlice)).body as {
        secret: string;
      }
    ).secret;
    expect(secret.length).toBeGreaterThan(20);

    // Carol, in room A: the hook, its rules and its delivery log.
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    const carolGet = await api(srv, `/api/webhooks/${hook.id}`, asCarol);
    expect(carolGet.body).toEqual(
      (await api(srv, `/api/webhooks/${hook.id}`, asAlice)).body,
    );
    expect((carolGet.body as WebhookWire).rules).toEqual(hook.rules);
    const dry = await api(srv, `/api/webhooks/${hook.id}/dry-run`, asCarol, {
      method: "POST",
      body: {
        event: "pull_request",
        payload: { action: "opened", pull_request: { number: 7 } },
      },
    });
    expect(dry.body).toMatchObject({ outcome: "match", args: { pr: "7" } });
    for (const text of [
      (await api(srv, "/api/webhooks", asCarol)).text,
      carolGet.text,
      (await api(srv, `/api/webhooks/${hook.id}/deliveries`, asCarol)).text,
      dry.text,
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
    // Not the secret, and no edit, rotate or delete.
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(READS_ONLY);

    // Dan, in room B only: an empty list and 403 on every route.
    expect(await listIds(srv, asDan)).toEqual([]);
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(NOTHING);

    // Their refused writes changed nothing: same secret, still enabled.
    expect(
      (
        (await api(srv, `/api/webhooks/${hook.id}/secret`, asAlice)).body as {
          secret: string;
        }
      ).secret,
    ).toBe(secret);
    expect(
      ((await api(srv, `/api/webhooks/${hook.id}`, asAlice)).body as WebhookWire)
        .enabled,
    ).toBe(true);
  });

  it("an agent reads the hooks in its manager's rooms and nothing else", async () => {
    const { srv, asAlice, idOf, roomA, roomB } = await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const carolBot = await spawnAgent(srv, "CarolBot", roomA);
    const danBot = await spawnAgent(srv, "DanBot", roomB);
    const asCarolBot = { bearer: mintAgentToken(carolBot.id, idOf("Carol")) };
    const asDanBot = { bearer: mintAgentToken(danBot.id, idOf("Dan")) };
    expect(await listIds(srv, asCarolBot)).toEqual([hook.id]);
    expect(
      (await api(srv, `/api/webhooks/${hook.id}/deliveries`, asCarolBot))
        .status,
    ).toBe(200);
    expect(
      (
        await api(srv, `/api/webhooks/${hook.id}`, asCarolBot, {
          method: "PATCH",
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    expect(await listIds(srv, asDanBot)).toEqual([]);
    expect((await api(srv, `/api/webhooks/${hook.id}`, asDanBot)).status).toBe(
      403,
    );
  });
});

describe("webhook rooms: the audience moves with the target", () => {
  it("an agent target: a move, a kill and a revive move the hook between rooms, on REST and live", async () => {
    const { srv, owner, asAlice, asCarol, asDan, carol, dan, roomA, roomB } =
      await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const danWs = await srv.connectWs(dan.rawSessionId);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    // The create reaches the room member and not the outsider.
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 1,
      "carol hears the create",
    );
    expect(framesOf(danWs, "webhook_upserted", hook.id)).toEqual([]);

    // The agent moves to room B: Carol loses the hook, Dan gains it.
    const moved = await api(srv, `/api/agents/${bot.id}/move`, asAlice, {
      method: "POST",
      body: { targetRoomId: roomB },
    });
    expect(moved.status).toBe(200);
    await waitUntil(
      () =>
        framesOf(carolWs, "webhook_deleted", hook.id).length === 1 &&
        framesOf(danWs, "webhook_upserted", hook.id).length === 1,
      "the move re-projects both sockets",
    );
    expect(await listIds(srv, asCarol)).toEqual([]);
    expect((await api(srv, `/api/webhooks/${hook.id}`, asCarol)).status).toBe(
      403,
    );
    expect(await listIds(srv, asDan)).toEqual([hook.id]);

    // The agent is killed: the hook has no room, so it is the owner's and
    // office owners' only.
    const killed = await api(srv, `/api/agents/${bot.id}`, asAlice, {
      method: "DELETE",
    });
    expect(killed.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(danWs, "webhook_deleted", hook.id).length === 1,
      "dan hears the hook leave",
    );
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(NOTHING);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    expect(
      await listIds(srv, { rawSessionId: owner.rawSessionId }),
    ).toEqual([hook.id]);

    // Revived into room A: Carol gets it back.
    const revived = await api(srv, `/api/agents/${bot.id}/revive`, asAlice, {
      method: "POST",
      body: { roomId: roomA, desk: 0 },
    });
    expect(revived.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 2,
      "carol hears the hook come back",
    );
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    carolWs.close();
    danWs.close();
  });

  it("a cronjob target: the hook follows the job's room, and leaves with the job", async () => {
    const { srv, asAlice, asCarol, asDan, carol, dan, roomA, roomB } =
      await office();
    const job = seedJob(srv, "Alice", roomA);
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const danWs = await srv.connectWs(dan.rawSessionId);
    const hook = await createHook(srv, asAlice, {
      kind: "cronjob",
      cronjobId: job.id,
    });
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(READS_ONLY);
    expect(await listIds(srv, asDan)).toEqual([]);

    srv.cronjobManager.updateCronjob(job.id, { roomId: roomB });
    await waitUntil(
      () =>
        framesOf(carolWs, "webhook_deleted", hook.id).length === 1 &&
        framesOf(danWs, "webhook_upserted", hook.id).length === 1,
      "the job's move re-projects both sockets",
    );
    expect(await listIds(srv, asCarol)).toEqual([]);
    expect(await statusesOn(srv, asDan, hook.id)).toEqual(READS_ONLY);

    expect(srv.cronjobManager.deleteCronjob(job.id)).toBe(true);
    await waitUntil(
      () => framesOf(danWs, "webhook_deleted", hook.id).length === 1,
      "dan hears the hook leave with the job",
    );
    expect(await listIds(srv, asDan)).toEqual([]);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    carolWs.close();
    danWs.close();
  });

  it("losing and regaining room access withdraws and returns the hook live", async () => {
    const { srv, owner, asAlice, asCarol, carol, roomA, roomB } =
      await office();
    const bot = await spawnAgent(srv, "HookBot", roomA);
    const hook = await createHook(srv, asAlice, {
      kind: "agent",
      agentId: bot.id,
    });
    const carolWs = await srv.connectWs(carol.rawSessionId);
    const setCarolRooms = async (allowedRooms: string[]) => {
      const res = await api(
        srv,
        "/api/users/Carol/access",
        { rawSessionId: owner.rawSessionId },
        { method: "PUT", body: { allowedRooms } },
      );
      expect(res.status).toBeLessThan(300);
    };
    await setCarolRooms([roomB]);
    await waitUntil(
      () => framesOf(carolWs, "webhook_deleted", hook.id).length === 1,
      "carol hears the hook leave",
    );
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(NOTHING);
    await setCarolRooms([roomA]);
    await waitUntil(
      () => framesOf(carolWs, "webhook_upserted", hook.id).length === 1,
      "carol hears the hook come back",
    );
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);
    carolWs.close();
  });

  it("closing the hook's room leaves it to the owner and office owners", async () => {
    const { srv, owner, asAlice, asCarol, carol, idOf } = await office();
    const roomC = srv.agentManager.createRoom("Gamma");
    expect(updateUserById(idOf("Carol"), { allowedRooms: [roomC] }).ok).toBe(
      true,
    );
    expect(
      updateUserById(idOf("Alice"), { allowedRooms: [roomC] }).ok,
    ).toBe(true);
    const job = seedJob(srv, "Alice", roomC);
    const hook = await createHook(srv, asAlice, {
      kind: "cronjob",
      cronjobId: job.id,
    });
    const carolWs = await srv.connectWs(carol.rawSessionId);
    expect(await listIds(srv, asCarol)).toEqual([hook.id]);

    const closed = await api(
      srv,
      `/api/rooms/${roomC}`,
      { rawSessionId: owner.rawSessionId },
      { method: "DELETE" },
    );
    expect(closed.status).toBeLessThan(300);
    await waitUntil(
      () => framesOf(carolWs, "webhook_deleted", hook.id).length === 1,
      "carol hears the hook leave",
    );
    expect(await statusesOn(srv, asCarol, hook.id)).toEqual(NOTHING);
    expect(await listIds(srv, asAlice)).toEqual([hook.id]);
    carolWs.close();
  });
});
