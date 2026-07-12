// Pure unit tests for roomPaletteIndex. The palette slot cycles by the room's
// POSITION in the room list (index % len): adjacent rooms always differ and
// every palette appears before any repeats. This is an explicit product
// decision (task 5c10494a) — id-hash keying collapsed onto few palettes on
// real offices — and the accepted tradeoff is that rooms recolour when the
// list order changes. Callers pass `rooms.findIndex(...)`, so the not-found
// sentinel -1 must fall back to slot 0 rather than index out of bounds.

import { describe, it, expect } from "bun:test";
import { roomPaletteIndex } from "./grid.ts";

describe("roomPaletteIndex", () => {
  it("cycles all palettes in order before repeating", () => {
    const slots = Array.from({ length: 12 }, (_, i) => roomPaletteIndex(i, 6));
    expect(slots).toEqual([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
  });

  it("gives adjacent rooms different slots whenever len > 1", () => {
    for (const len of [2, 3, 6, 8]) {
      for (let i = 0; i < 20; i++) {
        expect(roomPaletteIndex(i, len)).not.toBe(roomPaletteIndex(i + 1, len));
      }
    }
  });

  it("always returns a slot within [0, len)", () => {
    for (const index of [0, 1, 5, 11, 100]) {
      for (const len of [1, 2, 6, 8]) {
        const idx = roomPaletteIndex(index, len);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(len);
      }
    }
  });

  it("falls back to slot 0 for out-of-domain indices", () => {
    expect(roomPaletteIndex(-1, 6)).toBe(0); // findIndex not-found sentinel
    expect(roomPaletteIndex(-5, 6)).toBe(0);
    expect(roomPaletteIndex(NaN, 6)).toBe(0);
    expect(roomPaletteIndex(2.5, 6)).toBe(0);
  });

  it("returns 0 for a non-positive length", () => {
    expect(roomPaletteIndex(3, 0)).toBe(0);
    expect(roomPaletteIndex(3, -1)).toBe(0);
  });
});
