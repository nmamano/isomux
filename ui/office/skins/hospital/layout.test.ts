// Where the ward furniture is allowed to stand.
//
// The hospital layer is drawn BEFORE the eight desks, so a desk that overlaps
// a bed paints over it. The beds that shipped first stood on desk slots 2 and
// 4, and an occupied desk cut the head off the bed behind it - which is the
// defect this file exists to keep out. A bed is big and immobile in a room
// that is already full of desks, so "does it fit" is arithmetic, not taste,
// and arithmetic belongs in a test rather than in a screenshot somebody has to
// remember to take.

import { expect, test } from "bun:test";
import { DESK_SLOTS } from "../../../../shared/desks.ts";
import { isoXY } from "../../grid.ts";
import { BED_SPOTS, BED_U, BED_V, PLACEMENT, bedBox } from "./props.tsx";

// What one occupied desk PAINTS, as an offset from its floor point, measured
// off a real browser render of all eight desks (2026-09-16, headless Chrome,
// union of every painted element in the desk and its character).
//
// The ink runs to 31 below the floor point, but the last 26 of that is the
// desk's soft floor shadow - a 12%-black blur the beds are allowed to stand
// on, and which would otherwise push both of them off the front edge of the
// room. The bound below is the solid furniture.
const DESK_INK = { left: 70, right: 70, up: 123, down: 5 };

function deskBox(slot: { row: number; col: number }) {
  const { x, y } = isoXY(slot.row, slot.col);
  return {
    minX: x - DESK_INK.left,
    maxX: x + DESK_INK.right,
    minY: y - DESK_INK.up,
    maxY: y + DESK_INK.down,
  };
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
  );
}

test("no bed stands where an occupied desk would paint over it", () => {
  for (const spot of BED_SPOTS) {
    const bed = bedBox(PLACEMENT[spot]);
    for (const [i, slot] of DESK_SLOTS.entries()) {
      expect({ spot, desk: i + 1, hit: overlaps(bed, deskBox(slot)) }).toEqual({
        spot,
        desk: i + 1,
        hit: false,
      });
    }
  }
});

// The floor is the diamond the tiles are laid on (ui/office/Floor.tsx): back
// corner, then the two side corners the walls stand on, then the front corner
// nearest the viewer. A bed whose foot hangs over one of those edges stands on
// the slab, or on nothing.
const FLOOR = {
  back: { x: 120, y: 40 },
  left: { x: -355, y: 277.5 },
  right: { x: 595, y: 277.5 },
  front: { x: 120, y: 515 },
};

/** Both floor axes run at the scene's 2:1 slope, so a point is on the floor
 *  when it is inside all four edges - and each edge is a straight |dx| = 2|dy|
 *  comparison against the corner it starts from. */
function onFloor(p: { x: number; y: number }): boolean {
  return (
    p.y >= FLOOR.back.y + Math.abs(p.x - FLOOR.back.x) / 2 &&
    p.y <= FLOOR.front.y - Math.abs(p.x - FLOOR.front.x) / 2 &&
    p.x >= FLOOR.left.x + Math.abs(p.y - FLOOR.left.y) * 2 &&
    p.x <= FLOOR.right.x - Math.abs(p.y - FLOOR.right.y) * 2
  );
}

test("every bed stands with all four castors on the floor", () => {
  for (const spot of BED_SPOTS) {
    const at = PLACEMENT[spot];
    // The bed's footprint: half a bed along each floor axis, in all four
    // combinations. These are the points the castors touch.
    const corners = [
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ].map(([u, v]) => ({
      x: at.x + BED_U.x * u + BED_V.x * v,
      y: at.y + BED_U.y * u + BED_V.y * v,
    }));
    for (const [i, corner] of corners.entries()) {
      expect({ spot, corner: i, on: onFloor(corner) }).toEqual({
        spot,
        corner: i,
        on: true,
      });
    }
  }
});

// HospitalProps draws the layer straight out of PLACEMENT, so the list's order
// is the painting order. A prop listed before one that stands FURTHER from the
// viewer is painted behind it, which reads as the near prop having a hole in
// it - the same failure the desks caused, from inside the layer this time.
test("the furniture is listed back to front", () => {
  const depths = Object.values(PLACEMENT).map((p) => p.y);
  expect(depths).toEqual([...depths].sort((a, b) => a - b));
});
