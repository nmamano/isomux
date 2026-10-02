// agents.abort from an agent token (task f4452169). Every agent may stop any
// agent it may message; such a stop shares the steer window (3 per minute per
// receiver) and leaves the receiver a one-time note on its next turn, so the
// backend's "interrupted by user" text is not read as a member decision.
// Members keep the operator path: no limit, no note.
//
// Zero LLM: parkingBackend parks each turn in "thinking" until it is stopped.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { AGENT_STOP_NOTE } from "../agent-manager.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Durable sessions: a stop replaces the session, and only a resumable one
// continues the conversation the notice explains. A lost one starts a fresh
// conversation, where the conversation reset drops the notice.
function parkingBackend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

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

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
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

// Every prompt the backend received for this agent, across the sessions an
// abort replaces.
function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

async function post(
  srv: TestServer,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  body: unknown = {},
): Promise<{ status: number; code?: string; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  const res = await srv.http(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    rawSessionId: auth.rawSessionId,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

const abortAs = (srv: TestServer, targetId: string, senderId: string) =>
  post(srv, `/api/agents/${targetId}/abort`, {
    bearer: getAgentTokenRaw(senderId)!,
  });

// Starts a parked turn on `targetId` with a message from `senderId`.
async function startTurn(
  srv: TestServer,
  targetId: string,
  senderId: string,
  text: string,
): Promise<void> {
  const r = await post(
    srv,
    `/api/agents/${targetId}/messages`,
    { bearer: getAgentTokenRaw(senderId)! },
    { text },
  );
  expect(r.status).toBe(200);
  await waitUntil(
    () => agentOf(srv, targetId).state === "thinking",
    3000,
    `turn "${text}" running`,
  );
}

describe("agents.abort from an ordinary agent", () => {
  it("stops a busy agent in another room", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const r2 = server.agentManager.createRoom("Elsewhere");
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r2);
    await startTurn(server, target.id, stopper.id, "work");

    const r = await abortAs(server, target.id, stopper.id);
    expect(r.status).toBe(204);
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
      3000,
      "target stopped",
    );
  });

  it("gets 404 for an agent that does not exist, as a message send does", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    const r = await abortAs(server, "no-such-agent", stopper.id);
    expect(r.status).toBe(404);
    expect(r.code).toBe("agent_not_found");
  });

  it("denies a permission prompt the target is parked on, as an operator's stop does", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    await startTurn(server, target.id, stopper.id, "run something");
    server.fakeBackend.sessionForAgent(target.id)!.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    await waitUntil(
      () => agentOf(server!, target.id).pendingPrompt === "permission",
      3000,
      "target parked on a permission prompt",
    );

    const r = await abortAs(server, target.id, stopper.id);
    expect(r.status).toBe(204);
    const approvals = server.fakeBackend.sessions
      .filter((s) => s.opts.agentId === target.id)
      .flatMap((s) => s.approvals);
    expect(approvals.map((a) => a.decision.kind)).toEqual(["deny"]);
    expect(agentOf(server, target.id).pendingPrompt).toBe(null);
  });
});

describe("agents.abort rate limit for agent callers", () => {
  it("refuses the fourth stop of one receiver inside the window with 429", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);

    const outcomes: (number | string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      await startTurn(server, target.id, stopper.id, `turn-${i}`);
      const r = await abortAs(server, target.id, stopper.id);
      outcomes.push(r.status === 204 ? 204 : r.code);
    }
    expect(outcomes).toEqual([204, 204, 204, "rate_limited"]);
    // The refused stop interrupted nothing.
    expect(agentOf(server, target.id).state).toBe("thinking");
  });

  it("shares the window with steers", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);

    await startTurn(server, target.id, stopper.id, "kickoff");
    for (let i = 0; i < 3; i++) {
      // Each steer cuts a parked turn and starts the next one.
      await waitUntil(
        () =>
          agentOf(server!, target.id).state === "thinking" &&
          agentOf(server!, target.id).queue.length === 0,
        3000,
        `turn before steer ${i}`,
      );
      const s = await post(
        server,
        `/api/agents/${target.id}/messages`,
        { bearer: getAgentTokenRaw(stopper.id)! },
        { text: `steer-${i}`, steer: true },
      );
      expect((s.body as { steered?: boolean }).steered).toBe(true);
    }
    await waitUntil(
      () => agentOf(server!, target.id).state === "thinking",
      3000,
      "turn after the steers",
    );
    const r = await abortAs(server, target.id, stopper.id);
    expect(r.status).toBe(429);
    expect(r.code).toBe("rate_limited");
  });

  it("does not count a stop that found nothing to stop", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);

    for (let i = 0; i < 3; i++) {
      const idle = await abortAs(server, target.id, stopper.id);
      expect(idle.code).toBe("nothing_to_abort");
    }
    const outcomes: (number | string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      await startTurn(server, target.id, stopper.id, `turn-${i}`);
      const r = await abortAs(server, target.id, stopper.id);
      outcomes.push(r.status === 204 ? 204 : r.code);
    }
    expect(outcomes).toEqual([204, 204, 204]);
  });

  // abort() sets its in-flight flag synchronously, so calls made in one tick
  // join the first: deterministic without timing.
  it("counts stops that join one in flight once", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);

    await startTurn(server, target.id, stopper.id, "turn-0");
    const joined = await Promise.all([
      server.agentManager.abortByAgent(target.id),
      server.agentManager.abortByAgent(target.id),
      server.agentManager.abortByAgent(target.id),
    ]);
    expect(joined.map((r) => r.ok)).toEqual([true, true, true]);

    // One slot spent above, so two more fit and the third is refused.
    const outcomes: (number | string | undefined)[] = [];
    for (let i = 1; i <= 3; i++) {
      await startTurn(server, target.id, stopper.id, `turn-${i}`);
      const r = await abortAs(server, target.id, stopper.id);
      outcomes.push(r.status === 204 ? 204 : r.code);
    }
    expect(outcomes).toEqual([204, 204, "rate_limited"]);
  });

  it("does not limit a member", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner("Boss");
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const sender = await spawnAgent(server, "Sender", r1.id);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      await startTurn(server, target.id, sender.id, `turn-${i}`);
      const r = await post(server, `/api/agents/${target.id}/abort`, {
        rawSessionId: owner.rawSessionId,
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([204, 204, 204, 204]);
  });
});

describe("the stop notice", () => {
  it("rides the target's next turn once after an agent's stop", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    await startTurn(server, target.id, stopper.id, "first");
    expect((await abortAs(server, target.id, stopper.id)).status).toBe(204);
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );

    await startTurn(server, target.id, stopper.id, "second");
    expect((await abortAs(server, target.id, stopper.id)).status).toBe(204);
    // A member's stop arms nothing, so the third turn carries no notice even
    // though its predecessor was stopped.
    const owner = await server.seedOwner("Boss");
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );
    await startTurn(server, target.id, stopper.id, "third");
    expect(
      (
        await post(server, `/api/agents/${target.id}/abort`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(204);
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );
    await startTurn(server, target.id, stopper.id, "fourth");

    const texts = sentTexts(server, target.id);
    const turn = (marker: string) => texts.find((t) => t.includes(marker))!;
    expect(turn("first")).not.toContain(AGENT_STOP_NOTE);
    expect(turn("second")).toContain(AGENT_STOP_NOTE);
    expect(turn("third")).toContain(AGENT_STOP_NOTE);
    expect(turn("fourth")).not.toContain(AGENT_STOP_NOTE);
  });

  it("keeps a member's stop unattributed when an agent joins it", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    await startTurn(server, target.id, stopper.id, "first");

    // The member's stop starts first; the agent's call joins it.
    const [member, agent] = await Promise.all([
      server.agentManager.abort(target.id),
      server.agentManager.abortByAgent(target.id),
    ]);
    expect(member.ok).toBe(true);
    expect(agent.ok).toBe(true);
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );
    await startTurn(server, target.id, stopper.id, "second");
    const second = sentTexts(server, target.id).find((t) =>
      t.includes("second"),
    )!;
    expect(second).not.toContain(AGENT_STOP_NOTE);

    // The joined call spent no slot either: three fresh stops all land.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) await startTurn(server, target.id, stopper.id, `more-${i}`);
      statuses.push((await abortAs(server, target.id, stopper.id)).status);
    }
    expect(statuses).toEqual([204, 204, 204]);
  });

  // Stops that find nothing never run abort()'s in-flight path, so both calls
  // arm before either answers. Neither may leave a note behind.
  it("leaves no note after concurrent stops that both found nothing", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const sender = await spawnAgent(server, "Sender", r1.id);
    const results = await Promise.all([
      server.agentManager.abortByAgent(target.id),
      server.agentManager.abortByAgent(target.id),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      "nothing_to_abort",
      "nothing_to_abort",
    ]);
    await startTurn(server, target.id, sender.id, "first");
    const first = sentTexts(server, target.id).find((t) =>
      t.includes("first"),
    )!;
    expect(first).not.toContain(AGENT_STOP_NOTE);
  });

  it("keeps a real note through concurrent stops that found nothing", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    await startTurn(server, target.id, stopper.id, "first");
    expect((await abortAs(server, target.id, stopper.id)).status).toBe(204);
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );
    const results = await Promise.all([
      server.agentManager.abortByAgent(target.id),
      server.agentManager.abortByAgent(target.id),
    ]);
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      "nothing_to_abort",
      "nothing_to_abort",
    ]);
    await startTurn(server, target.id, stopper.id, "second");
    const second = sentTexts(server, target.id).find((t) =>
      t.includes("second"),
    )!;
    expect(second).toContain(AGENT_STOP_NOTE);
  });

  it("rides the flush a stop starts when messages were queued", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const [r1] = server.agentManager.getRooms();
    const target = await spawnAgent(server, "Target", r1.id);
    const stopper = await spawnAgent(server, "Stopper", r1.id);
    await startTurn(server, target.id, stopper.id, "first");
    const queued = await post(
      server,
      `/api/agents/${target.id}/messages`,
      { bearer: getAgentTokenRaw(stopper.id)! },
      { text: "waiting-in-queue" },
    );
    expect((queued.body as { queued?: boolean }).queued).toBe(true);

    expect((await abortAs(server, target.id, stopper.id)).status).toBe(204);
    await waitUntil(
      () =>
        sentTexts(server!, target.id).some((t) =>
          t.includes("waiting-in-queue"),
        ),
      3000,
      "queued message flushed",
    );
    const flushed = sentTexts(server, target.id).find((t) =>
      t.includes("waiting-in-queue"),
    )!;
    expect(flushed).toContain(AGENT_STOP_NOTE);
  });
});
