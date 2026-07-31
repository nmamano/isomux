// Phase 3a slice 2b — cron run-messages + RUN-bearer run affordances on the
// unified REST surface (opIds cron.runMessage / editRunMessage / runReadFile /
// runDiff).
//
// What this freezes:
//   - RUN-bearer affordances (`self:affordance` + runParamMustEqualTokenRun):
//     a firing run's in-flight read-file/diff authenticates as the RUN token
//     (ISOMUX_AGENT_TOKEN, minted in fire()), surfaces a card into the LIVE run
//     transcript, and that card arrives on the wire as the intentionally-weird
//     compatibility bridge: `type:"log_entry"` with `entry.agentId ===
//     cronrun-<runId>` (NOT the target `cron_run_log_entry`, which waits for the
//     UI/demo-coordinated wire switch). This is Reviewer1's PINNED bridge test.
//   - The legacy loopback affordance path (`/cronjobs/:id/runs/:runId/read-file`,
//     no `/api`, no token) is now REJECTED: the loopback-bypass removal deleted
//     the legacy cron-run POST handlers, and the legacy-routes retirement took
//     the whole /cronjobs prefix with it, so a no-token POST 401s at the cookie
//     wall and writes nothing to the transcript.
//   - run-message ownership tightening: REST via the route guard
//     (cronjobOwnerOrOfficeOwner). The legacy WS run-message arms were retired in
//     3d.3 and the shared wsCanMutateCronjob shim in 3d.4.
//   - The boundary messageId is threaded into the manager so the response ack
//     equals the eventual persisted user_message id (handler-boundary unit test;
//     the full resume e2e needs an on-disk session file FakeBackend doesn't write,
//     so it is targeted at the handler option-path per Reviewer1's fallback).
//
// Seam: startTestServer() + a non-completing FakeBackend for the live-run path.
// Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { getRunTokenRaw, mintRunToken } from "../identity/tokens.ts";
import { cronjobRunStreamId } from "../../shared/types.ts";
import type { Cronjob, CronjobRun, LogEntry } from "../../shared/types.ts";
import { cronHandlers, type CronDeps } from "../routes/handlers/cron.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
import type { Identity } from "../identity/index.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  // The #11 bridge test overrides the process-global office env-file provider
  // to inject a temp CLAUDE_CONFIG_DIR. Reset it so it can't outlive this file
  // pointing at a now-deleted temp STATE_ROOT path (mirrors fork-usage.test.ts).
  setOfficeEnvFileProvider(() => null);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "cond",
): Promise<void> {
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
async function httpJson(
  srv: TestServer,
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await srv.http(path, {
    method: opts.method ?? "GET",
    headers,
    rawSessionId: opts.rawSessionId,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
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

function countLog(
  sock: TestSocket,
  agentId: string,
  kind: LogEntry["kind"],
  contains?: string,
): number {
  return sock.messages.filter((m) => {
    const msg = m as { type?: string; entry?: LogEntry };
    return (
      msg.type === "log_entry" &&
      msg.entry?.agentId === agentId &&
      msg.entry?.kind === kind &&
      (contains === undefined || msg.entry.content.includes(contains))
    );
  }).length;
}

// Boot with a FakeBackend whose turn never completes, so the cron run stays
// ACTIVE (in activeRuns) and its RUN token stays live for the affordance calls.
// mintRunToken precedes activeRuns.set with no await between them, so a non-null
// getRunTokenRaw is a reliable "run is active" signal.
interface LiveRun {
  srv: TestServer;
  ownerSession: string;
  job: Cronjob;
  run: CronjobRun;
  token: string;
  streamId: string;
}
async function startLiveRun(name = "Boss"): Promise<LiveRun> {
  const fb = new FakeBackend({ session: { onSend: () => {} } });
  const srv = await startTestServer({ fakeBackend: fb });
  server = srv;
  const owner = await srv.seedOwner(name);
  const job = seedJob(srv, name);
  const run = srv.cronjobManager.runCronjobNow(job.id, name);
  if (!run) throw new Error("runCronjobNow returned null");
  await waitUntil(
    () => getRunTokenRaw(job.id, run.id) !== null,
    3000,
    "run token minted (run active)",
  );
  return {
    srv,
    ownerSession: owner.rawSessionId,
    job,
    run,
    token: getRunTokenRaw(job.id, run.id)!,
    streamId: cronjobRunStreamId(run.id),
  };
}

describe("routes/cron run-affordances: RUN bearer + the log_entry bridge", () => {
  it("PINNED: RUN-bearer read-file surfaces a file-view that arrives as type:log_entry, agentId cronrun-<runId>", async () => {
    const live = await startLiveRun();
    writeFileSync(join(live.srv.stateRoot, "report.txt"), "hello run");
    const sock = await live.srv.connectWs(live.ownerSession);

    const r = await httpJson(
      live.srv,
      `/api/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`,
      { method: "POST", bearer: live.token, body: { path: "report.txt" } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { ok?: boolean }).ok).toBe(true);

    await waitUntil(
      () => countLog(sock, live.streamId, "file-view") >= 1,
      2000,
      "file-view log_entry on the cronrun stream",
    );
  });

  it("PINNED: RUN-bearer diff (non-repo cwd) reaches the cronrun stream as a system log_entry", async () => {
    const live = await startLiveRun();
    const sock = await live.srv.connectWs(live.ownerSession);

    const r = await httpJson(
      live.srv,
      `/api/cronjobs/${live.job.id}/runs/${live.run.id}/diff`,
      { method: "POST", bearer: live.token, body: {} },
    );
    expect(r.status).toBe(200);
    expect((r.body as { ok?: boolean }).ok).toBe(true);

    await waitUntil(
      () =>
        countLog(sock, live.streamId, "system", "not a git repository") >= 1,
      2000,
      "diff non-repo system entry on the cronrun stream",
    );
  });

  it("read-file missing path -> 400 before any transcript write", async () => {
    const live = await startLiveRun();
    const r = await httpJson(
      live.srv,
      `/api/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`,
      { method: "POST", bearer: live.token, body: {} },
    );
    expect(r.status).toBe(400);
  });

  it("idempotency: same Idempotency-Key replays read-file without a second transcript entry", async () => {
    const live = await startLiveRun();
    writeFileSync(join(live.srv.stateRoot, "idem.txt"), "x");
    const sock = await live.srv.connectWs(live.ownerSession);
    const path = `/api/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`;

    const first = await httpJson(live.srv, path, {
      method: "POST",
      bearer: live.token,
      idempotencyKey: "k-1",
      body: { path: "idem.txt" },
    });
    expect(first.status).toBe(200);
    await waitUntil(
      () => countLog(sock, live.streamId, "file-view") >= 1,
      2000,
      "first file-view entry",
    );

    const replay = await httpJson(live.srv, path, {
      method: "POST",
      bearer: live.token,
      idempotencyKey: "k-1",
      body: { path: "idem.txt" },
    });
    expect(replay.status).toBe(200);

    // ping/pong barrier: any (erroneous) second broadcast was ws.send'd during
    // the replay POST, before this ping — ordered delivery means pong implies it
    // already arrived. A replay must NOT re-run the handler, so the count stays 1.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, live.streamId, "file-view")).toBe(1);
  });

  it("legacy loopback affordance path (no /api, no token) is rejected — 401 at the cookie wall, not the transcript", async () => {
    const live = await startLiveRun();
    writeFileSync(join(live.srv.stateRoot, "legacy.txt"), "y");
    const sock = await live.srv.connectWs(live.ownerSession);
    const res = await live.srv.http(
      `/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "legacy.txt" }),
      },
    );
    // The legacy loopback cron-run affordances were deleted, and the whole
    // /cronjobs prefix is retired, so a no-token POST no longer reaches any
    // handler: it 401s at the cookie wall.
    expect(res.status).toBe(401);
    // Fail-closed: nothing reached the run transcript. ping/pong barrier — any
    // (erroneous) emit would have been ws.send'd before this ping arrives.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, live.streamId, "file-view")).toBe(0);
  });

  // Follow-up #11 bridge: proves the resume-token plumbing actually unblocks the
  // loopback flip — a RESUMED run's in-flight read-file authenticates to the
  // token-required /api route using the bearer buildRunSessionOptions injected
  // into the resumed run's env (not just the primary fire() token). Without #11
  // this 401s/403s because the resumed run carries no RUN token.
  it("PINNED (#11): a RESUMED run's injected RUN bearer authenticates read-file via /api", async () => {
    // Counter FakeBackend: the primary turn (send #1) completes so the run is
    // resumable; the resumed turn (send #2) stays live so its RUN token is
    // active for the affordance call.
    let sends = 0;
    const fb = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "primary done" });
        },
      },
    });
    const srv = await startTestServer({ fakeBackend: fb });
    server = srv;
    const owner = await srv.seedOwner("Boss");

    // Point CLAUDE_CONFIG_DIR at a temp tree via the office env-file provider (the
    // same hook production uses), so the claude resume precheck checks the temp
    // tree, never the real ~/.claude. Mirrors fork-usage.test.ts. The next
    // startTestServer boot re-registers the production provider, so no leak.
    const claudeHome = join(srv.stateRoot, "bridge-claude-home");
    const envFile = join(srv.stateRoot, "bridge-office.env");
    writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome}\n`);
    setOfficeEnvFileProvider(() => envFile);

    const job = seedJob(srv, "Boss");
    const run = srv.cronjobManager.runCronjobNow(job.id, "Boss");
    if (!run) throw new Error("runCronjobNow returned null");
    await waitUntil(
      () => srv.cronjobManager.findRun(job.id, run.id)?.status === "completed",
      3000,
      "primary run finalized (resumable)",
    );

    // Touch the existence-only leaf session file the resume precheck wants.
    const finalized = srv.cronjobManager.findRun(job.id, run.id)!;
    const leaf = finalized.currentSessionId ?? finalized.rootSessionId;
    const projDir = claudeProjectDir(srv.stateRoot, {
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${leaf}.jsonl`), "");

    // Resume: buildRunSessionOptions mints + injects a fresh RUN token; the run
    // goes active and the token is live.
    await srv.cronjobManager.sendRunMessage(
      job.id,
      run.id,
      "follow up",
      "Boss",
    );
    await waitUntil(
      () => getRunTokenRaw(job.id, run.id) !== null,
      3000,
      "resumed run active w/ token",
    );

    // The token the /api route accepts IS exactly the one injected into the
    // resumed run's backend env.
    const resumedToken = getRunTokenRaw(job.id, run.id)!;
    const resumed = fb.lastSession!;
    expect(resumed.isResume).toBe(true);
    expect(resumed.opts.env?.ISOMUX_AGENT_TOKEN).toBe(resumedToken);

    const sock = await srv.connectWs(owner.rawSessionId);
    writeFileSync(join(srv.stateRoot, "resumed.txt"), "hello resumed run");

    const r = await httpJson(
      srv,
      `/api/cronjobs/${job.id}/runs/${run.id}/read-file`,
      { method: "POST", bearer: resumedToken, body: { path: "resumed.txt" } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { ok?: boolean }).ok).toBe(true);

    await waitUntil(
      () => countLog(sock, cronjobRunStreamId(run.id), "file-view") >= 1,
      2000,
      "resumed-run file-view bridged to the cronrun stream",
    );
  });
});

describe("routes/cron run-affordances: RUN-bearer authz (no active run needed)", () => {
  it("a USER cookie cannot reach a RUN affordance (lacks self:affordance) -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");
    const r = await httpJson(
      srv,
      `/api/cronjobs/${job.id}/runs/anyrun/read-file`,
      { method: "POST", rawSessionId: owner.rawSessionId, body: { path: "x" } },
    );
    expect(r.status).toBe(403);
  });

  it("a RUN token bound to a DIFFERENT {job,run} -> 403 (runParamMustEqualTokenRun)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");
    const wrong = mintRunToken("other-job", "other-run", null);
    const r = await httpJson(
      srv,
      `/api/cronjobs/${job.id}/runs/some-run/read-file`,
      { method: "POST", bearer: wrong, body: { path: "x" } },
    );
    expect(r.status).toBe(403);
  });

  it("no identity (no cookie, no bearer) -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");
    const r = await httpJson(
      srv,
      `/api/cronjobs/${job.id}/runs/some-run/read-file`,
      { method: "POST", body: { path: "x" } },
    );
    expect(r.status).toBe(401);
  });
});

describe("routes/cron run-messages: ownership tightening (REST)", () => {
  it("REST: a member cannot message another user's run (403); 400 empty text; 404 unknown run", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory");
    const ownersJob = seedJob(srv, "Boss", "OwnersJob");

    // Member -> owner's job run-message: blocked by the route guard.
    expect(
      (
        await httpJson(srv, `/api/cronjobs/${ownersJob.id}/runs/r1/messages`, {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body: { text: "hijack" },
        })
      ).status,
    ).toBe(403);

    // Member -> owner's run-message EDIT (PATCH, :logEntryId): same route guard.
    expect(
      (
        await httpJson(
          srv,
          `/api/cronjobs/${ownersJob.id}/runs/r1/messages/e1`,
          {
            method: "PATCH",
            rawSessionId: member.rawSessionId,
            body: { newText: "hijack-edit" },
          },
        )
      ).status,
    ).toBe(403);

    // Owner, empty text -> 400 (before the run pre-flight).
    expect(
      (
        await httpJson(srv, `/api/cronjobs/${ownersJob.id}/runs/r1/messages`, {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { text: "" },
        })
      ).status,
    ).toBe(400);

    // Owner, unknown run -> cheap 404 pre-flight.
    expect(
      (
        await httpJson(
          srv,
          `/api/cronjobs/${ownersJob.id}/runs/nope/messages`,
          {
            method: "POST",
            rawSessionId: owner.rawSessionId,
            body: { text: "hi" },
          },
        )
      ).status,
    ).toBe(404);
  });
});

describe("routes/cron run-messages: ack idempotency", () => {
  it("same-key cron.runMessage replay returns the SAME {messageId} (handler not re-run)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const job = seedJob(srv, "Boss");
    const run = srv.cronjobManager.runCronjobNow(job.id, "Boss");
    if (!run) throw new Error("runCronjobNow returned null");
    // findRun is satisfied by the persisted run row; resumability is irrelevant
    // to the ack (runMessage is fire-and-forget). A same key + same body must
    // replay the cached response — the identical messageId, with no 2nd handler
    // run (so no regenerated id) — which is the direct proof the ack is stable.
    await waitUntil(
      () => srv.cronjobManager.findRun(job.id, run.id) !== null,
      2000,
      "run persisted",
    );
    const path = `/api/cronjobs/${job.id}/runs/${run.id}/messages`;
    const first = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      idempotencyKey: "msg-1",
      body: { text: "hello run" },
    });
    expect(first.status).toBe(200);
    const id1 = (first.body as { messageId?: string }).messageId;
    expect(typeof id1).toBe("string");

    const replay = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      idempotencyKey: "msg-1",
      body: { text: "hello run" },
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { messageId?: string }).messageId).toBe(id1);
  });
});

// The full resume e2e (a successful run-message that writes a user_message into
// the transcript) needs an on-disk Claude/Codex session file that FakeBackend
// doesn't write, so the happy path is targeted at the handler option-path per
// Reviewer1's fallback: prove the boundary messageId is generated, threaded into
// the manager op, AND returned — so the ack is a real correlation id, not a
// fictional one.
describe("routes/cron run-messages: messageId threading (handler boundary)", () => {
  const ownerIdentity: Identity = {
    scope: "user",
    userId: "u-owner",
    role: "owner",
    capabilities: [],
  };
  function unitCtx(
    body: unknown,
    params: Record<string, string>,
  ): RouteHandlerContext {
    return {
      identity: ownerIdentity,
      params,
      body,
      rawBody: JSON.stringify(body ?? {}),
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    };
  }
  function stubDeps(over: Partial<CronDeps>): CronDeps {
    const base: CronDeps = {
      listCronjobs: () => [],
      createCronjob: () => {
        throw new Error("unused");
      },
      updateCronjob: () => null,
      deleteCronjob: () => false,
      setPrompt: () => {},
      runNow: () => null,
      runsForCronjob: () => [],
      allRunsByJob: () => [],
      runTranscript: () => ({ run: null, entries: [] }),
      findRun: () => null,
      sendRunMessage: () => {},
      editRunMessage: () => {},
      emitCronjobRunReadFile: () => ({ ok: true }),
      emitCronjobRunDiff: () => ({ ok: true }),
      attributionFor: () => ({ createdBy: "Boss", username: "Boss" }),
      validateCwd: () => null,
      saveRecentCwd: () => {},
    };
    return { ...base, ...over };
  }

  it("cron.runMessage returns {messageId} and threads that SAME id into sendRunMessage", async () => {
    let captured: { messageId?: string } | undefined;
    let calls = 0;
    const handlers = cronHandlers(
      stubDeps({
        findRun: () => ({ id: "run1" }) as CronjobRun,
        sendRunMessage: (_j, _r, _t, _u, _d, opts) => {
          calls++;
          captured = opts;
        },
      }),
    );
    const result = await handlers["cron.runMessage"](
      unitCtx({ text: "hi" }, { id: "job1", runId: "run1" }),
    );
    expect(result.kind).toBe("json");
    if (result.kind !== "json") throw new Error("expected json");
    const messageId = (result.body as { messageId: string }).messageId;
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
    expect(calls).toBe(1); // fire-and-forget: called exactly once
    expect(captured?.messageId).toBe(messageId); // ack === id threaded to manager
  });

  it("cron.editRunMessage returns {messageId} and threads that SAME id into editRunMessage", async () => {
    let captured: { messageId?: string } | undefined;
    const handlers = cronHandlers(
      stubDeps({
        findRun: () => ({ id: "run1" }) as CronjobRun,
        editRunMessage: (_j, _r, _e, _t, _u, _d, opts) => {
          captured = opts;
        },
      }),
    );
    const result = await handlers["cron.editRunMessage"](
      unitCtx(
        { newText: "edited" },
        { id: "job1", runId: "run1", logEntryId: "e1" },
      ),
    );
    expect(result.kind).toBe("json");
    if (result.kind !== "json") throw new Error("expected json");
    const messageId = (result.body as { messageId: string }).messageId;
    expect(captured?.messageId).toBe(messageId);
  });

  it("cron.listAllRuns maps the manager's internal jobId to the public cronjobId on the wire", async () => {
    // Regression guard (3d slice 2): getAllRunsByJob() yields { jobId, runs },
    // but the documented wire contract + every other cron field use cronjobId.
    // The handler must remap; otherwise the client seeds runs under key
    // `undefined` and the Jobs-tab run counts read zero.
    const handlers = cronHandlers(
      stubDeps({
        allRunsByJob: () => [
          {
            jobId: "job-1",
            runs: [{ id: "r1", cronjobId: "job-1" } as CronjobRun],
          },
        ],
      }),
    );
    const result = await handlers["cron.listAllRuns"](unitCtx({}, {}));
    expect(result.kind).toBe("json");
    if (result.kind !== "json") throw new Error("expected json");
    const body = result.body as {
      jobs: { cronjobId: string; runs: CronjobRun[] }[];
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].cronjobId).toBe("job-1");
    // The internal `jobId` field must NOT leak onto the wire.
    expect((body.jobs[0] as Record<string, unknown>).jobId).toBeUndefined();
    expect(body.jobs[0].runs).toHaveLength(1);
  });

  it("cron.runMessage on an unknown run -> 404 (cheap pre-flight, manager not called)", async () => {
    let calls = 0;
    const handlers = cronHandlers(
      stubDeps({
        findRun: () => null,
        sendRunMessage: () => {
          calls++;
        },
      }),
    );
    const result = await handlers["cron.runMessage"](
      unitCtx({ text: "hi" }, { id: "job1", runId: "ghost" }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.status).toBe(404);
    expect(calls).toBe(0);
  });
});
