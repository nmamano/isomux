// groupAgentsByRoom (task 899360d3): the one order every agent selector uses.
import { describe, expect, it } from "bun:test";
import { groupAgentsByRoom } from "./agent-groups.ts";
import {
  GROUP_AGENTS,
  GROUP_ROOMS,
} from "./test-support/agent-groups-fixture.ts";

const shape = (
  groups: { room: { id: string } | null; agents: { id: string }[] }[],
) => groups.map((g) => [g.room?.id ?? null, g.agents.map((a) => a.id)]);

describe("groupAgentsByRoom", () => {
  it("groups by room in office order, by desk inside a room, empty rooms out, unknown rooms last in input order", () => {
    const groups = groupAgentsByRoom(GROUP_AGENTS, GROUP_ROOMS);
    expect(shape(groups)).toEqual([
      ["r2", ["x5", "x2", "x7"]],
      ["r1", ["x3", "x1"]],
      [null, ["x4", "x6"]],
    ]);
    // The room itself comes back, so a caller reads its name.
    expect(groups[0].room).toBe(GROUP_ROOMS[0]);
    // The input order of the unknown-room agents is kept, both ways.
    expect(
      shape(groupAgentsByRoom([...GROUP_AGENTS].reverse(), GROUP_ROOMS)).at(-1),
    ).toEqual([null, ["x6", "x4"]]);
  });

  it("has no unknown-room group when every agent's room is known, and no group for no agents", () => {
    const known = GROUP_AGENTS.filter((a) => a.roomId !== "r9");
    expect(shape(groupAgentsByRoom(known, GROUP_ROOMS))).toEqual([
      ["r2", ["x5", "x2", "x7"]],
      ["r1", ["x3", "x1"]],
    ]);
    expect(groupAgentsByRoom([], GROUP_ROOMS)).toEqual([]);
  });
});
