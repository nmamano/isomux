// Self-handoff REST contract (task 8883e45d).
//
// HTTP-contract layer for POST /api/agents/:id/handoff - the instant self-handoff
// that replaces the old deliverAt + separate new-conversation dance. Runs through
// the REAL auth + /api executor + production persistence (temp STATE_ROOT), and
// reads the coalesced prompt off the FakeBackend to pin the self-handoff flush
// prefix ("[Handoff from your previous session]", no reply-to-self preamble).
//
// The endpoint resets the session (reuses newConversation, which WIPES the queue)
// and then enqueues the brief into the now-fresh session; because the enqueue
// happens AFTER the reset, the queue-clear can't drop the brief. These tests pin:
//   - delivery + the self-handoff prefix + auth split + body validation;
//   - CONCURRENCY (review REQUEST-CHANGES follow-up): a concurrent second
//     handoff is rejected with 409 (the running one keeps its honest guarantee),
//     an inbound message during a BLOCKED reset drain doesn't lose the brief, and
//     a forced durable-write failure returns a real HTTP error instead of a false
//     {ok:true}.
// The privileged-AGENT reach is pinned at the guard level in
// routes-privileged-auth.test.ts.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
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

// A backend that parks each turn in "thinking" on send (no turn_completed),
// mirroring queue-reliability's helper. hangOnClose wedges close() so a reset's
// drain blocks until the test releases the session via endStream().
function parkingBackend(extra?: { hangOnClose?: boolean }): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      ...extra,
    },
  });
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

interface Res {
  status: number;
  body: { ok?: boolean; error?: { code: string; message?: string } };
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

async function setup(fakeBackend?: FakeBackend) {
  const srv = await startTestServer(fakeBackend ? { fakeBackend } : undefined);
  const owner = await srv.seedOwner("Nil");
  const room = srv.agentManager.getRooms()[0];
  const a = await spawnAgent(srv, "AgentA", room.id);
  const b = await spawnAgent(srv, "AgentB", room.id);
  return { srv, owner, room, a, b };
}

// Sessions belonging to an agent across resets (newest last), and the count of
// individual sends whose text contains `needle` across all of them.
const sessionsFor = (srv: TestServer, id: string): FakeSession[] =>
  srv.fakeBackend.sessions.filter((s) => s.opts.agentId === id);
const deliveryCount = (srv: TestServer, id: string, needle: string): number =>
  sessionsFor(srv, id).reduce(
    (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
    0,
  );
const agentOf = (srv: TestServer, id: string): AgentInfo =>
  srv.agentManager.getAllAgents().find((x) => x.id === id)!;
const firstPrompt = (srv: TestServer, id: string): string =>
  srv.fakeBackend.sessionForAgent(id)!.sent[0].text;

describe("agents.handoff REST - delivery + self-handoff flush prefix", () => {
  it("delivers the brief into a FRESH session, prefixed as a handoff (no reply-to-self)", async () => {
    const { srv, a } = await setup();
    server = srv;
    const brief = "Finish wiring the widget; the parser is stubbed in foo.ts.";

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: brief },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The reset + enqueue are one server-side op; wait for the fresh session to
    // receive the brief. It arrives despite newConversation clearing the queue,
    // because the enqueue runs AFTER the reset.
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
      2000,
      "fresh session received the handoff brief",
    );
    const prompt = firstPrompt(srv, a.id);
    // Self-handoff prefix renders, and the brief text is carried through.
    expect(prompt).toContain(`[Handoff from your previous session] ${brief}`);
    // No sender-id preamble - the fresh copy has nobody to reply to.
    expect(prompt).not.toContain("(agent id:");
  });

  it("a user operator may hand off a reachable agent (brief still self-prefixed)", async () => {
    const { srv, owner, a } = await setup();
    server = srv;
    const brief = "Continue the migration from step 3.";

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { rawSessionId: owner.rawSessionId },
      { text: brief },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
      2000,
      "operator handoff delivered",
    );
    // Even when a user triggers it, the brief is delivered as the agent's own
    // handoff from its previous session.
    expect(firstPrompt(srv, a.id)).toContain(
      `[Handoff from your previous session] ${brief}`,
    );
  });
});

describe("agents.handoff REST - auth split (conversationReset)", () => {
  it("an ordinary agent may hand off ITSELF", async () => {
    const { srv, a } = await setup();
    server = srv;
    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: "carry on" },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("an ordinary agent is FORBIDDEN (403) handing off another agent", async () => {
    const { srv, a, b } = await setup();
    server = srv;
    const res = await call(
      srv,
      "POST",
      `/api/agents/${b.id}/handoff`,
      { agentId: a.id },
      { text: "not yours" },
    );
    expect(res.status).toBe(403);
    // The target was never touched.
    expect(srv.fakeBackend.sessionForAgent(b.id)?.sent.length ?? 0).toBe(0);
  });
});

describe("agents.handoff REST - body validation", () => {
  it("empty text -> 422 invalid_text; the agent is untouched", async () => {
    const { srv, a } = await setup();
    server = srv;
    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: "" },
    );
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("invalid_text");
    expect(srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0).toBe(0);
  });

  it("missing text -> 422 invalid_text", async () => {
    const { srv, a } = await setup();
    server = srv;
    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      {},
    );
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("invalid_text");
  });
});

// --- Concurrency + failure honesty (review REQUEST-CHANGES follow-up) --------

describe("agents.handoff REST - concurrency and failure honesty", () => {
  it("rejects a concurrent handoff with 409 handoff_in_progress: the winner delivers, the loser is told (no false success)", async () => {
    // Hold the winner's reset open (wedged drain) so a second handoff genuinely
    // overlaps it. Chaining the second would let its reset clear the winner's
    // just-enqueued brief - a false 200 for a brief that then vanished; instead
    // the second is rejected 409 and the winner keeps the honest guarantee.
    const { srv, owner, a, b } = await setup(
      parkingBackend({ hangOnClose: true }),
    );
    server = srv;
    srv.agentManager._testSetConsumerDrainTimeout(300);

    // Give A a LIVE session so the winner's reset actually blocks on a drain.
    await call(
      srv,
      "POST",
      `/api/agents/${a.id}/messages`,
      { agentId: b.id },
      { text: "kickoff" },
    );
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
      2000,
      "A has a live session",
    );
    const oldSession = srv.fakeBackend.sessionForAgent(a.id)!;
    oldSession.completeTurn();
    await waitUntil(
      () => agentOf(srv, a.id).state !== "thinking",
      2000,
      "A idle",
    );

    const winnerBrief = "HANDOFF-WINNER: keep going from here.";
    const loserBrief = "HANDOFF-LOSER: should be rejected.";

    // Winner enters the critical section and blocks on the wedged drain.
    const winnerP = call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: winnerBrief },
    );
    await waitUntil(
      () => agentOf(srv, a.id).dormant === true,
      2000,
      "winner reset draining",
    );
    // A second handoff during that window is rejected, not chained.
    const loser = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { rawSessionId: owner.rawSessionId },
      { text: loserBrief },
    );
    expect(loser.status).toBe(409);
    expect(loser.body.error?.code).toBe("handoff_in_progress");

    const winner = await winnerP;
    expect(winner.status).toBe(200);
    expect(winner.body.ok).toBe(true);
    oldSession.endStream();

    // The winner's brief is delivered, prefixed as a handoff.
    await waitUntil(
      () => deliveryCount(srv, a.id, winnerBrief) >= 1,
      3000,
      "winner brief delivered",
    );
    expect(firstPrompt(srv, a.id)).toContain(
      `[Handoff from your previous session] ${winnerBrief}`,
    );
    // The rejected caller's brief was never enqueued - no phantom delivery.
    expect(deliveryCount(srv, a.id, loserBrief)).toBe(0);
    expect(agentOf(srv, a.id).state).not.toBe("error");
  });

  it("an inbound message during a BLOCKED reset drain does not lose the brief", async () => {
    // hangOnClose wedges the old session's close(), so the reset's drain blocks
    // until we release it - a real window for an inbound message to wake a fresh
    // session and become its first turn. The brief must still be delivered.
    const { srv, owner, a, b } = await setup(
      parkingBackend({ hangOnClose: true }),
    );
    server = srv;
    srv.agentManager._testSetConsumerDrainTimeout(200);

    // Give A a LIVE session (so the handoff's reset actually has one to drain).
    await call(
      srv,
      "POST",
      `/api/agents/${a.id}/messages`,
      { agentId: b.id },
      { text: "kickoff" },
    );
    await waitUntil(
      () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
      2000,
      "A has a live session",
    );
    const oldSession = srv.fakeBackend.sessionForAgent(a.id)!;
    oldSession.completeTurn();

    const brief = "HANDOFF-BRIEF: keep going from here.";
    // Fire the handoff but DON'T await - it will block on the wedged drain.
    const handoffP = call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { rawSessionId: owner.rawSessionId },
      { text: brief },
    );
    // Once the reset has released the old session (dormant), an inbound message
    // races in during the still-blocked drain.
    await waitUntil(
      () => agentOf(srv, a.id).dormant === true,
      2000,
      "reset drain started",
    );
    await call(
      srv,
      "POST",
      `/api/agents/${a.id}/messages`,
      { agentId: b.id },
      { text: "mid-drain" },
    );

    const res = await handoffP;
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Release the wedged old session so nothing hangs on teardown.
    oldSession.endStream();

    // parkingBackend never auto-completes a turn, so a queued message only
    // flushes once the turn ahead of it finishes. Complete parked turns until
    // BOTH the racing message and the brief have been delivered - the brief is
    // queued behind the racing message if it lost the first slot, but never
    // dropped.
    const deadline = Date.now() + 3000;
    for (;;) {
      const gotBrief = deliveryCount(srv, a.id, brief) >= 1;
      const gotMid = deliveryCount(srv, a.id, "mid-drain") >= 1;
      if (gotBrief && gotMid) break;
      if (Date.now() > deadline) {
        throw new Error(
          `brief not delivered under drain race (brief=${gotBrief}, mid-drain=${gotMid})`,
        );
      }
      const cur = srv.fakeBackend.sessionForAgent(a.id);
      if (cur && agentOf(srv, a.id).state === "thinking") cur.completeTurn();
      await sleep(15);
    }
  });

  it("a forced durable-write failure returns 500 persist_failed, not a false success", async () => {
    const { srv, a } = await setup();
    server = srv;

    // Make the transactional queue persist fail: atomicWriteFileSync renames
    // onto message-queues.json, which can't succeed while it's a non-empty
    // DIRECTORY (same lever as queue-reliability's persist-failure test).
    const storePath = join(srv.stateRoot, "message-queues.json");
    mkdirSync(storePath);
    writeFileSync(join(storePath, "keep"), "x");

    const res = await call(
      srv,
      "POST",
      `/api/agents/${a.id}/handoff`,
      { agentId: a.id },
      { text: "brief that cannot persist" },
    );
    expect(res.status).toBe(500);
    expect(res.body.error?.code).toBe("persist_failed");
    // No brief was delivered - the failure was surfaced, not masked.
    expect(deliveryCount(srv, a.id, "brief that cannot persist")).toBe(0);

    // Unblock the disk so teardown's persistence doesn't choke.
    rmSync(storePath, { recursive: true, force: true });
  });
});
