// Isometric grid layout for the desks (see shared/desks.ts for the slot list)
// All coordinates are in SVG space (viewBox: -355 -100 950 700)

// Scene viewport spans -355 to 595; wall thickness overhangs from -364 to 604.
export const SCENE_W = 950,
  SCENE_H = 700;
export const VB_X = -355,
  VB_Y = -100;

// The floor tile grid: N x N tiles from the back corner, where the two walls
// meet the floor. A row step goes down-left and a column step down-right, both
// at the 2:1 isometric slope.
export const FLOOR_BACK_X = 120,
  FLOOR_BACK_Y = 40;
export const FLOOR_ROW_DX = -47.5,
  FLOOR_ROW_DY = 23.75;
export const FLOOR_COL_DX = 47.5,
  FLOOR_COL_DY = 23.75;
export const FLOOR_N = 10;

// The floor diamond's outline, from the back corner through the left, front
// and right corners: M120 40 L-355 277.5 L120 515 L595 277.5 Z.
export const FLOOR_CLIP = (() => {
  const left = {
    x: FLOOR_BACK_X + FLOOR_N * FLOOR_ROW_DX,
    y: FLOOR_BACK_Y + FLOOR_N * FLOOR_ROW_DY,
  };
  const right = {
    x: FLOOR_BACK_X + FLOOR_N * FLOOR_COL_DX,
    y: FLOOR_BACK_Y + FLOOR_N * FLOOR_COL_DY,
  };
  const front = {
    x: left.x + FLOOR_N * FLOOR_COL_DX,
    y: left.y + FLOOR_N * FLOOR_COL_DY,
  };
  return `M${FLOOR_BACK_X} ${FLOOR_BACK_Y} L${left.x} ${left.y} L${front.x} ${front.y} L${right.x} ${right.y} Z`;
})();

// Returns the SVG-space floor coordinate for a desk slot
export function isoXY(row: number, col: number) {
  // 2:1 isometric ratio matching walls and floor tiles.
  // The desk step is (120, 60) per row and per column.
  // Extra gap of 60 on both axes between the two columns, so right-column
  // desks aren't hidden behind left-column ones.
  const colGap = col >= 1 ? 60 : 0;
  return {
    x: (col - row) * 120 + 220 + colGap,
    y: (col + row) * 60 + 120 + colGap,
  };
}

// Convert SVG coordinate to pixel position within the 1100×700 scene container.
// The desk sprite's ground contact (chair legs) is at ~(90, 116) in the 180×140 sprite.
export function deskPixelPos(row: number, col: number) {
  const { x, y } = isoXY(row, col);
  return {
    left: x - VB_X - 90, // center the 180px-wide desk
    top: y - VB_Y - 116, // anchor chair legs to floor point
  };
}

// Pick a palette slot for a room from its POSITION in the room list. Cycling
// by index guarantees adjacent rooms always differ and every palette appears
// before any repeats - an explicit product decision: the
// id-hash keying collapsed onto few palettes on real offices
// (5 of 12 rooms identical, 4 adjacent), and variety/adjacency takes priority
// over colour stability. Accepted tradeoff: rooms recolour when the list
// order changes (reorder/close). Callers pass `rooms.findIndex(...)`, so a
// not-found -1 (and any other out-of-domain input) falls back to slot 0.
export function roomPaletteIndex(roomIndex: number, len: number): number {
  if (len <= 0 || !Number.isInteger(roomIndex) || roomIndex < 0) return 0;
  return roomIndex % len;
}
