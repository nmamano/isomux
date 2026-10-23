// /plan over the real command path: it switches the engine's native plan mode
// on the live session, every later session starts in it, and an engine that
// leaves plan mode by itself (an approved Claude plan) clears it.

import { describe, it, expect, afterEach } from "bun:test";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import type { AgentEvent } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";

const { t } = translatorFor("en");
const ON = t("commands.plan.on");
const OFF = t("commands.plan.off");

const ROOM: RoomWire = {
  id: "room-plan",
  name: "room-plan",
  prompt: null,
  canCloseWhenEmpty: true,
};
const USER = "Morgan";

const fakes: FakeBackend[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
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

type Mgr = ReturnType<typeof createAgentManager>;

async function setup(backend: FakeBackend) {
  fakes.push(backend);
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => backend,
    officeState: new OfficeState({ rooms: [ROOM] }),
    initialRooms: [],
    eventSink: (event) => events.push(event),
  });
  mgr.configureAgentTurnDeps();
  const agent = await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    ROOM.id,
    undefined,
    undefined,
    undefined,
    USER,
    "claude",
  );
  if (!agent) throw new Error("spawn returned null");
  return { mgr, agent, events };
}

function entries(mgr: Mgr, agentId: string, kind: LogEntry["kind"]) {
  return mgr
    .getAgentLogs(agentId)
    .filter((e) => e.kind === kind)
    .map((e) => e.content);
}

// A first message gives the agent a live session.
async function liveSession(
  mgr: Mgr,
  backend: FakeBackend,
  agentId: string,
): Promise<FakeSession> {
  await mgr.sendMessage(agentId, "hello", USER);
  const session = backend.sessionForAgent(agentId);
  if (!session) throw new Error("no session");
  return session;
}

describe("/plan", () => {
  it("toggles plan mode on the live session", async () => {
    const backend = planBackend();
    const { mgr, agent } = await setup(backend);
    const session = await liveSession(mgr, backend, agent.id);

    await mgr.sendMessage(agent.id, "/plan", USER);
    await mgr.sendMessage(agent.id, "/plan", USER);

    expect(session.planModeCalls).toEqual([true, false]);
    expect(entries(mgr, agent.id, "system").filter((e) => e === ON)).toEqual([
      ON,
    ]);
    expect(entries(mgr, agent.id, "system").filter((e) => e === OFF)).toEqual([
      OFF,
    ]);
  });

  it("a new session starts in plan mode while it is on, and not after it is off", async () => {
    const backend = planBackend();
    const { mgr, agent } = await setup(backend);
    // No live session yet: the switch waits for the first session.
    await mgr.sendMessage(agent.id, "/plan", USER);
    const first = await liveSession(mgr, backend, agent.id);
    expect(first.opts.planMode).toBe(true);
    expect(first.planModeCalls).toEqual([]);

    await mgr.sendMessage(agent.id, "/clear", USER);
    const second = await liveSession(mgr, backend, agent.id);
    expect(second).not.toBe(first);
    expect(second.opts.planMode).toBe(true);

    await mgr.sendMessage(agent.id, "/plan", USER);
    await mgr.sendMessage(agent.id, "/clear", USER);
    const third = await liveSession(mgr, backend, agent.id);
    expect(third).not.toBe(second);
    expect(third.opts.planMode).toBe(false);
  });

  it("/plan <text> turns plan mode on and sends the text", async () => {
    const backend = planBackend();
    const { mgr, agent } = await setup(backend);
    const session = await liveSession(mgr, backend, agent.id);

    await mgr.sendMessage(agent.id, "/plan add a login page", USER);
    expect(session.planModeCalls).toEqual([true]);
    await waitUntil(
      () => session.sent.length === 2,
      "the text reaches the engine",
    );
    expect(session.sent[1].text).toEndWith("add a login page");
    // Already on: the text goes out with no second switch and no notice.
    await mgr.sendMessage(agent.id, "/plan and a logout", USER);
    await waitUntil(() => session.sent.length === 3, "the second text");
    expect(session.planModeCalls).toEqual([true]);
    expect(
      entries(mgr, agent.id, "system").filter((e) => e === ON),
    ).toHaveLength(1);
  });

  it("a refused switch reports the error and leaves plan mode off", async () => {
    const backend = planBackend(new Error("engine refused"));
    const { mgr, agent } = await setup(backend);
    const session = await liveSession(mgr, backend, agent.id);

    await mgr.sendMessage(agent.id, "/plan", USER);
    expect(session.planModeCalls).toEqual([true]);
    expect(
      entries(mgr, agent.id, "error").some((e) => e.includes("engine refused")),
    ).toBe(true);
    expect(entries(mgr, agent.id, "system")).not.toContain(ON);
    await mgr.sendMessage(agent.id, "/clear", USER);
    const next = await liveSession(mgr, backend, agent.id);
    expect(next.opts.planMode).toBeFalsy();
  });

  it("an engine that leaves plan mode by itself clears it, with one notice", async () => {
    const backend = planBackend();
    const { mgr, agent } = await setup(backend);
    const session = await liveSession(mgr, backend, agent.id);
    await mgr.sendMessage(agent.id, "/plan", USER);

    // The engine confirms the switch /plan made: no second notice.
    session.push({ kind: "plan_mode", on: true });
    // An approved plan: the engine is back in its configured mode.
    session.push({ kind: "plan_mode", on: false });
    session.push({ kind: "plan_mode", on: false });
    await waitUntil(
      () => entries(mgr, agent.id, "system").includes(OFF),
      "the off notice",
    );
    const system = entries(mgr, agent.id, "system");
    expect(system.filter((e) => e === ON)).toHaveLength(1);
    expect(system.filter((e) => e === OFF)).toHaveLength(1);

    await mgr.sendMessage(agent.id, "/clear", USER);
    const next = await liveSession(mgr, backend, agent.id);
    expect(next.opts.planMode).toBe(false);
  });

  it("an engine with no plan mode refuses /plan", async () => {
    const backend = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const { mgr, agent, events } = await setup(backend);
    const session = await liveSession(mgr, backend, agent.id);
    const refusal = t("commands.plan.unavailable", { engine: "Claude" });
    const refusals = () =>
      events.filter(
        (e) =>
          e.type === "log_entry" &&
          e.entry.agentId === agent.id &&
          e.entry.kind === "system" &&
          e.entry.content === refusal,
      );
    await mgr.sendMessage(agent.id, "/plan", USER);
    await mgr.sendMessage(agent.id, "/plan do it", USER);
    expect(refusals()).toHaveLength(2);
    expect(session.planModeCalls).toEqual([]);
    expect(session.sent).toHaveLength(1);
  });
});
