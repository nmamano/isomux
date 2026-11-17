import { DESK_COUNT } from "../shared/desks.ts";

// The office's shape as last drawn on this device (task ea29a8e2): the
// room tabs, the online chip, the tucked chip and the occupied desks of
// the room in view, and the bar's counts row and the phone menu's dot (task
// 73b5c130). Until the office state arrives, the tab bar, the room scene
// and the bar draw dim placeholders of it, so nothing moves at load.
// Geometry only: no names, so the next member on this browser sees
// nothing of the last one's office.

export type OfficeShapeDesk = {
  // The desk slot, 0..DESK_COUNT-1.
  desk: number;
  // The agent's name tag box.
  w: number;
  h: number;
};

export type OfficeShape = {
  // Each tab of the bar, in order, its close button included.
  tabs: number[];
  // The online chip's width; 0 when none was drawn.
  online: number;
  // The tucked-rooms chip's width; 0 when none was drawn.
  tucked: number;
  // The occupied desks of the front room in view.
  desks: OfficeShapeDesk[];
  // The bar's working and error counts row's width; 0 when none was drawn
  // (task 73b5c130).
  counts: number;
  // The phone menu's trigger drew its badge dot (task 73b5c130).
  dot: boolean;
};

/** The most tabs a stored shape may hold: a corrupt cache draws no more. */
export const OFFICE_SHAPE_MAX_TABS = 200;
/** The largest px value a stored shape may hold. */
export const OFFICE_SHAPE_MAX_PX = 2000;

/** The shape drawn on a device with no stored one. */
export const OFFICE_SHAPE_DEFAULT: OfficeShape = {
  tabs: [100],
  online: 110,
  tucked: 0,
  desks: [],
  counts: 0,
  dot: false,
};

/** A stored shape, or null when it is not a valid, sane OfficeShape. Junk
 *  anywhere gives null, never a partly kept shape; unknown keys drop. A
 *  shape stored before task 73b5c130 reads as no counts row and no dot. */
export function parseOfficeShape(raw: unknown): OfficeShape | null {
  if (!isRecord(raw)) return null;
  const { tabs, online, tucked, desks } = raw;
  // A shape stored before task 73b5c130 has no counts and no dot.
  const counts = raw.counts === undefined ? 0 : raw.counts;
  const dot = raw.dot === undefined ? false : raw.dot;
  if (!isShapePx(counts) || typeof dot !== "boolean") return null;
  if (!Array.isArray(tabs) || tabs.length > OFFICE_SHAPE_MAX_TABS) return null;
  if (!tabs.every(isShapePx) || !isShapePx(online) || !isShapePx(tucked))
    return null;
  if (!Array.isArray(desks)) return null;
  const seen = new Set<number>();
  const kept: OfficeShapeDesk[] = [];
  for (const d of desks as unknown[]) {
    if (
      !isRecord(d) ||
      typeof d.desk !== "number" ||
      !Number.isInteger(d.desk) ||
      d.desk < 0 ||
      d.desk >= DESK_COUNT ||
      seen.has(d.desk) ||
      !isShapePx(d.w) ||
      !isShapePx(d.h)
    )
      return null;
    seen.add(d.desk);
    kept.push({ desk: d.desk, w: d.w, h: d.h });
  }
  return { tabs: [...tabs], online, tucked, desks: kept, counts, dot };
}

/** A measured px value as stored: whole, inside the caps. */
export const shapePx = (n: number): number =>
  Math.min(OFFICE_SHAPE_MAX_PX, Math.max(0, Math.round(n)));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isShapePx = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= OFFICE_SHAPE_MAX_PX;
