// Phase 1.4(b) — Task HTTP board route characterization.
//
// Freezes the OBSERVABLE contract of the `/tasks*` HTTP surface before Phase 3
// strangles it onto the typed REST route table (opIds tasks.{list,get,create,
// update,claim,done,delete}). The boundary is the HTTP response: status code,
// JSON body shape, and CORS headers, with the persisted task list
// (agentManager.getTasks() + STATE_ROOT/tasks.json) as confirmation only.
//
// Current posture frozen here (the bits Phase 3 deliberately changes later):
//   - Attribution is BODY-TRUST: createdBy + username come from the request
//     body, not a token. The route table marks tasks.create [behavior-change]
//     "createdBy/username from token, not body" — this test pins the BEFORE.
//   - DELETE is blocked at the HTTP layer (405). The route table unifies it
//     under tasks.delete later; we freeze the 405 wall as-is.
//   - The OPTIONS preflight advertises DELETE even though DELETE 405s — a
//     current mismatch, frozen intentionally.
//
// Loopback-trusted: /tasks is in isAgentApiPath, so the harness (127.0.0.1)
// reaches it with no cookie. Auth posture itself is frozen in routes-auth.
//
// Seam: startTestServer().http(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import type { TaskItem } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function boot(): Promise<TestServer> {
  server = await startTestServer();
  return server;
}

interface HttpResult {
  status: number;
  cors: string | null;
  body: unknown;
}

async function taskHttp(
  srv: TestServer,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<HttpResult> {
  const res = await srv.http(path, {
    method: init?.method ?? "GET",
    headers:
      init?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const cors = res.headers.get("access-control-allow-origin");
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, cors, body };
}

// Read the persisted task list straight off disk (the shape Phase 3 must keep).
function tasksOnDisk(srv: TestServer): TaskItem[] {
  const file = join(srv.stateRoot, "tasks.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8")) as TaskItem[];
}

describe("routes/tasks: create (Phase 1.4b)", () => {
  it("POST /tasks creates -> 201 with the persisted task shape", async () => {
    const srv = await boot();
    const r = await taskHttp(srv, "/tasks", {
      method: "POST",
      body: { title: "Wire the strangler", createdBy: "Isomuxer1" },
    });
    expect(r.status).toBe(201);
    expect(r.cors).toBe("*");
    const t = r.body as TaskItem;
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.title).toBe("Wire the strangler");
    expect(t.createdBy).toBe("Isomuxer1");
    expect(t.status).toBe("open"); // new tasks default to open
    expect(typeof t.createdAt).toBe("number");
    // Persistence confirmation: in-memory list AND on-disk file both carry it.
    expect(srv.agentManager.getTasks().some((x) => x.id === t.id)).toBe(true);
    expect(tasksOnDisk(srv).some((x) => x.id === t.id)).toBe(true);
  });

  it("POST /tasks honors optional fields + BODY-TRUST username (frozen before-picture)", async () => {
    const srv = await boot();
    const r = await taskHttp(srv, "/tasks", {
      method: "POST",
      body: {
        title: "Filed on behalf",
        createdBy: "Isomuxer1",
        description: "desc",
        priority: "P1",
        assignee: "Reviewer1",
        username: "Nil",
      },
    });
    expect(r.status).toBe(201);
    const t = r.body as TaskItem;
    expect(t.description).toBe("desc");
    expect(t.priority).toBe("P1");
    expect(t.assignee).toBe("Reviewer1");
    // username is taken from the body verbatim today (no token derivation).
    expect(t.username).toBe("Nil");
  });

  it("POST /tasks requires title + createdBy -> 400", async () => {
    const srv = await boot();
    const noTitle = await taskHttp(srv, "/tasks", {
      method: "POST",
      body: { createdBy: "Isomuxer1" },
    });
    expect(noTitle.status).toBe(400);
    expect((noTitle.body as { error: string }).error).toBe(
      "title and createdBy required",
    );
    const noCreatedBy = await taskHttp(srv, "/tasks", {
      method: "POST",
      body: { title: "orphan" },
    });
    expect(noCreatedBy.status).toBe(400);
  });

  it("POST /tasks rejects invalid priority -> 400", async () => {
    const srv = await boot();
    const r = await taskHttp(srv, "/tasks", {
      method: "POST",
      body: { title: "t", createdBy: "c", priority: "P9" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe(
      "invalid priority, must be P0-P3",
    );
  });

  it("POST /tasks rejects invalid JSON -> 400", async () => {
    const srv = await boot();
    const res = await srv.http("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid JSON");
  });
});

describe("routes/tasks: list + filters (Phase 1.4b)", () => {
  async function seedBoard(srv: TestServer) {
    await taskHttp(srv, "/tasks", {
      method: "POST",
      body: { title: "alpha open", createdBy: "c", assignee: "ann" },
    });
    const inprog = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "beta running", createdBy: "c", assignee: "bob" },
      })
    ).body as TaskItem;
    await taskHttp(srv, `/tasks/${inprog.id}`, {
      method: "PATCH",
      body: { status: "in_progress" },
    });
    const done = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "gamma finished", createdBy: "c" },
      })
    ).body as TaskItem;
    await taskHttp(srv, `/tasks/${done.id}/done`, { method: "POST", body: {} });
    const backlog = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "delta later", createdBy: "c" },
      })
    ).body as TaskItem;
    await taskHttp(srv, `/tasks/${backlog.id}`, {
      method: "PATCH",
      body: { status: "backlog" },
    });
  }

  it("GET /tasks default-excludes done + backlog", async () => {
    const srv = await boot();
    await seedBoard(srv);
    const r = await taskHttp(srv, "/tasks");
    expect(r.status).toBe(200);
    expect(r.cors).toBe("*");
    const titles = (r.body as TaskItem[]).map((t) => t.title).sort();
    expect(titles).toEqual(["alpha open", "beta running"]);
  });

  it("GET /tasks?status=all returns everything", async () => {
    const srv = await boot();
    await seedBoard(srv);
    const r = await taskHttp(srv, "/tasks?status=all");
    expect((r.body as TaskItem[]).length).toBe(4);
  });

  it("GET /tasks?status=<status> filters to that status", async () => {
    const srv = await boot();
    await seedBoard(srv);
    const r = await taskHttp(srv, "/tasks?status=backlog");
    const titles = (r.body as TaskItem[]).map((t) => t.title);
    expect(titles).toEqual(["delta later"]);
  });

  it("GET /tasks?assignee= filters", async () => {
    const srv = await boot();
    await seedBoard(srv);
    const r = await taskHttp(srv, "/tasks?assignee=ann");
    const titles = (r.body as TaskItem[]).map((t) => t.title);
    expect(titles).toEqual(["alpha open"]);
  });

  it("GET /tasks?title= is a case-insensitive substring match", async () => {
    const srv = await boot();
    await seedBoard(srv);
    const r = await taskHttp(srv, "/tasks?title=RUNN");
    const titles = (r.body as TaskItem[]).map((t) => t.title);
    expect(titles).toEqual(["beta running"]);
  });

  it("GET /tasks/:id returns one; unknown -> 404 not found", async () => {
    const srv = await boot();
    const created = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "findme", createdBy: "c" },
      })
    ).body as TaskItem;
    const hit = await taskHttp(srv, `/tasks/${created.id}`);
    expect(hit.status).toBe(200);
    expect((hit.body as TaskItem).title).toBe("findme");
    const miss = await taskHttp(srv, "/tasks/deadbeef");
    expect(miss.status).toBe(404);
    expect((miss.body as { error: string }).error).toBe("not found");
  });
});

describe("routes/tasks: update / claim / done (Phase 1.4b)", () => {
  async function makeTask(srv: TestServer, title = "task"): Promise<TaskItem> {
    return (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title, createdBy: "c" },
      })
    ).body as TaskItem;
  }

  it("PATCH validates status + priority, applies changes, 404 on unknown", async () => {
    const srv = await boot();
    const t = await makeTask(srv);
    const badStatus = await taskHttp(srv, `/tasks/${t.id}`, {
      method: "PATCH",
      body: { status: "nope" },
    });
    expect(badStatus.status).toBe(400);
    expect((badStatus.body as { error: string }).error).toBe(
      "invalid status, must be open|in_progress|backlog|done",
    );
    const badPrio = await taskHttp(srv, `/tasks/${t.id}`, {
      method: "PATCH",
      body: { priority: "P7" },
    });
    expect(badPrio.status).toBe(400);
    const ok = await taskHttp(srv, `/tasks/${t.id}`, {
      method: "PATCH",
      body: { title: "renamed", status: "in_progress", priority: "P0" },
    });
    expect(ok.status).toBe(200);
    const t2 = ok.body as TaskItem;
    expect(t2.title).toBe("renamed");
    expect(t2.status).toBe("in_progress");
    expect(t2.priority).toBe("P0");
    const miss = await taskHttp(srv, "/tasks/deadbeef", {
      method: "PATCH",
      body: { status: "open" },
    });
    expect(miss.status).toBe(404);
  });

  it("PATCH clears description via non-string and priority via null; '' is still rejected", async () => {
    const srv = await boot();
    const t = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "t", createdBy: "c", description: "d", priority: "P2" },
      })
    ).body as TaskItem;
    // description has no validator: a provided non-string value clears it to
    // undefined (only a string survives).
    const cleared = await taskHttp(srv, `/tasks/${t.id}`, {
      method: "PATCH",
      body: { description: null },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body as TaskItem).description).toBeUndefined();
    // priority IS validated, so only an explicit null clears it (task
    // dc642af2); "" stays a malformed level, like "P9".
    for (const bad of ["", "P9"]) {
      const r = await taskHttp(srv, `/tasks/${t.id}`, {
        method: "PATCH",
        body: { priority: bad },
      });
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe(
        "invalid priority, must be P0-P3 or null to clear",
      );
    }
    // priority survived the rejected writes.
    expect(
      srv.agentManager.getTasks().find((x) => x.id === t.id)?.priority,
    ).toBe("P2");

    const unset = await taskHttp(srv, `/tasks/${t.id}`, {
      method: "PATCH",
      body: { priority: null },
    });
    expect(unset.status).toBe(200);
    expect((unset.body as TaskItem).priority).toBeUndefined();
    const stored = srv.agentManager.getTasks().find((x) => x.id === t.id);
    expect(stored && "priority" in stored).toBe(false);
  });

  it("POST /tasks/:id/claim sets in_progress + assignee from body; 404 on unknown", async () => {
    const srv = await boot();
    const t = await makeTask(srv);
    const r = await taskHttp(srv, `/tasks/${t.id}/claim`, {
      method: "POST",
      body: { assignee: "Isomuxer1" },
    });
    expect(r.status).toBe(200);
    const t2 = r.body as TaskItem;
    expect(t2.status).toBe("in_progress");
    expect(t2.assignee).toBe("Isomuxer1");
    const miss = await taskHttp(srv, "/tasks/deadbeef/claim", {
      method: "POST",
      body: { assignee: "x" },
    });
    expect(miss.status).toBe(404);
  });

  it("POST /tasks/:id/done sets done; 404 on unknown", async () => {
    const srv = await boot();
    const t = await makeTask(srv);
    const r = await taskHttp(srv, `/tasks/${t.id}/done`, {
      method: "POST",
      body: {},
    });
    expect(r.status).toBe(200);
    expect((r.body as TaskItem).status).toBe("done");
    const miss = await taskHttp(srv, "/tasks/deadbeef/done", {
      method: "POST",
      body: {},
    });
    expect(miss.status).toBe(404);
  });
});

describe("routes/tasks: method + CORS walls (Phase 1.4b)", () => {
  it("DELETE /tasks/:id is blocked at the HTTP layer -> 405", async () => {
    const srv = await boot();
    const t = (
      await taskHttp(srv, "/tasks", {
        method: "POST",
        body: { title: "t", createdBy: "c" },
      })
    ).body as TaskItem;
    const r = await taskHttp(srv, `/tasks/${t.id}`, { method: "DELETE" });
    expect(r.status).toBe(405);
    expect((r.body as { error: string }).error).toBe(
      "DELETE not allowed via HTTP",
    );
    // The task is untouched.
    expect(srv.agentManager.getTasks().some((x) => x.id === t.id)).toBe(true);
  });

  it("OPTIONS preflight advertises GET,POST,PATCH,DELETE,OPTIONS (DELETE still 405s)", async () => {
    const srv = await boot();
    const res = await srv.http("/tasks", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Frozen mismatch: preflight lists DELETE though the route returns 405.
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
  });
});
