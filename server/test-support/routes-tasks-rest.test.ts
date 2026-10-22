// Phase 3a slice 1 - Tasks on the unified REST surface (opIds tasks.*).
//
// TDD'd against the typed route table: the NEW /api/tasks* endpoints are
// identity-required (cookie or agent bearer), attribution is token-derived
// ([behavior-change] createdBy/username NOT from body), DELETE is unified, and a
// mutation fans out the `all`-audience `tasks` event through the emit() helper
// (double-signal). The legacy unprefixed /tasks* surface is retired; its
// end-state (401 anonymous, 404 authenticated) lives in
// routes-legacy-retired.test.ts.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
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

// Delta helpers: a mutation pushes the ONE task that moved (task b13445e2), so
// assertions read the deltas a socket received instead of scanning a whole list.
// The whole board only arrives as `tasks` at connect / on a room-access change.
const upsertsOf = (s: TestSocket): TaskItem[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "task_upserted")
    .map((m) => (m as { task: TaskItem }).task);
const deletedIdsOf = (s: TestSocket): string[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "task_deleted")
    .map((m) => (m as { taskId: string }).taskId);

// Every PATCH must carry the version the caller read (task 4243ecc0). Tests
// that are not about the version read it straight off the board.
function currentVersion(srv: TestServer, id: string): string {
  const task = srv.agentManager.getTasks().find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task.version;
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
// --- CRUD + attribution ------------------------------------------------------
describe("routes/tasks REST: attribution and lifecycle", () => {
  it("POST /api/tasks derives createdBy+username from the TOKEN, ignoring body (behavior-change)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      // Spoof attempt: createdBy/username in the body MUST be ignored.
      body: {
        title: "Ship 3a",
        createdBy: "EVIL",
        username: "EVIL",
        createdByAgentId: "EVIL",
        assigneeAgentId: "EVIL",
      },
    });
    expect(r.status).toBe(201);
    const t = r.body as TaskItem;
    expect(t.title).toBe("Ship 3a");
    expect(t.createdBy).toBe("Morgan");
    expect(t.username).toBe("Morgan");
    expect(t.status).toBe("open");
    // A member creates with no agent id, and the body cannot supply one.
    expect(t).not.toHaveProperty("createdByAgentId");
    expect(t).not.toHaveProperty("assigneeAgentId");
  });

  // Task dc642af2: `priority: null` clears the priority. Before the fix the
  // validator ran first and rejected null with a 400, so a priority could be
  // set and changed but never taken back off.
  it("PATCH, claim and done update the task and DELETE removes it; priority null clears, '' and an unknown level are 400, absent leaves it alone", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const created = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title: "T", priority: "P1" },
      })
    ).body as TaskItem;
    const patch = (body: Record<string, unknown>) =>
      api(srv, `/api/tasks/${created.id}`, {
        method: "PATCH",
        rawSessionId: sid,
        body: { version: currentVersion(srv, created.id), ...body },
      });
    const stored = () =>
      srv.agentManager.getTasks().find((t) => t.id === created.id);

    // A PATCH that doesn't mention priority leaves it untouched.
    const other = await patch({ title: "T2", description: "d" });
    expect(other.status).toBe(200);
    expect(other.body as TaskItem).toMatchObject({
      title: "T2",
      description: "d",
      priority: "P1",
    });

    // An empty string is a malformed level, not a clear; so is a bogus level.
    for (const priority of ["", "P9"]) {
      expect((await patch({ priority })).status).toBe(400);
      expect(stored()?.priority).toBe("P1");
    }

    const cleared = await patch({ priority: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as TaskItem).priority).toBeUndefined();
    // Cleared means the KEY is gone, so the task is shaped exactly like one
    // that never had a priority (same rule as the roomId clear).
    expect("priority" in stored()!).toBe(false);
    // Clearing an already-clear priority is a no-op, not an error.
    expect((await patch({ priority: null })).status).toBe(200);

    const claimed = await api(srv, `/api/tasks/${created.id}/claim`, {
      method: "POST",
      rawSessionId: sid,
      body: { assignee: "Isomuxer1" },
    });
    expect(claimed.body as TaskItem).toMatchObject({
      status: "in_progress",
      assignee: "Isomuxer1",
    });
    const done = await api(srv, `/api/tasks/${created.id}/done`, {
      method: "POST",
      rawSessionId: sid,
      body: {},
    });
    expect((done.body as TaskItem).status).toBe("done");

    const del = await api(srv, `/api/tasks/${created.id}`, {
      method: "DELETE",
      rawSessionId: sid,
    });
    expect(del.status).toBe(204);
    expect(stored()).toBeUndefined();

    const missing = await api(srv, `/api/tasks/nope`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: "any", title: "x" },
    });
    expect(missing.status).toBe(404);
  });

  it("an agent token: createdBy is the agent and username its manager; a create files into its own room and '' files it global; it re-files a task into its own room and filters the list by it", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    const bot = await spawnAgent(srv, "TaskBot"); // spawns into roomA
    // Mint a token bound to the agent, attributed to the owner user.
    const token = mintAgentToken(bot.id, ownerId);
    const post = async (body: Record<string, unknown>) => {
      const r = await api(srv, "/api/tasks", {
        method: "POST",
        bearer: token,
        body,
      });
      expect(r.status).toBe(201);
      return r.body as TaskItem;
    };

    const mine = await post({ title: "mine" });
    expect(mine).toMatchObject({
      createdBy: "TaskBot",
      username: "Morgan",
      // The creating agent's id rides next to its name (task 83f71be9).
      createdByAgentId: bot.id,
      roomId: roomA,
    });
    const glob = await post({ title: "shared", roomId: "" });
    expect(glob.roomId).toBeUndefined();
    const theirs = await post({ title: "theirs", roomId: roomB });

    const homed = await api(srv, `/api/tasks/${glob.id}`, {
      method: "PATCH",
      bearer: token,
      body: { version: currentVersion(srv, glob.id), roomId: roomA },
    });
    expect(homed.status).toBe(200);
    expect((homed.body as TaskItem).roomId).toBe(roomA);

    // The id its prompt hands it narrows the list to its room.
    const r = await api(srv, `/api/tasks?roomId=${roomA}`, { bearer: token });
    expect(r.status).toBe(200);
    const ids = (r.body as TaskItem[]).map((t) => t.id).sort();
    expect(ids).toEqual([mine.id, glob.id].sort());
    expect(ids).not.toContain(theirs.id);
  });

  // A CRON RUN is the identity that inherited the retired loopback /tasks
  // board: it has no room of its own, and its userId is the job's CREATOR, so
  // without the cron-run rule an owner-created job would inherit every room.
  // task:write is one coarse capability, and the retired route walled DELETE
  // off at 405: the taskDelete guard keeps that boundary.
  it("a run token: createdBy is the job and username its creator; it sees, touches and files office-global tasks only, even for an owner's job, and never deletes", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const job = srv.cronjobManager.addCronjob({
      name: "Nightly Sweep",
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Morgan",
      userId: ownerId,
    });
    const runToken = mintRunToken(job.id, "run-1", ownerId);
    const roomB = srv.agentManager.createRoom("Room B");
    const asOwner = { rawSessionId: owner.rawSessionId };
    const inB = (
      await api(srv, "/api/tasks", {
        method: "POST",
        ...asOwner,
        body: { title: "in B", roomId: roomB },
      })
    ).body as TaskItem;
    const glob = (
      await api(srv, "/api/tasks", {
        method: "POST",
        ...asOwner,
        body: { title: "glob", roomId: "" },
      })
    ).body as TaskItem;

    const list = await api(srv, "/api/tasks", { bearer: runToken });
    expect(list.status).toBe(200);
    const runIds = (list.body as TaskItem[]).map((t) => t.id);
    expect(runIds).toContain(glob.id);
    expect(runIds).not.toContain(inB.id);
    // GET + every mutation on the room task is a 404 for the run.
    for (const [method, path, body] of [
      ["GET", `/api/tasks/${inB.id}`, undefined],
      [
        "PATCH",
        `/api/tasks/${inB.id}`,
        { version: currentVersion(srv, inB.id), status: "done" },
      ],
      ["POST", `/api/tasks/${inB.id}/claim`, { assignee: "x" }],
      ["POST", `/api/tasks/${inB.id}/done`, {}],
    ] as const) {
      const r = await api(srv, path, { method, bearer: runToken, body });
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
    expect(
      srv.agentManager.getTasks().find((t) => t.id === inB.id)?.status,
    ).toBe("open");

    // A create with no roomId files GLOBAL, as the job; naming a room is a 404.
    const filed = await api(srv, "/api/tasks", {
      method: "POST",
      bearer: runToken,
      body: { title: "filed by the run" },
    });
    expect(filed.status).toBe(201);
    const t = filed.body as TaskItem;
    // The run acts as the job, not as the human who created the job.
    expect(t.createdBy).toBe("Nightly Sweep");
    expect(t.username).toBe("Morgan");
    expect(t).not.toHaveProperty("createdByAgentId");
    expect(t.roomId).toBeUndefined();
    expect(
      (
        await api(srv, "/api/tasks", {
          method: "POST",
          bearer: runToken,
          body: { title: "into B", roomId: roomB },
        })
      ).status,
    ).toBe(404);

    const del = await api(srv, `/api/tasks/${glob.id}`, {
      method: "DELETE",
      bearer: runToken,
    });
    expect(del.status).toBe(403);
    expect(srv.agentManager.getTasks().some((x) => x.id === glob.id)).toBe(
      true,
    );
    // An owner cookie still deletes it - the guard is cron-run-only.
    expect(
      (
        await api(srv, `/api/tasks/${glob.id}`, {
          method: "DELETE",
          ...asOwner,
        })
      ).status,
    ).toBe(204);
  });
});

// --- The delta a mutation sends ----------------------------------------------
describe("routes/tasks REST: WS delta", () => {
  it("a REST create fans out a `task_upserted` DELTA to a connected socket (emit() path)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const hydrationCount = () =>
      sock.messages.filter((m) => (m as { type?: string }).type === "tasks")
        .length;
    await waitUntil(() => hydrationCount() > 0, 2000, "connect hydration");
    const afterConnect = hydrationCount();

    const created = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { title: "broadcast me" },
      })
    ).body as TaskItem;

    await waitUntil(
      () => upsertsOf(sock).some((t) => t.id === created.id),
      2000,
      "task_upserted carrying the new task",
    );
    // The whole board must NOT ride a mutation any more - that rebroadcast is
    // the 635KB-per-mutation cost this delta replaced. Hydration stays put.
    expect(hydrationCount()).toBe(afterConnect);
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
    const owner = await srv.seedOwner("Morgan");
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
      [
        "PATCH",
        `/api/tasks/${inA.id}`,
        { version: currentVersion(srv, inA.id), status: "done" },
      ],
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

  it("PATCH re-rooms: omit=unchanged, accessible id=move, ''=clear-to-global, non-string=400, unknown=404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");

    const t = (await postTask(srv, owner.rawSessionId, "movable", roomA))
      .body as TaskItem;
    expect(t.roomId).toBe(roomA);

    // (1) roomId key OMITTED → room unchanged (a title-only PATCH keeps roomA).
    const untouched = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), title: "renamed" },
    });
    expect(untouched.status).toBe(200);
    expect((untouched.body as TaskItem).title).toBe("renamed");
    expect((untouched.body as TaskItem).roomId).toBe(roomA);

    // (4) accessible room id → move to roomB.
    const moved = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: roomB },
    });
    expect(moved.status).toBe(200);
    expect((moved.body as TaskItem).roomId).toBe(roomB);

    // (3) "" → clear to office-global. The response AND the stored record drop
    // the key entirely (canonical global === absent roomId, not undefined).
    const cleared = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: "" },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body as TaskItem).roomId).toBeUndefined();
    const stored = srv.agentManager.getTasks().find((x) => x.id === t.id)!;
    expect("roomId" in stored).toBe(false);

    // (1b) an untouched PATCH after a clear leaves it global - a change to some
    // OTHER field must not resurrect a room.
    const stillGlobal = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), status: "in_progress" },
    });
    expect(stillGlobal.status).toBe(200);
    expect((stillGlobal.body as TaskItem).roomId).toBeUndefined();

    // (2) non-string roomId → 400 shape error (before the visibility gate).
    const badShape = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: 7 },
    });
    expect(badShape.status).toBe(400);

    // (5) unknown room id → uniform 404 (the owner's all-rooms set lets a truly
    // unknown id be told apart, and the answer is the same 404 as inaccessible).
    const unknown = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: "deadbeef" },
    });
    expect(unknown.status).toBe(404);
  });

  it("PATCH into a room outside the caller's access is a uniform 404 (no room oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id; // Mia has NO grant
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });

    // A global task Mia can see and mutate.
    const glob = (await postTask(srv, owner.rawSessionId, "g", ""))
      .body as TaskItem;

    // Mia CAN re-room into roomB (granted) ...
    const okMove = await api(srv, `/api/tasks/${glob.id}`, {
      method: "PATCH",
      rawSessionId: member.rawSessionId,
      body: { version: currentVersion(srv, glob.id), roomId: roomB },
    });
    expect(okMove.status).toBe(200);
    expect((okMove.body as TaskItem).roomId).toBe(roomB);

    // ... but NOT into roomA (no grant), nor an unknown id - both a uniform 404.
    for (const target of [roomA, "nope1234"]) {
      const r = await api(srv, `/api/tasks/${glob.id}`, {
        method: "PATCH",
        rawSessionId: member.rawSessionId,
        body: { version: currentVersion(srv, glob.id), roomId: target },
      });
      expect(r.status).toBe(404);
    }
    // The rejected writes were pre-mutation: the task stayed in roomB.
    expect(
      srv.agentManager.getTasks().find((x) => x.id === glob.id)?.roomId,
    ).toBe(roomB);
  });

  it("re-filing a task OUT of a member's rooms reaches them as task_deleted", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomA] });

    const t = (await postTask(srv, owner.rawSessionId, "moves away", roomA))
      .body as TaskItem;
    const memberSock: TestSocket = await srv.connectWs(member.rawSessionId);
    await waitUntil(
      () =>
        memberSock.messages.some(
          (m) => (m as { type?: string }).type === "tasks",
        ),
      2000,
      "member hydration",
    );

    // roomA → roomB: Mia can't access roomB, so from her seat the task is gone.
    // Without this delete her board would keep showing a task she lost.
    await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: roomB },
    });
    await waitUntil(
      () => deletedIdsOf(memberSock).includes(t.id),
      2000,
      "member told to drop the re-filed task",
    );
    // And she is NOT handed the task's new home in an upsert.
    expect(upsertsOf(memberSock).some((x) => x.id === t.id)).toBe(false);
  });

  it("re-filing a task INTO a member's rooms reaches them as task_upserted", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomA] });

    const t = (await postTask(srv, owner.rawSessionId, "moves in", roomB))
      .body as TaskItem;
    const memberSock: TestSocket = await srv.connectWs(member.rawSessionId);
    await waitUntil(
      () =>
        memberSock.messages.some(
          (m) => (m as { type?: string }).type === "tasks",
        ),
      2000,
      "member hydration",
    );
    // She has never heard of this task - her hydration predates the move.
    expect(upsertsOf(memberSock).some((x) => x.id === t.id)).toBe(false);

    await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, t.id), roomId: roomA },
    });
    // An upsert, even though this is an UPDATE: it's the first time she can see
    // the task, so her board has no row to update - it appends.
    await waitUntil(
      () => upsertsOf(memberSock).some((x) => x.id === t.id),
      2000,
      "member gains the re-filed task",
    );
  });

  // Closing a room changes who can see its tasks WITHOUT going through
  // updateTask, so no delta describes it: the close itself re-projects every
  // board. The records stay, and office owners keep them (task 6abfcc18): an
  // owner's board keeps the closed room's task, a member who had the room
  // drops it, and the owner's later moves on it never reach the member.
  it("closing a room keeps its tasks on an owner's board and drops them from a member's; the owner's moves on them never reach the member", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id; // Mia has no grant
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const kept = (await postTask(srv, owner.rawSessionId, "kept", roomB))
      .body as TaskItem;
    const moved = (await postTask(srv, owner.rawSessionId, "moved", roomB))
      .body as TaskItem;
    const gone = (await postTask(srv, owner.rawSessionId, "gone", roomB))
      .body as TaskItem;
    const survivor = (await postTask(srv, owner.rawSessionId, "global", ""))
      .body as TaskItem;

    const ownerSock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const memberSock: TestSocket = await srv.connectWs(member.rawSessionId);
    const boardsOf = (s: TestSocket) =>
      s.messages.filter((m) => (m as { type?: string }).type === "tasks");
    const lastBoard = (s: TestSocket): TaskItem[] | null => {
      const boards = boardsOf(s);
      return boards.length
        ? ((boards[boards.length - 1] as { tasks: TaskItem[] }).tasks ?? [])
        : null;
    };
    await waitUntil(
      () => lastBoard(ownerSock) !== null && lastBoard(memberSock) !== null,
      2000,
      "connect hydration",
    );
    // Hydration holds the room's tasks for both: the room is open.
    expect(lastBoard(ownerSock)!.some((t) => t.id === kept.id)).toBe(true);
    expect(lastBoard(memberSock)!.some((t) => t.id === kept.id)).toBe(true);
    const ownerBoardsBefore = boardsOf(ownerSock).length;

    expect(
      (
        await api(srv, `/api/rooms/${roomB}`, {
          method: "DELETE",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(204);
    await waitUntil(
      () => lastBoard(memberSock)!.every((t) => t.id !== kept.id),
      2000,
      "member board drops the closed room's tasks",
    );
    expect(lastBoard(memberSock)!.some((t) => t.id === survivor.id)).toBe(true);
    // The owner got a fresh board too, and it still holds all three.
    await waitUntil(
      () => boardsOf(ownerSock).length > ownerBoardsBefore,
      2000,
      "owner board re-pushed",
    );
    for (const t of [kept, moved, gone]) {
      expect(lastBoard(ownerSock)!.some((x) => x.id === t.id)).toBe(true);
    }

    // An edit in place, a re-file into room A (Mia has no grant there) and a
    // delete: each reaches the owner and none reaches Mia.
    await api(srv, `/api/tasks/${kept.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, kept.id), title: "kept, edited" },
    });
    await api(srv, `/api/tasks/${moved.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, moved.id), roomId: roomA },
    });
    await api(srv, `/api/tasks/${gone.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    // A last edit Mia CAN see orders the stream: once it arrives, every delta
    // before it has been decided for her.
    await api(srv, `/api/tasks/${survivor.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: {
        version: currentVersion(srv, survivor.id),
        title: "global, edited",
      },
    });
    await waitUntil(
      () =>
        upsertsOf(ownerSock).some((t) => t.title === "kept, edited") &&
        upsertsOf(ownerSock).some(
          (t) => t.id === moved.id && t.roomId === roomA,
        ) &&
        deletedIdsOf(ownerSock).includes(gone.id),
      2000,
      "owner hears all three moves",
    );
    await waitUntil(
      () => upsertsOf(memberSock).some((t) => t.title === "global, edited"),
      2000,
      "member hears the global edit",
    );
    const closedIds = [kept.id, moved.id, gone.id];
    expect(
      upsertsOf(memberSock).filter((t) => closedIds.includes(t.id)),
    ).toEqual([]);
    expect(
      deletedIdsOf(memberSock).filter((id) => closedIds.includes(id)),
    ).toEqual([]);
  });

  it("a mutation fans out per-recipient: a member socket never receives a room task it can't see", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomB = srv.agentManager.createRoom("Room B"); // Mia has no grant
    const ownerSock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const memberSock: TestSocket = await srv.connectWs(member.rawSessionId);

    const inB = (await postTask(srv, owner.rawSessionId, "in B", roomB))
      .body as TaskItem;

    // Owner can access every room, so the create reaches them as an upsert.
    await waitUntil(
      () => upsertsOf(ownerSock).some((t) => t.id === inB.id),
      2000,
      "owner sees room task",
    );
    // Mia hears NOTHING about it - not an upsert, and not a delete either. A
    // delete would name the id, which is the cross-room oracle the REST 404
    // avoids; silence is the point.
    expect(upsertsOf(memberSock).some((t) => t.id === inB.id)).toBe(false);
    expect(deletedIdsOf(memberSock)).not.toContain(inB.id);
  });
});

// The ?roomId= list filter (task 43c55a3b). It exists because an agent asked to
// "find my room's tasks" had no server-side way to do it and hand-rolled a jq
// pipeline over a field the task object does not have (roomName), reading the
// null fallback as "everything is office-global". Same value grammar as the
// create/update roomId body field so one value means one thing across all verbs.
describe("routes/tasks REST: ?roomId= list filter", () => {
  const idsOf = (r: Res) => new Set((r.body as TaskItem[]).map((t) => t.id));
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

  it("narrows to one room, '' to office-global only, and composes with ?status=, ?assignee= and ?title=", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    const inA = (await postTask(srv, sid, "in A", roomA)).body as TaskItem;
    const doneA = (await postTask(srv, sid, "done A", roomA)).body as TaskItem;
    // Every narrowing needs a foil in the other room, or a dropped room
    // filter still looks right.
    const inB = (await postTask(srv, sid, "in B", roomB)).body as TaskItem;
    const glob = (await postTask(srv, sid, "global", "")).body as TaskItem;
    await api(srv, `/api/tasks/${doneA.id}/done`, {
      method: "POST",
      rawSessionId: sid,
      body: {},
    });
    for (const t of [inA, inB]) {
      await api(srv, `/api/tasks/${t.id}/claim`, {
        method: "POST",
        rawSessionId: sid,
        body: { assignee: "Isomuxer1" },
      });
    }
    const list = async (q: string) =>
      [
        ...idsOf(await api(srv, `/api/tasks${q}`, { rawSessionId: sid })),
      ].sort();

    // Default (no status) still hides done, within the room filter.
    expect(await list(`?roomId=${roomA}`)).toEqual([inA.id]);
    expect(await list(`?status=all&roomId=${roomA}`)).toEqual(
      [inA.id, doneA.id].sort(),
    );
    expect(await list("?roomId=")).toEqual([glob.id]);
    // Omitting the param is unchanged: accessible rooms UNION globals.
    expect(await list("")).toEqual([inA.id, inB.id, glob.id].sort());
    expect(await list(`?roomId=${roomA}&assignee=Isomuxer1`)).toEqual([inA.id]);
    expect(await list(`?roomId=${roomA}&title=in`)).toEqual([inA.id]);
  });

  it("an inaccessible OR unknown roomId is a uniform 404, not an empty list", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id; // Mia has no grant
    await postTask(srv, owner.rawSessionId, "in A", roomA);

    const forbidden = await api(srv, `/api/tasks?roomId=${roomA}`, {
      rawSessionId: member.rawSessionId,
    });
    expect(forbidden.status).toBe(404);
    const unknown = await api(srv, "/api/tasks?roomId=deadbeef", {
      rawSessionId: member.rawSessionId,
    });
    expect(unknown.status).toBe(404);
    // An accessible room with nothing in it is the distinguishable case: 200 [].
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const empty = await api(srv, `/api/tasks?roomId=${roomB}`, {
      rawSessionId: member.rawSessionId,
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });
});

// --- Lost-update guard (task 4243ecc0) --------------------------------------
// Every PATCH carries the version the caller read; a claim refuses a task that
// someone else holds; done needs no version.

describe("routes/tasks REST: version guard + claim", () => {
  type ErrBody = {
    error: {
      code: string;
      message?: string;
      version?: string;
      task?: TaskItem;
    };
  };
  const err = (r: Res) => (r.body as ErrBody).error;

  async function setup() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const t = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title: "T" },
      })
    ).body as TaskItem;
    const stored = () =>
      srv.agentManager.getTasks().find((x) => x.id === t.id)!;
    return { srv, sid, t, stored };
  }

  it("a task carries a version and a write gives a new one; a PATCH with no version is 400, a stale one is 409 with the current task, and neither writes", async () => {
    const { srv, sid, t, stored } = await setup();
    expect(typeof t.version).toBe("string");
    expect(t.version.length).toBeGreaterThan(0);
    for (const body of [{ title: "x" }, { title: "x", version: "" }]) {
      const r = await api(srv, `/api/tasks/${t.id}`, {
        method: "PATCH",
        rawSessionId: sid,
        body,
      });
      expect(r.status).toBe(400);
      expect(err(r).code).toBe("invalid_version");
    }
    expect(stored().title).toBe("T");

    // Another writer lands first.
    const theirs = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: t.version, title: "theirs" },
    });
    expect(theirs.status).toBe(200);
    const after = theirs.body as TaskItem;
    expect(after.version).not.toBe(t.version);
    // GET serves the same token the write returned.
    const got = await api(srv, `/api/tasks/${t.id}`, { rawSessionId: sid });
    expect((got.body as TaskItem).version).toBe(after.version);

    const r = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: t.version, title: "mine" },
    });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe("version_conflict");
    expect(err(r).task).toEqual(stored());
    expect(err(r).version).toBe(stored().version);
    expect(stored().title).toBe("theirs");
    // Retrying with the version from the 409 lands.
    const retry = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: err(r).version, title: "mine" },
    });
    expect(retry.status).toBe(200);
    expect(stored().title).toBe("mine");
  });

  it("claim takes an unheld task and lets its holder claim again; anyone else gets 409 naming the holder; a versioned PATCH reassigns; done needs no version from any state", async () => {
    const { srv, sid, t, stored } = await setup();
    const claim = (body: object) =>
      api(srv, `/api/tasks/${t.id}/claim`, {
        method: "POST",
        rawSessionId: sid,
        body,
      });
    const doneOnce = async (id = t.id) => {
      const r = await api(srv, `/api/tasks/${id}/done`, {
        method: "POST",
        rawSessionId: sid,
        body: {},
      });
      expect(r.status).toBe(200);
      expect((r.body as TaskItem).status).toBe("done");
    };

    for (let i = 0; i < 2; i++)
      expect((await claim({ assignee: "Worker A" })).status).toBe(200);
    expect(stored()).toMatchObject({
      status: "in_progress",
      assignee: "Worker A",
    });
    // A claim naming someone else, and a claim naming no one, both refuse.
    for (const body of [{ assignee: "Worker B" }, {}]) {
      const r = await claim(body);
      expect(r.status).toBe(409);
      expect(err(r).code).toBe("task_held");
      expect((err(r) as { assignee?: string }).assignee).toBe("Worker A");
      expect(stored().assignee).toBe("Worker A");
    }
    const moved = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: stored().version, assignee: "Worker B" },
    });
    expect(moved.status).toBe(200);
    expect(stored().assignee).toBe("Worker B");

    await doneOnce(); // from in_progress, held
    await doneOnce(); // from done
    const fresh = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title: "open" },
      })
    ).body as TaskItem;
    await doneOnce(fresh.id); // from open
  });
});

// --- Status and priority on the list (tasks 77460aea, 76511cf9) -------------
// P4 replaces the old backlog status; obsolete closes a task without doing it.
// inDefaultTaskList is shared/task-board.test.ts; this is the query grammar.

describe("routes/tasks REST: status and priority filters", () => {
  const idsOf = (r: Res) => new Set((r.body as TaskItem[]).map((t) => t.id));

  it("the default list hides closed (done, obsolete) and open P4 tasks; an explicit filter reaches them", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const make = async (title: string, priority: string) =>
      (
        await api(srv, "/api/tasks", {
          method: "POST",
          rawSessionId: sid,
          body: { title, priority },
        })
      ).body as TaskItem;
    const live = await make("live", "P1");
    const shelved = await make("shelved", "P4");
    const startedP4 = await make("started P4", "P4");
    const doneP4 = await make("done P4", "P4");
    const dropped = await make("dropped", "P1");
    const droppedP4 = await make("dropped P4", "P4");
    const finished = await make("finished", "P1");
    expect(shelved.priority).toBe("P4");
    await api(srv, `/api/tasks/${startedP4.id}/claim`, {
      method: "POST",
      rawSessionId: sid,
      body: { assignee: "Worker A" },
    });
    for (const t of [doneP4, finished])
      await api(srv, `/api/tasks/${t.id}/done`, {
        method: "POST",
        rawSessionId: sid,
        body: {},
      });
    for (const t of [dropped, droppedP4]) {
      const r = await api(srv, `/api/tasks/${t.id}`, {
        method: "PATCH",
        rawSessionId: sid,
        body: {
          version: t.version,
          status: "obsolete",
          description: "superseded",
        },
      });
      expect(r.status).toBe(200);
      expect(r.body as TaskItem).toMatchObject({
        status: "obsolete",
        description: "superseded",
      });
    }

    const list = async (q: string) => {
      const r = await api(srv, `/api/tasks${q}`, { rawSessionId: sid });
      expect(r.status).toBe(200);
      return idsOf(r);
    };
    // Default: an in-progress P4 task shows, as a claimed backlog task did.
    expect(await list("")).toEqual(new Set([live.id, startedP4.id]));
    // A named priority lifts the P4 exclusion, not the closed one.
    expect(await list("?priority=P4")).toEqual(
      new Set([shelved.id, startedP4.id]),
    );
    expect(await list("?priority=P4&status=all")).toEqual(
      new Set([shelved.id, startedP4.id, doneP4.id, droppedP4.id]),
    );
    // An explicit status filter is literal: it includes P4 tasks.
    expect(await list("?status=open")).toEqual(new Set([live.id, shelved.id]));
    expect(await list("?status=obsolete")).toEqual(
      new Set([dropped.id, droppedP4.id]),
    );
    expect(await list("?status=done")).toEqual(
      new Set([doneP4.id, finished.id]),
    );
    expect((await list("?status=all")).size).toBe(7);
  });

  it('refuses status "backlog" with a pointer to P4 on a PATCH, a list and a create, an unknown status and an unknown priority, and changes nothing', async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const t = (
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title: "T" },
      })
    ).body as TaskItem;
    const backlog = [
      await api(srv, `/api/tasks/${t.id}`, {
        method: "PATCH",
        rawSessionId: sid,
        body: { version: t.version, status: "backlog" },
      }),
      await api(srv, "/api/tasks?status=backlog", { rawSessionId: sid }),
      await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title: "shelve me", status: "backlog" },
      }),
    ];
    for (const r of backlog) {
      expect(r.status).toBe(400);
      const e = (r.body as { error: { code: string; message: string } }).error;
      expect(e.code).toBe("invalid_request");
      // The way forward is the priority level, so the error names it.
      expect(e.message).toContain("P4");
    }
    const closed = await api(srv, `/api/tasks/${t.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { version: t.version, status: "closed" },
    });
    expect(closed.status).toBe(400);
    expect((closed.body as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
    expect(
      (await api(srv, "/api/tasks?priority=P9", { rawSessionId: sid })).status,
    ).toBe(400);
    expect(srv.agentManager.getTasks()).toEqual([
      expect.objectContaining({ id: t.id, status: "open" }),
    ]);
  });
});

describe("task history and restore", () => {
  it("uses task visibility for history and owner authority for audit and restore", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("HistoryOwner");
    const member = await srv.seedMember("HistoryMember");
    const room = srv.agentManager.getRooms()[0].id;
    updateUserById(getUserByName("HistoryMember")!.id, { allowedRooms: [] });
    const made = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { title: "history", roomId: room },
    });
    const task = made.body as TaskItem;
    expect(made.status).toBe(201);
    expect(
      (
        await api(srv, `/api/tasks/${task.id}/history`, {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(srv, "/api/audit-log", { rawSessionId: member.rawSessionId }))
        .status,
    ).toBe(403);
    updateUserById(getUserByName("HistoryMember")!.id, {
      allowedRooms: [room],
    });
    const history = await api(srv, `/api/tasks/${task.id}/history`, {
      rawSessionId: member.rawSessionId,
    });
    expect(history.status).toBe(200);
    expect((history.body as { items: unknown[] }).items).toHaveLength(1);
    expect(
      (
        await api(srv, `/api/tasks/${task.id}/restore`, {
          method: "POST",
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    await api(srv, `/api/tasks/${task.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    const restored = await api(srv, `/api/tasks/${task.id}/restore`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(restored.status).toBe(201);
    expect(restored.body).toEqual(task);
    expect(
      (
        await api(srv, `/api/tasks/${task.id}/restore`, {
          method: "POST",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(409);
    const page = await api(srv, `/api/audit-log?targetId=${task.id}`, {
      rawSessionId: owner.rawSessionId,
    });
    const rows = (page.body as { items: { operation: string }[] }).items;
    expect(rows.map((row) => row.operation)).toEqual([
      "tasks.restore",
      "tasks.delete",
      "tasks.create",
    ]);
    expect(
      (
        await api(srv, "/api/audit-log?limit=1001", {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(400);
  });
  it("a failed restore transaction leaves the deleted task absent", async () => {
    const { officeAuditStore } = await import("../audit-store.ts");
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("RestoreOwner");
    const made = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { title: "restore" },
    });
    const task = made.body as TaskItem;
    await api(srv, `/api/tasks/${task.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    officeAuditStore().db.exec(
      "CREATE TRIGGER audit_fail BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect(
      (
        await api(srv, `/api/tasks/${task.id}/restore`, {
          method: "POST",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(500);
    expect(srv.agentManager.getTasks().some((t) => t.id === task.id)).toBe(
      false,
    );
    expect(
      officeAuditStore()
        .db.query("SELECT * FROM tasks WHERE id=?")
        .all(task.id),
    ).toHaveLength(0);
  });
});

it("refuses to restore a task from a closed room", async () => {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("ClosedRoomOwner");
  const roomId = srv.agentManager.createRoom("Closed task room");
  const made = await api(srv, "/api/tasks", {
    method: "POST",
    rawSessionId: owner.rawSessionId,
    body: { title: "private task", roomId },
  });
  const task = made.body as TaskItem;
  expect(made.status).toBe(201);
  await api(srv, `/api/tasks/${task.id}`, {
    method: "DELETE",
    rawSessionId: owner.rawSessionId,
  });
  expect(
    (
      await api(srv, `/api/rooms/${roomId}`, {
        method: "DELETE",
        rawSessionId: owner.rawSessionId,
      })
    ).status,
  ).toBe(204);
  const restored = await api(srv, `/api/tasks/${task.id}/restore`, {
    method: "POST",
    rawSessionId: owner.rawSessionId,
  });
  expect(restored.status).toBe(409);
  expect(restored.body).toMatchObject({ error: { code: "room_unavailable" } });
  expect(srv.agentManager.getTasks().some((t) => t.id === task.id)).toBe(false);
});

// --- A closed room's tasks (task 6abfcc18) -----------------------------------
// Closing a room leaves its tasks in the store. Office owners - the owner user,
// their agents, their API tokens, and an app run by one of their agents - see
// them and can edit, re-file, close or delete them with the ordinary routes. A
// member who had the room, and a cron run, get the uniform 404. Nobody can file
// INTO the closed room.
describe("routes/tasks REST: a closed room's tasks", () => {
  async function setup() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const ownerId = getUserByName("Morgan")!.id;
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const post = async (title: string, roomId: string) => {
      const r = await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { title, roomId },
      });
      expect(r.status).toBe(201);
      return r.body as TaskItem;
    };
    const stored = (id: string) =>
      srv.agentManager.getTasks().find((t) => t.id === id);
    return { srv, owner, member, ownerId, roomA, roomB, post, stored };
  }
  async function closeRoom(srv: TestServer, rawSessionId: string, id: string) {
    const r = await api(srv, `/api/rooms/${id}`, {
      method: "DELETE",
      rawSessionId,
    });
    expect(r.status).toBe(204);
    expect(srv.agentManager.getRooms().some((room) => room.id === id)).toBe(
      false,
    );
  }
  const listIds = async (
    srv: TestServer,
    auth: { rawSessionId?: string; bearer?: string },
  ) => {
    const r = await api(srv, "/api/tasks?status=all", auth);
    expect(r.status).toBe(200);
    return (r.body as TaskItem[]).map((t) => t.id);
  };

  it("an owner, the owner's agent, API token and agent-run app see the task; a member of the room and a cron run get 404", async () => {
    const { srv, owner, member, ownerId, roomB, post } = await setup();
    const bot = await srv.agentManager.spawn(
      "OwnerBot",
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      srv.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      "Morgan",
      "claude",
    );
    if (!bot) throw new Error("spawn OwnerBot returned null");
    const agentToken = mintAgentToken(bot.id, ownerId);
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: agentToken,
      body: {
        name: "board-app",
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
      },
    });
    expect(reg.status).toBe(201);
    const appToken = srv.appSupervisor.tokenFiles.get("board-app");
    if (!appToken) throw new Error("no token file for board-app");
    const apiToken = (
      await mintApiToken({
        userId: ownerId,
        name: "board",
        expiresInDays: null,
      })
    ).token;
    const runToken = mintRunToken("job-closed", "run-closed", ownerId);

    const t = await post("in the closed room", roomB);
    await closeRoom(srv, owner.rawSessionId, roomB);

    const sees = [
      { rawSessionId: owner.rawSessionId },
      { bearer: agentToken },
      { bearer: apiToken },
      { bearer: appToken },
    ];
    for (const auth of sees) {
      expect(await listIds(srv, auth)).toContain(t.id);
      const got = await api(srv, `/api/tasks/${t.id}`, auth);
      expect(got.status).toBe(200);
      expect((got.body as TaskItem).roomId).toBe(roomB);
    }
    // Both blind callers can list (a 200), so the absence is the room rule,
    // not a missing route or token.
    for (const auth of [
      { rawSessionId: member.rawSessionId },
      { bearer: runToken },
    ]) {
      expect(await listIds(srv, auth)).not.toContain(t.id);
      expect((await api(srv, `/api/tasks/${t.id}`, auth)).status).toBe(404);
    }
  });

  it("an owner edits, claims, completes, re-files and deletes it; a member of the room gets 404 on each and changes nothing", async () => {
    const { srv, owner, member, roomA, roomB, post, stored } = await setup();
    const edited = await post("edit me", roomB);
    const toRoomA = await post("re-file me into room A", roomB);
    const toGlobal = await post("re-file me to global", roomB);
    const deleted = await post("delete me", roomB);
    await closeRoom(srv, owner.rawSessionId, roomB);

    const mutations = (id: string) =>
      [
        ["GET", `/api/tasks/${id}/history`, undefined],
        [
          "PATCH",
          `/api/tasks/${id}`,
          { version: currentVersion(srv, id), title: "x" },
        ],
        ["POST", `/api/tasks/${id}/claim`, { assignee: "Mia" }],
        ["POST", `/api/tasks/${id}/done`, {}],
        ["DELETE", `/api/tasks/${id}`, undefined],
      ] as const;
    for (const [method, path, body] of mutations(edited.id)) {
      const r = await api(srv, path, {
        method,
        rawSessionId: member.rawSessionId,
        body,
      });
      expect(r.status).toBe(404);
    }
    expect(stored(edited.id)).toEqual(edited);

    const as = (method: string, path: string, body?: unknown) =>
      api(srv, path, { method, rawSessionId: owner.rawSessionId, body });
    expect((await as("GET", `/api/tasks/${edited.id}/history`)).status).toBe(
      200,
    );
    const patched = await as("PATCH", `/api/tasks/${edited.id}`, {
      version: currentVersion(srv, edited.id),
      title: "edited",
    });
    expect(patched.status).toBe(200);
    // An edit that does not name a room leaves the task in the closed room.
    expect(stored(edited.id)).toMatchObject({ title: "edited", roomId: roomB });
    expect(
      (
        await as("POST", `/api/tasks/${edited.id}/claim`, {
          assignee: "Morgan",
        })
      ).status,
    ).toBe(200);
    expect((await as("POST", `/api/tasks/${edited.id}/done`, {})).status).toBe(
      200,
    );
    expect(stored(edited.id)?.status).toBe("done");

    expect(
      (
        await as("PATCH", `/api/tasks/${toRoomA.id}`, {
          version: currentVersion(srv, toRoomA.id),
          roomId: roomA,
        })
      ).status,
    ).toBe(200);
    expect(stored(toRoomA.id)?.roomId).toBe(roomA);
    expect(
      (
        await as("PATCH", `/api/tasks/${toGlobal.id}`, {
          version: currentVersion(srv, toGlobal.id),
          roomId: "",
        })
      ).status,
    ).toBe(200);
    expect(stored(toGlobal.id)).toBeDefined();
    expect("roomId" in stored(toGlobal.id)!).toBe(false);

    expect((await as("DELETE", `/api/tasks/${deleted.id}`)).status).toBe(204);
    expect(stored(deleted.id)).toBeUndefined();
  });

  it("an owner cannot file into the closed room or filter the list by it", async () => {
    const { srv, owner, roomB, post, stored } = await setup();
    const glob = await post("global", "");
    await closeRoom(srv, owner.rawSessionId, roomB);

    const create = await api(srv, "/api/tasks", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { title: "into the closed room", roomId: roomB },
    });
    expect(create.status).toBe(404);
    const into = await api(srv, `/api/tasks/${glob.id}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { version: currentVersion(srv, glob.id), roomId: roomB },
    });
    expect(into.status).toBe(404);
    expect("roomId" in stored(glob.id)!).toBe(false);
    const filtered = await api(srv, `/api/tasks?roomId=${roomB}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(filtered.status).toBe(404);
  });
});

// --- The assignee's agent id (task 83f71be9) --------------------------------
// A task remembers WHICH agent its assignee name named. A new agent that takes
// a killed agent's name does not get that agent's tasks, and a rename carries
// the agent's tasks along.

describe("routes/tasks REST: the assignee's agent id", () => {
  type HeldErr = {
    error: {
      code: string;
      assignee?: string;
      assigneeAgentId?: string;
      killed?: boolean;
    };
  };
  const heldErr = (r: Res) => (r.body as HeldErr).error;
  const idsOf = (r: Res) => new Set((r.body as TaskItem[]).map((t) => t.id));

  async function setup() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const sid = owner.rawSessionId;
    const stored = (id: string) =>
      srv.agentManager.getTasks().find((x) => x.id === id)!;
    const create = async (title: string, extra: object = {}) => {
      const r = await api(srv, "/api/tasks", {
        method: "POST",
        rawSessionId: sid,
        body: { title, ...extra },
      });
      expect(r.status).toBe(201);
      return r.body as TaskItem;
    };
    const claim = (id: string, assignee: string) =>
      api(srv, `/api/tasks/${id}/claim`, {
        method: "POST",
        rawSessionId: sid,
        body: { assignee },
      });
    const patch = (id: string, body: object) =>
      api(srv, `/api/tasks/${id}`, {
        method: "PATCH",
        rawSessionId: sid,
        body: { version: stored(id).version, ...body },
      });
    const listBy = (assignee: string) =>
      api(
        srv,
        `/api/tasks?status=all&assignee=${encodeURIComponent(assignee)}`,
        { rawSessionId: sid },
      );
    const kill = async (agentId: string) => {
      const r = await api(srv, `/api/agents/${agentId}`, {
        method: "DELETE",
        rawSessionId: sid,
      });
      expect(r.status).toBe(204);
    };
    return { srv, sid, stored, create, claim, patch, listBy, kill };
  }

  it("create, claim and PATCH stamp the live agent the name names; a member name or a clear stamps none", async () => {
    const { srv, sid, stored, create, claim, patch } = await setup();
    const worker = await spawnAgent(srv, "Worker");

    // Create resolves the name case-insensitively and trimmed.
    const made = await create("assigned at create", { assignee: " worker " });
    expect(stored(made.id).assigneeAgentId).toBe(worker.id);

    const t = await create("claimed");
    expect(stored(t.id)).not.toHaveProperty("assigneeAgentId");
    // The id is the server's to stamp: a body that carries one is ignored.
    const claimed = await api(srv, `/api/tasks/${t.id}/claim`, {
      method: "POST",
      rawSessionId: sid,
      body: { assignee: "Worker", assigneeAgentId: "agent-spoof" },
    });
    expect(claimed.status).toBe(200);
    expect(stored(t.id).assigneeAgentId).toBe(worker.id);
    expect((claimed.body as TaskItem).assigneeAgentId).toBe(worker.id);

    // A name no live agent has (a member) stamps no id.
    expect((await patch(t.id, { assignee: "Morgan" })).status).toBe(200);
    expect(stored(t.id).assignee).toBe("Morgan");
    expect(stored(t.id)).not.toHaveProperty("assigneeAgentId");

    expect(
      (
        await patch(t.id, {
          assignee: "Worker",
          assigneeAgentId: "agent-spoof",
        })
      ).status,
    ).toBe(200);
    expect(stored(t.id).assigneeAgentId).toBe(worker.id);

    // A clear drops the name and the id together.
    expect((await patch(t.id, { assignee: null })).status).toBe(200);
    expect(stored(t.id)).not.toHaveProperty("assignee");
    expect(stored(t.id)).not.toHaveProperty("assigneeAgentId");

    // Re-claim by a namesake string with another case: same agent, same id.
    expect((await claim(t.id, "WORKER")).status).toBe(200);
    expect(stored(t.id).assigneeAgentId).toBe(worker.id);
    // Now held: a claimant written another way resolves to the holder's id,
    // so it is the holder, not a 409.
    expect((await claim(t.id, "worker")).status).toBe(200);
    expect(stored(t.id).assigneeAgentId).toBe(worker.id);
  });

  it("a killed holder's tasks do not pass to a new agent with its name", async () => {
    const { srv, sid, stored, create, claim, patch, listBy, kill } =
      await setup();
    const first = await spawnAgent(srv, "Worker");
    const held = await create("held by the first Worker");
    expect((await claim(held.id, "Worker")).status).toBe(200);
    expect(stored(held.id).assigneeAgentId).toBe(first.id);
    await kill(first.id);

    // Dead id, no live namesake: the name filter still finds the task by its
    // string, and a claim by that name is refused as held by a killed agent.
    expect(idsOf(await listBy("Worker")).has(held.id)).toBe(true);
    const noNamesake = await claim(held.id, "Worker");
    expect(noNamesake.status).toBe(409);
    expect(heldErr(noNamesake)).toMatchObject({
      code: "task_held",
      assignee: "Worker",
      assigneeAgentId: first.id,
      killed: true,
    });

    // A task the name claims while no agent has it carries no id: a legacy-
    // shaped row, matched by string as before.
    const legacy = await create("claimed while no Worker lived");
    expect((await claim(legacy.id, "Worker")).status).toBe(200);
    expect(stored(legacy.id)).not.toHaveProperty("assigneeAgentId");

    const second = await spawnAgent(srv, "Worker");
    expect(second.id).not.toBe(first.id);
    const fresh = await create("held by the second Worker");
    expect((await claim(fresh.id, "Worker")).status).toBe(200);
    expect(stored(fresh.id).assigneeAgentId).toBe(second.id);

    // Dead id, live namesake: the claim is refused and names the dead holder.
    const namesake = await claim(held.id, "Worker");
    expect(namesake.status).toBe(409);
    expect(heldErr(namesake)).toMatchObject({
      code: "task_held",
      assigneeAgentId: first.id,
      killed: true,
    });
    expect(stored(held.id)).toMatchObject({
      assignee: "Worker",
      assigneeAgentId: first.id,
    });
    // A live holder's 409 says it is not killed.
    const live = await claim(fresh.id, "Helper");
    expect(live.status).toBe(409);
    expect(heldErr(live)).toMatchObject({
      assigneeAgentId: second.id,
      killed: false,
    });

    // The namesake's filter lists its own task and the string-only row, never
    // the dead agent's task.
    const mine = idsOf(await listBy("Worker"));
    expect(mine.has(fresh.id)).toBe(true);
    expect(mine.has(legacy.id)).toBe(true);
    expect(mine.has(held.id)).toBe(false);

    // A legacy row keeps today's string rule: the namesake may claim it.
    expect((await claim(legacy.id, "Worker")).status).toBe(200);

    // A title-only edit and an echo of the stored name keep the dead id; the
    // echo must not re-resolve to the live namesake.
    expect((await patch(held.id, { title: "renamed task" })).status).toBe(200);
    expect(stored(held.id).assigneeAgentId).toBe(first.id);
    expect((await patch(held.id, { assignee: "Worker" })).status).toBe(200);
    expect(stored(held.id).assigneeAgentId).toBe(first.id);

    // Delete and restore keep the dead id: no re-resolve on restore.
    expect(
      (
        await api(srv, `/api/tasks/${held.id}`, {
          method: "DELETE",
          rawSessionId: sid,
        })
      ).status,
    ).toBe(204);
    const restored = await api(srv, `/api/tasks/${held.id}/restore`, {
      method: "POST",
      rawSessionId: sid,
    });
    expect(restored.status).toBe(201);
    expect(stored(held.id).assigneeAgentId).toBe(first.id);

    // The namesake takes over with a clear and then a set.
    expect((await patch(held.id, { assignee: null })).status).toBe(200);
    expect((await patch(held.id, { assignee: "Worker" })).status).toBe(200);
    expect(stored(held.id).assigneeAgentId).toBe(second.id);
    expect((await claim(held.id, "Worker")).status).toBe(200);
  });

  it("a rename moves the agent's open and closed tasks to the new name, and nothing else", async () => {
    const { srv, sid, stored, create, claim, kill } = await setup();
    const dead = await spawnAgent(srv, "Worker");
    const deadTask = await create("dead Worker's task");
    await claim(deadTask.id, "Worker");
    await kill(dead.id);
    const legacy = await create("string-only Worker row");
    await claim(legacy.id, "Worker");

    const worker = await spawnAgent(srv, "Worker");
    const open = await create("open");
    const closed = await create("closed");
    for (const t of [open, closed]) await claim(t.id, "Worker");
    await api(srv, `/api/tasks/${closed.id}/done`, {
      method: "POST",
      rawSessionId: sid,
      body: {},
    });
    const closedVersion = stored(closed.id).version;

    const res = await api(srv, `/api/agents/${worker.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { name: "Builder" },
    });
    expect(res.status).toBe(200);
    expect(srv.agentManager.getAgent(worker.id)?.name).toBe("Builder");

    for (const t of [open, closed]) {
      expect(stored(t.id)).toMatchObject({
        assignee: "Builder",
        assigneeAgentId: worker.id,
      });
    }
    // The write bumps the version like any task write.
    expect(stored(closed.id).version).not.toBe(closedVersion);
    expect(stored(closed.id).status).toBe("done");
    // Neither the dead agent's task nor the string-only row moves.
    expect(stored(deadTask.id).assignee).toBe("Worker");
    expect(stored(legacy.id).assignee).toBe("Worker");
    // createdBy stays as written.
    expect(stored(open.id).createdBy).toBe("Morgan");
  });

  it("a rename that rolls back leaves the tasks on the old name", async () => {
    const { srv, sid, stored, create, claim } = await setup();
    const worker = await spawnAgent(srv, "Worker");
    const t = await create("held");
    await claim(t.id, "Worker");
    // A session-bearing Claude agent must move its .jsonl on a cwd change; no
    // file exists for the fake session id, so the edit fails and rolls back
    // (the fault seam of routes-agents-rest.test.ts, "failed cwd+instructions
    // edit rolls back ...").
    const enq = srv.agentManager.enqueueMessage(worker.id, {
      sender: { kind: "user", username: "tester" },
      text: "wake",
    });
    expect(enq.ok).toBe(true);
    await waitUntil(
      () => srv.agentManager.getCurrentSessionId(worker.id) !== null,
      2000,
      "sessionId",
    );
    const versionBefore = stored(t.id).version;
    const res = await api(srv, `/api/agents/${worker.id}`, {
      method: "PATCH",
      rawSessionId: sid,
      body: { name: "Builder", cwd: "/tmp" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "edit_failed",
    );
    expect(srv.agentManager.getAgent(worker.id)?.name).toBe("Worker");
    expect(stored(t.id).assignee).toBe("Worker");
    expect(stored(t.id).version).toBe(versionBefore);
  });
});
