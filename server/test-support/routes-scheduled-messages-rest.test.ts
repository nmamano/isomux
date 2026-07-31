// Scheduled-messages REST contract (task 8ff369b5).
//
// HTTP-contract layer for the deliverAt branch of agents.sendMessage plus the
// new outbox routes (agents.listScheduledMessages / agents.cancelScheduledMessage),
// through the REAL auth + /api executor + production persistence (temp
// STATE_ROOT). COMPLEMENTS scheduled-messages.di.test.ts, which owns the
// firing/tick/retry/crash-window semantics against injected fakes - the harness
// boots with skipSchedulers, so no tick ever runs here and entries stay pending
// for the whole test.
//
// Also pins the flush-prefix formatting for scheduled deliveries (self /
// other-sender / sender-gone) by enqueueing directly with scheduledFor set and
// reading the coalesced prompt off the FakeBackend - the fire path's enqueue
// and a direct enqueue are the same call, so this exercises the real receiver-
// side rendering without waiting on a timer.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo, ScheduledMessageEntry } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

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

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  // Positional spawn(name, cwd, permissionMode, desk, customInstructions,
  // roomId, ...) - same shape queue.test.ts uses.
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

interface Res {
  status: number;
  body: {
    messageId?: string;
    scheduledId?: string;
    deliverAt?: string;
    scheduled?: ScheduledMessageEntry[];
    error?: { code: string; message?: string };
  };
}

// Request as an AGENT (bearer) or a USER (cookie) against any path.
async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { agentId?: string; rawSessionId?: string },
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth.agentId) {
    const bearer = getAgentTokenRaw(auth.agentId);
    if (!bearer) throw new Error(`no token for ${auth.agentId}`);
    headers["Authorization"] = `Bearer ${bearer}`;
  }
  const res = await srv.http(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    rawSessionId: auth.rawSessionId,
  });
  let parsed: Res["body"] = {};
  try {
    parsed = (await res.json()) as Res["body"];
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

// One hour out, RFC3339 UTC - far enough that a slow test never crosses it.
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

async function setup() {
  const srv = await startTestServer();
  const owner = await srv.seedOwner("Nil");
  const room = srv.agentManager.getRooms()[0];
  const a = await spawnAgent(srv, "SenderA", room.id);
  const b = await spawnAgent(srv, "ReceiverB", room.id);
  return { srv, owner, room, a, b };
}

describe("agents.sendMessage deliverAt branch", () => {
  it("schedules for an agent sender: ScheduledAck, persisted entry, receiver queue untouched", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const deliverAt = inOneHour();
    const r = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "see you later", deliverAt },
    );
    expect(r.status).toBe(200);
    expect(r.body.scheduledId).toMatch(/^sm_[0-9a-f]{8}$/);
    expect(r.body.deliverAt).toBe(deliverAt); // normalized UTC echo
    expect(r.body.messageId).toBeUndefined(); // no fake empty messageId
    // Durable: the entry is on disk under STATE_ROOT, not in the live queue.
    const file = join(srv.stateRoot, "scheduled-messages.json");
    expect(existsSync(file)).toBe(true);
    const persisted = JSON.parse(
      readFileSync(file, "utf-8"),
    ) as ScheduledMessageEntry[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(r.body.scheduledId!);
    expect(persisted[0].senderName).toBe("SenderA");
    const liveB = srv.agentManager.getAllAgents().find((x) => x.id === b.id)!;
    expect(liveB.queue).toHaveLength(0);
  });

  it("normalizes an offset form to UTC in the ack", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const utc = new Date(Date.now() + 3_600_000);
    utc.setUTCMilliseconds(0);
    // Same instant, +02:00 representation.
    const offsetForm = new Date(utc.getTime() + 2 * 3_600_000)
      .toISOString()
      .replace("Z", "+02:00");
    const r = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "tz", deliverAt: offsetForm },
    );
    expect(r.status).toBe(200);
    expect(r.body.deliverAt).toBe(utc.toISOString());
  });

  it("allows a SCHEDULED self-send while the immediate self-send stays rejected", async () => {
    const { srv, a } = await setup();
    server = srv;
    const immediate = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/messages`,
      { agentId: a.id },
      { text: "now" },
    );
    expect(immediate.status).toBe(400);
    expect(immediate.body.error?.code).toBe("self_send");
    const scheduled = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/messages`,
      { agentId: a.id },
      { text: "future me: check the build", deliverAt: inOneHour() },
    );
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.scheduledId).toBeDefined();
  });

  it("rejects a USER-scope deliverAt with 400 (never silently sends now)", async () => {
    const { srv, owner, b } = await setup();
    server = srv;
    const r = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { rawSessionId: owner.rawSessionId },
      { text: "boss send", deliverAt: inOneHour() },
    );
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("deliver_at_not_supported");
    // Nothing was scheduled and nothing was sent.
    const list = await call(
      srv,
      "GET",
      `/api/agents/${b.id}/scheduled-messages`,
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(list.body.scheduled).toHaveLength(0);
  });

  it("rejects malformed deliverAt: offset-less 400, non-string 422, past 400", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const post = (payload: Record<string, unknown>) =>
      call(
        srv,
        "POST",
        `/api/agents/${b.id}/messages`,
        { agentId: a.id },
        payload,
      );
    const noZone = await post({
      text: "x",
      deliverAt: "2030-01-01T10:00:00",
    });
    expect(noZone.status).toBe(400);
    expect(noZone.body.error?.code).toBe("invalid_deliver_at");
    const numeric = await post({ text: "x", deliverAt: 1784000000000 });
    expect(numeric.status).toBe(422);
    const past = await post({
      text: "x",
      deliverAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error?.code).toBe("invalid_deliver_at");
  });

  it("404s on an unknown recipient (precondition) and keeps clientMessageId idempotent across a RESTART", async () => {
    const { srv: srv0, a, b } = await setup();
    server = srv0;
    const missing = await call(
      srv0,
      "POST",
      "/api/agents/agent-nope/messages",
      { agentId: a.id },
      { text: "x", deliverAt: inOneHour() },
    );
    expect(missing.status).toBe(404);
    const deliverAt = inOneHour();
    const first = await call(
      srv0,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "retry-safe", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(first.status).toBe(200);
    // Cold restart: same STATE_ROOT, fresh boot re-reads scheduled-messages.json.
    const srv = await srv0.restart();
    server = srv;
    const retry = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "retry-safe", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.scheduledId).toBe(first.body.scheduledId); // ORIGINAL id
    const conflict = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "DIFFERENT", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("client_message_id_conflict");
  });
});

describe("outbox routes (list / cancel)", () => {
  it("GET lists only the sender's outbox; DELETE cancels; authority is self-or-user", async () => {
    const { srv, owner, a, b } = await setup();
    server = srv;
    const r = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "pending", deliverAt: inOneHour() },
    );
    const sid = r.body.scheduledId!;
    // The sender sees its outbox.
    const own = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {
        agentId: a.id,
      },
    );
    expect(own.status).toBe(200);
    expect(own.body.scheduled!.map((e) => e.id)).toEqual([sid]);
    // The RECEIVER's outbox is empty - entries live under the sender.
    const receiverOutbox = await call(
      srv,
      "GET",
      `/api/agents/${b.id}/scheduled-messages`,
      { agentId: b.id },
    );
    expect(receiverOutbox.body.scheduled).toHaveLength(0);
    // Another agent may NOT read a's outbox (403), even from the same room.
    const foreign = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      { agentId: b.id },
    );
    expect(foreign.status).toBe(403);
    // A user with room access may (boss oversight).
    const boss = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(boss.status).toBe(200);
    expect(boss.body.scheduled).toHaveLength(1);
    // No bearer at all → 401.
    const anon = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {},
    );
    expect(anon.status).toBe(401);
    // Foreign cancel → 403 (guard), then the sender cancels → 204 → 404 on repeat.
    const foreignCancel = await call(
      srv,
      "DELETE",
      `/api/agents/${a.id}/scheduled-messages/${sid}`,
      { agentId: b.id },
    );
    expect(foreignCancel.status).toBe(403);
    const cancel = await call(
      srv,
      "DELETE",
      `/api/agents/${a.id}/scheduled-messages/${sid}`,
      { agentId: a.id },
    );
    expect(cancel.status).toBe(204);
    const gone = await call(
      srv,
      "DELETE",
      `/api/agents/${a.id}/scheduled-messages/${sid}`,
      { agentId: a.id },
    );
    expect(gone.status).toBe(404);
    expect(gone.body.error?.code).toBe("scheduled_message_not_found");
    const empty = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {
        agentId: a.id,
      },
    );
    expect(empty.body.scheduled).toHaveLength(0);
  });

  it("pending entries survive a cold restart and remain listable/cancellable", async () => {
    const { srv: srv0, a, b } = await setup();
    server = srv0;
    const r = await call(
      srv0,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "durable", deliverAt: inOneHour() },
    );
    const sid = r.body.scheduledId!;
    const srv = await srv0.restart();
    server = srv;
    const list = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {
        agentId: a.id,
      },
    );
    expect(list.status).toBe(200);
    expect(list.body.scheduled!.map((e) => e.id)).toEqual([sid]);
    const cancel = await call(
      srv,
      "DELETE",
      `/api/agents/${a.id}/scheduled-messages/${sid}`,
      { agentId: a.id },
    );
    expect(cancel.status).toBe(204);
  });
});

describe("scheduled delivery rendering (flush prefix)", () => {
  // Enqueue directly with scheduledFor set - the exact call the fire path
  // makes - and read the coalesced prompt off the FakeBackend.
  it("marks a scheduled other-sender message, a self past-self message, and a gone sender", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const scheduledFor = Date.now() - 1000;
    const whenIso = new Date(scheduledFor).toISOString();

    // Other-sender scheduled delivery into b.
    srv.agentManager.enqueueMessage(b.id, {
      sender: {
        kind: "agent",
        agentId: a.id,
        agentName: "SenderA",
        roomName: "Room 1",
      },
      text: "scheduled hello",
      scheduledFor,
    });
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(b.id)?.sent.length ?? 0) >= 1,
      2000,
      "b received scheduled flush",
    );
    const bPrompt = srv.fakeBackend.sessionForAgent(b.id)!.sent[0].text;
    expect(bPrompt).toContain("scheduled hello");
    expect(bPrompt).toContain(`(agent id: ${a.id})`);
    expect(bPrompt).toContain(
      `[This message was scheduled by the sender for delivery at ${whenIso}.]`,
    );

    // Self-addressed scheduled delivery reads as the past self, no sender id
    // preamble to reply to.
    srv.agentManager.enqueueMessage(a.id, {
      sender: {
        kind: "agent",
        agentId: a.id,
        agentName: "SenderA",
        roomName: "Room 1",
      },
      text: "note to self",
      scheduledFor,
    });
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
      2000,
      "a received self flush",
    );
    const aPrompt = srv.fakeBackend.sessionForAgent(a.id)!.sent[0].text;
    expect(aPrompt).toContain(
      `[Scheduled message from your own past self, scheduled for delivery at ${whenIso}] note to self`,
    );

    // Gone sender is called out.
    srv.agentManager.enqueueMessage(b.id, {
      sender: {
        kind: "agent",
        agentId: "agent-dead",
        agentName: "Ghost",
        roomName: "Room X",
      },
      text: "from beyond",
      scheduledFor,
      scheduledSenderGone: true,
    });
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(b.id)?.sent.length ?? 0) >= 2,
      2000,
      "b received gone-sender flush",
    );
    const ghostPrompt = srv.fakeBackend.sessionForAgent(b.id)!.sent[1].text;
    expect(ghostPrompt).toContain('"Ghost"');
    expect(ghostPrompt).toContain(
      "The sender agent no longer exists, so it will not see a reply.",
    );

    // A PLAIN inter-agent message stays exactly as before (no scheduled note).
    srv.agentManager.enqueueMessage(b.id, {
      sender: {
        kind: "agent",
        agentId: a.id,
        agentName: "SenderA",
        roomName: "Room 1",
      },
      text: "plain hello",
    });
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(b.id)?.sent.length ?? 0) >= 3,
      2000,
      "b received plain flush",
    );
    const plainPrompt = srv.fakeBackend.sessionForAgent(b.id)!.sent[2].text;
    expect(plainPrompt).toContain("plain hello");
    expect(plainPrompt).not.toContain("scheduled");
  });
});
