// The desktop chat sidebar's decisions (task c61316be): when it starts open,
// which rooms it lists and where, the order of a room's agents, and where a
// new agent sits. The DOM around them is in ui/App.chat-sidebar*.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import {
  CHAT_SIDEBAR_MIN_OPEN_WIDTH,
  newAgentSeat,
  roomAgents,
  sidebarRooms,
  sidebarStartsOpen,
  spawnRoomFor,
} from "./chat-sidebar.ts";
import { BACK_SEAT_BASE, DESK_COUNT } from "../shared/desks.ts";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type AgentState,
  type RoomWire,
} from "../shared/types.ts";

const agent = (
  id: string,
  roomId: string,
  desk: number,
  state: AgentState = "idle",
): AgentInfo => ({ id, roomId, desk, state }) as unknown as AgentInfo;

const room = (id: string): RoomWire => ({ id, name: id }) as RoomWire;
const ids = (list: readonly { id: string }[]) => list.map((x) => x.id);

describe("sidebarStartsOpen", () => {
  it("follows the member's choice on this device at any width, and with none opens only on a wide window", () => {
    const wide = CHAT_SIDEBAR_MIN_OPEN_WIDTH;
    expect([
      sidebarStartsOpen(null, wide),
      sidebarStartsOpen(null, wide - 1),
      sidebarStartsOpen(null, 1920),
      sidebarStartsOpen("closed", 1920),
      sidebarStartsOpen("open", 800),
    ]).toEqual([true, false, true, false, true]);
    // The agreed threshold (design, 2026-11-11).
    expect(wide).toBe(1100);
  });
});

describe("sidebarRooms", () => {
  const rooms = ["r1", "r2", "r3", "r4"].map(room);
  const tucked = ["r2", "r4"];

  it("lists the shown rooms in the member's order and puts tucked rooms under More rooms", () => {
    const out = sidebarRooms({ rooms, tucked }, null);
    expect({ shown: ids(out.shown), more: ids(out.more) }).toEqual({
      shown: ["r1", "r3"],
      more: ["r2", "r4"],
    });
  });

  it("shows the open agent's room even when it is tucked, and only once", () => {
    const out = sidebarRooms({ rooms, tucked }, "r4");
    expect({ shown: ids(out.shown), more: ids(out.more) }).toEqual({
      shown: ["r1", "r3", "r4"],
      more: ["r2"],
    });
  });

  it("does not fail when the open agent's room is not in the list (a Lobby agent, or a room the member does not see)", () => {
    for (const open of [LOBBY_ROOM_ID, "gone"]) {
      const out = sidebarRooms({ rooms, tucked }, open);
      expect({ open, shown: ids(out.shown), more: ids(out.more) }).toEqual({
        open,
        shown: ["r1", "r3"],
        more: ["r2", "r4"],
      });
    }
  });
});

describe("roomAgents", () => {
  it("gives the room's front desks in desk order and its back room with the waiting and failed agents first, then desk order", () => {
    const agents = [
      agent("f3", "r1", 3),
      agent("b0", "r1", BACK_SEAT_BASE, "idle"),
      agent("f0", "r1", 0),
      agent("b1", "r1", BACK_SEAT_BASE + 1, "thinking"),
      agent("b3", "r1", BACK_SEAT_BASE + 3, "waiting_for_response"),
      agent("f1", "r1", 1),
      agent("b2", "r1", BACK_SEAT_BASE + 2, "error"),
      agent("b4", "r1", BACK_SEAT_BASE + 4, "stopped"),
      // Another room's agents are not this room's.
      agent("x0", "r2", 2),
      agent("x8", "r2", BACK_SEAT_BASE),
    ];
    const out = roomAgents(agents, "r1");
    expect({ front: ids(out.front), back: ids(out.back) }).toEqual({
      front: ["f0", "f1", "f3"],
      back: ["b2", "b3", "b0", "b1", "b4"],
    });
  });
});

describe("newAgentSeat", () => {
  it("is the room's first free front desk; back agents and other rooms do not take one", () => {
    const cases = [
      // A gap at desk 2.
      {
        agents: [agent("a", "r1", 0), agent("b", "r1", 1), agent("c", "r1", 3)],
        want: 2,
      },
      // Empty room, with only back agents and another room's desk 0.
      {
        agents: [agent("a", "r1", BACK_SEAT_BASE), agent("b", "r2", 0)],
        want: 0,
      },
      // Another room's desk 2 does not fill this room's desk 2.
      {
        agents: [agent("a", "r1", 0), agent("b", "r1", 1), agent("c", "r2", 2)],
        want: 2,
      },
    ];
    expect(cases.map((c) => newAgentSeat(c.agents, "r1"))).toEqual(
      cases.map((c) => c.want),
    );
  });

  it("is null, the back room, when every front desk is taken", () => {
    const full = Array.from({ length: DESK_COUNT }, (_, desk) =>
      agent(`d${desk}`, "r1", desk),
    );
    expect(newAgentSeat(full, "r1")).toBeNull();
    // One desk short of full: the last desk.
    expect(newAgentSeat(full.slice(0, -1), "r1")).toBe(DESK_COUNT - 1);
  });
});

describe("spawnRoomFor", () => {
  it("is the open agent's room, front or back; for a Lobby agent or no agent, the room the member last stood in", () => {
    expect([
      spawnRoomFor(agent("f", "r2", 0), "r1"),
      spawnRoomFor(agent("b", "r2", BACK_SEAT_BASE), "r1"),
      spawnRoomFor(agent("l", LOBBY_ROOM_ID, 0), "r1"),
      spawnRoomFor(null, "r1"),
      spawnRoomFor(null, null),
    ]).toEqual(["r2", "r2", "r1", "r1", null]);
  });
});
