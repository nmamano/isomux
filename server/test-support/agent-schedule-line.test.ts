// The schedule line of an agent's system prompt follows its mode (task
// 11e311db): an agent that makes schedules (agentMakesSchedules) is offered
// the cronjob-management page, any other agent is sent to the member. This
// file pins the wiring the unit tests cannot see: every place that builds
// the prompt passes the agent's own mode, a mode or privilege change moves
// the next session's prompt, and the form preview follows the form.
// The mode table is in server/cron-agent-limits.test.ts, the line itself in
// server/test-support/system-prompt.test.ts.
//
// Seam: startTestServer() with a FakeBackend. Zero LLM. Copy is never
// matched: the line is found by its page pointer.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

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
    await sleep(5);
  }
}

const POINTER = "Page: `cronjob-management`";
const offers = (prompt: string): boolean => prompt.includes(POINTER);

interface Res {
  status: number;
  body: unknown;
}

async function api(
  srv: TestServer,
  method: string,
  path: string,
  rawSessionId: string,
  payload?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    rawSessionId,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// A backend whose every turn completes, so an agent goes back to idle.
const completingBackend = () =>
  new FakeBackend({
    session: {
      onSend: (_t, _a, session) => session.completeTurn({ text: "ok" }),
    },
  });

async function office() {
  const srv = await startTestServer({ fakeBackend: completingBackend() });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const roomId = srv.agentManager.getRooms()[0].id;
  return { srv, owner, roomId };
}

async function spawn(
  srv: TestServer,
  name: string,
  agentType: AgentInfo["agentType"],
  permissionMode: AgentInfo["permissionMode"],
  codexSandbox?: AgentInfo["codexSandbox"],
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    permissionMode,
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    "Morgan",
    agentType,
    codexSandbox,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const agent = srv.agentManager.getAgent(id);
  if (!agent) throw new Error(`agent ${id} not live`);
  return agent;
}

function latestSession(srv: TestServer, agentId: string): FakeSession {
  const session = srv.fakeBackend.sessionForAgent(agentId);
  if (!session) throw new Error("no fake session for agent");
  return session;
}

// One member turn to idle; returns the session it ran in.
async function runTurn(srv: TestServer, agentId: string): Promise<FakeSession> {
  const before = srv.fakeBackend.sessions.length;
  const sentBefore = srv.fakeBackend.sessionForAgent(agentId)?.sent.length ?? 0;
  await srv.agentManager.sendMessage(agentId, "hello", "tester");
  await waitUntil(
    () =>
      srv.fakeBackend.sessions.length > before ||
      latestSession(srv, agentId).sent.length > sentBefore,
    "turn sent",
  );
  await waitUntil(
    () => agentOf(srv, agentId).state === "waiting_for_response",
    "turn finished",
  );
  return latestSession(srv, agentId);
}

// The prompt both ways: what GET /api/agents/:id/system-prompt shows, and
// what the next session is built with.
async function prompts(
  srv: TestServer,
  rawSessionId: string,
  agentId: string,
): Promise<{ route: boolean; session: boolean }> {
  const res = await api(
    srv,
    "GET",
    `/api/agents/${agentId}/system-prompt`,
    rawSessionId,
  );
  expect(res.status).toBe(200);
  const route = (res.body as { prompt: string }).prompt;
  const session = (await runTurn(srv, agentId)).opts.systemPrompt ?? "";
  // Enabling condition: both are whole prompts, so a missing pointer is not
  // a missing prompt.
  for (const prompt of [route, session])
    expect(prompt).toContain("Page: `cronjobs`");
  return { route: offers(route), session: offers(session) };
}

const BOTH = { route: true, session: true };
const NEITHER = { route: false, session: false };

describe("the schedule line in an agent's prompt", () => {
  it("follows the agent's mode in the prompt view and in the session", async () => {
    const { srv, owner } = await office();
    const cases: Array<
      [
        string,
        AgentInfo["agentType"],
        AgentInfo["permissionMode"],
        AgentInfo["codexSandbox"] | undefined,
        boolean,
      ]
    > = [
      ["claude auto", "claude", "auto", undefined, false],
      ["claude bypass", "claude", "bypassPermissions", undefined, true],
      ["codex never read-only", "codex", "never", "read-only", true],
      [
        "codex on-request full",
        "codex",
        "on-request",
        "danger-full-access",
        false,
      ],
    ];
    for (const [label, type, mode, sandbox, makes] of cases) {
      const agent = await spawn(srv, label, type, mode, sandbox);
      expect([label, await prompts(srv, owner.rawSessionId, agent.id)]).toEqual(
        [label, makes ? BOTH : NEITHER],
      );
    }
  });

  it("moves with a mode change and with the privileged flag, at the next session", async () => {
    const { srv, owner } = await office();
    const agent = await spawn(srv, "Mover", "claude", "auto");
    expect(await prompts(srv, owner.rawSessionId, agent.id)).toEqual(NEITHER);

    await srv.agentManager.editAgent(agent.id, {
      permissionMode: "bypassPermissions",
    });
    expect(agentOf(srv, agent.id).permissionMode).toBe("bypassPermissions");
    expect(await prompts(srv, owner.rawSessionId, agent.id)).toEqual(BOTH);

    await srv.agentManager.editAgent(agent.id, { permissionMode: "auto" });
    expect(await prompts(srv, owner.rawSessionId, agent.id)).toEqual(NEITHER);

    // cron:manage lifts the limits, so a privileged agent makes schedules in
    // any mode.
    await srv.agentManager.setPrivileged(agent.id, true);
    expect(agentOf(srv, agent.id).permissionMode).toBe("auto");
    expect(await prompts(srv, owner.rawSessionId, agent.id)).toEqual(BOTH);
  });
});

describe("the schedule line in the form preview", () => {
  it("follows the form's mode, else the agent's on the same engine, else the engine's default", async () => {
    const { srv, owner, roomId } = await office();
    const auto = await spawn(srv, "Auto", "claude", "auto");
    const bypass = await spawn(srv, "Bypass", "claude", "bypassPermissions");
    const preview = async (draft: Record<string, unknown>) => {
      const res = await api(
        srv,
        "POST",
        "/api/agents/system-prompt-preview",
        owner.rawSessionId,
        {
          roomId,
          name: "Draft",
          agentType: "claude",
          instructions: "",
          privileged: false,
          ...draft,
        },
      );
      expect([draft, res.status]).toEqual([draft, 200]);
      return offers((res.body as { prompt: string }).prompt);
    };
    const cases: Array<[Record<string, unknown>, boolean]> = [
      // The form's mode wins over the saved one, both ways.
      [{ agentId: auto.id, permissionMode: "bypassPermissions" }, true],
      [{ agentId: bypass.id, permissionMode: "auto" }, false],
      // No mode in the request: the agent's own.
      [{ agentId: auto.id }, false],
      [{ agentId: bypass.id }, true],
      // On another engine the agent's mode does not apply: the engine's
      // default does (OpenCode bypassPermissions, Codex never).
      [{ agentId: auto.id, agentType: "opencode" }, true],
      [
        {
          agentId: bypass.id,
          agentType: "opencode",
          permissionMode: "default",
        },
        false,
      ],
      // A new agent: the engine's default (Claude bypassPermissions since
      // task f49289bd).
      [{}, true],
      [{ agentType: "codex" }, true],
      [{ agentType: "codex", permissionMode: "on-request" }, false],
      [
        {
          agentType: "codex",
          permissionMode: "never",
          codexSandbox: "read-only",
        },
        true,
      ],
      // Privileged, in a mode that asks.
      [{ agentId: auto.id, privileged: true }, true],
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const [draft, makes] of cases) {
      got.push(`${JSON.stringify(draft)}: ${await preview(draft)}`);
      want.push(`${JSON.stringify(draft)}: ${makes}`);
    }
    expect(got).toEqual(want);
    // Nothing saved.
    expect(agentOf(srv, auto.id).permissionMode).toBe("auto");
  });
});
