// Agents see message queues and take back their own queued messages
// (task e17989e0; Nil, 2026-10-20).
//
//   - READ   GET /api/agents/:id/queue has the reach of the session list: an
//            agent reads its own queue and the queue of any agent in a room its
//            member can reach. It shows what the chip row shows (no item already
//            delivered inside a running turn) without the expanded skill body.
//   - RETRACT DELETE /api/agents/:id/queue/:messageId lets an agent sender take
//            back its own item while it waits, from any queue. An agent that is
//            not privileged, or is privileged but cannot reach the queue, cancels
//            nothing else. Members and privileged agents with reach still cancel
//            any item.
//   - HONEST A miss (no such item, already delivered, not the caller's) answers
//            404 not_queued, the same body for every miss.
//
// Seam: startTestServer() - real auth, the /api executor and the real queue.
// A parking FakeBackend holds the receiver busy so messages queue. Zero LLM calls.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  mintAgentToken,
  mintRunToken,
  _testResetTokens,
} from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, Attachment } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  _testResetTokens();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// Each turn parks in "thinking" (no turn_completed), so later sends queue.
function parkingBackend(toolBoundaryDelivery = false): FakeBackend {
  return new FakeBackend({
    storedSessionState: "missing",
    toolBoundaryDelivery,
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

async function spawnIn(
  srv: TestServer,
  name: string,
  roomId: string,
  manager: { username: string },
): Promise<AgentInfo> {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    manager.username,
    "claude",
    undefined,
    userIdOf(manager),
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

function userIdOf(who: { username: string }): string {
  const u = getUserByName(who.username);
  if (!u) throw new Error(`no user ${who.username}`);
  return u.id;
}

// Live queue (getAllAgents splices messageQueue in).
function queueOf(srv: TestServer, id: string): NonNullable<AgentInfo["queue"]> {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a.queue ?? [];
}

type Caller = { bearer: string } | { rawSessionId: string };

function authOf(caller: Caller): {
  headers: Record<string, string>;
  rawSessionId?: string;
} {
  return "bearer" in caller
    ? { headers: { Authorization: `Bearer ${caller.bearer}` } }
    : { headers: {}, rawSessionId: caller.rawSessionId };
}

interface Res {
  status: number;
  body: unknown;
}

async function call(
  srv: TestServer,
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const { headers, rawSessionId } = authOf(caller);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    rawSessionId,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

// An agent-to-agent send; returns the ack's messageId (the queued item's id).
async function send(
  srv: TestServer,
  from: Caller,
  to: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ messageId: string; queued?: boolean }> {
  const r = await call(srv, from, "POST", `/api/agents/${to}/messages`, {
    text,
    ...extra,
  });
  if (r.status !== 200)
    throw new Error(`send -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { messageId: string; queued?: boolean };
}

async function busy(
  srv: TestServer,
  from: Caller,
  receiverId: string,
): Promise<void> {
  await send(srv, from, receiverId, "kickoff");
  await waitUntil(
    () =>
      srv.agentManager.getAllAgents().find((a) => a.id === receiverId)
        ?.state === "thinking",
    "receiver busy",
  );
}

const readQueue = (srv: TestServer, caller: Caller, id: string) =>
  call(srv, caller, "GET", `/api/agents/${id}/queue`);

const cancel = (srv: TestServer, caller: Caller, id: string, mid: string) =>
  call(srv, caller, "DELETE", `/api/agents/${id}/queue/${mid}`);

type ReadItem = Record<string, unknown> & { id: string; text: string };
const itemsOf = (r: Res): ReadItem[] => (r.body as { queue: ReadItem[] }).queue;

// True if the socket saw an agent_updated whose queue is exactly these ids.
function sawQueueIds(sock: TestSocket, agentId: string, ids: string[]) {
  return sock.messages.some((m) => {
    const u = m as {
      type?: string;
      agentId?: string;
      changes?: { queue?: { id: string }[] };
    };
    const q = u.changes?.queue;
    return (
      u.type === "agent_updated" &&
      u.agentId === agentId &&
      Array.isArray(q) &&
      q.length === ids.length &&
      q.every((item, i) => item.id === ids[i])
    );
  });
}

const SKILL_BODY = "SKILL-BODY-MARKER expanded instructions";
const ATTACHMENT: Attachment = {
  filename: "c0ffee12.txt",
  originalName: "notes.txt",
  mediaType: "text/plain",
  size: 12,
};

describe("agents.readQueue: reach", () => {
  it("has exactly the session list's reach for every caller", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const owner = await srv.seedOwner("Boss");
    const mia = await srv.seedMember("Mia");
    const ownerSock = await srv.connectWs(owner.rawSessionId);
    await ownerSock.waitFor("full_state");
    const access = await call(
      srv,
      owner,
      "PUT",
      `/api/users/${encodeURIComponent(mia.username)}/access`,
      { allowedRooms: [r1] },
    );
    expect(access.status).toBeLessThan(300);

    const self = await spawnIn(srv, "Self", r1, owner);
    const peer = await spawnIn(srv, "Peer", r1, owner);
    const hidden = await spawnIn(srv, "Hidden", r2, owner);
    const miaAgent = await spawnIn(srv, "MiaAgent", r1, mia);
    const miaOperator = await spawnIn(srv, "MiaOperator", r1, mia);
    const ownerId = userIdOf(owner);
    const selfTok = { bearer: mintAgentToken(self.id, ownerId) };
    const miaTok = { bearer: mintAgentToken(miaAgent.id, userIdOf(mia)) };
    // A separate agent: minting rotates the agent's previous token.
    const miaPriv = {
      bearer: mintAgentToken(miaOperator.id, userIdOf(mia), true),
    };
    const run = { bearer: mintRunToken("job-1", "run-1", ownerId) };
    const miaUser = { rawSessionId: mia.rawSessionId };
    const ownerUser = { rawSessionId: owner.rawSessionId };

    // [label, caller, target, may read]
    const cases: Array<[string, Caller, AgentInfo, boolean]> = [
      ["agent reads itself", selfTok, self, true],
      ["agent reads a room-mate", selfTok, peer, true],
      [
        "agent reads an agent in its member's other room",
        selfTok,
        hidden,
        true,
      ],
      ["owner reads any agent", ownerUser, hidden, true],
      ["restricted member reads a reachable agent", miaUser, peer, true],
      ["restricted member is denied a hidden room", miaUser, hidden, false],
      ["restricted member's agent reads itself", miaTok, miaAgent, true],
      ["restricted member's agent reads a reachable agent", miaTok, peer, true],
      [
        "restricted member's agent is denied a hidden room",
        miaTok,
        hidden,
        false,
      ],
      ["privileged agent is denied a hidden room", miaPriv, hidden, false],
      ["a cron run is denied", run, self, false],
    ];
    for (const [label, caller, target, allowed] of cases) {
      const q = await readQueue(srv, caller, target.id);
      const s = await call(
        srv,
        caller,
        "GET",
        `/api/agents/${target.id}/sessions`,
      );
      // Same reach, same refusal: the two reads can never drift apart.
      expect({ label, status: q.status }).toEqual({ label, status: s.status });
      if (allowed) {
        expect({ label, status: q.status }).toEqual({ label, status: 200 });
        expect(Array.isArray(itemsOf(q))).toBe(true);
      } else {
        expect({ label, denied: q.status >= 400 }).toEqual({
          label,
          denied: true,
        });
        expect(JSON.stringify(q.body)).not.toContain('"queue"');
      }
    }
  });
});

describe("agents.readQueue: content", () => {
  it("lists the waiting items in queue order, without the skill body or internal flags", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const peer = await spawnIn(srv, "Peer", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const peerTok = { bearer: mintAgentToken(peer.id, ownerId) };
    const recvTok = { bearer: mintAgentToken(recv.id, ownerId) };

    await busy(srv, senderTok, recv.id);
    const first = await send(srv, senderTok, recv.id, "first");
    expect(first.queued).toBe(true);
    const skill = srv.agentManager.enqueueMessage(recv.id, {
      sender: { kind: "user", username: owner.username },
      text: "/some-skill",
      sdkText: SKILL_BODY,
      attachments: [ATTACHMENT],
    });
    expect(skill.ok).toBe(true);
    const last = await send(srv, peerTok, recv.id, "last");
    const live = queueOf(srv, recv.id);
    expect(live.map((m) => m.text)).toEqual(["first", "/some-skill", "last"]);
    // The enabling condition for the flag check below: the live items carry
    // the internal busy flag.
    expect(live.every((m) => m.queuedDuringBusyTurn === true)).toBe(true);

    for (const reader of [recvTok, peerTok]) {
      const r = await readQueue(srv, reader, recv.id);
      expect(r.status).toBe(200);
      const items = itemsOf(r);
      expect(items.map((i) => i.id)).toEqual(live.map((m) => m.id));
      expect(items.map((i) => i.text)).toEqual([
        "first",
        "/some-skill",
        "last",
      ]);
      expect(items[0].id).toBe(first.messageId);
      expect(items[2].id).toBe(last.messageId);
      // Who sent each one.
      expect(items[0].sender).toMatchObject({
        kind: "agent",
        agentId: sender.id,
      });
      expect(items[1].sender).toMatchObject({ kind: "user" });
      expect(items[2].sender).toMatchObject({
        kind: "agent",
        agentId: peer.id,
      });
      expect(typeof items[0].queuedAt).toBe("number");
      // No pre-expanded skill body: an agent pays for it in context.
      expect(JSON.stringify(r.body)).not.toContain("SKILL-BODY-MARKER");
      // Attachments by name only.
      const att = JSON.stringify(items[1].attachments);
      expect(att).toContain(ATTACHMENT.originalName);
      expect(att).not.toContain(ATTACHMENT.mediaType);
      // Internal flags stay internal.
      for (const item of items) {
        for (const key of [
          "sdkText",
          "queuedDuringBusyTurn",
          "native",
          "echoed",
          "limitResume",
          "interruptCause",
        ]) {
          expect({ key, present: key in item }).toEqual({
            key,
            present: false,
          });
        }
      }
    }
  });

  it("leaves out an item already delivered inside the running turn, and it can no longer be taken back", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend(true) });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const ownerUser = { rawSessionId: owner.rawSessionId };

    await busy(srv, senderTok, recv.id);
    const steer = await send(srv, senderTok, recv.id, "urgent", {
      steer: true,
    });
    const before = await readQueue(srv, senderTok, recv.id);
    expect(itemsOf(before).map((i) => i.id)).toEqual([steer.messageId]);

    // The tool boundary takes the item into the running turn; it stays in the
    // stored queue until the turn ends.
    const delivered = srv.fakeBackend.sessionForAgent(recv.id)!.toolBoundary();
    expect(delivered).toContain("urgent");

    const after = await readQueue(srv, senderTok, recv.id);
    expect(after.status).toBe(200);
    expect(itemsOf(after)).toEqual([]);

    const bySender = await cancel(srv, senderTok, recv.id, steer.messageId);
    expect(bySender.status).toBe(404);
    expect(errCode(bySender.body)).toBe("not_queued");
    const byOwner = await cancel(srv, ownerUser, recv.id, steer.messageId);
    expect(byOwner.status).toBe(404);
    expect(errCode(byOwner.body)).toBe("not_queued");
  });
});

describe("agents.cancelQueued: sender retract", () => {
  it("a sender takes back its own waiting message; the chip row updates", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const sock = await srv.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");

    await busy(srv, senderTok, recv.id);
    const keep = await send(srv, senderTok, recv.id, "keep");
    const drop = await send(srv, senderTok, recv.id, "drop");
    expect(queueOf(srv, recv.id).map((m) => m.id)).toEqual([
      keep.messageId,
      drop.messageId,
    ]);

    const r = await cancel(srv, senderTok, recv.id, drop.messageId);
    expect(r.status).toBe(204);
    expect(queueOf(srv, recv.id).map((m) => m.id)).toEqual([keep.messageId]);
    await waitUntil(
      () => sawQueueIds(sock, recv.id, [keep.messageId]),
      "queue re-emitted without the taken-back item",
    );

    // Gone is gone: the second try is an honest miss.
    const again = await cancel(srv, senderTok, recv.id, drop.messageId);
    expect(again.status).toBe(404);
    expect(errCode(again.body)).toBe("not_queued");
  });

  it("an agent that is not privileged cancels no other sender's item, and learns nothing from the miss", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const peer = await spawnIn(srv, "Peer", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const peerTok = { bearer: mintAgentToken(peer.id, ownerId) };
    const recvTok = { bearer: mintAgentToken(recv.id, ownerId) };

    await busy(srv, senderTok, recv.id);
    const theirs = await send(srv, senderTok, recv.id, "theirs");
    const member = srv.agentManager.enqueueMessage(recv.id, {
      sender: { kind: "user", username: owner.username },
      text: "from the member",
    });
    expect(member.ok).toBe(true);
    const memberId = queueOf(srv, recv.id)[1].id;

    const missing = await cancel(srv, peerTok, recv.id, "deadbeef");
    expect(missing.status).toBe(404);
    expect(errCode(missing.body)).toBe("not_queued");

    // A room-mate (it can READ this queue) and the receiver itself.
    for (const caller of [peerTok, recvTok]) {
      for (const id of [theirs.messageId, memberId]) {
        const r = await cancel(srv, caller, recv.id, id);
        // The same answer as for an id that does not exist.
        expect({ status: r.status, body: r.body }).toEqual({
          status: missing.status,
          body: missing.body,
        });
      }
    }
    expect(queueOf(srv, recv.id).map((m) => m.text)).toEqual([
      "theirs",
      "from the member",
    ]);
  });

  it("a sender takes back its message from a queue it cannot read, privileged or not, and cancels nothing else there", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const owner = await srv.seedOwner("Boss");
    const mia = await srv.seedMember("Mia");
    const ownerSock = await srv.connectWs(owner.rawSessionId);
    await ownerSock.waitFor("full_state");
    const access = await call(
      srv,
      owner,
      "PUT",
      `/api/users/${encodeURIComponent(mia.username)}/access`,
      { allowedRooms: [r1] },
    );
    expect(access.status).toBeLessThan(300);
    const ownerId = userIdOf(owner);
    const hidden = await spawnIn(srv, "Hidden", r2, owner);
    const local = await spawnIn(srv, "Local", r2, owner);
    const miaAgent = await spawnIn(srv, "MiaAgent", r1, mia);
    const localTok = { bearer: mintAgentToken(local.id, ownerId) };

    await busy(srv, localTok, hidden.id);
    const other = await send(srv, localTok, hidden.id, "local's");

    for (const privileged of [false, true]) {
      const tok = {
        bearer: mintAgentToken(miaAgent.id, userIdOf(mia), privileged),
      };
      // The enabling condition: this caller cannot read the target's queue.
      const read = await readQueue(srv, tok, hidden.id);
      expect({ privileged, denied: read.status >= 400 }).toEqual({
        privileged,
        denied: true,
      });

      const mine = await send(srv, tok, hidden.id, `mine ${privileged}`);
      expect(mine.queued).toBe(true);
      const r = await cancel(srv, tok, hidden.id, mine.messageId);
      expect({ privileged, status: r.status }).toEqual({
        privileged,
        status: 204,
      });

      const theirs = await cancel(srv, tok, hidden.id, other.messageId);
      expect({ privileged, status: theirs.status }).toEqual({
        privileged,
        status: 404,
      });
      expect(errCode(theirs.body)).toBe("not_queued");
    }
    expect(queueOf(srv, hidden.id).map((m) => m.text)).toEqual(["local's"]);
  });
});

describe("agents.cancelQueued: members and privileged agents", () => {
  it("a privileged agent with reach cancels another sender's item", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const operator = await spawnIn(srv, "Operator", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const opTok = { bearer: mintAgentToken(operator.id, ownerId, true) };

    await busy(srv, senderTok, recv.id);
    const a = await send(srv, senderTok, recv.id, "agent's");
    srv.agentManager.enqueueMessage(recv.id, {
      sender: { kind: "user", username: owner.username },
      text: "member's",
    });
    const memberId = queueOf(srv, recv.id)[1].id;

    expect((await cancel(srv, opTok, recv.id, a.messageId)).status).toBe(204);
    expect((await cancel(srv, opTok, recv.id, memberId)).status).toBe(204);
    expect(queueOf(srv, recv.id)).toEqual([]);

    const gone = await cancel(srv, opTok, recv.id, a.messageId);
    expect(gone.status).toBe(404);
    expect(errCode(gone.body)).toBe("not_queued");
  });

  it("a member cancels any item, and a gone item answers 404 not_queued", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };
    const ownerUser = { rawSessionId: owner.rawSessionId };

    await busy(srv, senderTok, recv.id);
    const a = await send(srv, senderTok, recv.id, "agent's");
    expect((await cancel(srv, ownerUser, recv.id, a.messageId)).status).toBe(
      204,
    );
    expect(queueOf(srv, recv.id)).toEqual([]);

    for (const id of [a.messageId, "deadbeef"]) {
      const r = await cancel(srv, ownerUser, recv.id, id);
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("not_queued");
    }
  });

  it("a cron run cancels nothing", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const owner = await srv.seedOwner("Boss");
    const ownerId = userIdOf(owner);
    const recv = await spawnIn(srv, "Receiver", r1, owner);
    const sender = await spawnIn(srv, "Sender", r1, owner);
    const senderTok = { bearer: mintAgentToken(sender.id, ownerId) };

    await busy(srv, senderTok, recv.id);
    const a = await send(srv, senderTok, recv.id, "agent's");
    const run = { bearer: mintRunToken("job-1", "run-1", ownerId) };
    const r = await cancel(srv, run, recv.id, a.messageId);
    expect(r.status).toBe(403);
    expect(queueOf(srv, recv.id).map((m) => m.id)).toEqual([a.messageId]);
  });
});
