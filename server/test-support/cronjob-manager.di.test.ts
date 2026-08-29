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
  CODEX_MODELS,
  MODEL_FAMILIES,
  type AgentBackendType,
} from "../../shared/types.ts";
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
    resolveEnvironmentKey: () => "test-environment",
    resolveEnvironmentRevision: () => "test-revision",
    resolveUser: () => undefined,
    persistence: makeFakeCronPersistence(),
    clock: { now: () => FIXED_NOW },
    scheduler: fakeScheduler().scheduler,
    renderMemoryForPrompt: () => null,
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

  it("switches a Claude cronjob to Codex under the new engine", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob(intervalInput("SwitchToCodex"));

    const updated = mgr.updateCronjob(job.id, { agentType: "codex" });

    expect(updated).toMatchObject({
      agentType: "codex",
      modelFamily: CODEX_MODELS[0].value,
      effort: "high",
      permissionMode: "never",
    });
  });

  it("switches a Codex cronjob to Claude atomically and removes its sandbox", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob({
      ...intervalInput("SwitchToClaude"),
      agentType: "codex",
      modelFamily: "gpt-test-cron",
      effort: "high",
      permissionMode: "never",
      codexSandbox: "read-only",
    });

    const updated = mgr.updateCronjob(job.id, { agentType: "claude" });

    expect(updated).toMatchObject({
      agentType: "claude",
      modelFamily: MODEL_FAMILIES[0].family,
      effort: "high",
      permissionMode: "bypassPermissions",
    });
    expect(updated?.codexSandbox).toBeUndefined();
  });

  it("switches a Codex cronjob to OpenCode and removes its sandbox", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob({
      ...intervalInput("SwitchToOpenCode"),
      agentType: "codex",
      modelFamily: "gpt-test-cron",
      effort: "high",
      permissionMode: "never",
      codexSandbox: "read-only",
    });

    const updated = mgr.updateCronjob(job.id, {
      agentType: "opencode",
      modelFamily: "provider/model",
      permissionMode: "bypassPermissions",
    });

    expect(updated).toMatchObject({
      agentType: "opencode",
      modelFamily: "provider/model",
      permissionMode: "bypassPermissions",
    });
    expect(updated?.codexSandbox).toBeUndefined();
  });

  it("does not persist a Codex sandbox on an OpenCode cronjob", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob({
      ...intervalInput("OpenCodeSandbox"),
      agentType: "opencode",
      modelFamily: "provider/model",
      permissionMode: "bypassPermissions",
    });

    const updated = mgr.updateCronjob(job.id, {
      codexSandbox: "danger-full-access",
    });

    expect(updated?.agentType).toBe("opencode");
    expect(updated?.codexSandbox).toBeUndefined();
  });

  it("ignores an unknown engine instead of persisting it", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob(intervalInput("InvalidEngine"));

    const updated = mgr.updateCronjob(job.id, {
      agentType: "gpt" as AgentBackendType,
    });

    expect(updated?.agentType).toBe("claude");
    expect(
      mgr.listCronjobs().find((item) => item.id === job.id)?.agentType,
    ).toBe("claude");
  });

  it("keeps a fired run on its snapshotted engine after the cronjob switches", () => {
    const mgr = createCronjobManager(baseDeps());
    const job = mgr.addCronjob(intervalInput("SnapshotEngine"));
    const run = mgr.runCronjobNow(job.id, "Nil");

    mgr.updateCronjob(job.id, {
      agentType: "codex",
      modelFamily: "gpt-test-cron",
      effort: "high",
      permissionMode: "never",
    });

    const storedRun = mgr
      .getRunsForCronjob(job.id)
      .find((item) => item.id === run?.id);
    expect(storedRun?.agentTypeSnapshot).toBe("claude");
    expect(storedRun?.modelFamilySnapshot).toBe(MODEL_FAMILIES[0].family);
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

  it("selects the Codex backend and passes its run options through unchanged", async () => {
    const claude = new FakeBackend();
    const codex = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "done" }) },
    });
    const selected: string[] = [];
    const mgr = createCronjobManager(
      baseDeps({
        resolveBackend: (agentType) => {
          selected.push(agentType);
          return agentType === "codex" ? codex : claude;
        },
      }),
    );
    const job = mgr.addCronjob({
      ...intervalInput("CodexRunJob"),
      agentType: "codex",
      modelFamily: "gpt-test-cron",
      effort: "high",
      permissionMode: "never",
      codexSandbox: "read-only",
    });

    mgr.runCronjobNow(job.id, "Nil");
    await new Promise((r) => setTimeout(r, 25));

    expect(selected).toContain("codex");
    expect(claude.createSessionCount).toBe(0);
    expect(codex.createSessionCount).toBe(1);
    expect(codex.lastSession?.opts).toMatchObject({
      modelFamily: "gpt-test-cron",
      effort: "high",
      permissionMode: "never",
      sandbox: "read-only",
    });
    codex.sessions.forEach((s) => s.close());
  });

  it("runs OpenCode with its unattended profile and no office bearer", async () => {
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "done" }) },
    });
    const mgr = createCronjobManager(
      baseDeps({
        resolveBackend: () => fake,
        resolveEnv: () => ({ PROVIDER_KEY: "test-provider" }),
        resolveEnvironmentKey: () => "office-profile",
        resolveEnvironmentRevision: () => "office-revision",
      }),
    );
    const job = mgr.addCronjob({
      ...intervalInput("OpenCodeRunJob"),
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fake.lastSession?.opts).toMatchObject({
      modelFamily: "gate/gate-model",
      permissionMode: "bypassPermissions",
      environmentKey: "office-profile",
      environmentRevision: "office-revision",
    });
    expect(fake.lastSession?.opts.env?.ISOMUX_AGENT_TOKEN).toBeUndefined();
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    const prompt = fake.lastSession?.opts.systemPrompt ?? "";
    for (const forbidden of [
      "ISOMUX_AGENT_TOKEN",
      "/agents",
      "/api/tasks",
      "/messages",
      "/read-file",
      "/diff",
    ]) {
      expect(prompt).not.toContain(forbidden);
    }
    const claudePrompt = mgr.buildCronjobSystemPrompt(
      mgr.addCronjob(intervalInput("ClaudePromptJob")),
    );
    for (const required of [
      "ISOMUX_AGENT_TOKEN",
      "/agents",
      "/api/tasks",
      "/messages",
      "/read-file",
      "/diff",
    ]) {
      expect(claudePrompt).toContain(required);
    }
    expect(mgr.findRun(job.id, run.id)?.status).toBe("completed");
    fake.sessions.forEach((session) => session.close());
  });

  it("denies permission before aborting and fails unattended OpenCode runs", async () => {
    const order: string[] = [];
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) => {
          session.approve = async (id, decision) => {
            order.push(`deny:${id}:${decision.kind}`);
          };
          session.abort = async () => {
            order.push("abort");
          };
          session.push({
            kind: "approval_request",
            approvalId: "permission-1",
            toolName: "bash",
            input: {},
          });
        },
      },
    });
    const mgr = createCronjobManager(baseDeps({ resolveBackend: () => fake }));
    const job = mgr.addCronjob({
      ...intervalInput("PermissionFailure"),
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(order).toEqual(["deny:permission-1:deny", "abort"]);
    expect(mgr.findRun(job.id, run.id)).toMatchObject({
      status: "failed",
      errorReason:
        "Backend requested tool permission during an unattended cron run.",
    });
    fake.sessions.forEach((session) => session.close());
  });

  it("aborts and explains an interactive question request", async () => {
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) =>
          session.push({
            kind: "input_request",
            inputType: "question",
            requestId: "question-1",
          }),
      },
    });
    const mgr = createCronjobManager(baseDeps({ resolveBackend: () => fake }));
    const job = mgr.addCronjob({
      ...intervalInput("QuestionFailure"),
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fake.lastSession?.abortCount).toBe(1);
    expect(mgr.findRun(job.id, run.id)).toMatchObject({
      status: "failed",
      errorReason:
        "Backend requested an interactive question during an unattended cron run.",
    });
    fake.sessions.forEach((session) => session.close());
  });

  it("resumes OpenCode in the stored environment without minting a run bearer", async () => {
    let sends = 0;
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) => {
          sends++;
          session.completeTurn({ text: `done-${sends}` });
        },
      },
    });
    const mgr = createCronjobManager(
      baseDeps({
        resolveBackend: () => fake,
        resolveEnvironmentKey: () => "resume-environment",
        resolveEnvironmentRevision: () => "resume-revision",
      }),
    );
    const job = mgr.addCronjob({
      ...intervalInput("OpenCodeResume"),
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    for (let index = 0; index < 100; index++) {
      if (mgr.findRun(job.id, run.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");
    for (let index = 0; index < 100; index++) {
      if (fake.resumeSessionCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(fake.lastSession?.isResume).toBe(true);
    expect(fake.lastSession?.opts).toMatchObject({
      modelFamily: "gate/gate-model",
      permissionMode: "bypassPermissions",
      environmentKey: "resume-environment",
      environmentRevision: "resume-revision",
    });
    expect(fake.lastSession?.opts.env?.ISOMUX_AGENT_TOKEN).toBeUndefined();
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    fake.sessions.forEach((session) => session.close());
  });

  it("explains why a deleted OpenCode cronjob cannot resume", async () => {
    const { events, sink } = capture();
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "done" }),
      },
    });
    const mgr = createCronjobManager(
      baseDeps({ resolveBackend: () => fake, eventSink: sink }),
    );
    const job = mgr.addCronjob({
      ...intervalInput("DeletedOpenCode"),
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    });
    const run = mgr.runCronjobNow(job.id, "Nil")!;
    for (let index = 0; index < 100; index++) {
      if (mgr.findRun(job.id, run.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(mgr.deleteCronjob(job.id)).toBe(true);
    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");

    expect(fake.resumeSessionCount).toBe(0);
    expect(
      events.some(
        (event) =>
          event.type === "log_entry" &&
          event.entry.content.includes(
            "cronjob was deleted and its shared environment profile can no longer be resolved",
          ),
      ),
    ).toBe(true);
    fake.sessions.forEach((session) => session.close());
  });

  it("production factory constructs against today's defaults (shallow)", () => {
    const mgr = createProductionCronjobManager();
    expect(typeof mgr.listCronjobs).toBe("function");
    expect(Array.isArray(mgr.listCronjobs())).toBe(true);
  });
});

// Phase 2.1 (ADDITIVE) - RUN-scope token wired into the primary Claude/Codex
// lifecycle. OpenCode is excluded because its process is shared across runs.
// For the supported backends, every terminal path revokes the token.
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
    expect([...id.capabilities]).toEqual([
      "self:affordance",
      "agent:send-as-cron",
      "task:read",
      "task:write",
    ]);

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

describe("buildCronjobSystemPrompt - memory injection (DI seam)", () => {
  it("appends the office memory section via the injected seam; none by default", () => {
    const withMem = createCronjobManager(
      baseDeps({
        renderMemoryForPrompt: () => "Office-wide:\n- Nil, 2026-06-28: use Bun",
      }),
    );
    const job = withMem.addCronjob(intervalInput("MemCron"));
    const prompt = withMem.buildCronjobSystemPrompt(job);
    expect(prompt).toContain("## Memory (shared notes, not policy)");
    expect(prompt).toContain("Office-wide:\n- Nil, 2026-06-28: use Bun");

    // Default seam (baseDeps -> null) injects no Memory section.
    const noMem = createCronjobManager(baseDeps());
    const job2 = noMem.addCronjob(intervalInput("NoMemCron"));
    expect(noMem.buildCronjobSystemPrompt(job2)).not.toContain(
      "## Memory (shared notes, not policy)",
    );
  });
});

// Follow-up #11 - RUN token on RESUMED cron turns. Phase 2.1 wired the RUN
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
    expect([...id.capabilities]).toEqual([
      "self:affordance",
      "agent:send-as-cron",
      "task:read",
      "task:write",
    ]);
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
    // revoke it - installResumedActive never runs, so finalizeRun never would.
    fake.resumeSession = () => {
      throw new Error("boom (resume)");
    };
    await mgr.sendRunMessage(job.id, run.id, "follow up", "Nil");
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    fake.sessions.forEach((s) => s.close());
  });

  it("a post-mint, pre-install failure (install-time emit throws) revokes the token - no leak", async () => {
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
    // The resumed turn's token was minted then revoked by the post-mint guard -
    // not leaked. (A subsequent resume could start again; the run isn't wedged.)
    expect(getRunTokenRaw(job.id, run.id)).toBeNull();
    fake.sessions.forEach((s) => s.close());
  });
});
