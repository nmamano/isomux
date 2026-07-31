// Isometric grid layout for the desks (see shared/desks.ts for the slot list)
// All coordinates are in SVG space (viewBox: -450 -100 1100 700)

// Scene container dimensions and viewBox - sized wall-to-wall (left wall -355 to right wall 595)
export const SCENE_W = 950,
  SCENE_H = 700;
export const VB_X = -355,
  VB_Y = -100;

// Returns the SVG-space floor coordinate for a desk slot
export function isoXY(row: number, col: number) {
  // 2:1 isometric ratio matching walls and floor tiles.
  // 3.5 floor tiles per desk step: (140, 70).
  // Extra gap between the two columns so right-column desks aren't hidden behind left-column ones.
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
// before any repeats - an explicit product decision (task 5c10494a): the
// id-hash keying tried in 3c.3 collapsed onto few palettes on real offices
// (5 of 12 rooms identical, 4 adjacent), and Nil prefers variety/adjacency
// over colour stability. Accepted tradeoff: rooms recolour when the list
// order changes (reorder/close). Callers pass `rooms.findIndex(...)`, so a
// not-found -1 (and any other out-of-domain input) falls back to slot 0.
export function roomPaletteIndex(roomIndex: number, len: number): number {
  if (len <= 0 || !Number.isInteger(roomIndex) || roomIndex < 0) return 0;
  return roomIndex % len;
}
