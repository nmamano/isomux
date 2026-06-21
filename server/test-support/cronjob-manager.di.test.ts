// Phase 0.2 DI seam test for CronjobManager. Proves it is an instantiable unit:
// backend resolver, env/user resolution, persistence, clock, and scheduler are
// all injected; the module-read bridge is registration-only (no lazy
// construction); schedule firing is deterministic via a fake clock + scheduler;
// and no real LLM/provider call happens. Injecting an in-memory persistence
// makes the manager OPERATIONS disk-free, so the seam assertions run
// unconditionally regardless of STATE_ROOT. Importing cronjob-manager pulls in
// cronjob-persistence, but that import is now side-effect-free (CRONJOBS_DIR is
// created lazily on first write, not at module load), so module import never
// creates dirs under real state. The run-execution proof and the
// production-factory check touch disk directly (office-config read / temp
// state); they run in-suite because the bun test preload presets ISOMUX_HOME to
// a temp dir before config.ts is imported (see agent-manager.di.test.ts).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  resolveToken,
  getRunTokenRaw,
  _testResetTokens,
} from "../identity/tokens.ts";
import { STATE_ROOT } from "../config.ts";
import {
  createCronjobManager,
  createProductionCronjobManager,
  registerProductionCronjobManagerForModuleReads,
  listCronjobs,
} from "../cronjob-manager.ts";
type CronDeps = Parameters<typeof createCronjobManager>[0];
type CronEvent = Parameters<NonNullable<CronDeps["eventSink"]>>[0];
// AddCronjobInput is a factory-local interface; derive it from the method.
type AddCronjobInput = Parameters<
  ReturnType<typeof createCronjobManager>["addCronjob"]
>[0];

// STATE_ROOT is a temp dir (the bun test preload preset ISOMUX_HOME before
// config.ts was imported), so the disk-touching assertions below run in-suite
// instead of skipping. The preload owns temp-root cleanup at process exit.

afterAll(() => {
  // Clear the module-read bridge so the fake instance registered by the bridge
  // test above doesn't leak into other files in the shared Bun process.
  registerProductionCronjobManagerForModuleReads(null);
});

// A fake scheduler that records registrations and never auto-fires, so tests
// drive time deterministically.
function fakeScheduler() {
  const timeouts: { fn: () => void; ms?: number }[] = [];
  const intervals: { fn: () => void; ms?: number }[] = [];
  const scheduler: CronDeps["scheduler"] = {
    setTimeout: ((fn: () => void, ms?: number) => {
      timeouts.push({ fn, ms });
      return timeouts.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: () => {},
    setInterval: ((fn: () => void, ms?: number) => {
      intervals.push({ fn, ms });
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
  };
  return { scheduler, timeouts, intervals };
}

const FIXED_NOW = 1_000_000; // far below real Date.now(): proves the fake clock.

function baseDeps(over: Partial<CronDeps> = {}): CronDeps {
  return {
    resolveBackend: () => new FakeBackend(),
    resolveEnv: () => ({}),
    resolveUser: () => undefined,
    persistence: makeFakeCronPersistence(),
    clock: { now: () => FIXED_NOW },
    scheduler: fakeScheduler().scheduler,
    ...over,
  };
}

function intervalInput(name: string): AddCronjobInput {
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
  };
}

function capture() {
  const events: CronEvent[] = [];
  const sink = (e: CronEvent) => events.push(e);
  return { events, sink };
}

describe("CronjobManager DI (disk-free seam)", () => {
  // Make the "throws before registration" precondition self-enforcing instead of
  // relying on bun's top-down order: reset the bridge to unregistered before this
  // block runs, so a future reorder or a new registering test can't silently flip
  // the assertion below from "tests the throw path" to a confusing failure.
  beforeAll(() => registerProductionCronjobManagerForModuleReads(null));

  it("module-read bridge throws before registration, forwards after (registration-only)", () => {
    expect(() => listCronjobs()).toThrow(/not registered/);

    const mgr = createCronjobManager(baseDeps());
    mgr.addCronjob(intervalInput("BridgeJob"));
    registerProductionCronjobManagerForModuleReads(mgr);
    expect(listCronjobs().map((c) => c.name)).toContain("BridgeJob");
  });

  it("routes cron events to the injected sink and reads back prompt state", () => {
    const { events, sink } = capture();
    const mgr = createCronjobManager(baseDeps({ eventSink: sink }));
    mgr.setCronjobsPrompt("be terse");
    expect(events.some((e) => e.type === "cronjobs_prompt_updated")).toBe(true);
    expect(mgr.getCronjobsPrompt()).toBe("be terse");
  });

  it("onCronjobEvent() overrides the default noop sink", () => {
    const mgr = createCronjobManager(baseDeps());
    const { events, sink } = capture();
    mgr.onCronjobEvent(sink);
    mgr.addCronjob(intervalInput("EventJob"));
    expect(events.some((e) => e.type === "cronjob_added")).toBe(true);
  });

  it("computes schedule times from the injected clock (deterministic)", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob(intervalInput("ClockJob"));
    // createdAt comes from clock.now(); a real Date.now() would be ~1.7e12.
    expect(job.createdAt).toBe(FIXED_NOW);
    expect(job.nextFireAt).toBeGreaterThan(FIXED_NOW);
    expect(job.nextFireAt).toBeLessThan(1e9);
  });

  it("startCronjobScheduler registers tick + interval on the injected scheduler", () => {
    const sched = fakeScheduler();
    const mgr = createCronjobManager(baseDeps({ scheduler: sched.scheduler }));
    mgr.startCronjobScheduler();
    expect(sched.timeouts.length).toBeGreaterThan(0); // initial tick
    expect(sched.intervals.length).toBeGreaterThan(0); // recurring tick
  });
});

describe("CronjobManager DI (temp-state isolated)", () => {
  it("runCronjobNow drives the FakeBackend through the resolver (no real backend)", async () => {
    const fake = new FakeBackend({
      // Auto-complete the run's single turn so it finalizes deterministically.
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "done" }) },
    });
    const mgr = createCronjobManager(baseDeps({ resolveBackend: () => fake }));
    const job = mgr.addCronjob(intervalInput("RunJob"));
    const run = mgr.runCronjobNow(job.id, "Nil");
    expect(run).not.toBeNull();
    // Let the async run reach createSession.
    await new Promise((r) => setTimeout(r, 25));
    expect(fake.createSessionCount).toBeGreaterThan(0);
    fake.sessions.forEach((s) => s.close());
  });

  it("production factory constructs against today's defaults (shallow)", () => {
    const mgr = createProductionCronjobManager();
    expect(typeof mgr.listCronjobs).toBe("function");
    expect(Array.isArray(mgr.listCronjobs())).toBe(true);
  });
});

// Phase 2.1 (ADDITIVE) — RUN-scope token wired into the PRIMARY run lifecycle.
// fire() mints a token, injects it as ISOMUX_AGENT_TOKEN into the run env (so a
// firing run's in-flight read-file/diff can authenticate as the run), and every
// terminal path revokes it. Resumed follow-up turns are out of 2.1 scope (still
// loopback-covered; wired with the Phase 3 loopback-bypass removal).
describe("CronjobManager RUN token lifecycle (Phase 2.1)", () => {
  afterEach(() => _testResetTokens());

  it("fire() injects a RUN bearer into the run env and resolves it to a cron-run identity; finalize revokes it", async () => {
    // No auto-complete: keep the run live so we can inspect the token before it
    // is revoked at finalize.
    const fake = new FakeBackend();
    const mgr = createCronjobManager(baseDeps({ resolveBackend: () => fake }));
    const job = mgr.addCronjob(intervalInput("RunTokenJob"));
    const run = mgr.runCronjobNow(job.id, "Nil");
    expect(run).not.toBeNull();
    // Let the async run reach createSession (+ send, which does not complete).
    await new Promise((r) => setTimeout(r, 25));

    const sess = fake.lastSession;
    const raw = sess?.opts.env?.ISOMUX_AGENT_TOKEN;
    expect(typeof raw).toBe("string");

    // Resolves (while the run is live) to a RUN-scope identity bound to {job,run}.
    const id = resolveToken(raw as string)!;
    expect(id.scope).toBe("cron-run");
    expect(id.cronjobId).toBe(job.id);
    expect(id.runId).toBe(run!.id);
    expect([...id.capabilities]).toEqual(["self:affordance"]);

    // Redaction: the run token must not ride in the run's system prompt.
    expect(sess?.opts.systemPrompt ?? "").not.toContain(raw as string);

    // End the run -> finalizeRun revokes the token.
    sess?.completeTurn({ text: "done" });
    await new Promise((r) => setTimeout(r, 25));
    expect(resolveToken(raw as string)).toBeNull();

    fake.sessions.forEach((s) => s.close());
  });

  it("createSession failure revokes the run token (no leak on the failed-run path)", async () => {
    const throwing = new FakeBackend();
    // Force the failed-run path: fire() must revoke the token it minted before
    // createSession threw (this path never enters activeRuns/finalizeRun).
    throwing.createSession = () => {
      throw new Error("boom (createSession)");
    };
    const mgr = createCronjobManager(
      baseDeps({ resolveBackend: () => throwing }),
    );
    const job = mgr.addCronjob(intervalInput("FailJob"));
    const run = mgr.runCronjobNow(job.id, "Nil");
    expect(run).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(getRunTokenRaw(job.id, run!.id)).toBeNull();
  });
});

// Follow-up #11 — RUN token on RESUMED cron turns. Phase 2.1 wired the RUN
// token only into the primary fire() lifecycle; resumed follow-up turns
// (sendRunMessage / editRunMessage) resume through buildRunSessionOptions, which
// now mints + injects a fresh RUN token and revokes it on every terminal path
// (the caller's resume-failure catch before install, finalizeRun after). These
// tests drive a REAL resume: the claude resume-precheck is satisfied by pointing
// CLAUDE_CONFIG_DIR at a temp dir (via the injected resolveEnv) and touching the
// leaf session file, mirroring fork-usage.test.ts's seedClaudeSession.
describe("CronjobManager RUN token lifecycle on RESUMED turns (Follow-up #11)", () => {
  afterEach(() => _testResetTokens());

  const CLAUDE_CFG = join(STATE_ROOT, "cron-resume-claude-home");

  const waitFor = async (pred: () => boolean, label = "cond") => {
    for (let i = 0; i < 400; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`waitFor timed out: ${label}`);
  };

  // Touch the existence-only leaf session file the claude resume precheck checks.
  function seedLeafSession(cwd: string, sessionId: string): void {
    const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: CLAUDE_CFG });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), "");
  }

  // Run the primary turn to completion (so it finalizes + revokes and the run is
  // resumable), then seed the leaf session file. fake.session.onSend decides
  // which turns auto-complete.
  async function primaryRunThenLeaf(fake: FakeBackend) {
    const mgr = createCronjobManager(
      baseDeps({
        resolveBackend: () => fake,
        resolveEnv: () => ({ CLAUDE_CONFIG_DIR: CLAUDE_CFG }),
      }),
    );
    const job = mgr.addCronjob(intervalInput("ResumeJob"));
    const run = mgr.runCronjobNow(job.id, "Nil");
    expect(run).not.toBeNull();
    await waitFor(
      () => mgr.findRun(job.id, run!.id)?.status === "completed",
      "primary run finalized",
    );
    const finalized = mgr.findRun(job.id, run!.id)!;
    const leaf = finalized.currentSessionId ?? finalized.rootSessionId;
    seedLeafSession(STATE_ROOT, leaf);
    return { mgr, job, run: run! };
  }

  it("a resumed turn injects a fresh RUN bearer resolving to {cron-run, job, run}; finalize revokes it", async () => {
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        // Primary turn (send #1) completes; the resumed turn (send #2) stays
        // live so we can inspect its token before finalize revokes it.
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "done" });
        },
      },
    });
    const { mgr, job, run } = await primaryRunThenLeaf(fake);

    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");
    await waitFor(
      () => getRunTokenRaw(job.id, run.id) !== null,
      "resumed run active",
    );

    const resumed = fake.lastSession!;
    expect(resumed.isResume).toBe(true);
    const raw = resumed.opts.env?.ISOMUX_AGENT_TOKEN;
    expect(typeof raw).toBe("string");
    const id = resolveToken(raw as string)!;
    expect(id.scope).toBe("cron-run");
    expect(id.cronjobId).toBe(job.id);
    expect(id.runId).toBe(run.id);
    expect([...id.capabilities]).toEqual(["self:affordance"]);
    // Redaction: the run token must not ride in the resumed run's system prompt.
    expect(resumed.opts.systemPrompt ?? "").not.toContain(raw as string);

    // Once active is installed, finalizeRun owns the revoke.
    resumed.completeTurn({ text: "done2" });
    await waitFor(
      () => getRunTokenRaw(job.id, run.id) === null,
      "resumed token revoked at finalize",
    );
    expect(resolveToken(raw as string)).toBeNull();
    fake.sessions.forEach((s) => s.close());
  });

  it("each resumed turn mints a fresh RUN bearer; the prior token is dead", async () => {
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        // Primary (#1) + first resume (#2) complete; the second resume (#3) lives.
        onSend: (_t, _a, s) => {
          if (++sends <= 2) s.completeTurn({ text: "x" });
        },
      },
    });
    const { mgr, job, run } = await primaryRunThenLeaf(fake);

    await mgr.sendRunMessage(job.id, run.id, "first", "Nil");
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status === "completed",
      "first resume finalized",
    );
    const firstRaw = fake.lastSession!.opts.env?.ISOMUX_AGENT_TOKEN as string;
    expect(resolveToken(firstRaw)).toBeNull(); // revoked at first finalize

    await mgr.sendRunMessage(job.id, run.id, "second", "Nil");
    await waitFor(
      () => getRunTokenRaw(job.id, run.id) !== null,
      "second resume active",
    );
    const secondRaw = fake.lastSession!.opts.env?.ISOMUX_AGENT_TOKEN as string;
    expect(secondRaw).not.toBe(firstRaw);
    const id = resolveToken(secondRaw)!;
    expect(id.scope).toBe("cron-run");
    expect(id.runId).toBe(run.id);

    fake.lastSession!.completeTurn({ text: "done" });
    await waitFor(
      () => getRunTokenRaw(job.id, run.id) === null,
      "second revoked",
    );
    fake.sessions.forEach((s) => s.close());
  });

  it("a resume whose resumeSession throws revokes the token minted before install (no leak)", async () => {
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "done" });
        },
      },
    });
    const { mgr, job, run } = await primaryRunThenLeaf(fake);

    // Force the resume to throw AFTER buildRunSessionOptions mints the token
    // (call arguments evaluate before the call). The resume-failure catch must
    // revoke it — installResumedActive never runs, so finalizeRun never would.
    fake.resumeSession = () => {
      throw new Error("boom (resume)");
    };
    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    fake.sessions.forEach((s) => s.close());
  });

  it("a post-mint, pre-install failure (install-time emit throws) revokes the token — no leak", async () => {
    // resumeSession SUCCEEDS (token minted + injected), but installResumedActive
    // throws AFTER activeRuns.set (its cronjob_run_updated emit throws). Without
    // the guard the token would outlive the run with no terminal owner (finalize
    // never runs). The shared abortResumedRunToken path must revoke + clean up.
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "primary done" });
        },
      },
    });
    // Arm a throwing sink: after the primary finalizes ("completed"), the next
    // "running" cronjob_run_updated is the resume's installResumedActive emit.
    let armed = false;
    const sink = (e: CronEvent) => {
      if (
        armed &&
        e.type === "cronjob_run_updated" &&
        e.run.status === "running"
      )
        throw new Error("boom (install-time emit)");
    };
    const mgr = createCronjobManager(
      baseDeps({
        resolveBackend: () => fake,
        resolveEnv: () => ({ CLAUDE_CONFIG_DIR: CLAUDE_CFG }),
        eventSink: sink,
      }),
    );
    const job = mgr.addCronjob(intervalInput("ResumeLeakJob"));
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await waitFor(
      () => mgr.findRun(job.id, run.id)?.status === "completed",
      "primary finalized",
    );
    const finalized = mgr.findRun(job.id, run.id)!;
    seedLeafSession(
      STATE_ROOT,
      finalized.currentSessionId ?? finalized.rootSessionId,
    );
    expect(getRunTokenRaw(job.id, run.id)).toBeNull(); // primary token revoked

    armed = true;
    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");
    // The resumed turn's token was minted then revoked by the post-mint guard —
    // not leaked. (A subsequent resume could start again; the run isn't wedged.)
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    fake.sessions.forEach((s) => s.close());
  });
});
