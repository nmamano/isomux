import { describe, expect, it } from "bun:test";
import { swipeTarget } from "./room-cycle.ts";

const rooms = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

describe("swipeTarget", () => {
  it("walks Lobby, r1, r2, r3 and back to the Lobby on next", () => {
    expect(swipeTarget(rooms, "r1", true, "next")).toEqual({ kind: "room", roomId: "r1" });
    expect(swipeTarget(rooms, "r1", false, "next")).toEqual({ kind: "room", roomId: "r2" });
    expect(swipeTarget(rooms, "r3", false, "next")).toEqual({ kind: "lobby" });
  });

  it("walks the same ring backwards on prev", () => {
    expect(swipeTarget(rooms, "r1", false, "prev")).toEqual({ kind: "lobby" });
    expect(swipeTarget(rooms, "r3", true, "prev")).toEqual({ kind: "room", roomId: "r3" });
    expect(swipeTarget(rooms, "r2", false, "prev")).toEqual({ kind: "room", roomId: "r1" });
  });

  it("does nothing with no rooms, and reaches the lobby with one room", () => {
    expect(swipeTarget([], null, true, "next")).toBeNull();
    expect(swipeTarget([{ id: "r1" }], "r1", false, "next")).toEqual({ kind: "lobby" });
    expect(swipeTarget([{ id: "r1" }], "r1", false, "prev")).toEqual({ kind: "lobby" });
  });
});
