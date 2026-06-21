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
import { getUserByName } from "../users.ts";
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
