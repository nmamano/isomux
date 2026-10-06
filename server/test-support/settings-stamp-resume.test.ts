// T1 seam tier: a settings change must reach a later resume of the same
// session (task a987d05b).
//
// THE BUG, as reproduced before the fix (2026-10-06, real OpenCode server and a
// mock provider): an OpenCode agent on a model the provider refuses goes to
// `error`. A model edit replaces its session, but the session's stored engine
// config is written only at system_init, which OpenCode reports at the first
// send. An agent message then auto-resumes the errored agent, the resume reads
// the stale stored config and puts the old model back into the agent record,
// and every later turn (also after a new conversation) runs the old model.
//
// Seam: the real harness with a FakeBackend whose sessions report system_init
// at their first send, as OpenCode and Claude do.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getSessionEngineConfig } from "../persistence.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  await server?.stop();
  server = null;
  if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
});

const REFUSED = "gate/refused-model";
const GOOD = "gate/good-model";
// The Claude agent's refused model.
const CLAUDE_REFUSED = "opus";

// Sessions report system_init at their first send, not at creation (OpenCode
// and Claude both do). A turn on a refused model fails as a provider refusal
// does; any other model completes.
function lazyInitBackend(): FakeBackend {
  const initialized = new WeakSet<FakeSession>();
  return new FakeBackend({
    session: {
      autoSystemInit: false,
      onSend: (_text, _attachments, session) => {
        if (!initialized.has(session)) {
          initialized.add(session);
          session.push({
            kind: "system_init",
            sessionId: session.sessionId,
            slashCommands: [],
          });
        }
        const model = session.opts.modelFamily;
        if (model === REFUSED || model === CLAUDE_REFUSED) {
          session.completeTurn({ status: "failed", error: "refused" });
        } else {
          session.completeTurn({ text: "ok" });
        }
      },
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = 3000,
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

function firstRoomId(srv: TestServer): string {
  const room = srv.agentManager.getRooms()[0] as { id: string } | undefined;
  if (!room) throw new Error("no rooms");
  return room.id;
}

// A Claude resume needs the session's .jsonl. Point CLAUDE_CONFIG_DIR at the
// harness's temp root and drop an empty file there.
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

async function spawn(
  srv: TestServer,
  agentType: "opencode" | "codex" | "claude",
  modelFamily: string,
  effort: AgentInfo["effort"],
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    `Stamp ${agentType}`,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    firstRoomId(srv),
    undefined,
    modelFamily,
    effort,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

function latestSession(srv: TestServer, agentId: string): FakeSession {
  const session = srv.fakeBackend.sessionForAgent(agentId);
  if (!session) throw new Error("no fake session for agent");
  return session;
}

// One member turn; returns the session id it reported.
async function runTurn(
  srv: TestServer,
  agentId: string,
  endState: AgentInfo["state"],
): Promise<string> {
  await srv.agentManager.sendMessage(agentId, "hello", "tester");
  await waitUntil(
    () => agentOf(srv, agentId).state === endState,
    `agent reached ${endState}`,
  );
  return latestSession(srv, agentId).sessionId;
}

// The /model and /effort two-step: open the card, then pick by value.
async function pickChoice(
  srv: TestServer,
  agentId: string,
  command: "/model" | "/effort",
  value: string,
): Promise<void> {
  await srv.agentManager.sendMessage(agentId, command, "tester");
  const interaction = srv.agentManager
    .getPendingInteractions()
    .find((i) => i.agentId === agentId);
  if (!interaction) throw new Error(`${command} opened no choice`);
  const index = interaction.choices.findIndex((c) => c.value === value);
  expect(index).toBeGreaterThanOrEqual(0);
  await srv.agentManager.sendMessage(agentId, String(index + 1), "tester");
}

describe("a settings change reaches a resume of the same session (a987d05b)", () => {
  // Errored session, model and effort edit, then an agent message: the
  // auto-resume must run the edited settings.
  async function erroredAutoResume(
    agentType: "opencode" | "claude",
    refused: string,
    good: string,
  ): Promise<void> {
    server = await startTestServer({ fakeBackend: lazyInitBackend() });
    await server.seedOwner();
    const agent = await spawn(server, agentType, refused, "high");
    const sessionId = await runTurn(server, agent.id, "error");
    if (agentType === "claude") stubClaudeSession(server, agent.cwd, sessionId);
    expect(getSessionEngineConfig(agent.id, sessionId)).toMatchObject({
      modelFamily: refused,
      effort: "high",
    });

    await server.agentManager.editAgent(agent.id, {
      modelFamily: good,
      effort: "low",
    });
    expect(agentOf(server, agent.id).state).toBe("error");

    const resumesBefore = server.fakeBackend.resumeSessionCount;
    const sent = server.agentManager.enqueueMessage(agent.id, {
      sender: {
        kind: "agent",
        agentId: "agent-sender",
        agentName: "Sender",
        roomName: "Room 1",
      },
      text: "after the edit",
    });
    expect(sent).toMatchObject({ ok: true, queued: true });
    await waitUntil(
      () => server!.fakeBackend.resumeSessionCount === resumesBefore + 1,
      "automatic resume",
    );
    await waitUntil(
      () => agentOf(server!, agent.id).queue.length === 0,
      "queued message delivered",
    );

    const resumed = latestSession(server, agent.id);
    expect(resumed.isResume).toBe(true);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.opts.modelFamily).toBe(good);
    expect(resumed.opts.effort).toBe("low");
    expect(agentOf(server, agent.id)).toMatchObject({
      modelFamily: good,
      effort: "low",
      state: "waiting_for_response",
    });
  }

  it("an errored OpenCode agent's auto-resume runs the model and effort the edit chose", async () => {
    await erroredAutoResume("opencode", REFUSED, GOOD);
  });

  it("an errored Claude agent's auto-resume runs the model and effort the edit chose", async () => {
    await erroredAutoResume("claude", CLAUDE_REFUSED, "sonnet");
  });

  it("a manual resume after /model keeps the picked model", async () => {
    server = await startTestServer({ fakeBackend: lazyInitBackend() });
    await server.seedOwner();
    const agent = await spawn(server, "codex", "gpt-5.6-sol", "medium");
    const sessionId = await runTurn(server, agent.id, "waiting_for_response");
    expect(getSessionEngineConfig(agent.id, sessionId)?.modelFamily).toBe(
      "gpt-5.6-sol",
    );

    await pickChoice(server, agent.id, "/model", "gpt-5.6-terra");
    expect(agentOf(server, agent.id).modelFamily).toBe("gpt-5.6-terra");

    await server.agentManager.resume(agent.id, sessionId);
    const resumed = latestSession(server, agent.id);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.opts.modelFamily).toBe("gpt-5.6-terra");
    expect(agentOf(server, agent.id).modelFamily).toBe("gpt-5.6-terra");
  });

  it("a manual resume after /effort keeps the picked effort", async () => {
    server = await startTestServer({ fakeBackend: lazyInitBackend() });
    await server.seedOwner();
    const agent = await spawn(server, "codex", "gpt-5.6-sol", "medium");
    const sessionId = await runTurn(server, agent.id, "waiting_for_response");
    expect(getSessionEngineConfig(agent.id, sessionId)?.effort).toBe("medium");

    await pickChoice(server, agent.id, "/effort", "high");
    expect(agentOf(server, agent.id).effort).toBe("high");

    await server.agentManager.resume(agent.id, sessionId);
    const resumed = latestSession(server, agent.id);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.opts.effort).toBe("high");
    expect(agentOf(server, agent.id).effort).toBe("high");
  });

  it("a failed replacement leaves the session's stored config unchanged", async () => {
    server = await startTestServer({ fakeBackend: lazyInitBackend() });
    await server.seedOwner();
    const agent = await spawn(server, "opencode", REFUSED, "high");
    const sessionId = await runTurn(server, agent.id, "error");
    server.fakeBackend.setSessionResumableError(sessionId, "missing");

    let failed = false;
    try {
      await server.agentManager.editAgent(agent.id, { modelFamily: GOOD });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(agentOf(server, agent.id).modelFamily).toBe(REFUSED);
    expect(getSessionEngineConfig(agent.id, sessionId)?.modelFamily).toBe(
      REFUSED,
    );
  });

  it("a cwd edit that abandons the session leaves its stored config unchanged", async () => {
    server = await startTestServer({ fakeBackend: lazyInitBackend() });
    await server.seedOwner();
    const agent = await spawn(server, "opencode", GOOD, "high");
    const sessionId = await runTurn(server, agent.id, "waiting_for_response");
    const newCwd = mkdtempSync(join(server.stateRoot, "cwd-"));

    await server.agentManager.editAgent(agent.id, {
      cwd: newCwd,
      modelFamily: "gate/other-model",
    });
    expect(agentOf(server, agent.id).modelFamily).toBe("gate/other-model");
    expect(getSessionEngineConfig(agent.id, sessionId)?.modelFamily).toBe(GOOD);
  });
});
