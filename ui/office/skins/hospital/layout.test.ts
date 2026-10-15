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
import { FLOOR_COL_DX, FLOOR_COL_DY, isoXY } from "../../grid.ts";
import { BED_SPOTS, BED_U, BED_V, PLACEMENT, bedBox } from "./props.tsx";
import { PET_SPOT } from "../../RoomProps.tsx";
import { TRAP_DOOR_CENTER, TRAP_DOOR_U, TRAP_DOOR_V } from "../../TrapDoor.tsx";

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

// The pet bed with any animal in it, from its floor point: the widest bed and
// the shadow under it across, and the tallest ears up.
const PET_INK = { left: 31, right: 31, up: 30, down: 29 };

function petBox(at: { x: number; y: number }): Box {
  return {
    minX: at.x - PET_INK.left,
    maxX: at.x + PET_INK.right,
    minY: at.y - PET_INK.up,
    maxY: at.y + PET_INK.down,
  };
}

// A room can show the ward and a pet together. The pet keeps its own corner,
// so the ward stands clear of it, as it does of every desk.
test("the pet stands in its corner, clear of the bed and the desks", () => {
  const at = PET_SPOT;
  const pet = petBox(at);
  for (const spot of BED_SPOTS) {
    expect({ spot, hit: overlaps(pet, bedBox(PLACEMENT[spot])) }).toEqual({
      spot,
      hit: false,
    });
  }
  for (const [i, slot] of DESK_SLOTS.entries()) {
    expect({ desk: i + 1, hit: overlaps(pet, deskBox(slot)) }).toEqual({
      desk: i + 1,
      hit: false,
    });
  }
  for (const corner of [
    { x: pet.minX, y: at.y + PET_INK.down },
    { x: pet.maxX, y: at.y + PET_INK.down },
    { x: pet.minX, y: at.y },
    { x: pet.maxX, y: at.y },
  ]) {
    expect({ corner, on: onFloor(corner) }).toEqual({ corner, on: true });
  }
});

// The ward stands between the pet and the trap door, and crowds neither (Nil,
// task e01ca389). Distances are between floor footprints, the shapes each
// piece covers on the floor plane, so a tall piece is not measured by its
// height.
type Point = { x: number; y: number };

function footprint(spot: keyof typeof PLACEMENT): Point[] {
  const at = PLACEMENT[spot];
  const shapes: Record<keyof typeof PLACEMENT, Array<[number, number]>> = {
    // The four castors (Bed in props.tsx).
    bed: [
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ].map(([u, v]): [number, number] => [
      BED_U.x * u + BED_V.x * v,
      BED_U.y * u + BED_V.y * v,
    ]),
    // The cabinet's base diamond (BedsideCabinet in decorations.tsx).
    cabinet: [
      [0, -18],
      [23, -6],
      [0, 6],
      [-23, -6],
    ],
    // The three feet (IvStand in props.tsx).
    ivStand: [
      [-14, 7],
      [14, 7],
      [0, -7],
    ],
  };
  return shapes[spot].map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy }));
}

// The hatch with its rim shadow, poly(1.12) in TrapDoor.tsx.
const HATCH: Point[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
].map(([u, v]) => ({
  x: TRAP_DOOR_CENTER.x + 1.12 * (TRAP_DOOR_U.x * u + TRAP_DOOR_V.x * v),
  y: TRAP_DOOR_CENTER.y + 1.12 * (TRAP_DOOR_U.y * u + TRAP_DOOR_V.y * v),
}));

// The pet bed's base on the floor, an ellipse as wide as PET_INK.
const PET_BASE: Point[] = Array.from({ length: 24 }, (_, i) => ({
  x: PET_SPOT.x + PET_INK.left * Math.cos((i * Math.PI) / 12),
  y: PET_SPOT.y + 4 + 15 * Math.sin((i * Math.PI) / 12),
}));

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** The gap between two convex outlines that do not overlap. */
function gap(a: Point[], b: Point[]): number {
  let best = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    for (const p of from)
      for (const [i, q] of to.entries())
        best = Math.min(best, segmentDistance(p, q, to[(i + 1) % to.length]));
  return best;
}

// One floor tile's edge: enough floor that neither the pet nor the hatch reads
// as part of the ward.
const MIN_CLEARANCE = Math.hypot(FLOOR_COL_DX, FLOOR_COL_DY);

test("the ward keeps clear floor to the pet and to the trap door", () => {
  // Between them: the bed's floor point projects onto the middle of the line
  // from the pet to the hatch.
  const bed = PLACEMENT.bed;
  const dx = TRAP_DOOR_CENTER.x - PET_SPOT.x;
  const dy = TRAP_DOOR_CENTER.y - PET_SPOT.y;
  const along =
    ((bed.x - PET_SPOT.x) * dx + (bed.y - PET_SPOT.y) * dy) /
    (dx * dx + dy * dy);
  expect({ along, between: along > 0.3 && along < 0.7 }).toMatchObject({
    between: true,
  });
  for (const spot of Object.keys(PLACEMENT) as Array<keyof typeof PLACEMENT>) {
    const piece = footprint(spot);
    expect({ spot, pet: gap(piece, PET_BASE) >= MIN_CLEARANCE }).toEqual({
      spot,
      pet: true,
    });
    expect({ spot, hatch: gap(piece, HATCH) >= MIN_CLEARANCE }).toEqual({
      spot,
      hatch: true,
    });
  }
});
