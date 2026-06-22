// Pure unit tests for roomPaletteIndex (Phase 3c slice 3). The palette slot is
// keyed by the room's stable id (not its position), so a room keeps its colour
// across reorders/closes. The function takes no position argument, so that
// stability is structural; here we cover determinism, bounds, and the null/
// empty fallbacks.

import { describe, it, expect } from "bun:test";
import { roomPaletteIndex } from "./grid.ts";

describe("roomPaletteIndex", () => {
  it("is deterministic for a given id + length", () => {
    expect(roomPaletteIndex("a1b2c3d4", 6)).toBe(
      roomPaletteIndex("a1b2c3d4", 6),
    );
  });

  it("always returns a slot within [0, len)", () => {
    const ids = ["a1b2c3d4", "deadbeef", "00000000", "ffffffff", "5e5e5e5e"];
    for (const id of ids) {
      for (const len of [1, 2, 6, 8]) {
        const idx = roomPaletteIndex(id, len);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(len);
      }
    }
  });

  it("falls back to slot 0 for a null/empty id", () => {
    expect(roomPaletteIndex(null, 6)).toBe(0);
    expect(roomPaletteIndex("", 6)).toBe(0);
  });

  it("returns 0 for a non-positive length", () => {
    expect(roomPaletteIndex("a1b2c3d4", 0)).toBe(0);
  });

  it("distributes distinct ids across more than one slot", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `room${i}aa`);
    const slots = new Set(ids.map((id) => roomPaletteIndex(id, 6)));
    expect(slots.size).toBeGreaterThan(1);
  });
});
