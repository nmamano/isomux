// The look a room is drawn in. A skin is a LOOK, not a type: it changes the
// floor, the walls and the props, and nothing else. The eight desks, the
// characters, the pet and the status lights behave the same under every skin.
//
// The ids live here, not in the UI, because the server validates a requested
// skin against them; the colours and the drawings live in ui/office/skins/,
// the same split shared/pets.ts uses for the pet. Never the reverse: shared/
// must not import UI.

export const ROOM_SKIN_IDS = ["office", "hospital"] as const;

export type RoomSkin = (typeof ROOM_SKIN_IDS)[number];

/** What a room draws when its skin is null or absent: the office, which is the
 *  look every room had before skins existed. */
export const DEFAULT_ROOM_SKIN: RoomSkin = "office";

export function isRoomSkin(value: unknown): value is RoomSkin {
  return (
    typeof value === "string" &&
    (ROOM_SKIN_IDS as readonly string[]).includes(value)
  );
}

/** The skin a room is actually drawn in. Total over its input: an absent field
 *  and a skin this build does not know both fall back to the office, so a room
 *  written by a newer version - or hand-edited - draws a room rather than
 *  nothing. */
export function effectiveRoomSkin(room?: {
  skin?: RoomSkin | null;
}): RoomSkin {
  const skin = room?.skin;
  return isRoomSkin(skin) ? skin : DEFAULT_ROOM_SKIN;
}

/** Narrows an untrusted value to a RoomSkin. `null` and `undefined` both mean
 *  "no skin", which draws the office - so a request body can clear the field
 *  the same way it omits it, like the pet. */
export function parseRoomSkin(
  value: unknown,
): { ok: true; skin: RoomSkin | null } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, skin: null };
  if (!isRoomSkin(value)) {
    return {
      ok: false,
      reason: `skin must be null or one of: ${ROOM_SKIN_IDS.join(", ")}`,
    };
  }
  return { ok: true, skin: value };
}
