import { describe, it, expect } from "bun:test";
import {
  buildDeckTurns,
  findDeckTurn,
  nextDeckIndex,
  settledDeckPos,
  restoredDeckPos,
} from "./slide-turns.ts";
import type { LogEntry } from "./types.ts";

let seq = 0;
function entry(
  kind: LogEntry["kind"],
  content: string,
  extra: Partial<LogEntry> = {},
): LogEntry {
  seq += 1;
  return {
    id: extra.id ?? `e${seq}`,
    agentId: "a1",
    timestamp: seq,
    kind,
    content,
    ...extra,
  };
}

describe("buildDeckTurns", () => {
  it("splits at user_message and concatenates text spans", () => {
    const turns = buildDeckTurns([
      entry("system", "boot"), // pre-first-turn: no anchor, dropped
      entry("user_message", "hello", { id: "u1" }),
      entry("thinking", "hmm"),
      entry("text", "part one"),
      entry("tool_call", "ls"),
      entry("text", "part two"),
      entry("user_message", "again", { id: "u2" }),
      entry("text", "second answer"),
    ]);
    expect(turns.map((t) => t.entryId)).toEqual(["u1", "u2"]);
    expect(turns[0].promptText).toBe("hello");
    expect(turns[0].assistantText).toBe("part one\n\npart two");
    expect(turns[0].placeholder).toBe(false);
    expect(turns[1].assistantText).toBe("second answer");
  });

  it("marks a tool-only / empty turn as a placeholder", () => {
    const turns = buildDeckTurns([
      entry("user_message", "do it", { id: "u1" }),
      entry("tool_call", "run"),
      entry("tool_result", "done"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].placeholder).toBe(true);
    expect(turns[0].assistantText).toBe("");
    expect(turns[0].errorText).toBeNull();
  });

  it("captures error text on a failed turn (still a placeholder if no text)", () => {
    const turns = buildDeckTurns([
      entry("user_message", "go", { id: "u1" }),
      entry("error", "it broke"),
    ]);
    expect(turns[0].placeholder).toBe(true);
    expect(turns[0].errorText).toBe("it broke");
  });

  it("ignores ephemeral UI markers", () => {
    const turns = buildDeckTurns([
      entry("user_message", "x", { id: "u1" }),
      entry("system", "Conversation cleared.", { ephemeral: true }),
      entry("text", "answer"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantText).toBe("answer");
  });

  it("findDeckTurn returns the matching anchor or null", () => {
    const logs = [
      entry("user_message", "a", { id: "u1" }),
      entry("text", "A"),
      entry("user_message", "b", { id: "u2" }),
      entry("text", "B"),
    ];
    expect(findDeckTurn(logs, "u2")?.assistantText).toBe("B");
    expect(findDeckTurn(logs, "nope")).toBeNull();
  });
});

describe("nextDeckIndex", () => {
  it("follows the newest when the viewer was on the last slide as the deck grows", () => {
    // The bug this guards: index still points at the OLD last (4) while the deck
    // already grew to 6. Testing at-end against the grown length would read
    // false; against prevLen it correctly follows to the new last (5).
    expect(nextDeckIndex(4, 5, 6)).toBe(5);
    expect(nextDeckIndex(5, 6, 8)).toBe(7); // grew by more than one
  });

  it("stays put when the viewer was NOT on the last slide", () => {
    expect(nextDeckIndex(2, 5, 6)).toBe(2);
    expect(nextDeckIndex(0, 5, 9)).toBe(0);
  });

  it("clamps into range when the deck shrinks past the cursor", () => {
    expect(nextDeckIndex(4, 5, 3)).toBe(2); // /clear or edit-fork shrank it
    expect(nextDeckIndex(1, 5, 3)).toBe(1); // still in range, unchanged
  });

  it("handles empty / single-slide decks without going negative", () => {
    expect(nextDeckIndex(0, 0, 0)).toBe(0);
    expect(nextDeckIndex(0, 1, 1)).toBe(0);
  });
});

describe("settledDeckPos (what gets persisted on a length change)", () => {
  it("marks atEnd when a SHRINK makes the unchanged cursor the new last slide", () => {
    // The P2 case: viewer at index 1 of a 5-deck (not at end). An edit/fork
    // shrinks the deck to 2; index stays 1 but 1 is now the last slide, so the
    // persisted atEnd must flip to true — otherwise re-entry treats them as
    // intentionally behind and won't follow newest.
    expect(settledDeckPos(1, 5, 2)).toEqual({ index: 1, atEnd: true });
  });

  it("keeps atEnd true while following the newest as the deck grows", () => {
    expect(settledDeckPos(4, 5, 6)).toEqual({ index: 5, atEnd: true });
  });

  it("stays behind (atEnd false) when the viewer was not on the last slide", () => {
    expect(settledDeckPos(2, 5, 6)).toEqual({ index: 2, atEnd: false });
  });

  it("clamps and marks atEnd when a shrink lands the cursor on the last slide", () => {
    expect(settledDeckPos(4, 5, 3)).toEqual({ index: 2, atEnd: true });
  });
});

describe("restoredDeckPos (what gets shown + persisted on first open)", () => {
  it("no saved position → newest, atEnd", () => {
    expect(restoredDeckPos(null, 5)).toEqual({ index: 4, atEnd: true });
  });

  it("saved at-end → follows newest even if the deck grew since", () => {
    expect(restoredDeckPos({ index: 2, atEnd: true }, 6)).toEqual({
      index: 5,
      atEnd: true,
    });
  });

  it("saved behind → restores that slide, still behind", () => {
    expect(restoredDeckPos({ index: 1, atEnd: false }, 5)).toEqual({
      index: 1,
      atEnd: false,
    });
  });

  it("saved-behind index that clamps onto the (now shorter) last slide becomes atEnd", () => {
    // The first-load P2: {index:0, atEnd:false} but the deck is now one slide —
    // index 0 is at-end, so the persisted position must record atEnd:true, or
    // re-entry keeps treating the viewer as intentionally behind.
    expect(restoredDeckPos({ index: 0, atEnd: false }, 1)).toEqual({
      index: 0,
      atEnd: true,
    });
    // Any out-of-range saved index that clamps to the last slide, likewise.
    expect(restoredDeckPos({ index: 9, atEnd: false }, 3)).toEqual({
      index: 2,
      atEnd: true,
    });
  });
});
