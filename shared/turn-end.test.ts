// The one turn-end rule for the sound and the push (shared/turn-end.ts).
// Each condition gets a flip case.

import { describe, it, expect } from "bun:test";
import { endsTurn, turnEndNotifies } from "./turn-end.ts";

describe("turnEndNotifies", () => {
  const prev = { state: "thinking", turnHadHumanInput: true };

  it("is true for a working agent that stops in a turn a person started", () => {
    for (const next of ["idle", "error", "waiting_for_response"]) {
      expect(turnEndNotifies(prev, next)).toBe(true);
    }
  });

  it("flips on each condition", () => {
    // The agent was not working.
    expect(turnEndNotifies({ ...prev, state: "idle" }, "idle")).toBe(false);
    // It does not stop.
    expect(turnEndNotifies(prev, "tool_executing")).toBe(false);
    // No person started the turn.
    expect(turnEndNotifies({ ...prev, turnHadHumanInput: false }, "idle")).toBe(
      false,
    );
    expect(turnEndNotifies({ state: "thinking" }, "idle")).toBe(false);
    // No agent before, or no new state.
    expect(turnEndNotifies(undefined, "idle")).toBe(false);
    expect(turnEndNotifies(prev, undefined)).toBe(false);
  });

  it("endsTurn ignores the human input", () => {
    expect(endsTurn("thinking", "idle")).toBe(true);
    expect(endsTurn(undefined, "idle")).toBe(false);
  });
});
