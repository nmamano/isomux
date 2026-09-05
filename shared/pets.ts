// The office pet a room keeps: which animal, and which of that animal's coats.
//
// The DRAWINGS live in ui/office/RoomProps.tsx, but the coat lists live here,
// because the server validates a requested coat index against the length of the
// list its species is drawn in. Keeping only the LENGTHS here and the colours in
// the UI would mean two hand-maintained lists and a test whose whole job is to
// notice when they drift, which makes the duplication survivable instead of
// removing it. One list, imported by both sides. Same reason shared/desks.ts
// owns the desk-slot list. Never the reverse: shared/ must not import UI.

// `line` colours eyes, whiskers and other hairline strokes; dark coats need a
// light stroke or the face disappears into the body (the black cat used to
// render as a blob). `mark` is the second coat colour - stripes, patches,
// shell scutes, a wing. `inner` is the smaller skin-ish part: inner ear, bare
// shell skin, bare tortoise skin.
export interface PetPalette {
  coat: string;
  mark: string;
  inner: string;
  nose: string;
  line: string;
  /** Read by the dog only. On a dark coat the hairline mouth stroke has to be
   *  light to be seen at all, and a light curve on a brown muzzle reads as bared
   *  teeth. Those coats get a tongue instead. */
  tongue?: boolean;
}

export const CAT_PALETTES: PetPalette[] = [
  // orange tabby
  { coat: "#E8A050", mark: "#C08030", inner: "#D08040", nose: "#D08080", line: "#333333" },
  // silver
  { coat: "#A0A0A8", mark: "#707078", inner: "#909098", nose: "#C09090", line: "#333333" },
  // black
  { coat: "#3A3A3A", mark: "#222222", inner: "#4A4A4A", nose: "#A07070", line: "#C8C8C8" },
  // white
  { coat: "#E8E0D8", mark: "#C0B8B0", inner: "#DCC8C0", nose: "#D0A0A0", line: "#333333" },
  // ginger
  { coat: "#D07030", mark: "#A05020", inner: "#C06030", nose: "#C07060", line: "#333333" },
  // siamese
  { coat: "#E0D8C8", mark: "#8B7060", inner: "#C0A890", nose: "#C08888", line: "#333333" },
];

export const DOG_PALETTES: PetPalette[] = [
  // golden retriever
  { coat: "#E0B070", mark: "#C08F4E", inner: "#EFCE9C", nose: "#3A3028", line: "#333333" },
  // chocolate
  { coat: "#7A5238", mark: "#5A3A26", inner: "#9A7052", nose: "#2E2620", line: "#EFE4D8" , tongue: true },
  // black and tan
  { coat: "#3C3630", mark: "#26221E", inner: "#8A6A44", nose: "#1E1A16", line: "#D8D0C4" , tongue: true },
  // grey husky
  { coat: "#A8A8AE", mark: "#6E6E76", inner: "#E4E0DA", nose: "#2E2E34", line: "#333333" },
  // cream
  { coat: "#EFE2CC", mark: "#CDBB9C", inner: "#FAF3E6", nose: "#4A3E32", line: "#333333" },
];

export const RABBIT_PALETTES: PetPalette[] = [
  // dutch grey
  { coat: "#B4AEA6", mark: "#8A857E", inner: "#EAC4C4", nose: "#C08C8C", line: "#333333" },
  // chestnut
  { coat: "#9E7048", mark: "#7A5232", inner: "#E0B0A4", nose: "#B47C74", line: "#333333" },
  // cream lop
  { coat: "#EDDFC6", mark: "#CCB893", inner: "#F0C0BC", nose: "#C08C88", line: "#333333" },
  // blue
  { coat: "#8E96A2", mark: "#6A727E", inner: "#DCB6B6", nose: "#B08484", line: "#333333" },
];

export const TORTOISE_PALETTES: PetPalette[] = [
  // olive
  { coat: "#7C8A4A", mark: "#5A6634", inner: "#B6B27C", nose: "#4A4632", line: "#2E2A20" },
  // horsfield brown
  { coat: "#9A7A46", mark: "#6E5630", inner: "#C4A874", nose: "#54462C", line: "#2E2A20" },
  // amber - the old sandy shell vanished against its own sand box
  { coat: "#C8934A", mark: "#96682C", inner: "#E3C48E", nose: "#6A5838", line: "#2E2A20" },
];

export const PET_SPECIES = ["cat", "dog", "rabbit", "tortoise"] as const;

export type PetSpecies = (typeof PET_SPECIES)[number];

/** Every species' coats, in the order the picker shows them. A room stores an
 *  index into the list for ITS species. */
export const PET_PALETTES: Record<PetSpecies, PetPalette[]> = {
  cat: CAT_PALETTES,
  dog: DOG_PALETTES,
  rabbit: RABBIT_PALETTES,
  tortoise: TORTOISE_PALETTES,
};

/** A room's chosen pet. `null` on a room means nobody has chosen. */
export interface RoomPet {
  species: PetSpecies;
  coat: number;
}

/** What a room draws when its pet is null: the cat in its first coat, which is
 *  the pet every room had before the picker existed. */
export const DEFAULT_ROOM_PET: RoomPet = { species: "cat", coat: 0 };

export function isPetSpecies(value: unknown): value is PetSpecies {
  return (
    typeof value === "string" &&
    (PET_SPECIES as readonly string[]).includes(value)
  );
}

/** Narrows an untrusted value to a RoomPet. `null` and `undefined` both mean
 *  "no pet", so a request body can clear the field the same way it omits it.
 *
 *  This validates a coat index at the moment it is WRITTEN. It cannot validate
 *  one already on disk: shortening a coat list leaves stored rooms pointing past
 *  the end, which has happened twice in this list's short life. The drawing side
 *  is what has to survive that - see coatFor in ui/office/RoomProps.tsx. */
export function parseRoomPet(
  value: unknown,
): { ok: true; pet: RoomPet | null } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: true, pet: null };
  if (typeof value !== "object") {
    return { ok: false, reason: "pet must be an object or null" };
  }
  const { species, coat } = value as { species?: unknown; coat?: unknown };
  if (!isPetSpecies(species)) {
    return {
      ok: false,
      reason: `pet.species must be one of: ${PET_SPECIES.join(", ")}`,
    };
  }
  const count = PET_PALETTES[species].length;
  if (
    typeof coat !== "number" ||
    !Number.isInteger(coat) ||
    coat < 0 ||
    coat >= count
  ) {
    return {
      ok: false,
      reason: `pet.coat must be an integer in 0..${count - 1} for species ${species}`,
    };
  }
  return { ok: true, pet: { species, coat } };
}
