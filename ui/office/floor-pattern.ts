import type { RoomDecorValue } from "../../shared/room-decor.ts";
import { FLOOR_N } from "./grid.ts";

// A floor pattern says which tone each floor cell takes. The floor draws its
// tiles AND the slab sides under the front edges from the same pattern, so the
// thick side always continues the cells it meets and the floor reads as one
// solid piece.

export type FloorPattern = RoomDecorValue<"floor">;
export type FloorTone = "light" | "dark";

export interface FloorPatternGrid {
  /** Cells per side. A pattern with smaller cells than the desk grid has more. */
  cells: number;
  tone: (row: number, col: number) => FloorTone;
}

// Each pattern: how many cells one desk-grid tile splits into per side, and
// which tone a cell takes.
const PATTERNS: Record<
  FloorPattern,
  { split: number; tone: (row: number, col: number) => FloorTone }
> = {
  checker: { split: 1, tone: (r, c) => ((r + c) % 2 === 0 ? "light" : "dark") },
  plain: { split: 1, tone: () => "light" },
  stripes: { split: 1, tone: (r) => (r % 2 === 0 ? "light" : "dark") },
  blocks: {
    split: 1,
    tone: (r, c) =>
      (Math.floor(r / 2) + Math.floor(c / 2)) % 2 === 0 ? "light" : "dark",
  },
  mosaic: { split: 2, tone: (r, c) => ((r + c) % 2 === 0 ? "light" : "dark") },
};

export function floorPattern(pattern: FloorPattern): FloorPatternGrid {
  const { split, tone } = PATTERNS[pattern] ?? PATTERNS.checker;
  return { cells: FLOOR_N * split, tone };
}

/** The tone of each slab segment along the two front edges, back to front.
 *  `left[i]` meets cell (cells - 1, i); `right[i]` meets cell (i, cells - 1). */
export function slabTones(pattern: FloorPattern): {
  left: FloorTone[];
  right: FloorTone[];
} {
  const { cells, tone } = floorPattern(pattern);
  const edge = Array.from({ length: cells }, (_, i) => i);
  return {
    left: edge.map((i) => tone(cells - 1, i)),
    right: edge.map((i) => tone(i, cells - 1)),
  };
}
