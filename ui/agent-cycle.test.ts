// Next and Prev agent stay in one area of the room (task 5b503e32): the back
// room when a back agent is focused, the front desks otherwise.
import { describe, expect, it } from "bun:test";
import { cycleAgent } from "./agent-cycle.ts";
import { deskOfBackSeat } from "../shared/desks.ts";
import type { AgentInfo } from "../shared/types.ts";

const agent = (id: string, desk: number) =>
  ({ id, desk, roomId: "r1", state: "thinking" }) as unknown as AgentInfo;

const AGENTS = [
  agent("f0", 0),
  agent("f1", 1),
  agent("b0", deskOfBackSeat({ table: 0, stool: 0 })),
  agent("b1", deskOfBackSeat({ table: 0, stool: 1 })),
];

function walk(start: string, direction: "next" | "prev"): string[] {
  const seen: string[] = [];
  let id: string | null = start;
  for (let i = 0; i < 4; i++) {
    id = cycleAgent(AGENTS, new Map(), "r1", id, direction);
    if (id) seen.push(id);
  }
  return seen;
}

describe("cycleAgent", () => {
  it("cycles a focused front agent among front agents only", () => {
    expect(walk("f0", "next")).toEqual(["f1", "f0", "f1", "f0"]);
    expect(walk("f0", "prev")).toEqual(["f1", "f0", "f1", "f0"]);
  });

  it("cycles a focused back agent among back agents only", () => {
    expect(walk("b0", "next")).toEqual(["b1", "b0", "b1", "b0"]);
  });

  it("starts at the front with no agent focused", () => {
    expect(cycleAgent(AGENTS, new Map(), "r1", null, "next")).toBe("f0");
  });
});
