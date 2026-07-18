// Phase 3a slice 1 — Tasks on the unified REST surface (opIds tasks.*).
//
// TDD'd against the typed route table: the NEW /api/tasks* endpoints are
// identity-required (cookie or agent bearer), attribution is token-derived
// ([behavior-change] createdBy/username NOT from body), DELETE is unified, and a
// mutation fans out the `all`-audience `tasks` event through the emit() helper
// (double-signal). The LEGACY /tasks* surface (frozen in routes-tasks.test.ts)
// must stay byte-identical, including its loopback trust and DELETE-405 wall.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, TaskItem } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "cond",
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
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

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
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

// --- /api auth posture (the bypass guard, Reviewer1 #1) ---------------------
describe("routes/tasks REST: /api identity required (no loopback bypass)", () => {
  it("loopback no-cookie GET/POST /api/tasks -> 401 while legacy /tasks still passes", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");

    const getApi = await api(srv, "/api/tasks");
    expect(getApi.status).toBe(401);
    // The rejection rides the NEW /api envelope {error:{code,message}}, not the
    // legacy auth-middleware shape — every migrated /api route inherits this.
    expect((getApi.body as { error?: { code?: string } }).error?.code).toBe(
      "unauthenticated",
    );
    const postApi = await api(srv, "/api/tasks", {
      method: "POST",
      body: { title: "x" },
    });
    expect(postApi.status).toBe(401);
    expect((postApi.body as { error?: { code?: string } }).error?.code).toBe(
      "unauthenticated",
    );

    // Legacy loopback-trusted surface is untouched: no cookie, still 200.
    const legacy = await api(srv, "/tasks");
    expect(legacy.status).toBe(200);
  });
});

// --- CRUD + attribution via cookie (USER) -----------------------------------
describe("routes/tasks REST: cookie (user) CRUD + attribution", () => {
  it("GET /api/tasks with an owner cookie lists (200)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/tasks", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it("POST /api/tasks derives createdBy+username from the TOKEN, ignoring body (behavior-change)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      // Spoof attempt: createdBy/username in the body MUST be ignored.
      body: { title: "Ship 3a", createdBy: "EVIL", username: "EVIL" },
    });
    expect(r.status).toBe(201);
    const t = r.body as TaskItem;
    expect(t.title).toBe("Ship 3a");
    expect(t.createdBy).toBe("Boss");
    expect(t.username).toBe("Boss");
    expect(t.status).toBe("open");
  });

  it("PATCH/claim/done update the task; DELETE -> 204; unknown id -> 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const created = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { title: "T" },
      })
    ).body as TaskItem;

    const patched = await api(srv, `/api/tasks/${created.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { priority: "P1", description: "d" },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as TaskItem).priority).toBe("P1");

    const claimed = await api(srv, `/api/tasks/${created.id}/claim`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { assignee: "Isomuxer1" },
    });
    expect((claimed.body as TaskItem).status).toBe("in_progress");
    expect((claimed.body as TaskItem).assignee).toBe("Isomuxer1");

    const done = await api(srv, `/api/tasks/${created.id}/done`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {},
    });
    expect((done.body as TaskItem).status).toBe("done");

    const del = await api(srv, `/api/tasks/${created.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(del.status).toBe(204);
    expect(srv.agentManager.getTasks().some((t) => t.id === created.id)).toBe(
      false,
    );

    const missing = await api(srv, `/api/tasks/nope`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { title: "x" },
    });
    expect(missing.status).toBe(404);
  });

  it("legacy HTTP DELETE /tasks/:id stays a 405 wall (unchanged)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r = await api(srv, "/tasks/whatever", { method: "DELETE" });
    expect(r.status).toBe(405);
  });
});

// --- Agent bearer auth + agent-name attribution -----------------------------
describe("routes/tasks REST: agent bearer", () => {
  it("an agent token authenticates and createdBy is the AGENT name, username the owner", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "TaskBot");
    // Mint a token bound to the agent, attributed to the owner user.
    const token = mintAgentToken(bot.id, ownerId);

    const list = await api(srv, "/api/tasks", { bearer: token });
    expect(list.status).toBe(200);

    const r = await api(srv, "/api/tasks", {
      method: "POST",
      bearer: token,
      body: { title: "from the bot" },
    });
    expect(r.status).toBe(201);
    const t = r.body as TaskItem;
    expect(t.createdBy).toBe("TaskBot");
    expect(t.username).toBe("Boss");
  });
});

// --- Idempotency + double-signal --------------------------------------------
describe("routes/tasks REST: idempotency + WS double-signal", () => {
  it("a repeated POST with the same Idempotency-Key creates one task", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const before = srv.agentManager.getTasks().length;
    const headers = { "Idempotency-Key": "create-1" };
    const a = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers,
      body: { title: "once" },
    });
    const b = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers,
      body: { title: "once" },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as TaskItem).id).toBe((b.body as TaskItem).id);
    expect(srv.agentManager.getTasks().length).toBe(before + 1);
  });

  it("a REST create fans out the `tasks` event to a connected socket (emit() path)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);

    const created = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { title: "broadcast me" },
      })
    ).body as TaskItem;

    await waitUntil(
      () =>
        sock.messages.some(
          (m) =>
            (m as { type?: string }).type === "tasks" &&
            ((m as { tasks?: TaskItem[] }).tasks ?? []).some(
              (t) => t.id === created.id,
            ),
        ),
      2000,
      "tasks event carrying the new task",
    );
  });
});

// --- Room scoping: visibility ∪ globals, create-stamping, no-oracle ----------
describe("routes/tasks REST: room scoping", () => {
  // Shorthand: POST a task as an owner cookie, optionally into a room. Omitting
  // roomId exercises the scope default; roomId:"" is an explicit global.
  function postTask(
    srv: TestServer,
    rawSessionId: string,
    title: string,
    roomId?: string,
  ) {
    const body: Record<string, unknown> = { title };
    if (roomId !== undefined) body.roomId = roomId;
    return api(srv, "/api/tasks", { method: "POST", rawSessionId, body });
  }
  const idsOf = (r: Res) => new Set((r.body as TaskItem[]).map((t) => t.id));

  it("owner sees every room + globals; a member sees only granted rooms + globals", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    // Grant Mia roomB ONLY (not roomA).
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });

    const inA = (await postTask(srv, owner.rawSessionId, "in A", roomA))
      .body as TaskItem;
    const inB = (await postTask(srv, owner.rawSessionId, "in B", roomB))
      .body as TaskItem;
    const glob = (await postTask(srv, owner.rawSessionId, "global", ""))
      .body as TaskItem;
    expect(inA.roomId).toBe(roomA);
    expect(inB.roomId).toBe(roomB);
    expect(glob.roomId).toBeUndefined(); // explicit "" normalizes to global

    // Owner: sees all three.
    const ownerIds = idsOf(
      await api(srv, "/api/tasks", { rawSessionId: owner.rawSessionId }),
    );
    expect(ownerIds.has(inA.id)).toBe(true);
    expect(ownerIds.has(inB.id)).toBe(true);
    expect(ownerIds.has(glob.id)).toBe(true);

    // Member: roomB + global, NOT roomA.
    const miaIds = idsOf(
      await api(srv, "/api/tasks", { rawSessionId: member.rawSessionId }),
    );
    expect(miaIds.has(inB.id)).toBe(true);
    expect(miaIds.has(glob.id)).toBe(true);
    expect(miaIds.has(inA.id)).toBe(false);

    // No oracle: GET + every mutation on the invisible roomA task is a 404, and
    // the task is untouched.
    for (const [method, path, body] of [
      ["GET", `/api/tasks/${inA.id}`, undefined],
      ["PATCH", `/api/tasks/${inA.id}`, { status: "done" }],
      ["POST", `/api/tasks/${inA.id}/claim`, { assignee: "Mia" }],
      ["POST", `/api/tasks/${inA.id}/done`, {}],
      ["DELETE", `/api/tasks/${inA.id}`, undefined],
    ] as const) {
      const r = await api(srv, path, {
        method,
        rawSessionId: member.rawSessionId,
        body,
      });
      expect(r.status).toBe(404);
    }
    expect(
      srv.agentManager.getTasks().find((t) => t.id === inA.id)?.status,
    ).toBe("open");
  });

  it("create into an inaccessible OR unknown room is a uniform 404 (no room oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id; // Mia has no grant

    const forbidden = await postTask(srv, member.rawSessionId, "x", roomA);
    expect(forbidden.status).toBe(404);
    const unknown = await postTask(srv, member.rawSessionId, "x", "deadbeef");
    expect(unknown.status).toBe(404);
    // A non-string roomId is a shape 400, distinct from the room-access 404.
    const badShape = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { title: "x", roomId: 7 },
    });
    expect(badShape.status).toBe(400);
    // Explicit global + no-room both succeed as global for a user caller.
    const glob = await postTask(srv, member.rawSessionId, "g", "");
    expect(glob.status).toBe(201);
    expect((glob.body as TaskItem).roomId).toBeUndefined();
    const noRoom = await postTask(srv, member.rawSessionId, "n");
    expect((noRoom.body as TaskItem).roomId).toBeUndefined();
  });

  it("an agent create defaults to the agent's OWN room; roomId:'' makes it global", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const roomA = srv.agentManager.getRooms()[0].id;
    const bot = await spawnAgent(srv, "RoomBot"); // spawns into roomA
    const token = mintAgentToken(bot.id, ownerId);

    const mine = (
      await api(srv, "/api/tasks", {
        method: "POST",
        bearer: token,
        body: { title: "mine" },
      })
    ).body as TaskItem;
    expect(mine.roomId).toBe(roomA); // stamped with the agent's room

    const glob = (
      await api(srv, "/api/tasks", {
        method: "POST",
        bearer: token,
        body: { title: "shared", roomId: "" },
      })
    ).body as TaskItem;
    expect(glob.roomId).toBeUndefined();
  });

  it("legacy loopback /tasks is GLOBALS-ONLY: hides room tasks and refuses to mutate them", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomB = srv.agentManager.createRoom("Room B");
    const inB = (await postTask(srv, owner.rawSessionId, "in B", roomB))
      .body as TaskItem;
    const glob = (await postTask(srv, owner.rawSessionId, "glob", ""))
      .body as TaskItem;

    // GET list (loopback, no cookie): only the global task.
    const legacyIds = idsOf(await api(srv, "/tasks"));
    expect(legacyIds.has(glob.id)).toBe(true);
    expect(legacyIds.has(inB.id)).toBe(false);
    // GET + every mutation on the room task is a 404 through the legacy surface.
    expect((await api(srv, `/tasks/${inB.id}`)).status).toBe(404);
    expect(
      (
        await api(srv, `/tasks/${inB.id}`, {
          method: "PATCH",
          body: { status: "done" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(srv, `/tasks/${inB.id}/claim`, {
          method: "POST",
          body: { assignee: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(srv, `/tasks/${inB.id}/done`, { method: "POST", body: {} }))
        .status,
    ).toBe(404);
    expect(
      srv.agentManager.getTasks().find((t) => t.id === inB.id)?.status,
    ).toBe("open");
    // Legacy create files GLOBAL even if the body names a room.
    const legacyCreate = (
      await api(srv, "/tasks", {
        method: "POST",
        body: { title: "leg", createdBy: "c", roomId: roomB },
      })
    ).body as TaskItem;
    expect(legacyCreate.roomId).toBeUndefined();
  });

  it("a mutation fans out per-recipient: a member socket never receives a room task it can't see", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomB = srv.agentManager.createRoom("Room B"); // Mia has no grant
    const ownerSock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const memberSock: TestSocket = await srv.connectWs(member.rawSessionId);

    const inB = (await postTask(srv, owner.rawSessionId, "in B", roomB))
      .body as TaskItem;

    const carries = (s: TestSocket) =>
      s.messages.some(
        (m) =>
          (m as { type?: string }).type === "tasks" &&
          ((m as { tasks?: TaskItem[] }).tasks ?? []).some(
            (t) => t.id === inB.id,
          ),
      );
    // Owner's projection carries the room task.
    await waitUntil(() => carries(ownerSock), 2000, "owner sees room task");
    // Member got a `tasks` push, but NONE of them carry the room-B task.
    await waitUntil(
      () =>
        memberSock.messages.some(
          (m) => (m as { type?: string }).type === "tasks",
        ),
      2000,
      "member got a tasks push",
    );
    expect(carries(memberSock)).toBe(false);
  });

  it("granting a member room access (setAccess) live-re-projects their board", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomB = srv.agentManager.createRoom("Room B"); // Mia has no grant yet
    const inB = (await postTask(srv, owner.rawSessionId, "in B", roomB))
      .body as TaskItem;

    const sock: TestSocket = await srv.connectWs(member.rawSessionId);
    const carriesInB = () =>
      sock.messages.some(
        (m) =>
          (m as { type?: string }).type === "tasks" &&
          ((m as { tasks?: TaskItem[] }).tasks ?? []).some(
            (t) => t.id === inB.id,
          ),
      );
    // Connect hydration arrives and does NOT include the room-B task.
    await waitUntil(
      () =>
        sock.messages.some((m) => (m as { type?: string }).type === "tasks"),
      2000,
      "member connect tasks",
    );
    expect(carriesInB()).toBe(false);

    // Owner grants Mia access to roomB → her board must re-project live (this is
    // what pushTasksForUserId at the setAccess site guarantees).
    const grant = await api(srv, `/api/users/${member.username}/access`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { allowedRooms: [roomB] },
    });
    expect(grant.status).toBe(200);
    await waitUntil(carriesInB, 2000, "board re-projected after grant");
  });
});
