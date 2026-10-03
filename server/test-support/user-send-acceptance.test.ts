// Member send acceptance and attempt-id dedupe (task 51de8814).
//
// The composer keeps an attempt until the server acknowledges it, and resends
// a failed attempt with its original clientMessageId. So the USER branch of
// POST /api/agents/:id/messages must (a) answer 200 only once the server has
// taken responsibility for the message and an HTTP error for every refusal,
// and (b) treat a repeated id from the same member as already handled on the
// echo, queue and command paths.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type SeededIdentity,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { existsSync, mkdirSync, renameSync, rmdirSync } from "fs";
import { join } from "path";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// Parks each turn busy (no turn_completed) so later sends take the queue path.
function parkingBackend(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

async function spawnAgent(srv: TestServer): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const info = await srv.agentManager.spawn(
    "X",
    srv.stateRoot,
    "default",
    0,
    undefined,
    room.id,
  );
  if (!info) throw new Error("spawn failed");
  return info;
}

async function send(
  srv: TestServer,
  who: SeededIdentity,
  agentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; code?: string }> {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    rawSessionId: who.rawSessionId,
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return { status: res.status, code: json.error?.code };
}

function queueOf(srv: TestServer, id: string): NonNullable<AgentInfo["queue"]> {
  const agent = srv.agentManager.getAllAgents().find((a) => a.id === id);
  return agent?.queue ?? [];
}

function stateOf(srv: TestServer, id: string): string | undefined {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)?.state;
}

function echoesOf(srv: TestServer, id: string, text: string): number {
  return srv.agentManager
    .getAgentLogs(id)
    .filter((e) => e.kind === "user_message" && e.content === text).length;
}

async function busyAgent(srv: TestServer, owner: SeededIdentity) {
  const agent = await spawnAgent(srv);
  expect((await send(srv, owner, agent.id, { text: "kickoff" })).status).toBe(
    200,
  );
  await waitUntil(() => stateOf(srv, agent.id) === "thinking", "busy");
  return agent;
}

describe("USER send acceptance (task 51de8814)", () => {
  it("a repeated attempt id on the echo path is acknowledged and delivered once", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);

    const body = { text: "crafted prompt", clientMessageId: "attempt-1" };
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    // Acceptance means the echo is already in the log when the 200 lands.
    expect(echoesOf(srv, agent.id, "crafted prompt")).toBe(1);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    await waitUntil(() => stateOf(srv, agent.id) !== "thinking", "idle");

    expect(echoesOf(srv, agent.id, "crafted prompt")).toBe(1);
    const delivered = srv.fakeBackend.sessions
      .flatMap((s) => s.sent)
      .filter((m) => m.text.includes("crafted prompt"));
    expect(delivered.length).toBe(1);
  });

  it("concurrent requests with one attempt id deliver once and both succeed", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);

    const body = { text: "twin", clientMessageId: "attempt-twin" };
    const [a, b] = await Promise.all([
      send(srv, owner, agent.id, body),
      send(srv, owner, agent.id, body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(echoesOf(srv, agent.id, "twin")).toBe(1);
  });

  it("the attempt id is scoped to the member who sent it", async () => {
    const srv = (server = await startTestServer());
    const agent = await spawnAgent(srv);
    const sendAs = (username: string) =>
      new Promise<boolean>((resolve) => {
        void srv.agentManager.sendMessage(
          agent.id,
          "same id",
          username,
          undefined,
          undefined,
          {
            clientMessageId: "shared-id",
            onAccepted: (r) => resolve(r.ok),
          },
        );
      });

    expect(await sendAs("alice")).toBe(true);
    await waitUntil(() => stateOf(srv, agent.id) !== "thinking", "idle");
    expect(await sendAs("bob")).toBe(true);
    await waitUntil(() => stateOf(srv, agent.id) !== "thinking", "idle");
    expect(echoesOf(srv, agent.id, "same id")).toBe(2);
  });

  it("a repeated attempt id on the queue path queues once", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: parkingBackend(),
    }));
    const owner = await srv.seedOwner("Boss");
    const agent = await busyAgent(srv, owner);

    const body = { text: "queued prompt", clientMessageId: "attempt-q" };
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    expect(
      queueOf(srv, agent.id).filter((m) => m.text === "queued prompt").length,
    ).toBe(1);
  });

  it("a full queue refuses with 429 queue_full, and the refused id can be resent once there is room", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: parkingBackend(),
    }));
    const owner = await srv.seedOwner("Boss");
    const agent = await busyAgent(srv, owner);

    for (let i = 0; i < 50; i++) {
      expect(
        (await send(srv, owner, agent.id, { text: `filler ${i}` })).status,
      ).toBe(200);
    }
    const body = { text: "overflow", clientMessageId: "attempt-full" };
    const refused = await send(srv, owner, agent.id, body);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe("queue_full");
    expect(queueOf(srv, agent.id).length).toBe(50);

    // A refusal is not remembered: after room frees up, the same id goes in.
    const first = queueOf(srv, agent.id)[0];
    const cancel = await srv.http(
      `/api/agents/${agent.id}/queue/${first.id}`,
      { method: "DELETE", rawSessionId: owner.rawSessionId },
    );
    expect(cancel.status).toBeLessThan(300);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    expect(
      queueOf(srv, agent.id).filter((m) => m.text === "overflow").length,
    ).toBe(1);
  });

  it("a repeated attempt id on the command path runs the command once", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);
    const sock = await srv.connectWs(owner.rawSessionId);
    const entriesFor = () =>
      sock.messages.filter((m) => {
        const msg = m as { type?: string; entry?: { agentId?: string } };
        return msg.type === "log_entry" && msg.entry?.agentId === agent.id;
      }).length;

    const body = { text: "/help", clientMessageId: "attempt-cmd" };
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    await sleep(200);
    const afterFirst = entriesFor();
    expect(afterFirst).toBeGreaterThan(0);

    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    await sleep(200);
    expect(entriesFor()).toBe(afterFirst);
  });

  it("refuses a message whose transcript write fails, and the repaired resend delivers once", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);
    expect((await send(srv, owner, agent.id, { text: "bootstrap" })).status).toBe(
      200,
    );
    await waitUntil(
      () => stateOf(srv, agent.id) === "waiting_for_response",
      "idle",
    );
    // Block the established session's transcript: a directory where the
    // JSONL file was.
    const file = join(
      srv.stateRoot,
      "logs",
      agent.id,
      `${srv.fakeBackend.sessions[0].sessionId}.jsonl`,
    );
    expect(existsSync(file)).toBe(true);
    renameSync(file, `${file}.saved`);
    mkdirSync(file);

    const body = { text: "must be stored", clientMessageId: "attempt-disk" };
    const refused = await send(srv, owner, agent.id, body);
    expect(refused.status).toBe(500);
    expect(refused.code).toBe("persist_failed");
    expect(echoesOf(srv, agent.id, "must be stored")).toBe(0);
    const delivered = () =>
      srv.fakeBackend.sessions
        .flatMap((s) => s.sent)
        .filter((m) => m.text.includes("must be stored")).length;
    expect(delivered()).toBe(0);

    rmdirSync(file);
    renameSync(`${file}.saved`, file);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    await waitUntil(() => stateOf(srv, agent.id) !== "thinking", "idle");
    expect(echoesOf(srv, agent.id, "must be stored")).toBe(1);
    expect(delivered()).toBe(1);
  });

  it("refuses a message that cancels a pick when its transcript write fails", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);
    expect((await send(srv, owner, agent.id, { text: "bootstrap" })).status).toBe(
      200,
    );
    await waitUntil(
      () => stateOf(srv, agent.id) === "waiting_for_response",
      "idle",
    );
    const file = join(
      srv.stateRoot,
      "logs",
      agent.id,
      `${srv.fakeBackend.sessions[0].sessionId}.jsonl`,
    );
    expect(existsSync(file)).toBe(true);
    renameSync(file, `${file}.saved`);
    mkdirSync(file);

    // A pending pick plus plain text: the pick is cancelled and the text is
    // echoed late, after the pick handling, as a normal message.
    expect((await send(srv, owner, agent.id, { text: "/model" })).status).toBe(
      200,
    );
    const body = { text: "after the pick", clientMessageId: "attempt-pick" };
    const refused = await send(srv, owner, agent.id, body);
    expect(refused.status).toBe(500);
    expect(refused.code).toBe("persist_failed");
    expect(echoesOf(srv, agent.id, "after the pick")).toBe(0);
    const delivered = () =>
      srv.fakeBackend.sessions
        .flatMap((s) => s.sent)
        .filter((m) => m.text.includes("after the pick")).length;
    expect(delivered()).toBe(0);

    rmdirSync(file);
    renameSync(`${file}.saved`, file);
    expect((await send(srv, owner, agent.id, body)).status).toBe(200);
    await waitUntil(() => stateOf(srv, agent.id) !== "thinking", "idle");
    expect(echoesOf(srv, agent.id, "after the pick")).toBe(1);
    expect(delivered()).toBe(1);
  });

  it("bounds a member's attempt id at 128 characters, and only on the member path", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const agent = await spawnAgent(srv);

    const atBound = await send(srv, owner, agent.id, {
      text: "at the bound",
      clientMessageId: "x".repeat(128),
    });
    expect(atBound.status).toBe(200);
    const over = await send(srv, owner, agent.id, {
      text: "over the bound",
      clientMessageId: "y".repeat(129),
    });
    expect(over.status).toBe(422);
    expect(over.code).toBe("invalid_client_message_id");
    expect(echoesOf(srv, agent.id, "over the bound")).toBe(0);

    // An agent sender keeps its own rules.
    const room = srv.agentManager.getRooms()[0];
    const sender = await srv.agentManager.spawn(
      "Sender",
      srv.stateRoot,
      "default",
      1,
      undefined,
      room.id,
    );
    const res = await srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentTokenRaw(sender!.id)}`,
      },
      body: JSON.stringify({
        text: "from an agent",
        clientMessageId: "z".repeat(129),
      }),
    });
    expect(res.status).toBe(200);
  });
});
