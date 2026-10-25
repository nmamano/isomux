// The receptionist's size in the lobby scene. Its own module, so the lobby
// scene can place the receptionist's keyboard button without importing the
// live figure (which reads the store).
import { CHARACTER_GEOMETRY } from "./Character.tsx";

// Keep the sprite modestly larger than a desk agent, anchored at its feet.
export const RECEPTIONIST_SCALE = 1.2;
const HALF_W = CHARACTER_GEOMETRY.width / 2;
// The nametag sits at the top of the figure.
export const RECEPTIONIST_PILL_Y =
  -CHARACTER_GEOMETRY.feetY * RECEPTIONIST_SCALE;

// The figure's hit box, feet at the origin: the sprite column up to the tag.
// The lobby puts the receptionist's keyboard button over the same box.
export const RECEPTIONIST_HIT = {
  x: -HALF_W * RECEPTIONIST_SCALE - 4,
  y: RECEPTIONIST_PILL_Y - 12,
  width: HALF_W * 2 * RECEPTIONIST_SCALE + 8,
  height: -RECEPTIONIST_PILL_Y + 14,
};
