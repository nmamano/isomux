// The back room's drawing (task 5b503e32): an isometric basement with n long
// tables of n stools. Its building is the front room's (task dc9786a8): the
// same floor, walls and place in the scene, so going down never changes the
// building's size. A seat's place comes from its stored (table, stool).

import type { BackSeat } from "../../../shared/desks.ts";
import {
  FLOOR_BACK_X,
  FLOOR_BACK_Y,
  FLOOR_N,
  SCENE_H,
  SCENE_W,
  VB_X,
  VB_Y,
} from "../grid.ts";

// Tile half-diagonals, as in the front room (ui/office/grid.ts).
export const TILE_A = 47.5;
export const TILE_B = 23.75;
// The front room's wall height, wall thickness and slab (ui/office/Floor.tsx).
export const WALL_H = 240;
export const WALL_T = 9;
export const SLAB_H = 14;
// Stool step along a table, and table step across tables, in tiles.
const SEAT_STEP = 1.0;
const TABLE_STEP = 1.45;
// Free floor around the tables, in tiles: at the left and right ends of the
// tables, behind the first table (the ladder stands there), and in front.
const MARGIN_C = 0.9;
const MARGIN_R = 1.2;
const MARGIN_FRONT = 0.6;
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
  /** The seating's scale: 1 while the tables fit the floor at their full
   *  size, less in a fuller room, where tables, stools and figures shrink
   *  together. */
  k: number;
  /** Screen point of floor coordinates (c along a table, r across). */
  at: (c: number, r: number) => Point;
  /** Where a seated figure's feet are. */
  seat: (s: BackSeat) => Point;
  /** The near-left corner of table j's top, and its length in tiles. */
  table: (j: number) => { c0: number; c1: number; r: number };
}

export function backRoomLayout(side: number): BackRoomLayout {
  const nc = FLOOR_N;
  const nr = FLOOR_N;
  const x0 = FLOOR_BACK_X - VB_X;
  const y0 = FLOOR_BACK_Y - VB_Y;
  const at = (c: number, r: number) => ({
    x: x0 + (c - r) * TILE_A,
    y: y0 + (c + r) * TILE_B,
  });
  // The tables' block at full size, and the floor it may take.
  const tablesC = side * SEAT_STEP + 0.2;
  const tablesR = (side - 1) * TABLE_STEP + TABLE_DEPTH;
  const freeC = nc - 2 * MARGIN_C;
  const freeR = nr - MARGIN_R - MARGIN_FRONT;
  const k = Math.min(1, freeC / tablesC, freeR / tablesR);
  // The block is centred on the free floor.
  const c0 = MARGIN_C + (freeC - k * tablesC) / 2;
  const r0 = MARGIN_R + (freeR - k * tablesR) / 2;
  const tableR = (j: number) => r0 + k * j * TABLE_STEP;
  return {
    side,
    nc,
    nr,
    width: SCENE_W,
    height: SCENE_H,
    k,
    at,
    seat: (s) =>
      at(c0 + k * (0.5 + s.stool * SEAT_STEP), tableR(s.table) - 0.04 * k),
    table: (j) => ({ c0, c1: c0 + k * tablesC, r: tableR(j) }),
  };
}
