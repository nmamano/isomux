// An agent's message to another agent is recorded in the SENDER's log as an
// agent_outbound entry (task 40b82508). Before it, the send existed in the
// sender's log only as a curl tool call, which log search does not read, so an
// audit of the sender's log found none of the messages it sent.
//
// Drives the real HTTP server, auth, /api executor and on-disk log tree. The
// scheduled-message record is pinned in scheduled-messages.di.test.ts; the
// chat hides both sender-side records (ui/log-view/LogView.outbound.dom.test.tsx).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { blockAtomicFileReplacement } from "./temp-state.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { _testResetSearchAdmission } from "../log-search-runner.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});
// Search admission counters are process-global (see routes-logs-rest.test.ts).
beforeEach(_testResetSearchAdmission);

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

type World = {
  srv: TestServer;
  owner: { rawSessionId: string; id: string };
  sender: AgentInfo;
  receiver: AgentInfo;
  senderBearer: string;
};

// Every turn parks (no turn_completed), so the sender is mid-turn when it
// sends, as an agent is when it runs curl, and the receiver can be held busy.
async function setup(): Promise<World> {
  const srv = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "missing",
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      },
    }),
  });
  server = srv;
  const seeded = await srv.seedOwner("Boss");
  const ownerId = getUserByName(seeded.username)!.id;
  const room = srv.agentManager.getRooms()[0].id;
  const spawn = async (name: string) => {
    const a = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      seeded.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!a) throw new Error(`spawn ${name} failed`);
    return a;
  };
  const sender = await spawn("Sender");
  const receiver = await spawn("Receiver");
  const owner = { rawSessionId: seeded.rawSessionId, id: ownerId };
  // The sender's own turn: it has a session to record into.
  await humanSend(srv, owner.rawSessionId, sender.id, "start your work");
  await waitUntil(
    () => srv.agentManager.getCurrentSessionId(sender.id) !== null,
    "sender session",
  );
  return {
    srv,
    owner,
    sender,
    receiver,
    senderBearer: mintAgentToken(sender.id, ownerId),
  };
}

async function humanSend(
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
  expect(res.status).toBe(200);
}

async function agentSend(
  w: World,
  receiverId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await w.srv.http(`/api/agents/${receiverId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${w.senderBearer}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const outbound = (srv: TestServer, agentId: string): LogEntry[] =>
  srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "agent_outbound");

const errorCode = (body: Record<string, unknown>) =>
  (body.error as { code?: string } | undefined)?.code;

async function searchHits(
  w: World,
  query: string,
): Promise<{ entryId: string }[]> {
  const res = await w.srv.http(`/api/agents/${w.sender.id}/logs?${query}`, {
    headers: { Authorization: `Bearer ${w.senderBearer}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: { entryId: string }[] }).results;
}

describe("an agent's send to another agent, in the sender's log", () => {
  it("is recorded once with the text and recipient, and found by the default-tier search only", async () => {
    const w = await setup();
    const text = "Approved: QUINCE-7 is ready for the merge.";
    const sent = await agentSend(w, w.receiver.id, { text });
    expect(sent.status).toBe(200);
    expect(sent.body.messageId).toBeString();

    const records = outbound(w.srv, w.sender.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      content: text,
      metadata: {
        recipient_agent_id: w.receiver.id,
        recipient_agent_name: "Receiver",
        message_id: sent.body.messageId,
      },
    });
    // An immediate send names no schedule.
    expect(Object.keys(records[0].metadata ?? {})).not.toContain(
      "scheduled_message_id",
    );
    // The record is the sender's; the receiver keeps only its user_message.
    expect(outbound(w.srv, w.receiver.id)).toHaveLength(0);

    // Searched from disk, as an auditor reads it.
    const hits = await searchHits(w, "q=QUINCE-7");
    expect(hits.map((h) => h.entryId)).toEqual([records[0].id]);
    expect(await searchHits(w, "q=QUINCE-7&tier=prompts")).toHaveLength(0);
  });

  it("is recorded once when a retry reuses the clientMessageId", async () => {
    const w = await setup();
    const body = { text: "retry-safe verdict", clientMessageId: "cid-1" };
    expect((await agentSend(w, w.receiver.id, body)).status).toBe(200);
    const retry = await agentSend(w, w.receiver.id, body);
    expect(retry.status).toBe(200);
    // The retry was deduped: it touched no queue.
    expect("queued" in retry.body).toBe(false);
    expect(outbound(w.srv, w.sender.id)).toHaveLength(1);
  });

  it("is not recorded when the send is refused", async () => {
    const w = await setup();
    // Self-send, refused before any queue.
    const self = await agentSend(w, w.sender.id, { text: "to me" });
    expect(self.status).toBe(400);
    expect(errorCode(self.body)).toBe("self_send");

    // A send the receiver's queue refuses: hold the receiver busy so the
    // message must be queued, and make the durable queue write fail.
    await humanSend(w.srv, w.owner.rawSessionId, w.receiver.id, "kickoff");
    await waitUntil(
      () => w.srv.agentManager.getAgent(w.receiver.id)?.state === "thinking",
      "receiver busy",
    );
    const store = join(w.srv.stateRoot, "message-queues.json");
    blockAtomicFileReplacement(store);
    const failed = await agentSend(w, w.receiver.id, { text: "lost verdict" });
    expect(failed.status).toBe(500);
    expect(errorCode(failed.body)).toBe("persist_failed");
    expect(outbound(w.srv, w.sender.id)).toHaveLength(0);

    // Control: the same send is recorded once the queue can persist again.
    rmSync(store, { recursive: true, force: true });
    const ok = await agentSend(w, w.receiver.id, { text: "kept verdict" });
    expect(ok.status).toBe(200);
    expect(outbound(w.srv, w.sender.id).map((e) => e.content)).toEqual([
      "kept verdict",
    ]);
  });

  it("does not fail the send when the record cannot be written", async () => {
    const w = await setup();
    let attempts = 0;
    w.srv.agentManager.addAgentOutbound = () => {
      attempts++;
      throw new Error("log write failed");
    };
    const sent = await agentSend(w, w.receiver.id, { text: "still delivered" });
    // The record was attempted, and its failure did not reach the sender.
    expect(attempts).toBe(1);
    expect(sent.status).toBe(200);
    expect(sent.body.messageId).toBeString();
    await waitUntil(
      () =>
        (w.srv.fakeBackend.sessionForAgent(w.receiver.id)?.sent ?? []).some(
          (m) => m.text.endsWith("still delivered"),
        ),
      "delivery",
    );
  });
});

describe("addAgentOutbound for a fired scheduled message", () => {
  it("names the schedule and its delivery time beside the recipient", async () => {
    const w = await setup();
    w.srv.agentManager.addAgentOutbound(
      w.sender.id,
      w.receiver.id,
      "the scheduled check-in",
      {
        messageId: "q-9",
        scheduledMessageId: "sm_0123abcd",
        scheduledFor: 1_784_000_000_000,
      },
    );
    expect(w.srv.agentManager.getAgentLogs(w.sender.id).at(-1)).toMatchObject({
      kind: "agent_outbound",
      content: "the scheduled check-in",
      metadata: {
        recipient_agent_id: w.receiver.id,
        recipient_agent_name: "Receiver",
        message_id: "q-9",
        scheduled_message_id: "sm_0123abcd",
        scheduled_for: 1_784_000_000_000,
      },
    });
  });
});
