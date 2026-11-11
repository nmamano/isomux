// The agent's failure record end to end (task ddf02829): a failed turn sets
// AgentInfo.failure with the turn's own error text and its starters, the
// wire carries it (and its clear, as an explicit null), it survives the
// restart that brings the agent back idle, and the next turn clears it.
//
// Seam: the real WS/HTTP harness with a FakeBackend, so the manager's state
// machine, the persistence and the snapshot are the production ones. The
// decision itself (nextFailure) has its own table in server/agent-failure.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import type { AgentFailure, AgentInfo } from "../../shared/types.ts";

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
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// "fail <x>" ends the turn failed with error <x>; "park" holds the turn open
// (a permission prompt is pushed by the test); anything else completes.
function scriptedBackend(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (text, _a, s) => {
        const fail = /fail (\S+)/.exec(text);
        if (fail) s.completeTurn({ status: "failed", error: fail[1] });
        else if (text.includes("park"))
          s.push({ kind: "assistant_text", text: "..." });
        else s.completeTurn({ text: "ok" });
      },
    },
  });
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

async function spawnAgent(srv: TestServer): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const info = await srv.agentManager.spawn(
    "Failer",
    srv.workDir,
    "default",
    undefined,
    undefined,
    room.id,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
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

// An errored Claude agent resumes its session on the next message, and the
// Claude backend refuses a resume without the session file.
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

// The agent_updated changes for one agent that name `failure`, in order.
function failureUpdates(
  sock: TestSocket,
  agentId: string,
): (AgentFailure | null | undefined)[] {
  const out: (AgentFailure | null | undefined)[] = [];
  for (const m of sock.messages as Record<string, unknown>[]) {
    if (m.type !== "agent_updated" || m.agentId !== agentId) continue;
    const changes = m.changes as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(changes, "failure"))
      out.push(changes.failure as AgentFailure | null);
  }
  return out;
}

async function failTurn(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
  error: string,
): Promise<AgentFailure> {
  await sendHuman(srv, rawSessionId, agentId, `fail ${error}`);
  await waitUntil(() => agentOf(srv, agentId).state === "error", "errored");
  const failure = agentOf(srv, agentId).failure;
  if (!failure) throw new Error("no failure record after the failed turn");
  return failure;
}

describe("the agent failure record", () => {
  it("records a failed turn with its text and its starter, broadcasts it, and keeps it across a restart that brings the agent back idle", async () => {
    server = await startTestServer({ fakeBackend: scriptedBackend() });
    const owner = await server.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");
    const a = await spawnAgent(server);
    expect(agentOf(server, a.id).failure ?? null).toBeNull();

    const before = Date.now();
    const failure = await failTurn(server, owner.rawSessionId, a.id, "boom-1");
    expect(failure.content).toContain("boom-1");
    expect(failure.memberIds).toEqual([ownerId]);
    expect(failure.since).toBeGreaterThanOrEqual(before);
    expect(failure.since).toBeLessThanOrEqual(Date.now());
    await waitUntil(
      () => failureUpdates(sock, a.id).length > 0,
      "failure broadcast",
    );
    expect(failureUpdates(sock, a.id).at(-1)).toEqual(failure);
    sock.close();

    // The restart brings every agent back without state error, which is
    // exactly why the record is persisted.
    server = await server.restart();
    const restored = agentOf(server, a.id);
    expect(restored.state).not.toBe("error");
    expect(restored.failure).toEqual(failure);
    // A browser that connects after the restart gets it in the snapshot.
    const fresh = await server.connectWs(owner.rawSessionId);
    const snap = await fresh.waitFor("full_state");
    const wired = (snap.agents as AgentInfo[]).find((x) => x.id === a.id);
    expect(wired?.failure).toEqual(failure);
    fresh.close();
  });

  it("clears at the next turn, sends the clear as an explicit null, and the clear survives a restart", async () => {
    server = await startTestServer({ fakeBackend: scriptedBackend() });
    const owner = await server.seedOwner("Morgan");
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");
    const a = await spawnAgent(server);
    const failure = await failTurn(server, owner.rawSessionId, a.id, "boom-1");
    stubClaudeSession(
      server,
      a.cwd,
      server.fakeBackend.sessionForAgent(a.id)!.sessionId,
    );

    await sendHuman(server, owner.rawSessionId, a.id, "hello again");
    await waitUntil(
      () =>
        agentOf(server!, a.id).state !== "error" &&
        (agentOf(server!, a.id).failure ?? null) === null,
      "failure cleared by the next turn",
    );
    // JSON drops an undefined: only an explicit null clears the browser's copy.
    await waitUntil(
      () => failureUpdates(sock, a.id).at(-1) === null,
      "explicit null on the wire",
    );
    expect(failureUpdates(sock, a.id)).toEqual([failure, null]);
    sock.close();

    server = await server.restart();
    expect(agentOf(server, a.id).failure ?? null).toBeNull();
  });

  // A failed permission answer writes its text as an ephemeral entry, not
  // through the log: the record must carry that text, not the error of an
  // earlier turn.
  it("takes a failed permission answer's own text, never an earlier turn's error", async () => {
    server = await startTestServer({ fakeBackend: scriptedBackend() });
    const owner = await server.seedOwner("Morgan");
    const a = await spawnAgent(server);
    const first = await failTurn(server, owner.rawSessionId, a.id, "boom-old");
    stubClaudeSession(
      server,
      a.cwd,
      server.fakeBackend.sessionForAgent(a.id)!.sessionId,
    );

    await sendHuman(server, owner.rawSessionId, a.id, "park please");
    await waitUntil(
      () => agentOf(server!, a.id).state === "thinking",
      "next turn started",
    );
    // The turn start cleared the old failure.
    expect(agentOf(server, a.id).failure ?? null).toBeNull();
    const session = server.fakeBackend.sessionForAgent(a.id)!;
    session.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "Claude wants to use Bash",
    });
    await waitUntil(
      () => agentOf(server!, a.id).pendingPrompt === "permission",
      "parked on a permission prompt",
    );
    session.approveError = new Error("backend-refused-the-decision");
    const interaction = server.agentManager
      .getPendingInteractions()
      .find((i) => i.agentId === a.id);
    if (!interaction) throw new Error("no permission interaction");
    await server.http(
      `/api/agents/${a.id}/interactions/${interaction.id}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: interaction.choices[0].value }),
        rawSessionId: owner.rawSessionId,
      },
    );
    await waitUntil(
      () => agentOf(server!, a.id).state === "error",
      "the failed answer put the agent in error",
    );
    const second = agentOf(server, a.id).failure;
    expect(second).toBeTruthy();
    expect(second!.content).toContain("backend-refused-the-decision");
    expect(second!.content).not.toContain("boom-old");
    expect(second!.since).toBeGreaterThan(first.since);
  });
});

// The Inbox permission card is answered away from the chat, so its
// interaction carries what the request is for (task ddf02829): the
// backend's reason and the tool input, redacted as log text is. Each
// engine's shape: Claude and Codex send a Bash command, OpenCode sends the
// permission's patterns.
describe("the permission interaction's facts", () => {
  const SECRET = "sk_live_abcdefghijklmnopqrstuvwxyz0123456789";
  async function parkWith(
    srv: TestServer,
    rawSessionId: string,
    agentId: string,
    request: {
      toolName: string;
      input: Record<string, unknown>;
      description?: string;
    },
  ) {
    await sendHuman(srv, rawSessionId, agentId, "park please");
    await waitUntil(
      () => agentOf(srv, agentId).state === "thinking",
      "turn started",
    );
    srv.fakeBackend.sessionForAgent(agentId)!.push({
      kind: "approval_request",
      approvalId: "ap-facts",
      title: `wants to use ${request.toolName}`,
      ...request,
    });
    await waitUntil(
      () => agentOf(srv, agentId).pendingPrompt === "permission",
      "parked on a permission prompt",
    );
    const interaction = srv.agentManager
      .getPendingInteractions()
      .find((i) => i.agentId === agentId);
    if (!interaction) throw new Error("no permission interaction");
    return interaction;
  }

  it("carries the reason and the command, redacted, in the state and on the wire", async () => {
    server = await startTestServer({ fakeBackend: scriptedBackend() });
    const owner = await server.seedOwner("Morgan");
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("full_state");
    const a = await spawnAgent(server);
    const interaction = await parkWith(server, owner.rawSessionId, a.id, {
      toolName: "Bash",
      input: { command: `npm publish && API_KEY=${SECRET} deploy` },
      // The backend's reason is free text: it can quote a secret too.
      description: `Publish the package with API_KEY=${SECRET}`,
    });
    expect(interaction.kind).toBe("permission");
    const facts = interaction.permission;
    expect(facts?.description).toContain("Publish the package with API_KEY=");
    expect(facts?.input.command).toContain("npm publish");
    expect(facts?.input.command).toContain("deploy");
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    const added = (sock.messages as Record<string, unknown>[]).find(
      (m) =>
        m.type === "interaction_added" &&
        (m.interaction as { id?: string }).id === interaction.id,
    );
    expect(
      (added?.interaction as { permission?: unknown } | undefined)?.permission,
    ).toEqual(facts);
    sock.close();
  });

  it("carries an OpenCode permission's patterns", async () => {
    server = await startTestServer({ fakeBackend: scriptedBackend() });
    const owner = await server.seedOwner("Morgan");
    const a = await spawnAgent(server);
    const interaction = await parkWith(server, owner.rawSessionId, a.id, {
      toolName: "bash",
      input: { patterns: ["git push origin main", "rm -rf build"] },
    });
    const shown = Object.values(interaction.permission?.input ?? {}).join("\n");
    expect(shown).toContain("git push origin main");
    expect(shown).toContain("rm -rf build");
  });
});
