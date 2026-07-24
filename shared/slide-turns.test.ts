import { describe, it, expect } from "bun:test";
import { buildDeckTurns, findDeckTurn } from "./slide-turns.ts";
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
