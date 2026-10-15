// The back room's seat rules (task 5b503e32): seat numbers that survive
// growth and shrinking, the n x n room derived from the seats in use, the
// order new agents take seats in, the cap, and OfficeState placement.

import { describe, it, expect } from "bun:test";
import {
  BACK_SEAT_BASE,
  BACK_ROOM_MAX_SIDE,
  BACK_ROOM_MIN_SIDE,
  BACK_ROOM_SEATS,
  DESK_COUNT,
  backRoomSide,
  backSeatOf,
  deskOfBackSeat,
  firstFreeBackSeat,
  isBackSeat,
  isFrontDesk,
  isValidPlacement,
  roomIsFull,
} from "./desks.ts";
import { OfficeState } from "./office-state.ts";

const seat = (table: number, stool: number) => deskOfBackSeat({ table, stool });

// The desks of every seat in the side x side square.
function square(side: number): number[] {
  const desks: number[] = [];
  for (let table = 0; table < side; table++)
    for (let stool = 0; stool < side; stool++) desks.push(seat(table, stool));
  return desks;
}

describe("back seat numbers", () => {
  it("are a fixed storage format, not the front layout", () => {
    // A stored seat must keep its meaning if the front grid changes, so the
    // base is pinned here rather than derived from DESK_SLOTS.
    expect(BACK_SEAT_BASE).toBe(8);
    expect(BACK_SEAT_BASE).toBeGreaterThanOrEqual(DESK_COUNT);
  });

  it("round-trip through (table, stool) with a stride of the max side", () => {
    for (let table = 0; table < BACK_ROOM_MAX_SIDE; table++) {
      for (let stool = 0; stool < BACK_ROOM_MAX_SIDE; stool++) {
        const desk = seat(table, stool);
        expect(isBackSeat(desk)).toBe(true);
        expect(backSeatOf(desk)).toEqual({ table, stool });
      }
    }
    expect(seat(0, 0)).toBe(BACK_SEAT_BASE);
    expect(seat(1, 0)).toBe(BACK_SEAT_BASE + BACK_ROOM_MAX_SIDE);
  });

  it("front desks, out-of-range numbers and fractions are not back seats", () => {
    for (const desk of [
      -1,
      0,
      DESK_COUNT - 1,
      BACK_SEAT_BASE + BACK_ROOM_SEATS,
      8.5,
    ]) {
      expect(isBackSeat(desk)).toBe(false);
      expect(backSeatOf(desk)).toBeNull();
    }
  });

  it("isValidPlacement accepts front desks and back seats, but no back seat in the lobby", () => {
    const room = { type: "office" as const };
    const lobby = { type: "lobby" as const };
    expect(isValidPlacement(0, room)).toBe(true);
    expect(isValidPlacement(seat(9, 9), room)).toBe(true);
    expect(isValidPlacement(seat(0, 0), lobby)).toBe(false);
    expect(isValidPlacement(0, lobby)).toBe(true);
    expect(isFrontDesk(seat(0, 0), room)).toBe(false);
  });
});

describe("the size of the back room", () => {
  it("is the min side while it is empty", () => {
    expect(backRoomSide([])).toBe(BACK_ROOM_MIN_SIDE);
  });

  it("grows by one when the last free seat of its square fills", () => {
    const full = square(BACK_ROOM_MIN_SIDE);
    expect(backRoomSide(full.slice(1))).toBe(BACK_ROOM_MIN_SIDE);
    expect(backRoomSide(full)).toBe(BACK_ROOM_MIN_SIDE + 1);
  });

  it("does not shrink while anyone sits in the outer ring", () => {
    const desks = [...square(3), seat(0, 3)]; // one agent in ring 4
    desks.splice(0, 1); // a seat of the inner square frees up
    expect(backRoomSide(desks)).toBe(4);
  });

  it("shrinks when its outer ring is empty again", () => {
    const desks = square(3).slice(1); // 8 of 9, nothing outside
    expect(backRoomSide(desks)).toBe(3);
  });

  it("stops at the max side", () => {
    expect(backRoomSide(square(BACK_ROOM_MAX_SIDE))).toBe(BACK_ROOM_MAX_SIDE);
  });

  it("ignores front desks", () => {
    expect(backRoomSide([0, 1, 2, 3, 4, 5, 6, 7])).toBe(BACK_ROOM_MIN_SIDE);
  });
});

describe("the seat a new back agent takes", () => {
  it("fills the inner squares first, by table and then stool in each ring", () => {
    const order: number[] = [];
    const taken: number[] = [];
    for (let i = 0; i < 9; i++) {
      const next = firstFreeBackSeat(taken);
      expect(next).not.toBeNull();
      order.push(next!);
      taken.push(next!);
    }
    expect(order).toEqual([
      seat(0, 0),
      seat(0, 1),
      seat(1, 0),
      seat(1, 1),
      seat(0, 2),
      seat(1, 2),
      seat(2, 0),
      seat(2, 1),
      seat(2, 2),
    ]);
  });

  it("takes a seat in the new ring when the square is full", () => {
    expect(firstFreeBackSeat(square(3))).toBe(seat(0, 3));
  });

  it("refills a hole in the inner square before the outer ring", () => {
    const desks = [...square(3), seat(0, 3)].filter((d) => d !== seat(1, 1));
    expect(firstFreeBackSeat(desks)).toBe(seat(1, 1));
  });

  it("is null when all seats are in use", () => {
    expect(firstFreeBackSeat(square(BACK_ROOM_MAX_SIDE))).toBeNull();
    expect(square(BACK_ROOM_MAX_SIDE)).toHaveLength(BACK_ROOM_SEATS);
  });
});

describe("OfficeState placement", () => {
  function office() {
    const state = new OfficeState();
    state.setRooms([
      { id: "r1", name: "One", prompt: null, backRoom: true },
      { id: "r2", name: "Two", prompt: null, backRoom: true },
      { id: "lobby", name: "Lobby", prompt: null, type: "lobby" },
    ]);
    return state;
  }
  const spawn = (
    state: OfficeState,
    name: string,
    roomId: string,
    desk?: number | null,
  ) =>
    state.spawn({ name, cwd: "/", permissionMode: "default", roomId, desk })
      ?.agent ?? null;

  it("spawn: omitted desk takes a front desk, then a back seat", () => {
    const state = office();
    for (let i = 0; i < DESK_COUNT; i++)
      expect(spawn(state, `F${i}`, "r1")?.desk).toBe(i);
    expect(spawn(state, "B0", "r1")?.desk).toBe(seat(0, 0));
  });

  it("spawn: null takes a back seat even when a front desk is free", () => {
    const state = office();
    expect(spawn(state, "B0", "r1", null)?.desk).toBe(seat(0, 0));
  });

  it("spawn: a taken front desk falls through to a free one, then the back room", () => {
    const state = office();
    spawn(state, "A", "r1", 0);
    expect(spawn(state, "B", "r1", 0)?.desk).toBe(1);
    for (let i = 2; i < DESK_COUNT; i++) spawn(state, `F${i}`, "r1", i);
    expect(spawn(state, "C", "r1", 0)?.desk).toBe(seat(0, 0));
  });

  it("spawn: a back seat number is not a desk a caller can name", () => {
    const state = office();
    expect(spawn(state, "X", "r1", seat(0, 0))).toBeNull();
  });

  it("spawn: the lobby has no back room", () => {
    const state = office();
    expect(spawn(state, "X", "lobby", null)).toBeNull();
    expect(spawn(state, "R", "lobby")?.desk).toBe(0);
    expect(spawn(state, "Y", "lobby")).toBeNull();
  });

  it("spawn: refuses when the front and all back seats are taken", () => {
    const state = office();
    for (let i = 0; i < DESK_COUNT + BACK_ROOM_SEATS; i++)
      expect(spawn(state, `A${i}`, "r1")).not.toBeNull();
    expect(spawn(state, "Last", "r1")).toBeNull();
  });

  it("placeAgent: no desk keeps the agent's area", () => {
    const state = office();
    const front = spawn(state, "F", "r1", 0)!;
    const back = spawn(state, "B", "r1", null)!;
    const f = state.placeAgent(front.id, "r2");
    const b = state.placeAgent(back.id, "r2");
    expect(f.ok && b.ok).toBe(true);
    expect(state.getAgent(front.id)?.desk).toBe(0);
    expect(state.getAgent(back.id)?.desk).toBe(seat(0, 0));
  });

  it("placeAgent: front to back and back to front in one room", () => {
    const state = office();
    const a = spawn(state, "A", "r1", 3)!;
    const toBack = state.placeAgent(a.id, "r1", null);
    expect(toBack.ok).toBe(true);
    expect(state.getAgent(a.id)?.desk).toBe(seat(0, 0));
    if (toBack.ok)
      expect(toBack.events[0]).toEqual({
        type: "agent_updated",
        agentId: a.id,
        changes: { desk: seat(0, 0) },
      });
    const toFront = state.placeAgent(a.id, "r1", 5);
    expect(toFront.ok).toBe(true);
    expect(state.getAgent(a.id)?.desk).toBe(5);
  });

  it("placeAgent: a taken desk is refused, not swapped", () => {
    const state = office();
    const a = spawn(state, "A", "r1", 0)!;
    const b = spawn(state, "B", "r1", null)!;
    expect(state.placeAgent(b.id, "r1", 0)).toEqual({
      ok: false,
      reason: "desk_taken",
    });
    expect(state.getAgent(a.id)?.desk).toBe(0);
    expect(state.getAgent(b.id)?.desk).toBe(seat(0, 0));
  });

  it("placeAgent: the agent's own room with no desk, or its own area, does nothing", () => {
    const state = office();
    const a = spawn(state, "A", "r1", 0)!;
    const b = spawn(state, "B", "r1", null)!;
    expect(state.placeAgent(a.id, "r1")).toEqual({
      ok: false,
      reason: "same_place",
    });
    expect(state.placeAgent(b.id, "r1", null)).toEqual({
      ok: false,
      reason: "same_place",
    });
  });

  it("no stored desk changes while the room grows 3x3 -> 4x4 -> 5x5 and shrinks back", () => {
    const state = office();
    const side = () =>
      backRoomSide(
        state
          .getAllAgents()
          .filter((a) => a.roomId === "r1")
          .map((a) => a.desk),
      );
    const seen = new Map<string, number>();
    // Every live agent keeps the desk it was given, no two share one, and
    // each seat lies inside the room's current square.
    const check = () => {
      const live = state.getAllAgents().filter((a) => a.roomId === "r1");
      for (const a of live) expect(a.desk).toBe(seen.get(a.id)!);
      expect(new Set(live.map((a) => a.desk)).size).toBe(live.length);
      const n = side();
      for (const a of live) {
        const s = backSeatOf(a.desk)!;
        expect(Math.max(s.table, s.stool)).toBeLessThan(n);
      }
    };
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const a = spawn(state, `W${i}`, "r1", null)!;
      seen.set(a.id, a.desk);
      ids.push(a.id);
      check();
    }
    expect(side()).toBe(6); // 25 seats fill 5x5, so a sixth ring is open
    const sides: number[] = [];
    // Kill from the newest: the outer rings empty and the room shrinks.
    for (const id of ids.slice(9).reverse()) {
      state.kill(id);
      check();
      sides.push(side());
    }
    expect(sides).toContain(5);
    expect(sides).toContain(4);
    expect(side()).toBe(4); // 9 seats fill 3x3, so a fourth ring is open
  });

  it("placeAgent: a back agent moved to an empty lobby with no desk takes its desk", () => {
    const state = office();
    const b = spawn(state, "B", "r1", null)!;
    expect(state.placeAgent(b.id, "lobby").ok).toBe(true);
    expect(state.getAgent(b.id)?.desk).toBe(0);
  });

  it("placeAgent: a full back room and the lobby", () => {
    const state = office();
    for (let i = 0; i < DESK_COUNT + BACK_ROOM_SEATS; i++)
      spawn(state, `A${i}`, "r2");
    const x = spawn(state, "X", "r1", null)!;
    expect(state.placeAgent(x.id, "r2")).toEqual({
      ok: false,
      reason: "back_room_full",
    });
    expect(state.placeAgent(x.id, "lobby", null)).toEqual({
      ok: false,
      reason: "invalid_desk",
    });
  });
});

describe("roomIsFull", () => {
  const front = Array.from({ length: DESK_COUNT }, (_, d) => d);
  const back = Array.from({ length: BACK_ROOM_SEATS }, (_, i) =>
    deskOfBackSeat({
      table: Math.floor(i / BACK_ROOM_MAX_SIDE),
      stool: i % BACK_ROOM_MAX_SIDE,
    }),
  );
  it("a room with the back room off is full at 8 front agents", () => {
    expect(roomIsFull({}, front)).toBe(true);
    expect(roomIsFull({ backRoom: false }, front)).toBe(true);
    expect(roomIsFull({ backRoom: false }, front.slice(1))).toBe(false);
  });
  it("a room with the back room on is full only when its back room is full too", () => {
    expect(roomIsFull({ backRoom: true }, front)).toBe(false);
    expect(roomIsFull({ backRoom: true }, [...front, ...back])).toBe(true);
    expect(roomIsFull({ backRoom: true }, [...front, ...back.slice(1)])).toBe(
      false,
    );
  });
  it("the lobby is full at its one desk", () => {
    expect(roomIsFull({ type: "lobby", backRoom: true }, [0])).toBe(true);
  });
});
