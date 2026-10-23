// The one turn-end rule for the Unread badge, the sound and the push
// (shared/turn-end.ts): the members who started the turn, when the change
// ends it. Each condition gets a flip case.

import { describe, it, expect } from "bun:test";
import { endsTurn, turnEndMembers } from "./turn-end.ts";

describe("turnEndMembers", () => {
  const prev = { state: "thinking", turnMemberIds: ["u-a", "u-b"] };

  it("is the turn's members when a working agent stops", () => {
    for (const next of ["idle", "error", "waiting_for_response"]) {
      expect([next, turnEndMembers(prev, next)]).toEqual([
        next,
        ["u-a", "u-b"],
      ]);
    }
    expect(
      turnEndMembers({ ...prev, state: "tool_executing" }, "idle"),
    ).toEqual(["u-a", "u-b"]);
  });

  it("is empty when one condition flips", () => {
    // The agent was not working.
    expect(turnEndMembers({ ...prev, state: "idle" }, "idle")).toEqual([]);
    // It does not stop.
    expect(turnEndMembers(prev, "tool_executing")).toEqual([]);
    // No member started the turn: an agent, app, schedule or webhook did.
    expect(turnEndMembers({ ...prev, turnMemberIds: [] }, "idle")).toEqual([]);
    expect(turnEndMembers({ state: "thinking" }, "idle")).toEqual([]);
    // No agent before, or no new state.
    expect(turnEndMembers(undefined, "idle")).toEqual([]);
    expect(turnEndMembers(prev, undefined)).toEqual([]);
  });

  it("endsTurn ignores who started the turn", () => {
    expect(endsTurn("thinking", "idle")).toBe(true);
    expect(endsTurn(undefined, "idle")).toBe(false);
  });
});
