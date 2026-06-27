// DI unit tests for idle eviction / lazy demotion (Track B: memory efficiency).
// Exercises demoteToLazy, the canDemote guard, sweepIdleAgents, and the
// dormant -> wake roundtrip against the FakeBackend (zero LLM / provider calls).
// Pins the manager-internal lifecycle invariants Reviewer5 flagged: demote keeps
// the agent on its desk with a resumable session, wake resumes the SAME thread
// (not a fresh one), demote does NOT revoke the token (kill does), and the sweep
// honors the idle threshold. Lazy-restore + full inter-agent HTTP routing are
// covered at the harness layer.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { setOfficeEnvFileProvider } from "../env-loader.ts";
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

// Point the agent env's CLAUDE_CONFIG_DIR at a temp dir via a temp office env
// file, so the Claude resume preflight (claudeSessionFileExists) consults a
// path we control instead of the host ~/.claude.
function wireClaudeConfigDir(): void {
  const envFile = join(STATE_ROOT, "office-idle-evict.env");
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome()}\n`);
  setOfficeEnvFileProvider(() => envFile);
}

// Touch the existence-only session file createSession checks on resume.
function seedClaudeSession(cwd: string, sessionId: string): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

function makeManager(fake: FakeBackend) {
  return createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
  });
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
  // Wait for the FakeBackend's auto system_init to land so managed.sessionId is
  // set (demote requires a resumable session).
  await waitUntil(
    () => mgr.getCurrentSessionId(info.id) !== null,
    `${name} sessionId`,
  );
  return info.id;
}

afterEach(() => {
  // env-loader's office-env provider is a process global; reset so other test
  // files don't inherit our temp CLAUDE_CONFIG_DIR.
  setOfficeEnvFileProvider(() => null);
});

describe("idle eviction — demote / dormant / wake", () => {
  it("demotes an idle agent to lazy, then wakes it by resuming the SAME session", async () => {
    wireClaudeConfigDir();
    const fake = new FakeBackend();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    expect(sid).not.toBeNull();
    expect(mgr.getAgent(id)?.dormant ?? false).toBe(false);
    expect(fake.createSessionCount).toBe(1);
    expect(fake.resumeSessionCount).toBe(0);

    // Demote: subprocess closed, agent stays on its desk, idle + dormant.
    expect(await mgr.demoteToLazy(id)).toBe(true);
    expect(mgr.getAgent(id)?.dormant).toBe(true);
    expect(mgr.getAgent(id)?.state).toBe("idle");
    expect(fake.resumeSessionCount).toBe(0); // no new subprocess yet

    // Demote must NOT revoke the bearer token (kill does) — wake reuses it.
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
    const fake = new FakeBackend();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    const sid = mgr.getCurrentSessionId(id);
    seedClaudeSession(STATE_ROOT, sid!);
    expect(await mgr.demoteToLazy(id)).toBe(true);
    // sendMessage is the WS textarea path — the one that showed "ended
    // unexpectedly" before the fix. Fire-and-forget: the wake (installSession +
    // the system message) lands early in sendMessage's flow; we don't await the
    // turn itself, which would hang on the no-op FakeBackend when plugin hooks
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
    const fake = new FakeBackend();
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
    // with no extra fresh session — the demote's post-await body never stomped
    // the concurrent wake. (Turn processing itself errors here only because the
    // bare DI manager has no plugin hooks; that's unrelated to the race.)
    expect(mgr.getCurrentSessionId(id)).toBe(sid);
    expect(fake.resumeSessionCount).toBe(1);
    expect(fake.createSessionCount).toBe(1);
    fake.lastSession?.close();
  });

  it("does not re-demote an already-dormant agent", async () => {
    const fake = new FakeBackend();
    const mgr = makeManager(fake);
    const id = await spawnReady(mgr, "A");
    expect(await mgr.demoteToLazy(id)).toBe(true);
    // session === null now → canDemote is false, second call is a no-op.
    expect(await mgr.demoteToLazy(id)).toBe(false);
    expect(fake.resumeSessionCount).toBe(0);
  });

  it("boot lazy-restore: restores agents dormant with NO subprocess, then wakes on message", async () => {
    wireClaudeConfigDir();
    const fake = new FakeBackend();
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

    await mgr.restoreAgents();

    // The deploy-critical assertion: lazy restore spawns ZERO subprocesses.
    expect(fake.createSessionCount).toBe(0);
    expect(fake.resumeSessionCount).toBe(0);
    const info = mgr.getAgent("agent-test-lazy");
    expect(info).toBeDefined();
    expect(info?.dormant).toBe(true);
    expect(info?.state).toBe("idle");
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
    const fake = new FakeBackend();
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
    await waitUntil(
      () => mgr.getCurrentSessionId(info.id) !== null,
      "codex sessionId",
    );
    // No durable rollout on disk → pickAutoResumeSessionId returns null → the
    // guard refuses to demote (demoting would lose context on wake). This is the
    // entire safety justification for including Codex in the sweep.
    expect(await mgr.demoteToLazy(info.id)).toBe(false);
    expect(mgr.getAgent(info.id)?.dormant ?? false).toBe(false);
    fake.lastSession?.close();
  });

  it("sweepIdleAgents honors the idle threshold", async () => {
    const fake = new FakeBackend();
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
