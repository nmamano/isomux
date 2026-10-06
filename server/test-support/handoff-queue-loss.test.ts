// Task 6f6e8ed7, over HTTP: messages queued for an agent when it is handed off
// (by itself or by an operator) reach the fresh session after the brief. The
// manager-level cases are in handoff-queue-carry.test.ts.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { agentId?: string; rawSessionId?: string },
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth.agentId)
    headers["Authorization"] = `Bearer ${getAgentTokenRaw(auth.agentId)}`;
  const res = await srv.http(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    rawSessionId: auth.rawSessionId,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const sessionsFor = (srv: TestServer, id: string): FakeSession[] =>
  srv.fakeBackend.sessions.filter((s) => s.opts.agentId === id);
const deliveryCount = (srv: TestServer, id: string, needle: string) =>
  sessionsFor(srv, id).reduce(
    (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
    0,
  );
const agentOf = (srv: TestServer, id: string): AgentInfo =>
  srv.agentManager.getAllAgents().find((x) => x.id === id)!;

// A is mid-turn (parked in "thinking"); B's message queues behind that turn.
async function busyAgentWithQueuedMessage(queued: string) {
  const srv = await startTestServer({
    fakeBackend: new FakeBackend({
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      },
    }),
  });
  const owner = await srv.seedOwner("Nil");
  const room = srv.agentManager.getRooms()[0];
  const spawn = async (name: string) =>
    (await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      room.id,
    ))!;
  const a = await spawn("AgentA");
  const b = await spawn("AgentB");
  await call(srv, "POST", `/api/agents/${a.id}/messages`, { agentId: b.id }, {
    text: "kickoff",
  });
  await waitUntil(
    () => agentOf(srv, a.id).state === "thinking",
    "A is mid-turn",
  );
  const q = await call(
    srv,
    "POST",
    `/api/agents/${a.id}/messages`,
    { agentId: b.id },
    { text: queued },
  );
  expect(q.body.queued).toBe(true);
  expect(agentOf(srv, a.id).queue?.map((m) => m.text)).toEqual([queued]);
  const old = srv.fakeBackend.sessionForAgent(a.id)!;
  return { srv, owner, a, b, old };
}

// The fresh session the handoff woke, once it has received its first prompt.
async function freshSession(
  srv: TestServer,
  id: string,
  old: FakeSession,
): Promise<FakeSession> {
  await waitUntil(() => {
    const cur = srv.fakeBackend.sessionForAgent(id);
    return !!cur && cur !== old && cur.sent.length > 0;
  }, "fresh session received its first prompt");
  return srv.fakeBackend.sessionForAgent(id)!;
}

// The brief leads the fresh session's first prompt and the queued message
// follows it; the old session never saw the queued message.
function expectCarried(
  old: FakeSession,
  fresh: FakeSession,
  brief: string,
  queued: string,
) {
  const prompt = fresh.sent[0].text;
  expect(prompt.indexOf(brief)).toBeGreaterThanOrEqual(0);
  expect(prompt.indexOf(queued)).toBeGreaterThan(prompt.indexOf(brief));
  expect(old.sent.some((m) => m.text.includes(queued))).toBe(false);
}

describe("task 6f6e8ed7: queued messages across a handoff", () => {
  it("self-handoff: a message queued during the handing-off turn reaches the fresh session", async () => {
    const queued = "QUEUED-FROM-B";
    const brief = "HANDOFF-BRIEF";
    const { srv, a, b, old } = await busyAgentWithQueuedMessage(queued);
    server = srv;

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: brief },
    );
    expect(res.status).toBe(200);
    const fresh = await freshSession(srv, a.id, old);
    expectCarried(old, fresh, brief, queued);
    // B stays the sender: the reply-to preamble names B.
    expect(fresh.sent[0].text).toContain(b.id);
  });

  it("operator handoff of another agent: a queued message reaches the fresh session", async () => {
    const queued = "QUEUED-FROM-B";
    const brief = "HANDOFF-BRIEF";
    const { srv, owner, a, old } = await busyAgentWithQueuedMessage(queued);
    server = srv;

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { rawSessionId: owner.rawSessionId },
      { text: brief },
    );
    expect(res.status).toBe(200);
    expectCarried(old, await freshSession(srv, a.id, old), brief, queued);
  });

  it("new-conversation still clears the queue: no message is delivered and no session wakes", async () => {
    const queued = "QUEUED-FROM-B";
    const { srv, a } = await busyAgentWithQueuedMessage(queued);
    server = srv;

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/new-conversation`,
      { agentId: a.id },
      {},
    );
    expect(res.status).toBe(204);
    await waitUntil(() => agentOf(srv, a.id).dormant === true, "reset done");
    expect(agentOf(srv, a.id).queue ?? []).toHaveLength(0);
    expect(sessionsFor(srv, a.id)).toHaveLength(1);
    expect(deliveryCount(srv, a.id, queued)).toBe(0);
  });
});
