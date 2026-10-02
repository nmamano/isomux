// The room pet is a stored setting now, not a function of the room's position.
// What the drawing still owes: it must be total over what is stored, because a
// coat index on disk can outlive the coat list it was written against.

import { expect, test } from "bun:test";
import { PETS, coatFor, drawnPet } from "./RoomProps.tsx";
import {
  DEFAULT_ROOM_PET,
  PET_PALETTES,
  PET_SPECIES,
  parseRoomPet,
  type RoomPet,
} from "../../shared/pets.ts";

test("every species is drawn and has at least one coat", () => {
  for (const species of PET_SPECIES) {
    expect(PETS[species]).toBeDefined();
    expect(PET_PALETTES[species].length).toBeGreaterThan(0);
  }
});

test("the default pet is a coat the cat actually has", () => {
  expect(PET_SPECIES).toContain(DEFAULT_ROOM_PET.species);
  expect(
    PET_PALETTES[DEFAULT_ROOM_PET.species][DEFAULT_ROOM_PET.coat],
  ).toBeDefined();
});

test("a stored coat index picks that coat", () => {
  for (const species of PET_SPECIES) {
    const palettes = PET_PALETTES[species];
    for (let coat = 0; coat < palettes.length; coat++) {
      expect(coatFor({ species, coat })).toBe(palettes[coat]);
    }
  }
});

// The server validates a coat index when it is written and cannot validate one
// already on disk. Two coat lists have already got shorter in this file's life,
// so a room persisted against a longer list is a real state, not a hypothetical.
// A species this build does not know reaches the drawing the same way a stale
// coat does: nothing parses the pet when a room is loaded from disk, so a
// hand-edited agents.json or a rollback past a version that added a species
// puts it straight into RoomWire. "duck" was a species in this file until a
// few days ago.
test("an unknown species falls back to the default, and does not throw", () => {
  const pet = { species: "duck", coat: 0 } as unknown as RoomPet;
  expect(() => coatFor(pet)).not.toThrow();
  expect(coatFor(pet)).toBe(PET_PALETTES[DEFAULT_ROOM_PET.species][0]);
  const both = { species: "duck", coat: 42 } as unknown as RoomPet;
  expect(coatFor(both)).toBe(PET_PALETTES[DEFAULT_ROOM_PET.species][0]);
});

test("a coat index past the end of its list falls back, never undefined", () => {
  for (const species of PET_SPECIES) {
    const palettes = PET_PALETTES[species];
    for (const coat of [palettes.length, palettes.length + 7, 99]) {
      expect(coatFor({ species, coat })).toBe(palettes[0]);
    }
  }
});

test("parseRoomPet accepts null and every drawable coat", () => {
  expect(parseRoomPet(null)).toEqual({ ok: true, pet: null });
  expect(parseRoomPet(undefined)).toEqual({ ok: true, pet: null });
  for (const species of PET_SPECIES) {
    const last = PET_PALETTES[species].length - 1;
    expect(parseRoomPet({ species, coat: last })).toEqual({
      ok: true,
      pet: { species, coat: last },
    });
  }
});

test("parseRoomPet rejects an unknown species and an out-of-range coat", () => {
  for (const bad of [
    { species: "duck", coat: 0 },
    { species: "cat", coat: -1 },
    { species: "cat", coat: PET_PALETTES.cat.length },
    { species: "cat", coat: 1.5 },
    { species: "cat" },
    "cat",
    42,
  ]) {
    expect(parseRoomPet(bad).ok).toBe(false);
  }
});

// The species and coat the scene and the settings section both show: the same
// fallbacks as coatFor, so the two can never disagree about an animal.
test("drawnPet falls back the way coatFor does", () => {
  expect(drawnPet(null)).toEqual(DEFAULT_ROOM_PET);
  for (const species of ["duck", "constructor", "__proto__"]) {
    const pet = { species, coat: 1 } as unknown as RoomPet;
    expect(drawnPet(pet)).toEqual({
      species: DEFAULT_ROOM_PET.species,
      coat: 1,
    });
    expect(coatFor(pet)).toBe(PET_PALETTES[DEFAULT_ROOM_PET.species][1]);
  }
  expect(drawnPet({ species: "dog", coat: 42 })).toEqual({
    species: "dog",
    coat: 0,
  });
  expect(drawnPet({ species: "dog", coat: 1.5 })).toEqual({
    species: "dog",
    coat: 0,
  });
});
