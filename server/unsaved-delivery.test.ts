// The record of messages a backend process accepted in a turn it has not
// ended (task 5d8e6cd4): which session it belongs to, when it goes, and what a
// message looks like when it is sent again. The flows that use it are in
// server/test-support/unsaved-delivery.di.test.ts.

import { describe, expect, it } from "bun:test";
import type { QueuedMessage } from "../shared/types.ts";
import type { BackendSession } from "./backends/types.ts";
import type { ManagedAgent } from "./internal-types.ts";
import {
  bindUnsavedSessionId,
  cleanedForSendAgain,
  clearUnsavedDeliveryOnTurnEnd,
  recordUnsavedDelivery,
  unsavedItemsToSendAgain,
} from "./unsaved-delivery.ts";

const A = {} as BackendSession;
const B = {} as BackendSession;

function agent(session: BackendSession | null, sessionId: string | null) {
  return {
    sessionManager: { session, sessionId },
    unsavedDelivery: null,
  } as unknown as ManagedAgent;
}

function item(text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: `id-${text}`,
    sender: { kind: "user", username: "tester" },
    text,
    queuedAt: 1,
    ...extra,
  };
}

const texts = (m: ManagedAgent) =>
  m.unsavedDelivery?.items.map((i) => i.text) ?? null;

describe("the record", () => {
  // MUTANT: always start a new record (dies on the append).
  it("collects the sends of one session and starts over for another", () => {
    const m = agent(A, null);
    recordUnsavedDelivery(m, [item("one")]);
    // The same process, before it reported its id.
    recordUnsavedDelivery(m, [item("two")]);
    expect(texts(m)).toEqual(["one", "two"]);
    // Another session takes the next send: the record starts over.
    (m.sessionManager as { session: BackendSession | null }).session = B;
    (m.sessionManager as { sessionId: string | null }).sessionId = "s-b";
    recordUnsavedDelivery(m, [item("three")]);
    expect(texts(m)).toEqual(["three"]);
    expect(m.unsavedDelivery?.sessionId).toBe("s-b");
    // Nothing to record changes nothing.
    expect(recordUnsavedDelivery(m, [])).toBe(false);
    expect(recordUnsavedDelivery(m, undefined)).toBe(false);
    expect(texts(m)).toEqual(["three"]);
  });

  // MUTANT: bind without the session check (dies on the second bind).
  it("takes a session id only from the process that accepted it", () => {
    const m = agent(A, null);
    recordUnsavedDelivery(m, [item("one")]);
    (m.sessionManager as { session: BackendSession | null }).session = B;
    expect(bindUnsavedSessionId(m, "s-b")).toBe(false);
    expect(m.unsavedDelivery?.sessionId).toBeNull();
    (m.sessionManager as { session: BackendSession | null }).session = A;
    expect(bindUnsavedSessionId(m, "s-a")).toBe(true);
    expect(m.unsavedDelivery?.sessionId).toBe("s-a");
  });

  // MUTANT: clear at any turn end, whose ever (dies on the first clear).
  it("is cleared by the turn end of its own session only", () => {
    const m = agent(A, "s-a");
    recordUnsavedDelivery(m, [item("one")]);
    (m.sessionManager as { session: BackendSession | null }).session = B;
    (m.sessionManager as { sessionId: string | null }).sessionId = "s-b";
    expect(clearUnsavedDeliveryOnTurnEnd(m)).toBe(false);
    expect(texts(m)).toEqual(["one"]);
    (m.sessionManager as { session: BackendSession | null }).session = A;
    (m.sessionManager as { sessionId: string | null }).sessionId = "s-a";
    expect(clearUnsavedDeliveryOnTurnEnd(m)).toBe(true);
    expect(m.unsavedDelivery).toBeNull();
  });

  // MUTANT: ignore the id (dies on the other session's drop).
  it("goes back for the dropped session, or when no id was ever reported", () => {
    const m = agent(A, "s-a");
    recordUnsavedDelivery(m, [item("one")]);
    expect(unsavedItemsToSendAgain(m, "s-other")).toBeNull();
    expect(unsavedItemsToSendAgain(m, null)).toBeNull();
    expect(unsavedItemsToSendAgain(m, "s-a")?.map((i) => i.text)).toEqual([
      "one",
    ]);
    const n = agent(A, null);
    recordUnsavedDelivery(n, [item("two")]);
    expect(unsavedItemsToSendAgain(n, null)?.map((i) => i.text)).toEqual([
      "two",
    ]);
    expect(unsavedItemsToSendAgain(agent(A, null), null)).toBeNull();
  });
});

describe("a message sent again", () => {
  // MUTANTS: keep a continue item (dies on the texts); keep a turn mark
  // (dies on the marks); drop the handoff, ask or attachments (dies on the
  // kept fields).
  it("leaves out what continues the lost conversation and the marks of its turn, and keeps the rest", () => {
    const ask = { askId: "ask-1" } as unknown as QueuedMessage["ask"];
    const attachments = [
      { name: "a.png", path: "/tmp/a.png" },
    ] as unknown as QueuedMessage["attachments"];
    const out = cleanedForSendAgain(
      [
        item("wake", { restartWake: true }),
        item("limit", { limitResume: true }),
        item("fallback", { fallbackContinue: true }),
        item("brief", {
          handoff: true,
          echoed: true,
          steer: true,
          queuedDuringBusyTurn: true,
          modelRetry: true,
          interruptCause: "steer" as QueuedMessage["interruptCause"],
          ask,
          attachments,
        }),
      ],
      false,
    );
    expect(out.map((m) => m.text)).toEqual(["brief"]);
    const [brief] = out as Partial<QueuedMessage>[];
    for (const mark of [
      "id",
      "echoed",
      "steer",
      "queuedDuringBusyTurn",
      "modelRetry",
      "interruptCause",
    ] as const)
      expect([mark, mark in brief]).toEqual([mark, false]);
    expect(brief).toMatchObject({ handoff: true, ask, attachments });
    // The chat still shows it: its delivery writes no second entry.
    expect(cleanedForSendAgain([item("x", { echoed: false })], true)).toEqual([
      expect.objectContaining({ text: "x", echoed: true }),
    ]);
  });
});
