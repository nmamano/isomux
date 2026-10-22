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
  it("schedules for an agent sender: UTC ack, persisted entry, receiver queue untouched; a scheduled self-send passes where the immediate one is refused", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const utc = new Date(Date.now() + 3_600_000);
    utc.setUTCMilliseconds(0);
    // The same instant in a +02:00 representation: the ack echoes it in UTC.
    const offsetForm = new Date(utc.getTime() + 2 * 3_600_000)
      .toISOString()
      .replace("Z", "+02:00");
    const r = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "see you later", deliverAt: offsetForm },
    );
    expect(r.status).toBe(200);
    expect(r.body.scheduledId).toMatch(/^sm_[0-9a-f]{8}$/);
    expect(r.body.deliverAt).toBe(utc.toISOString());
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

  it("refuses a user-scope deliverAt (never sends it now), a malformed or past deliverAt, and an unknown recipient", async () => {
    const { srv, owner, a, b } = await setup();
    server = srv;
    const user = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { rawSessionId: owner.rawSessionId },
      { text: "morgan send", deliverAt: inOneHour() },
    );
    expect(user.status).toBe(400);
    expect(user.body.error?.code).toBe("deliver_at_not_supported");
    const liveB = srv.agentManager.getAllAgents().find((x) => x.id === b.id)!;
    expect(liveB.queue).toHaveLength(0);

    const post = (recipient: string, payload: Record<string, unknown>) =>
      call(
        srv,
        "POST",
        `/api/agents/${recipient}/messages`,
        { agentId: a.id },
        payload,
      );
    for (const deliverAt of [
      "2030-01-01T10:00:00",
      new Date(Date.now() - 60_000).toISOString(),
    ]) {
      const r = await post(b.id, { text: "x", deliverAt });
      expect([deliverAt, r.status, r.body.error?.code]).toEqual([
        deliverAt,
        400,
        "invalid_deliver_at",
      ]);
    }
    expect(
      (await post(b.id, { text: "x", deliverAt: 1784000000000 })).status,
    ).toBe(422);
    expect(
      (await post("agent-nope", { text: "x", deliverAt: inOneHour() })).status,
    ).toBe(404);
    // Nothing was scheduled.
    const list = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      { agentId: a.id },
    );
    expect(list.body.scheduled).toHaveLength(0);
  });

  it("a pending entry and its clientMessageId survive a cold restart: listable, retry-safe, cancellable", async () => {
    const { srv: srv0, a, b } = await setup();
    server = srv0;
    const deliverAt = inOneHour();
    const first = await call(
      srv0,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "retry-safe", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(first.status).toBe(200);
    const sid = first.body.scheduledId!;
    // Cold restart: same STATE_ROOT, fresh boot re-reads scheduled-messages.json.
    const srv = await srv0.restart();
    server = srv;
    const list = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      { agentId: a.id },
    );
    expect(list.status).toBe(200);
    expect(list.body.scheduled!.map((e) => e.id)).toEqual([sid]);
    const retry = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "retry-safe", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.scheduledId).toBe(sid); // ORIGINAL id
    const conflict = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/messages`,
      { agentId: a.id },
      { text: "DIFFERENT", deliverAt, clientMessageId: "cmid-1" },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("client_message_id_conflict");
    const cancel = await call(
      srv,
      "DELETE",
      `/api/agents/${a.id}/scheduled-messages/${sid}`,
      { agentId: a.id },
    );
    expect(cancel.status).toBe(204);
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
    // A user with room access may (member oversight).
    const morgan = await call(
      srv,
      "GET",
      `/api/agents/${a.id}/scheduled-messages`,
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(morgan.status).toBe(200);
    expect(morgan.body.scheduled).toHaveLength(1);
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
    expect(bPrompt).toContain(whenIso);

    // Self-addressed scheduled delivery reads as the past self: no sender id
    // to reply to.
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
    expect(aPrompt).toContain("note to self");
    expect(aPrompt).toContain(whenIso);
    expect(aPrompt).not.toContain(`(agent id: ${a.id})`);

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
    expect(ghostPrompt).toContain(whenIso);
    // The gone sender adds a note inside the scheduled marker.
    const markerOf = (prompt: string) => {
      const at = prompt.indexOf(whenIso);
      return prompt.slice(prompt.lastIndexOf("[", at), prompt.indexOf("]", at));
    };
    expect(markerOf(ghostPrompt).length).toBeGreaterThan(
      markerOf(bPrompt).length,
    );

    // A PLAIN inter-agent message carries no scheduled marker.
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
    expect(plainPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});
