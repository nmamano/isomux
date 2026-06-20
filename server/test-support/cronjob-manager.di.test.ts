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

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";
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
