// Subscription-allowance usage (the pill next to the context battery, task
// df489513): the per-agent reading in agent-manager and the rules that keep it
// honest. Seam: createAgentManager + FakeBackend, no HTTP, no LLM.
//
// What this freezes:
//   - A turn boundary samples the backend and mirrors the reading onto
//     AgentInfo (which is what reaches the browser over agent_updated),
//     clamped to 0..100.
//   - The pill's number comes from the window closest to its limit, not from
//     whichever window the backend listed first.
//   - An "unknown" answer (call failed, nothing reported yet) leaves the
//     previous value standing instead of blanking the pill, while an
//     "unavailable" answer (authoritatively no plan allowance) clears it.
//   - Both turn boundaries and mid-turn cumulative-usage events sample; the
//     orchestrator does NOT throttle, because each backend owns its own cost
//     (Codex reads pushed data, Claude throttles its RPC internally).
//   - /clear does NOT reset it: the number describes the ACCOUNT, not the
//     conversation.
//   - An ENGINE switch (and a cross-engine resume) clears it and orphans any
//     read already in flight: those are the paths where the agent starts
//     talking to a different provider account. A same-engine model change does
//     NOT clear it - swapping Opus for Sonnet leaves the account alone.

import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { FakeBackend } from "./fake-backend.ts";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { stampSessionEngineConfig } from "../persistence.ts";
import type { AgentInfo, RoomWire } from "../../shared/types.ts";
import type { SubscriptionUsageResult } from "../backends/types.ts";

afterEach(() => clearTestManagedOfficeEnv());

const WAIT_MS = 20_000;
setDefaultTimeout(60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  label = "cond",
  timeoutMs = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function diRooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function reading(
  usedPercent: number,
  plan = "max",
  extraWindows: { label: string; usedPercent: number }[] = [],
): SubscriptionUsageResult {
  return {
    kind: "usage",
    usage: {
      plan,
      windows: [
        { label: "Weekly", usedPercent, resetsAtMs: 1785000000000 },
        ...extraWindows.map((w) => ({ ...w, resetsAtMs: null })),
      ],
    },
  };
}

function makeManager(fake: FakeBackend): ReturnType<typeof createAgentManager> {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: diRooms("room-a") }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

async function spawn(
  mgr: ReturnType<typeof createAgentManager>,
): Promise<AgentInfo> {
  const info = await mgr.spawn(
    "Worker",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

async function runTurn(
  mgr: ReturnType<typeof createAgentManager>,
  id: string,
  text: string,
): Promise<void> {
  const r = mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "Boss" },
    text,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
  await waitUntil(() => {
    const s = mgr.getAgent(id)?.state;
    return s !== undefined && s !== "thinking" && s !== "tool_executing";
  }, `turn processed: ${text}`);
}

// The model-change path re-creates the session, which runs the Claude resume
// preflight - so that test needs a CLAUDE_CONFIG_DIR we control plus an
// existence-only session file. Same setup as context-usage.test.ts.
let homeSuffix = 0;
function wireClaudeHome(): string {
  const suffix = `sub-usage-${++homeSuffix}`;
  const claudeHome = join(STATE_ROOT, `claude-home-${suffix}`);
  setTestManagedOfficeEnv({
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: join(STATE_ROOT, "codex-home"),
  });
  return claudeHome;
}

function seedClaudeFile(
  claudeHome: string,
  cwd: string,
  sessionId: string,
): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

describe("subscription usage", () => {
  it("publishes the reading on AgentInfo at a turn boundary, clamped", async () => {
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(120.5),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeFalsy();

    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );
    const usage = mgr.getAgent(info.id)!.subscriptionUsage!;
    expect(usage.plan).toBe("max");
    expect(usage.windows).toEqual([
      { label: "Weekly", usedPercent: 100, resetsAtMs: 1785000000000 },
    ]);
    expect(usage.primaryIndex).toBe(0);
    expect(usage.sampledAtMs).toBeGreaterThan(0);
  });

  it("points the pill at the window closest to its limit, not the first one", async () => {
    // The whole point of the indicator: a weekly window at 30% must not read
    // green while the 5-hour window is nearly spent.
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () =>
          reading(30, "max", [
            { label: "5-hour", usedPercent: 95 },
            { label: "Weekly (Opus)", usedPercent: 60 },
          ]),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );
    const usage = mgr.getAgent(info.id)!.subscriptionUsage!;
    // Display order is preserved; only the pointer moves.
    expect(usage.windows.map((w) => w.label)).toEqual([
      "Weekly",
      "5-hour",
      "Weekly (Opus)",
    ]);
    expect(usage.primaryIndex).toBe(1);
  });

  it("keeps the previous reading when a later sample says 'unknown'", async () => {
    let calls = 0;
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () =>
          ++calls === 1 ? reading(42) : { kind: "unknown" as const },
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);

    await runTurn(mgr, info.id, "one");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "first reading",
    );
    await runTurn(mgr, info.id, "two");
    await waitUntil(() => calls >= 2, "second sample taken");
    expect(
      mgr.getAgent(info.id)?.subscriptionUsage?.windows[0].usedPercent,
    ).toBe(42);
  });

  it("samples on mid-turn usage events as well as at the turn boundary", async () => {
    // No orchestrator-side throttle: the backends own that decision, so a
    // runaway retry loop can move the pill while it is still running.
    let calls = 0;
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => {
          calls++;
          return reading(7);
        },
        onSend: (_t, _a, s) => {
          // Three cumulative-usage notifications inside one turn, the shape a
          // runaway retry loop produces.
          for (let i = 0; i < 3; i++) {
            s.push({
              kind: "usage_update",
              tokenUsage: {
                inputTokens: 10,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            });
          }
          s.completeTurn({ text: "ok" });
        },
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);

    await runTurn(mgr, info.id, "loop");
    await waitUntil(
      () => calls >= 4,
      "sampled on each usage event plus the turn end",
    );
    expect(calls).toBe(4);
  });

  it("clears the pill when the backend authoritatively has no allowance", async () => {
    // An API-key login answering "rate limits do not apply here" must take a
    // populated pill away, which "unknown" deliberately would not.
    let calls = 0;
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () =>
          ++calls === 1 ? reading(42) : { kind: "unavailable" as const },
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "one");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "first reading",
    );
    await runTurn(mgr, info.id, "two");
    await waitUntil(
      () => !mgr.getAgent(info.id)?.subscriptionUsage,
      "pill cleared",
    );
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeNull();
  });

  it("ignores a stale sample that resolves after a newer one committed", async () => {
    // Out-of-order resolution: the slow first call must not overwrite the
    // fast second one.
    const gates: ((v: SubscriptionUsageResult) => void)[] = [];
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: () =>
          new Promise<SubscriptionUsageResult>((resolve) =>
            gates.push(resolve),
          ),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "one");
    await runTurn(mgr, info.id, "two");
    await waitUntil(() => gates.length >= 2, "two samples in flight");
    // Newer sample lands first, then the older one.
    gates[1](reading(80));
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "newer reading committed",
    );
    gates[0](reading(5));
    await sleep(50);
    expect(
      mgr.getAgent(info.id)?.subscriptionUsage?.windows[0].usedPercent,
    ).toBe(80);
  });

  it("survives /clear - the quota belongs to the account, not the conversation", async () => {
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(63),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );

    await mgr.newConversation(info.id);
    expect(mgr.getAgent(info.id)?.contextUsage).toBeFalsy();
    expect(
      mgr.getAgent(info.id)?.subscriptionUsage?.windows[0].usedPercent,
    ).toBe(63);
  });

  it("refreshes the reading's timestamp at every turn boundary, even when the number is unchanged", async () => {
    // The popover says how old the reading is, so a deduped broadcast would
    // freeze that timestamp on screen while the number was quietly being
    // re-confirmed. Only the high-frequency mid-turn path may dedupe.
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(42),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "one");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "first reading",
    );
    const first = mgr.getAgent(info.id)!.subscriptionUsage!.sampledAtMs;

    await sleep(5);
    await runTurn(mgr, info.id, "two");
    await waitUntil(
      () => mgr.getAgent(info.id)!.subscriptionUsage!.sampledAtMs > first,
      "timestamp advanced on an identical reading",
    );
    // Same displayed number, fresher reading.
    expect(
      mgr.getAgent(info.id)?.subscriptionUsage?.windows[0].usedPercent,
    ).toBe(42);
  });

  it("survives a same-engine model change - the account is unchanged", async () => {
    // Opus -> Sonnet is still the same claude.ai account, so blanking the pill
    // here would be a regression, not caution.
    const claudeHome = wireClaudeHome();
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(63),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );

    const cwd = mgr.getAgent(info.id)!.cwd;
    seedClaudeFile(claudeHome, cwd, mgr.getCurrentSessionId(info.id)!);
    await mgr.editAgent(info.id, { modelFamily: "sonnet" });
    expect(
      mgr.getAgent(info.id)?.subscriptionUsage?.windows[0].usedPercent,
    ).toBe(63);
  });

  it("clears on an engine switch, which is where the account actually changes", async () => {
    // editAgent routes an agentType change through newConversation and returns
    // early, so this is the path that has to do the clearing.
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(63),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );

    await mgr.editAgent(info.id, { agentType: "codex" });
    expect(mgr.getAgent(info.id)?.agentType).toBe("codex");
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeNull();
  });

  it("clears when resuming a session recorded under the other engine", async () => {
    wireClaudeHome();
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: async () => reading(63),
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "hi");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "reading published",
    );

    // A session this agent previously ran under Codex.
    const codexSessionId = "11111111-1111-4111-8111-111111111111";
    stampSessionEngineConfig(info.id, codexSessionId, {
      agentType: "codex",
      modelFamily: "gpt-5.5",
      effort: "medium",
      permissionMode: "on-request",
      codexSandbox: "workspace-write",
    });
    const rolloutDir = join(
      STATE_ROOT,
      "codex-home",
      "sessions",
      "2026",
      "08",
      "27",
    );
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, `rollout-test-${codexSessionId}.jsonl`),
      '{"type":"session_meta"}\n{"type":"response_item"}\n',
    );
    await mgr.resume(info.id, codexSessionId);
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeNull();
    expect(mgr.getAgent(info.id)?.permissionMode).toBe("never");
    expect(mgr.getAgent(info.id)?.codexSandbox).toBe("danger-full-access");

    // The stamp records historical posture but is not a resume input. A later
    // same-engine resume cannot drag the corrected record back to old defaults.
    stampSessionEngineConfig(info.id, codexSessionId, {
      agentType: "codex",
      modelFamily: "gpt-5.5",
      effort: "medium",
      permissionMode: "on-request",
      codexSandbox: "workspace-write",
    });
    await mgr.resume(info.id, codexSessionId);
    expect(mgr.getAgent(info.id)?.permissionMode).toBe("never");
    expect(mgr.getAgent(info.id)?.codexSandbox).toBe("danger-full-access");
  });

  it("drops a read that was already in flight when the engine switched", async () => {
    // The seq guard alone can't catch this: the stale sample is the NEWEST
    // one. Only an account-identity generation rejects it.
    let calls = 0;
    let release: ((v: SubscriptionUsageResult) => void) | null = null;
    const fake = new FakeBackend({
      session: {
        subscriptionUsage: () => {
          if (++calls === 1) return Promise.resolve(reading(20));
          return new Promise<SubscriptionUsageResult>((resolve) => {
            release = resolve;
          });
        },
        onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      },
    });
    const mgr = makeManager(fake);
    const info = await spawn(mgr);
    await runTurn(mgr, info.id, "one");
    await waitUntil(
      () => !!mgr.getAgent(info.id)?.subscriptionUsage,
      "first reading published",
    );
    await runTurn(mgr, info.id, "two");
    await waitUntil(() => release !== null, "second read in flight");

    await mgr.editAgent(info.id, { agentType: "codex" });
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeNull();
    // The old account's answer finally arrives, after the switch. It must not
    // repopulate a Claude figure onto an agent that now runs Codex.
    release!(reading(63));
    await sleep(50);
    expect(mgr.getAgent(info.id)?.subscriptionUsage).toBeNull();
  });
});
