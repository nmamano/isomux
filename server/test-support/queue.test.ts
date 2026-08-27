// Phase 1.4a - Queue / coalescing / notification characterization.
//
// Freezes the OBSERVABLE behavior of the message queue before Phase 3 moves the
// orchestrator/transport: how messages addressed to a busy agent are queued,
// coalesced into one backend prompt on the next idle transition (sender prefixes
// + the busy note), the dedupe/cap/reject contracts on the agent-to-agent HTTP
// entry point, cancel/send-now, and the turnHadHumanInput notification gate.
//
// Seam: the WS harness (startTestServer). The wire IS the boundary here - queue
// chips reach clients as `agent_updated` { changes: { queue } }, the per-message
// provenance lands as `log_entry`, and the agent-to-agent POST returns the raw
// EnqueueResult. The coalesced SDK prompt the backend receives is read off the
// injected FakeSession (`fakeBackend.sessionForAgent(id).sent`). In-memory state
// is read via `agentManager` (note: getAgent().queue is always empty by design -
// the live queue is spliced in only by getAllAgents(), which is what full_state
// uses; turnHadHumanInput IS on info).
//
// Busy control: a non-auto-completing FakeBackend whose onSend pushes a single
// `assistant_text` (-> state "thinking") without a turn_completed, so the agent
// parks busy until the test calls completeTurn(). This mirrors onboarding's
// per-state scripting and gives clean, explicit turn boundaries.
//
// Zero LLM calls. The two agent entry points are deliberately distinguished:
//   - human (USER cookie) send when IDLE -> immediate turn (no enqueue), only
//     enqueues when busy (state thinking/tool_executing, non-slash, no pending);
//   - agent (AGENT bearer) send -> always enqueueMessage, accepts-then-flushes when
//     idle (queued:false) and queues when busy (queued:true).

import { describe, it, expect, afterEach, setSystemTime } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { _testSetPlugins } from "../plugins.ts";
import type { IsomuxPlugin } from "../../shared/plugin-types.ts";
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
  // The unified agents.sendMessage route (3d.6a) returns { messageId, queued } on
  // success or the standard error envelope { error: { code, message } } - not the
  // raw EnqueueResult the legacy endpoint exposed. `queued` came back with task
  // 425facdd (true = parked behind the receiver's turn, false = handed straight
  // to one, absent on a deduped retry); the rest of the EnqueueResult stays
  // internal and is read off the live queue (queueOf) + state.
  body: {
    messageId?: string;
    queued?: boolean;
    // Task 80b2bb08: present only when the send asked to steer. steered:true =
    // an in-flight turn was interrupted for this message; steerDeclined = a
    // guard rail refused and the message queued instead.
    steered?: boolean;
    steerDeclined?: string;
    error?: { code: string; message: string };
  };
}

// Agent-to-agent entry point: POST /api/agents/:receiverId/messages (3d.6a - the
// unified agents.sendMessage route, AGENT branch). Bearer-required: the sender's
// auto-injected AGENT bearer (ISOMUX_AGENT_TOKEN, resolved here via
// getAgentTokenRaw) IS the sender, so the body no longer carries senderAgentId on
// the happy path - it's token-derived. A null senderId (or one with no minted
// token) sends NO bearer, exercising the no-identity 401 path.
async function postAgentMessage(
  srv: TestServer,
  receiverId: string,
  senderId: string | null,
  text: string | null,
  clientMessageId?: string,
  // Extra body fields (steer, deliverAt, ...) for the tests that exercise the
  // optional flags on the same route.
  extra?: Record<string, unknown>,
): Promise<PostResult> {
  const payload: Record<string, unknown> = { ...extra };
  if (text !== null) payload.text = text;
  if (clientMessageId) payload.clientMessageId = clientMessageId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bearer = senderId !== null ? getAgentTokenRaw(senderId) : null;
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await srv.http(`/api/agents/${receiverId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as PostResult["body"] };
}

// Human (USER cookie) chat send: POST /api/agents/:id/messages, the same unified
// route, USER branch. Replaces the retired WS `send_message` command - the turn
// streams back over the socket; the { messageId:"" } ack is ignored. username is
// server-derived (attributionFor), so the body carries only the text.
async function sendHuman(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...extra }),
    rawSessionId,
  });
  if (res.status >= 400) throw new Error(`sendHuman -> ${res.status}`);
}

// Authenticated USER mutation with no response body (cancelQueued / sendNow /
// newConversation - the retired WS commands, now 204 REST routes).
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
// carry turnHadHumanInput === value (the notification-gate WIRE signal - the UI
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
  it("idle human send_message starts an immediate turn - no enqueue, no chip", async () => {
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

    await sendHuman(server, owner.rawSessionId, a.id, "hello");

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
    expect(typeof r1.body.messageId).toBe("string");
    // The ack says the message was handed straight to a turn (task 425facdd).
    expect(r1.body.queued).toBe(false);

    // That flush parks the receiver busy (onSend pushed assistant_text).
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "receiver busy after first flush",
    );

    // Busy receiver: the next POST queues.
    const r2 = await postAgentMessage(server, recv.id, sender.id, "second");
    expect(r2.status).toBe(200);
    // Both the ack and the live queue report the park.
    expect(r2.body.queued).toBe(true);
    expect(queueOf(server, recv.id).length).toBe(1);
  });

  // Task 425facdd: the whole point of the flag is that a sender who cannot see
  // the receiver's state can still tell "read now" from "read after their turn",
  // so the two outcomes must DIFFER on the same receiver in one run.
  it("the ack's queued flag flips with the receiver's state", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    const idle = await postAgentMessage(server, recv.id, sender.id, "one");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "receiver busy",
    );
    const busy = await postAgentMessage(server, recv.id, sender.id, "two");
    expect(idle.body.queued).toBe(false);
    expect(busy.body.queued).toBe(true);
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
    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
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

    // msg2 (human) + msg3 (agent) arrive while busy -> queue in order.
    await sendHuman(server, owner.rawSessionId, recv.id, "human-two");
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
      "[Note: these messages were queued while you were processing your previous turn - the sender had not seen your most recent reply when they sent them.]";
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
    // completeTurn it below - beginTurn flips state to "thinking" before send.
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");

    await postAgentMessage(server, recv.id, sender.id, "only-one");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");

    session.completeTurn();
    await waitUntil(() => session.sent.length === 2, 2000, "coalesced send");

    const note =
      "[Note: this message was queued while you were processing your previous turn - the sender had not seen your most recent reply when they sent it.]";
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
    // later completeTurn - beginTurn flips state to "thinking" before send.
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");
    expect(agentOf(server, recv.id).turnHadHumanInput).toBe(false);

    // --- mixed human + agent flush -> flips false to true ---
    await sendHuman(server, owner.rawSessionId, recv.id, "human");
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
    expect(first.status).toBe(200);
    const repeat = await postAgentMessage(
      server,
      recvA.id,
      sender.id,
      "dup",
      "cid-1",
    );
    expect(repeat.status).toBe(200);
    expect(first.body.queued).toBe(true);
    // A deduped retry never touched the queue, so it reports no queued/delivered
    // answer at all rather than the misleading false the enqueue path defaults to
    // (task 425facdd).
    expect("queued" in repeat.body).toBe(false);
    // Dedupe is observable as the queue NOT growing on the repeated cid.
    expect(queueOf(server, recvA.id).length).toBe(1); // no second copy

    // Same clientMessageId to a DIFFERENT receiver is not deduped.
    const other = await postAgentMessage(
      server,
      recvB.id,
      sender.id,
      "dup",
      "cid-1",
    );
    expect(other.status).toBe(200);
    // Same cid to a DIFFERENT receiver is not deduped: it queues normally.
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
      expect(r.status).toBe(200);
    }
    expect(queueOf(server, recv.id).length).toBe(50);

    const overflow = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "too-many",
    );
    expect(overflow.status).toBe(429);
    expect(overflow.body.error?.code).toBe("queue_full");
    expect(queueOf(server, recv.id).length).toBe(50); // unchanged
  });

  it("rejects malformed / self / unknown-receiver / error-state sends with today's status codes", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    // Codex without a durable rollout makes the later error state deliberately
    // unresumable, so this contract test keeps pinning the 409 fallback while
    // resumable error states are covered by agent-death-recovery.test.ts.
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
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

    // Unresumable error-state receiver -> 409. Drive a failed turn to reach
    // state "error"; pickAutoResumeSessionId rejects its missing rollout.
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
    expect(rejected.body.error?.code).toBe("agent_error");
  });
});

describe("queue: cancel / send-now / new-conversation (Phase 1.4a)", () => {
  it("cancel_queued (REST) removes a queued item and re-emits the queue without it", async () => {
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
    await userMut(
      server,
      owner.rawSessionId,
      "DELETE",
      `/api/agents/${recv.id}/queue/${drop.body.messageId!}`,
    );

    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");
    expect(queueOf(server, recv.id)[0].id).toBe(keep.body.messageId!);
    // Wire: the re-emitted queue carries only the kept id.
    await waitUntil(
      () => sawQueueIds(sock, recv.id, [keep.body.messageId!]),
      2000,
      "wire re-emit without dropped id",
    );
  });

  it("send_now (REST) drains the queue to the backend", async () => {
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

    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/send-now`,
    );

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

  it("new_conversation (REST) clears the queue and no queued prompt bleeds into the new session", async () => {
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

    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/new-conversation`,
    );

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

// Regression for task d7c879da: "Queue flush interrupted by session change;
// will retry." leaking on an intentional Send-now.
//
// The window: a queued flush's runAgentTurn parks PRE-SEND (awaiting a slow
// beforeTurn plugin, pendingTurn not yet installed, queue undrained). Send-now
// calls abort(), which bumps turnCancelToken and - with no pendingTurn - early-
// returns without ever setting `aborting`. When the plugin finishes,
// checkCancelled throws SessionSwappedError into flushQueue's catch with the
// queue still non-empty, which used to log the "will retry" system message
// even though the interrupt was deliberate and the retry automatic. The fix
// stamps abort()'s bump (managed.abortCancelToken) so the catch can tell a
// user-initiated cancel (stay quiet) from an unexpected swap (still surface).
//
// Determinism: a test-injected gated beforeTurn plugin (via _testSetPlugins)
// holds the flush in the pre-send window until the test has fired Send-now -
// the exact widening that made the bug intermittent in production (mem0).
describe("queue: flush cancelled pre-send (task d7c879da)", () => {
  // One-shot gate: the FIRST beforeTurn call parks on `gate` (and signals
  // `entered`); every later call returns immediately so the retry flush
  // proceeds unimpeded.
  function gatedBeforeTurnPlugin(): {
    plugin: IsomuxPlugin;
    entered: Promise<void>;
    openGate: () => void;
  } {
    let signalEntered!: () => void;
    let openGate!: () => void;
    const entered = new Promise<void>((r) => (signalEntered = r));
    const gate = new Promise<void>((r) => (openGate = r));
    let armed = true;
    const plugin: IsomuxPlugin = {
      id: "test-slow-gate",
      beforeTurn: async () => {
        if (!armed) return {};
        armed = false;
        signalEntered();
        await gate;
        return {};
      },
    };
    return { plugin, entered, openGate };
  }

  const NOISE = "Queue flush interrupted by session change";

  // Shared setup: park the receiver busy on a kickoff turn, queue one message,
  // inject the gated plugin, release the kickoff so the queued flush parks in
  // the pre-send window. Returns once the flush is provably parked (queue
  // undrained, state "thinking").
  async function parkFlushPreSend(srv: TestServer, ownerSession: string) {
    const room = srv.agentManager.getRooms()[0];
    // Codex receiver for the same reason as the send_now test above: any
    // session replace on the way (abort slow path / out-of-band swap) starts
    // a FRESH session instead of tripping Claude's resume preflight on the
    // fake session id's missing .jsonl.
    const recv = await spawnAgent(srv, "Receiver", room.id, "codex");
    const sender = await spawnAgent(srv, "Sender", room.id);
    const sock = await srv.connectWs(ownerSession);
    await sock.waitFor("full_state");

    await postAgentMessage(srv, recv.id, sender.id, "kickoff");
    await waitUntil(() => stateOf(srv, recv.id) === "thinking", 2000, "busy");
    const session = srv.fakeBackend.sessionForAgent(recv.id)!;
    await waitUntil(() => session.sent.length === 1, 2000, "kickoff sent");

    await postAgentMessage(srv, recv.id, sender.id, "queued-1");
    await waitUntil(() => queueOf(srv, recv.id).length === 1, 2000, "q=1");

    // Install the gate BEFORE releasing the kickoff turn, so the queued
    // flush's runAgentTurn (triggered by the idle transition) parks in its
    // beforeTurn loop. The kickoff turn itself ran plugin-less.
    const { plugin, entered, openGate } = gatedBeforeTurnPlugin();
    _testSetPlugins([plugin]);
    session.completeTurn();
    await entered;

    // Parked pre-send: the flush turn claimed the state (thinking) but has
    // NOT drained the queue (drain happens in onSendAccepted, post-send).
    expect(queueOf(srv, recv.id).length).toBe(1);
    expect(stateOf(srv, recv.id)).toBe("thinking");

    return { recv, sock, openGate };
  }

  afterEach(() => {
    _testSetPlugins([]);
  });

  it("send-now during the pre-send window drains silently - no 'will retry' system message", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const { recv, sock, openGate } = await parkFlushPreSend(
      server,
      owner.rawSessionId,
    );

    // Send-now while the flush is parked pre-send: sendNow sees a busy state
    // and calls abort(), whose token bump cancels the parked flush turn.
    await userMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${recv.id}/send-now`,
    );
    openGate();

    // The retry flush drains the queue into a backend session.
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    const reached = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .some((s) => s.sent.some((m) => m.text.includes("queued-1")));
    expect(reached).toBe(true);

    // Wait for the retry's user_message provenance - it lands strictly AFTER
    // the SessionSwappedError catch ran, so absence of the noise message at
    // this point is conclusive, not a did-not-arrive-yet race.
    await waitUntil(
      () =>
        logEntriesFor(sock, recv.id).some(
          (e) => e.kind === "user_message" && e.content === "queued-1",
        ),
      2000,
      "retry provenance on wire",
    );
    const entries = logEntriesFor(sock, recv.id);
    // Sanity: the interrupt really took the abort path...
    expect(
      entries.some(
        (e) => e.kind === "system" && e.content === "Agent interrupted.",
      ),
    ).toBe(true);
    // ...and the deliberate cancel stayed quiet.
    expect(entries.some((e) => e.content.includes(NOISE))).toBe(false);
  });

  it("an unexpected session swap in the same window surfaces 'will retry' AND actually retries post-swap", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const { recv, sock, openGate } = await parkFlushPreSend(
      server,
      owner.rawSessionId,
    );

    // Out-of-band swap NOT routed through abort(): setPrivileged re-mints the
    // token and replaces the live session without touching the queue. Its
    // closeAndDrainSession bumps turnCancelToken past abort's stamp, so the
    // cancelled flush must still tell the user it was interrupted + retried.
    // (The call parks awaiting the consumer drain until the gate opens the
    // cancelled turn's path, so start it, THEN open the gate, then await.)
    const swapDone = server.agentManager.setPrivileged(recv.id, true);
    openGate();

    await waitUntil(
      () =>
        logEntriesFor(sock, recv.id).some(
          (e) => e.kind === "system" && e.content.includes(NOISE),
        ),
      2000,
      "'will retry' surfaced for unexpected swap",
    );
    await swapDone;

    // Task 314ee9fb: the promised retry now actually fires. replaceSession's
    // post-swap normalization + flush kick drain the queued item into the
    // POST-swap session (pre-fix contract: the item sat queued until an
    // unrelated state change, with the agent stranded visibly busy).
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "queued item drained post-swap",
    );
    const delivered = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .some((s) => s.sent.some((m) => m.text.includes("queued-1")));
    expect(delivered).toBe(true);
    // And the agent is reachable again, not stranded in a dead busy state.
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "delivery turn started",
    );
  });
});

// Task 8ba27b27: changing a setting (e.g. thinking effort) while messages are
// queued swaps the session out from under the in-flight flush turn. That's
// expected behavior, not a stall: the settings-driven replace stamps
// reason "settings" on the SessionSwappedError it rejects the turn with, and
// flushQueue's catch words the notice accordingly ("Restarting session to
// apply settings...") instead of the generic stall-sounding line - while the
// post-swap kick still delivers the queued item, same as any other swap.
describe("queue: settings-driven swap mid-flush (task 8ba27b27)", () => {
  it("effort change with a queued message words the notice as expected behavior and still delivers", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex receiver for the same reason as the d7c879da tests above: the
    // replace starts a FRESH session instead of tripping Claude's resume
    // preflight on the fake session id's missing .jsonl.
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Kickoff flush turn parks in-flight (parkingBackend accepts the send but
    // never completes the turn), with a second message queued behind it -
    // the exact production window from the task report.
    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    await postAgentMessage(server, recv.id, sender.id, "queued-1");
    await waitUntil(() => queueOf(server!, recv.id).length === 1, 2000, "q=1");

    // Effort change: editAgent's replace rejects the in-flight flush turn
    // with SessionSwappedError(reason: "settings").
    await server.agentManager.editAgent(recv.id, { effort: "medium" });

    await waitUntil(
      () =>
        logEntriesFor(sock, recv.id).some(
          (e) =>
            e.kind === "system" &&
            e.content.includes("Restarting session to apply settings"),
        ),
      2000,
      "settings-swap notice surfaced",
    );
    // The stall-sounding generic line never appears for this swap.
    expect(
      logEntriesFor(sock, recv.id).some((e) =>
        e.content.includes("Queue flush interrupted by session change"),
      ),
    ).toBe(false);

    // And the notice's promise holds: the post-swap kick drains the queued
    // item into the fresh session.
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "queued item drained post-swap",
    );
    const delivered = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === recv.id)
      .some((s) => s.sent.some((m) => m.text.includes("queued-1")));
    expect(delivered).toBe(true);
  });
});

// sendNow flag on the USER send (Ctrl/Cmd+Enter "deliver now", task 2226d4ce).
// A thin composition over existing machinery: when the message lands in a busy
// agent's queue, sendMessage triggers the same abort+flush as POST /send-now.
// The flag is read ONLY inside the busy-queue branch - idle sends, slash
// commands, and multi-step flows take their normal paths untouched.
describe("queue: sendNow flag on user send (Ctrl/Cmd+Enter)", () => {
  it("busy agent: a sendNow send lands in the queue and immediately drains to the backend", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex receiver for the same reason as the send_now (REST) test above:
    // the slow-path abort reinstalls a session, and Codex fresh-starts instead
    // of tripping Claude's resume preflight on the fake session id. The
    // contract pinned is backend-agnostic: the message leaves the queue and
    // reaches a backend session without waiting for the parked turn to end.
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );

    await sendHuman(server, owner.rawSessionId, recv.id, "urgent", {
      sendNow: true,
    });

    // No explicit /send-now call: the flag alone aborts the parked turn and
    // flushes. The parked FakeSession never completes its turn, so a drained
    // queue + backend delivery can only come from the sendNow path.
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    await waitUntil(
      () =>
        server!.fakeBackend.sessions
          .filter((s) => s.opts.agentId === recv.id)
          .some((s) => s.sent.some((m) => m.text.includes("urgent"))),
      3000,
      "reached backend",
    );
  });

  it("idle agent: a sendNow send is a plain send (starts a turn, nothing aborted)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const a = await spawnAgent(server, "Idle", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await sendHuman(server, owner.rawSessionId, a.id, "hello", {
      sendNow: true,
    });

    // Normal-send path: the message goes straight to the backend (never
    // queued) and the turn it starts stays alive (parkingBackend holds it in
    // "thinking" - an erroneous abort would knock it back to idle).
    await waitUntil(
      () =>
        (server!.fakeBackend.sessionForAgent(a.id)?.sent ?? []).some((m) =>
          m.text.includes("hello"),
        ),
      2000,
      "sent",
    );
    await waitUntil(() => stateOf(server!, a.id) === "thinking", 2000, "busy");
    await sleep(100);
    expect(stateOf(server, a.id)).toBe("thinking");
    expect(queueOf(server, a.id).length).toBe(0);
  });

  it("non-boolean sendNow -> 422 invalid_request", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const a = await spawnAgent(server, "Receiver", room.id);

    const res = await server.http(`/api/agents/${a.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", sendNow: "yes" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error?: { code: string };
    };
    expect(body.error?.code).toBe("invalid_request");
    expect(server.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0).toBe(0);
  });

  it("AGENT-scope sendNow -> 400 send_now_not_supported (agents use POST /send-now)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    const res = await server.http(`/api/agents/${recv.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentTokenRaw(sender.id)}`,
      },
      body: JSON.stringify({ text: "x", sendNow: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code: string };
    };
    expect(body.error?.code).toBe("send_now_not_supported");
    expect(server.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0).toBe(
      0,
    );
  });
});

// Agent-initiated steering (task 80b2bb08). "steer":true on the inter-agent send
// enqueues AND interrupts in one request, so the receiver can't go idle between
// an enqueue and a follow-up send-now and turn what the sender meant as a steer
// into an ordinary delivery. Guard rails degrade to a plain queue - the message
// is always accepted, only the interruption is refused - and the ack says which
// of the three things happened.
describe("queue: steer flag on agent send (task 80b2bb08)", () => {
  const sawInterrupt = (sock: TestSocket, agentId: string): boolean =>
    logEntriesFor(sock, agentId).some(
      (e) => e.kind === "system" && e.content === "Agent interrupted.",
    );

  it("busy receiver: the ack reports steered and the message drains without the parked turn ending", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    // Codex receiver for the same reason as the send-now tests above: the
    // slow-path abort reinstalls a session, and Codex fresh-starts instead of
    // tripping Claude's resume preflight on the fake session id.
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

    const r = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "urgent",
      undefined,
      { steer: true },
    );
    expect(r.status).toBe(200);
    expect(r.body.steered).toBe(true);
    // queued:false - the receiver's turn is being cut short precisely so this
    // message does NOT wait for it, which is what queued reports.
    expect(r.body.queued).toBe(false);
    expect("steerDeclined" in r.body).toBe(false);

    await waitUntil(
      () => sawInterrupt(sock, recv.id),
      3000,
      "interrupt logged",
    );
    // The parked FakeSession never completes its turn, so a drained queue and a
    // backend delivery can only come from the interrupt this send issued.
    await waitUntil(
      () => queueOf(server!, recv.id).length === 0,
      3000,
      "drained",
    );
    await waitUntil(
      () =>
        server!.fakeBackend.sessions
          .filter((s) => s.opts.agentId === recv.id)
          .some((s) => s.sent.some((m) => m.text.includes("urgent"))),
      3000,
      "reached backend",
    );
  });

  it("idle receiver: steer delivers now and interrupts nothing", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    const r = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "hello",
      undefined,
      { steer: true },
    );
    expect(r.body.queued).toBe(false);
    // No guard rail refused; there was simply no turn to interrupt.
    expect(r.body.steered).toBe(false);
    expect("steerDeclined" in r.body).toBe(false);

    await waitUntil(
      () =>
        (server!.fakeBackend.sessionForAgent(recv.id)?.sent ?? []).some((m) =>
          m.text.includes("hello"),
        ),
      2000,
      "sent",
    );
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );
    await sleep(100);
    // The turn this send started is still running - an erroneous abort would
    // have knocked it back to waiting_for_response and logged an interrupt.
    expect(stateOf(server, recv.id)).toBe("thinking");
    expect(sawInterrupt(sock, recv.id)).toBe(false);
  });

  it("receiver mid multi-step flow: steer degrades to a plain queue", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // /model leaves the agent waiting on a pick, where the next message is read
    // as the answer - the flow steering must refuse to interrupt.
    await sendHuman(server, owner.rawSessionId, recv.id, "/model");
    await waitUntil(
      () => stateOf(server!, recv.id) === "waiting_for_response",
      2000,
      "pick pending",
    );

    const r = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "urgent",
      undefined,
      { steer: true },
    );
    expect(r.body.queued).toBe(true);
    expect(r.body.steered).toBe(false);
    expect(r.body.steerDeclined).toBe("multi_step_flow");

    // Nothing aborted, and the message waits with the pick (flushQueue declines
    // to run in a multi-step flow, so an abort would have cost a turn and still
    // not delivered).
    await sleep(200);
    expect(queueOf(server, recv.id).length).toBe(1);
    expect(sawInterrupt(sock, recv.id)).toBe(false);
  });

  it("rate limit: the fourth steer of one receiver inside the window queues instead", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");

    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      // Each round steers a DISTINCT turn: the previous steer's message has
      // drained (queue empty) and the turn it started is parked (thinking).
      await waitUntil(
        () =>
          stateOf(server!, recv.id) === "thinking" &&
          queueOf(server!, recv.id).length === 0,
        5000,
        `turn ${i} running`,
      );
      const r = await postAgentMessage(
        server,
        recv.id,
        sender.id,
        `steer-${i}`,
        undefined,
        { steer: true },
      );
      outcomes.push(r.body.steered === true ? "steered" : r.body.steerDeclined);
    }
    expect(outcomes).toEqual(["steered", "steered", "steered", "rate_limited"]);
    // The refused one is still accepted, just parked behind the running turn.
    expect(queueOf(server, recv.id).length).toBe(1);
  });

  // The window is a ROLLING one, not a lifetime cap: an agent that spends its
  // budget is steerable again a minute later. Pinned with a clock jump rather
  // than a real wait. Safe in the harness: the queue watchdog interval is
  // main-process only (isomux-office.ts), so nothing else is reading the clock
  // in the background, and the jump happens between awaits.
  it("the steer budget refills once the window passes", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    const steerOnce = async (label: string): Promise<string | undefined> => {
      await waitUntil(
        () =>
          stateOf(server!, recv.id) === "thinking" &&
          queueOf(server!, recv.id).length === 0,
        5000,
        `turn for ${label}`,
      );
      const r = await postAgentMessage(
        server!,
        recv.id,
        sender.id,
        label,
        undefined,
        { steer: true },
      );
      return r.body.steered === true ? "steered" : r.body.steerDeclined;
    };

    expect(await steerOnce("a")).toBe("steered");
    expect(await steerOnce("b")).toBe("steered");
    expect(await steerOnce("c")).toBe("steered");
    await waitUntil(
      () =>
        stateOf(server!, recv.id) === "thinking" &&
        queueOf(server!, recv.id).length === 0,
      5000,
      "turn for d",
    );
    // Without the jump this fourth one is the rate_limited case above.
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      const r = await postAgentMessage(
        server,
        recv.id,
        sender.id,
        "d",
        undefined,
        { steer: true },
      );
      expect(r.body.steered).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  // A steer landing while an earlier one's abort is still unwinding must not
  // claim a second interruption or spend a second slot: the first abort already
  // flipped the receiver out of busy, so there is nothing left to interrupt and
  // the message simply rides the flush that abort triggered. hangOnClose holds
  // the receiver in that window for the whole drain timeout, so the second send
  // lands inside it deterministically.
  it("a second steer during the first one's abort interrupts nothing", async () => {
    server = await startTestServer({
      fakeBackend: new FakeBackend({
        session: {
          onSend: (_t, _a, s) =>
            s.push({ kind: "assistant_text", text: "..." }),
          hangOnClose: true,
        },
      }),
    });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    server.agentManager._testSetConsumerDrainTimeout(300);

    await postAgentMessage(server, recv.id, sender.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      2000,
      "busy",
    );

    const first = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "first",
      undefined,
      { steer: true },
    );
    expect(first.body.steered).toBe(true);
    // The abort ran to its first await inside this request, so the receiver is
    // already out of busy by the time the ack is written.
    expect(stateOf(server, recv.id)).toBe("waiting_for_response");

    const second = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "second",
      undefined,
      { steer: true },
    );
    expect(second.body.steered).toBe(false);
    expect(second.body.queued).toBe(false);
    expect("steerDeclined" in second.body).toBe(false);

    // Both messages ride the same recovery: the drain bound releases the
    // replacement, and the flush delivers them together.
    await waitUntil(
      () =>
        server!.fakeBackend.sessions
          .filter((s) => s.opts.agentId === recv.id)
          .some((s) =>
            s.sent.some(
              (m) => m.text.includes("first") && m.text.includes("second"),
            ),
          ),
      5000,
      "both delivered",
    );

    // ...and only ONE slot was spent. The budget is 3 per window, so if the
    // second send had also counted, the second round below would decline.
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < 2; i++) {
      await waitUntil(
        () =>
          stateOf(server!, recv.id) === "thinking" &&
          queueOf(server!, recv.id).length === 0,
        5000,
        `turn ${i} running`,
      );
      const r = await postAgentMessage(
        server,
        recv.id,
        sender.id,
        `more-${i}`,
        undefined,
        { steer: true },
      );
      outcomes.push(r.body.steered === true ? "steered" : r.body.steerDeclined);
    }
    expect(outcomes).toEqual(["steered", "steered"]);
  });

  // The durable write is transactional and happens BEFORE any steer decision,
  // so a rejected send must leave the receiver's turn and its steer budget
  // exactly as they were - otherwise a flaky disk would silently spend a
  // sender's ability to interrupt.
  it("a send that fails to persist neither interrupts nor spends a slot", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id, "codex");
    const sender = await spawnAgent(server, "Sender", room.id);
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    // Human kickoff: an idle human send starts a turn without touching the
    // store, so the path below is free to become a directory.
    await sendHuman(server, owner.rawSessionId, recv.id, "kickoff");
    await waitUntil(
      () => stateOf(server!, recv.id) === "thinking",
      3000,
      "busy",
    );

    // atomicWriteFileSync renames onto the store path, which cannot succeed
    // while it is a non-empty directory (same trick as queue-reliability).
    const store = join(server.stateRoot, "message-queues.json");
    mkdirSync(store);
    writeFileSync(join(store, "keep"), "x");
    const failed = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "durable",
      undefined,
      { steer: true },
    );
    expect(failed.status).toBe(500);
    expect(failed.body.error?.code).toBe("persist_failed");
    await sleep(100);
    expect(stateOf(server, recv.id)).toBe("thinking");
    expect(sawInterrupt(sock, recv.id)).toBe(false);

    rmSync(store, { recursive: true, force: true });
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      await waitUntil(
        () =>
          stateOf(server!, recv.id) === "thinking" &&
          queueOf(server!, recv.id).length === 0,
        5000,
        `turn ${i} running`,
      );
      const r = await postAgentMessage(
        server,
        recv.id,
        sender.id,
        `after-${i}`,
        undefined,
        { steer: true },
      );
      outcomes.push(r.body.steered === true ? "steered" : r.body.steerDeclined);
    }
    // A fourth would be rate_limited; all three interrupting proves the
    // rejected send spent nothing.
    expect(outcomes).toEqual(["steered", "steered", "steered"]);
  });

  it("a deduped retry never interrupts", async () => {
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

    const first = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "same",
      "cid-steer",
    );
    expect(first.body.queued).toBe(true);
    const repeat = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "same",
      "cid-steer",
      { steer: true },
    );
    expect(repeat.status).toBe(200);
    // The retry touched no queue, so it reports neither answer - and must not
    // interrupt a turn on behalf of a message that was already accepted.
    expect("queued" in repeat.body).toBe(false);
    expect("steered" in repeat.body).toBe(false);
    await sleep(200);
    expect(stateOf(server, recv.id)).toBe("thinking");
    expect(queueOf(server, recv.id).length).toBe(1);
    expect(sawInterrupt(sock, recv.id)).toBe(false);
  });

  it("USER-scope steer -> 400 steer_not_supported", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const room = server.agentManager.getRooms()[0];
    const a = await spawnAgent(server, "Receiver", room.id);

    const res = await server.http(`/api/agents/${a.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", steer: true }),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("steer_not_supported");
    expect(server.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0).toBe(0);
  });

  it("steer with deliverAt -> 400 steer_with_deliver_at, nothing scheduled", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    const r = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "later",
      undefined,
      { steer: true, deliverAt: new Date(Date.now() + 3600_000).toISOString() },
    );
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("steer_with_deliver_at");
    const list = await server.http(
      `/api/agents/${sender.id}/scheduled-messages`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${getAgentTokenRaw(sender.id)}` },
      },
    );
    expect(((await list.json()) as { scheduled: unknown[] }).scheduled).toEqual(
      [],
    );
  });

  it("non-boolean steer -> 422 invalid_request", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    const r = await postAgentMessage(
      server,
      recv.id,
      sender.id,
      "x",
      undefined,
      { steer: "yes" },
    );
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe("invalid_request");
    expect(server.fakeBackend.sessionForAgent(recv.id)?.sent.length ?? 0).toBe(
      0,
    );
  });
});

// Unified agents.sendMessage route (3d.6a), AGENT branch - sender authority via
// the messageSend guard. A valid AGENT bearer (auto-injected ISOMUX_AGENT_TOKEN)
// IS the sender; a mismatched body.senderAgentId is a spoof (403); a valid
// non-agent identity (USER/RUN) is rejected (403); a no/invalid-bearer request is
// rejected 401 at the /api auth wall - no anonymous-loopback body-trust.
describe("queue: message endpoint sender authority (bearer-required)", () => {
  async function postBearer(
    srv: TestServer,
    receiverId: string,
    bearer: string,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    body: { messageId?: string; error?: { code: string; message: string } };
  }> {
    const res = await srv.http(`/api/agents/${receiverId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        messageId?: string;
        error?: { code: string; message: string };
      },
    };
  }

  it("a no-bearer loopback POST is rejected 401 (loopback body-trust removed)", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    const sender = await spawnAgent(server, "Sender", room.id);

    // No Authorization header. The unified /api/agents/:id/messages route is
    // bearer/cookie-required, so the /api auth wall rejects it (401) before the
    // handler runs - no anonymous-loopback body-trust.
    const res = await server.http(`/api/agents/${recv.id}/messages`, {
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

    // No senderAgentId in the body - a loopback post without it would 400. The
    // 200 + token-derived attribution proves the sender came from the bearer.
    const r = await postBearer(server, recv.id, token, {
      text: "hi from token",
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.messageId).toBe("string");

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
    expect(typeof r.body.messageId).toBe("string");
  });

  it("an unowned RUN token cannot send or body-trust an agent sender", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const room = server.agentManager.getRooms()[0];
    const recv = await spawnAgent(server, "Receiver", room.id);
    // The token has no live owned job, and a cron run never body-trusts a
    // senderAgentId. Both facts fail closed before delivery.
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
