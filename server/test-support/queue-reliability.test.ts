// Queue reliability bundle (tasks da065287 / 9870b472 / 314ee9fb).
//
// Covers the three delivery-machinery fixes designed with Reviewer6 (see
// internal-docs/queue-reliability-design.md):
//   - da065287 layer 1: pendingTurn waiters ATTACH to the deferred's promise
//     instead of replacing the record (the lost-wakeup class), plus the
//     runConsumer clean-stream-end backstop;
//   - da065287 layer 2: bounded consumer drain in closeAndDrainSession;
//   - da065287 layer 3: the queue watchdog (sweepStuckFlushes) - gentle
//     re-trigger for missed flushes, rate-limited forced recovery for wedged
//     ones (exercised via the _testWedgeFlush seam: once layers 1–2 exist,
//     every wire-constructible wedge is already recovered by those layers
//     themselves, so the forced path is insurance for unknown wedges);
//   - 9870b472: durable per-agent queues (~/.isomux/message-queues.json) -
//     transactional acceptance, boot replay via harness restart(), dedupe
//     across restarts, clear/kill/corrupt-file behavior;
//   - 314ee9fb: wake-vs-swap serialization (the flush wake defers to a
//     mid-drain swap; a wakeSessionForSend that wins the drain window is
//     never clobbered by the swap's conditional install). The setPrivileged
//     pre-send-cancel retry itself is pinned in queue.test.ts.
//
// Seam: the WS/HTTP harness plus the FakeBackend knobs added for this bundle
// (manualSend park/fail, hangOnClose wedge) and the manager's test hooks
// (_testSetConsumerDrainTimeout, _testWedgeFlush, sweepStuckFlushes).
// Zero LLM calls.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { formatAgentSenderPrefix } from "../../shared/identity.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

function queueOf(srv: TestServer, id: string): AgentInfo["queue"] {
  return agentOf(srv, id).queue;
}

function stateOf(srv: TestServer, id: string): string {
  return agentOf(srv, id).state;
}

function sessionsFor(srv: TestServer, id: string): FakeSession[] {
  return srv.fakeBackend.sessions.filter((s) => s.opts.agentId === id);
}

// Count of individual sends (across all of the agent's sessions) whose text
// contains `needle` - the exactly-once delivery assertion.
function deliveryCount(srv: TestServer, id: string, needle: string): number {
  return sessionsFor(srv, id).reduce(
    (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
    0,
  );
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  agentType: AgentInfo["agentType"] = "claude",
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
    agentType,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

async function postAgentMessage(
  srv: TestServer,
  receiverId: string,
  senderId: string,
  text: string,
  clientMessageId?: string,
): Promise<{
  status: number;
  body: { messageId?: string; error?: { code: string; message: string } };
}> {
  const payload: Record<string, unknown> = { text };
  if (clientMessageId) payload.clientMessageId = clientMessageId;
  const res = await srv.http(`/api/agents/${receiverId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAgentTokenRaw(senderId)}`,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      messageId?: string;
      error?: { code: string; message: string };
    },
  };
}

async function sendHuman(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
  text: string,
): Promise<void> {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    rawSessionId,
  });
  if (res.status >= 400) throw new Error(`sendHuman -> ${res.status}`);
}

async function userMut(
  srv: TestServer,
  rawSessionId: string,
  method: string,
  path: string,
): Promise<void> {
  const res = await srv.http(path, { method, rawSessionId });
  if (res.status >= 400)
    throw new Error(`userMut ${method} ${path} -> ${res.status}`);
}

function logEntriesFor(sock: TestSocket, agentId: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of sock.messages) {
    const msg = m as { type?: string; entry?: LogEntry };
    if (msg.type === "log_entry" && msg.entry?.agentId === agentId)
      out.push(msg.entry);
  }
  return out;
}

// The durable store as persisted on disk.
function queueFile(
  srv: TestServer,
): Record<
  string,
  { queue?: { text?: string }[]; dedupe?: Record<string, number> }
> {
  const path = join(srv.stateRoot, "message-queues.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function stubClaudeSession(srv: TestServer, sessionId: string): void {
  const configDir = join(srv.stateRoot, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const projectDir = join(
    configDir,
    "projects",
    srv.stateRoot.replace(/[^a-zA-Z0-9-]/g, "-"),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "");
}

// A backend that parks each turn in "thinking" on send (no turn_completed).
function parkingBackend(extra?: {
  manualSend?: boolean;
  hangOnClose?: boolean;
  abortInPlace?: boolean;
}): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------------
// da065287 layer 1 - attach semantics + clean-stream-end backstop
// ---------------------------------------------------------------------------

describe("queue reliability: pendingTurn attach + stream-end backstop (da065287 L1)", () => {
  it("mid-turn clean stream end settles the turn, surfaces the error, releases the dead session, and the agent recovers", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex: the post-death recovery wake starts a FRESH session instead of
    // tripping Claude's resume preflight on the fake session id.
    const a = await spawnAgent(server, "Receiver", room.id, "codex");
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Turn in flight: send accepted, awaiting a turn_completed that never comes.
    await sendHuman(server, owner.rawSessionId, a.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(a.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    await waitUntil(() => stateOf(server!, a.id) === "thinking", 3000, "busy");

    // The stream ends cleanly, mid-turn, with no error event - the case that
    // used to strand `await turn` forever and keep a dead session pointer.
    s1.endStream();

    // The turn settles loudly (caller catch -> error state) instead of hanging.
    await waitUntil(
      () => stateOf(server!, a.id) === "error",
      3000,
      "turn failed loudly",
    );
    await waitUntil(
      () =>
        logEntriesFor(sock, a.id).some(
          (e) =>
            e.kind === "error" &&
            e.content.includes("Backend stream ended unexpectedly mid-turn"),
        ),
      3000,
      "stream-end error surfaced",
    );
    // The dead session pointer was released (dormant tracks session === null).
    expect(agentOf(server, a.id).dormant).toBe(true);

    // Recovery: the human path revives with a FRESH session; the message is
    // delivered there, proving the agent is not wedged.
    await sendHuman(server, owner.rawSessionId, a.id, "after-death");
    await waitUntil(
      () => deliveryCount(server!, a.id, "after-death") === 1,
      3000,
      "recovered delivery",
    );
    expect(sessionsFor(server, a.id).length).toBeGreaterThanOrEqual(2);
  });

  it("mid-turn stream end with a queued item: no replacement turn races the dying caller; the item delivers after human recovery", async () => {
    // Review-pinned (final code review, blockers 2 + 3): the stream-end
    // backstop must NOT synchronously flip state when a pendingTurn existed -
    // that would fire the queue trigger and could start a replacement turn
    // before the rejected caller's catch runs (which would then stamp
    // state=error over the live replacement). And the recovery wake must
    // PRESERVE the caller's claimed busy state - flipping to
    // waiting_for_response with a durable queue present used to race a queue
    // flush into the revive turn's pre-send window (bogus "Superseded by a
    // new turn." flush error, two concurrent sends). The queued item stays
    // durable, waits out the revive turn, and delivers exactly once after it.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const a = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await sendHuman(server, owner.rawSessionId, a.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(a.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    await postAgentMessage(server, a.id, sender.id, "queued-later");
    await waitUntil(() => queueOf(server!, a.id).length === 1, 3000, "q=1");

    s1.endStream();
    await waitUntil(
      () => stateOf(server!, a.id) === "error",
      3000,
      "error state",
    );
    await sleep(150);
    // Not delivered anywhere - no replacement turn raced the dying caller.
    expect(deliveryCount(server, a.id, "queued-later")).toBe(0);
    expect(queueOf(server, a.id).length).toBe(1);
    expect(queueFile(server)[a.id]?.queue?.length).toBe(1); // still durable

    // Human recovery: the wake serializes behind the revive turn.
    await sendHuman(server, owner.rawSessionId, a.id, "revive");
    await waitUntil(
      () => deliveryCount(server!, a.id, "revive") === 1,
      3000,
      "revive delivered",
    );
    const s2 = server.fakeBackend.sessionForAgent(a.id)!;
    // The replacement session's FIRST send is the human revive prompt - the
    // queued item did not jump the line into the pre-send window.
    expect(s2.sent[0].text).toContain("revive");
    expect(s2.sent[0].text).not.toContain("queued-later");
    // And it stays unsent until the revive turn actually completes.
    await sleep(150);
    expect(deliveryCount(server, a.id, "queued-later")).toBe(0);

    s2.completeTurn();
    await waitUntil(
      () => deliveryCount(server!, a.id, "queued-later") === 1,
      3000,
      "queued item delivered post-recovery",
    );
    await waitUntil(() => queueOf(server!, a.id).length === 0, 3000, "drained");

    // No superseded/flush-error fallout anywhere in the flow.
    const entries = logEntriesFor(sock, a.id);
    expect(
      entries.some(
        (e) =>
          e.content.includes("Superseded by a new turn") ||
          e.content.includes("Error flushing queue"),
      ),
    ).toBe(false);
  });

  it("a queued message still delivers promptly when the interrupted turn's send throws (the lost-wakeup interaction)", async () => {
    // The historical wrapper-orphan wedge (see the design doc's root-cause
    // section): pre-fix, a send throw while a waiter had replaced pendingTurn
    // left the wrapper unsettled. With attach semantics the send rejection
    // settles the ONE shared deferred and every attached waiter wakes.
    //
    // Construction: a hot-abortable session that acks abort() but never emits
    // the interrupt's turn_completed, with the kickoff turn parked inside
    // session.send under test control.
    server = await startTestServer({
      fakeBackend: parkingBackend({ manualSend: true, abortInPlace: true }),
    });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex receiver: any session replacement on the way starts a FRESH
    // session instead of tripping Claude's resume preflight on the fake
    // session id (same rationale as queue.test.ts's send_now test).
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Kickoff via the agent path: accept-then-flush parks the flush turn
    // inside session.send (manualSend).
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff in send window");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );

    // NOTE: with manualSend the kickoff item itself is still queued (the drain
    // runs in onSendAccepted, which fires only when session.send resolves), so
    // the queue holds kickoff + queued-2.
    await postAgentMessage(server, recv.id, sender.id, "queued-2");
    await waitUntil(() => queueOf(server!, recv.id).length === 2, 3000, "q=2");

    // Send-now -> abort() -> tryHotAbort attaches to the in-flight turn.
    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/send-now`,
    );
    await sleep(50); // let the abort reach its attach
    // The parked send now throws (backend died taking the interrupt).
    s1.failSends(new Error("send failed during interrupt"));

    // Prompt delivery - well under the 7s hot-abort timeout that was the only
    // (partial) rescuer pre-fix, and with no permanent wedge.
    await waitUntil(
      () => deliveryCount(server!, recv.id, "queued-2") === 1,
      4000,
      "queued item delivered promptly",
    );
    // The delivery flush is parked in the new session's manualSend; release it
    // so the drain completes, proving the flush lifecycle is healthy end-to-end.
    const latest = server.fakeBackend.sessionForAgent(recv.id)!;
    latest.releaseSends();
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
  });
});

// ---------------------------------------------------------------------------
// da065287 layer 2 - bounded consumer drain
// ---------------------------------------------------------------------------

describe("queue reliability: bounded consumer drain (da065287 L2)", () => {
  it("a session whose stream never ends after close() cannot wedge abort/flush; delivery resumes after the drain timeout", async () => {
    server = await startTestServer({
      fakeBackend: parkingBackend({ hangOnClose: true }),
    });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    server.agentManager._testSetConsumerDrainTimeout(300);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );

    await postAgentMessage(server, recv.id, sender.id, "queued-2");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");

    // Send-now -> abort -> slow path (canAbortInPlace false) -> the drain
    // parks on the hung stream. Pre-fix this wedged abortPromise (and the
    // flush parked on it) FOREVER; now the 300ms bound lets the whole normal
    // pipeline complete: replacement installs, flush wakes, item delivers.
    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/send-now`,
    );

    await waitUntil(
      () => deliveryCount(server!, recv.id, "queued-2") === 1,
      4000,
      "delivered past the wedged drain",
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    // Exactly once - the wedged old session never received it.
    expect(s1.sent.some((m) => m.text.includes("queued-2"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// da065287 layer 3 - queue watchdog
// ---------------------------------------------------------------------------

describe("queue reliability: watchdog (da065287 L3)", () => {
  it("gentle path: a message stranded by a missed trigger (model pick no-op) is delivered by the sweep", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Real missed-trigger construction: a message queued during a pending
    // /model pick, where the pick resolves to "Already using X" - the handler
    // returns with no state transition and no flush kick, stranding the item.
    await sendHuman(server, owner.rawSessionId, recv.id, "/model");
    await waitUntil(
      () =>
        (sock.messages as { entry?: LogEntry }[]).some((m) =>
          m.entry?.content?.includes?.("Switch model"),
        ),
      3000,
      "model pick list shown",
    );
    await postAgentMessage(server, recv.id, sender.id, "stranded");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");

    // Pick option 1 - the CURRENT model (spawn default = first family).
    await sendHuman(server, owner.rawSessionId, recv.id, "1");
    await waitUntil(
      () =>
        (sock.messages as { entry?: LogEntry }[]).some((m) =>
          m.entry?.content?.includes?.("Already using"),
        ),
      3000,
      "pick no-oped",
    );
    await sleep(150);
    // Stranded: idle, queued, no flush coming.
    expect(queueOf(server, recv.id).length).toBe(1);
    expect(stateOf(server, recv.id)).toBe("waiting_for_response");

    const acted = await server.agentManager.sweepStuckFlushes(0);
    expect(acted).toBe(1);
    await waitUntil(
      () => deliveryCount(server!, recv.id, "stranded") === 1,
      3000,
      "watchdog delivered",
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
  });

  it("never touches a busy agent (a long turn is not a wedge)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );
    await postAgentMessage(server, recv.id, sender.id, "waiting");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const previousDeadline =
      server.agentManager._testSetBusyTurnWatchdogStuckMs(0);
    try {
      // Thinking is observed once per turn, but it is never acted on.
      expect(await server.agentManager.sweepStuckFlushes(0)).toBe(0);
      expect(await server.agentManager.sweepStuckFlushes(0)).toBe(0);
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("[queue-watchdog] would-act"),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      server.agentManager._testSetBusyTurnWatchdogStuckMs(previousDeadline);
    }
    await sleep(100);
    expect(queueOf(server, recv.id).length).toBe(1);
    expect(s1.sent.length).toBe(1);
  });

  it("does not recover a tool call that is genuinely still running past the deadline", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "claude");
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => session.sent.length === 1, 3000, "kickoff sent");
    session.push({
      kind: "tool_call",
      toolUseId: "still-running",
      name: "Bash",
      input: {},
    });
    await waitUntil(
      () =>
        server!.agentManager.inFlightTurnForLogs(recv.id)?.activeTool?.name ===
        "Bash",
      3000,
      "active tool visible",
    );
    await postAgentMessage(server, recv.id, sender.id, "stay queued");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    const sessionsBefore = sessionsFor(server, recv.id).length;
    const previousDeadline =
      server.agentManager._testSetBusyTurnWatchdogStuckMs(5);
    try {
      await sleep(20);
      expect(await server.agentManager.sweepStuckFlushes()).toBe(0);
    } finally {
      server.agentManager._testSetBusyTurnWatchdogStuckMs(previousDeadline);
    }
    expect(sessionsFor(server, recv.id).length).toBe(sessionsBefore);
    expect(queueOf(server, recv.id).length).toBe(1);
  });

  it("waits for the non-zero quiescence deadline and skips an abort already in progress", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "claude");
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => session.sent.length === 1, 3000, "kickoff sent");
    session.push({
      kind: "tool_call",
      toolUseId: "completed",
      name: "Read",
      input: {},
    });
    session.push({
      kind: "tool_result",
      toolUseId: "completed",
      content: "done",
    });
    await waitUntil(
      () =>
        stateOf(server!, recv.id) === "tool_executing" &&
        server!.agentManager.inFlightTurnForLogs(recv.id)?.activeTool === null,
      3000,
      "quiescent tool turn",
    );
    await postAgentMessage(server, recv.id, sender.id, "release me");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    stubClaudeSession(server, session.sessionId);
    const sessionsBefore = sessionsFor(server, recv.id).length;
    const previousDeadline =
      server.agentManager._testSetBusyTurnWatchdogStuckMs(500);
    try {
      expect(await server.agentManager.sweepStuckFlushes()).toBe(0);
      server.agentManager._testSetAbortInProgress(recv.id, true);
      await sleep(510);
      expect(await server.agentManager.sweepStuckFlushes()).toBe(0);
      expect(sessionsFor(server, recv.id).length).toBe(sessionsBefore);
      server.agentManager._testSetAbortInProgress(recv.id, false);
      expect(await server.agentManager.sweepStuckFlushes()).toBe(1);
    } finally {
      server.agentManager._testSetAbortInProgress(recv.id, false);
      server.agentManager._testSetBusyTurnWatchdogStuckMs(previousDeadline);
    }
  });

  it("recovers a quiescent Claude tool turn, clears leaked prior-turn tools, normalizes state, and delivers the queue", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "claude");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // First turn leaks a tool call, then settles. Per-turn cleanup must remove
    // it so it neither appears in observability nor disables later recovery.
    await sendHuman(server, owner.rawSessionId, recv.id, "first turn");
    const first = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => first.sent.length === 1, 3000, "first sent");
    first.push({
      kind: "tool_call",
      toolUseId: "leaked",
      name: "Bash",
      input: {},
    });
    await waitUntil(
      () =>
        server!.agentManager.inFlightTurnForLogs(recv.id)?.activeTool?.name ===
        "Bash",
      3000,
      "leaked tool visible during its turn",
    );
    first.completeTurn();
    await waitUntil(
      () => stateOf(server!, recv.id) === "waiting_for_response",
      3000,
      "first settled",
    );
    expect(server.agentManager.inFlightTurnForLogs(recv.id)).toBe(null);
    expect(server.agentManager._testActiveToolCount(recv.id)).toBe(0);

    // Second turn reaches the measured wedge shape: formal turn owner, sticky
    // tool_executing state, but the matching result leaves no tool running.
    await sendHuman(server, owner.rawSessionId, recv.id, "second turn");
    await waitUntil(() => first.sent.length === 2, 3000, "second sent");
    first.push({
      kind: "tool_call",
      toolUseId: "completed",
      name: "Read",
      input: {},
    });
    first.push({
      kind: "tool_result",
      toolUseId: "completed",
      content: "done",
    });
    await waitUntil(
      () =>
        stateOf(server!, recv.id) === "tool_executing" &&
        server!.agentManager.inFlightTurnForLogs(recv.id)?.activeTool === null,
      3000,
      "quiescent tool turn",
    );
    await postAgentMessage(server, recv.id, sender.id, "release me");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    stubClaudeSession(server, first.sessionId);

    const previousDeadline =
      server.agentManager._testSetBusyTurnWatchdogStuckMs(0);
    const beforeSweep = sock.messages.length;
    try {
      expect(await server.agentManager.sweepStuckFlushes()).toBe(1);
    } finally {
      server.agentManager._testSetBusyTurnWatchdogStuckMs(previousDeadline);
    }
    await waitUntil(
      () => deliveryCount(server!, recv.id, "release me") === 1,
      3000,
      "busy watchdog delivered",
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    await waitUntil(
      () =>
        sock.messages.slice(beforeSweep).some((message) => {
          const event = message as {
            type?: string;
            agentId?: string;
            changes?: { state?: string };
          };
          return (
            event.type === "agent_updated" &&
            event.agentId === recv.id &&
            event.changes?.state === "waiting_for_response"
          );
        }),
      3000,
      "queue-idle state emitted",
    );
    expect(
      sock.messages.slice(beforeSweep).some((message) => {
        const event = message as {
          type?: string;
          agentId?: string;
          changes?: { state?: string };
        };
        return (
          event.type === "agent_updated" &&
          event.agentId === recv.id &&
          event.changes?.state === "waiting_for_response"
        );
      }),
    ).toBe(true);
    expect(
      logEntriesFor(sock, recv.id).some(
        (entry) => entry.content === "Message delivery stalled; recovering.",
      ),
    ).toBe(true);
  });

  it("observes the same quiescent signature on Codex without recovering it", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => session.sent.length === 1, 3000, "kickoff sent");
    session.push({
      kind: "tool_call",
      toolUseId: "done",
      name: "Bash",
      input: {},
    });
    session.push({ kind: "tool_result", toolUseId: "done", content: "ok" });
    await waitUntil(
      () =>
        stateOf(server!, recv.id) === "tool_executing" &&
        server!.agentManager.inFlightTurnForLogs(recv.id)?.activeTool === null,
      3000,
      "Codex signature",
    );
    await postAgentMessage(server, recv.id, sender.id, "stay queued");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    const sessionsBefore = sessionsFor(server, recv.id).length;
    const previousDeadline =
      server.agentManager._testSetBusyTurnWatchdogStuckMs(0);
    try {
      expect(await server.agentManager.sweepStuckFlushes()).toBe(0);
    } finally {
      server.agentManager._testSetBusyTurnWatchdogStuckMs(previousDeadline);
    }
    expect(sessionsFor(server, recv.id).length).toBe(sessionsBefore);
    expect(queueOf(server, recv.id).length).toBe(1);
    // An observation must not spend the cooldown shared by real recovery.
    expect(server.agentManager._testLastForcedRecoveryAt(recv.id)).toBe(0);
  });

  it("forced path: attempts a session-replacement recovery once, then respects the cooldown (never force-clears flushInProgress)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex: forced recovery's auto-resume starts a fresh session (no Claude
    // resume preflight on the fake session id).
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Simulate an unknown-bug wedge: flushInProgress held with an aged start
    // stamp. (Once L1/L2 exist, every wire-constructible wedge is recovered by
    // those layers themselves; the forced path is insurance for wedges we
    // haven't found, which by definition can't be built via honest machinery.)
    server.agentManager._testWedgeFlush(recv.id, 120_000);
    // The enqueue's own flush kick is gated off by the wedged flag.
    await postAgentMessage(server, recv.id, sender.id, "behind-the-wedge");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    const sessionsBefore = sessionsFor(server, recv.id).length;

    const acted = await server.agentManager.sweepStuckFlushes(0);
    expect(acted).toBe(1);
    // Recovery ATTEMPTED: chat entry + a replacement session. The synthetic
    // wedge has no real zombie flush to settle, so the flag stays held and the
    // queue stays put - the documented honest-terminal residue; delivery is
    // NOT asserted here on purpose. flushInProgress is never force-cleared.
    await waitUntil(
      () =>
        logEntriesFor(sock, recv.id).some((e) =>
          e.content.includes("Message delivery stalled; recovering."),
        ),
      3000,
      "recovery surfaced in chat",
    );
    await waitUntil(
      () => sessionsFor(server!, recv.id).length === sessionsBefore + 1,
      3000,
      "session replaced",
    );
    expect(queueOf(server, recv.id).length).toBe(1);

    // Immediate second sweep: cooldown holds - no second replacement, no spam.
    expect(await server.agentManager.sweepStuckFlushes(0)).toBe(0);
    expect(sessionsFor(server, recv.id).length).toBe(sessionsBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// 314ee9fb - wake vs. mid-drain swap
// ---------------------------------------------------------------------------

describe("queue reliability: wake vs. swap (314ee9fb gating)", () => {
  it("a message arriving during a swap's blocked drain waits and delivers exactly once into the post-swap session", async () => {
    server = await startTestServer({
      fakeBackend: parkingBackend({ hangOnClose: true }),
    });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);

    // Agents spawn lazy - give the receiver a LIVE session (kickoff turn,
    // completed) so setPrivileged actually has a session to swap.
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    s1.completeTurn();
    await waitUntil(
      () => stateOf(server!, recv.id) === "waiting_for_response",
      3000,
      "idle with live session",
    );

    // Out-of-band swap parks on the hung drain (default 15s bound - released
    // manually below, well before it).
    const swapDone = server.agentManager.setPrivileged(recv.id, true);
    await waitUntil(
      () => agentOf(server!, recv.id).sessionSwapping === true,
      3000,
      "swap draining",
    );

    // Inbound message mid-drain: the flush wake DEFERS to the swap (no wake
    // session is installed; the item stays queued).
    await postAgentMessage(server, recv.id, sender.id, "mid-drain");
    await sleep(150);
    expect(queueOf(server, recv.id).length).toBe(1);
    expect(sessionsFor(server, recv.id).length).toBe(2); // kickoff + swap replacement only

    // Release the drain: the swap installs its replacement and its post-swap
    // kick delivers the queued item there - exactly once.
    s1.endStream();
    await swapDone;
    await waitUntil(
      () => deliveryCount(server!, recv.id, "mid-drain") === 1,
      3000,
      "delivered post-swap",
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    expect(agentOf(server, recv.id).privileged).toBe(true);
    // Into the replacement, never the wedged old session.
    expect(s1.sent.some((m) => m.text.includes("mid-drain"))).toBe(false);
  });

  it("a human wake that wins the drain window is kept - the swap discards its own replacement instead of clobbering the live turn", async () => {
    server = await startTestServer({
      fakeBackend: parkingBackend({ hangOnClose: true }),
    });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");

    // Lazy spawn: give the receiver a live session first (see previous test).
    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    s1.completeTurn();
    await waitUntil(
      () => stateOf(server!, recv.id) === "waiting_for_response",
      3000,
      "idle with live session",
    );

    const swapDone = server.agentManager.setPrivileged(recv.id, true);
    await waitUntil(
      () => agentOf(server!, recv.id).sessionSwapping === true,
      3000,
      "swap draining",
    );
    // The swap's replacement was created up front (session #2), then the swap
    // parked on the drain.
    expect(sessionsFor(server, recv.id).length).toBe(2);
    const swapReplacement = sessionsFor(server, recv.id)[1];

    // Human message mid-drain: sendMessage's wakeSessionForSend wins the
    // window and installs session #3; the turn parks there (parking backend).
    await sendHuman(server, owner.rawSessionId, recv.id, "hello-mid-drain");
    await waitUntil(
      () => sessionsFor(server!, recv.id).length === 3,
      3000,
      "wake session installed",
    );
    const wake = sessionsFor(server, recv.id)[2];
    await waitUntil(() => wake.sent.length === 1, 3000, "wake turn sent");

    // Release the drain: the swap sees the wake session installed, keeps it,
    // and closes its own never-installed replacement.
    s1.endStream();
    await swapDone;
    expect(deliveryCount(server, recv.id, "hello-mid-drain")).toBe(1);
    expect(swapReplacement.sent.length).toBe(0);
    expect(swapReplacement.closed).toBe(true);
    expect(agentOf(server, recv.id).privileged).toBe(true);
    // The wake turn is still LIVE on its own consumer: completing it flows
    // through to the state machine (a clobbered consumer would drop it).
    expect(stateOf(server, recv.id)).toBe("thinking");
    wake.completeTurn({ text: "done" });
    await waitUntil(
      () => stateOf(server!, recv.id) === "waiting_for_response",
      3000,
      "wake turn completed through its consumer",
    );
  });
});

// ---------------------------------------------------------------------------
// 9870b472 - durable queues
// ---------------------------------------------------------------------------

describe("queue reliability: durable queues (9870b472)", () => {
  it("acceptance writes the item + dedupe key to disk; the drain empties it", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const s1 = server.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => s1.sent.length === 1, 3000, "kickoff sent");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );

    await postAgentMessage(server, recv.id, sender.id, "durable-1", "cid-d1");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    const persisted = queueFile(server)[recv.id];
    expect(persisted?.queue?.length).toBe(1);
    expect(persisted?.queue?.[0]?.text).toBe("durable-1");
    expect(typeof persisted?.dedupe?.["cid-d1"]).toBe("number");

    s1.completeTurn();
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    await waitUntil(
      () => (queueFile(server!)[recv.id]?.queue?.length ?? 0) === 0,
      3000,
      "durable removal",
    );
  });

  it("a restart replays queued messages in order (one coalesced prompt) and the dedupe window survives", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex: the boot-replay wake starts a fresh session (no Claude resume
    // preflight against the fake session id).
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);

    // Busy via the HUMAN path (no queue-store involvement), then two queued
    // agent messages that would have been dropped by a restart pre-fix.
    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );
    await postAgentMessage(server, recv.id, sender.id, "m-one", "cid-1");
    await postAgentMessage(server, recv.id, sender.id, "m-two", "cid-2");
    await waitUntil(() => queueOf(server!, recv.id).length === 2, 3000, "q=2");
    const sendsBefore = sessionsFor(server, recv.id).reduce(
      (n, s) => n + s.sent.length,
      0,
    );

    server = await server.restart();

    // Boot replay: the kick wakes the (dormant) agent and delivers ONE
    // coalesced prompt - plural busy-note, FIFO order, sender prefixes.
    await waitUntil(
      () => deliveryCount(server!, recv.id, "m-two") === 1,
      5000,
      "replayed delivery",
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    const replaySession = sessionsFor(server, recv.id)
      .slice()
      .reverse()
      .find((s) => s.sent.some((m) => m.text.includes("m-two")))!;
    const prompt = replaySession.sent.find((m) =>
      m.text.includes("m-two"),
    )!.text;
    const prefix = formatAgentSenderPrefix(sender.id, "Sender", room.name);
    const expected = [
      "[Note: these messages were queued while you were processing your previous turn - the sender had not seen your most recent reply when they sent them.]",
      `${prefix} m-one`,
      `${prefix} m-two`,
    ].join("\n\n");
    expect(prompt).toBe(expected);
    // One coalesced send, not one per item.
    const sendsAfter = sessionsFor(server, recv.id).reduce(
      (n, s) => n + s.sent.length,
      0,
    );
    expect(sendsAfter).toBe(sendsBefore + 1);

    // The dedupe window survived the restart: a sender retry with a replayed
    // clientMessageId must not deliver twice.
    const retry = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "m-one",
      "cid-1",
    );
    expect(retry.status).toBe(200);
    await sleep(150);
    expect(deliveryCount(server, recv.id, "m-one")).toBe(1);
    expect(queueOf(server, recv.id).length).toBe(0);
  });

  it("explicit clears persist (newConversation) and kill removes the record", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const other = await spawnAgent(server, "Other", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    for (const target of [recv, other]) {
      await postAgentMessage(server, target.id, sender.id, "kick");
      await waitUntil(
        () => stateOf(server!, target.id) === "thinking",
        3000,
        "busy",
      );
      await postAgentMessage(
        server,
        target.id,
        sender.id,
        `queued-${target.id}`,
      );
      await waitUntil(
        () => queueOf(server!, target.id).length === 1,
        3000,
        "q=1",
      );
    }
    expect(queueFile(server)[recv.id]?.queue?.length).toBe(1);
    expect(queueFile(server)[other.id]?.queue?.length).toBe(1);

    // /clear drops the queue - durably.
    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/new-conversation`,
    );
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "cleared",
    );
    await waitUntil(
      () => (queueFile(server!)[recv.id]?.queue?.length ?? 0) === 0,
      3000,
      "clear persisted",
    );

    // kill removes the whole record (no replay into a future revive).
    await server.agentManager.kill(other.id);
    await waitUntil(
      () => queueFile(server!)[other.id] === undefined,
      3000,
      "record removed on kill",
    );
  });

  it("a corrupt store is quarantined at boot and the server starts with empty queues", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const path = join(server.stateRoot, "message-queues.json");
    writeFileSync(path, "{ not json !!!");

    server = await server.restart();

    expect(queueOf(server, recv.id).length).toBe(0);
    const quarantined = readdirSync(server.stateRoot).filter((f) =>
      f.startsWith("message-queues.json.corrupt-"),
    );
    expect(quarantined.length).toBe(1);
  });

  it("a failed durable write rejects the send with 500 persist_failed and rolls back cleanly (dedupe key reusable)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // Busy via the human path (no store write involved in the kickoff).
    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );

    // Make the durable write fail: atomicWriteFileSync renames onto the store
    // path, which cannot succeed while it is a non-empty DIRECTORY.
    const path = join(server.stateRoot, "message-queues.json");
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "x");

    const failed = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "durable",
      "cid-p",
    );
    expect(failed.status).toBe(500);
    expect(failed.body.error?.code).toBe("persist_failed");
    // Rolled back: nothing queued.
    expect(queueOf(server, recv.id).length).toBe(0);

    // Unblock the disk and retry with the SAME clientMessageId: the rollback
    // must have released the dedupe key, so the retry is accepted for real.
    rmSync(path, { recursive: true, force: true });
    const retried = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "durable",
      "cid-p",
    );
    expect(retried.status).toBe(200);
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 3000, "q=1");
    expect(queueFile(server)[recv.id]?.queue?.length).toBe(1);
  });

  it("a failed acceptance leaves no phantom in the store cache: a later save for ANOTHER agent must not resurrect it", async () => {
    // Review-pinned (final code review, blocker 1): store writes are
    // copy-on-success. Pre-fix, the failed write's mutation stayed in the
    // in-memory cache, and the next successful save (for any agent)
    // serialized the whole cache - resurrecting a message whose sender was
    // told 500.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recvA = await spawnAgent(server, "ReceiverA", room.id, "codex");
    const recvB = await spawnAgent(server, "ReceiverB", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);

    // Busy both via the human path (no store writes involved).
    for (const r of [recvA, recvB]) {
      await sendHuman(server, owner.rawSessionId, r.id, "kickoff");
      await waitUntil(
        () => stateOf(server!, r.id) === "thinking",
        3000,
        "busy",
      );
    }

    // Block the disk; A's acceptance fails and rolls back.
    const path = join(server.stateRoot, "message-queues.json");
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "x");
    const failed = await postAgentMessage(
      server,
      recvA.id,
      sender.id,
      "phantom",
      "cid-a",
    );
    expect(failed.status).toBe(500);
    expect(queueOf(server, recvA.id).length).toBe(0);

    // Unblock and successfully persist for B.
    rmSync(path, { recursive: true, force: true });
    const okB = await postAgentMessage(
      server,
      recvB.id,
      sender.id,
      "b-real",
      "cid-b",
    );
    expect(okB.status).toBe(200);
    await waitUntil(
      () => queueOf(server!, recvB.id).length === 1,
      3000,
      "B q=1",
    );

    // B's save must not have dragged A's rolled-back record onto disk.
    const store = queueFile(server);
    expect(store[recvB.id]?.queue?.length).toBe(1);
    expect(store[recvA.id]).toBeUndefined();

    // And it stays dead across a restart: A replays nothing, B replays its item.
    server = await server.restart();
    expect(queueOf(server, recvA.id).length).toBe(0);
    await waitUntil(
      () => deliveryCount(server!, recvB.id, "b-real") === 1,
      5000,
      "B replayed",
    );
    expect(deliveryCount(server, recvA.id, "phantom")).toBe(0);
  });
});
