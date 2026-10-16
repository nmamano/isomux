// Turn ends for the turn-end push (server/turn-end-watch.ts).
//
// Pins: a change from a working state to idle, error or
// waiting_for_response ends a turn; it counts only when the turn had human
// input; an agent seen for the first time in an attention state ends
// nothing; a removed agent starts over.

import { describe, it, expect } from "bun:test";
import { createTurnEndWatch, type TurnEndAgent } from "./turn-end-watch.ts";
import type { AgentEvent } from "./internal-types.ts";

function setup(human = true) {
  const ended: TurnEndAgent[] = [];
  const watch = createTurnEndWatch({
    agent: (id) =>
      id === "a1"
        ? { id, name: "Bot", roomId: "room-a", turnHadHumanInput: human }
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
      expect(ended).toEqual([{ id: "a1", name: "Bot", roomId: "room-a" }]);
    }
  });

  it("stays quiet for a turn with no human input", () => {
    const { ended, state } = setup(false);
    state("thinking");
    state("idle");
    expect(ended).toEqual([]);
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
