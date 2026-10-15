// The back room's drawing (task 5b503e32): an isometric basement with n long
// tables of n stools, laid out in its own pixel space. A seat's place on screen
// comes from its stored (table, stool), so growing the room never moves a
// figure that is already seated.

import type { BackSeat } from "../../../shared/desks.ts";

// Tile half-diagonals, as in the front room (ui/office/grid.ts).
export const TILE_A = 47.5;
export const TILE_B = 23.75;
export const WALL_H = 175;
export const SLAB_H = 12;
// Stool step along a table, and table step across tables, in tiles.
export const SEAT_STEP = 1.0;
export const TABLE_STEP = 1.45;
// Free floor around the tables, in tiles.
const MARGIN_C = 0.9;
const MARGIN_R = 1.2;
export const TABLE_H = 12;
export const TABLE_DEPTH = 0.45;
// Figures are drawn at this fraction of the front room's character size.
export const FIGURE_SCALE = 0.56;

export interface Point {
  x: number;
  y: number;
}

export interface BackRoomLayout {
  side: number;
  /** Floor size in tiles: along a table, and across tables. */
  nc: number;
  nr: number;
  width: number;
  height: number;
  /** Screen point of floor coordinates (c along a table, r across). */
  at: (c: number, r: number) => Point;
  /** Where a seated figure's feet are. */
  seat: (s: BackSeat) => Point;
  /** The near-left corner of table j's top, and its length in tiles. */
  table: (j: number) => { c0: number; c1: number; r: number };
}

export function backRoomLayout(side: number): BackRoomLayout {
  const nc = side * SEAT_STEP + 2 * MARGIN_C;
  const nr = side * TABLE_STEP + MARGIN_R + 0.6;
  const x0 = nr * TILE_A + 20;
  const y0 = WALL_H + 60;
  const at = (c: number, r: number) => ({
    x: x0 + (c - r) * TILE_A,
    y: y0 + (c + r) * TILE_B,
  });
  const tableR = (j: number) => MARGIN_R + j * TABLE_STEP;
  return {
    side,
    nc,
    nr,
    width: (nc + nr) * TILE_A + 40,
    height: y0 + (nc + nr) * TILE_B + SLAB_H + 20,
    at,
    seat: (s) =>
      at(MARGIN_C + 0.5 + s.stool * SEAT_STEP, tableR(s.table) - 0.04),
    table: (j) => ({
      c0: MARGIN_C,
      c1: MARGIN_C + side * SEAT_STEP + 0.2,
      r: tableR(j),
    }),
  };
}

// The lowest scale the back room's rest view fits to, so a seat stays about
// 44 px wide along its table (a phone tap target) and a figure stays readable.
// Below it, the rest view crops; zoom still goes lower (task f0af4677).
export const MIN_SCALE = 0.83;
