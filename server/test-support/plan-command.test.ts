// /plan over the real command path: it switches the engine's native plan mode
// on the live session, every later session starts in it, and an engine that
// leaves plan mode by itself (an approved Claude plan) clears it.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

const { t } = translatorFor("en");
const ON = t("commands.plan.on");
const OFF = t("commands.plan.off");

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function planBackend(planModeError?: Error): FakeBackend {
  return new FakeBackend({
    planMode: true,
    session: {
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      planModeError,
    },
  });
}

async function setup(
  backend: FakeBackend,
): Promise<{ srv: TestServer; agent: AgentInfo; username: string }> {
  const srv = await startTestServer({ fakeBackend: backend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const room = srv.agentManager.getRooms()[0];
  const agent = await srv.agentManager.spawn(
    "A",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    owner.username,
    "claude",
  );
  if (!agent) throw new Error("spawn returned null");
  return { srv, agent, username: owner.username };
}

function entries(srv: TestServer, agentId: string, kind: LogEntry["kind"]) {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === kind)
    .map((e) => e.content);
}

// A first message gives the agent a live session.
async function liveSession(
  srv: TestServer,
  backend: FakeBackend,
  agentId: string,
  username: string,
): Promise<FakeSession> {
  await srv.agentManager.sendMessage(agentId, "hello", username);
  const session = backend.sessionForAgent(agentId);
  if (!session) throw new Error("no session");
  return session;
}

describe("/plan", () => {
  it("toggles plan mode on the live session", async () => {
    const backend = planBackend();
    const { srv, agent, username } = await setup(backend);
    const session = await liveSession(srv, backend, agent.id, username);

    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    await srv.agentManager.sendMessage(agent.id, "/plan", username);

    expect(session.planModeCalls).toEqual([true, false]);
    expect(entries(srv, agent.id, "system").filter((e) => e === ON)).toEqual([
      ON,
    ]);
    expect(entries(srv, agent.id, "system").filter((e) => e === OFF)).toEqual([
      OFF,
    ]);
  });

  it("a new session starts in plan mode while it is on, and not after it is off", async () => {
    const backend = planBackend();
    const { srv, agent, username } = await setup(backend);
    await liveSession(srv, backend, agent.id, username);

    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    await srv.agentManager.sendMessage(agent.id, "/clear", username);
    const second = await liveSession(srv, backend, agent.id, username);
    expect(second.opts.planMode).toBe(true);

    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    await srv.agentManager.sendMessage(agent.id, "/clear", username);
    const third = await liveSession(srv, backend, agent.id, username);
    expect(third).not.toBe(second);
    expect(third.opts.planMode).toBe(false);
  });

  it("with no live session, the first session starts in plan mode", async () => {
    const backend = planBackend();
    const { srv, agent, username } = await setup(backend);
    expect(backend.sessionForAgent(agent.id)).toBeUndefined();

    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    const session = await liveSession(srv, backend, agent.id, username);
    expect(session.opts.planMode).toBe(true);
    expect(session.planModeCalls).toEqual([]);
  });

  it("/plan <text> turns plan mode on and sends the text", async () => {
    const backend = planBackend();
    const { srv, agent, username } = await setup(backend);
    const session = await liveSession(srv, backend, agent.id, username);

    await srv.agentManager.sendMessage(
      agent.id,
      "/plan add a login page",
      username,
    );
    expect(session.planModeCalls).toEqual([true]);
    await waitUntil(
      () => session.sent.length === 2,
      "the text reaches the engine",
    );
    expect(session.sent[1].text).toEndWith("add a login page");
    // Already on: the text goes out with no second switch and no notice.
    await srv.agentManager.sendMessage(
      agent.id,
      "/plan and a logout",
      username,
    );
    await waitUntil(() => session.sent.length === 3, "the second text");
    expect(session.planModeCalls).toEqual([true]);
    expect(
      entries(srv, agent.id, "system").filter((e) => e === ON),
    ).toHaveLength(1);
  });

  it("a refused switch reports the error and leaves plan mode off", async () => {
    const backend = planBackend(new Error("engine refused"));
    const { srv, agent, username } = await setup(backend);
    const session = await liveSession(srv, backend, agent.id, username);

    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    expect(session.planModeCalls).toEqual([true]);
    expect(
      entries(srv, agent.id, "error").some((e) => e.includes("engine refused")),
    ).toBe(true);
    expect(entries(srv, agent.id, "system")).not.toContain(ON);
    await srv.agentManager.sendMessage(agent.id, "/clear", username);
    const next = await liveSession(srv, backend, agent.id, username);
    expect(next.opts.planMode).toBeFalsy();
  });

  it("an engine that leaves plan mode by itself clears it, with one notice", async () => {
    const backend = planBackend();
    const { srv, agent, username } = await setup(backend);
    const session = await liveSession(srv, backend, agent.id, username);
    await srv.agentManager.sendMessage(agent.id, "/plan", username);

    // The engine confirms the switch /plan made: no second notice.
    session.push({ kind: "plan_mode", on: true });
    // An approved plan: the engine is back in its configured mode.
    session.push({ kind: "plan_mode", on: false });
    session.push({ kind: "plan_mode", on: false });
    await waitUntil(
      () => entries(srv, agent.id, "system").includes(OFF),
      "the off notice",
    );
    const system = entries(srv, agent.id, "system");
    expect(system.filter((e) => e === ON)).toHaveLength(1);
    expect(system.filter((e) => e === OFF)).toHaveLength(1);

    await srv.agentManager.sendMessage(agent.id, "/clear", username);
    const next = await liveSession(srv, backend, agent.id, username);
    expect(next.opts.planMode).toBe(false);
  });

  it("an engine with no plan mode refuses /plan", async () => {
    const backend = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const { srv, agent, username } = await setup(backend);
    const session = await liveSession(srv, backend, agent.id, username);
    await srv.agentManager.sendMessage(agent.id, "/plan", username);
    await srv.agentManager.sendMessage(agent.id, "/plan do it", username);
    expect(session.planModeCalls).toEqual([]);
    expect(session.sent).toHaveLength(1);
  });
});
