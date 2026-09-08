// Shared geometry for the lobby scene. It uses the office's isometric
// coordinate space (ui/office/grid.ts) so the scene drops into the same
// viewport rig as a desk room: same 950x700 box, same viewBox, same walls.
import { SCENE_W, SCENE_H, VB_X, VB_Y } from "../grid.ts";

export const VB = `${VB_X} ${VB_Y} ${SCENE_W} ${SCENE_H}`;

export const SVG_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
};

// Floor diamond (matches Floor.tsx): back, left, right, front corners.
export const FLOOR_BACK = { x: 120, y: 40 };
export const FLOOR_LEFT = { x: -355, y: 277.5 };
export const FLOOR_RIGHT = { x: 595, y: 277.5 };
export const FLOOR_FRONT = { x: 120, y: 515 };
export const FLOOR_CLIP = `M${FLOOR_BACK.x} ${FLOOR_BACK.y} L${FLOOR_LEFT.x} ${FLOOR_LEFT.y} L${FLOOR_FRONT.x} ${FLOOR_FRONT.y} L${FLOOR_RIGHT.x} ${FLOOR_RIGHT.y} Z`;

// One tile step along each iso axis (10 x 10 tiles cover the diamond).
export const ROW = { dx: -47.5, dy: 23.75 }; // towards the left corner
export const COL = { dx: 47.5, dy: 23.75 }; // towards the right corner
export const TILES = 10;

// Slab thickness and the outer corners where the slab passes under the wall.
export const SLAB_H = 14;
export const OUTER_LEFT = { x: -364, y: 273 };
export const OUTER_RIGHT = { x: 604, y: 273 };

// Wall apex (back corner, top of the walls) and wall height.
export const WALL_APEX = { x: 120, y: -200 };
export const WALL_TOP_Y = 37.5; // wall top at the outer x edges

// Map a point on the floor plane: (r, c) in tile units, r along ROW, c along COL.
export function floorXY(r: number, c: number) {
  return {
    x: FLOOR_BACK.x + r * ROW.dx + c * COL.dx,
    y: FLOOR_BACK.y + r * ROW.dy + c * COL.dy,
  };
}
