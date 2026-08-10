// T1 seam tier: what happens to an agent, and to the messages queued for it,
// when its backend dies or it parks on a permission prompt.
//
// Tasks 86678675 / e8168c2a (the surfaced death message), 5dcb0a02 (recovery
// never delivers the queue) and 29daebe2 (a parked agent is invisible and abort
// is a silent no-op). All three were reported from real incidents on 2026-08-06
// and 2026-08-10, where earlyoom SIGTERM-killed several claude backends
// mid-turn.
//
// WHAT THE ORIGINAL BUGS ACTUALLY WERE, as reproduced here before the fix:
//
//   POST /send-now on an agent whose backend died returned 204 and moved
//   nothing. Every queue-flush trigger (updateState's transition hook,
//   flushQueue's own re-check, the stuck-flush watchdog, enqueueMessage's idle
//   kick) is gated on isQueueIdleState(), and `error` is not one - so the flush
//   returned immediately and the 204 was indistinguishable from a delivery.
//
//   POST /resume with the CURRENT session id - the documented dead-backend
//   recovery - DELETED the queue. resume() cleared managed.messageQueue
//   unconditionally and did it BEFORE attempting the resume, with no log entry,
//   so the messages the operator ran /resume to rescue were destroyed, and a
//   resume that then threw destroyed them for nothing.
//
//   POST /abort on an agent parked at a permission prompt returned 204 having
//   done nothing at all: the no-pendingTurn branch only acted when the state
//   was thinking/tool_executing, and a parked agent sits at
//   waiting_for_response.
//
// Seam: the real WS/HTTP harness with a FakeBackend, so the routes, the
// envelopes and the manager's state machine are all exercised. The kill is
// modelled as endStream() with no turn_completed, which is what a SIGTERM'd
// subprocess looks like to the orchestrator.

import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  await server?.stop();
  server = null;
  // stubClaudeSession repoints CLAUDE_CONFIG_DIR; put it back so a later test
  // file in the same process is unaffected.
  if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
});

// Make a resume preflight pass. createSession refuses to resume a Claude
// session whose .jsonl is missing (a real guard - it is how a moved cwd
// surfaces as a readable error instead of an opaque subprocess exit), and the
// FakeBackend never writes one. Point CLAUDE_CONFIG_DIR at the harness's own
// temp root and drop an empty file there, so nothing touches the real
// ~/.claude.
function stubClaudeSession(srv: TestServer, cwd: string, sessionId: string) {
  const configDir = join(srv.stateRoot, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const projectDir = join(
    configDir,
    "projects",
    cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "");
}

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

// A backend that parks each turn in "thinking" on send (no turn_completed), so
// a test can hold an agent mid-turn and then kill it there.
function parkingBackend(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

async function spawnAgent(srv: TestServer, name: string, roomId: string) {
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
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

function firstRoomId(srv: TestServer): string {
  const rooms = srv.agentManager.getRooms?.() ?? [];
  const room = rooms[0] as { id: string } | undefined;
  if (!room) throw new Error("no rooms");
  return room.id;
}

async function sendHuman(
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
  if (res.status >= 400) throw new Error(`sendHuman -> ${res.status}`);
}

async function postAgentMessage(
  srv: TestServer,
  receiverId: string,
  senderId: string,
  text: string,
) {
  const res = await srv.http(`/api/agents/${receiverId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAgentTokenRaw(senderId)}`,
    },
    body: JSON.stringify({ text }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// Session ids the agent has on disk, newest first - the index mode of the logs
// route, which is also what an operator reads to find the id to resume.
async function sessionIdsOf(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
): Promise<string[]> {
  const res = await srv.http(`/api/agents/${agentId}/logs`, { rawSessionId });
  const body = (await res.json()) as { sessions: { sessionId: string }[] };
  return body.sessions.map((s) => s.sessionId);
}

function logContents(srv: TestServer, agentId: string): string[] {
  return srv.agentManager.getAgentLogs(agentId).map((e) => e.content);
}

// How many times a given explanation appears in the agent's chat. One backend
// death must produce exactly ONE user-visible explained entry: the stream
// consumer writes it and then rejects the turn, and that rejection is what
// wakes the owning caller's catch, which used to write the very same sentence
// again. Two identical explanations in a row read worse than the two raw
// copies did.
function countEntries(
  srv: TestServer,
  agentId: string,
  content: string,
): number {
  return logContents(srv, agentId).filter((c) => c === content).length;
}

// agent_updated frames carrying a pendingPrompt change for this agent, in
// arrival order. `null` is a real value on the wire here (the field clears as
// an EXPLICIT null so a spread-merge on the client cannot keep a stale value),
// so this collects the key's presence rather than its truthiness.
function pendingPromptFrames(
  sock: TestSocket,
  agentId: string,
): (string | null)[] {
  return sock.messages
    .filter((m) => {
      const u = m as {
        type?: string;
        agentId?: string;
        changes?: Record<string, unknown>;
      };
      return (
        u.type === "agent_updated" &&
        u.agentId === agentId &&
        u.changes !== undefined &&
        "pendingPrompt" in u.changes
      );
    })
    .map(
      (m) =>
        (m as { changes: { pendingPrompt: string | null } }).changes
          .pendingPrompt,
    );
}

// Log entries as they were WRITTEN TO DISK, not as the in-memory cache holds
// them. The distinction is load-bearing for anything claiming an entry is
// persisted: an ephemeral entry (the permission prompt itself is one) reaches
// the cache and the WebSocket but never the .jsonl, so a cache-only assertion
// would pass even if the entry stopped being durable. Reads every session file
// the agent has, since a resume switches which one is current.
function persistedEntries(
  srv: TestServer,
  agentId: string,
): { kind: string; content: string; metadata?: Record<string, unknown> }[] {
  const dir = join(srv.stateRoot, "logs", agentId);
  if (!existsSync(dir)) return [];
  const out: {
    kind: string;
    content: string;
    metadata?: Record<string, unknown>;
  }[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A partially-flushed trailing line is not what these tests are about.
      }
    }
  }
  return out;
}

// Drive an agent to "backend died mid-turn": send, wait for the turn to be in
// flight, then end the stream without a turn_completed.
async function killBackendMidTurn(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
): Promise<void> {
  await sendHuman(srv, rawSessionId, agentId, "start a long turn");
  await waitUntil(
    () => agentOf(srv, agentId).state === "thinking",
    2000,
    "agent went busy",
  );
  const session = srv.fakeBackend.sessionForAgent(agentId);
  if (!session) throw new Error("no fake session for agent");
  session.endStream();
  await waitUntil(
    () => agentOf(srv, agentId).state === "error",
    2000,
    "agent reached error state",
  );
}

describe("backend death: what the user is told (86678675, e8168c2a)", () => {
  it("explains a SIGTERM instead of pasting the exit code", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Dying", firstRoomId(server));

    await sendHuman(server, owner.rawSessionId, a.id, "go");
    await waitUntil(() => agentOf(server!, a.id).state === "thinking");
    const session = server.fakeBackend.sessionForAgent(a.id)!;
    // What the SDK throws when earlyoom SIGTERMs the subprocess.
    session.push({
      kind: "error",
      message: "Claude Code process exited with code 143",
    });
    await waitUntil(() => agentOf(server!, a.id).state === "error");

    const entries = server.agentManager.getAgentLogs(a.id);
    const failure = entries.find((e) => e.kind === "error");
    expect(failure?.content).toBe(
      "The agent backend was terminated by SIGTERM (exit code 143). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
    );
    // The raw diagnostic is kept on the entry, just not shown as the message -
    // and kept ON DISK, which is the whole point of keeping it at all.
    expect(failure?.metadata?.backendFailureRaw).toBe(
      "Claude Code process exited with code 143",
    );
    const persistedFailure = persistedEntries(server, a.id).find(
      (e) => e.kind === "error",
    );
    expect(persistedFailure?.metadata?.backendFailureRaw).toBe(
      "Claude Code process exited with code 143",
    );
    // And the raw string is nowhere in the user-visible text.
    expect(logContents(server, a.id).join("\n")).not.toContain(
      "exited with code 143",
    );
    // Exactly ONE explained entry for the one death.
    expect(
      countEntries(
        server,
        a.id,
        "The agent backend was terminated by SIGTERM (exit code 143). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
      ),
    ).toBe(1);
  });

  it("replaces the ede_diagnostic blob on a failed turn", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Crasher", firstRoomId(server));

    await sendHuman(server, owner.rawSessionId, a.id, "go");
    await waitUntil(() => agentOf(server!, a.id).state === "thinking");
    const session = server.fakeBackend.sessionForAgent(a.id)!;
    session.push({
      kind: "turn_completed",
      status: "failed",
      error:
        "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
    });
    await waitUntil(() => agentOf(server!, a.id).state === "error");

    const failure = server.agentManager
      .getAgentLogs(a.id)
      .find((e) => e.kind === "error");
    expect(failure?.content).toBe(
      "The agent backend stopped during the turn. The conversation is saved and can be resumed.",
    );
    expect(logContents(server, a.id).join("\n")).not.toContain(
      "ede_diagnostic",
    );
  });

  it("words a bare mid-turn stream end the same way", async () => {
    // The fourth death surface: no exit code, no subtype, the stream just ends.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Vanisher", firstRoomId(server));

    await killBackendMidTurn(server, owner.rawSessionId, a.id);

    expect(
      countEntries(
        server,
        a.id,
        "The agent backend stopped during the turn. The conversation is saved and can be resumed.",
      ),
    ).toBe(1);
  });

  it("explains a death during a QUEUED FLUSH, exactly once", async () => {
    // The shape of the original incident: messages queued behind a turn, then
    // earlyoom kills the backend. The flush path has its OWN caller catch, and
    // it was still pasting the raw exit code long after the sendMessage one was
    // fixed - the humanization missed it entirely.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    // An owner has to exist before agents can be spawned, but this test drives
    // the agent-to-agent path only, so the cookie is never used.
    await server.seedOwner();
    const roomId = firstRoomId(server);
    const target = await spawnAgent(server, "FlushDies", roomId);
    const sender = await spawnAgent(server, "Sender", roomId);

    // Idle agent + agent message => the send goes through flushQueue.
    await postAgentMessage(server, target.id, sender.id, "do the thing");
    await waitUntil(
      () => agentOf(server!, target.id).state === "thinking",
      2000,
      "flush turn started",
    );
    server.fakeBackend.sessionForAgent(target.id)!.push({
      kind: "error",
      message: "Claude Code process exited with code 143",
    });
    await waitUntil(() => agentOf(server!, target.id).state === "error");

    const text =
      "The agent backend was terminated by SIGTERM (exit code 143). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.";
    expect(countEntries(server, target.id, text)).toBe(1);
    expect(logContents(server, target.id).join("\n")).not.toContain(
      "exited with code 143",
    );
    expect(logContents(server, target.id).join("\n")).not.toContain(
      "Error flushing queue:",
    );
  });
});

describe("dead-backend recovery delivers the queue (5dcb0a02)", () => {
  it("keeps queued messages when the current session is re-resumed, and flushes them", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const roomId = firstRoomId(server);
    const target = await spawnAgent(server, "Target", roomId);
    const sender = await spawnAgent(server, "Sender", roomId);

    await sendHuman(server, owner.rawSessionId, target.id, "start");
    await waitUntil(() => agentOf(server!, target.id).state === "thinking");
    // Queued behind the in-flight turn, exactly like the incident.
    const q = await postAgentMessage(
      server,
      target.id,
      sender.id,
      "please review the diff",
    );
    expect(q.body.queued).toBe(true);

    const sessionId = (
      await sessionIdsOf(server, owner.rawSessionId, target.id)
    )[0];
    stubClaudeSession(server, target.cwd, sessionId);

    // Kill the backend mid-turn.
    server.fakeBackend.sessionForAgent(target.id)!.endStream();
    await waitUntil(() => agentOf(server!, target.id).state === "error");
    expect(agentOf(server, target.id).queue).toHaveLength(1);

    // The documented recovery: resume the agent's CURRENT session.
    const res = await server.http(`/api/agents/${target.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);

    // The queue must survive the resume AND then actually deliver: the
    // error -> waiting_for_response transition fires the flush trigger.
    await waitUntil(
      () => agentOf(server!, target.id).queue.length === 0,
      3000,
      "queue flushed after recovery",
    );
    const sent = server.fakeBackend.sessionForAgent(target.id)?.sent ?? [];
    expect(sent.some((m) => m.text.includes("please review the diff"))).toBe(
      true,
    );
  });

  it("still clears the queue when resuming a DIFFERENT session, and says so", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const roomId = firstRoomId(server);
    const target = await spawnAgent(server, "Switcher", roomId);
    const sender = await spawnAgent(server, "Sender", roomId);

    // First conversation, then a fresh one, so there are two sessions on disk.
    await sendHuman(server, owner.rawSessionId, target.id, "first");
    await waitUntil(() => agentOf(server!, target.id).state === "thinking");
    server.fakeBackend.sessionForAgent(target.id)!.completeTurn();
    await waitUntil(
      () => agentOf(server!, target.id).state === "waiting_for_response",
    );
    const firstSessionId = (
      await sessionIdsOf(server, owner.rawSessionId, target.id)
    )[0];

    await server.http(`/api/agents/${target.id}/new-conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      rawSessionId: owner.rawSessionId,
    });
    await sleep(300);

    // Park it busy so an agent message queues rather than sending.
    await sendHuman(server, owner.rawSessionId, target.id, "second");
    await waitUntil(() => agentOf(server!, target.id).state === "thinking");
    await postAgentMessage(server, target.id, sender.id, "stale context");
    expect(agentOf(server, target.id).queue).toHaveLength(1);
    // Left BUSY on purpose: letting the turn finish would flush the queue
    // before the resume, and there would be nothing left to observe.

    // Switching conversations: the queued message belonged to the old one.
    stubClaudeSession(server, target.cwd, firstSessionId);
    await server.http(`/api/agents/${target.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: firstSessionId }),
      rawSessionId: owner.rawSessionId,
    });
    await sleep(400);

    // Dropped - but never silently. Asserted from the .jsonl on disk, not the
    // in-memory cache: "persisted" is the actual requirement, and an ephemeral
    // entry would satisfy a cache-only check while still vanishing on restart.
    expect(persistedEntries(server, target.id).map((e) => e.content)).toContain(
      "Cleared 1 queued message when switching to another session.",
    );
  });

  it("keeps the queue when the resume itself fails", async () => {
    // Manager predicate 2. The clear used to run BEFORE the resume was even
    // attempted, so a resume that threw destroyed the messages and left the
    // agent errored with nothing to show for it - the worst of both outcomes.
    // The failure here is the real one: createSession refuses to resume a
    // Claude session whose .jsonl is missing, and this test deliberately does
    // NOT stub one.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const roomId = firstRoomId(server);
    const target = await spawnAgent(server, "ResumeFails", roomId);
    const sender = await spawnAgent(server, "Sender", roomId);

    await sendHuman(server, owner.rawSessionId, target.id, "start");
    await waitUntil(() => agentOf(server!, target.id).state === "thinking");
    await postAgentMessage(server, target.id, sender.id, "must survive");
    const sessionId = (
      await sessionIdsOf(server, owner.rawSessionId, target.id)
    )[0];
    server.fakeBackend.sessionForAgent(target.id)!.endStream();
    await waitUntil(() => agentOf(server!, target.id).state === "error");
    expect(agentOf(server, target.id).queue).toHaveLength(1);

    await server.http(`/api/agents/${target.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      rawSessionId: owner.rawSessionId,
    });
    await sleep(400);

    // The resume failed...
    expect(logContents(server, target.id).join("\n")).toContain(
      "Failed to resume:",
    );
    // ...and took nothing with it. The message is still deliverable.
    expect(agentOf(server, target.id).queue).toHaveLength(1);
    expect(agentOf(server, target.id).queue[0]?.text).toBe("must survive");
    // No clear entry was written, in the cache or on disk.
    for (const content of [
      ...logContents(server, target.id),
      ...persistedEntries(server, target.id).map((e) => e.content),
    ]) {
      expect(content).not.toContain("queued message");
    }
  });

  it("send-now on a dead-backend agent refuses instead of answering 204", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const roomId = firstRoomId(server);
    const target = await spawnAgent(server, "Wedged", roomId);
    const sender = await spawnAgent(server, "Sender", roomId);

    await sendHuman(server, owner.rawSessionId, target.id, "start");
    await waitUntil(() => agentOf(server!, target.id).state === "thinking");
    await postAgentMessage(server, target.id, sender.id, "urgent");
    server.fakeBackend.sessionForAgent(target.id)!.endStream();
    await waitUntil(() => agentOf(server!, target.id).state === "error");

    const res = await server.http(`/api/agents/${target.id}/send-now`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("agent_error");
    expect(body.error.message).toBe(
      "The agent's backend is not running, so queued messages cannot be delivered. Resume the agent's current session first; the queue is kept and delivers on resume.",
    );

    // A refusal is not a recovery: nothing was delivered, and the agent was
    // NOT quietly revived (that policy is task 64b36bee and stays unsettled).
    await sleep(200);
    expect(agentOf(server, target.id).queue).toHaveLength(1);
    expect(agentOf(server, target.id).state).toBe("error");
  });
});

describe("prompt-parked agents are visible and stoppable (29daebe2)", () => {
  async function parkOnPermission(
    srv: TestServer,
    rawSessionId: string,
    agentId: string,
  ) {
    await sendHuman(srv, rawSessionId, agentId, "run something");
    await waitUntil(() => agentOf(srv, agentId).state === "thinking");
    srv.fakeBackend.sessionForAgent(agentId)!.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/x" },
      title: "Claude wants to use Bash",
    });
    await waitUntil(
      () => agentOf(srv, agentId).pendingPrompt === "permission",
      2000,
      "agent parked on a permission prompt",
    );
  }

  it("reports the parked state on the agent roster without leaking the prompt", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Parked", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    // The state that used to be indistinguishable from a dead backend.
    expect(agentOf(server, a.id).state).toBe("waiting_for_response");
    expect(agentOf(server, a.id).pendingPrompt).toBe("permission");

    const res = await server.http("/agents", {
      rawSessionId: owner.rawSessionId,
    });
    const roster = (await res.json()) as {
      id: string;
      pendingPrompt: string | null;
    }[];
    const entry = roster.find((r) => r.id === a.id);
    expect(entry?.pendingPrompt).toBe("permission");
    // The KIND only. The tool name and the command must not ride along.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("Bash");
    expect(serialized).not.toContain("rm -rf");
  });

  it("pushes the parked state over the wire, and clears it explicitly", async () => {
    // Manager predicate 5 across the two live wire paths: the incremental
    // agent_updated that keeps an already-connected client current, and the
    // full_state a reconnecting one gets.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Parked", firstRoomId(server));

    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");
    await parkOnPermission(server, owner.rawSessionId, a.id);
    await waitUntil(
      () => pendingPromptFrames(sock, a.id).includes("permission"),
      2000,
      "agent_updated announced the prompt",
    );

    // A reconnecting client sees it too - full_state derives the live value
    // rather than replaying whatever the last incremental frame said.
    const sock2 = await server.connectWs(owner.rawSessionId);
    const full = (await sock2.waitFor("full_state")) as {
      agents: { id: string; pendingPrompt?: string | null }[];
    };
    expect(full.agents.find((x) => x.id === a.id)?.pendingPrompt).toBe(
      "permission",
    );
    // Still only the kind: no prompt text, tool name or command on the wire.
    const wire = JSON.stringify(full.agents.find((x) => x.id === a.id));
    expect(wire).not.toContain("Bash");
    expect(wire).not.toContain("rm -rf");

    // Answering it must clear the field as an EXPLICIT null: JSON.stringify
    // drops undefined-valued keys, so an undefined clear would vanish in
    // serialization and the client's spread-merge would keep "permission".
    await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    await waitUntil(
      () => pendingPromptFrames(sock, a.id).at(-1) === null,
      2000,
      "agent_updated cleared the prompt",
    );
    expect(pendingPromptFrames(sock, a.id)).toEqual(["permission", null]);
    sock.close();
    sock2.close();
  });

  it("reports the parked state on the logs API, where the prompt itself never lands", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Parked", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    const sessionId = (await sessionIdsOf(server, owner.rawSessionId, a.id))[0];
    const res = await server.http(
      `/api/agents/${a.id}/logs?session=${sessionId}&tier=full`,
      { rawSessionId: owner.rawSessionId },
    );
    const body = (await res.json()) as {
      pendingPrompt: string | null;
      entries: { content: string }[];
    };

    // The prompt is written as an EPHEMERAL log entry, so it is genuinely not
    // in the transcript - which is exactly why the live field has to be here.
    expect(body.entries.map((e) => e.content).join("\n")).not.toContain(
      "Wants to use",
    );
    expect(body.pendingPrompt).toBe("permission");
  });

  it("does not disclose the parked state to a caller who cannot read the agent", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const outsider = await server.seedMember("Outsider");
    const a = await spawnAgent(server, "Parked", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    // The field inherits the route's existing boundary: a caller without room
    // access never gets a body to read it from.
    const res = await server.http(`/api/agents/${a.id}/logs`, {
      rawSessionId: outsider.rawSessionId,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("permission");
  });

  it("abort denies the pending prompt and unparks the agent", async () => {
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Parked", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    const session = server.fakeBackend.sessionForAgent(a.id)!;
    const res = await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);

    // The backend's approval callback was resolved as a denial - without this
    // the SDK's canUseTool promise never settles and the agent stays parked.
    expect(session.approvals).toContainEqual({
      approvalId: "ap-1",
      decision: { kind: "deny", reason: "The operator stopped the agent." },
    });
    await waitUntil(
      () => agentOf(server!, a.id).pendingPrompt === null,
      2000,
      "agent unparked",
    );
    expect(logContents(server, a.id)).toContain(
      "Agent interrupted; the pending permission request was denied.",
    );
  });

  it("abort unparks an agent still parked after its backend died", async () => {
    // The branch that produced the reported silent 204: no pendingTurn (the
    // mid-turn death rejected it) and a state of `error` rather than a busy
    // one, so the old code returned having done nothing while pendingPermission
    // stayed set - and an agent in a multi-step flow is skipped by every queue
    // trigger, so it stayed wedged.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "ParkedThenDead", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    server.fakeBackend.sessionForAgent(a.id)!.endStream();
    await waitUntil(
      () => agentOf(server!, a.id).state === "error",
      2000,
      "backend death observed",
    );
    // Still parked: nothing cleared the prompt.
    expect(agentOf(server, a.id).pendingPrompt).toBe("permission");

    const res = await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(agentOf(server, a.id).pendingPrompt).toBe(null);
    expect(logContents(server, a.id)).toContain(
      "Agent interrupted; the pending permission request was denied.",
    );
  });

  it("does not claim success when the backend refuses the denial", async () => {
    // The false-success hole: clearing our own pointer is not a stop. If
    // approve() fails the backend may still be sitting inside canUseTool, so
    // the only thing that really ends the call is tearing the session down.
    // Returning 204 after merely hiding the prompt locally would be the same
    // class of lie this batch exists to remove.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "RefusesDenial", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);

    // Make the session replacement VIABLE, so this test deterministically
    // exercises the recovered branch (the sibling test below covers the case
    // where the replacement also fails). Without the stub, abort's slow path
    // resumes the current session and createSession throws on the missing
    // .jsonl, and this would silently become a second copy of that test.
    const sessionId = (await sessionIdsOf(server, owner.rawSessionId, a.id))[0];
    stubClaudeSession(server, a.cwd, sessionId);
    const parkedSession = server.fakeBackend.sessionForAgent(a.id)!;
    parkedSession.approveError = new Error("backend refused the decision");
    // Settle the turn while the prompt is STILL pending: that leaves the agent
    // parked with a live session but no pendingTurn, which is the branch under
    // test (the main path's replacement never runs there). Ending the stream
    // instead would null the session, and the helper would report "gone" - the
    // approval failure would never be reached.
    parkedSession.push({ kind: "turn_completed", status: "completed" });
    await waitUntil(
      () => agentOf(server!, a.id).state === "waiting_for_response",
      2000,
      "turn settled with the prompt still pending",
    );

    const res = await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });

    // The replacement succeeds here (the fake backend starts a fresh session
    // happily), so this asserts exactly that branch: a real teardown, not a
    // 204 over an untouched session with the prompt still live in the backend.
    expect(res.status).toBe(204);
    expect(server.fakeBackend.sessionForAgent(a.id)).not.toBe(parkedSession);
    expect(agentOf(server, a.id).pendingPrompt).toBe(null);
    // The entry has to name what actually happened. approve() was refused, so
    // claiming the request "was denied" would be false even though the abort
    // succeeded by another route.
    expect(logContents(server, a.id)).toContain(
      "Agent interrupted; the pending permission request could not be denied, so the agent session was replaced.",
    );
    expect(logContents(server, a.id)).not.toContain(
      "Agent interrupted; the pending permission request was denied.",
    );
  });

  it("reports 500 when neither the denial nor the replacement can end the prompt", async () => {
    // The MAIN branch (a live pendingTurn). approve() is refused AND the
    // session replacement fails, so nothing ended the prompt - the backend may
    // still be inside canUseTool. Claiming success here would be the same lie
    // as the original silent 204, just later in the path.
    //
    // The replacement is made to fail the honest way: abort's slow path resumes
    // the agent's current session, and createSession refuses to resume a Claude
    // session whose .jsonl is missing. No stub is written, so it throws.
    server = await startTestServer({ fakeBackend: parkingBackend() });
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "NoWayOut", firstRoomId(server));
    await parkOnPermission(server, owner.rawSessionId, a.id);
    // Parked with the turn STILL in flight - no turn_completed - so abort takes
    // the pendingTurn path.
    server.fakeBackend.sessionForAgent(a.id)!.approveError = new Error(
      "backend refused the decision",
    );

    const res = await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("abort_failed");
    expect(body.error.message).toBe(
      "The pending permission request could not be resolved and the agent's session could not be replaced.",
    );
    // And it must NOT have claimed the denial landed.
    expect(logContents(server, a.id)).not.toContain(
      "Agent interrupted; the pending permission request was denied.",
    );
  });

  it("abort on an agent with nothing to stop returns an honest error", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner();
    const a = await spawnAgent(server, "Idle", firstRoomId(server));

    const res = await server.http(`/api/agents/${a.id}/abort`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("nothing_to_abort");
    expect(body.error.message).toBe(
      "The agent is not running a turn, so there is nothing to stop.",
    );
  });
});
