// Task 6f6e8ed7: a handoff carries the receiver's queue to the fresh session,
// behind the brief; the resets that still clear the queue say how many
// messages they cleared.
//
// Seam: the DI manager (createAgentManager + FakeBackend), as in
// steer-boundary.test.ts. Every send parks its turn until the test calls
// completeTurn(), so the receiver is held mid-turn while messages queue.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { blockAtomicFileReplacement, removeStateDir } from "./temp-state.ts";
import { loadMessageQueuesRaw } from "../persistence.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorForLanguage } from "../i18n.ts";
import {
  FakeBackend,
  type FakeBackendConfig,
  type FakeSession,
} from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import type {
  AgentInfo,
  Attachment,
  LogEntry,
  QueuedMessage,
  RoomWire,
} from "../../shared/types.ts";

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
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];

const SENDER: QueuedMessage["sender"] = {
  kind: "agent",
  agentId: "agent-sender",
  agentName: "Sender",
  roomName: "room-a",
};

const ATTACHMENT: Attachment = {
  filename: "notes_1.txt",
  originalName: "notes.txt",
  mediaType: "text/plain",
  size: 12,
};

const en = translatorForLanguage("en");

function fakeBackend(cfg: FakeBackendConfig = {}): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
    ...cfg,
  });
}

interface QueueEvent {
  ids: string[];
  persistedIds: string[];
}

function makeManager(fake: FakeBackend) {
  const logs: LogEntry[] = [];
  // Every queue the manager announces, with what disk held at that moment.
  const queueEvents: QueueEvent[] = [];
  // Set to an event type to make the sink throw once on it: a synchronous
  // throw inside the manager's emit.
  const fault: { throwOnce: string | null } = { throwOnce: null };
  const sink: EventHandler = (e) => {
    const ev = e as {
      type?: string;
      agentId?: string;
      entry?: LogEntry;
      changes?: { queue?: QueuedMessage[] };
    };
    if (fault.throwOnce !== null && ev.type === fault.throwOnce) {
      fault.throwOnce = null;
      throw new Error("injected sink fault");
    }
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
    if (ev.type === "agent_updated" && ev.changes?.queue && ev.agentId) {
      queueEvents.push({
        ids: ev.changes.queue.map((m) => m.id),
        persistedIds: persistedQueue(ev.agentId).map((m) => m.id),
      });
    }
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return { mgr, logs, queueEvents, fault };
}

type Manager = ReturnType<typeof makeManager>["mgr"];

async function spawn(mgr: Manager): Promise<AgentInfo> {
  const info = await mgr.spawn(
    "Receiver",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

const stateOf = (mgr: Manager, id: string) => mgr.getAgent(id)?.state;

function visibleQueue(mgr: Manager, id: string): QueuedMessage[] {
  return mgr.getAllAgents().find((a) => a.id === id)?.queue ?? [];
}

function persistedQueue(id: string): QueuedMessage[] {
  const rec = loadMessageQueuesRaw()[id] as
    | { queue?: QueuedMessage[] }
    | undefined;
  return rec?.queue ?? [];
}

// Start a turn and wait until the receiver is running it.
async function startTurn(
  mgr: Manager,
  fake: FakeBackend,
  id: string,
): Promise<FakeSession> {
  void mgr.sendMessage(id, "kickoff");
  await waitUntil(
    () =>
      stateOf(mgr, id) === "thinking" &&
      !!fake.sessionForAgent(id)?.sent.some((m) => m.text === "kickoff"),
    "kickoff turn running",
  );
  return fake.sessionForAgent(id)!;
}

function queueWhileBusy(mgr: Manager, id: string, text: string, extra = {}) {
  const r = mgr.enqueueMessage(id, { sender: SENDER, text, ...extra });
  expect(r).toMatchObject({ ok: true, queued: true });
  return r.ok ? r.messageId! : "";
}

// The fresh session that the handoff woke, once it has received its first
// prompt. Fails fast when no other session appears.
async function freshSession(
  fake: FakeBackend,
  id: string,
  old: FakeSession,
): Promise<FakeSession> {
  await waitUntil(() => {
    const cur = fake.sessionForAgent(id);
    return !!cur && cur !== old && cur.sent.length > 0;
  }, "fresh session received its first prompt");
  return fake.sessionForAgent(id)!;
}

function expectInOrder(text: string, needles: string[]) {
  const at = needles.map((n) => text.indexOf(n));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

const BRIEF = "HANDOFF-BRIEF: carry on from step 3.";

describe("handoff carries the queue to the fresh session", () => {
  it("one prompt holds the brief first, then each carried message with its sender and attachment; ids and disk copy are kept", async () => {
    const fake = fakeBackend();
    const { mgr, queueEvents } = makeManager(fake);
    const info = await spawn(mgr);
    const dir = join(STATE_ROOT, "logs", info.id, "files");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ATTACHMENT.filename), "hello notes\n");
    const old = await startTurn(mgr, fake, info.id);
    const firstId = queueWhileBusy(mgr, info.id, "CARRIED-ONE", {
      attachments: [ATTACHMENT],
    });
    const secondId = queueWhileBusy(mgr, info.id, "CARRIED-TWO");
    const eventsBefore = queueEvents.length;

    const r = await mgr.handoff(info.id, BRIEF);
    expect(r.ok).toBe(true);
    const briefId = r.ok ? r.messageId! : "";

    const fresh = await freshSession(fake, info.id, old);
    expect(fresh.sent).toHaveLength(1);
    const prompt = fresh.sent[0].text;
    // The brief leads the prompt: nothing (no busy-turn note) comes before it.
    expect(prompt.split("\n\n")[0]).toContain(BRIEF);
    expectInOrder(prompt, [BRIEF, "CARRIED-ONE", "CARRIED-TWO"]);
    expect(prompt).toContain("agent-sender");
    expect(fresh.sent[0].attachments).toEqual([ATTACHMENT]);
    // The old session never saw the carried messages.
    expect(old.sent.map((m) => m.text).join("\n")).not.toContain("CARRIED");

    // Same ids throughout. Each announced queue during the handoff holds the
    // carried items, on disk too, until the fresh session's send drains it.
    const during = queueEvents.slice(eventsBefore);
    expect(during[0].ids).toEqual([briefId, firstId, secondId]);
    expect(during[0].persistedIds).toEqual([briefId, firstId, secondId]);
    for (const ev of during.slice(0, -1)) {
      expect(ev.ids).toContain(firstId);
      expect(ev.persistedIds).toContain(firstId);
    }
    expect(during.at(-1)!.ids).toEqual([]);
  });

  it("an agent at rest after a turn: the brief goes to a fresh session, not the old one", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const old = await startTurn(mgr, fake, info.id);
    old.completeTurn();
    await waitUntil(
      () => stateOf(mgr, info.id) === "waiting_for_response",
      "at rest after the turn",
    );

    expect((await mgr.handoff(info.id, BRIEF)).ok).toBe(true);
    const fresh = await freshSession(fake, info.id, old);
    expect(fresh.sent[0].text).toContain(BRIEF);
    expect(old.sent.some((m) => m.text.includes(BRIEF))).toBe(false);
  });

  it("a tool-boundary item the old session claimed but did not finish is carried too", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const old = await startTurn(mgr, fake, info.id);
    const r = mgr.enqueueMessage(
      info.id,
      { sender: SENDER, text: "STEERED" },
      { steer: true },
    );
    expect(r).toMatchObject({ ok: true, steered: true });
    expect(old.toolBoundary()).toContain("STEERED");
    // Claimed: off the visible queue, still on disk.
    expect(visibleQueue(mgr, info.id)).toHaveLength(0);
    expect(persistedQueue(info.id).map((m) => m.text)).toEqual(["STEERED"]);

    expect((await mgr.handoff(info.id, BRIEF)).ok).toBe(true);
    const fresh = await freshSession(fake, info.id, old);
    expectInOrder(fresh.sent[0].text, [BRIEF, "STEERED"]);
  });

  it("the old turn's flush ends with no flush-interrupted notice in the fresh chat", async () => {
    const fake = fakeBackend();
    const { mgr, logs } = makeManager(fake);
    const info = await spawn(mgr);
    // An agent message starts the turn, so the handing-off turn is a flush turn.
    mgr.enqueueMessage(info.id, { sender: SENDER, text: "FLUSHED-KICKOFF" });
    await waitUntil(
      () =>
        stateOf(mgr, info.id) === "thinking" &&
        !!fake.sessionForAgent(info.id)?.sent.length,
      "flush turn running",
    );
    const old = fake.sessionForAgent(info.id)!;
    queueWhileBusy(mgr, info.id, "CARRIED-ONE");

    expect((await mgr.handoff(info.id, BRIEF)).ok).toBe(true);
    const fresh = await freshSession(fake, info.id, old);
    expectInOrder(fresh.sent[0].text, [BRIEF, "CARRIED-ONE"]);
    const interrupted = en.t("systemEntries.flushInterrupted");
    expect(logs.some((e) => e.content === interrupted)).toBe(false);
  });

  it("a throw inside the reset leaves the held queue in memory, and the next write keeps it on disk", async () => {
    const fake = fakeBackend();
    const { mgr, fault } = makeManager(fake);
    const info = await spawn(mgr);
    await startTurn(mgr, fake, info.id);
    queueWhileBusy(mgr, info.id, "CARRIED-ONE");
    expect(visibleQueue(mgr, info.id).map((m) => m.text)).toEqual([
      "CARRIED-ONE",
    ]);
    expect(persistedQueue(info.id).map((m) => m.text)).toEqual(["CARRIED-ONE"]);

    // clear_logs is emitted while the queue is held aside.
    fault.throwOnce = "clear_logs";
    const thrown = await mgr.handoff(info.id, BRIEF).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(thrown)).toContain("injected sink fault");
    expect(fault.throwOnce).toBeNull();
    expect(visibleQueue(mgr, info.id).map((m) => m.text)).toEqual([
      BRIEF,
      "CARRIED-ONE",
    ]);

    queueWhileBusy(mgr, info.id, "LATER");
    expect(persistedQueue(info.id).map((m) => m.text)).toEqual([
      BRIEF,
      "CARRIED-ONE",
      "LATER",
    ]);
  });

  it("a full queue does not block the handoff: every queued message follows the brief", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const old = await startTurn(mgr, fake, info.id);
    const texts: string[] = [];
    for (;;) {
      const text = `FILL-${String(texts.length).padStart(3, "0")}`;
      const r = mgr.enqueueMessage(info.id, { sender: SENDER, text });
      if (!r.ok) {
        expect(r.error).toBe("queue_full");
        break;
      }
      texts.push(text);
    }

    expect((await mgr.handoff(info.id, BRIEF)).ok).toBe(true);
    const fresh = await freshSession(fake, info.id, old);
    expectInOrder(fresh.sent[0].text, [BRIEF, ...texts]);
  });

  it("a failed durable write refuses the handoff and leaves the session and queue as they were", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const old = await startTurn(mgr, fake, info.id);
    const queuedId = queueWhileBusy(mgr, info.id, "CARRIED-ONE");

    const storePath = join(STATE_ROOT, "message-queues.json");
    blockAtomicFileReplacement(storePath);
    const r = await mgr.handoff(info.id, BRIEF);
    rmSync(storePath, { recursive: true, force: true });
    expect(r).toMatchObject({ ok: false, error: "persist_failed" });

    // Not reset: same live session, still mid-turn, queue unchanged.
    expect(fake.sessionForAgent(info.id)).toBe(old);
    expect(old.closed).toBe(false);
    expect(stateOf(mgr, info.id)).toBe("thinking");
    expect(visibleQueue(mgr, info.id).map((m) => m.id)).toEqual([queuedId]);

    // The turn ends; the queued message goes to the same session, no brief.
    old.completeTurn();
    await waitUntil(
      () => old.sent.some((m) => m.text.includes("CARRIED-ONE")),
      "queued message delivered after the refused handoff",
    );
    expect(old.sent.some((m) => m.text.includes(BRIEF))).toBe(false);
  });
});

describe("resets that clear the queue say how many messages they cleared", () => {
  const cleared = (n: number) =>
    en.tn("systemEntries.queueCleared.newConversation", n);

  async function busyWithTwoQueued() {
    const fake = fakeBackend();
    const made = makeManager(fake);
    const info = await spawn(made.mgr);
    await startTurn(made.mgr, fake, info.id);
    queueWhileBusy(made.mgr, info.id, "DROPPED-ONE");
    queueWhileBusy(made.mgr, info.id, "DROPPED-TWO");
    return { ...made, fake, info };
  }

  it("new conversation", async () => {
    const { mgr, logs, info } = await busyWithTwoQueued();
    await mgr.newConversation(info.id);
    expect(visibleQueue(mgr, info.id)).toHaveLength(0);
    expect(persistedQueue(info.id)).toHaveLength(0);
    expect(logs.filter((e) => e.content === cleared(2))).toHaveLength(1);
  });

  it("typed /clear, which also empties the disk copy", async () => {
    const { mgr, logs, info } = await busyWithTwoQueued();
    expect(persistedQueue(info.id).map((m) => m.text)).toEqual([
      "DROPPED-ONE",
      "DROPPED-TWO",
    ]);
    await mgr.sendMessage(info.id, "/clear");
    await waitUntil(() => stateOf(mgr, info.id) === "idle", "cleared");
    expect(visibleQueue(mgr, info.id)).toHaveLength(0);
    expect(persistedQueue(info.id)).toHaveLength(0);
    expect(logs.filter((e) => e.content === cleared(2))).toHaveLength(1);
  });

  it("engine switch", async () => {
    const { mgr, logs, info } = await busyWithTwoQueued();
    await mgr.editAgent(info.id, { agentType: "codex" });
    expect(visibleQueue(mgr, info.id)).toHaveLength(0);
    expect(logs.filter((e) => e.content === cleared(2))).toHaveLength(1);
  });

  it("an empty queue writes no count", async () => {
    const fake = fakeBackend();
    const { mgr, logs } = makeManager(fake);
    const info = await spawn(mgr);
    await startTurn(mgr, fake, info.id);
    const from = logs.length;
    await mgr.newConversation(info.id);
    expect(
      logs
        .slice(from)
        .filter((e) => e.kind === "system")
        .map((e) => e.content),
    ).toEqual([en.t("systemEntries.newConversation")]);
  });
});
