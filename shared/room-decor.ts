// The decorations a room's members chose, on top of its preset (the room's
// `skin`). A room stores only the slots somebody picked: what the scene draws
// for every other slot is the preset's value, and the presets live in
// ui/office/skins/, beside the drawings. internal-docs/room-customization-design.md
// has the whole design.
//
// The slot ids and their wire values live here, not in the UI, because the
// server validates a requested change against them - the same split
// shared/room-skins.ts and shared/pets.ts use. Never the reverse: shared/ must
// not import UI.

export const ROOM_DECOR_OPTIONS = {
  walls: ["office", "clinic"],
  curtains: ["none", "tied"],
  sill: ["trailing", "blossom", "none"],
  wallArt: ["neon", "landscape", "chart", "none"],
  trim: ["none", "rail"],
  cabinet: ["none", "first-aid"],
  floorPlant: ["plant", "none"],
  ward: ["none", "beds"],
  pet: ["shown", "none"],
} as const;

export type RoomDecorSlot = keyof typeof ROOM_DECOR_OPTIONS;

/** The slots in the order the settings section shows them. */
export const ROOM_DECOR_SLOTS = Object.keys(
  ROOM_DECOR_OPTIONS,
) as RoomDecorSlot[];

export type RoomDecorValue<S extends RoomDecorSlot = RoomDecorSlot> =
  (typeof ROOM_DECOR_OPTIONS)[S][number];

/** A room's stored choices: only the slots somebody picked. */
export type RoomDecor = { [S in RoomDecorSlot]?: RoomDecorValue<S> };

/** One value for every slot: what a room actually draws. */
export type ResolvedRoomDecor = { [S in RoomDecorSlot]: RoomDecorValue<S> };

/** A requested change: a value sets that slot, null clears it back to the
 *  preset, and an absent key leaves it as it is. */
export type RoomDecorPatch = {
  [S in RoomDecorSlot]?: RoomDecorValue<S> | null;
};

export function isRoomDecorSlot(value: unknown): value is RoomDecorSlot {
  return typeof value === "string" && Object.hasOwn(ROOM_DECOR_OPTIONS, value);
}

export function isRoomDecorValue<S extends RoomDecorSlot>(
  slot: S,
  value: unknown,
): value is RoomDecorValue<S> {
  return (
    typeof value === "string" &&
    (ROOM_DECOR_OPTIONS[slot] as readonly string[]).includes(value)
  );
}

/** The usable part of a stored map. Total over its input: a slot or a value
 *  this build does not know is dropped, so the scene draws the preset's value
 *  there - a record written by a newer version, or hand-edited, still draws. */
export function storedRoomDecor(value: unknown): RoomDecor {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [slot, v] of Object.entries(value)) {
    if (isRoomDecorSlot(slot) && isRoomDecorValue(slot, v)) out[slot] = v;
  }
  return out;
}

/** Narrows an untrusted request value. `null` clears every choice; an object
 *  is a patch, and every key and value in it has to be known. */
export function parseRoomDecorPatch(
  value: unknown,
): { ok: true; patch: RoomDecorPatch | null } | { ok: false; reason: string } {
  if (value === null) return { ok: true, patch: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "decor must be an object or null" };
  }
  const patch: Record<string, string | null> = {};
  for (const [slot, v] of Object.entries(value)) {
    if (!isRoomDecorSlot(slot)) {
      return {
        ok: false,
        reason: `decor slots are: ${ROOM_DECOR_SLOTS.join(", ")}`,
      };
    }
    if (v !== null && !isRoomDecorValue(slot, v)) {
      return {
        ok: false,
        reason: `decor.${slot} must be null or one of: ${ROOM_DECOR_OPTIONS[slot].join(", ")}`,
      };
    }
    patch[slot] = v;
  }
  return { ok: true, patch: patch };
}

/** The stored map after a patch. `null` when nothing is left, so a room whose
 *  choices were all cleared stores what a room that never had any stores. */
export function applyRoomDecorPatch(
  current: unknown,
  patch: RoomDecorPatch | null,
): RoomDecor | null {
  if (patch === null) return null;
  const next: Record<string, string> = { ...storedRoomDecor(current) };
  for (const [slot, v] of Object.entries(patch)) {
    if (v === null) delete next[slot];
    else next[slot] = v;
  }
  return Object.keys(next).length > 0 ? next : null;
}
