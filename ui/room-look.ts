// The room settings pane's staged look: the preset, the decor tiles picked
// since the last save, and the pet. Everything stays local until Save, which
// sends one PATCH with only what changed. internal-docs/room-customization-design.md
// has the rules this follows.

import {
  ROOM_DECOR_SLOTS,
  type ResolvedRoomDecor,
} from "../shared/room-decor.ts";
import { effectiveRoomSkin, type RoomSkin } from "../shared/room-skins.ts";
import type { RoomPet } from "../shared/pets.ts";
import type { RoomRenameReq } from "../shared/contract-shapes.ts";
import type { RoomWire } from "../shared/types.ts";

export interface RoomLook {
  skin: RoomSkin;
  /** A preset tile was picked: the room's stored choices are dropped, and
   *  only `picks` sit on top of the preset. */
  reset: boolean;
  /** Tiles picked in the pane, stored as they are even when one equals what
   *  the preset would draw - that is how a rotating default gets pinned. */
  picks: Partial<ResolvedRoomDecor>;
  pet: RoomPet | null;
}

export function initialRoomLook(room: RoomWire | undefined): RoomLook {
  return {
    skin: effectiveRoomSkin(room),
    reset: false,
    picks: {},
    pet: room?.pet ?? null,
  };
}

export function pickPreset(look: RoomLook, skin: RoomSkin): RoomLook {
  return { ...look, skin, reset: true, picks: {} };
}

export function pickDecor<S extends keyof ResolvedRoomDecor>(
  look: RoomLook,
  slot: S,
  value: ResolvedRoomDecor[S],
): RoomLook {
  return { ...look, picks: { ...look.picks, [slot]: value } };
}

/** A species or a coat: the pet is drawn from then on. */
export function pickPet(look: RoomLook, pet: RoomPet): RoomLook {
  return { ...pickDecor(look, "pet", "shown"), pet };
}

function samePet(a: RoomPet | null, b: RoomPet | null): boolean {
  return a?.species === b?.species && a?.coat === b?.coat;
}

/** The look fields of the PATCH body, or null when nothing changed since
 *  `saved` (the look as of the last load or save). */
export function roomLookBody(
  look: RoomLook,
  saved: RoomLook,
): Pick<RoomRenameReq, "skin" | "pet" | "decor"> | null {
  const body: Pick<RoomRenameReq, "skin" | "pet" | "decor"> = {};
  if (look.reset || look.skin !== saved.skin) body.skin = look.skin;
  if (look.reset) {
    // One PATCH cannot carry `decor: null` and new choices at once, so a reset
    // with choices on top clears every known slot by name and then sets them.
    if (Object.keys(look.picks).length === 0) {
      body.decor = null;
    } else {
      const patch: Record<string, string | null> = {};
      for (const slot of ROOM_DECOR_SLOTS) patch[slot] = null;
      body.decor = { ...patch, ...look.picks };
    }
  } else {
    const changed: Record<string, string> = {};
    for (const [slot, value] of Object.entries(look.picks)) {
      if (saved.picks[slot as keyof ResolvedRoomDecor] !== value) {
        changed[slot] = value;
      }
    }
    if (Object.keys(changed).length > 0) {
      body.decor = changed;
    }
  }
  if (!samePet(look.pet, saved.pet)) body.pet = look.pet;
  return Object.keys(body).length > 0 ? body : null;
}

/** The look after a successful save: the server now stores what was picked,
 *  so the reset is spent. */
export function savedRoomLook(look: RoomLook): RoomLook {
  return { ...look, reset: false };
}
