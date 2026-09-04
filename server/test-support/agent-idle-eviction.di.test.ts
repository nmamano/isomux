// DI unit tests for idle eviction / lazy demotion (Track B: memory efficiency).
// Exercises demoteToLazy, the canDemote guard, sweepIdleAgents, and the
// dormant -> wake roundtrip against the FakeBackend (zero LLM / provider calls).
// Pins the manager-internal lifecycle invariants Reviewer5 flagged: demote keeps
// the agent on its desk with a resumable session, wake resumes the SAME thread
// (not a fresh one), demote does NOT revoke the token (kill does), and the sweep
// honors the idle threshold. Lazy-restore + full inter-agent HTTP routing are
// covered at the harness layer.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { claudeProjectDir } from "../cwd-utils.ts";

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  label = "cond",
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

const claudeHome = () => join(STATE_ROOT, "claude-home-idle-evict");

// Point the agent env's CLAUDE_CONFIG_DIR at a temp dir via the managed office
// env file, so the Claude resume preflight (claudeSessionFileExists) consults
// a path we control instead of the host ~/.claude.
function wireClaudeConfigDir(): void {
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
}

// Touch the existence-only session file createSession checks on resume.
// `content` also feeds claudeSessionInterruptedByShutdown, which reads the
// file's last line to decide whether the wake-up message may speak
// categorically about the fake "user rejected" result (task e06b7e23).
function seedClaudeSession(cwd: string, sessionId: string, content = ""): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), content);
}

// A transcript whose last entry carries the SIGTERM marker the Claude CLI
// stamps when it cuts a turn short - the entry whose tool result claims the
// user rejected the running tool.
const SHUTDOWN_TRANSCRIPT =
  JSON.stringify({ type: "user", interruptedByShutdown: false }) +
  "\n" +
  JSON.stringify({
    type: "user",
    interruptedByShutdown: true,
    message: { content: [{ type: "tool_result", content: "user rejected" }] },
  }) +
  "\n";

// Phrases the wake-up message is built from. Kept as constants so a reworded
// message fails these tests loudly instead of silently passing a stale check.
const WAKE_RESTART = "Resumed your session after the server restarted.";
const WAKE_STREAM_END =
  "Resumed your session after the backend ended unexpectedly.";
const WAKE_PARTIAL =
  "Any command that was in flight may have partially run; verify its effects before retrying.";
// The rejection clause appears ONLY when the transcript proves the shutdown
// (Nil 2026-08-05: do not explain a rejection that may not be there), so
// unproven wakes must carry no rejection wording at all.
const WAKE_REJECTION_TALK = "rejected";
const WAKE_CATEGORICAL = "is from the shutdown, not a human";
// The built-in envelope block runAgentTurn wraps the note in on its way to the
// backend (plugin-hooks.ts). Its presence in a sent prompt is what proves the
// AGENT was told, not just the isomux log.
const WAKE_BLOCK_OPEN = "--- begin isomux: wake-notice ---";

function logText(
  mgr: ReturnType<typeof createAgentManager>,
  id: string,
): string {
  return mgr
    .getAgentLogs(id)
    .map((e) => String(e.content ?? ""))
    .join("\n");
}

// A FakeBackend whose every send auto-completes the turn. Lazy spawn means an
// agent has no live session until its first message, so these tests WAKE agents
// to get a live, demotable session - and a wake runs a real turn. Without a
// turn-completing onSend the woken agent would park in waiting_for_response
// (canDemote would fail for the WRONG reason, masking real regressions); with
// it the agent returns to a queue-idle state, i.e. genuinely demotable.
function makeFake(): FakeBackend {
  return new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
}

function makeManager(fake: FakeBackend) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
  });
  // Waking an agent runs runAgentTurn, which throws unless turn-runner deps are
  // configured. Production wires this at boot (isomux-office.ts); the bare DI manager
  // must do it itself. The module-global is re-pointed per test (makeManager
  // runs per test) and harness tests reconfigure it to their own manager, so
  // this stays deterministic within the file.
  mgr.configureAgentTurnDeps();
  return mgr;
}

function persistedAgent(id: string, lastSessionId: string | null) {
  return {
    id,
    name: id,
    desk: 0,
    cwd: STATE_ROOT,
    outfit: {
      hat: "none" as const,
      color: "#ffffff",
      hair: "#000000",
      hairStyle: "short" as const,
      skin: "#ffffff",
      beard: "none" as const,
      accessory: null,
    },
    permissionMode: "default" as const,
    modelFamily: "opencode/fake",
    agentType: "opencode" as const,
    lastSessionId,
    topic: null,
    customInstructions: null,
    userId: null,
    username: null,
  };
}

async function spawnReady(
  mgr: ReturnType<typeof createAgentManager>,
  name: string,
): Promise<string> {
  const info = await mgr.spawn(
    name,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  );
  if (!info) throw new Error("spawn returned null");
  // Lazy spawn holds NO subprocess. Wake the agent with a message so it installs
  // a fresh live session and - thanks to makeFake's turn-completing send -
  // returns to idle (demotable). After this it has createSessionCount === 1 and
  // resumeSessionCount === 0, exactly as eager spawn used to leave it.
  const r = mgr.enqueueMessage(info.id, {
    sender: { kind: "user", username: "tester" },
    text: "wake",
  });
  if (!r.ok) throw new Error("wake enqueue failed");
  await waitUntil(
    () => isLiveAndDemotable(mgr, info.id),
    `${name} live+demotable`,
  );
  return info.id;
}

// A woken agent that finished its turn lands in "waiting_for_response" (it
// answered, now awaits the next message), NOT "idle" - and BOTH are queue-idle
// states that canDemote accepts (isQueueIdleState). So "demotable" means: has a
// live session (not dormant) and is in a queue-idle state.
const QUEUE_IDLE_STATES = new Set(["idle", "waiting_for_response"]);
function isLiveAndDemotable(
  mgr: ReturnType<typeof createAgentManager>,
  id: string,
): boolean {
  const a = mgr.getAgent(id);
  return (
    mgr.getCurrentSessionId(id) !== null &&
    (a?.dormant ?? false) === false &&
    QUEUE_IDLE_STATES.has(a?.state ?? "")
  );
}

afterEach(() => {
  // env-loader's office-env provider is a process global; reset so other test
  // files don't inherit our temp CLAUDE_CONFIG_DIR.
  clearTestManagedOfficeEnv();
});

describe("idle eviction - demote / dormant / wake", () => {
  it("demotes an idle agent to lazy, then wakes it by resuming the SAME session", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    expect(sid).not.toBeNull();
    expect(mgr.getAgent(id)?.dormant ?? false).toBe(false);
    expect(fake.createSessionCount).toBe(1);
    expect(fake.resumeSessionCount).toBe(0);

    // Demote: subprocess closed, agent stays on its desk, dormant. State is
    // unchanged by demote - a woken-then-quiet agent sits in waiting_for_response
    // (a queue-idle state), which is exactly what canDemote accepts.
    expect(await mgr.demoteToLazy(id)).toBe(true);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    expect(QUEUE_IDLE_STATES.has(mgr.getAgent(id)?.state ?? "")).toBe(true);
    expect(fake.resumeSessionCount).toBe(0); // no new subprocess yet

    // Demote must NOT revoke the bearer token (kill does) - wake reuses it.
    expect(getAgentTokenRaw(id)).toBeTruthy();

    // Seed the on-disk session file so the resume preflight passes, then wake
    // via an inter-agent message: resumes the same thread, clears dormant.
    seedClaudeSession(STATE_ROOT, sid!);
    const r = mgr.enqueueMessage(id, {
      sender: {
        kind: "agent",
        agentId: "x",
        agentName: "X",
        roomName: "room-a",
      },
      text: "ping",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "woke from dormant",
    );
    expect(fake.resumeSessionCount).toBe(1); // resumed, not started fresh
    expect(fake.createSessionCount).toBe(1); // still only the original create
    expect(mgr.getCurrentSessionId(id)).toBe(sid); // same session id preserved
    // A clean idle-wake gets the calm message, NOT the alarming crash wording.
    const logs = mgr.getAgentLogs(id);
    expect(
      logs.some((e) => String(e.content ?? "").includes("released while idle")),
    ).toBe(true);
    expect(
      logs.some((e) => String(e.content ?? "").includes("ended unexpectedly")),
    ).toBe(false);
    fake.lastSession?.close();
  });

  it("textarea-path wake of a dormant agent uses the calm message, not the crash wording", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    seedClaudeSession(STATE_ROOT, sid!);
    expect(await mgr.demoteToLazy(id)).toBe(true);
    // sendMessage is the WS textarea path - the one that showed "ended
    // unexpectedly" before the fix. Fire-and-forget: the wake (installSession +
    // the system message) lands early in sendMessage's flow; we don't await the
    // turn itself, which would hang on the no-op FakeBackend when the turn runner
    // happen to be globally configured by another test in the shared process.
    void mgr.sendMessage(id, "hi", "tester").catch(() => {});
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "woke via textarea path",
    );
    const logs = mgr.getAgentLogs(id);
    expect(
      logs.some((e) => String(e.content ?? "").includes("released while idle")),
    ).toBe(true);
    expect(
      logs.some((e) => String(e.content ?? "").includes("ended unexpectedly")),
    ).toBe(false);
    fake.lastSession?.close();
  });

  it("a message racing demote leaves the agent awake on the same session (no clobber)", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    seedClaudeSession(STATE_ROOT, sid!);
    // Start demote and enqueue a message without awaiting the drain. demote nulls
    // the session synchronously then awaits the old consumer; the message's
    // flushQueue sees !session and wakes a fresh session during that await.
    // demote touches nothing after the await, so the end state must be: awake,
    // same thread, exactly one resume, never error/corrupt.
    const demote = mgr.demoteToLazy(id);
    const r = mgr.enqueueMessage(id, {
      sender: {
        kind: "agent",
        agentId: "x",
        agentName: "X",
        roomName: "room-a",
      },
      text: "ping",
    });
    expect(r.ok).toBe(true);
    expect(await demote).toBe(true);
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "awake after racing demote",
    );
    // Anti-clobber invariants: woke onto the SAME thread, via exactly one resume,
    // with no extra fresh session - the demote's post-await body never stomped
    // the concurrent wake.
    expect(mgr.getCurrentSessionId(id)).toBe(sid);
    expect(fake.resumeSessionCount).toBe(1);
    expect(fake.createSessionCount).toBe(1);
    fake.lastSession?.close();
  });

  it("does not re-demote an already-dormant agent", async () => {
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    expect(await mgr.demoteToLazy(id)).toBe(true);
    // session === null now → canDemote is false, second call is a no-op.
    expect(await mgr.demoteToLazy(id)).toBe(false);
    expect(fake.resumeSessionCount).toBe(0);
  });

  it("boot lazy-restore: restores agents dormant with NO subprocess, then wakes on message", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const sid = "fake-session-restore";
    const persisted = {
      id: "agent-test-lazy",
      name: "Lazy",
      desk: 0,
      cwd: STATE_ROOT,
      outfit: {
        hat: "none" as const,
        color: "#ffffff",
        hair: "#000000",
        hairStyle: "short" as const,
        skin: "#ffffff",
        beard: "none" as const,
        accessory: null,
      },
      permissionMode: "default" as const,
      modelFamily: "opus",
      agentType: "claude" as const,
      lastSessionId: sid,
      topic: null,
      customInstructions: null,
      userId: null,
      username: null,
    };
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [
        { id: "room-a", name: "room-a", prompt: null, agents: [persisted] },
      ],
    });
    // This test builds its own manager (custom initialRooms), so wire turn-runner
    // deps here too - the wake below runs a turn.
    mgr.configureAgentTurnDeps();

    await mgr.restoreAgents();

    // The deploy-critical assertion: lazy restore spawns ZERO subprocesses.
    expect(fake.createSessionCount).toBe(0);
    expect(fake.resumeSessionCount).toBe(0);
    const info = mgr.getAgent("agent-test-lazy");
    expect(info).toBeDefined();
    expect(info?.dormant).toBe(true);
    // Restored WITH a resumable session: comes back "waiting_for_response"
    // (finished its last turn, waiting on the human), NOT the sleeping "idle"
    // pose. The pose tracks whether there's a conversation, not whether the
    // subprocess is loaded - dormant=true above still reflects the no-subprocess
    // reality, independently of the pose.
    expect(info?.state).toBe("waiting_for_response");
    expect(mgr.getCurrentSessionId("agent-test-lazy")).toBe(sid);

    // First message wakes it by resuming the persisted session (not a fresh one).
    seedClaudeSession(STATE_ROOT, sid);
    const r = mgr.enqueueMessage("agent-test-lazy", {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => (mgr.getAgent("agent-test-lazy")?.dormant ?? false) === false,
      "lazy-restored agent woke",
    );
    expect(fake.resumeSessionCount).toBe(1);
    expect(fake.createSessionCount).toBe(0); // resumed, never created fresh
    // A lazy-restore wake is worded for a restart, NOT "while idle".
    const logs = mgr.getAgentLogs("agent-test-lazy");
    expect(
      logs.some((e) =>
        String(e.content ?? "").includes("after the server restarted"),
      ),
    ).toBe(true);
    expect(
      logs.some((e) => String(e.content ?? "").includes("while idle")),
    ).toBe(false);
    fake.lastSession?.close();
  });

  it("does NOT demote a Codex agent with no durable rollout (would wake context-less)", async () => {
    const fake = new FakeBackend({
      storedSessionState: "missing",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const mgr = makeManager(fake);
    const info = await mgr.spawn(
      "C",
      STATE_ROOT,
      "on-request",
      undefined,
      undefined,
      "room-a",
      undefined,
      "gpt-5.5",
      undefined,
      undefined,
      "codex",
    );
    if (!info) throw new Error("spawn returned null");
    // Lazy spawn: wake it so it has a LIVE, idle session. The agent must be idle
    // so the ONLY reason demote can refuse is the missing durable rollout - not
    // a non-idle state, which would mask the durability gate this test pins.
    const wake = mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "tester" },
      text: "wake",
    });
    if (!wake.ok) throw new Error("wake enqueue failed");
    await waitUntil(
      () => isLiveAndDemotable(mgr, info.id),
      "codex live+demotable",
    );
    // No durable rollout in backend state → pickAutoResumeSessionId returns null → the
    // guard refuses to demote (demoting would lose context on wake). This is the
    // entire safety justification for including Codex in the sweep.
    expect(await mgr.demoteToLazy(info.id)).toBe(false);
    expect(mgr.getAgent(info.id)?.dormant ?? false).toBe(false);
    fake.lastSession?.close();
  });

  it("sweepIdleAgents honors the idle threshold", async () => {
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    // Just-active agent: a 60s threshold demotes nobody.
    expect(await mgr.sweepIdleAgents(60_000)).toBe(0);
    expect(mgr.getAgent(id)?.dormant ?? false).toBe(false);
    // Zero threshold: every idle resumable agent demotes.
    expect(await mgr.sweepIdleAgents(0)).toBe(1);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    // Idempotent: a second sweep finds nothing live to demote.
    expect(await mgr.sweepIdleAgents(0)).toBe(0);
  });
});

describe("lazy spawn / release-on-clear - blank agents hold no subprocess", () => {
  it("a never-started agent stays a silent fresh wake across boot restore", async () => {
    const fake = makeFake();
    const id = "agent-never-started";
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [
        {
          id: "room-a",
          name: "room-a",
          prompt: null,
          agents: [persistedAgent(id, null)],
        },
      ],
    });
    mgr.configureAgentTurnDeps();

    await mgr.restoreAgents();
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    expect(mgr._testDormantReason(id)).toBe("fresh");
    expect(mgr.getCurrentSessionId(id)).toBeNull();

    const sent = mgr.sendMessage(id, "hello", "tester");
    await waitUntil(() => isLiveAndDemotable(mgr, id), "blank restore woke");
    await sent;
    expect(fake.createSessionCount).toBe(1);
    expect(fake.resumeSessionCount).toBe(0);
    expect(logText(mgr, id)).not.toContain(
      "Started a fresh session (previous one could not be restored).",
    );
    expect(logText(mgr, id)).not.toContain("Resumed");
    fake.lastSession?.close();
  });

  it("a lost prior session still reports the fresh recovery after boot restore", async () => {
    const fake = new FakeBackend({
      storedSessionState: "missing",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const id = "agent-lost-session";
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [
        {
          id: "room-a",
          name: "room-a",
          prompt: null,
          agents: [persistedAgent(id, "missing-session")],
        },
      ],
    });
    mgr.configureAgentTurnDeps();

    await mgr.restoreAgents();
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    expect(mgr._testDormantReason(id)).toBe("boot");
    expect(mgr.getCurrentSessionId(id)).toBeNull();

    const sent = mgr.sendMessage(id, "hello", "tester");
    await waitUntil(() => isLiveAndDemotable(mgr, id), "lost restore woke");
    await sent;
    expect(fake.createSessionCount).toBe(1);
    expect(fake.resumeSessionCount).toBe(0);
    expect(logText(mgr, id)).toContain(
      "Started a fresh session (previous one could not be restored).",
    );
    fake.lastSession?.close();
  });

  it("lazy spawn holds NO subprocess; first message wakes a FRESH session, silently", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const info = await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    );
    if (!info) throw new Error("spawn returned null");
    // The whole point: a brand-new agent costs ZERO subprocess until used.
    expect(fake.createSessionCount).toBe(0);
    expect(fake.resumeSessionCount).toBe(0);
    expect(mgr.getAgent(info.id)?.dormant).toBe(true);
    expect(mgr.getAgent(info.id)?.state).toBe("idle");
    expect(mgr.getCurrentSessionId(info.id)).toBeNull(); // no session at all yet

    // First message wakes it: a fresh session is CREATED (a new agent has no
    // thread on disk to resume).
    const r = mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "tester" },
      text: "hi",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => isLiveAndDemotable(mgr, info.id),
      "lazy-spawned agent woke",
    );
    expect(fake.createSessionCount).toBe(1);
    expect(fake.resumeSessionCount).toBe(0);

    // The wake is SILENT: a brand-new blank conversation announces neither
    // "Started a fresh session…" nor "Resumed…" (those would be NEW noise - the
    // old eager path hit an already-live session and logged nothing). The
    // pre-wake "ready" action-feedback line stays.
    const logs = mgr.getAgentLogs(info.id);
    expect(
      logs.some((e) =>
        String(e.content ?? "").includes("Started a fresh session"),
      ),
    ).toBe(false);
    expect(logs.some((e) => String(e.content ?? "").includes("Resumed"))).toBe(
      false,
    );
    expect(
      logs.some((e) => String(e.content ?? "").includes("ready. Working in")),
    ).toBe(true);
    fake.lastSession?.close();
  });

  it("surfaces an invalid cwd at spawn time, leaving the agent in error (not dormant, no subprocess)", async () => {
    const fake = makeFake();
    const mgr = makeManager(fake);
    const info = await mgr.spawn(
      "BadCwd",
      "/no/such/dir/anywhere",
      "default",
      undefined,
      undefined,
      "room-a",
    );
    if (!info) throw new Error("spawn returned null");
    // Lazy spawn defers createSession to first message, but a cheap spawn-time
    // validateCwd still surfaces an obviously-bad cwd immediately rather than
    // deferring the error to the first message. The agent lands in error (NOT
    // dormant - an errored agent isn't a releasable blank) with no subprocess.
    expect(fake.createSessionCount).toBe(0);
    expect(mgr.getAgent(info.id)?.state).toBe("error");
    expect(mgr.getAgent(info.id)?.dormant ?? false).toBe(false);
    expect(
      mgr
        .getAgentLogs(info.id)
        .some(
          (e) =>
            e.kind === "error" &&
            String(e.content ?? "").includes("Failed to start"),
        ),
    ).toBe(true);
  });

  it("release-on-clear: /clear closes the subprocess and goes dormant; next message wakes a FRESH blank session", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A"); // live, createSessionCount === 1
    expect(fake.createSessionCount).toBe(1);
    expect(mgr.getAgent(id)?.dormant ?? false).toBe(false);

    // /clear RELEASES the subprocess instead of installing a fresh live one.
    await mgr.newConversation(id);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    expect(mgr.getCurrentSessionId(id)).toBeNull(); // thread blanked
    expect(fake.createSessionCount).toBe(1); // NO new subprocess on clear
    expect(fake.resumeSessionCount).toBe(0);
    // Action-feedback line stays (added pre-drain, after the log wipe).
    expect(
      mgr
        .getAgentLogs(id)
        .some((e) =>
          String(e.content ?? "").includes("New conversation started."),
        ),
    ).toBe(true);

    // Next message wakes a FRESH session (created, not resuming the cleared
    // thread), silently.
    const r = mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "hi again",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => isLiveAndDemotable(mgr, id),
      "cleared agent woke fresh",
    );
    expect(fake.createSessionCount).toBe(2); // brand-new session, not a resume
    expect(fake.resumeSessionCount).toBe(0);
    const logs = mgr.getAgentLogs(id);
    expect(
      logs.some((e) =>
        String(e.content ?? "").includes("Started a fresh session"),
      ),
    ).toBe(false);
    expect(logs.some((e) => String(e.content ?? "").includes("Resumed"))).toBe(
      false,
    );
    fake.lastSession?.close();
  });

  it("lazy spawn composes with the idle sweep: never-messaged agent is skipped, then demotable after waking", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const info = await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    );
    if (!info) throw new Error("spawn returned null");
    // Already dormant (session === null) → the sweep skips it even at a zero
    // threshold; there is nothing to release.
    expect(await mgr.sweepIdleAgents(0)).toBe(0);
    expect(mgr.getAgent(info.id)?.dormant).toBe(true);
    expect(fake.createSessionCount).toBe(0);

    // Wake it, then a zero-threshold sweep NOW demotes it - proving lazy spawn
    // and the sweep compose (spawn skipped, the woken agent later reclaimed).
    const r = mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "tester" },
      text: "hi",
    });
    expect(r.ok).toBe(true);
    await waitUntil(() => isLiveAndDemotable(mgr, info.id), "woke");
    expect(await mgr.sweepIdleAgents(0)).toBe(1);
    expect(mgr.getAgent(info.id)?.dormant).toBe(true);
    fake.lastSession?.close();
  });

  it("a human message racing /clear wakes a FRESH blank session via the recovery path (no clobber, no resume)", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    expect(fake.createSessionCount).toBe(1);

    // Start /clear and a human message WITHOUT awaiting the drain. clear blanks
    // sessionId and nulls the live session synchronously, then awaits the
    // consumer drain; the racing message sees session===null and wakes a FRESH
    // session via sendMessage's recovery branch (sessionId null → created, never
    // resuming the just-cleared thread). clear's post-drain body is empty, so it
    // cannot stomp that concurrent wake. Covers the sendMessage wake path (the
    // demote-race test covers the flushQueue path).
    const clear = mgr.newConversation(id);
    void mgr.sendMessage(id, "hi", "tester").catch(() => {});
    await clear;
    await waitUntil(
      () => isLiveAndDemotable(mgr, id),
      "awake on fresh session after racing clear",
    );
    // Woke onto a NEW blank session: a second create, zero resumes.
    expect(fake.resumeSessionCount).toBe(0);
    expect(fake.createSessionCount).toBe(2);
    expect(mgr.getAgent(id)?.dormant ?? false).toBe(false);
    fake.lastSession?.close();
  });
});

describe("skill dispatch on a dormant agent", () => {
  // Create a file-based skill so `/<name>` resolves via resolveSkillPrompt ->
  // executeSkill (the file-skill dispatch path), the same path that threw
  // "Cannot send: agent has no session." on a dormant agent before the fix.
  function writeSkill(name: string): string {
    const dir = join(STATE_ROOT, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "Do the thing.");
    return dir;
  }

  it("wakes a dormant agent to run a skill (was throwing 'no session')", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    seedClaudeSession(STATE_ROOT, sid!);
    const skillName = "dormantskilltest";
    const skillDir = writeSkill(skillName);
    try {
      // Release the subprocess: agent is dormant, holds no live session.
      expect(await mgr.demoteToLazy(id)).toBe(true);
      expect(mgr.getAgent(id)?.dormant).toBe(true);
      const resumesBefore = fake.resumeSessionCount;

      // Dispatch the skill. Before the fix, executeSkill -> runAgentTurn threw
      // because session === null; now executeSkill wakes the dormant agent
      // first (lazy-restore). Fire-and-forget: the wake lands synchronously
      // early in the flow; awaiting the turn can hang on the no-op FakeBackend
      // when the turn runner is globally configured by another test.
      void mgr.sendMessage(id, `/${skillName}`, "tester").catch(() => {});
      await waitUntil(
        () => (mgr.getAgent(id)?.dormant ?? false) === false,
        "woke from dormant to run skill",
      );

      // Woke onto a live session by resuming the SAME thread (lazy-restore),
      // and produced no error (the old throw set state "error" + logged
      // "Skill error: Cannot send...").
      expect(mgr.getCurrentSessionId(id)).toBe(sid);
      expect(fake.resumeSessionCount).toBe(resumesBefore + 1);
      expect(mgr.getAgentLogs(id).some((e) => e.kind === "error")).toBe(false);
      fake.lastSession?.close();
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("an unknown slash command does NOT wake a dormant agent (only real skills do)", async () => {
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    expect(await mgr.demoteToLazy(id)).toBe(true);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    const createsBefore = fake.createSessionCount;
    const resumesBefore = fake.resumeSessionCount;

    // No skill file, not an SDK-reported command, not a config command -> Step 5
    // "unknown command" is HANDLED inside handleSlashCommand (returns true), so
    // sendMessage returns before the skill-wake site. The dormant agent must
    // stay dormant, holding no subprocess: the wake fires for actual skills
    // only, never for arbitrary slash input.
    await mgr.sendMessage(id, "/no-such-skill-xyz", "tester");

    expect(fake.createSessionCount).toBe(createsBefore);
    expect(fake.resumeSessionCount).toBe(resumesBefore);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
  });
});

// Task e06b7e23. A SIGTERMed Claude CLI hands the resumed model hardcoded text
// claiming the USER rejected the tool that was running, so the agent wakes up
// believing its boss countermanded it (ad86462c: 18 occurrences, 16 of them our
// own service restarts). The wake-up message has to say what actually happened.
describe("idle eviction - truthful wake-up after a shutdown", () => {
  // Boot lazy-restore with a persisted session id, i.e. the state every agent
  // is in after `systemctl restart isomux`.
  // Log entries are persisted per agent id and replayed by restoreAgents, so
  // every case needs its own agent + session or it reads the previous case's
  // wake-up message out of the shared store.
  let seq = 0;

  function restoredManager(fake: FakeBackend, agentId: string, sid: string) {
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [
        {
          id: "room-a",
          name: "room-a",
          prompt: null,
          agents: [
            {
              id: agentId,
              name: "Lazy",
              desk: 0,
              cwd: STATE_ROOT,
              outfit: {
                hat: "none" as const,
                color: "#ffffff",
                hair: "#000000",
                hairStyle: "short" as const,
                skin: "#ffffff",
                beard: "none" as const,
                accessory: null,
              },
              permissionMode: "default" as const,
              modelFamily: "opus",
              agentType: "claude" as const,
              lastSessionId: sid,
              topic: null,
              customInstructions: null,
              userId: null,
              username: null,
            },
          ],
        },
      ],
    });
    mgr.configureAgentTurnDeps();
    return mgr;
  }

  // Everything the woken session actually sent to the backend. This is the
  // surface that matters: the agent reads the prompt, never the isomux log.
  function sentText(fake: FakeBackend): string {
    return (fake.lastSession?.sent ?? []).map((m) => m.text).join("\n");
  }

  async function wakeRestored(
    transcript: string,
  ): Promise<{ log: string; sent: string }> {
    wireClaudeConfigDir();
    const fake = makeFake();
    const n = ++seq;
    const agentId = `agent-test-shutdown-${n}`;
    const sid = `fake-session-shutdown-${n}`;
    const mgr = restoredManager(fake, agentId, sid);
    await mgr.restoreAgents();
    seedClaudeSession(STATE_ROOT, sid, transcript);
    const r = mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "tester" },
      text: "status?",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => (mgr.getAgent(agentId)?.dormant ?? false) === false,
      "restored agent woke",
    );
    const out = { log: logText(mgr, agentId), sent: sentText(fake) };
    fake.lastSession?.close();
    return out;
  }

  it("restart wake: warns about partial effects, NO rejection clause unproven", async () => {
    // No shutdown marker on disk, so isomux cannot prove a rejection was
    // synthetic - and explaining a rejection that may not exist is noise.
    const { log, sent } = await wakeRestored('{"type":"user"}\n');
    expect(log).toContain(WAKE_RESTART);
    expect(log).toContain(WAKE_PARTIAL);
    expect(log).not.toContain(WAKE_REJECTION_TALK);
    // The whole point: the AGENT is told, not just the human reading the log.
    expect(sent).toContain(WAKE_BLOCK_OPEN);
    expect(sent).toContain(WAKE_RESTART);
    expect(sent).toContain(WAKE_PARTIAL);
    expect(sent).not.toContain(WAKE_REJECTION_TALK);
  });

  it("restart wake: upgrades to CATEGORICAL when the transcript proves it", async () => {
    const { log, sent } = await wakeRestored(SHUTDOWN_TRANSCRIPT);
    expect(log).toContain(WAKE_RESTART);
    expect(log).toContain(WAKE_PARTIAL);
    expect(log).toContain(WAKE_CATEGORICAL);
    expect(sent).toContain(WAKE_CATEGORICAL);
  });

  it("restart wake: no rejection clause when the transcript is unreadable", async () => {
    // Best-effort means non-load-bearing: a truncated/garbage final line must
    // fall back to the clause-free wording, never crash the wake.
    const { log, sent } = await wakeRestored(
      '{"type":"user"}\n{"interruptedBySh',
    );
    expect(log).toContain(WAKE_RESTART);
    expect(log).toContain(WAKE_PARTIAL);
    expect(log).not.toContain(WAKE_REJECTION_TALK);
    expect(sent).not.toContain(WAKE_REJECTION_TALK);
  });

  it("restart wake: ignores a marker that is not on the LAST entry", async () => {
    // The marker belongs to the entry the shutdown cut short. An older one
    // describes a previous death the agent has already been told about.
    const { log } = await wakeRestored(
      JSON.stringify({ type: "user", interruptedByShutdown: true }) +
        "\n" +
        JSON.stringify({ type: "assistant" }) +
        "\n",
    );
    expect(log).toContain(WAKE_PARTIAL);
    expect(log).not.toContain(WAKE_REJECTION_TALK);
  });

  it("backend-death wake: same warning, worded for an unexpected end", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id)!;
    seedClaudeSession(STATE_ROOT, sid, SHUTDOWN_TRANSCRIPT);
    // Clean stream end while idle - what an earlyoom SIGTERM looks like from
    // here. Sets dormantReason "stream-ended".
    fake.lastSession!.endStream();
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === true,
      "went dormant on stream end",
    );
    const r = mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "still there?",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "woke after stream end",
    );
    const text = logText(mgr, id);
    expect(text).toContain(WAKE_STREAM_END);
    expect(text).toContain(WAKE_PARTIAL);
    expect(text).toContain(WAKE_CATEGORICAL);
    const sent = sentText(fake);
    expect(sent).toContain(WAKE_BLOCK_OPEN);
    expect(sent).toContain(WAKE_STREAM_END);
    expect(sent).toContain(WAKE_CATEGORICAL);
    fake.lastSession?.close();
  });

  // A backend that refuses any send carrying the wake block, so the notice is
  // armed, attempted, and NOT consumed - the state in which a conversation
  // boundary can strand it.
  function makeBlockRefusingFake(): FakeBackend {
    return new FakeBackend({
      session: {
        onSend: (text, _a, s) => {
          if (text.includes(WAKE_BLOCK_OPEN))
            throw new Error("backend refused the send");
          s.completeTurn({ text: "ok" });
        },
      },
    });
  }

  // Drive an agent to "wake notice armed, send failed, notice still in the
  // slot". Returns the woken session so the caller can read what went out.
  async function armThenFailSend(
    mgr: ReturnType<typeof createAgentManager>,
    fake: FakeBackend,
    id: string,
  ) {
    const sid = mgr.getCurrentSessionId(id)!;
    seedClaudeSession(STATE_ROOT, sid, SHUTDOWN_TRANSCRIPT);
    const dead = fake.lastSession!;
    dead.endStream();
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === true,
      "went dormant on stream end",
    );
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "first",
    });
    await waitUntil(() => fake.lastSession !== dead, "woke on a new session");
    const woken = fake.lastSession!;
    await waitUntil(() => woken.sent.length >= 1, "wake send attempted");
    expect(woken.sent[0].text).toContain(WAKE_BLOCK_OPEN);
    return woken;
  }

  it("a failed send RETAINS the note (never consumed before acceptance)", async () => {
    wireClaudeConfigDir();
    const fake = makeBlockRefusingFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const woken = await armThenFailSend(mgr, fake, id);
    // The backend never accepted it, so the agent was never told. The next
    // attempt must still carry the warning. Goes through sendMessage (the
    // human path) because the failed send parked the agent in "error", which
    // flushQueue refuses to serve and only a human message auto-recovers.
    void mgr.sendMessage(id, "retry", "tester").catch(() => {});
    await waitUntil(() => woken.sent.length >= 2, "retry attempted");
    expect(woken.sent[1].text).toContain(WAKE_BLOCK_OPEN);
    woken.close();
  });

  it("/clear drops a retained note: the fresh conversation gets no wake block", async () => {
    // The contextGen guard stops an OLD send from clearing a NEW generation's
    // slot, but it cannot empty a slot whose notice was never consumed. Without
    // the boundary cleanup in resetContextUsage, this stranded warning rides
    // into a conversation whose transcript holds no rejection to warn about -
    // and it says "just above". Found by Reviewer1 on fingerprint b92141d3.
    wireClaudeConfigDir();
    const fake = makeBlockRefusingFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const stranded = await armThenFailSend(mgr, fake, id);

    await mgr.newConversation(id);
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "fresh start",
    });
    await waitUntil(
      () => fake.lastSession !== stranded && fake.lastSession!.sent.length >= 1,
      "fresh conversation sent",
    );
    const fresh = fake.lastSession!;
    expect(fresh.sent[0].text).not.toContain(WAKE_BLOCK_OPEN);
    expect(fresh.sent[0].text).not.toContain(WAKE_PARTIAL);
    fresh.close();
  });

  it("textarea path (wakeSessionForSend) delivers the note too", async () => {
    // The other delivery tests all wake through flushQueue's !session branch.
    // sendMessage arms the note in a DIFFERENT function (wakeSessionForSend)
    // and its caller does the send, so the two paths can regress apart.
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id)!;
    seedClaudeSession(STATE_ROOT, sid, SHUTDOWN_TRANSCRIPT);
    fake.lastSession!.endStream();
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === true,
      "went dormant on stream end",
    );
    await mgr.sendMessage(id, "you there?", "tester");
    const woken = fake.lastSession!;
    await waitUntil(() => woken.sent.length === 1, "textarea message sent");
    expect(woken.sent[0].text).toContain(WAKE_BLOCK_OPEN);
    expect(woken.sent[0].text).toContain(WAKE_STREAM_END);
    expect(woken.sent[0].text).toContain(WAKE_CATEGORICAL);
    // Still exactly once on this path.
    await mgr.sendMessage(id, "again", "tester");
    await waitUntil(() => woken.sent.length === 2, "second textarea message");
    expect(woken.sent[1].text).not.toContain(WAKE_BLOCK_OPEN);
    woken.close();
  });

  it("delivers the note ONCE: the next message carries no wake block", async () => {
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id)!;
    seedClaudeSession(STATE_ROOT, sid, SHUTDOWN_TRANSCRIPT);
    fake.lastSession!.endStream();
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === true,
      "went dormant on stream end",
    );
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "first",
    });
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "woke after stream end",
    );
    const woken = fake.lastSession!;
    await waitUntil(() => woken.sent.length === 1, "first message sent");
    expect(woken.sent[0].text).toContain(WAKE_BLOCK_OPEN);

    // Second message on the SAME live session: the note was consumed, so the
    // agent isn't re-told about a shutdown it already knows about.
    mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "second",
    });
    await waitUntil(() => woken.sent.length === 2, "second message sent");
    expect(woken.sent[1].text).not.toContain(WAKE_BLOCK_OPEN);
    woken.close();
  });

  it("idle-eviction wake says nothing about shutdowns", async () => {
    // The calm branch must not inherit the alarm: nothing was interrupted.
    wireClaudeConfigDir();
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id)!;
    seedClaudeSession(STATE_ROOT, sid, SHUTDOWN_TRANSCRIPT);
    expect(await mgr.demoteToLazy(id)).toBe(true);
    const r = mgr.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "back",
    });
    expect(r.ok).toBe(true);
    await waitUntil(
      () => (mgr.getAgent(id)?.dormant ?? false) === false,
      "woke from idle demote",
    );
    const text = logText(mgr, id);
    expect(text).toContain("released while idle");
    expect(text).not.toContain(WAKE_PARTIAL);
    expect(text).not.toContain(WAKE_REJECTION_TALK);
    // And costs the agent no context: no block on the wire either, even though
    // a shutdown-marked transcript is sitting on disk.
    expect(sentText(fake)).not.toContain(WAKE_BLOCK_OPEN);
  });
});
