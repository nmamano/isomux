// Direct unit tests on SessionManager (server/session-manager.ts) for the
// contract clauses the public surface cannot reach (ruling 8 of the
// SessionManager extraction loop, task 798922c1): every terminal boundary
// already clears the live-turn clock, so no honest end-to-end path leaves
// residue for an idle install to clear; every turn entry is gated on
// pendingTurn, so no honest path installs a second deferred over a live one;
// and the consumer loop's bound-session guards (S3) are only observable from
// inside the object. Each test was shown failing against a named mutant in
// the slice hand-off.

import { describe, it, expect } from "bun:test";
import { FakeBackend, FakeSession } from "./test-support/fake-backend.ts";
import {
  SessionManager,
  type SessionHost,
  type SessionManagerDeps,
} from "./session-manager.ts";
import {
  AuthNeededError,
  TurnSupersededError,
  type AgentEvent,
} from "./internal-types.ts";
import { backendStoppedDuringTurn } from "./backend-failure-text.ts";
import { msg, type LogText } from "../shared/i18n/log-message.ts";

// Isomux's own lines are messages each reader words (task c37a7365).
const BACKEND_STOPPED_DURING_TURN = backendStoppedDuringTurn();
import type { BackendSession, NormalizedEvent } from "./backends/types.ts";
import type { AgentInfo, AgentState, LogEntry } from "../shared/types.ts";

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

interface LoggedEntry {
  agentId: string;
  kind: LogEntry["kind"];
  content: LogText;
  metadata: Record<string, unknown> | undefined;
}

// A recording deps object. `whenProcessed(n)` resolves once the consumer has
// forwarded n events, so tests wait on the loop itself instead of a timer.
function fakeDeps() {
  const events: AgentEvent[] = [];
  const processed: NormalizedEvent[] = [];
  const logged: LoggedEntry[] = [];
  const stateUpdates: AgentState[] = [];
  const diagnostics = {
    reconciled: 0,
    diagnosed: 0,
    authAsked: 0,
  };
  // What the manager answers when the consumer asks whether this turn already
  // needed sign-in.
  const auth = { needed: false };
  const waiters: { n: number; resolve: () => void }[] = [];
  // createSession recorder: `create.onCall` observes each call at call time,
  // `create.throwWith` makes the next call throw synchronously.
  const created: BackendSession[] = [];
  const create: {
    onCall: ((resumeSessionId: string | undefined) => void) | null;
    throwWith: Error | null;
  } = { onCall: null, throwWith: null };
  const deps: SessionManagerDeps<TestHost> = {
    updateAgent: (agentId, changes) => [
      { type: "agent_updated", agentId, changes },
    ],
    emit: (event) => events.push(event),
    isStillManaged: () => true,
    createSession: (_host, resumeSessionId) => {
      create.onCall?.(resumeSessionId);
      if (create.throwWith) throw create.throwWith;
      const session = fakeSession();
      created.push(session);
      return session;
    },
    processNormalizedEvent: (_agentId, ev) => {
      processed.push(ev);
      for (const w of waiters.splice(0)) {
        if (processed.length >= w.n) w.resolve();
        else waiters.push(w);
      }
    },
    addLogEntry: (agentId, kind, content, metadata) => {
      logged.push({ agentId, kind, content, metadata });
    },
    reconcilePendingFixedCwdReset: () => {
      diagnostics.reconciled++;
    },
    diagnoseProcessExitHints: () => {
      diagnostics.diagnosed++;
      return null;
    },
    authNeededThisTurn: () => {
      diagnostics.authAsked++;
      return auth.needed;
    },
    updateState: (_agentId, state) => {
      stateUpdates.push(state);
    },
    flushQueue: () => Promise.resolve(),
    getConsumerDrainTimeoutMs: () => 15_000,
    logger: { warn: () => {}, error: () => {} },
  };
  const whenProcessed = (n: number) =>
    new Promise<void>((resolve) => {
      if (processed.length >= n) resolve();
      else waiters.push({ n, resolve });
    });
  return {
    deps,
    events,
    processed,
    logged,
    stateUpdates,
    diagnostics,
    auth,
    whenProcessed,
    create,
    created,
  };
}

function fakeSession(): FakeSession {
  const session = new FakeBackend().createSession({
    agentId: "a1",
    cwd: "/tmp",
    systemPrompt: "",
    modelFamily: "fake",
    effort: "default",
    permissionMode: "default",
  });
  if (!(session instanceof FakeSession)) {
    throw new Error("FakeBackend did not hand back a FakeSession");
  }
  return session;
}

// The consumer promise as installed; throws when the slot is empty so a test
// never awaits `null`.
function consumerOf(sm: SessionManager<TestHost>): Promise<void> {
  const consumer = sm.consumerPromise;
  if (!consumer) throw new Error("no consumer installed");
  return consumer;
}

describe("SessionManager.installSession", () => {
  it("an idle install clears live-turn residue, binds the session and starts the consumer", async () => {
    const { deps, events, processed, whenProcessed } = fakeDeps();
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
    expect(sm.consumerPromise).toBeInstanceOf(Promise);
    expect(h.lastActiveAt).toBeGreaterThanOrEqual(before);
    expect(h.dormantReason).toBeNull();
    expect(events).toEqual([
      { type: "agent_updated", agentId: "a1", changes: { dormant: false } },
    ]);
    // The consumer forwards the session's events while it is bound: the
    // auto-emitted system_init, then what the test pushes.
    session.push({ kind: "assistant_text", text: "hello" });
    await whenProcessed(2);
    expect(processed.map((e) => e.kind)).toEqual([
      "system_init",
      "assistant_text",
    ]);
    session.close();
  });
});

describe("SessionManager.createTurnDeferred", () => {
  it("rejects a stale pending turn with TurnSupersededError and installs the new record", async () => {
    const { deps } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    sm.lastBackendFailure = "sigterm:143";

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

describe("SessionManager consumer: stream end", () => {
  it("a clean stream end while bound settles the turn, releases the session and nulls consumerPromise", async () => {
    const { deps, events, logged, stateUpdates, diagnostics } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "thinking", dormant: false } });
    const session = fakeSession();
    sm.installSession(h, session);
    const consumer = consumerOf(sm);
    const turn = sm.createTurnDeferred();
    let captured: unknown = undefined;
    turn.catch((err: unknown) => {
      captured = err;
    });
    const tokenBefore = sm.turnCancelToken;

    // The backend dies without an error event: the stream just ends.
    session.endStream();
    await consumer;

    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) {
      throw new Error("the owned turn did not reject with an Error");
    }
    expect(captured.message).toBe(
      "Backend stream ended unexpectedly mid-turn.",
    );
    expect(sm.pendingTurn).toBeNull();
    expect(sm.session).toBeNull();
    expect(sm.consumerPromise).toBeNull();
    expect(h.dormantReason).toBe("stream-ended");
    expect(sm.turnCancelToken).toBe(tokenBefore + 1);
    // The background work died with the process (task daa9dbef).
    expect(events).toEqual([
      {
        type: "agent_updated",
        agentId: "a1",
        changes: { dormant: true, backgroundTasks: null },
      },
    ]);
    expect(logged).toEqual([
      {
        agentId: "a1",
        kind: "error",
        content: BACKEND_STOPPED_DURING_TURN,
        metadata: {
          backendFailureRaw: "Backend stream ended unexpectedly mid-turn.",
        },
      },
    ]);
    // The stamp is now WHAT happened, not what it said.
    expect(sm.lastBackendFailure).toBe("stopped-during-turn");
    // Mid-turn branch: no state transition, and none of the error-path
    // diagnostics run on a clean end.
    expect(stateUpdates).toEqual([]);
    expect(diagnostics).toEqual({
      reconciled: 0,
      diagnosed: 0,
      authAsked: 0,
    });
  });

  it("a stream that ends after a swap touches nothing: late events are dropped and the cleanup is skipped", async () => {
    const { deps, events, processed, logged, stateUpdates, whenProcessed } =
      fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "thinking", dormant: false } });
    const old = fakeSession();
    sm.installSession(h, old);
    const oldConsumer = consumerOf(sm);
    const turn = sm.createTurnDeferred();
    let captured: unknown = undefined;
    turn.catch((err: unknown) => {
      captured = err;
    });
    // The swap's install step: the slot now points at the replacement, so the
    // old consumer is unbound before it ever forwards an event.
    const replacement = fakeSession();
    sm.installSession(h, replacement);
    const replacementConsumer = consumerOf(sm);
    const tokenBefore = sm.turnCancelToken;

    // Late events from the dying session are drained but dropped; only the
    // replacement's system_init reaches the manager.
    old.push({ kind: "assistant_text", text: "late" });
    await whenProcessed(1);
    old.endStream();
    await oldConsumer;
    expect(processed.map((e) => e.kind)).toEqual(["system_init"]);
    expect(
      processed.some((e) => e.kind === "assistant_text" && e.text === "late"),
    ).toBe(false);

    // The clean-end cleanup is skipped for an unbound consumer.
    expect(sm.session).toBe(replacement);
    expect(sm.consumerPromise).toBe(replacementConsumer);
    expect(sm.pendingTurn?.promise).toBe(turn);
    expect(captured).toBeUndefined();
    expect(h.dormantReason).toBeNull();
    expect(sm.turnCancelToken).toBe(tokenBefore);
    expect(events).toEqual([]);
    expect(logged).toEqual([]);
    expect(stateUpdates).toEqual([]);

    replacement.close();
    await replacementConsumer;
  });
});

// The dormant / sessionSwapping flips in emission order, as "flag:value".
function flagChanges(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "agent_updated") continue;
    if ("sessionSwapping" in e.changes)
      out.push(`sessionSwapping:${String(e.changes.sessionSwapping)}`);
    if ("dormant" in e.changes)
      out.push(`dormant:${String(e.changes.dormant)}`);
  }
  return out;
}

// Background work (task daa9dbef) lives with the session's process: every way
// the session ends clears it, and its event is never dropped as part of a
// cancelled turn.
describe("SessionManager background work", () => {
  const TASKS = [{ id: "b1", kind: "command" as const, label: "npm run dev" }];
  const cleared = (events: AgentEvent[]) =>
    events.filter(
      (e) =>
        e.type === "agent_updated" &&
        "backgroundTasks" in e.changes &&
        e.changes.backgroundTasks === null,
    ).length;

  it("passes a background_tasks event through the hot-abort window", async () => {
    const { deps, processed, whenProcessed } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "thinking", dormant: false } });
    const session = fakeSession();
    sm.installSession(h, session);
    sm.aborting = true;
    session.push({ kind: "assistant_text", text: "cancelled output" });
    session.push({ kind: "background_tasks", tasks: TASKS });
    session.push({ kind: "turn_completed", status: "interrupted" });
    await Promise.race([
      whenProcessed(2),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    expect(processed).toEqual([
      { kind: "background_tasks", tasks: TASKS },
      { kind: "turn_completed", status: "interrupted" },
    ]);
    session.close();
  });

  it("clears it when the session is replaced", async () => {
    const { deps, events, created } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host();
    sm.installSession(h, fakeSession());
    expect(cleared(events)).toBe(0);
    await sm.replaceWith(h, "resume-1");
    expect(cleared(events)).toBe(1);
    created[0].close();
  });

  it("clears it when the stream fails", async () => {
    const { deps, events } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "waiting_for_response", dormant: false } });
    const session = fakeSession();
    sm.installSession(h, session);
    const consumer = consumerOf(sm);
    session.failStream(new Error("ECONNRESET"));
    await consumer;
    expect(cleared(events)).toBe(1);
  });
});

describe("SessionManager.replaceWith", () => {
  it("creates the replacement before closing the old session, exactly once with the given id, then drains and installs it", async () => {
    const { deps, events, create, created } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host();
    const old = fakeSession();
    sm.installSession(h, old);
    const calls: {
      resumeSessionId: string | undefined;
      oldClosedAtCall: boolean;
      oldBoundAtCall: boolean;
    }[] = [];
    create.onCall = (resumeSessionId) =>
      calls.push({
        resumeSessionId,
        oldClosedAtCall: old.closed,
        oldBoundAtCall: sm.session === old,
      });

    await sm.replaceWith(h, "resume-1");

    // Create first: exactly one call, with the id given, while the old session
    // is still bound and open.
    expect(calls).toEqual([
      {
        resumeSessionId: "resume-1",
        oldClosedAtCall: false,
        oldBoundAtCall: true,
      },
    ]);
    // Then close, drain, install.
    expect(old.closed).toBe(true);
    expect(created.length).toBe(1);
    expect(sm.session).toBe(created[0]);
    expect(sm.consumerPromise).toBeInstanceOf(Promise);
    expect(flagChanges(events)).toEqual([
      "sessionSwapping:true",
      "dormant:true",
      "sessionSwapping:false",
    ]);
    created[0].close();
  });

  it("a createSession dep that throws synchronously throws synchronously and leaves the old session bound with its turn untouched", async () => {
    const { deps, events, create, created } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "thinking", dormant: false } });
    const old = fakeSession();
    sm.installSession(h, old);
    const turn = sm.createTurnDeferred();
    let captured: unknown = undefined;
    turn.catch((err: unknown) => {
      captured = err;
    });
    const tokenBefore = sm.turnCancelToken;
    const eventsBefore = events.length;
    create.throwWith = new Error("cwd is invalid");

    let thrown: unknown = undefined;
    let returned: Promise<void> | undefined;
    try {
      returned = sm.replaceWith(h, null);
    } catch (err: unknown) {
      thrown = err;
    }
    await Promise.resolve(); // a rejection of the turn would have landed by now

    // Untouched state first: nothing was closed, unset, cancelled or emitted.
    // (A swallowed throw that went on to drain would fail here, because
    // closeAndDrainSession closes and unsets before its first await.)
    expect(sm.session).toBe(old);
    expect(old.closed).toBe(false);
    expect(sm.pendingTurn?.promise).toBe(turn);
    expect(captured).toBeUndefined();
    expect(sm.turnCancelToken).toBe(tokenBefore);
    expect(events.length).toBe(eventsBefore);
    expect(created).toEqual([]);
    // Then propagation: a synchronous throw, not a rejected promise, so the
    // caller's own catch handles it in the same tick, the way the former call
    // sites did.
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("replaceWith did not throw synchronously");
    }
    expect(thrown.message).toBe("cwd is invalid");
    expect(returned).toBeUndefined();
    old.close();
  });
});

// The visible "Stream error: " line is isomux's own framing, so it is a
// message each reader words; the SUFFIX inside it is the backend's own text
// and stays a plain value. The raw wrapper still goes to the metadata
// unchanged, because it keeps the backend's wording.
describe("SessionManager consumer: an unclassified stream failure", () => {
  it("frames the backend text as a message and keeps the backend suffix", async () => {
    const { deps, logged } = fakeDeps();
    const sm = new SessionManager<TestHost>("a1", deps);
    const h = host({ info: { state: "thinking", dormant: false } });
    const session = fakeSession();
    sm.installSession(h, session);
    const consumer = consumerOf(sm);
    const turn = sm.createTurnDeferred();
    turn.catch(() => {});

    // ECONNRESET is the pass-through case: nothing about it is classified, so
    // the entry is the framing plus the backend's own string.
    session.failStream(new Error("ECONNRESET"));
    await consumer;

    const entry = logged.find((e) => e.kind === "error");
    expect(entry).toBeDefined();
    // Our wrapper as a message, the backend text as a literal value.
    expect(entry!.content).toEqual(
      msg("systemEntries.streamError", { error: "ECONNRESET" }),
    );
    // An unclassified failure carries no rewritten-text metadata, exactly as
    // before.
    expect(entry!.metadata).toBeUndefined();
    // The stamp is the language-independent identity, not the sentence.
    expect(sm.lastBackendFailure).toBe("unclassified");
  });
});

// The adapter says when a turn needs sign-in (auth_needed); a stream failure
// only asks the manager whether this turn already did. The failure text is
// auth-shaped in both cases, so a text sniff fails the second one.
describe("SessionManager consumer: a stream failure and sign-in", () => {
  for (const needed of [true, false]) {
    // The turn's owner tells a sign-in failure from a crash by the error it
    // gets, so the answer has to be known before the turn is rejected.
    it(`${needed ? "a turn that needed sign-in leaves the desk waiting and rejects with AuthNeededError" : "otherwise the desk shows the error and the turn gets the original error"}`, async () => {
      const { deps, stateUpdates, diagnostics, auth } = fakeDeps();
      auth.needed = needed;
      const sm = new SessionManager<TestHost>("a1", deps);
      const h = host({ info: { state: "thinking", dormant: false } });
      const session = fakeSession();
      sm.installSession(h, session);
      const consumer = consumerOf(sm);
      const turn = sm.createTurnDeferred();
      const rejected = turn.then(
        () => null,
        (err: unknown) => err,
      );
      const original = new Error("401 Unauthorized");

      session.failStream(original);
      await consumer;

      expect(diagnostics.authAsked).toBe(1);
      expect(stateUpdates).toEqual([needed ? "waiting_for_response" : "error"]);
      const err = await rejected;
      if (needed) {
        expect(err).toBeInstanceOf(AuthNeededError);
        expect((err as Error).message).toBe("401 Unauthorized");
      } else {
        expect(err === original).toBe(true);
      }
    });
  }
});
