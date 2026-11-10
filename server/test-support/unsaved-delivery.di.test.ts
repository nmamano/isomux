// Task 5d8e6cd4: a process killed during a turn its engine never saved leaves
// a session with no conversation in it. The office drops that session, starts
// a fresh one, and sends the messages the dead process had accepted again,
// first, with one chat line. Seam: the DI manager with a FakeBackend; the kill
// is endStream() with no turn_completed, and the engine's stored-session fact
// is FakeBackend.setStoredSessionState.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { describe, it, expect } from "bun:test";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { loadMessageQueuesRaw } from "../persistence.ts";
import type { EventHandler } from "../internal-types.ts";

type Manager = ReturnType<typeof createAgentManager>;

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

// A backend whose FIRST session never ends a turn (its process is killed in
// the test), and whose later sessions answer every send.
function backend(): { fake: FakeBackend; first: () => FakeSession } {
  const fake: FakeBackend = new FakeBackend({
    session: {
      onSend: (_t, _a, s) => {
        if (s !== fake.sessions[0]) s.completeTurn({ text: "ok" });
      },
    },
  });
  return { fake, first: () => fake.sessions[0] };
}

function manager(fake: FakeBackend, room: string, sink?: EventHandler) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms: [],
    ...(sink ? { eventSink: sink } : {}),
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

async function spawn(mgr: Manager, room: string): Promise<string> {
  const info = await mgr.spawn(
    room,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    "opencode/fake",
    "high",
    undefined,
    "opencode",
  );
  if (!info) throw new Error("spawn returned null");
  return info.id;
}

function send(
  mgr: Manager,
  id: string,
  text: string,
  clientMessageId?: string,
) {
  return mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "tester" },
    text,
    ...(clientMessageId ? { clientMessageId } : {}),
  });
}

// The entries in the agent's chat written from one catalog key.
function entriesWithKey(mgr: Manager, id: string, key: string): number {
  return mgr
    .getAgentLogs(id)
    .filter((entry) =>
      (entry.message ?? []).some(
        (part) => typeof part !== "string" && part.key.startsWith(key),
      ),
    ).length;
}

// The agent's stored queue record, as the next boot reads it.
function stored(id: string): {
  queue?: unknown[];
  unsaved?: { sessionId: string | null; items: { text: string }[] };
} {
  return (loadMessageQueuesRaw()[id] ?? {}) as ReturnType<typeof stored>;
}

const sentText = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text).join("\n");

// The first session accepted "first", then its process died before the
// engine ended the turn; the engine stored the session as `state`.
async function killFirstTurn(
  mgr: Manager,
  fake: FakeBackend,
  first: () => FakeSession,
  id: string,
  state: "empty" | "durable",
  clientMessageId?: string,
): Promise<void> {
  expect(send(mgr, id, "first", clientMessageId).ok).toBe(true);
  await waitUntil(() => (first()?.sent.length ?? 0) > 0, "first accepted");
  // Written with the drain: the record holds it, the queue does not.
  await waitUntil(
    () => (stored(id).unsaved?.items.length ?? 0) === 1,
    "record stored",
  );
  expect(stored(id).queue ?? []).toEqual([]);
  expect(stored(id).unsaved?.items[0].text).toBe("first");
  fake.setStoredSessionState(first().sessionId, state);
  first().endStream();
  await waitUntil(() => mgr.getAgent(id)?.state === "error", "process died");
}

describe("a session the engine never saved", () => {
  // MUTANTS: dropUnresumableSession without requeueUnsavedDelivery (dies on
  // the order check); no line for the requeue (dies on the line count); the
  // record never cleared at turn end (dies on the last line).
  it("is dropped, and a fresh session gets its messages again, first, with one line", async () => {
    const room = "room-unsaved-runtime";
    const { fake, first } = backend();
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    await killFirstTurn(mgr, fake, first, id, "empty");

    expect(send(mgr, id, "second").ok).toBe(true);
    await waitUntil(
      () => sentText(fake.sessions[1]).includes("second"),
      "fresh session got the new message",
    );
    expect(fake.resumeSessionCount).toBe(0);
    expect(fake.createSessionCount).toBe(2);
    const text = sentText(fake.sessions[1]);
    expect(text.indexOf("first")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(entriesWithKey(mgr, id, "systemEntries.unsavedResent")).toBe(1);
    expect(entriesWithKey(mgr, id, "systemEntries.sessionNotResumable")).toBe(
      0,
    );
    // The fresh session ended its turn: nothing is left to send again.
    await waitUntil(() => stored(id).unsaved === undefined, "record cleared");
    fake.sessions.forEach((s) => s.close());
  });

  // The control: a session the engine saved resumes, and the conversation
  // already holds what it accepted. MUTANT: resumeIdOrDrop requeueing the
  // record on a resume too dies here.
  it("is not what a saved session is: it resumes, and nothing is sent twice", async () => {
    const room = "room-unsaved-durable";
    const { fake, first } = backend();
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    await killFirstTurn(mgr, fake, first, id, "durable");

    expect(send(mgr, id, "second").ok).toBe(true);
    await waitUntil(
      () => sentText(fake.sessions[1]).includes("second"),
      "resumed session got the new message",
    );
    expect(fake.resumeSessionCount).toBe(1);
    expect(sentText(fake.sessions[1])).not.toContain("first");
    expect(entriesWithKey(mgr, id, "systemEntries.unsavedResent")).toBe(0);
    fake.sessions.forEach((s) => s.close());
  });

  // A Stop ends the turn on purpose. MUTANT: abort() without the record clear
  // dies here ("first" is sent again).
  it("after a Stop, is dropped without sending the stopped message again", async () => {
    const room = "room-unsaved-stop";
    const { fake, first } = backend();
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    expect(send(mgr, id, "first").ok).toBe(true);
    await waitUntil(() => (first()?.sent.length ?? 0) > 0, "first accepted");
    await waitUntil(() => stored(id).unsaved !== undefined, "record stored");
    fake.setStoredSessionState(first().sessionId, "empty");
    void mgr.abort(id);
    await waitUntil(() => stored(id).unsaved === undefined, "Stop cleared it");
    first().endStream();
    await waitUntil(
      () =>
        ["error", "idle", "waiting_for_response"].includes(
          mgr.getAgent(id)?.state ?? "",
        ),
      "turn over",
    );

    expect(send(mgr, id, "second").ok).toBe(true);
    const fresh = () => fake.sessions.at(-1);
    await waitUntil(
      () => fresh() !== first() && sentText(fresh()).includes("second"),
      "a later session got the new message",
    );
    expect(sentText(fresh())).not.toContain("first");
    expect(entriesWithKey(mgr, id, "systemEntries.unsavedResent")).toBe(0);
    fake.sessions.forEach((s) => s.close());
  });

  // Review finding 1: a refused send to an errored agent changes nothing.
  // MUTANT: resumeIdOrDrop before the dedupe check (the round-1 code) dies on
  // the chat and queue checks.
  it("a deduped retry to the errored agent drops nothing; the next accepted send recovers", async () => {
    const room = "room-unsaved-dedupe";
    const events: Parameters<EventHandler>[0][] = [];
    const { fake, first } = backend();
    const mgr = manager(fake, room, (e) => events.push(e));
    const id = await spawn(mgr, room);
    await killFirstTurn(mgr, fake, first, id, "empty", "client-1");
    const chatBefore = mgr.getAgentLogs(id).length;
    const clearsBefore = events.filter((e) => e.type === "clear_logs").length;

    const retry = send(mgr, id, "first", "client-1");
    expect(retry).toMatchObject({ ok: true, deduped: true });
    await sleep(50);
    expect(events.filter((e) => e.type === "clear_logs").length).toBe(
      clearsBefore,
    );
    expect(mgr.getAgentLogs(id).length).toBe(chatBefore);
    expect(stored(id).unsaved?.items.map((m) => m.text)).toEqual(["first"]);
    expect(stored(id).queue ?? []).toEqual([]);
    expect(fake.createSessionCount).toBe(1);

    expect(send(mgr, id, "second").ok).toBe(true);
    await waitUntil(
      () => sentText(fake.sessions[1]).includes("second"),
      "fresh session got the new message",
    );
    const text = sentText(fake.sessions[1]);
    expect(text.indexOf("first")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    fake.sessions.forEach((s) => s.close());
  });
});

describe("a send that a conversation change overtakes", () => {
  // Review finding 2: the send resolves after /clear installed the next
  // conversation; what it carried is not that conversation's. MUTANT:
  // runAgentTurn records without the sentTo check (dies on the last line).
  it("is not kept for the next conversation", async () => {
    const room = "room-unsaved-swap";
    const fake = new FakeBackend({ session: { manualSend: true } });
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    expect(send(mgr, id, "first").ok).toBe(true);
    const first = () => fake.sessions[0];
    await waitUntil(() => (first()?.sent.length ?? 0) > 0, "send in flight");
    expect(stored(id).unsaved).toBeUndefined();
    await mgr.newConversation(id);
    expect(mgr.getCurrentSessionId(id)).not.toBe(first().sessionId);
    first().releaseSends();
    await sleep(100);
    expect(stored(id).unsaved).toBeUndefined();
    fake.sessions.forEach((s) => s.close());
  });
});

describe("after a restart", () => {
  // The incident: the restart killed the first turn, the stored record and
  // the dropped session meet at boot. MUTANTS: agent-restore without the
  // requeue (dies on the sent check); the record not read back from disk
  // (readPersistedQueueRecord ignoring `unsaved`, same check); the items
  // pushed at the tail of the queue (dies on the order check).
  it("the boot drops the empty session and the replay sends its messages to a fresh one", async () => {
    const room = "room-unsaved-boot";
    const { fake, first } = backend();
    const before = manager(fake, room);
    const id = await spawn(before, room);
    expect(send(before, id, "the brief").ok).toBe(true);
    await waitUntil(() => (first()?.sent.length ?? 0) > 0, "brief accepted");
    await waitUntil(() => stored(id).unsaved !== undefined, "record stored");
    // A message that waits behind the running turn.
    expect(send(before, id, "later").ok).toBe(true);
    await waitUntil(() => (stored(id).queue ?? []).length === 1, "later waits");
    const sessionId = first().sessionId;
    const persisted = before.getAgent(id)!;
    // The process dies with the server; nothing ends the turn.

    const after = new FakeBackend({
      storedSessionState: (sid) => (sid === sessionId ? "empty" : "durable"),
      newSessionId: () => "fake-session-after-restart",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const mgr = createAgentManager({
      resolveBackend: () => after,
      officeState: new OfficeState({ rooms: rooms(room) }),
      initialRooms: [
        {
          id: room,
          name: room,
          prompt: null,
          agents: [
            {
              id,
              name: persisted.name,
              desk: 0,
              cwd: STATE_ROOT,
              outfit: persisted.outfit,
              permissionMode: "default",
              modelFamily: "opencode/fake",
              agentType: "opencode",
              lastSessionId: sessionId,
              topic: null,
              customInstructions: null,
              userId: null,
            },
          ],
        },
      ],
    });
    mgr.configureAgentTurnDeps();
    await mgr.restoreAgents();
    await waitUntil(
      () =>
        sentText(after.lastSession).includes("the brief") &&
        sentText(after.lastSession).includes("later"),
      "the replay sent the brief and the waiting message",
    );
    const replayed = sentText(after.lastSession);
    expect(replayed.indexOf("the brief")).toBeLessThan(
      replayed.indexOf("later"),
    );
    expect(after.resumeSessionCount).toBe(0);
    expect(after.createSessionCount).toBe(1);
    expect(entriesWithKey(mgr, id, "systemEntries.unsavedResent")).toBe(1);
    await waitUntil(() => stored(id).unsaved === undefined, "record cleared");
    fake.sessions.forEach((s) => s.close());
    after.sessions.forEach((s) => s.close());
  });
});
