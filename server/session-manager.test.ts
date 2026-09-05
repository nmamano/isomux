// Direct unit tests on SessionManager (server/session-manager.ts) for the two
// contract clauses the public surface cannot reach (ruling 8 of the
// SessionManager extraction loop, task 798922c1): every terminal boundary
// already clears the live-turn clock, so no honest end-to-end path leaves
// residue for an idle install to clear; and every turn entry is gated on
// pendingTurn, so no honest path installs a second deferred over a live one.
// Each test was shown failing against a named mutant in the S2 hand-off.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./test-support/fake-backend.ts";
import {
  SessionManager,
  type SessionHost,
  type SessionManagerDeps,
} from "./session-manager.ts";
import { TurnSupersededError, type AgentEvent } from "./internal-types.ts";
import type { AgentInfo } from "../shared/types.ts";

interface TestHost extends SessionHost {
  info: Pick<AgentInfo, "state" | "dormant">;
}

function host(overrides: Partial<TestHost> = {}): TestHost {
  return {
    info: { state: "waiting_for_response", dormant: false },
    turnStartedAt: 0,
    lastNormalizedEventAt: 0,
    busyTurnWatchdogObserved: false,
    toolCallTimestamps: new Map<string, { name: string; startedAt: number }>(),
    lastActiveAt: 0,
    dormantReason: "idle",
    messageQueue: [],
    ...overrides,
  };
}

function fakeDeps() {
  const events: AgentEvent[] = [];
  const consumed: unknown[] = [];
  const consumerPromise = new Promise<void>(() => {});
  const deps: SessionManagerDeps<TestHost> = {
    updateAgent: (agentId, changes) => [
      { type: "agent_updated", agentId, changes },
    ],
    emit: (event) => events.push(event),
    isStillManaged: () => true,
    runConsumer: (_agentId, _host, session) => {
      consumed.push(session);
      return consumerPromise;
    },
    updateState: () => {},
    flushQueue: () => Promise.resolve(),
    getConsumerDrainTimeoutMs: () => 15_000,
    logger: { warn: () => {}, error: () => {} },
  };
  return { deps, events, consumed, consumerPromise };
}

function fakeSession() {
  return new FakeBackend().createSession({
    agentId: "a1",
    cwd: "/tmp",
    systemPrompt: "",
    modelFamily: "fake",
    effort: "default",
    permissionMode: "default",
  });
}

describe("SessionManager.installSession", () => {
  it("an idle install clears live-turn residue and binds the session", () => {
    const { deps, events, consumed, consumerPromise } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const tools = new Map<string, { name: string; startedAt: number }>([
      ["tool-1", { name: "Bash", startedAt: 5 }],
    ]);
    // Residue from an earlier turn on an agent that is NOT busy: the clock is
    // stale, so it is not a live turn (turnIsLive needs a busy state).
    const h = host({
      info: { state: "waiting_for_response", dormant: true },
      turnStartedAt: 123,
      lastNormalizedEventAt: 456,
      busyTurnWatchdogObserved: true,
      toolCallTimestamps: tools,
    });
    expect(sm.turnIsLive(h)).toBe(false);
    const session = fakeSession();
    const before = Date.now();

    sm.installSession(h, session);

    expect(h.turnStartedAt).toBe(0);
    expect(h.lastNormalizedEventAt).toBe(0);
    expect(h.busyTurnWatchdogObserved).toBe(false);
    expect(tools.size).toBe(0);
    expect(sm.session).toBe(session);
    expect(consumed).toEqual([session]);
    expect(sm.consumerPromise).toBe(consumerPromise);
    expect(h.lastActiveAt).toBeGreaterThanOrEqual(before);
    expect(h.dormantReason).toBeNull();
    expect(events).toEqual([
      { type: "agent_updated", agentId: "a1", changes: { dormant: false } },
    ]);
  });
});

describe("SessionManager.createTurnDeferred", () => {
  it("rejects a stale pending turn with TurnSupersededError and installs the new record", async () => {
    const { deps } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    sm.lastBackendFailure = "old failure";

    const first = sm.createTurnDeferred();
    let captured: unknown = undefined;
    first.catch((err: unknown) => {
      captured = err;
    });
    const firstRecord = sm.pendingTurn;
    expect(firstRecord?.promise).toBe(first);

    const second = sm.createTurnDeferred();
    await Promise.resolve(); // let the rejection reach the attached catch

    expect(captured).toBeInstanceOf(TurnSupersededError);
    if (!(captured instanceof Error)) {
      throw new Error("the stale deferred did not reject with an Error");
    }
    expect(captured.name).toBe("TurnSupersededError");
    expect(sm.pendingTurn?.promise).toBe(second);
    expect(sm.pendingTurn).not.toBe(firstRecord);
    expect(sm.lastBackendFailure).toBeNull();

    sm.pendingTurn?.resolve();
    await second;
  });
});
