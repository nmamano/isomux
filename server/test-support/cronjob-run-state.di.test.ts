// A cron run has one state and one way to change it (task abc438ee): each run
// is owned while it runs (a session turn, or a send to an agent), ends once,
// and a row that has ended refuses a second end whoever writes it. Driven
// through the manager with a fake backend and an in-memory store, as in
// cronjob-manager.di.test.ts (which is at its line limit).

import { describe, it, expect, afterEach } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { resolveToken, _testResetTokens } from "../identity/tokens.ts";
import { STATE_ROOT } from "../config.ts";
import { expectWorded, expectWordedText } from "./worded.ts";
import type { CronjobRun, LogEntry } from "../../shared/types.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
type CronDeps = Parameters<typeof createCronjobManager>[0];
type CronEvent = Parameters<NonNullable<CronDeps["eventSink"]>>[0];
type AddCronjobInput = Parameters<
  ReturnType<typeof createCronjobManager>["addCronjob"]
>[0];
type Deliver = NonNullable<CronDeps["deliverToAgent"]>;
type Delivered = Awaited<ReturnType<Deliver>>;

const FIXED_NOW = 1_000_000;
const AGENT = "agent-1700000000000-abcd";

const settle = () => new Promise((r) => setTimeout(r, 25));

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// A scheduler that never fires on its own.
const idleScheduler: CronDeps["scheduler"] = {
  setTimeout: (() => 0) as unknown as typeof setTimeout,
  clearTimeout: () => {},
  setInterval: (() => 0) as unknown as typeof setInterval,
  clearInterval: () => {},
};

function deps(over: Partial<CronDeps>): CronDeps {
  return {
    resolveBackend: () => new FakeBackend(),
    resolveEnv: () => ({}),
    resolveEnvironmentKey: () => "test-environment",
    resolveEnvironmentRevision: () => "test-revision",
    resolveUser: () => undefined,
    persistence: makeFakeCronPersistence(),
    clock: { now: () => FIXED_NOW },
    scheduler: idleScheduler,
    renderMemoryForPrompt: () => null,
    ...over,
  };
}

function jobInput(name: string, agentTarget = false): AddCronjobInput {
  return {
    name,
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: STATE_ROOT,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username: "Nil",
    ...(agentTarget ? { target: { kind: "agent", agentId: AGENT } } : {}),
  };
}

// The store keeps rows by reference, and events carry the same objects: keep
// a copy of each announced row and each error line.
function recorder() {
  const rows: CronjobRun[] = [];
  const errors: LogEntry[] = [];
  const events: CronEvent[] = [];
  const eventSink = (e: CronEvent) => {
    events.push(e);
    if (e.type === "cronjob_run_updated")
      rows.push(JSON.parse(JSON.stringify(e.run)));
    if (e.type === "log_entry" && e.entry.kind === "error")
      errors.push(e.entry);
  };
  return { rows, errors, events, eventSink };
}

// A deliverToAgent whose one send stays in flight until the test answers it.
function pendingSend() {
  let answer: ((d: Delivered) => void) | null = null;
  let calls = 0;
  const deliverToAgent: Deliver = () => {
    calls++;
    return new Promise<Delivered>((resolve) => {
      answer = resolve;
    });
  };
  return {
    deliverToAgent,
    calls: () => calls,
    deliver: () => answer!({ ok: true, messageId: "m-1", agentName: "Pat" }),
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("a cron run's one state", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    _testResetTokens();
  });

  // A follow-up reopens an ended run as running; the deletion must end that
  // turn once, at its own time, and the stream end that its close causes must
  // not end it again.
  it("deleting the schedule ends a resumed run once, and the stream end that follows changes nothing", async () => {
    let t = FIXED_NOW;
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "done" });
        },
      },
    });
    cleanups.push(() => fake.sessions.forEach((s) => s.close()));
    const seen = recorder();
    const mgr = createCronjobManager(
      deps({
        resolveBackend: () => fake,
        clock: { now: () => t },
        eventSink: seen.eventSink,
      }),
    );
    const job = mgr.addCronjob(jobInput("ResumedJob"));
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status === "completed",
      "first turn completed",
    );
    t += 1_000;
    const sent = await mgr.sendRunMessage(job.id, run.id, "again", "Nil");
    expect(sent.ok).toBe(true);
    await waitFor(() => sends === 2, "follow-up sent");
    // The ENABLING CONDITION: the follow-up reopened the row, and its turn
    // holds a live session and token.
    const resumed = fake.lastSession!;
    expect(fake.resumeSessionCount).toBe(1);
    const reopened = mgr.findRun(job.id, run.id)!;
    expect([reopened.status, reopened.endedAt]).toEqual(["running", null]);
    expect(resumed.closed).toBe(false);
    const raw = resumed.opts.env?.ISOMUX_AGENT_TOKEN as string;
    expect(resolveToken(raw)?.runId).toBe(run.id);

    t += 1_000;
    const deletedAt = t;
    const from = seen.rows.length;
    expect(mgr.deleteCronjob(job.id)).toBe(true);
    t += 1_000;
    // The close ended the stream; let the turn's consumer see that.
    await settle();

    expect(
      seen.rows
        .slice(from)
        .filter((r) => r.id === run.id)
        .map((r) => [r.status, r.endedAt]),
    ).toEqual([["failed", deletedAt]]);
    const row = mgr.findRun(job.id, run.id)!;
    expect([row.status, row.endedAt]).toEqual(["failed", deletedAt]);
    expectWordedText(
      row.errorReason ?? undefined,
      row.errorReasonMessage,
      "systemEntries.scheduleRun.jobDeleted",
    );
    expect(resumed.closed).toBe(true);
    expect(resolveToken(raw)).toBeNull();
    // One error line: the deletion's, and no stream-end line after it.
    expect(seen.errors).toHaveLength(1);
    expectWorded(seen.errors[0], "systemEntries.scheduleRun.jobDeleted");
  });

  // Once the turn has ended the run, a prompt send that only now fails (the
  // end's close rejects it) is not news for that run.
  it("a prompt send that fails after the turn ended the run adds nothing to it", async () => {
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        // The send stays parked until the test settles it.
        manualSend: true,
        onSend: (_t, _a, s) => {
          sends++;
          s.completeTurn({ text: "done" });
        },
      },
    });
    cleanups.push(() => fake.sessions.forEach((s) => s.close()));
    const seen = recorder();
    const mgr = createCronjobManager(
      deps({ resolveBackend: () => fake, eventSink: seen.eventSink }),
    );
    const job = mgr.addCronjob(jobInput("LateSendFailure"));
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status === "completed",
      "turn completed",
    );
    // The ENABLING CONDITION: the run ended while its one prompt send was
    // still parked, and the end closed the session.
    expect(sends).toBe(1);
    expect(fake.lastSession!.closed).toBe(true);
    const from = seen.events.length;

    fake.lastSession!.failSends(new Error("session closed"));
    await settle();

    expect(seen.events.slice(from).map((e) => e.type)).toEqual([]);
    const row = mgr.findRun(job.id, run.id)!;
    expect([row.status, row.errorReason]).toEqual(["completed", null]);
  });

  // A follow-up reopens the row; a row that refuses the reopen (here: it is
  // still running, for a turn another process owns) must start no turn. Two
  // managers on one store is the only way to reach it: in one process the
  // run's slot already makes the follow-up busy.
  it("a follow-up whose run refuses the reopen starts no turn and keeps no token", async () => {
    const persistence = makeFakeCronPersistence();
    let sends = 0;
    const first = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "done" });
        },
      },
    });
    const second = new FakeBackend();
    cleanups.push(() =>
      [...first.sessions, ...second.sessions].forEach((s) => s.close()),
    );
    const a = createCronjobManager(
      deps({ persistence, resolveBackend: () => first }),
    );
    const job = a.addCronjob(jobInput("ReopenRefused"));
    const run = a.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => a.findRun(job.id, run.id)?.status === "completed",
      "first turn completed",
    );
    expect((await a.sendRunMessage(job.id, run.id, "again", "Nil")).ok).toBe(
      true,
    );
    await waitFor(() => sends === 2, "follow-up sent");
    // The ENABLING CONDITION: the row is running for a turn `a` owns.
    const live = clone(a.findRun(job.id, run.id)!);
    expect(live.status).toBe("running");

    const b = createCronjobManager(
      deps({ persistence, resolveBackend: () => second }),
    );
    const refused = await b.sendRunMessage(job.id, run.id, "mine", "Nil");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.code).toBe("resume_failed");
    // The resume got as far as a session and a token, and both are gone.
    expect(second.resumeSessionCount).toBe(1);
    const orphan = second.lastSession!;
    expect(orphan.closed).toBe(true);
    expect(orphan.sent).toEqual([]);
    expect(
      resolveToken(orphan.opts.env?.ISOMUX_AGENT_TOKEN as string),
    ).toBeNull();
    const row = a.findRun(job.id, run.id)!;
    expect([row.status, row.endedAt]).toEqual([live.status, live.endedAt]);
  });

  // A send to an agent holds its run while it is in flight. The cron manager
  // has no stop hook, so the next boot ends what a stop cut. Two managers on
  // one store is the only way to reach the row's own refusal of a second end:
  // in one process the run's owner already refuses it.
  it("a send in flight is failed by the next boot, and its late answer does not overwrite that", async () => {
    const send = pendingSend();
    const persistence = makeFakeCronPersistence();
    let t = FIXED_NOW;
    const before = createCronjobManager(
      deps({
        persistence,
        deliverToAgent: send.deliverToAgent,
        clock: { now: () => t },
      }),
    );
    const job = before.addCronjob(jobInput("CutSend", true));
    const run = before.runCronjobNow(job.id, "Nil")!;
    await settle();
    expect(send.calls()).toBe(1);
    expect(before.findRun(job.id, run.id)?.status).toBe("running");

    t += 60_000;
    const bootAt = t;
    const after = createCronjobManager(
      deps({
        persistence,
        deliverToAgent: pendingSend().deliverToAgent,
        clock: { now: () => t },
      }),
    );
    after.startCronjobScheduler();
    const swept = clone(after.findRun(job.id, run.id)!);
    expect([swept.status, swept.endedAt]).toEqual(["failed", bootAt]);
    expectWordedText(
      swept.errorReason ?? undefined,
      swept.errorReasonMessage,
      "systemEntries.scheduleRun.serverRestarted",
    );

    t += 60_000;
    send.deliver();
    await settle();
    expect(after.findRun(job.id, run.id)).toEqual(swept);
  });

  // A message may already be in the agent's queue when the schedule is
  // deleted, and it cannot be taken back, so the deletion leaves the run to
  // end by the send's answer.
  it("deleting the schedule leaves a send in flight to end by its answer, once", async () => {
    const send = pendingSend();
    const seen = recorder();
    const mgr = createCronjobManager(
      deps({ deliverToAgent: send.deliverToAgent, eventSink: seen.eventSink }),
    );
    const job = mgr.addCronjob(jobInput("DeletedMidSend", true));
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await settle();
    expect(send.calls()).toBe(1);

    expect(mgr.deleteCronjob(job.id)).toBe(true);
    expect(mgr.findRun(job.id, run.id)?.status).toBe("running");

    send.deliver();
    await settle();
    expect(
      seen.rows.filter((r) => r.id === run.id).map((r) => r.status),
    ).toEqual(["running", "completed"]);
    expect(mgr.findRun(job.id, run.id)?.status).toBe("completed");
  });
});
