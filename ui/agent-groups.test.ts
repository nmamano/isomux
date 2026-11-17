// groupAgentsByRoom (task 899360d3): the one order every agent selector uses.
import { describe, expect, it } from "bun:test";
import { groupAgentsByRoom, groupKilledAgentsByRoom } from "./agent-groups.ts";
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

// Task c3c5e709: the Revive a killed agent list (spawn dialog). A killed
// agent's room is lastRoomId; the input is newest killed first.
describe("groupKilledAgentsByRoom", () => {
  const k = (id: string, lastRoomId: string, lastRoomName: string) => ({
    id,
    lastRoomId,
    lastRoomName,
  });
  // r1 was renamed since k1 was killed; r9 and r8 are deleted rooms that had
  // the same name, so only their ids tell them apart.
  const KILLED = [
    k("k1", "r1", "Old Alpha"),
    k("k2", "r9", "Gone"),
    k("k3", "r2", "Zeta"),
    k("k4", "r8", "Gone"),
    k("k5", "r1", "Alpha"),
    k("k6", "r9", "Gone"),
  ];
  const kshape = (
    groups: { roomId: string; roomName: string; agents: { id: string }[] }[],
  ) => groups.map((g) => [g.roomId, g.roomName, g.agents.map((a) => a.id)]);

  it("groups in office order with current room names, input order inside a group, deleted rooms after by first appearance and by id", () => {
    expect(kshape(groupKilledAgentsByRoom(KILLED, GROUP_ROOMS))).toEqual([
      ["r2", "Zeta", ["k3"]],
      ["r1", "Alpha", ["k1", "k5"]],
      ["r9", "Gone", ["k2", "k6"]],
      ["r8", "Gone", ["k4"]],
    ]);
    // Input order is kept, both ways, for known and deleted rooms.
    expect(
      kshape(groupKilledAgentsByRoom([...KILLED].reverse(), GROUP_ROOMS)),
    ).toEqual([
      ["r2", "Zeta", ["k3"]],
      ["r1", "Alpha", ["k5", "k1"]],
      ["r9", "Gone", ["k6", "k2"]],
      ["r8", "Gone", ["k4"]],
    ]);
  });
});
