// Phase 1.4a — Conversation branching: fork-chain assembly + usage accounting.
//
// Freezes the OBSERVABLE behavior of fork-chain log assembly and per-session
// usage accounting before Phase 3 touches the orchestrator/transport.
//
// Two seams, documented per block:
//   B1 (pure helpers) — direct-call against the preload's temp STATE_ROOT
//      (persistence.test.ts idiom: beforeEach wipes STATE_ROOT, seed sessions.json
//      + .jsonl via the real persist/append API, call, assert). Covers
//      loadLogWithAncestors, accumulate/roll/snapshot, findUsageAtFork, and the
//      usage-report lifetime/session math (readAgentUsage).
//   B2 (orchestrated wiring) — the DI manager seam (createAgentManager +
//      FakeBackend + event sink, per agent-manager.di.test.ts). Drives ONE
//      orchestrator event and reads sessions.json + the captured events. No WS
//      boundary needed here, so this is lighter and more deterministic than the
//      harness. Covers turn_completed -> accumulate + snapshot (exact anchor),
//      resume -> roll usage + replay ancestors, and editMessage -> persistSessionFork
//      (forkBaseUsage undefined for a first-message edit, present otherwise).
//
// Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import {
  appendLog,
  loadLog,
  loadLogWithAncestors,
  loadSessionsMap,
  persistSessionFork,
  accumulateSessionUsage,
  rollSessionUsageOnResume,
  appendSessionUsageSnapshot,
  type PersistedUsage,
} from "../persistence.ts";
import { findUsageAtFork, readAgentUsage } from "../usage-report.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { FakeBackend } from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

// B2 managers are tracked here so their parked FakeSession consumers are closed
// after every test even if an assertion throws mid-test (throw-safe cleanup,
// vs a success-path-only inline close).
const activeFakes: FakeBackend[] = [];

afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  // The B2 resume/edit tests register a temp office env file (pointing
  // CLAUDE_CONFIG_DIR at a temp dir so the orchestrator's explicit-resume
  // preflight finds the seeded provider file). Reset the env-loader
  // process-global after each test so it cannot leak into other tests; harness
  // tests re-register their own provider on boot.
  setOfficeEnvFileProvider(() => null);
});

let ts = 0;
function le(
  agentId: string,
  id: string,
  kind: LogEntry["kind"],
  content = "",
): LogEntry {
  return { id, agentId, timestamp: ++ts, kind, content };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUSD: number,
): PersistedUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costUSD,
  };
}

// Write sessions.json directly (bypassing persistSessionFork) to seed shapes the
// public persist API can't produce — e.g. a fork link with NO forkMessageId.
function seedSessionsMapRaw(
  agentId: string,
  map: Record<string, unknown>,
): void {
  const dir = join(STATE_ROOT, "logs", agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(map));
}

// ===========================================================================
// B1 — fork-chain assembly (loadLogWithAncestors), direct-call seam
// ===========================================================================

describe("B1 loadLogWithAncestors (Phase 1.4a)", () => {
  const A = "agent-fork";

  it("returns all entries for a session with no fork ancestry", () => {
    appendLog(A, "s1", le(A, "e1", "user_message", "one"));
    appendLog(A, "s1", le(A, "e2", "text", "two"));
    const out = loadLogWithAncestors(A, "s1");
    expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("cuts the immediate parent at the fork point and appends the child's own entries", () => {
    // parent: p1, p2 (fork point), p3 (continued in parent after the fork)
    appendLog(A, "parent", le(A, "p1", "user_message"));
    appendLog(A, "parent", le(A, "p2", "user_message"));
    appendLog(A, "parent", le(A, "p3", "text"));
    appendLog(A, "child", le(A, "c1", "user_message"));
    appendLog(A, "child", le(A, "c2", "text"));
    persistSessionFork(A, "child", "parent", "p2", null, 0, "/tmp");

    // Ancestor prefix is taken UP TO (excluding) the fork point p2: p1 only,
    // never p2/p3; then the child's own entries.
    expect(loadLogWithAncestors(A, "child").map((e) => e.id)).toEqual([
      "p1",
      "c1",
      "c2",
    ]);
  });

  it("cuts at every level of a multi-ancestor chain (oldest-first)", () => {
    appendLog(A, "gp", le(A, "g1", "user_message"));
    appendLog(A, "gp", le(A, "g2", "user_message")); // fork point for parent
    appendLog(A, "gp", le(A, "g3", "text"));
    appendLog(A, "parent", le(A, "p1", "user_message"));
    appendLog(A, "parent", le(A, "p2", "user_message")); // fork point for child
    appendLog(A, "parent", le(A, "p3", "text"));
    appendLog(A, "child", le(A, "c1", "text"));
    persistSessionFork(A, "parent", "gp", "g2", null, 0, "/tmp");
    persistSessionFork(A, "child", "parent", "p2", null, 0, "/tmp");

    expect(loadLogWithAncestors(A, "child").map((e) => e.id)).toEqual([
      "g1",
      "p1",
      "c1",
    ]);
  });

  it("terminates (no infinite loop) on a forkedFrom cycle and still yields the leaf's own entries", () => {
    appendLog(A, "sa", le(A, "a1", "text"));
    appendLog(A, "sb", le(A, "b1", "text"));
    persistSessionFork(A, "sa", "sb", "b1", null, 0, "/tmp");
    persistSessionFork(A, "sb", "sa", "a1", null, 0, "/tmp");
    const out = loadLogWithAncestors(A, "sa");
    // Finite + deterministic; the leaf's own entry is present. We do not overfit
    // the exact ancestor-dedup order under a cycle (not a real-world shape).
    expect(Array.isArray(out)).toBe(true);
    expect(out.some((e) => e.id === "a1")).toBe(true);
  });

  it("takes the ENTIRE ancestor prefix when the fork link has no forkMessageId", () => {
    appendLog(A, "parent", le(A, "p1", "user_message"));
    appendLog(A, "parent", le(A, "p2", "text"));
    appendLog(A, "child", le(A, "c1", "text"));
    // Fork link with forkMessageId ABSENT (legacy/edge shape). The cutoff loop
    // breaks only on a matching entry id, so an undefined cutoff matches nothing
    // and the whole parent prefix is taken.
    seedSessionsMapRaw(A, {
      child: { forkedFrom: "parent", topic: null, lastModified: 0 },
    });
    expect(loadLogWithAncestors(A, "child").map((e) => e.id)).toEqual([
      "p1",
      "p2",
      "c1",
    ]);
  });
});

// ===========================================================================
// B1 — usage accounting math, direct-call seam
// ===========================================================================

describe("B1 accumulateSessionUsage (Phase 1.4a)", () => {
  const A = "agent-acc";

  it("sums token fields across turns and overwrites cost (cumulative-per-process)", () => {
    accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 2,
      },
      1.0,
    );
    const cumulative = accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 4,
      },
      2.5,
    );
    // Tokens summed across the two real calls; cost overwritten to the latest.
    expect(cumulative).toEqual(usage(13, 7, 8, 6, 2.5));
    expect(loadSessionsMap(A)["s"].usage).toEqual(usage(13, 7, 8, 6, 2.5));
  });
});

describe("B1 rollSessionUsageOnResume (Phase 1.4a)", () => {
  const A = "agent-roll";

  it("rolls current-run usage into priorRunsUsage and clears usage", () => {
    accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 2,
      },
      1.5,
    );
    rollSessionUsageOnResume(A, "s");
    const m = loadSessionsMap(A)["s"];
    expect(m.usage).toBeUndefined();
    expect(m.priorRunsUsage).toEqual(usage(10, 5, 7, 2, 1.5));
  });

  it("sums into an existing priorRunsUsage across multiple resumes", () => {
    accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1.0,
    );
    rollSessionUsageOnResume(A, "s"); // prior = run1
    accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 4,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      2.0,
    );
    rollSessionUsageOnResume(A, "s"); // prior = run1 + run2
    const m = loadSessionsMap(A)["s"];
    expect(m.usage).toBeUndefined();
    expect(m.priorRunsUsage).toEqual(usage(14, 8, 0, 0, 3.0));
  });

  it("is a no-op when there is no current-run usage", () => {
    rollSessionUsageOnResume(A, "missing");
    expect(loadSessionsMap(A)["missing"]).toBeUndefined();
  });
});

describe("B1 appendSessionUsageSnapshot (Phase 1.4a)", () => {
  const A = "agent-snap";

  it("appends a snapshot per anchor, coalescing only CONSECUTIVE same-entryId writes", () => {
    appendSessionUsageSnapshot(A, "s", "e1", usage(1, 0, 0, 0, 0.1));
    appendSessionUsageSnapshot(A, "s", "e2", usage(2, 0, 0, 0, 0.2));
    // Consecutive same anchor -> overwrites the last snapshot in place.
    appendSessionUsageSnapshot(A, "s", "e2", usage(3, 0, 0, 0, 0.3));
    // Non-consecutive repeat of e1 -> pushes a NEW snapshot (pins "consecutive",
    // not "unique by entryId").
    appendSessionUsageSnapshot(A, "s", "e1", usage(4, 0, 0, 0, 0.4));

    const snaps = loadSessionsMap(A)["s"].usageSnapshots!;
    expect(snaps.map((s) => s.entryId)).toEqual(["e1", "e2", "e1"]);
    expect(snaps[1].usage).toEqual(usage(3, 0, 0, 0, 0.3)); // coalesced
    expect(snaps[2].usage).toEqual(usage(4, 0, 0, 0, 0.4)); // new
  });
});

describe("B1 findUsageAtFork (Phase 1.4a)", () => {
  const A = "agent-fuf";

  function seedParentLog() {
    appendLog(A, "parent", le(A, "p1", "user_message"));
    appendLog(A, "parent", le(A, "p2", "user_message"));
    appendLog(A, "parent", le(A, "p3", "user_message"));
  }

  it("returns the latest snapshot strictly BEFORE the fork point (equality excluded)", () => {
    seedParentLog();
    appendSessionUsageSnapshot(A, "parent", "p1", usage(100, 10, 0, 0, 1.0));
    appendSessionUsageSnapshot(A, "parent", "p2", usage(200, 20, 0, 0, 2.0));

    // Fork at p3: latest snapshot before p3 is the one anchored at p2.
    expect(findUsageAtFork(A, "parent", "p3")).toEqual(
      usage(200, 20, 0, 0, 2.0),
    );
    // Fork at p2: a snapshot anchored exactly ON p2 is NOT eligible (strict <),
    // so the p1 snapshot wins. This guards against a regression to <=.
    expect(findUsageAtFork(A, "parent", "p2")).toEqual(
      usage(100, 10, 0, 0, 1.0),
    );
  });

  it("falls back to the parent cumulative (usage + priorRunsUsage) when no snapshot precedes the fork", () => {
    seedParentLog();
    // priorRunsUsage from a prior run, plus a current-run usage; no snapshots.
    accumulateSessionUsage(
      A,
      "parent",
      {
        inputTokens: 50,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1.0,
    );
    rollSessionUsageOnResume(A, "parent"); // prior = (50,5,..,1.0)
    accumulateSessionUsage(
      A,
      "parent",
      {
        inputTokens: 20,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      3.0,
    );
    // Fork at p1: no snapshot anchored before p1 -> fallback sums prior + usage.
    expect(findUsageAtFork(A, "parent", "p1")).toEqual(usage(70, 7, 0, 0, 4.0));
  });

  it("returns undefined when the fork message id is not in the parent log", () => {
    seedParentLog();
    appendSessionUsageSnapshot(A, "parent", "p1", usage(1, 1, 0, 0, 0.1));
    expect(findUsageAtFork(A, "parent", "not-there")).toBeUndefined();
  });
});

// ===========================================================================
// B1 — usage-report lifetime/session math (readAgentUsage), direct-call seam
// ===========================================================================

describe("B1 readAgentUsage (Phase 1.4a)", () => {
  const A = "agent-report";

  it("subtracts each fork's base so a parent+fork pair is not double-counted", () => {
    // Parent: 100 in / 50 out / $1, no fork base.
    accumulateSessionUsage(
      A,
      "parent",
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1.0,
    );
    // Fork: cumulative 130 in / 60 out / $1.3, but forkBaseUsage 100/50/$1 means
    // it only contributed 30 in / 10 out / $0.3 of new work.
    accumulateSessionUsage(
      A,
      "fork",
      {
        inputTokens: 130,
        outputTokens: 60,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      1.3,
    );
    persistSessionFork(
      A,
      "fork",
      "parent",
      "p2",
      null,
      0,
      "/tmp",
      usage(100, 50, 0, 0, 1.0),
    );

    const { lifetime, session } = readAgentUsage(A, "fork");
    // lifetime = parent (100/50/$1) + fork-minus-base (30/10/$0.3).
    expect(lifetime.totalIn).toBe(130);
    expect(lifetime.totalOut).toBe(60);
    expect(lifetime.costUSD).toBeCloseTo(1.3, 5);
    // session = the current (fork) session's full cumulative, no base subtraction.
    expect(session.totalIn).toBe(130);
    expect(session.totalOut).toBe(60);
    expect(session.costUSD).toBeCloseTo(1.3, 5);
  });

  it("rolls cacheRead/cacheCreation into totalIn and reports priorRunsUsage", () => {
    accumulateSessionUsage(
      A,
      "s",
      {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 5,
      },
      0.5,
    );
    rollSessionUsageOnResume(A, "s"); // becomes priorRunsUsage
    const { session, lifetime } = readAgentUsage(A, "s");
    // totalIn = input + cacheRead + cacheCreation = 10 + 90 + 5.
    expect(session.totalIn).toBe(105);
    expect(session.cacheRead).toBe(90);
    expect(session.cacheCreation).toBe(5);
    expect(session.totalOut).toBe(4);
    expect(lifetime.totalIn).toBe(105);
  });
});

// ===========================================================================
// B2 — orchestrated wiring (DI manager seam: createAgentManager + FakeBackend
//       + event sink). Drive one orchestrator event, read sessions.json + the
//       captured events. No WS boundary needed, so this is lighter/more
//       deterministic than the harness for usage/fork wiring.
// ===========================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id) => ({ id, name: id, prompt: null }));
}

function capture() {
  const events: Parameters<EventHandler>[0][] = [];
  const sink: EventHandler = (e) => events.push(e);
  return { events, sink };
}

function makeManager(fake: FakeBackend, sink: EventHandler) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
    eventSink: sink,
  });
  // Production wires this at boot (index.ts); the DI seam must too, or the first
  // turn throws "plugin-hooks not configured". The deps are a process-global, so
  // each manager (serial tests) rebinds it on construction.
  mgr.configurePluginHooksDeps();
  activeFakes.push(fake);
  return mgr;
}

// Loose accessor for captured domain events (the EventHandler param is a wide
// discriminated union; tests only read a few fields).
type AnyEvent = {
  type?: string;
  agentId?: string;
  entry?: { agentId?: string; id?: string; content?: string; kind?: string };
};

function claudeHome(): string {
  return join(STATE_ROOT, "claude-home");
}

// Point the agent env's CLAUDE_CONFIG_DIR at a temp dir via a temp office env
// file, so the orchestrator's resume/fork preflight checks the temp tree (never
// the real ~/.claude). buildEnvForUserId merges the office env file over
// process.env, so this reaches createSession's preflight.
function wireClaudeConfigDir(): void {
  const envFile = join(STATE_ROOT, "office.env");
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome()}\n`);
  setOfficeEnvFileProvider(() => envFile);
}

// Satisfy the explicit-resume/fork preflight by touching the provider session
// file createSession checks (existence-only), under the temp CLAUDE_CONFIG_DIR.
function seedClaudeSession(cwd: string, sessionId: string): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

function turnUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

describe("B2 turn_completed -> accumulate + snapshot (Phase 1.4a)", () => {
  it("accumulates the turn usage and anchors the snapshot to the LAST written log entry", async () => {
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) =>
          s.completeTurn({ text: "reply", usage: turnUsage(12, 7), cost: 0.9 }),
      },
    });
    const { sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    ))!;
    const sid = fake.sessionForAgent(info.id)!.sessionId;

    await mgr.sendMessage(info.id, "hi");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[sid]?.usage,
      2000,
      "usage persisted",
    );

    const m = loadSessionsMap(info.id)[sid];
    expect(m.usage).toEqual(usage(12, 7, 0, 0, 0.9));

    // The snapshot anchor is the id of the LAST log entry written before the
    // turn boundary (the assistant text), not merely "a snapshot exists" — this
    // is what keeps fork accounting exact.
    const log = loadLog(info.id, sid);
    expect(log.at(-1)!.kind).toBe("text");
    expect(log.at(-1)!.content).toBe("reply");
    expect(m.usageSnapshots!.at(-1)!.entryId).toBe(log.at(-1)!.id);
  });
});

describe("B2 resume -> roll usage + replay ancestors (Phase 1.4a)", () => {
  it("rolls usage into priorRunsUsage and emits clear_logs before the replayed log_entry stream", async () => {
    wireClaudeConfigDir();
    const fake = new FakeBackend({
      session: {
        onSend: (_t, _a, s) =>
          s.completeTurn({ text: "reply", usage: turnUsage(20, 8), cost: 1.1 }),
      },
    });
    const { events, sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    ))!;
    const sid = fake.sessionForAgent(info.id)!.sessionId;

    await mgr.sendMessage(info.id, "hi");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[sid]?.usage,
      2000,
      "usage persisted",
    );

    seedClaudeSession(info.cwd, sid);
    events.length = 0; // observe only resume's events

    await mgr.resume(info.id, sid);
    await waitUntil(
      () => loadSessionsMap(info.id)[sid]?.usage === undefined,
      2000,
      "usage rolled",
    );

    // usage rolled into priorRunsUsage (so lifetime cost survives the SDK's
    // per-process counter reset).
    const m = loadSessionsMap(info.id)[sid];
    expect(m.priorRunsUsage).toEqual(usage(20, 8, 0, 0, 1.1));

    // The UI-facing replay: clear_logs precedes the replayed log_entry events.
    const evs = events as AnyEvent[];
    const clearIdx = evs.findIndex(
      (e) => e.type === "clear_logs" && e.agentId === info.id,
    );
    const logIdx = evs.findIndex(
      (e) => e.type === "log_entry" && e.entry?.agentId === info.id,
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeGreaterThan(clearIdx);
  });
});

describe("B2 editMessage -> persistSessionFork base accounting (Phase 1.4a)", () => {
  // The fake's session counter is deterministic: spawn's createSession is the
  // first, so the parent session id is always "fake-session-1". We wire the fork
  // result's forkedFromSessionId to it and seed the fork session's provider file
  // so editMessage's createSession(fork) preflight passes.
  const PARENT_SID = "fake-session-1";
  const FORK_SID = "forked-1";

  function editFake() {
    return new FakeBackend({
      session: {
        onSend: (_t, _a, s) =>
          s.completeTurn({ text: "reply", usage: turnUsage(10, 5), cost: 1.0 }),
      },
      sessionMessages: [
        { uuid: "u-first", role: "user", text: "first" },
        { uuid: "a-1", role: "assistant", text: "reply" },
        { uuid: "u-second", role: "user", text: "second" },
        { uuid: "a-2", role: "assistant", text: "reply" },
      ],
      forkResult: {
        kind: "fork",
        sessionId: FORK_SID,
        forkedFromSessionId: PARENT_SID,
      },
    });
  }

  async function seedTwoTurnAgent(
    mgr: ReturnType<typeof makeManager>,
    fake: FakeBackend,
  ) {
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    ))!;
    expect(fake.sessionForAgent(info.id)!.sessionId).toBe(PARENT_SID); // determinism sanity
    await mgr.sendMessage(info.id, "first");
    await mgr.sendMessage(info.id, "second");
    await waitUntil(
      () =>
        loadLog(info.id, PARENT_SID).filter((e) => e.kind === "user_message")
          .length === 2 &&
        mgr.getAgent(info.id)?.state === "waiting_for_response",
      3000,
      "two turns settled",
    );
    return info;
  }

  function userMsgId(agentId: string, content: string): string {
    const e = loadLog(agentId, PARENT_SID).find(
      (x) => x.kind === "user_message" && x.content === content,
    );
    if (!e) throw new Error(`no user_message "${content}"`);
    return e.id;
  }

  it("omits forkBaseUsage for a first-user-message edit (child starts from empty context)", async () => {
    wireClaudeConfigDir();
    const fake = editFake();
    const { sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = await seedTwoTurnAgent(mgr, fake);
    seedClaudeSession(info.cwd, FORK_SID);

    await mgr.editMessage(info.id, userMsgId(info.id, "first"), "edited first");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );

    const forkMeta = loadSessionsMap(info.id)[FORK_SID];
    expect(forkMeta.forkedFrom).toBe(PARENT_SID);
    expect(forkMeta.forkBaseUsage).toBeUndefined();
  });

  it("captures forkBaseUsage from findUsageAtFork for a non-first edit (normal fork accounting)", async () => {
    wireClaudeConfigDir();
    const fake = editFake();
    const { sink } = capture();
    const mgr = makeManager(fake, sink);
    const info = await seedTwoTurnAgent(mgr, fake);
    seedClaudeSession(info.cwd, FORK_SID);

    await mgr.editMessage(
      info.id,
      userMsgId(info.id, "second"),
      "edited second",
    );
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );

    const forkMeta = loadSessionsMap(info.id)[FORK_SID];
    expect(forkMeta.forkedFrom).toBe(PARENT_SID);
    // forkBaseUsage = the parent's cumulative at the fork point = turn 1's usage
    // (the snapshot anchored before "second"). Token sums; cost is the latest.
    expect(forkMeta.forkBaseUsage).toEqual(usage(10, 5, 0, 0, 1.0));
  });
});
