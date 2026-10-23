// Turn ends for the turn-end push (server/turn-end-watch.ts).
//
// Pins: a change from a working state to idle, error or
// waiting_for_response ends a turn; it goes on with the members who started
// the turn, and a turn no member started goes nowhere; an agent seen for the
// first time in an attention state ends nothing; a removed agent starts over.

import { describe, it, expect } from "bun:test";
import { createTurnEndWatch, type TurnEndAgent } from "./turn-end-watch.ts";
import type { AgentEvent } from "./internal-types.ts";

// null: the agent carries no turnMemberIds at all.
function setup(members: readonly string[] | null = ["u-morgan"]) {
  const ended: (TurnEndAgent & { memberIds: readonly string[] })[] = [];
  const watch = createTurnEndWatch({
    agent: (id) =>
      id === "a1"
        ? {
            id,
            name: "Bot",
            roomId: "room-a",
            ...(members ? { turnMemberIds: members } : {}),
          }
        : null,
    onTurnEnd: (agent) => ended.push(agent),
  });
  const state = (s: string) =>
    watch.observe({
      type: "agent_updated",
      agentId: "a1",
      changes: { state: s },
    } as AgentEvent);
  return { watch, ended, state };
}

describe("turn-end watch", () => {
  it("ends a turn when a working agent waits for a person", () => {
    for (const [from, to] of [
      ["thinking", "idle"],
      ["tool_executing", "waiting_for_response"],
      ["thinking", "error"],
    ]) {
      const { ended, state } = setup();
      state(from);
      state(to);
      expect(ended).toEqual([
        { id: "a1", name: "Bot", roomId: "room-a", memberIds: ["u-morgan"] },
      ]);
    }
  });

  it("passes on every member of the turn", () => {
    const { ended, state } = setup(["u-morgan", "u-mia"]);
    state("thinking");
    state("idle");
    expect(ended.map((e) => e.memberIds)).toEqual([["u-morgan", "u-mia"]]);
  });

  it("stays quiet for a turn that no member started", () => {
    for (const members of [[], null]) {
      const { ended, state } = setup(members);
      state("thinking");
      state("idle");
      expect(ended).toEqual([]);
    }
  });

  it("ends nothing between attention states, on a first sight, or after a removal", () => {
    const { watch, ended, state } = setup();
    state("idle");
    state("waiting_for_response");
    expect(ended).toEqual([]);
    state("thinking");
    watch.observe({
      type: "agent_removed",
      agentId: "a1",
      roomId: "room-a",
    });
    state("idle");
    expect(ended).toEqual([]);
    // Other changes than the state pass through.
    watch.observe({
      type: "agent_updated",
      agentId: "a1",
      changes: { name: "Bot 2" },
    });
    expect(ended).toEqual([]);
  });
});
