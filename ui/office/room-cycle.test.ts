import { describe, expect, it } from "bun:test";
import { selfTuckedRooms, swipeTarget, tabBarRooms } from "./room-cycle.ts";

const rooms = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

describe("swipeTarget", () => {
  it("walks Lobby, r1, r2, r3 and back to the Lobby on next", () => {
    expect(swipeTarget(rooms, "r1", true, "next")).toEqual({
      kind: "room",
      roomId: "r1",
    });
    expect(swipeTarget(rooms, "r1", false, "next")).toEqual({
      kind: "room",
      roomId: "r2",
    });
    expect(swipeTarget(rooms, "r3", false, "next")).toEqual({ kind: "lobby" });
  });

  it("walks the same ring backwards on prev", () => {
    expect(swipeTarget(rooms, "r1", false, "prev")).toEqual({ kind: "lobby" });
    expect(swipeTarget(rooms, "r3", true, "prev")).toEqual({
      kind: "room",
      roomId: "r3",
    });
    expect(swipeTarget(rooms, "r2", false, "prev")).toEqual({
      kind: "room",
      roomId: "r1",
    });
  });

  it("does nothing with no rooms, and reaches the lobby with one room", () => {
    expect(swipeTarget([], null, true, "next")).toBeNull();
    expect(swipeTarget([{ id: "r1" }], "r1", false, "next")).toEqual({
      kind: "lobby",
    });
    expect(swipeTarget([{ id: "r1" }], "r1", false, "prev")).toEqual({
      kind: "lobby",
    });
  });
});

const ids = (rooms: readonly { id: string }[]) => rooms.map((r) => r.id);

describe("tabBarRooms", () => {
  const order = [{ id: "a" }, { id: "t1" }, { id: "b" }, { id: "t2" }];
  const tucked = ["t1", "t2"];

  it("keeps the member's order and leaves the tucked rooms out", () => {
    expect(ids(tabBarRooms(order, tucked, "a", false))).toEqual(["a", "b"]);
    expect(ids(tabBarRooms(order, [], "a", false))).toEqual([
      "a",
      "t1",
      "b",
      "t2",
    ]);
  });

  it("pins the open tucked room at the end, and only while it is open", () => {
    expect(ids(tabBarRooms(order, tucked, "t1", false))).toEqual([
      "a",
      "b",
      "t1",
    ]);
    expect(ids(tabBarRooms(order, tucked, "t1", true))).toEqual(["a", "b"]);
  });
});

describe("selfTuckedRooms", () => {
  it("reads the tucked list from the member's own record only", () => {
    const users = [
      { id: "u1", tucked: ["x"] },
      { id: "u2", tucked: ["y"] },
      { id: "u3" },
    ];
    expect(selfTuckedRooms(users, "u2")).toEqual(["y"]);
    expect(selfTuckedRooms(users, "u3")).toEqual([]);
    expect(selfTuckedRooms(users, null)).toEqual([]);
  });
});
