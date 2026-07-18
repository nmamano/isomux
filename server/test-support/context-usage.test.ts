// Context-window fullness (internal-docs/context-fullness-visibility.md):
// the per-agent snapshot + race-safe commit protocol in agent-manager, and the
// GET /api/agents/:id/context self-affordance. Seam: startTestServer() +
// FakeBackend. Zero LLM.
//
// What this freezes:
//   - turn_completed sampling commits a snapshot that survives losing the live
//     session (fullness is a transcript property): after the backend stream
//     dies, the endpoint serves the stored fallback.
//   - Blank agent (no conversation) -> { available: false, "no_session" };
//     a live session that reports null (the Codex-before-first-tokenUsage
//     shape) -> "not_yet_measured".
//   - /clear (newConversation) resets the measurement, and a sample from the
//     OLD conversation resolving AFTER the clear is discarded (generation
//     guard of the commit protocol).
//   - Out-of-order resolutions: an older in-flight sample cannot overwrite a
//     newer committed one (sequence guard).
//   - Model change invalidates the measurement without resetting the
//     conversation; a permission-mode change (same window) preserves it.
//   - AGENT-bearer auth: own token 200; cross-agent token 403; USER cookie
//     403 (no self:affordance); no identity 401.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { stripOutboundEnvelope } from "../plugin-hooks.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentEvent } from "../internal-types.ts";
import { createAgentManager } from "../agent-manager.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { loadLog } from "../persistence.ts";
import { STATE_ROOT } from "../config.ts";
import type { AgentInfo, RoomWire } from "../../shared/types.ts";
import type { ContextUsage } from "../backends/types.ts";
import type { AgentContextUsageResp } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
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

function diRooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function usage(percentage: number): ContextUsage {
  return {
    model: "fake-model",
    totalTokens: percentage * 1000,
    maxTokens: 100_000,
    percentage,
  };
}

// A FakeBackend whose sessions auto-complete each turn and report `ctx` from
// getContextUsage (static value, function, or omitted for the null default).
function backendWith(
  ctx?: ContextUsage | null | (() => Promise<ContextUsage | null>),
): FakeBackend {
  return new FakeBackend({
    session: {
      contextUsage: ctx,
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
    },
  });
}

// --- DI-level helpers for the resume lifecycle tests -----------------------
// resume()'s replace runs the Claude resume preflight (claudeSessionFileExists),
// so we wire CLAUDE_CONFIG_DIR to a temp dir (per-manager, unique) and seed the
// existence-only .jsonl before resuming. Same pattern as
// agent-idle-eviction.di.test.ts. Behavior is asserted through the manager's
// public getAgentContextUsage op.
let diSuffix = 0;
// Point CLAUDE_CONFIG_DIR at a unique temp dir (via an office env file) so the
// Claude resume preflight consults a path we control. Returns that dir.
function wireClaudeHome(): string {
  const suffix = `ctx-life-${++diSuffix}`;
  const claudeHome = join(STATE_ROOT, `claude-home-${suffix}`);
  const envFile = join(STATE_ROOT, `office-${suffix}.env`);
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome}\n`);
  setOfficeEnvFileProvider(() => envFile);
  return claudeHome;
}

function makeManager(fake: FakeBackend): ReturnType<typeof createAgentManager> {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: diRooms("room-a") }),
    initialRooms: [],
  });
  mgr.configurePluginHooksDeps();
  return mgr;
}

function makeDiManager(ctxFn: () => Promise<ContextUsage | null>): {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  claudeHome: string;
} {
  const claudeHome = wireClaudeHome();
  const fake = new FakeBackend({
    session: {
      contextUsage: ctxFn,
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
    },
  });
  const mgr = makeManager(fake);
  return { mgr, fake, claudeHome };
}

async function diSpawn(
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

async function diRunTurn(
  mgr: ReturnType<typeof createAgentManager>,
  id: string,
  text: string,
): Promise<void> {
  const r = mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "Boss" },
    text,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
  await waitUntil(
    () => {
      const s = mgr.getAgent(id)?.state;
      return s !== undefined && s !== "thinking" && s !== "tool_executing";
    },
    3000,
    `turn processed: ${text}`,
  );
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

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// Drive one full turn: enqueue -> FakeSession auto-completes -> wait until the
// agent leaves the busy states (turn_completed processed).
async function runTurn(
  srv: TestServer,
  agentId: string,
  text: string,
): Promise<void> {
  const r = srv.agentManager.enqueueMessage(agentId, {
    sender: { kind: "user", username: "Boss" },
    text,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
  await waitUntil(
    () => {
      const s = srv.agentManager.getAgent(agentId)?.state;
      return s !== undefined && s !== "thinking" && s !== "tool_executing";
    },
    3000,
    `turn processed: ${text}`,
  );
}

// Release the live backend session (stream death) so the endpoint can't take
// the live-reading path and must serve the stored snapshot.
async function releaseSession(srv: TestServer, agentId: string): Promise<void> {
  srv.fakeBackend.sessionForAgent(agentId)!.endStream();
  await waitUntil(
    () => srv.agentManager.getAgent(agentId)?.dormant === true,
    3000,
    "session released",
  );
}

async function getContext(
  srv: TestServer,
  agentId: string,
  opts: { bearer?: string; rawSessionId?: string } = {},
): Promise<{ status: number; body: AgentContextUsageResp }> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  const res = await srv.http(`/api/agents/${agentId}/context`, {
    headers,
    rawSessionId: opts.rawSessionId,
  });
  let body: AgentContextUsageResp;
  try {
    body = (await res.json()) as AgentContextUsageResp;
  } catch {
    body = {} as AgentContextUsageResp;
  }
  return { status: res.status, body };
}

describe("context-fullness: snapshot lifecycle through GET /api/agents/:id/context", () => {
  it("blank agent -> no_session; after a turn -> available; survives session release via the snapshot fallback", async () => {
    const srv = await startTestServer({ fakeBackend: backendWith(usage(42)) });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    // Lazy spawn: no conversation yet, nothing to measure.
    let r = await getContext(srv, agent.id, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, reason: "no_session" });

    await runTurn(srv, agent.id, "hi");
    // Kill the live session BEFORE reading: the turn_completed sample must
    // have committed a snapshot that the endpoint serves without a live call.
    await releaseSession(srv, agent.id);

    r = await getContext(srv, agent.id, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      available: true,
      model: "fake-model",
      totalTokens: 42_000,
      maxTokens: 100_000,
      percentage: 42,
      sampledAtMs: expect.any(Number) as unknown as number,
    });
  });

  it("live session reporting null (Codex-before-first-tokenUsage shape) -> not_yet_measured", async () => {
    const srv = await startTestServer({ fakeBackend: backendWith() });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    await runTurn(srv, agent.id, "hi");
    const r = await getContext(srv, agent.id, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, reason: "not_yet_measured" });
  });

  it("/clear resets the measurement, and an old-conversation sample resolving AFTER the clear is discarded", async () => {
    const releases: ((v: ContextUsage | null) => void)[] = [];
    const srv = await startTestServer({
      fakeBackend: backendWith(
        () => new Promise<ContextUsage | null>((res) => releases.push(res)),
      ),
    });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    await runTurn(srv, agent.id, "hi");
    // The turn_completed refresh is parked on the gate.
    await waitUntil(() => releases.length >= 1, 2000, "refresh parked");

    // /clear while the sample is still in flight, then let it resolve late.
    await srv.agentManager.newConversation(agent.id);
    releases.shift()!(usage(77));
    await sleep(30);

    // The late sample belongs to the dead generation: still nothing to report.
    const r = await getContext(srv, agent.id, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, reason: "no_session" });
  });

  it("an older in-flight sample cannot overwrite a newer committed one (sequence guard)", async () => {
    const releases: ((v: ContextUsage | null) => void)[] = [];
    const srv = await startTestServer({
      fakeBackend: backendWith(
        () => new Promise<ContextUsage | null>((res) => releases.push(res)),
      ),
    });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    await runTurn(srv, agent.id, "one");
    await waitUntil(() => releases.length >= 1, 2000, "sample A parked");
    await runTurn(srv, agent.id, "two");
    await waitUntil(() => releases.length >= 2, 2000, "sample B parked");

    // Resolve the NEWER sample first (commits), then the older one (must be
    // discarded by the seq guard, not clobber the fresher reading).
    releases[1](usage(80));
    await sleep(30);
    releases[0](usage(20));
    await sleep(30);

    await releaseSession(srv, agent.id);
    const r = await getContext(srv, agent.id, { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    if (r.body.available) expect(r.body.percentage).toBe(80);
  });

  it("model change invalidates the measurement; permission-mode change preserves it", async () => {
    // DI-level (createAgentManager) because editAgent's setting-replace runs
    // the Claude resume preflight (claudeSessionFileExists): wire
    // CLAUDE_CONFIG_DIR to a temp dir and seed the existence-only session
    // file, same pattern as agent-idle-eviction.di.test.ts. Behavior is
    // asserted through the manager's public getAgentContextUsage op — the
    // REST mapping over it is covered by the harness tests above.
    const claudeHome = join(STATE_ROOT, "claude-home-context-usage");
    const envFile = join(STATE_ROOT, "office-context-usage.env");
    writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome}\n`);
    setOfficeEnvFileProvider(() => envFile);

    // One committed reading, then null forever — so post-edit reads can't
    // silently refill the snapshot through the live path.
    let calls = 0;
    const fake = backendWith(() =>
      Promise.resolve(calls++ === 0 ? usage(55) : null),
    );
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: diRooms("room-a") }),
      initialRooms: [],
    });
    mgr.configurePluginHooksDeps();
    try {
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
      const enq = mgr.enqueueMessage(info.id, {
        sender: { kind: "user", username: "Boss" },
        text: "hi",
      });
      expect(enq.ok).toBe(true);
      await waitUntil(
        () => {
          const s = mgr.getAgent(info.id)?.state;
          return s !== undefined && s !== "thinking" && s !== "tool_executing";
        },
        3000,
        "turn processed",
      );

      let r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);

      // Seed the existence-only .jsonl the resume preflight checks, in the
      // project dir derived from the agent's (resolved) cwd.
      const sessionId = mgr.getCurrentSessionId(info.id)!;
      const cwd = mgr.getAgent(info.id)!.cwd;
      const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionId}.jsonl`), "");

      // Same window, same transcript: permission-mode restart preserves.
      await mgr.editAgent(info.id, { permissionMode: "acceptEdits" });
      r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);

      // New window: the old reading is not actionable — measurement
      // invalidated, conversation NOT reset (same session id continues).
      await mgr.editAgent(info.id, { modelFamily: "sonnet" });
      r = await mgr.getAgentContextUsage(info.id);
      expect(r).toEqual({ available: false, reason: "not_yet_measured" });
      expect(mgr.getCurrentSessionId(info.id)).toBe(sessionId);
    } finally {
      // Unblock the manager's parked stream consumers.
      for (const s of fake.sessions) s.close();
    }
  });

  it("same-id resume preserves the committed snapshot; an old-session in-flight sample is discarded by object identity", async () => {
    // ctx: resolve 55 immediately while park=false; park the next call so an
    // old-session sample stays in flight across the resume.
    let park = false;
    const parked: ((v: ContextUsage | null) => void)[] = [];
    const { mgr, fake, claudeHome } = makeDiManager(() =>
      park
        ? new Promise<ContextUsage | null>((res) => parked.push(res))
        : Promise.resolve(usage(55)),
    );
    try {
      const info = await diSpawn(mgr);
      await diRunTurn(mgr, info.id, "one"); // S1 turn -> commits 55
      let r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);

      const s1Id = mgr.getCurrentSessionId(info.id)!;
      seedClaudeFile(claudeHome, mgr.getAgent(info.id)!.cwd, s1Id);

      // Park the NEXT sample so it's still in flight when we resume.
      park = true;
      await diRunTurn(mgr, info.id, "two"); // S1 turn-two refresh -> parked
      await waitUntil(() => parked.length >= 1, 2000, "turn-two sample parked");

      // Same-id resume: installs a fresh BackendSession object (S2). Snapshot
      // preserved (no gen bump), and the parked S1 sample is now orphaned.
      await mgr.resume(info.id, s1Id);
      expect(mgr.getCurrentSessionId(info.id)).toBe(s1Id);

      // Resolve the old-session sample: object identity (S1 !== S2) discards it.
      parked[0](usage(20));
      await sleep(30);

      // Release the live session so the endpoint serves the STORED snapshot
      // (no live-call overwrite): still the preserved 55, not the discarded 20.
      fake.sessionForAgent(info.id)!.endStream();
      await waitUntil(
        () => mgr.getAgent(info.id)?.dormant === true,
        3000,
        "session released",
      );
      r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);
    } finally {
      for (const s of fake.sessions) s.close();
    }
  });

  it("different-id resume clears the committed snapshot", async () => {
    let mode: number | null = 55; // number -> usage(mode); null -> null
    const { mgr, fake, claudeHome } = makeDiManager(() =>
      Promise.resolve(mode === null ? null : usage(mode)),
    );
    try {
      const info = await diSpawn(mgr);
      await diRunTurn(mgr, info.id, "one"); // S1 -> commits 55
      let r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);

      const cwd = mgr.getAgent(info.id)!.cwd;
      seedClaudeFile(claudeHome, cwd, mgr.getCurrentSessionId(info.id)!);
      // A different existing session to resume into.
      const otherId = "other-session-xyz";
      seedClaudeFile(claudeHome, cwd, otherId);

      // Stop later live reads from refilling the snapshot after the reset.
      mode = null;
      await mgr.resume(info.id, otherId); // different id -> resetContextUsage
      expect(mgr.getCurrentSessionId(info.id)).toBe(otherId);

      r = await mgr.getAgentContextUsage(info.id);
      expect(r).toEqual({ available: false, reason: "not_yet_measured" });
    } finally {
      for (const s of fake.sessions) s.close();
    }
  });

  it("failed edit-fork rollback does NOT restore the parent snapshot when the parent session wasn't reinstalled (P1)", async () => {
    // The fork installs (snapshot reset to null), the fork TURN fails (onSend
    // throws on the edited text), and the rollback's createSession(PARENT_SID)
    // fails because the parent file isn't seeded — so managed.session still
    // points at the (broken) fork. Restoring the parent's committed snapshot
    // there would mislabel the wrong conversation; the fix keeps it null.
    const PARENT_SID = "fake-session-1"; // deterministic: first createSession
    const FORK_SID = "forked-rollback-1";
    let mode: number | null = 55;
    const claudeHome = wireClaudeHome();
    const fake = new FakeBackend({
      session: {
        contextUsage: () => Promise.resolve(mode === null ? null : usage(mode)),
        onSend: (text, _a, s) => {
          if (text.includes("edited")) {
            throw new Error("boom: fork turn send failed");
          }
          s.completeTurn({ text: "reply" });
        },
      },
      // The backend transcript records the sent form, which carries the
      // "[Boss]" sender prefix diRunTurn applies — editMessage matches the log
      // entry against this exact text, so it must include the prefix.
      sessionMessages: [
        { uuid: "u-first", role: "user", text: "[Boss] first" },
        { uuid: "a-1", role: "assistant", text: "reply" },
      ],
      forkResult: {
        kind: "fork",
        sessionId: FORK_SID,
        forkedFromSessionId: PARENT_SID,
      },
    });
    const mgr = makeManager(fake);
    try {
      const info = await diSpawn(mgr);
      await diRunTurn(mgr, info.id, "first");
      expect(mgr.getCurrentSessionId(info.id)).toBe(PARENT_SID);
      await waitUntil(
        () => mgr.getAgent(info.id)?.state === "waiting_for_response",
        3000,
        "idle after first turn",
      );
      let r = await mgr.getAgentContextUsage(info.id);
      expect(r.available).toBe(true);
      if (r.available) expect(r.percentage).toBe(55);

      // Seed the FORK file (fork createSession preflight passes) but NOT the
      // PARENT file (rollback createSession preflight fails).
      seedClaudeFile(claudeHome, mgr.getAgent(info.id)!.cwd, FORK_SID);
      // Live reads now return null so a GET can't refill via the live path.
      mode = null;

      const firstMsgId = loadLog(info.id, PARENT_SID).find(
        (e) => e.kind === "user_message" && e.content === "first",
      )!.id;

      await mgr.editMessage(info.id, firstMsgId, "edited first");
      await waitUntil(
        () => mgr.getAgent(info.id)?.state === "error",
        3000,
        "edit fork failed to error state",
      );

      // The known-wrong parent snapshot (55) must NOT resurface.
      r = await mgr.getAgentContextUsage(info.id);
      expect(r).toEqual({ available: false, reason: "not_yet_measured" });
    } finally {
      for (const s of fake.sessions) s.close();
    }
  });
});

describe("context-fullness: agent-facing threshold notices (task 50392514)", () => {
  it("injects the 50% notice into the next send once, then the 75% notice when fullness rises", async () => {
    // Mutable fullness the fake backend reports at each turn_completed sample.
    let pct = 68;
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({
        session: {
          contextUsage: () => Promise.resolve(usage(pct)),
          onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
        },
      }),
    });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    // Turn 1: no prior sample, so nothing is injected; turn_completed then
    // commits the 68% reading.
    await runTurn(srv, agent.id, "one");
    expect(lastSent()).not.toContain("context check");
    // Confirm the 68% snapshot is committed before the next send races it.
    let r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 68 });

    // Turn 2: 68% >= 50 and 50 not yet fired -> the 50 notice rides this send,
    // wrapped in the reserved isomux envelope. The unwrapped payload (what the
    // log entry and edit-fork matching see) round-trips cleanly.
    await runTurn(srv, agent.id, "two");
    const turn2 = lastSent();
    expect(turn2.startsWith("--- begin isomux: context-check ---")).toBe(true);
    expect(turn2).toContain(
      "[context check: 68% full - 68,000 / 100,000 tokens. Budget accordingly.]",
    );
    const unwrapped2 = stripOutboundEnvelope(turn2);
    expect(unwrapped2).not.toContain("---");
    expect(unwrapped2.endsWith("two")).toBe(true);

    // Turn 3: still 68%, 50 already fired, 75 not reached -> no notice at all.
    await runTurn(srv, agent.id, "three");
    const turn3 = lastSent();
    expect(turn3).not.toContain("context check");
    expect(turn3).not.toContain("--- begin isomux:");

    // Fullness rises past 75. The turn-4 send predates the new sample (still
    // 68% -> no notice); turn 4's completion commits 90%.
    pct = 90;
    await runTurn(srv, agent.id, "four");
    expect(lastSent()).not.toContain("context check");
    r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 90 });

    // Turn 5: 90% >= 75 and 75 not yet fired -> the wrap-up notice fires.
    await runTurn(srv, agent.id, "five");
    const turn5 = lastSent();
    expect(turn5).toContain(
      "[context check: 90% full - 90,000 / 100,000 tokens.",
    );
    expect(turn5).toContain("Wrap up:");
  });

  it("resets the fired-notice set on /clear so the 50% notice can fire again", async () => {
    const srv = await startTestServer({ fakeBackend: backendWith(usage(70)) });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    await runTurn(srv, agent.id, "one");
    let r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 70 });
    await runTurn(srv, agent.id, "two");
    expect(lastSent()).toContain("[context check: 70% full");

    // A second turn at the same level does NOT re-fire.
    await runTurn(srv, agent.id, "three");
    expect(lastSent()).not.toContain("context check");

    // /clear resets the generation AND the fired-notice set. The fresh
    // conversation re-crosses 50% and the notice fires again.
    await srv.agentManager.newConversation(agent.id);
    await runTurn(srv, agent.id, "fresh-one");
    r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 70 });
    await runTurn(srv, agent.id, "fresh-two");
    expect(lastSent()).toContain("[context check: 70% full");
  });

  it("a swap during send() does not let the stale old send burn the fresh generation's notice (P1 deferred-send race)", async () => {
    // manualSend parks every send() so we can hold turn 2 in the send window,
    // /clear the conversation, THEN resolve the OLD session's send — exactly
    // the race where an old-session send resolves after replaceSession. The
    // mark-after-send must skip via the generation guard, so the fresh
    // fired-set stays empty and the 60% notice can fire again.
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({
        session: {
          contextUsage: () => Promise.resolve(usage(70)),
          manualSend: true,
        },
      }),
    });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const send = (text: string) =>
      srv.agentManager.enqueueMessage(agent.id, {
        sender: { kind: "user", username: "Boss" },
        text,
      });
    const curSess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const settled = () => {
      const s = srv.agentManager.getAgent(agent.id)?.state;
      return s !== undefined && s !== "thinking" && s !== "tool_executing";
    };

    // Turn 1: park -> release -> complete, seeding the 70% sample.
    send("one");
    await waitUntil(() => curSess().sent.length === 1, 3000, "turn1 parked");
    curSess().releaseSends();
    curSess().completeTurn();
    await waitUntil(settled, 3000, "turn1 done");
    let r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 70 });

    // Turn 2: build injects the 60 notice (70% >= 60); hold it in the send
    // window (do NOT release).
    const s1 = curSess();
    send("two");
    await waitUntil(() => s1.sent.length === 2, 3000, "turn2 parked");
    expect(s1.sent[1].text).toContain("[context check: 70% full");

    // Swap the conversation WHILE turn 2's send is parked (bumps the
    // generation, replaces the fired-set), THEN let the OLD session's send
    // resolve. The generation guard must skip the now-stale mark.
    await srv.agentManager.newConversation(agent.id);
    s1.releaseSends();
    await sleep(50); // let the stale turn-2 continuation unwind past the mark

    // Fresh conversation is dormant; turn 3 wakes a new session and re-seeds
    // 70%. Its first turn has no sample yet -> no notice.
    send("three");
    await waitUntil(() => curSess() !== s1, 3000, "turn3 session woke");
    const s2 = curSess();
    await waitUntil(() => s2.sent.length === 1, 3000, "turn3 parked");
    expect(s2.sent[0].text).not.toContain("context check");
    s2.releaseSends();
    s2.completeTurn();
    await waitUntil(settled, 3000, "turn3 done");
    r = await getContext(srv, agent.id, { bearer: token });
    expect(r.body).toMatchObject({ available: true, percentage: 70 });

    // Turn 4: the 60 notice MUST fire again — proof the stale turn-2 send did
    // NOT consume the fresh generation's fired-set. (With the bug, turn 2's
    // late send would have marked 60 on the new gen and this would be absent.)
    send("four");
    await waitUntil(() => s2.sent.length === 2, 3000, "turn4 parked");
    expect(s2.sent[1].text).toContain("[context check: 70% full");
    s2.releaseSends();
  });
});

// The UI indicator's data path (task 27096236): a committed sample broadcasts
// AgentInfo.contextUsage over agent_updated (wire shape = snapshot minus
// `source`), reset paths clear it, and the Codex usage_update path is throttled
// on displayed values. DI-level with a capturing eventSink.
describe("context-fullness: WS broadcast of AgentInfo.contextUsage (task 27096236)", () => {
  function makeManagerWithSink(
    fake: FakeBackend,
    sink: (e: AgentEvent) => void,
  ): ReturnType<typeof createAgentManager> {
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: diRooms("room-a") }),
      initialRooms: [],
      eventSink: sink,
    });
    mgr.configurePluginHooksDeps();
    return mgr;
  }

  // agent_updated events that actually carry a contextUsage change.
  function ctxBroadcasts(
    events: AgentEvent[],
  ): Extract<AgentEvent, { type: "agent_updated" }>[] {
    return events.filter(
      (e): e is Extract<AgentEvent, { type: "agent_updated" }> =>
        e.type === "agent_updated" && "contextUsage" in e.changes,
    );
  }

  const tokenUsage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  it("a committed turn_completed sample broadcasts the contextUsage wire (no `source`) and mirrors it onto AgentInfo", async () => {
    const captured: AgentEvent[] = [];
    const mgr = makeManagerWithSink(backendWith(usage(40)), (e) =>
      captured.push(e),
    );
    const info = await diSpawn(mgr);
    await diRunTurn(mgr, info.id, "hello");
    await waitUntil(
      () => ctxBroadcasts(captured).length >= 1,
      3000,
      "contextUsage broadcast",
    );

    const wire = ctxBroadcasts(captured).at(-1)!.changes.contextUsage;
    expect(wire).toEqual({
      model: "fake-model",
      totalTokens: 40_000,
      maxTokens: 100_000,
      percentage: 40,
      sampledAtMs: expect.any(Number),
    });
    // The internal `source` discriminator must NOT leak onto the wire.
    expect("source" in (wire as object)).toBe(false);
    // Mirrored onto public AgentInfo so a late-joining client's full_state sees it.
    expect(mgr.getAgent(info.id)?.contextUsage?.percentage).toBe(40);
  });

  it("/clear (newConversation) broadcasts contextUsage: undefined to clear the indicator", async () => {
    const captured: AgentEvent[] = [];
    const mgr = makeManagerWithSink(backendWith(usage(60)), (e) =>
      captured.push(e),
    );
    const info = await diSpawn(mgr);
    await diRunTurn(mgr, info.id, "hello");
    await waitUntil(
      () => mgr.getAgent(info.id)?.contextUsage != null,
      3000,
      "snapshot present",
    );

    captured.length = 0;
    await mgr.newConversation(info.id);

    const cleared = ctxBroadcasts(captured).find(
      (e) => e.changes.contextUsage === undefined,
    );
    expect(cleared).toBeTruthy();
    expect(mgr.getAgent(info.id)?.contextUsage).toBeUndefined();
  });

  it("throttles the Codex usage_update path: a second identical displayed value does not re-broadcast", async () => {
    const captured: AgentEvent[] = [];
    const fake = backendWith(usage(55));
    const mgr = makeManagerWithSink(fake, (e) => captured.push(e));
    const info = await diSpawn(mgr);
    await diRunTurn(mgr, info.id, "hello");
    await waitUntil(
      () => mgr.getAgent(info.id)?.contextUsage != null,
      3000,
      "initial snapshot",
    );

    const session = fake.sessionForAgent(info.id)!;
    // First usage_update with a value equal to the current one: same displayed
    // percentage/tokens, so the throttle suppresses the broadcast.
    captured.length = 0;
    session.push({ kind: "usage_update", tokenUsage });
    await sleep(60);
    expect(ctxBroadcasts(captured)).toHaveLength(0);
  });
});

describe("context-fullness: auth (self:affordance + agentParamMustEqualTokenAgent)", () => {
  it("own token 200; cross-agent token 403; user cookie 403; no identity 401", async () => {
    const srv = await startTestServer({ fakeBackend: backendWith(usage(10)) });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "A", room.id);
    const b = await spawnAgent(srv, "B", room.id);
    const tokenA = getAgentTokenRaw(a.id)!;
    const tokenB = getAgentTokenRaw(b.id)!;

    expect((await getContext(srv, a.id, { bearer: tokenA })).status).toBe(200);
    expect((await getContext(srv, a.id, { bearer: tokenB })).status).toBe(403);
    expect(
      (await getContext(srv, a.id, { rawSessionId: owner.rawSessionId }))
        .status,
    ).toBe(403);
    expect((await getContext(srv, a.id)).status).toBe(401);
  });
});
