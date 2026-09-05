// Characterization of the per-agent session lifecycle in server/agent-manager.ts
// (installSession / closeAndDrainSession / replaceSession / runConsumer's
// stream-end branch / abort), written as S1 of the SessionManager extraction
// loop (task 798922c1, internal-docs/session-manager-loop.md) so S2-S4 can move
// the code with a red/green signal. Every test here pins CURRENT behaviour and
// was shown failing against a named production mutant in the S1 hand-off.
//
// Inventory of the pickup's eight behaviours (what other suites already pin):
//   1. replaceSession close -> drain -> install, SessionSwappedError + reason.
//      Reason wording: queue.test.ts "effort change with a queued message words
//      the notice as expected behavior and still delivers" (settings) and "an
//      unexpected session swap in the same window surfaces 'will retry' AND
//      actually retries post-swap" (undefined). Queue-path wake defers to a
//      draining swap: queue-reliability.test.ts "a message arriving during a
//      swap's blocked drain waits and delivers exactly once into the post-swap
//      session". Added here: the close/drain/install order with the dormant and
//      sessionSwapping events, and the rejection type reaching a human turn.
//   2. A wake that wins the drain window is kept, the replacement discarded:
//      queue-reliability.test.ts "a human wake that wins the drain window is
//      kept - the swap discards its own replacement instead of clobbering the
//      live turn". Nothing added.
//   3. installSession keeps a live turn on a lazy first-message wake: added
//      here. The idle-install residue clear has no honest public path and is an
//      S2 direct-unit obligation (ruling 8).
//   4. Clean stream end while bound. Owned turn: queue-reliability.test.ts
//      "mid-turn clean stream end settles the turn, surfaces the error, releases
//      the dead session, and the agent recovers" and "mid-turn stream end with a
//      queued item: no replacement turn races the dying caller; the item
//      delivers after human recovery"; agent-death-recovery.test.ts "words a bare
//      mid-turn stream end the same way". Idle: agent-idle-eviction.di.test.ts
//      "backend-death wake: same warning, worded for an unexpected end". Added
//      here: the no-owner pre-send branch.
//   5. createTurnDeferred rejects a stale pending turn: no honest public path
//      (every entry is gated on pendingTurn); S2 direct-unit obligation
//      (ruling 8). Its absence is pinned by queue.test.ts "keeps the accepted
//      flush out of error and retries later arrivals".
//   6. Abort during a turn. Hot path denial: agent-death-recovery.test.ts "abort
//      denies the pending prompt and unparks the agent", "stops an OpenCode tool
//      through the in-place abort path". Slow path + bounded drain:
//      queue-reliability.test.ts "a session whose stream never ends after
//      close() cannot wedge abort/flush; delivery resumes after the drain
//      timeout". Hot-abort attach: queue-reliability.test.ts "a queued message
//      still delivers promptly when the interrupted turn's send throws". Re-entry
//      guard: queue.test.ts "a second steer during the first one's abort
//      interrupts nothing". Added here: the aborting flag's event suppression
//      and its lifetime through the drain, sendMessage awaiting abortPromise,
//      and the Codex interrupted/failed mapping.
//   7. Kill during a swap drain: PARKED FOR NIL (ruling 7, task 3e8482e2);
//      nothing pinned in S1.
//   8. drainConsumerBounded's bound: queue-reliability.test.ts (the test named
//      under 6) via _testSetConsumerDrainTimeout(300). Nothing added.
//
// Seam: the bare DI manager (createAgentManager + configureAgentTurnDeps + the
// event sink) over a FakeBackend, so dormant / sessionSwapping / state events
// and chat entries are observed directly with no route noise. Assertions read
// the sink from a pre-action index so older entries cannot satisfy them, and
// never read console output. Codex-typed agents keep the Claude resume
// preflight out of the way; storedSessionState "durable" makes a replacement
// resume the same thread, as production Codex does.

import { describe, it, expect, afterEach } from "bun:test";
import {
  FakeBackend,
  type FakeSession,
  type FakeSessionConfig,
} from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentInfo, LogEntry, RoomWire } from "../../shared/types.ts";
import type { AgentEvent } from "../internal-types.ts";
import type { ContextUsage } from "../backends/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";

type Manager = ReturnType<typeof createAgentManager>;

const WAIT_MS = 3000;
// Safety net for a test that fails while a drain is parked: well above every
// deliberate mid-drain pause below, well below the 15 s production bound.
const DRAIN_BOUND_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function rooms(): RoomWire[] {
  return [
    { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
  ];
}

// Every send pushes one text event and never completes the turn, so a turn
// stays parked until the test settles it.
function parkingBackend(extra?: FakeSessionConfig): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      ...extra,
    },
  });
}

interface Lane {
  mgr: Manager;
  fake: FakeBackend;
  events: AgentEvent[];
  prevDrainBound: number;
}

const lanes: Lane[] = [];
const openGates: Array<() => void> = [];

function makeLane(fake: FakeBackend, opts?: { sampleWaitMs?: number }): Lane {
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms() }),
    initialRooms: [],
    eventSink: (e) => events.push(e),
  });
  mgr.configureAgentTurnDeps(opts?.sampleWaitMs);
  const prevDrainBound = mgr._testSetConsumerDrainTimeout(DRAIN_BOUND_MS);
  const lane = { mgr, fake, events, prevDrainBound };
  lanes.push(lane);
  return lane;
}

afterEach(() => {
  for (const open of openGates.splice(0)) open();
  for (const lane of lanes.splice(0)) {
    lane.mgr._testSetConsumerDrainTimeout(lane.prevDrainBound);
    // Release every consumer, including streams parked by hangOnClose.
    for (const s of lane.fake.sessions) {
      s.close();
      s.endStream();
    }
  }
});

async function spawnLazy(
  mgr: Manager,
  agentType: AgentInfo["agentType"],
  name = "Worker",
): Promise<AgentInfo> {
  const info = await mgr.spawn(
    name,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

// getAllAgents, not getAgent: only the former splices the live queue (and the
// derived pendingPrompt) into the wire shape.
function agentOf(mgr: Manager, id: string): AgentInfo {
  const a = mgr.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

function stateOf(mgr: Manager, id: string): string {
  return agentOf(mgr, id).state;
}

function sessionsFor(fake: FakeBackend, id: string): FakeSession[] {
  return fake.sessions.filter((s) => s.opts.agentId === id);
}

function sentTo(session: FakeSession, needle: string): boolean {
  return session.sent.some((m) => m.text.includes(needle));
}

// Chat entries for `id` emitted after index `from` of the sink. Read from the
// sink, not getAgentLogs: a fresh-wake clear wipes the log cache, the sink
// keeps what the user was shown.
function entriesSince(events: AgentEvent[], id: string, from: number) {
  const out: LogEntry[] = [];
  for (const e of events.slice(from)) {
    if (e.type === "log_entry" && e.entry.agentId === id) out.push(e.entry);
  }
  return out;
}

function errorsSince(events: AgentEvent[], id: string, from: number) {
  return entriesSince(events, id, from)
    .filter((e) => e.kind === "error")
    .map((e) => e.content);
}

// The dormant / sessionSwapping flips for `id` after index `from`, in order,
// as "flag:value" strings. Other agent_updated changes (privileged, state) are
// filtered out so an unrelated update cannot shift the sequence.
function flagChanges(events: AgentEvent[], id: string, from: number) {
  const out: string[] = [];
  for (const e of events.slice(from)) {
    if (e.type !== "agent_updated" || e.agentId !== id) continue;
    if ("sessionSwapping" in e.changes)
      out.push(`sessionSwapping:${String(e.changes.sessionSwapping)}`);
    if ("dormant" in e.changes) out.push(`dormant:${String(e.changes.dormant)}`);
  }
  return out;
}

function stateChanges(events: AgentEvent[], id: string, from: number) {
  const out: string[] = [];
  for (const e of events.slice(from)) {
    if (e.type === "agent_updated" && e.agentId === id && e.changes.state)
      out.push(e.changes.state);
  }
  return out;
}

// The textarea path. Fire-and-forget: the promise settles only when the turn
// ends, and parked turns end in afterEach.
function humanSend(mgr: Manager, id: string, text: string): void {
  void mgr.sendMessage(id, text, "tester").catch(() => {});
}

// The queue path (accept-then-flush when idle, queued when busy).
function agentSend(mgr: Manager, id: string, text: string): void {
  const r = mgr.enqueueMessage(id, {
    sender: {
      kind: "agent",
      agentId: "peer",
      agentName: "Peer",
      roomName: "room-a",
    },
    text,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
}

// Wake a lazy agent and park it mid-turn on the textarea path.
async function parkHumanTurn(
  lane: Lane,
  id: string,
  text: string,
): Promise<FakeSession> {
  const before = sessionsFor(lane.fake, id).length;
  humanSend(lane.mgr, id, text);
  await waitUntil(
    () =>
      sessionsFor(lane.fake, id).length === before + 1 &&
      sentTo(sessionsFor(lane.fake, id)[before], text),
    `turn parked: ${text}`,
  );
  await waitUntil(() => stateOf(lane.mgr, id) === "thinking", "busy");
  return sessionsFor(lane.fake, id)[before];
}

// Wake a lazy agent and let its first turn complete, so it sits idle on a live
// session (the precondition for an out-of-band swap).
async function wakeToIdle(lane: Lane, id: string): Promise<FakeSession> {
  const s = await parkHumanTurn(lane, id, "kickoff");
  s.completeTurn();
  await waitUntil(
    () => stateOf(lane.mgr, id) === "waiting_for_response",
    "idle with a live session",
  );
  return s;
}

describe("session lifecycle: replaceSession closes, drains, then installs", () => {
  it("closes the old session and starts the replacement's consumer only after the old consumer drains, flipping dormant inside the sessionSwapping window", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const old = await wakeToIdle(lane, agent.id);
    const from = lane.events.length;

    // Out-of-band swap; the old stream never ends on close(), so the swap
    // parks on the drain and the mid-drain state is observable.
    const swap = lane.mgr.setPrivileged(agent.id, true);
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "swap draining",
    );
    expect(old.closed).toBe(true);
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    const replacement = sessionsFor(lane.fake, agent.id)[1];
    expect(replacement.isResume).toBe(true);
    // Consumer order first: the replacement exists but nothing consumes it
    // yet, so an event pushed into it stays buffered until the old consumer
    // has drained. Asserted before the dormant flag on purpose - a swap that
    // installs before the drain also flips dormant back, and this line is the
    // one that names the order.
    replacement.push({ kind: "assistant_text", text: "mid-drain-text" });
    await sleep(100);
    expect(
      entriesSince(lane.events, agent.id, from).some((e) =>
        e.content.includes("mid-drain-text"),
      ),
    ).toBe(false);
    // The slot is released and flagged dormant for the whole drain window.
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(true);
    expect(agentOf(lane.mgr, agent.id).sessionSwapping).toBe(true);

    // Release the drain: the replacement installs and its buffer flows.
    old.endStream();
    await swap;
    await waitUntil(
      () =>
        entriesSince(lane.events, agent.id, from).some((e) =>
          e.content.includes("mid-drain-text"),
        ),
      "replacement consumer live after the drain",
    );
    const after = agentOf(lane.mgr, agent.id);
    expect(after.sessionSwapping).toBe(false);
    expect(after.dormant).toBe(false);
    expect(after.privileged).toBe(true);
    expect(flagChanges(lane.events, agent.id, from)).toEqual([
      "sessionSwapping:true",
      "dormant:true",
      "dormant:false",
      "sessionSwapping:false",
    ]);
  });

  it("an out-of-band swap rejects the in-flight human turn with SessionSwappedError: the caller stays quiet and the busy state is normalized", async () => {
    const lane = makeLane(parkingBackend());
    const agent = await spawnLazy(lane.mgr, "codex");
    const old = await parkHumanTurn(lane, agent.id, "long task");
    const from = lane.events.length;

    await lane.mgr.setPrivileged(agent.id, true);

    expect(old.closed).toBe(true);
    // sendMessage's catch swallows SessionSwappedError: no error entry, no
    // error state. Any other rejection type would have logged "Error: ..."
    // and parked the agent in error before the swap finished.
    expect(errorsSince(lane.events, agent.id, from)).toEqual([]);
    expect(stateChanges(lane.events, agent.id, from)).not.toContain("error");
    // Post-swap normalization: the pre-swap turn is dead, so the busy state it
    // claimed is released.
    await waitUntil(
      () => stateOf(lane.mgr, agent.id) === "waiting_for_response",
      "busy state normalized post-swap",
    );
    const sessions = sessionsFor(lane.fake, agent.id);
    expect(sessions.length).toBe(2);
    expect(sessions[1].sent).toEqual([]);
  });
});

describe("session lifecycle: installSession on a lazy first-message wake", () => {
  it("keeps the claimed live turn: inFlightTurn reports the turn that began before the install", async () => {
    const lane = makeLane(parkingBackend());
    const agent = await spawnLazy(lane.mgr, "codex");
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(true);
    expect(lane.fake.createSessionCount).toBe(0);

    // sendMessage claims the turn (beginTurn) BEFORE wakeSessionForSend
    // installs the session; the install must not reset that clock.
    const t0 = Date.now();
    const session = await parkHumanTurn(lane, agent.id, "hello");
    expect(session.sent.length).toBe(1);
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(false);
    const inFlight = lane.mgr.inFlightTurnForLogs(agent.id);
    expect(inFlight).not.toBeNull();
    if (!inFlight) throw new Error("no in-flight turn reported");
    expect(inFlight.startedAt).toBeGreaterThanOrEqual(t0);
    expect(inFlight.startedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("session lifecycle: clean stream end in the pre-send window", () => {
  it("releases the claimed busy state; the parked flush bails and the queued item delivers on a replacement session", async () => {
    // A context sample that parks on a gate: the kickoff's turn_completed
    // starts it, and the next flush turn's notice assembly waits on it, which
    // holds that turn in the pre-send window (state thinking, no pendingTurn).
    // Claude-typed on purpose: the notice block is skipped for Codex and
    // OpenCode, so only a Claude agent has this window.
    let armed = true;
    let signalEntered!: () => void;
    let openGate!: () => void;
    const entered = new Promise<void>((r) => (signalEntered = r));
    const gate = new Promise<void>((r) => (openGate = r));
    openGates.push(openGate);
    const sample = async (): Promise<ContextUsage | null> => {
      if (!armed) return null;
      armed = false;
      signalEntered();
      await gate;
      return null;
    };
    const lane = makeLane(
      new FakeBackend({
        storedSessionState: "missing",
        session: {
          onSend: (_t, _a, s) =>
            s.push({ kind: "assistant_text", text: "..." }),
          contextUsage: sample,
        },
      }),
      { sampleWaitMs: 1500 },
    );
    const agent = await spawnLazy(lane.mgr, "claude");

    agentSend(lane.mgr, agent.id, "kickoff");
    await waitUntil(
      () =>
        sessionsFor(lane.fake, agent.id).length === 1 &&
        sentTo(sessionsFor(lane.fake, agent.id)[0], "kickoff"),
      "kickoff sent",
    );
    const s1 = sessionsFor(lane.fake, agent.id)[0];
    agentSend(lane.mgr, agent.id, "queued-1");
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).queue.length === 1,
      "second item queued",
    );
    s1.completeTurn();
    await entered;
    await waitUntil(
      () => stateOf(lane.mgr, agent.id) === "thinking",
      "flush claimed the turn pre-send",
    );
    expect(agentOf(lane.mgr, agent.id).queue.length).toBe(1);
    expect(s1.sent.length).toBe(1);
    const from = lane.events.length;

    // The backend dies inside the pre-send window: no owner will ever reset
    // the claimed busy state, so runConsumer's no-owner branch must.
    s1.endStream();
    await waitUntil(
      () => stateOf(lane.mgr, agent.id) === "waiting_for_response",
      "no-owner busy state normalized",
    );
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(true);
    expect(lane.mgr._testDormantReason(agent.id)).toBe("stream-ended");
    expect(s1.sent.length).toBe(1);

    // Open the gate: the parked flush must bail on the cancel-token bump
    // instead of sending into the released slot, and the re-flush wakes a
    // replacement that carries the item.
    openGate();
    const delivered = () =>
      sessionsFor(lane.fake, agent.id).length === 2 &&
      sentTo(sessionsFor(lane.fake, agent.id)[1], "queued-1");
    await waitUntil(
      () => delivered() || errorsSince(lane.events, agent.id, from).length > 0,
      "flush settled after the gate",
    );
    expect(errorsSince(lane.events, agent.id, from)).toEqual([]);
    expect(delivered()).toBe(true);
    expect(sentTo(s1, "queued-1")).toBe(false);
    expect(
      entriesSince(lane.events, agent.id, from).some(
        (e) =>
          e.kind === "system" &&
          e.content.includes("Queue flush interrupted by session change"),
      ),
    ).toBe(true);
    expect(stateOf(lane.mgr, agent.id)).toBe("thinking");
  });
});

describe("session lifecycle: abort during a turn", () => {
  it("a human message sent during the slow-path abort drain waits for the replacement instead of waking its own session", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const old = await parkHumanTurn(lane, agent.id, "long task");

    // Slow path (no in-place abort): the replacement is created up front and
    // the swap parks on the hung drain.
    const abortDone = lane.mgr.abort(agent.id);
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "slow path draining",
    );
    expect(old.closed).toBe(true);
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    const replacement = sessionsFor(lane.fake, agent.id)[1];

    // The follow-up sees session === null but must wait on abortPromise, not
    // wake a session of its own.
    humanSend(lane.mgr, agent.id, "follow-up");
    await sleep(100);
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    expect(replacement.sent.length).toBe(0);

    old.endStream();
    expect(await abortDone).toEqual({ ok: true });
    await waitUntil(
      () => sentTo(replacement, "follow-up"),
      "follow-up delivered into the replacement",
    );
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    expect(sentTo(old, "follow-up")).toBe(false);
    expect(replacement.closed).toBe(false);
  });

  it("hot abort drops the interrupted turn's events until turn_completed(interrupted), which settles quietly on the same session", async () => {
    const lane = makeLane(parkingBackend({ abortInPlace: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const session = await parkHumanTurn(lane, agent.id, "long task");
    const from = lane.events.length;

    const abortDone = lane.mgr.abort(agent.id);
    await waitUntil(() => session.abortCount === 1, "interrupt sent");
    // The cancelled turn keeps streaming for a moment; none of it may reach
    // the user or the state machine.
    session.push({ kind: "assistant_text", text: "leak-after-interrupt" });
    session.push({
      kind: "tool_call",
      toolUseId: "tool-1",
      name: "Bash",
      input: {},
    });
    await sleep(50);
    expect(
      entriesSince(lane.events, agent.id, from).some((e) =>
        e.content.includes("leak-after-interrupt"),
      ),
    ).toBe(false);
    expect(stateOf(lane.mgr, agent.id)).toBe("waiting_for_response");

    session.push({ kind: "turn_completed", status: "interrupted" });
    expect(await abortDone).toEqual({ ok: true });
    await sleep(50);
    expect(errorsSince(lane.events, agent.id, from)).toEqual([]);
    expect(stateChanges(lane.events, agent.id, from)).not.toContain("error");
    expect(stateOf(lane.mgr, agent.id)).toBe("waiting_for_response");
    expect(
      entriesSince(lane.events, agent.id, from).some(
        (e) => e.kind === "system" && e.content === "Agent interrupted.",
      ),
    ).toBe(true);
    // The session survived the interrupt: no replacement, nothing closed.
    expect(sessionsFor(lane.fake, agent.id).length).toBe(1);
    expect(session.closed).toBe(false);
  });

  it("turn_completed(failed) while aborting is a dirty interrupt: logged as a Codex exit, then the slow path installs a replacement session on the same thread and restores idle", async () => {
    const lane = makeLane(parkingBackend({ abortInPlace: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const session = await parkHumanTurn(lane, agent.id, "long task");
    const from = lane.events.length;

    const abortDone = lane.mgr.abort(agent.id);
    await waitUntil(() => session.abortCount === 1, "interrupt sent");
    // The subprocess exits mid-interrupt (the adapter synthesizes a failed
    // turn_completed).
    session.push({ kind: "turn_completed", status: "failed", error: "boom" });
    expect(await abortDone).toEqual({ ok: true });

    expect(errorsSince(lane.events, agent.id, from)).toEqual([
      "Codex exited during interrupt: boom",
    ]);
    expect(session.closed).toBe(true);
    const sessions = sessionsFor(lane.fake, agent.id);
    expect(sessions.length).toBe(2);
    // Durable thread: the replacement backend session resumes the same id.
    expect(sessions[1].isResume).toBe(true);
    expect(sessions[1].sessionId).toBe(session.sessionId);
    expect(stateOf(lane.mgr, agent.id)).toBe("waiting_for_response");
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(false);
  });

  it("the aborting flag outlives the slow-path drain: a flush turn cancelled by Stop stays quiet and its queue delivers after the swap", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");

    // Queue-path turn in flight, with a second item queued behind it.
    agentSend(lane.mgr, agent.id, "kickoff");
    await waitUntil(
      () =>
        sessionsFor(lane.fake, agent.id).length === 1 &&
        sentTo(sessionsFor(lane.fake, agent.id)[0], "kickoff"),
      "kickoff flush sent",
    );
    const old = sessionsFor(lane.fake, agent.id)[0];
    await waitUntil(() => stateOf(lane.mgr, agent.id) === "thinking", "busy");
    agentSend(lane.mgr, agent.id, "queued-2");
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).queue.length === 1,
      "second item queued",
    );
    const from = lane.events.length;

    // Stop: closeAndDrainSession rejects the flush turn while `aborting` is
    // still true, so flushQueue's catch reads a user-initiated cancel and
    // stays quiet.
    const abortDone = lane.mgr.abort(agent.id);
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "slow path draining",
    );
    await sleep(50);
    const noisy = () =>
      entriesSince(lane.events, agent.id, from).some((e) =>
        e.content.includes("Queue flush interrupted by session change"),
      );
    expect(noisy()).toBe(false);

    old.endStream();
    expect(await abortDone).toEqual({ ok: true });
    await waitUntil(
      () =>
        sessionsFor(lane.fake, agent.id).length === 2 &&
        sentTo(sessionsFor(lane.fake, agent.id)[1], "queued-2"),
      "queued item delivered post-swap",
    );
    expect(noisy()).toBe(false);
    expect(
      entriesSince(lane.events, agent.id, from).some(
        (e) => e.kind === "system" && e.content === "Agent interrupted.",
      ),
    ).toBe(true);
    expect(sentTo(old, "queued-2")).toBe(false);
  });
});
