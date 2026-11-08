// A member's message names its send attempt in every frame that shows it
// (task 1ea5abb4). The composer keeps a "Sending" row until it knows the
// message landed; the queue frame or the echo usually reaches the browser
// before the HTTP answer, so the client drops the row on the first frame that
// carries the attempt's clientMessageId. The client half is in
// ui/log-view/LogView.outbox-frame-ack.dom.test.tsx.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import type { AgentInfo, LogEntry, QueuedMessage } from "../../shared/types.ts";

let server: TestServer | null = null;
const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
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

async function spawnAgent(
  srv: TestServer,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const info = await srv.agentManager.spawn(
    "X",
    srv.workDir,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn failed");
  return info;
}

function stateOf(srv: TestServer, id: string): string | undefined {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)?.state;
}

function queueOf(srv: TestServer, id: string): QueuedMessage[] {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)?.queue ?? [];
}

async function send(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    rawSessionId,
  });
  await res.body?.cancel();
  return res.status;
}

async function busyAgent(
  srv: TestServer,
  rawSessionId: string,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const agent = await spawnAgent(srv, agentType);
  expect(await send(srv, rawSessionId, agent.id, { text: "kickoff" })).toBe(
    200,
  );
  await waitUntil(() => stateOf(srv, agent.id) === "thinking", "busy");
  return agent;
}

// The queue items of every agent_updated frame for `agentId`, in order.
function queueFrames(messages: unknown[], agentId: string): QueuedMessage[][] {
  const out: QueuedMessage[][] = [];
  for (const m of messages) {
    const msg = m as {
      type?: string;
      agentId?: string;
      changes?: { queue?: QueuedMessage[] };
    };
    if (
      msg.type === "agent_updated" &&
      msg.agentId === agentId &&
      msg.changes?.queue
    )
      out.push(msg.changes.queue);
  }
  return out;
}

function userMessageEntries(messages: unknown[], text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of messages) {
    const msg = m as { type?: string; entry?: LogEntry };
    if (
      msg.type === "log_entry" &&
      msg.entry?.kind === "user_message" &&
      msg.entry.content === text
    )
      out.push(msg.entry);
  }
  return out;
}

describe("a member's message names its send attempt (task 1ea5abb4)", () => {
  it("a send to a busy agent puts the attempt id on the queue item of the frame", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: parkingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await busyAgent(srv, owner.rawSessionId);
    const sock = await srv.connectWs(owner.rawSessionId);

    expect(
      await send(srv, owner.rawSessionId, agent.id, {
        text: "queued prompt",
        clientMessageId: "attempt-q",
      }),
    ).toBe(200);

    await waitUntil(
      () =>
        queueFrames(sock.messages, agent.id).some((q) =>
          q.some((m) => m.text === "queued prompt"),
        ),
      "queue frame",
    );
    const items = queueFrames(sock.messages, agent.id)
      .flat()
      .filter((m) => m.text === "queued prompt");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.clientMessageId).toBe("attempt-q");
    sock.close();
  });

  it("a send to an idle agent puts the attempt id on the echoed user_message", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const agent = await spawnAgent(srv);
    expect(stateOf(srv, agent.id)).not.toBe("thinking");
    const sock = await srv.connectWs(owner.rawSessionId);

    expect(
      await send(srv, owner.rawSessionId, agent.id, {
        text: "idle prompt",
        clientMessageId: "attempt-e",
      }),
    ).toBe(200);

    await waitUntil(
      () => userMessageEntries(sock.messages, "idle prompt").length > 0,
      "echo frame",
    );
    const echoes = userMessageEntries(sock.messages, "idle prompt");
    expect(echoes).toHaveLength(1);
    expect(echoes[0].metadata?.clientMessageId).toBe("attempt-e");
    // The log the chat replays on open carries it too.
    const logged = srv.agentManager
      .getAgentLogs(agent.id)
      .filter((e) => e.kind === "user_message" && e.content === "idle prompt");
    expect(logged).toHaveLength(1);
    expect(logged[0].metadata?.clientMessageId).toBe("attempt-e");
    sock.close();
  });

  // The attempt id rides on the item only: it is not a queue-dedupe key, which
  // is keyed by the bare id and would let one member's id drop another
  // member's message now that every viewer sees the id in the frame.
  it("another member's send with the same attempt id to the busy agent is queued too", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: parkingBackend(),
    }));
    const owner = await srv.seedOwner("Morgan");
    const agent = await busyAgent(srv, owner.rawSessionId);
    const sendAs = (username: string, text: string) =>
      new Promise<boolean>((resolve) => {
        void srv.agentManager.sendMessage(
          agent.id,
          text,
          username,
          undefined,
          undefined,
          {
            clientMessageId: "shared-id",
            onAccepted: (r) => resolve(r.ok),
          },
        );
      });

    expect(await sendAs("alice", "from alice")).toBe(true);
    expect(await sendAs("bob", "from bob")).toBe(true);

    const queue = queueOf(srv, agent.id);
    expect(queue.map((m) => m.text).sort()).toEqual(["from alice", "from bob"]);
    for (const m of queue) expect(m.clientMessageId).toBe("shared-id");
  });

  // A client whose HTTP answer was lost (here: by a restart) next sees the
  // message as the user_message the queue flush writes, so that entry names
  // the attempt too, and the id survives the queue's reload.
  it("a queued send keeps its attempt id across a restart, onto the flushed user_message", async () => {
    // Codex: the boot-replay wake starts a fresh session (no Claude resume
    // preflight against the fake session id), as in queue-reliability.test.ts.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Morgan");
    const agent = await busyAgent(server, owner.rawSessionId, "codex");

    expect(
      await send(server, owner.rawSessionId, agent.id, {
        text: "survives restart",
        clientMessageId: "attempt-r",
      }),
    ).toBe(200);
    expect(queueOf(server, agent.id).map((m) => m.text)).toEqual([
      "survives restart",
    ]);

    server = await server.restart();
    const srv = server;

    const flushed = () =>
      srv.agentManager
        .getAgentLogs(agent.id)
        .filter(
          (e) => e.kind === "user_message" && e.content === "survives restart",
        );
    await waitUntil(() => flushed().length > 0, "flushed user_message");
    expect(flushed()).toHaveLength(1);
    expect(flushed()[0].metadata?.clientMessageId).toBe("attempt-r");
  });
});
