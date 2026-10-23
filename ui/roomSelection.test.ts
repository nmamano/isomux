// Pure unit tests for the client-side room-selection helpers (Phase 3c slice
// 3). The view selection is tracked by stable room id, so a reorder or a
// non-selected close never moves it; only closing the selected room (or a
// rooms list that no longer contains it) reselects.

import { describe, it, expect } from "bun:test";
import type { RoomWire } from "../shared/types.ts";
import { resolveSelectedRoomId, applyRoomClose } from "./roomSelection.ts";

function room(id: string): RoomWire {
  return { id, name: id.toUpperCase(), prompt: null, canCloseWhenEmpty: true };
}

const A = room("a");
const B = room("b");
const C = room("c");

describe("resolveSelectedRoomId", () => {
  it("keeps the current selection when it still exists", () => {
    expect(resolveSelectedRoomId([A, B, C], "b")).toBe("b");
  });

  it("prefers `preferred` (e.g. default room) when present", () => {
    expect(resolveSelectedRoomId([A, B, C], null, "c")).toBe("c");
  });

  it("ignores a preferred id that isn't in the list, keeps current", () => {
    expect(resolveSelectedRoomId([A, B, C], "a", "zz")).toBe("a");
  });

  it("falls back to the first room when current no longer exists", () => {
    expect(resolveSelectedRoomId([A, B, C], "gone")).toBe("a");
  });

  // The lobby is a room on the wire but never the selected room.
  it("never selects the lobby, even when preferred or listed first", () => {
    const lobby: RoomWire = { ...room("l"), type: "lobby" };
    expect(resolveSelectedRoomId([lobby, A, B], "l", "l")).toBe("a");
    expect(resolveSelectedRoomId([lobby], null)).toBe(null);
  });

  it("returns null when there are no rooms", () => {
    expect(resolveSelectedRoomId([], "a", "b")).toBe(null);
  });
});

describe("applyRoomClose", () => {
  it("no-ops (null) when the closed id isn't present", () => {
    expect(applyRoomClose([A, B, C], "zz", "b")).toBe(null);
  });

  it("closed-before-current: selection preserved, list shrinks", () => {
    const r = applyRoomClose([A, B, C], "a", "c");
    expect(r).not.toBe(null);
    expect(r!.currentRoomId).toBe("c");
    expect(r!.rooms.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("closed-current (middle): jumps to the room taking its slot", () => {
    const r = applyRoomClose([A, B, C], "b", "b");
    expect(r!.currentRoomId).toBe("c");
    expect(r!.rooms.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("closed-current at the last index: jumps to the new last room", () => {
    const r = applyRoomClose([A, B, C], "c", "c");
    expect(r!.currentRoomId).toBe("b");
    expect(r!.rooms.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("closing the only (selected) room leaves no selection", () => {
    const r = applyRoomClose([A], "a", "a");
    expect(r!.currentRoomId).toBe(null);
    expect(r!.rooms).toEqual([]);
  });
});
