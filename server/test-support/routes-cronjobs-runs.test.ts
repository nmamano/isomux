// Phase 3a slice 2b - cron run-messages + RUN-bearer run affordances on the
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
//     no `/api`, no token) 401s at the cookie wall: routes-legacy-retired.test.ts.
//   - run-message ownership tightening: REST via the route guard
//     (cronjobOwnerOrOfficeOwner). The legacy WS run-message arms were retired in
//     3d.3 and the shared wsCanMutateCronjob shim in 3d.4.
//   - The ack's messageId is the id of the user_message the run log holds
//     (over HTTP for a follow-up; at the handler boundary for an edit).
//
// Seam: startTestServer() + a non-completing FakeBackend for the live-run path.
// Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
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
  clearTestManagedOfficeEnv();
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
async function startLiveRun(name = "Morgan"): Promise<LiveRun> {
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

    // A missing path is a 400 before any transcript write. ping/pong barrier:
    // an (erroneous) emit would have been ws.send'd before the pong.
    const bad = await httpJson(
      live.srv,
      `/api/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`,
      { method: "POST", bearer: live.token, body: {} },
    );
    expect(bad.status).toBe(400);
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, live.streamId, "file-view")).toBe(0);

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

  it("RUN-bearer read-file on a credential store path answers 403 credential_path and adds no entry", async () => {
    const live = await startLiveRun();
    const sock = await live.srv.connectWs(live.ownerSession);

    const r = await httpJson(
      live.srv,
      `/api/cronjobs/${live.job.id}/runs/${live.run.id}/read-file`,
      {
        method: "POST",
        bearer: live.token,
        body: { path: "secrets/office.json" },
      },
    );
    expect(r.status).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "credential_path",
    );
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, live.streamId, "file-view")).toBe(0);
    expect(countLog(sock, live.streamId, "system")).toBe(0);
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
    // the replay POST, before this ping - ordered delivery means pong implies it
    // already arrived. A replay must NOT re-run the handler, so the count stays 1.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, live.streamId, "file-view")).toBe(1);
  });

  // Follow-up #11 bridge: proves the resume-token plumbing actually unblocks the
  // loopback flip - a RESUMED run's in-flight read-file authenticates to the
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
    const owner = await srv.seedOwner("Morgan");

    // Point CLAUDE_CONFIG_DIR at a temp tree via the office env-file provider (the
    // same hook production uses), so the claude resume precheck checks the temp
    // tree, never the real ~/.claude. Mirrors fork-usage.test.ts. The next
    // startTestServer boot re-registers the production provider, so no leak.
    const claudeHome = join(srv.stateRoot, "bridge-claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });

    const job = seedJob(srv, "Morgan");
    const run = srv.cronjobManager.runCronjobNow(job.id, "Morgan");
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
      "Morgan",
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
  it("a USER cookie (no self:affordance) and a RUN token of another {job,run} (runParamMustEqualTokenRun) get 403", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const job = seedJob(srv, "Morgan");
    const path = `/api/cronjobs/${job.id}/runs/some-run/read-file`;
    const cookie = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { path: "x" },
    });
    expect(cookie.status).toBe(403);
    const wrong = await httpJson(srv, path, {
      method: "POST",
      bearer: mintRunToken("other-job", "other-run", null),
      body: { path: "x" },
    });
    expect(wrong.status).toBe(403);
  });
});

describe("routes/cron run-messages: ownership tightening (REST)", () => {
  it("REST: a member cannot message another user's run (403); 400 empty text; 404 unknown run", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mallory");
    const ownersJob = seedJob(srv, "Morgan", "OwnersJob");

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

    // Owner, unknown run -> the route's cheap 404 pre-flight, not the
    // manager's run_not_found.
    const unknown = await httpJson(
      srv,
      `/api/cronjobs/${ownersJob.id}/runs/nope/messages`,
      {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { text: "hi" },
      },
    );
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error?: { code?: string } }).error?.code).toBe(
      "not_found",
    );
  });
});

// A finalized, resumable run: the primary turn completes, and FakeBackend's
// resume precheck passes unless setLeafResumable(false). `holdResumed`: resumed
// turns never complete, so the run stays busy after the first accepted
// follow-up. `hangOnClose`: a closed session's stream ends only on endStream().
async function startResumableRun(holdResumed = false, hangOnClose = false) {
  let sends = 0;
  // Kept by reference: FakeBackend reads it per session, so a test can change
  // what later sessions do (autoSystemInit).
  const sessionCfg: NonNullable<
    ConstructorParameters<typeof FakeBackend>[0]
  >["session"] & { autoSystemInit?: boolean } = {
    hangOnClose,
    onSend: (_t, _a, s) => {
      if (++sends === 1 || !holdResumed) s.completeTurn({ text: "done" });
    },
  };
  const fb = new FakeBackend({ session: sessionCfg });
  const srv = await startTestServer({ fakeBackend: fb });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const job = seedJob(srv, "Morgan");
  const run = srv.cronjobManager.runCronjobNow(job.id, "Morgan");
  if (!run) throw new Error("runCronjobNow returned null");
  await waitUntil(
    () => srv.cronjobManager.findRun(job.id, run.id)?.status === "completed",
    3000,
    "primary run finalized (resumable)",
  );
  const setLeafResumable = (resumable: boolean) => {
    const finalized = srv.cronjobManager.findRun(job.id, run.id)!;
    fb.setSessionResumableError(
      finalized.currentSessionId ?? finalized.rootSessionId,
      resumable ? null : "Cannot resume: test leaf is gone.",
    );
  };
  const userMessages = () =>
    srv.cronjobManager
      .getRunTranscript(job.id, run.id)
      .entries.filter((e) => e.kind === "user_message");
  const path = `/api/cronjobs/${job.id}/runs/${run.id}/messages`;
  // A directory at the leaf log path makes every append to it fail.
  const breakLog = () => {
    const finalized = srv.cronjobManager.findRun(job.id, run.id)!;
    const leaf = finalized.currentSessionId ?? finalized.rootSessionId;
    const logFile = join(
      srv.stateRoot,
      "cronjobs",
      job.id,
      run.id,
      `${leaf}.jsonl`,
    );
    renameSync(logFile, `${logFile}.saved`);
    mkdirSync(logFile);
    expect(statSync(logFile).isDirectory()).toBe(true);
    return () => {
      rmdirSync(logFile);
      renameSync(`${logFile}.saved`, logFile);
    };
  };
  return {
    srv,
    fb,
    sessionCfg,
    owner,
    job,
    run,
    path,
    setLeafResumable,
    userMessages,
    breakLog,
  };
}

// Task 44872c41: the 200 means the follow-up is in the run log; a refusal is an
// HTTP error the composer keeps as a not-sent attempt; a resend with the same
// clientMessageId is not sent twice.
describe("routes/cron run-messages: acceptance and clientMessageId", () => {
  it("200 carries the id of the user_message now in the run log", async () => {
    const { srv, owner, path, userMessages } = await startResumableRun();
    const r = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { text: "follow up", clientMessageId: "c-1" },
    });
    expect(r.status).toBe(200);
    const messageId = (r.body as { messageId: string }).messageId;
    // Accepted means written: no wait for the turn.
    expect(userMessages().map((e) => [e.id, e.content])).toEqual([
      [messageId, "follow up"],
    ]);
  });

  it("a resend with the same clientMessageId answers 200 and writes nothing new", async () => {
    const { srv, job, run, owner, path, userMessages } =
      await startResumableRun();
    const body = { text: "once only", clientMessageId: "c-dup" };
    const first = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(first.status).toBe(200);
    await waitUntil(
      () => srv.cronjobManager.findRun(job.id, run.id)?.status === "completed",
      3000,
      "resumed turn finished",
    );
    const resend = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(resend.status).toBe(200);
    expect((resend.body as { messageId: string }).messageId).toBe("");
    expect(userMessages().length).toBe(1);
  });

  it("a busy run refuses with 409 instead of dropping the message behind a 200", async () => {
    const { srv, owner, path, userMessages } = await startResumableRun(true);
    const first = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { text: "first", clientMessageId: "c-a" },
    });
    expect(first.status).toBe(200);
    const second = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { text: "second", clientMessageId: "c-b" },
    });
    expect(second.status).toBe(409);
    expect((second.body as { error?: { code?: string } }).error?.code).toBe(
      "run_busy",
    );
    expect(userMessages().map((e) => e.content)).toEqual(["first"]);
  });

  it("an unresumable run refuses with 409, and the refused id can be sent again", async () => {
    const { srv, owner, path, setLeafResumable, userMessages } =
      await startResumableRun();
    setLeafResumable(false);
    const body = { text: "retry me", clientMessageId: "c-retry" };
    const refused = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { error?: { code?: string } }).error?.code).toBe(
      "run_not_resumable",
    );
    expect(userMessages()).toEqual([]);

    setLeafResumable(true);
    const resent = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(resent.status).toBe(200);
    expect((resent.body as { messageId: string }).messageId).not.toBe("");
    expect(userMessages().map((e) => e.content)).toEqual(["retry me"]);
  });

  it("a run log that cannot be written refuses with 500, undoes the resume, and the id can be sent again", async () => {
    const { srv, fb, owner, job, run, path, userMessages, breakLog } =
      await startResumableRun();
    const fixLog = breakLog();

    const body = { text: "must be saved", clientMessageId: "c-disk" };
    const refused = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(refused.status).toBe(500);
    expect((refused.body as { error?: { code?: string } }).error?.code).toBe(
      "persist_failed",
    );
    // Nothing reached the backend, and the run is as it was.
    const resumed = fb.lastSession!;
    expect(resumed.isResume).toBe(true);
    expect(resumed.sent).toEqual([]);
    expect(resumed.closed).toBe(true);
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    expect(srv.cronjobManager.findRun(job.id, run.id)?.status).toBe(
      "completed",
    );

    fixLog();
    const resent = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(resent.status).toBe(200);
    expect((resent.body as { messageId: string }).messageId).not.toBe("");
    expect(userMessages().map((e) => e.content)).toEqual(["must be saved"]);
  });

  it("a late stream end of the session a refused send closed does not end the retry", async () => {
    const { srv, fb, sessionCfg, owner, job, run, path, breakLog } =
      await startResumableRun(true, true);
    // Resumed sessions buffer no event, so the old consumer reaches the
    // stream-ended finalize, not the per-event check.
    sessionCfg.autoSystemInit = false;
    const fixLog = breakLog();
    const body = { text: "retry", clientMessageId: "c-late-close" };
    const refused = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(refused.status).toBe(500);
    const old = fb.lastSession!;
    expect(old.closed).toBe(true);

    fixLog();
    const retry = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body,
    });
    expect(retry.status).toBe(200);
    expect(fb.lastSession).not.toBe(old);
    expect(srv.cronjobManager.findRun(job.id, run.id)?.status).toBe("running");
    expect(getRunTokenRaw(job.id, run.id)).not.toBeNull();

    // The old consumer was parked on the wedged stream; let it finish now.
    old.endStream();
    await sleep(20);
    expect(srv.cronjobManager.findRun(job.id, run.id)?.status).toBe("running");
    expect(getRunTokenRaw(job.id, run.id)).not.toBeNull();
    expect(fb.lastSession!.closed).toBe(false);
  });

  it("events of the session a refused send closed never reach the wire", async () => {
    const { srv, fb, owner, job, run, path, breakLog } =
      await startResumableRun();
    const sock = await srv.connectWs(owner.rawSessionId);
    const fixLog = breakLog();
    // The refused resume's session already holds output when it is closed.
    const resume = fb.resumeSession.bind(fb);
    fb.resumeSession = (id, opts) => {
      const session = resume(id, opts);
      fb.lastSession!.completeTurn({ text: "late old text" });
      return session;
    };
    const refused = await httpJson(srv, path, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { text: "retry", clientMessageId: "c-late-event" },
    });
    expect(refused.status).toBe(500);
    expect(fb.lastSession!.closed).toBe(true);
    await sleep(50);
    fixLog();
    expect(
      countLog(sock, cronjobRunStreamId(run.id), "text", "late old text"),
    ).toBe(0);
    expect(srv.cronjobManager.findRun(job.id, run.id)?.status).toBe(
      "completed",
    );
  });

  it("rejects a clientMessageId that is not a string or is too long (422)", async () => {
    const { srv, owner, path, userMessages } = await startResumableRun();
    for (const clientMessageId of [7, "x".repeat(129)]) {
      const r = await httpJson(srv, path, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { text: "hi", clientMessageId },
      });
      expect(r.status).toBe(422);
    }
    expect(userMessages()).toEqual([]);
  });
});

// An edit has no HTTP test that reads the edited entry back, so its ack is
// pinned at the handler boundary: the messageId is generated, threaded into
// the manager op, AND returned - a real correlation id, not a fictional one.
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
      ownScheduleLimits: () => null,
      listCronjobs: () => [],
      listCronjobsFor: () => [],
      projectCronjobFor: () => null,
      visibleTo: () => true,
      assignableRoomIds: () => new Set(),
      defaultCreateRoomId: () => undefined,
      buildCronjobSystemPrompt: () => "system prompt",
      createCronjob: async () => {
        throw new Error("unused");
      },
      updateCronjob: async () => null,
      deleteCronjob: () => false,
      getPrompt: () => null,
      setPrompt: () => {},
      runNow: () => null,
      runsForCronjob: () => [],
      allRunsByJob: () => [],
      runTranscript: () => ({ run: null, entries: [] }),
      findRun: () => null,
      sendRunMessage: async () => ({ ok: true }),
      editRunMessage: () => {},
      emitCronjobRunReadFile: () => ({ ok: true }),
      emitCronjobRunDiff: async () => ({ ok: true }),
      attributionFor: () => ({ createdBy: "Morgan", username: "Morgan" }),
      validateCwd: () => null,
      saveRecentCwd: () => {},
      modelFamilyError: () => null,
    };
    return { ...base, ...over };
  }

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
});
