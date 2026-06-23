// Phase 3a slice 2 — Cronjobs on the unified REST surface (opIds cron.*).
//
// TDD'd against the typed route table: cronjob metadata + runs reads/CRUD on the
// /api surface, with the [behavior-change] authz tightenings ENFORCED by the
// REST route guards (the legacy WS command arms + their shims were retired in
// 3d.4). Attribution (createdBy/username/userId) is
// token-derived. The legacy /cronjobs HTTP reads stay loopback-trusted +
// byte-identical (frozen in routes-cronjobs.test.ts).
//
// The cron-run transcript `log_entry` compatibility bridge + RUN-bearer run
// affordances are covered in routes-cronjobs-runs.test.ts (slice 2b).
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName } from "../users.ts";
import type { Cronjob } from "../../shared/types.ts";

// AddCronjobInput is a factory-local interface; derive it from the method.
type AddCronjobInput = Parameters<
  TestServer["cronjobManager"]["addCronjob"]
>[0];

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
  init: { method?: string; body?: unknown; rawSessionId?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
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

function createBody(
  over: Partial<AddCronjobInput> = {},
): Record<string, unknown> {
  return {
    name: "Nightly",
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: server!.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    ...over,
  };
}

function seedJob(srv: TestServer, username: string, name = "Seed"): Cronjob {
  return srv.cronjobManager.addCronjob({
    name,
    schedule: { type: "interval", minutes: 60 },
    prompt: "p",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
  });
}

describe("routes/cron REST: reads", () => {
  it("GET /api/cronjobs lists; /api/cronjobs/:id gets; legacy /cronjobs still loopback-200", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss", "Reporter");

    const list = await api(srv, "/api/cronjobs", {
      rawSessionId: owner.rawSessionId,
    });
    expect(list.status).toBe(200);
    expect((list.body as Cronjob[]).some((c) => c.id === job.id)).toBe(true);

    const get = await api(srv, `/api/cronjobs/${job.id}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(get.status).toBe(200);
    expect((get.body as Cronjob).name).toBe("Reporter");

    expect(
      (
        await api(srv, `/api/cronjobs/nope`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(404);

    // Legacy loopback read surface untouched.
    expect((await api(srv, "/cronjobs")).status).toBe(200);
  });

  it("run reads: listRuns/listAllRuns shapes; getRun unknown -> 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");

    const runs = await api(srv, `/api/cronjobs/${job.id}/runs`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(runs.status).toBe(200);
    expect((runs.body as { runs: unknown[] }).runs).toEqual([]);

    const all = await api(srv, `/api/cron-runs`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(all.status).toBe(200);
    expect(Array.isArray((all.body as { jobs: unknown[] }).jobs)).toBe(true);

    const run = await api(srv, `/api/cronjobs/${job.id}/runs/missing`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(run.status).toBe(404);
  });
});

describe("routes/cron REST: create + attribution", () => {
  it("POST /api/cronjobs -> 201 with token-derived createdBy/username/userId", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: createBody({ name: "Nightly" }),
    });
    expect(r.status).toBe(201);
    const job = r.body as Cronjob;
    expect(job.name).toBe("Nightly");
    expect(job.createdBy).toBe("Boss");
    expect(job.username).toBe("Boss");
    expect(job.userId).toBe(getUserByName("Boss")!.id);
  });

  it("POST /api/cronjobs missing required fields -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { name: "x" },
    });
    expect(r.status).toBe(400);
  });
});

describe("routes/cron REST: ownership tightening", () => {
  it("a member cannot update/delete/run another user's cronjob via REST (403) but can manage their own", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory");
    const ownersJob = seedJob(srv, "Boss", "OwnersJob");

    // Member -> owner's job: all blocked.
    expect(
      (
        await api(srv, `/api/cronjobs/${ownersJob.id}`, {
          method: "PATCH",
          rawSessionId: member.rawSessionId,
          body: { name: "HACKED" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, `/api/cronjobs/${ownersJob.id}`, {
          method: "DELETE",
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, `/api/cronjobs/${ownersJob.id}/runs`, {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body: {},
        })
      ).status,
    ).toBe(403);
    // The owner's job is untouched.
    expect(
      srv.cronjobManager.listCronjobs().find((c) => c.id === ownersJob.id)
        ?.name,
    ).toBe("OwnersJob");

    // Member CAN create + manage their own.
    const own = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: createBody({ name: "Mine" }),
    });
    expect(own.status).toBe(201);
    const ownId = (own.body as Cronjob).id;
    expect(
      (
        await api(srv, `/api/cronjobs/${ownId}`, {
          method: "PATCH",
          rawSessionId: member.rawSessionId,
          body: { name: "MineRenamed" },
        })
      ).status,
    ).toBe(200);

    // Owner can manage anyone's.
    expect(
      (
        await api(srv, `/api/cronjobs/${ownId}`, {
          method: "DELETE",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(204);
  });

  it("cron-prompt is office-owner-only (REST)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory");

    expect(
      (
        await api(srv, "/api/cron-prompt", {
          method: "PUT",
          rawSessionId: member.rawSessionId,
          body: { value: "members can't" },
        })
      ).status,
    ).toBe(403);

    // The denied PUT left the prompt unchanged.
    expect(srv.cronjobManager.getCronjobsPrompt()).toBe(null);

    expect(
      (
        await api(srv, "/api/cron-prompt", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { value: "owner can" },
        })
      ).status,
    ).toBe(204);
    expect(srv.cronjobManager.getCronjobsPrompt()).toBe("owner can");
  });
});

describe("routes/cron REST: runNow + emit double-signal", () => {
  it("owner POST /api/cronjobs/:id/runs -> 200 {runId}", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");
    const r = await api(srv, `/api/cronjobs/${job.id}/runs`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(typeof (r.body as { runId?: string }).runId).toBe("string");
  });

  it("a REST cron.create fans out cronjob_added through the emit() helper", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const created = (
      await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: createBody({ name: "Fanned" }),
      })
    ).body as Cronjob;
    await waitUntil(
      () =>
        sock.messages.some(
          (m) =>
            (m as { type?: string }).type === "cronjob_added" &&
            (m as { cronjob?: Cronjob }).cronjob?.id === created.id,
        ),
      2000,
      "cronjob_added for the new job",
    );
  });
});
