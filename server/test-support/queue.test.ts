// Phase 1.4a — Queue / coalescing / notification characterization.
//
// Freezes the OBSERVABLE behavior of the message queue before Phase 3 moves the
// orchestrator/transport: how messages addressed to a busy agent are queued,
// coalesced into one backend prompt on the next idle transition (sender prefixes
// + the busy note), the dedupe/cap/reject contracts on the agent-to-agent HTTP
// entry point, cancel/send-now, and the turnHadHumanInput notification gate.
//
// Seam: the WS harness (startTestServer). The wire IS the boundary here — queue
// chips reach clients as `agent_updated` { changes: { queue } }, the per-message
// provenance lands as `log_entry`, and the agent-to-agent POST returns the raw
// EnqueueResult. The coalesced SDK prompt the backend receives is read off the
// injected FakeSession (`fakeBackend.sessionForAgent(id).sent`). In-memory state
// is read via `agentManager` (note: getAgent().queue is always empty by design —
// the live queue is spliced in only by getAllAgents(), which is what full_state
// uses; turnHadHumanInput IS on info).
//
// Busy control: a non-auto-completing FakeBackend whose onSend pushes a single
// `assistant_text` (-> state "thinking") without a turn_completed, so the agent
// parks busy until the test calls completeTurn(). This mirrors onboarding's
// per-state scripting and gives clean, explicit turn boundaries.
//
// Zero LLM calls. The two agent entry points are deliberately distinguished:
//   - human WS send_message when IDLE -> immediate turn (no enqueue), only
//     enqueues when busy (state thinking/tool_executing, non-slash, no pending);
//   - agent HTTP POST -> always enqueueMessage, which accepts-then-flushes when
//     idle (queued:false) and queues when busy (queued:true).

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw, mintRunToken } from "../identity/tokens.ts";
import {
  formatPrefix,
  formatAgentSenderPrefix,
} from "../../shared/identity.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A backend that parks each turn in "thinking" on send (no turn_completed), so a
// test can hold an agent busy and release it explicitly via completeTurn().
function parkingBackend(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

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

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

// Live queue (getAllAgents splices messageQueue in; getAgent().queue does not).
function queueOf(srv: TestServer, id: string): AgentInfo["queue"] {
  return agentOf(srv, id).queue;
}

function stateOf(srv: TestServer, id: string): string {
  return agentOf(srv, id).state;
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  // Positional spawn(name, cwd, permissionMode, desk, customInstructions,
  // roomId, outfit, modelFamily, effort, username, agentType, ...).
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

interface PostResult {
  status: number;
  body: {
    ok?: boolean;
    queued?: boolean;
    deduped?: boolean;
    messageId?: string;
    error?: string;
  };
}

// Agent-to-agent entry point: POST /agents/:receiverId/message. Bearer-required
// after the loopback-bypass removal: the sender's auto-injected AGENT bearer
// (ISOMUX_AGENT_TOKEN, resolved here via getAgentTokenRaw) IS the sender, so the
// body no longer carries senderAgentId on the happy path — it's token-derived.
// A null senderId (or one with no minted token) sends NO bearer, exercising the
// no-identity 401 path (the harness fetches 127.0.0.1, but loopback is no longer
// trusted for /agents/).
async function postAgentMessage(
  srv: TestServer,
  receiverId: string,
  senderId: string | null,
  text: string | null,
  clientMessageId?: string,
): Promise<PostResult> {
  const payload: Record<string, unknown> = {};
  if (text !== null) payload.text = text;
  if (clientMessageId) payload.clientMessageId = clientMessageId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bearer = senderId !== null ? getAgentTokenRaw(senderId) : null;
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await srv.http(`/agents/${receiverId}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as PostResult["body"] };
}

// All log_entry events on a socket for one agent, in arrival order.
function logEntriesFor(sock: TestSocket, agentId: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of sock.messages) {
    const msg = m as { type?: string; entry?: LogEntry };
    if (msg.type === "log_entry" && msg.entry?.agentId === agentId)
      out.push(msg.entry);
  }
  return out;
}

// True if the socket received an agent_updated for this agent whose changes
// carry turnHadHumanInput === value (the notification-gate WIRE signal — the UI
// reads this off the wire to gate the turn-end sound, not the manager state).
function sawTurnFlag(
  sock: TestSocket,
  agentId: string,
  value: boolean,
): boolean {
  return sock.messages.some((m) => {
    const u = m as {
      type?: string;
      agentId?: string;
      changes?: { turnHadHumanInput?: boolean };
    };
    return (
      u.type === "agent_updated" &&
      u.agentId === agentId &&
      u.changes?.turnHadHumanInput === value
    );
  });
}

// True if the socket received an agent_updated whose changes.queue is exactly
// the given ordered list of queued-message ids (the queue-chip WIRE signal).
function sawQueueIds(
  sock: TestSocket,
  agentId: string,
  ids: string[],
): boolean {
  return sock.messages.some((m) => {
    const u = m as {
      type?: string;
      agentId?: string;
      changes?: { queue?: { id: string }[] };
    };
    if (u.type !== "agent_updated" || u.agentId !== agentId) return false;
    const q = u.changes?.queue;
    return (
      Array.isArray(q) &&
      q.length === ids.length &&
      q.every((item, i) => item.id === ids[i])
    );
  });
}

describe("queue: entry points (Phase 1.4a)", () => {
  it("idle human send_message starts an immediate turn — no enqueue, no chip", async () => {
    server = await startTestServer({
      // Auto-complete so the single turn finishes; we assert no queueing happened.
      fakeBackend: new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      }),
    });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const a = await spawnAgent(server, "Receiver", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    sock.send({ type: "send_message", agentId: a.id, text: "hello" });

    // The turn runs to completion; the queue is never populated.
    await waitUntil(
      () => stateOf(server!, a.id) === "waiting_for_response",
      2000,
      "turn completes",
    );
    expect(queueOf(server, a.id).length).toBe(0);
    // Exactly one backend send (the immediate turn), nothing coalesced.
    expect(server.fakeBackend.sessionForAgent(a.id)?.sent.length).toBe(1);
  });

  it("agent POST when idle accepts-then-flushes (queued:false); when busy it queues (queued:true)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // Idle receiver: enqueueMessage accepts and immediately flushes.
    const r1 = await postAgentMessage(server, recv.id, sender.id, "first");
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, queued: false });
    expect(typeof r1.body.messageId).toBe("string");

    // That flush parks the receiver busy (onSend pushed assistant_text).
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "receiver busy after first flush",
    );

    // Busy receiver: the next POST queues.
    const r2 = await postAgentMessage(server, recv.id, sender.id, "second");
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ ok: true, queued: true });
    expect(queueOf(server, recv.id).length).toBe(1);
  });
});

describe("queue: coalescing (Phase 1.4a)", () => {
  it("coalesces queued human + agent messages in FIFO order with busy-note and rendered sender prefixes", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // msg1 (human, idle) -> immediate turn, parks the agent busy.
    sock.send({ type: "send_message", agentId: recv.id, text: "kickoff" });
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy after kickoff",
    );
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    // Wait for the kickoff to actually reach the backend before queueing more:
    // beginTurn flips state to "thinking" BEFORE session.send, so a bare
    // sent.length check here races the send (flaky under load). sent===1 also
    // confirms nothing is coalesced yet.
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");

    // msg2 (human, WS) + msg3 (agent, HTTP) arrive while busy -> queue in order.
    sock.send({ type: "send_message", agentId: recv.id, text: "human-two" });
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");
    await postAgentMessage(server, recv.id, sender.id, "agent-three");
    await waitUntil(() => queueOf(server!, recv.id).length === 2, 2000, "q=2");

    // The live chips reached the wire as agent_updated { changes: { queue } }.
    // Wait for WS delivery: the in-memory queue updates before the event lands
    // on the socket, so a synchronous read here would race the delivery.
    await waitUntil(
      () =>
        sock.messages.some((m) => {
          const u = m as {
            type?: string;
            agentId?: string;
            changes?: { queue?: unknown[] };
          };
          return (
            u.type === "agent_updated" &&
            u.agentId === recv.id &&
            Array.isArray(u.changes?.queue) &&
            u.changes.queue.length === 2
          );
        }),
      2000,
      "wire queue length 2",
    );

    // Release msg1's turn -> the idle transition flushes the queue as ONE prompt.
    session.completeTurn({ text: "done" });
    await waitUntil(() => session.sent.length === 2, 2000, "coalesced send");

    // Build the exact expected coalesced prompt. Two items queued-while-busy ->
    // plural busy note; FIFO order; user prefix then agent prefix; "\n\n" joins.
    const note =
      "[Note: these messages were queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent them.]";
    const userPrefix = formatPrefix({ username: owner.username }); // "[Boss] "
    const agentPrefix = `${formatAgentSenderPrefix(sender.id, "Sender", room.name)} `;
    const expected = [
      note,
      `${userPrefix}human-two`,
      `${agentPrefix}agent-three`,
    ].join("\n\n");
    expect(session.sent[1].text).toBe(expected);

    // Per-message user_message provenance lands in FIFO order with sender
    // metadata. Wait for both entries to arrive on the wire before asserting.
    await waitUntil(
      () => {
        const c = logEntriesFor(sock, recv.id)
          .filter((e) => e.kind === "user_message")
          .map((e) => e.content);
        return c.includes("human-two") && c.includes("agent-three");
      },
      2000,
      "user_message provenance on wire",
    );
    const userMsgs = logEntriesFor(sock, recv.id).filter(
      (e) => e.kind === "user_message",
    );
    const texts = userMsgs.map((e) => e.content);
    const i2 = texts.indexOf("human-two");
    const i3 = texts.indexOf("agent-three");
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i3).toBeGreaterThan(i2);
    expect(userMsgs[i2].metadata?.username).toBe(owner.username);
    expect(userMsgs[i2].metadata?.device).toBeUndefined();
    expect(userMsgs[i3].metadata?.sender_agent_id).toBe(sender.id);
  });

  it("uses the singular busy note for a single queued message", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    // Ensure the kickoff reached the backend (pendingTurn installed) before we
    // completeTurn it below — beginTurn flips state to "thinking" before send.
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");

    await postAgentMessage(server, recv.id, sender.id, "only-one");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");

    session.completeTurn();
    await waitUntil(() => session.sent.length === 2, 2000, "coalesced send");

    const note =
      "[Note: this message was queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent it.]";
    const agentPrefix = `${formatAgentSenderPrefix(sender.id, "Sender", room.name)} `;
    expect(session.sent[1].text).toBe(
      [note, `${agentPrefix}only-one`].join("\n\n"),
    );
  });
});

describe("queue: notifications / turnHadHumanInput (Phase 1.4a)", () => {
  it("isolates each flip: agent-only baseline false -> mixed flush true -> agent-only flush false", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // --- baseline: an AGENT-only kickoff turn leaves turnHadHumanInput false,
    // so the false->true flip below is isolated (not pre-satisfied by a human
    // kickoff). beginTurn stamps the flag at turn START from items.some(user).
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    const session = server.fakeBackend.sessionForAgent(recv.id)!;
    // Ensure the kickoff reached the backend (pendingTurn installed) before the
    // later completeTurn — beginTurn flips state to "thinking" before send.
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");
    expect(agentOf(server, recv.id).turnHadHumanInput).toBe(false);

    // --- mixed human + agent flush -> flips false to true ---
    sock.send({ type: "send_message", agentId: recv.id, text: "human" });
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");
    await postAgentMessage(server, recv.id, sender.id, "agent");
    await waitUntil(() => queueOf(server!, recv.id).length === 2, 2000, "q=2");
    session.completeTurn();
    await waitUntil(() => session.sent.length === 2, 2000, "mixed flush");
    // Assert the WIRE signal (the UI gates the sound on this), then the state.
    await waitUntil(
      () => sawTurnFlag(sock, recv.id, true),
      2000,
      "wire turnHadHumanInput=true",
    );
    expect(agentOf(server, recv.id).turnHadHumanInput).toBe(true);

    // --- agent-only flush -> flips true back to false ---
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy2",
    );
    await postAgentMessage(server, recv.id, sender.id, "agent-only");
    await waitUntil(
      () => queueOf(server!, recv.id).length === 1,
      2000,
      "q=1 again",
    );
    session.completeTurn();
    await waitUntil(() => session.sent.length === 3, 2000, "agent-only flush");
    await waitUntil(
      () => sawTurnFlag(sock, recv.id, false),
      2000,
      "wire turnHadHumanInput=false",
    );
    expect(agentOf(server, recv.id).turnHadHumanInput).toBe(false);
  });
});

describe("queue: dedupe / cap / reject contracts (Phase 1.4a)", () => {
  it("dedupes a repeated clientMessageId per-receiver, not globally", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recvA = await spawnAgent(server, "ReceiverA", room.id);
    const recvB = await spawnAgent(server, "ReceiverB", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // Make both receivers busy so the messages queue (and dedupe is observable
    // on queue length rather than racing a flush).
    await postAgentMessage(server, recvA.id, sender.id, "kickA");
    await postAgentMessage(server, recvB.id, sender.id, "kickB");
    await waitUntil(
      () => stateOf(server!, recvA.id) === "thinking",
      2000,
      "A busy",
    );
    await waitUntil(
      () => stateOf(server!, recvB.id) === "thinking",
      2000,
      "B busy",
    );

    const first = await postAgentMessage(
      server,
      recvA.id,
      sender.id,
      "dup",
      "cid-1",
    );
    expect(first.body).toMatchObject({ ok: true, queued: true });
    const repeat = await postAgentMessage(
      server,
      recvA.id,
      sender.id,
      "dup",
      "cid-1",
    );
    expect(repeat.body).toMatchObject({
      ok: true,
      queued: false,
      deduped: true,
    });
    expect(queueOf(server, recvA.id).length).toBe(1); // no second copy

    // Same clientMessageId to a DIFFERENT receiver is not deduped.
    const other = await postAgentMessage(
      server,
      recvB.id,
      sender.id,
      "dup",
      "cid-1",
    );
    expect(other.body).toMatchObject({ ok: true, queued: true });
    expect(other.body.deduped).toBeUndefined();
    expect(queueOf(server, recvB.id).length).toBe(1);
  });

  it("rejects the 51st message with 429 queue_full and leaves the queue at 50", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // First message flushes immediately and parks busy; subsequent ones queue.
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );

    for (let i = 0; i < 50; i++) {
      const r = await postAgentMessage(server, recv.id, sender.id, `q${i}`);
      expect(r.body.queued).toBe(true);
    }
    expect(queueOf(server, recv.id).length).toBe(50);

    const overflow = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "too-many",
    );
    expect(overflow.status).toBe(429);
    expect(overflow.body.error).toBe("queue_full");
    expect(queueOf(server, recv.id).length).toBe(50); // unchanged
  });

  it("rejects malformed / self / unknown-receiver / error-state sends with today's status codes", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // Missing text (valid AGENT bearer) -> 400. The old "missing / unknown
    // senderAgentId -> 400" cases are gone: the sender is token-derived, not
    // body-sourced (see the bearer-required sender-authority block below).
    expect(
      (await postAgentMessage(server, recv.id, sender.id, null)).status,
    ).toBe(400);
    // Send-to-self -> 400 (sender derived from the bearer equals the receiver).
    expect(
      (await postAgentMessage(server, recv.id, recv.id, "hi")).status,
    ).toBe(400);
    // Unknown receiver (valid sender bearer) -> 404 from enqueueMessage.
    const unknown = await postAgentMessage(
      server,
      "agent-bogus",
      sender.id,
      "hi",
    );
    expect(unknown.status).toBe(404);

    // Error-state receiver -> 409. Drive a failed turn to reach state "error".
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    server.fakeBackend
      .sessionForAgent(recv.id)!
      .completeTurn({ status: "failed", error: "boom" });
    await waitUntil(
      () => stateOf(server!, recv.id) === "error",
      2000,
      "error state",
    );
    const rejected = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "after-error",
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("agent_error");
  });
});

describe("queue: cancel / send-now / new-conversation (Phase 1.4a)", () => {
  it("cancel_queued (WS) removes a queued item and re-emits the queue without it", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    const keep = await postAgentMessage(server, recv.id, sender.id, "keep");
    const drop = await postAgentMessage(server, recv.id, sender.id, "drop");
    await waitUntil(() => queueOf(server!, recv.id).length === 2, 2000, "q=2");

    // Drive the real WS command (the boundary), not the manager method directly.
    sock.send({
      type: "cancel_queued",
      agentId: recv.id,
      messageId: drop.body.messageId,
    });

    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");
    expect(queueOf(server, recv.id)[0].id).toBe(keep.body.messageId!);
    // Wire: the re-emitted queue carries only the kept id.
    await waitUntil(
      () => sawQueueIds(sock, recv.id, [keep.body.messageId!]),
      2000,
      "wire re-emit without dropped id",
    );
  });

  it("send_now (WS) drains the queue to the backend", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex receiver: send-now on a busy agent aborts, and the slow-path abort
    // (FakeSession.canAbortInPlace()===false) reinstalls a session. Codex's
    // auto-resume returns null without on-disk history, so it starts a FRESH
    // session and dodges Claude's resume preflight (which would reject the fake
    // session id's missing .jsonl). The Claude abort->resume-real-session path
    // needs a seeded transcript and is covered by the resume block, not here.
    // The queue contract frozen here is backend-agnostic: the item leaves the
    // queue and reaches a backend session.
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );

    await postAgentMessage(server, recv.id, sender.id, "queued-1");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");

    sock.send({ type: "send_now", agentId: recv.id });

    // The queued item leaves the queue and reaches a backend session (today's
    // contract; not pinning which concrete session, since send-now aborts +
    // reinstalls).
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    const reached = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .some((s) => s.sent.some((m) => m.text.includes("queued-1")));
    expect(reached).toBe(true);
  });

  it("new_conversation (WS) clears the queue and no queued prompt bleeds into the new session", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    await postAgentMessage(server, recv.id, sender.id, "will-be-dropped");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");

    const beforeSends = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .reduce((n, s) => n + s.sent.length, 0);

    sock.send({ type: "new_conversation", agentId: recv.id });

    // Queue cleared (and emitted as such), state reset to idle.
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      2000,
      "cleared",
    );
    // Wait for the cleared-queue event to arrive on the wire (the in-memory
    // queue empties before the WS delivery).
    await waitUntil(
      () =>
        sock.messages.some((m) => {
          const u = m as {
            type?: string;
            agentId?: string;
            changes?: { queue?: unknown[] };
          };
          return (
            u.type === "agent_updated" &&
            u.agentId === recv.id &&
            Array.isArray(u.changes?.queue) &&
            u.changes.queue.length === 0
          );
        }),
      2000,
      "wire queue cleared",
    );

    // Give any (erroneous) bleed-through flush a chance to fire, then assert the
    // dropped message never reached a backend session.
    await sleep(100);
    const allSends = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .flatMap((s) => s.sent.map((m) => m.text));
    expect(allSends.some((t) => t.includes("will-be-dropped"))).toBe(false);
    // No NEW coalesced send was produced by the clear itself beyond what existed.
    const afterSends = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .reduce((n, s) => n + s.sent.length, 0);
    expect(afterSends).toBe(beforeSends);
  });
});

// Loopback-bypass removal (deletion): the legacy POST /agents/:id/message is now
// bearer-required. A valid AGENT bearer (auto-injected ISOMUX_AGENT_TOKEN) IS the
// sender; a mismatched body.senderAgentId is a spoof (403); a valid non-agent
// identity (USER/RUN) is rejected (403); a no/invalid-bearer request is rejected
// 401 at the cookie wall — loopback body-trust is gone (/agents/ is off
// isAgentApiPath).
describe("queue: message endpoint sender authority (bearer-required)", () => {
  async function postBearer(
    srv: TestServer,
    receiverId: string,
    bearer: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
    const res = await srv.http(`/agents/${receiverId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as { ok?: boolean; error?: string },
    };
  }

  it("a no-bearer loopback POST is rejected 401 (loopback body-trust removed)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // No Authorization header. Previously the anonymous-loopback path body-
    // trusted senderAgentId; now /agents/ is off isAgentApiPath, so the cookie
    // wall rejects it (401) before the handler runs.
    const res = await server.http(`/agents/${recv.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "anon", senderAgentId: sender.id }),
    });
    expect(res.status).toBe(401);
    // Nothing was enqueued or flushed to the receiver.
    expect(server.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0).toBe(
      0,
    );
  });

  it("a valid AGENT bearer IS the sender; no senderAgentId needed (token-derived)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const token = getAgentTokenRaw(sender.id)!;

    // No senderAgentId in the body — a loopback post without it would 400. The
    // 200 + token-derived attribution proves the sender came from the bearer.
    const r = await postBearer(server, recv.id, token, {
      text: "hi from token",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    await waitUntil(
      () =>
        (server!.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0) >= 1,
      2000,
      "receiver received the flushed prompt",
    );
    const prefix = formatAgentSenderPrefix(sender.id, "Sender", room.name);
    expect(server.fakeBackend.sessionForAgent(recv.id)!.sent[0].text).toContain(
      prefix,
    );
  });

  it("a present-but-mismatched senderAgentId on an AGENT bearer is a spoof -> 403", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const token = getAgentTokenRaw(sender.id)!;

    const r = await postBearer(server, recv.id, token, {
      text: "spoof attempt",
      senderAgentId: "agent-someone-else",
    });
    expect(r.status).toBe(403);
    // Nothing was enqueued/flushed to the receiver.
    expect(server.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0).toBe(
      0,
    );
  });

  it("a matching senderAgentId on an AGENT bearer is accepted (legacy input tolerated)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const token = getAgentTokenRaw(sender.id)!;

    const r = await postBearer(server, recv.id, token, {
      text: "explicit but matching",
      senderAgentId: sender.id,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("a valid non-agent bearer (RUN token) cannot send -> 403 (no body-trust bypass)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    // RUN scope carries only self:affordance — it is not an agent identity, so
    // it must not be allowed to body-trust a senderAgentId.
    const runToken = mintRunToken("some-job", "some-run", null);

    const r = await postBearer(server, recv.id, runToken, {
      text: "x",
      senderAgentId: "agent-anything",
    });
    expect(r.status).toBe(403);
    expect(server.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0).toBe(
      0,
    );
  });
});
