// Isometric grid layout for 8 desks (2 columns x 4 rows)
// All coordinates are in SVG space (viewBox: -360 -60 900 600)

export const DESK_SLOTS = [
  { row: 0, col: 0 },
  { row: 0, col: 1 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
  { row: 2, col: 0 },
  { row: 2, col: 1 },
  { row: 3, col: 0 },
  { row: 3, col: 1 },
];

// Scene container dimensions and viewBox
export const SCENE_W = 900, SCENE_H = 600;
export const VB_X = -360, VB_Y = -60;

// Returns the SVG-space floor coordinate for a desk slot
export function isoXY(row: number, col: number) {
  // 2:1 isometric ratio matching walls and floor tiles.
  // 2.5 floor tiles per desk step: (100, 50).
  return {
    x: (col - row) * 100 + 220,
    y: (col + row) * 50 + 120,
  };
}

// Convert SVG coordinate to pixel position within the 900×600 scene container.
// The desk sprite's ground contact (chair legs) is at ~(90, 116) in the 180×140 sprite.
export function deskPixelPos(row: number, col: number) {
  const { x, y } = isoXY(row, col);
  return {
    left: (x - VB_X) - 90,   // center the 180px-wide desk
    top: (y - VB_Y) - 116,   // anchor chair legs to floor point
  };
}
