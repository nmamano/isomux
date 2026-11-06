// The queue flush state and its one entry point, requestFlush (task e7cd6259,
// internal-docs/implicit-state-machines.md entry 2). Each trigger path
// delivers a waiting message with the queue watchdog never swept: the tests
// never call sweepStuckFlushes, so a missed trigger stays missed. Seam: the
// DI manager (createAgentManager + FakeBackend); a turn parks until the test
// completes it.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  dropBackendHold,
  flushRunning,
  hasBackendHold,
  holdBackend,
  holdQueue,
  newFlushState,
  queueHeld,
  releaseHold,
} from "../queue-flush.ts";
import type { ContextUsage } from "../backends/types.ts";
import type { ManagedAgent } from "../internal-types.ts";
import type { AgentInfo, QueuedMessage, RoomWire } from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
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
// Long enough for a flush that is NOT supposed to happen to have happened.
const settle = () => sleep(150);

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const SENDER: QueuedMessage["sender"] = {
  kind: "agent",
  agentId: "agent-sender",
  agentName: "Sender",
  roomName: "room-a",
};

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  // What the next getContextUsage reports, and how long it takes.
  measure: { now: ContextUsage | null; delayMs: number };
}

function makeHarness(
  opts: { hangOnClose?: boolean; sampleWaitMs?: number } = {},
): Harness {
  const measure: Harness["measure"] = { now: null, delayMs: 0 };
  const fake = new FakeBackend({
    session: {
      hangOnClose: opts.hangOnClose ?? false,
      contextUsage: async () => {
        const now = measure.now;
        if (measure.delayMs) await sleep(measure.delayMs);
        return now;
      },
    },
  });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: () => {},
  });
  mgr.configureAgentTurnDeps(opts.sampleWaitMs);
  activeFakes.push(fake);
  return { mgr, fake, measure };
}

async function spawn(
  h: Harness,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const info = await h.mgr.spawn(
    "Receiver",
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

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
// The live queue: the AgentInfo queue view is not updated in this harness.
const queueLength = (h: Harness, id: string) =>
  h.mgr.readQueue(id)?.length ?? 0;
// Sends, across all of the agent's sessions, that carry `needle`.
const deliveries = (h: Harness, id: string, needle: string) =>
  h.fake.sessions
    .filter((s) => s.opts.agentId === id)
    .reduce(
      (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
      0,
    );

function enqueue(h: Harness, id: string, text: string): void {
  expect(h.mgr.enqueueMessage(id, { sender: SENDER, text })).toMatchObject({
    ok: true,
  });
}

// An idle agent with a live session: one message flushed, its turn completed.
async function idleWithSession(h: Harness, id: string): Promise<FakeSession> {
  enqueue(h, id, "KICKOFF");
  await waitUntil(() => deliveries(h, id, "KICKOFF") === 1, "kickoff sent");
  const s = h.fake.sessionForAgent(id)!;
  s.completeTurn({ text: "done" });
  await waitUntil(
    () => stateOf(h, id) === "waiting_for_response" && queueLength(h, id) === 0,
    "idle with a live session",
  );
  return s;
}

describe("queue flush state", () => {
  it("the backend hold is one hold however often it is put on, and each hold reason is released apart", () => {
    const m = { flush: newFlushState() } as unknown as ManagedAgent;
    expect(queueHeld(m)).toBe(false);
    expect(flushRunning(m)).toBe(false);

    holdBackend(m);
    holdBackend(m);
    const a = holdQueue(m);
    const b = holdQueue(m);
    expect(hasBackendHold(m)).toBe(true);
    expect(m.flush.holds.size).toBe(3);

    // Dropping the backend hold keeps the conversation holds.
    dropBackendHold(m);
    expect(hasBackendHold(m)).toBe(false);
    expect(queueHeld(m)).toBe(true);
    // One of two conversation holds released: still held.
    releaseHold(m, a);
    expect(queueHeld(m)).toBe(true);
    releaseHold(m, b);
    expect(queueHeld(m)).toBe(false);

    m.flush.running = { startedAt: 0, rerun: false, restartWake: false };
    expect(flushRunning(m)).toBe(true);
  });
});

describe("queue flush triggers, with no watchdog sweep", () => {
  it("a held queue waits for the last hold's release, then goes out once", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await idleWithSession(h, info.id);

    const releaseFirst = h.mgr._testHoldQueue(info.id);
    const releaseSecond = h.mgr._testHoldQueue(info.id);
    enqueue(h, info.id, "HELD");
    await settle();
    expect(deliveries(h, info.id, "HELD")).toBe(0);

    releaseFirst();
    await settle();
    expect(deliveries(h, info.id, "HELD")).toBe(0);

    releaseSecond();
    await waitUntil(() => deliveries(h, info.id, "HELD") > 0, "HELD sent");
    await settle();
    expect(deliveries(h, info.id, "HELD")).toBe(1);
  });

  it("a message queued while a flush's turn runs goes out when that turn ends, with one more flush", async () => {
    const h = makeHarness();
    const info = await spawn(h);

    // The flush wakes the session and its turn parks.
    enqueue(h, info.id, "FIRST");
    await waitUntil(() => deliveries(h, info.id, "FIRST") === 1, "FIRST sent");
    expect(h.mgr._testFlushRuns(info.id)).toBe(1);
    expect(stateOf(h, info.id)).toBe("thinking");

    // Busy: the message waits behind the running flush.
    enqueue(h, info.id, "SECOND");
    await settle();
    expect(deliveries(h, info.id, "SECOND")).toBe(0);

    // The turn ends while the first flush still waits for it.
    h.fake.sessionForAgent(info.id)!.completeTurn({ text: "done" });
    await waitUntil(
      () => deliveries(h, info.id, "SECOND") === 1,
      "SECOND sent",
    );
    h.fake.sessionForAgent(info.id)!.completeTurn({ text: "done" });
    await waitUntil(
      () =>
        stateOf(h, info.id) === "waiting_for_response" &&
        queueLength(h, info.id) === 0,
      "idle with an empty queue",
    );
    await settle();
    expect(deliveries(h, info.id, "SECOND")).toBe(1);
    // FIRST's flush and SECOND's; the empty queue starts no third.
    expect(h.mgr._testFlushRuns(info.id)).toBe(2);
  });

  it("a hold put on while a flush waits stops that flush before it sends; the release sends", async () => {
    // The flush waits up to sampleWaitMs for the last turn's context sample;
    // the sample takes longer, so the flush is parked in that wait.
    const h = makeHarness({ sampleWaitMs: 400 });
    const info = await spawn(h);
    await idleWithSession(h, info.id);
    const s = h.fake.sessionForAgent(info.id)!;

    // A turn, with a message queued behind it, ends with a slow sample.
    enqueue(h, info.id, "WORK");
    await waitUntil(() => deliveries(h, info.id, "WORK") === 1, "WORK sent");
    enqueue(h, info.id, "WAITING");
    const runsBefore = h.mgr._testFlushRuns(info.id);
    h.measure.delayMs = 2000;
    s.completeTurn({ text: "done" });

    // The flush for WAITING has started and is parked in the sample wait.
    await waitUntil(
      () => h.mgr._testFlushRuns(info.id) > runsBefore,
      "flush for WAITING started",
    );
    await sleep(50);
    expect(deliveries(h, info.id, "WAITING")).toBe(0);
    const release = h.mgr._testHoldQueue(info.id);

    // The wait ends with the hold on: nothing goes out.
    await sleep(600);
    expect(deliveries(h, info.id, "WAITING")).toBe(0);
    expect(queueLength(h, info.id)).toBe(1);

    release();
    await waitUntil(
      () => deliveries(h, info.id, "WAITING") > 0,
      "WAITING sent",
    );
    await settle();
    expect(deliveries(h, info.id, "WAITING")).toBe(1);
  });

  it("a flush that defers to a session swap does not start again until the swap ends, and the swap's end sends", async () => {
    const h = makeHarness({ hangOnClose: true });
    const info = await spawn(h, "codex");
    const s1 = await idleWithSession(h, info.id);

    // The swap parks on the old session's drain.
    const swapDone = h.mgr.setPrivileged(info.id, true);
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.sessionSwapping === true,
      "swap draining",
    );
    const runsBefore = h.mgr._testFlushRuns(info.id);
    enqueue(h, info.id, "MID-SWAP");
    await settle();
    // One flush met the swap and returned; nothing asked for another.
    expect(h.mgr._testFlushRuns(info.id)).toBe(runsBefore + 1);
    expect(deliveries(h, info.id, "MID-SWAP")).toBe(0);

    s1.endStream();
    await swapDone;
    await waitUntil(
      () => deliveries(h, info.id, "MID-SWAP") > 0,
      "MID-SWAP sent after the swap",
    );
    await settle();
    expect(deliveries(h, info.id, "MID-SWAP")).toBe(1);
    expect(s1.sent.some((m) => m.text.includes("MID-SWAP"))).toBe(false);
  });
});
