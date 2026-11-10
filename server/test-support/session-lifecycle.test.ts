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
//   2. A wake during a drain: since task 082ab039 a swap holds the slot, so
//      nothing installs during its drain; pinned in "a swap holds the slot"
//      below.
//   3. installSession keeps a live turn on a lazy first-message wake: added
//      here. The idle-install residue clear has no honest public path and is an
//      S2 direct-unit obligation (ruling 8).
//   4. Clean stream end while bound. Owned turn: queue-reliability.test.ts
//      "mid-turn clean stream end fails the turn and releases the dead session;
//      no replacement turn races the dying caller, and the queued item delivers
//      after human recovery". Idle: agent-idle-eviction.di.test.ts
//      "backend-death wake: same warning, worded for an unexpected end,
//      delivered once". Added
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
//   7. Kill during a swap drain: added here with its fix (task 3e8482e2).
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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { listAgentSessions } from "../persistence.ts";

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
    if ("dormant" in e.changes)
      out.push(`dormant:${String(e.changes.dormant)}`);
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

// The access slider (task e77304b1): the tools and the token of a session
// are fixed when it is built, so the session that ends up live must be built
// after the last access change.
describe("session lifecycle: access change during a swap drain", () => {
  it("a move down while another swap drains still ends on a session built for the new stop", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "claude");
    const old = await wakeToIdle(lane, agent.id);

    // A settings swap (not an access change, so not queued behind one) parks
    // on the old consumer's drain; its replacement was built for Standard.
    expect(agentOf(lane.mgr, agent.id).effort).not.toBe("low");
    const swap = lane.mgr.editAgent(agent.id, { effort: "low" });
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "swap draining",
    );
    expect(sessionsFor(lane.fake, agent.id)).toHaveLength(2);

    // The member moves the agent below Standard inside that window.
    const moved = await lane.mgr.setAccess(agent.id, { access: "office" });
    expect(moved).toMatchObject({ access: "office" });

    old.endStream();
    await swap;
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
      "swaps settled",
    );
    // The live session (the last one built, not closed) carries the token the
    // office stop minted, not the one the drained swap was built with.
    const live = sessionsFor(lane.fake, agent.id).filter((s) => !s.closed);
    expect(live).toHaveLength(1);
    expect(live[0].opts.env?.ISOMUX_AGENT_TOKEN).toBe(
      getAgentTokenRaw(agent.id)!,
    );
  });

  it("a move down mid-turn on an engine that cannot abort in place still moves, and ends the turn's session", async () => {
    const lane = makeLane(parkingBackend());
    const agent = await spawnLazy(lane.mgr, "claude");
    const running = await parkHumanTurn(lane, agent.id, "long job");
    // As ClaudeSession: no in-place abort, and abort() rejects.
    expect(running.canAbortInPlace()).toBe(false);
    running.abort = () => Promise.reject(new Error("no in-place abort"));

    const moved = await lane.mgr.setAccess(agent.id, { access: "office" });
    expect(moved).toMatchObject({ access: "office" });
    expect(running.closed).toBe(true);
    const sessions = sessionsFor(lane.fake, agent.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].opts.env?.ISOMUX_AGENT_TOKEN).toBe(
      getAgentTokenRaw(agent.id)!,
    );
  });

  it("a kill while a move down waits on the abort leaves no live token", async () => {
    const lane = makeLane(parkingBackend());
    const agent = await spawnLazy(lane.mgr, "claude");
    const running = await parkHumanTurn(lane, agent.id, "long job");
    // An engine that stops a turn in place (not Claude), and takes its time.
    running.canAbortInPlace = () => true;
    let releaseAbort!: () => void;
    running.abort = () =>
      new Promise<void>((resolve) => {
        running.abortCount++;
        releaseAbort = resolve;
      });
    openGates.push(() => releaseAbort?.());

    const move = lane.mgr.setAccess(agent.id, { access: "office" });
    await waitUntil(() => running.abortCount > 0, "abort in flight");
    await lane.mgr.kill(agent.id);
    expect(getAgentTokenRaw(agent.id)).toBeNull();

    releaseAbort();
    await move;
    expect(lane.mgr.getAllAgents().some((a) => a.id === agent.id)).toBe(false);
    expect(getAgentTokenRaw(agent.id)).toBeNull();
  });
});

describe("session lifecycle: kill during a swap drain", () => {
  it("closes the replacement instead of installing it on the killed agent, so no backend session or consumer outlives the kill", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const old = await wakeToIdle(lane, agent.id);

    // Park the swap on the old consumer's drain, then kill inside it.
    let swapSettled = false;
    const swapDone = lane.mgr.setPrivileged(agent.id, true).then(
      () => {
        swapSettled = true;
      },
      () => {
        swapSettled = true;
      },
    );
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "swap draining",
    );
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    const replacement = sessionsFor(lane.fake, agent.id)[1];
    // Buffered before the kill: the fake's stream yields buffered events even
    // after a close, so any consumer ever started on the replacement delivers
    // this to the sink.
    const from = lane.events.length;
    replacement.push({ kind: "assistant_text", text: "orphan-text" });
    await lane.mgr.kill(agent.id);
    expect(lane.mgr.getAllAgents().some((a) => a.id === agent.id)).toBe(false);
    expect(swapSettled).toBe(false);

    old.endStream();
    await swapDone;
    await sleep(100);

    // The backend session the swap built for the killed agent is closed, and
    // nothing ever consumed it. One assertion so a failure shows both halves.
    const wasClosed = replacement.closed;
    const consumed = entriesSince(lane.events, agent.id, from).some((e) =>
      e.content.includes("orphan-text"),
    );
    expect({ wasClosed, consumed }).toEqual({
      wasClosed: true,
      consumed: false,
    });
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
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
    // Off: an automatic handoff would hold the flush for the same sample
    // before it claims the turn.
    await lane.mgr.editAgent(agent.id, { autoHandoff: false });

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

// One owner for the session slot (task 082ab039): a swap holds the slot from
// its close until its caller's post-install steps are done. A message, a
// skill, a second swap or a /clear that arrives meanwhile waits for it, so
// the conversation the swap picked is the one that ends up live.

// Two conversations on one agent: `older` (finished, then /clear) and
// `current`, live and idle on `live`.
async function twoConversations(
  lane: Lane,
  id: string,
): Promise<{ older: string; current: string; live: FakeSession }> {
  const first = await parkHumanTurn(lane, id, "first-conversation");
  first.completeTurn();
  await waitUntil(
    () => stateOf(lane.mgr, id) === "waiting_for_response",
    "first conversation idle",
  );
  const older = lane.mgr.getCurrentSessionId(id);
  if (!older) throw new Error("first conversation has no id");
  humanSend(lane.mgr, id, "/clear");
  await waitUntil(() => first.closed, "/clear closed the first process");
  first.endStream();
  await waitUntil(() => agentOf(lane.mgr, id).dormant === true, "cleared");
  const live = await parkHumanTurn(lane, id, "second-conversation");
  live.completeTurn();
  await waitUntil(
    () => stateOf(lane.mgr, id) === "waiting_for_response",
    "second conversation idle",
  );
  const current = lane.mgr.getCurrentSessionId(id);
  if (!current || current === older)
    throw new Error("second conversation has no id of its own");
  return { older, current, live };
}

// Type /resume, pick `target`, and wait until the pick's swap drains.
async function startResumePick(
  lane: Lane,
  id: string,
  target: string,
): Promise<void> {
  humanSend(lane.mgr, id, "/resume");
  await waitUntil(
    () => lane.mgr.getPendingInteractions().some((i) => i.agentId === id),
    "resume menu open",
  );
  const menu = lane.mgr.getPendingInteractions().find((i) => i.agentId === id);
  const index = menu?.choices.findIndex((c) => c.value === target) ?? -1;
  if (index < 0) throw new Error("the older conversation is not in the menu");
  humanSend(lane.mgr, id, String(index + 1));
  await waitUntil(
    () => agentOf(lane.mgr, id).sessionSwapping === true,
    "pick draining",
  );
}

function openSessions(fake: FakeBackend, id: string) {
  return sessionsFor(fake, id)
    .filter((s) => !s.closed)
    .map((s) => ({ resume: s.isResume, id: s.sessionId }));
}

// Topic generation skips a signed-out engine: a placeholder key makes the
// Codex agents count as signed in for one test. No request leaves the fake.
async function withCodexSignedIn(body: () => Promise<void>): Promise<void> {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-placeholder";
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
}

// The topic sessions.json keeps for one conversation (the resume menu label).
function topicOf(agentId: string, sessionId: string): string | null {
  return (
    listAgentSessions(agentId).find((s) => s.sessionId === sessionId)?.topic ??
    null
  );
}

function deliveries(fake: FakeBackend, id: string, needle: string): number {
  return sessionsFor(fake, id).reduce(
    (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
    0,
  );
}

describe("session lifecycle: a swap holds the slot", () => {
  it("a message sent while a /resume pick drains is delivered once, on the picked conversation, after its history replay", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const { older, live } = await twoConversations(lane, agent.id);
    const before = sessionsFor(lane.fake, agent.id).length;
    await startResumePick(lane, agent.id, older);

    const from = lane.events.length;
    humanSend(lane.mgr, agent.id, "hello-picked");
    await sleep(100);
    live.endStream();
    await waitUntil(
      () => deliveries(lane.fake, agent.id, "hello-picked") > 0,
      "message delivered",
    );
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
      "pick settled",
    );
    await sleep(50);

    // One process was started after the pick: the picked conversation, and it
    // is the one left running. The old process is closed.
    const created = sessionsFor(lane.fake, agent.id).slice(before);
    expect({
      created: created.map((s) => ({ resume: s.isResume, id: s.sessionId })),
      open: openSessions(lane.fake, agent.id),
    }).toEqual({
      created: [{ resume: true, id: older }],
      open: [{ resume: true, id: older }],
    });
    expect(live.closed).toBe(true);
    expect(lane.mgr.getCurrentSessionId(agent.id)).toBe(older);
    // Delivered once, as the one turn on the picked conversation.
    expect(deliveries(lane.fake, agent.id, "hello-picked")).toBe(1);
    expect(created[0].sent.length).toBe(1);
    // The chat shows the picked conversation's history, then the message: the
    // replay did not wipe it.
    const texts = lane.mgr
      .getAgentLogs(agent.id)
      .filter((e) => e.kind === "user_message")
      .map((e) => String(e.content));
    const replayed = texts.findIndex((t) => t.includes("first-conversation"));
    const message = texts.findIndex((t) => t.includes("hello-picked"));
    expect({ replayed: replayed >= 0, after: message > replayed }).toEqual({
      replayed: true,
      after: true,
    });
    expect(texts.some((t) => t.includes("second-conversation"))).toBe(false);
    // One busy span for the message: once its turn went busy, nothing set
    // the agent idle again before it was sent (the pick's steps run before
    // the message's turn starts, not under it).
    const states = stateChanges(lane.events, agent.id, from);
    const busyFrom = states.indexOf("thinking");
    expect({
      busy: busyFrom >= 0,
      idleAfter: states.slice(busyFrom).filter((s) => s !== "thinking"),
    }).toEqual({ busy: true, idleAfter: [] });
  });

  it("a message sent while a settings swap drains waits for the replacement and is sent there once, staying busy throughout", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const old = await wakeToIdle(lane, agent.id);
    const swap = lane.mgr.setPrivileged(agent.id, true);
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping === true,
      "swap draining",
    );
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    const replacement = sessionsFor(lane.fake, agent.id)[1];
    const from = lane.events.length;

    humanSend(lane.mgr, agent.id, "hello-mid-drain");
    await sleep(100);
    // The message does not start a process of its own.
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);

    old.endStream();
    await swap;
    await waitUntil(
      () => sentTo(replacement, "hello-mid-drain"),
      "sent on the replacement",
    );
    expect(sessionsFor(lane.fake, agent.id).length).toBe(2);
    expect(replacement.closed).toBe(false);
    expect(deliveries(lane.fake, agent.id, "hello-mid-drain")).toBe(1);
    expect(agentOf(lane.mgr, agent.id).privileged).toBe(true);
    // The message's turn claimed the busy state at once, and the swap's end
    // did not release it before the send.
    expect(stateChanges(lane.events, agent.id, from)).toEqual(["thinking"]);
  });

  it("a skill run while a /resume pick drains runs once, on the picked conversation", async () => {
    const skillName = "slotswapskill";
    const skillDir = join(STATE_ROOT, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Do the slot thing.");
    try {
      const lane = makeLane(parkingBackend({ hangOnClose: true }));
      const agent = await spawnLazy(lane.mgr, "codex");
      const { older, live } = await twoConversations(lane, agent.id);
      const before = sessionsFor(lane.fake, agent.id).length;
      await startResumePick(lane, agent.id, older);

      humanSend(lane.mgr, agent.id, `/${skillName}`);
      await sleep(100);
      live.endStream();
      await waitUntil(
        () => deliveries(lane.fake, agent.id, "Do the slot thing") > 0,
        "skill sent",
      );
      await sleep(50);

      const created = sessionsFor(lane.fake, agent.id).slice(before);
      expect(
        created.map((s) => ({ resume: s.isResume, id: s.sessionId })),
      ).toEqual([{ resume: true, id: older }]);
      expect(deliveries(lane.fake, agent.id, "Do the slot thing")).toBe(1);
      expect(sentTo(created[0], "Do the slot thing")).toBe(true);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("a second /resume while a pick drains waits for it: nothing installs before the old process drains, and the later pick ends up live", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const { older, current, live } = await twoConversations(lane, agent.id);
    const before = sessionsFor(lane.fake, agent.id).length;
    await startResumePick(lane, agent.id, older);

    // The member resumes the current conversation again before the pick of
    // the older one has finished.
    const second = lane.mgr.resume(agent.id, current);
    await sleep(100);
    // The old process still drains, so no process may be live yet.
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(true);

    live.endStream();
    // The second swap closes what the pick installed; release that drain.
    await waitUntil(
      () =>
        sessionsFor(lane.fake, agent.id)
          .slice(before)
          .some((s) => s.closed),
      "the pick's process closed by the second swap",
    );
    for (const s of sessionsFor(lane.fake, agent.id))
      if (s.closed) s.endStream();
    await second;
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
      "both swaps settled",
    );

    expect({
      open: openSessions(lane.fake, agent.id),
      sessionId: lane.mgr.getCurrentSessionId(agent.id),
    }).toEqual({ open: [{ resume: true, id: current }], sessionId: current });
  });

  it("a new conversation while a /resume pick drains wins: no process stays live and the next message starts a fresh conversation", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const { older, live } = await twoConversations(lane, agent.id);
    const before = sessionsFor(lane.fake, agent.id).length;
    await startResumePick(lane, agent.id, older);

    // The context menu's New conversation (the route; a typed /clear also
    // waits in sendMessage first).
    const cleared = lane.mgr.newConversation(agent.id);
    await sleep(100);
    live.endStream();
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
      "pick settled",
    );
    await sleep(100);
    // The reset closes what the pick installed; let that process drain.
    for (const s of sessionsFor(lane.fake, agent.id))
      if (s.closed) s.endStream();
    await cleared;
    await sleep(50);

    expect({
      open: openSessions(lane.fake, agent.id),
      sessionId: lane.mgr.getCurrentSessionId(agent.id),
    }).toEqual({ open: [], sessionId: null });
    // The chat is the cleared one: the pick's history replay came first.
    expect(
      lane.mgr
        .getAgentLogs(agent.id)
        .some((e) => String(e.content).includes("first-conversation")),
    ).toBe(false);

    humanSend(lane.mgr, agent.id, "after-clear");
    await waitUntil(
      () => deliveries(lane.fake, agent.id, "after-clear") > 0,
      "next message sent",
    );
    const target = sessionsFor(lane.fake, agent.id)
      .slice(before)
      .find((s) => sentTo(s, "after-clear"));
    expect(target?.isResume).toBe(false);
  });

  it("a /resume pick whose replacement cannot be rebuilt keeps the pick: the next message resumes the picked conversation", async () => {
    const lane = makeLane(parkingBackend({ hangOnClose: true }));
    const agent = await spawnLazy(lane.mgr, "codex");
    const { older, live } = await twoConversations(lane, agent.id);
    await startResumePick(lane, agent.id, older);

    // A token change during the drain makes the pick's replacement stale, and
    // its rebuild fails.
    const resumeSession = lane.fake.resumeSession.bind(lane.fake);
    lane.fake.resumeSession = () => {
      throw new Error("rebuild refused");
    };
    expect(await lane.mgr.setPrivileged(agent.id, true)).toMatchObject({
      privileged: true,
    });
    live.endStream();
    await waitUntil(
      () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
      "pick settled",
    );
    await sleep(50);
    lane.fake.resumeSession = resumeSession;

    expect(openSessions(lane.fake, agent.id)).toEqual([]);
    expect(agentOf(lane.mgr, agent.id).dormant).toBe(true);
    expect(lane.mgr.getCurrentSessionId(agent.id)).toBe(older);

    humanSend(lane.mgr, agent.id, "after-unbuilt");
    await waitUntil(
      () => deliveries(lane.fake, agent.id, "after-unbuilt") > 0,
      "next message sent",
    );
    const target = sessionsFor(lane.fake, agent.id).find((s) =>
      sentTo(s, "after-unbuilt"),
    );
    expect({ resume: target?.isResume, id: target?.sessionId }).toEqual({
      resume: true,
      id: older,
    });
  });

  // Topic writes during a pick's drain: sessionId already names the picked
  // conversation, so a topic for the chat still on screen must not land on it.
  it("a topic generated for the current conversation while a /resume pick drains does not relabel the picked one", async () => {
    await withCodexSignedIn(async () => {
      let releaseTopic!: (topic: string) => void;
      let calls = 0;
      const lane = makeLane(
        new FakeBackend({
          storedSessionState: "durable",
          session: {
            onSend: (_t, _a, s) =>
              s.push({ kind: "assistant_text", text: "..." }),
            hangOnClose: true,
          },
          oneShot: () => {
            calls++;
            if (calls === 1) return "topic-older";
            return new Promise<string>((resolve) => {
              releaseTopic = resolve;
            });
          },
        }),
      );
      const agent = await spawnLazy(lane.mgr, "codex");
      const { older, live } = await twoConversations(lane, agent.id);
      await waitUntil(
        () => calls === 2,
        "current conversation's topic pending",
      );
      expect(topicOf(agent.id, older)).toBe("topic-older");
      await startResumePick(lane, agent.id, older);

      releaseTopic("topic-current");
      await sleep(50);
      live.endStream();
      await waitUntil(
        () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
        "pick settled",
      );
      await sleep(50);

      expect(topicOf(agent.id, older)).toBe("topic-older");
      expect(agentOf(lane.mgr, agent.id).topic).toBe("topic-older");
    });
  });

  it("an edit while a /resume pick drains runs after it: it forks nothing and does not relabel the picked conversation", async () => {
    await withCodexSignedIn(async () => {
      let calls = 0;
      const lane = makeLane(
        new FakeBackend({
          storedSessionState: "durable",
          session: {
            onSend: (_t, _a, s) =>
              s.push({ kind: "assistant_text", text: "..." }),
            hangOnClose: true,
          },
          oneShot: () => (++calls === 1 ? "topic-older" : "topic-current"),
        }),
      );
      const agent = await spawnLazy(lane.mgr, "codex");
      const { older, live } = await twoConversations(lane, agent.id);
      await waitUntil(
        () => agentOf(lane.mgr, agent.id).topic === "topic-current",
        "current conversation labelled",
      );
      const entry = lane.mgr
        .getAgentLogs(agent.id)
        .find(
          (e) =>
            e.kind === "user_message" &&
            String(e.content).includes("second-conversation"),
        );
      if (!entry) throw new Error("no entry to edit");
      await startResumePick(lane, agent.id, older);

      const edit = lane.mgr
        .editMessage(agent.id, entry.id, "edited", "tester")
        .catch(() => {});
      await sleep(100);
      live.endStream();
      await edit;
      await waitUntil(
        () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
        "pick settled",
      );

      expect(lane.fake.forkCount).toBe(0);
      expect(topicOf(agent.id, older)).toBe("topic-older");
      expect(openSessions(lane.fake, agent.id)).toEqual([
        { resume: true, id: older },
      ]);
    });
  });

  it("a topic typed while a /resume pick drains does not relabel the picked conversation", async () => {
    await withCodexSignedIn(async () => {
      let calls = 0;
      const lane = makeLane(
        new FakeBackend({
          storedSessionState: "durable",
          session: {
            onSend: (_t, _a, s) =>
              s.push({ kind: "assistant_text", text: "..." }),
            hangOnClose: true,
          },
          oneShot: () => (++calls === 1 ? "topic-older" : "topic-current"),
        }),
      );
      const agent = await spawnLazy(lane.mgr, "codex");
      const { older, live } = await twoConversations(lane, agent.id);
      await waitUntil(
        () => agentOf(lane.mgr, agent.id).topic === "topic-current",
        "current conversation labelled",
      );
      await startResumePick(lane, agent.id, older);

      lane.mgr.setTopic(agent.id, "typed-topic");
      live.endStream();
      await waitUntil(
        () => agentOf(lane.mgr, agent.id).sessionSwapping !== true,
        "pick settled",
      );
      await sleep(50);

      expect(topicOf(agent.id, older)).toBe("topic-older");
    });
  });
});
