// Phase 1.4(b) — Cronjob HTTP read-surface + run-affordance route characterization.
//
// Freezes the OBSERVABLE contract of the `/cronjobs*` HTTP surface before
// Phase 3 strangles it onto the typed REST route table (opIds cron.list/get/
// listRuns/getRun, and the RUN-authed cron.runReadFile/runDiff). Mutations
// (add/update/delete/run-now) are WebSocket commands today and are NOT part of
// this HTTP surface — the read routes plus the two in-flight run affordances
// are everything the HTTP layer exposes.
//
// Run-affordance depth is DISPATCH-ONLY by design: emitCronjobRunReadFile /
// emitCronjobRunDiff resolve the target from `activeRuns.get(runId)`, which is
// populated only for a live, in-flight run. A persisted-but-not-running run is
// absent from that map, so the current before-picture for a seeded run is the
// "active run not found" 404. We freeze that error passthrough rather than
// manufacture a live backend run (that is adapter/live-tier territory). NOTE:
// the live-run SUCCESS path (a file-view / diff card emitted into an in-flight
// run's transcript) is intentionally NOT frozen here — it needs a real backend
// run and belongs to the live tier; only the dispatch + 404/400 contract is.
//
// Loopback-trusted: /cronjobs is in isAgentApiPath, so the harness (127.0.0.1)
// reaches it with no cookie. Seam: startTestServer().http() +
// srv.cronjobManager.addCronjob() to seed metadata. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { saveRuns, appendRunLog } from "../cronjob-persistence.ts";
import type { Cronjob, CronjobRun, LogEntry } from "../../shared/types.ts";

// AddCronjobInput is a factory-local interface; derive it from the method.
type AddCronjobInput = Parameters<
  TestServer["cronjobManager"]["addCronjob"]
>[0];

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function boot(): Promise<TestServer> {
  server = await startTestServer();
  return server;
}

function seedJob(srv: TestServer, name: string): Cronjob {
  const input: AddCronjobInput = {
    name,
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username: "Nil",
  };
  return srv.cronjobManager.addCronjob(input);
}

// Seed a COMPLETED persisted run + a one-entry transcript on disk (no live
// backend), so the GET .../runs/:runId read route can be exercised. The manager
// reads runs via loadRuns() and the transcript via loadRunLogWithAncestors()
// from the same CRONJOBS_DIR these production persistence fns write to.
function seedRun(srv: TestServer, job: Cronjob, runId: string): CronjobRun {
  const run: CronjobRun = {
    id: runId,
    cronjobId: job.id,
    cronjobName: job.name,
    trigger: "scheduled",
    status: "completed",
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    errorReason: null,
    promptSnapshot: job.prompt,
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    rootSessionId: "rsess-1",
    currentSessionId: "rsess-1",
    previewText: "All done.",
  };
  saveRuns(job.id, [run]);
  const entry: LogEntry = {
    id: "entry-1",
    agentId: runId,
    timestamp: 1700000030000,
    kind: "text",
    content: "summary line",
  };
  appendRunLog(job.id, runId, "rsess-1", entry);
  return run;
}

interface HttpResult {
  status: number;
  cors: string | null;
  body: unknown;
}

async function cronHttp(
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

describe("routes/cronjobs: read surface (Phase 1.4b)", () => {
  it("GET /cronjobs is [] for an empty office", async () => {
    const srv = await boot();
    const r = await cronHttp(srv, "/cronjobs");
    expect(r.status).toBe(200);
    expect(r.cors).toBe("*");
    expect(r.body).toEqual([]);
  });

  it("GET /cronjobs lists seeded jobs", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const r = await cronHttp(srv, "/cronjobs");
    expect(r.status).toBe(200);
    const ids = (r.body as Cronjob[]).map((c) => c.id);
    expect(ids).toContain(job.id);
  });

  it("GET /cronjobs/:id returns one; unknown -> 404 not found", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const hit = await cronHttp(srv, `/cronjobs/${job.id}`);
    expect(hit.status).toBe(200);
    expect((hit.body as Cronjob).id).toBe(job.id);
    expect((hit.body as Cronjob).name).toBe("Nightly");
    const miss = await cronHttp(srv, "/cronjobs/nope");
    expect(miss.status).toBe(404);
    expect((miss.body as { error: string }).error).toBe("not found");
  });

  it("GET /cronjobs/:id/runs is [] before any run fires", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const r = await cronHttp(srv, `/cronjobs/${job.id}/runs`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("GET /cronjobs/:id/runs/:runId for an unknown run -> 404 not found", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const r = await cronHttp(srv, `/cronjobs/${job.id}/runs/ghostrun`);
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("not found");
  });

  it("GET /cronjobs/:id/runs/:runId for a seeded run -> 200 { run, entries }", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const run = seedRun(srv, job, "run00001");
    // The run also shows up in the runs list (the non-empty list path).
    const list = await cronHttp(srv, `/cronjobs/${job.id}/runs`);
    expect((list.body as CronjobRun[]).map((r) => r.id)).toEqual([run.id]);
    // The detail route returns the run plus its transcript entries.
    const r = await cronHttp(srv, `/cronjobs/${job.id}/runs/${run.id}`);
    expect(r.status).toBe(200);
    expect(r.cors).toBe("*");
    const body = r.body as { run: CronjobRun; entries: LogEntry[] };
    expect(body.run.id).toBe(run.id);
    expect(body.run.status).toBe("completed");
    expect(body.entries.map((e) => e.content)).toEqual(["summary line"]);
  });
});

describe("routes/cronjobs: method + CORS walls (Phase 1.4b)", () => {
  it("OPTIONS preflight advertises GET,OPTIONS (POST dropped — loopback affordances removed)", async () => {
    const srv = await boot();
    const res = await srv.http("/cronjobs", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
  });

  it("a non-GET, non-affordance method -> 405 method not allowed", async () => {
    const srv = await boot();
    const r = await cronHttp(srv, "/cronjobs", { method: "PUT" });
    expect(r.status).toBe(405);
    expect(r.cors).toBe("*");
    expect((r.body as { error: string }).error).toBe("method not allowed");
  });
});

describe("routes/cronjobs: legacy in-flight run affordances removed (loopback-bypass removal)", () => {
  // The legacy loopback cron-run affordances (POST /cronjobs/:id/runs/:runId/
  // {read-file,diff}) were deleted; in-flight runs use the token-required /api
  // surface now (covered in routes-cronjobs-runs.test.ts). /cronjobs stays
  // loopback-trusted for GET this milestone, so a POST here is no longer the old
  // 400/404 dispatch — it falls through to the existing method gate (405), not a
  // 401. The old "missing path -> 400" / "no live run -> 404" dispatch behavior
  // is gone with the handler.
  it("POST .../runs/:runId/read-file -> 405 method not allowed (handler deleted)", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const r = await cronHttp(srv, `/cronjobs/${job.id}/runs/r1/read-file`, {
      method: "POST",
      body: { path: "/etc/hostname" },
    });
    expect(r.status).toBe(405);
    expect((r.body as { error: string }).error).toBe("method not allowed");
  });

  it("POST .../runs/:runId/diff -> 405 method not allowed (handler deleted)", async () => {
    const srv = await boot();
    const job = seedJob(srv, "Nightly");
    const r = await cronHttp(srv, `/cronjobs/${job.id}/runs/r1/diff`, {
      method: "POST",
      body: {},
    });
    expect(r.status).toBe(405);
    expect((r.body as { error: string }).error).toBe("method not allowed");
  });
});
