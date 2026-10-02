// What the preset table owes, independent of any scene: a preset for every id
// the server can store, an office preset that draws the room every office had
// before skins and decor, and - for a palette that repaints the room - only
// variables the themes actually define. A typo'd variable name is invisible at
// runtime (the scene keeps the theme's value and the room simply does not
// change), so the name check is the test that earns its place here.

import { expect, test } from "bun:test";
import {
  ROOM_PRESETS,
  presetDecor,
  resolveRoomDecor,
  sceneVarsFor,
} from "./index.tsx";
import {
  DEFAULT_ROOM_SKIN,
  ROOM_SKIN_IDS,
  effectiveRoomSkin,
  parseRoomSkin,
  type RoomSkin,
} from "../../../shared/room-skins.ts";
import {
  ROOM_DECOR_OPTIONS,
  ROOM_DECOR_SLOTS,
} from "../../../shared/room-decor.ts";
import type { RoomWire } from "../../../shared/types.ts";
import { THEMES } from "../../themes.ts";

const MODES = ["light", "dark"] as const;

function room(id: string, extra: Partial<RoomWire> = {}): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: true, ...extra };
}

test("every skin id has a preset, and every preset value is a known option", () => {
  expect(Object.keys(ROOM_PRESETS).sort()).toEqual([...ROOM_SKIN_IDS].sort());
  for (const id of ROOM_SKIN_IDS) {
    for (const blossom of [false, true]) {
      for (const hospitalIndex of [-1, 0, 1]) {
        const decor = ROOM_PRESETS[id]({ blossom, hospitalIndex });
        expect(Object.keys(decor).sort()).toEqual([...ROOM_DECOR_SLOTS].sort());
        for (const slot of ROOM_DECOR_SLOTS) {
          expect(
            (ROOM_DECOR_OPTIONS[slot] as readonly string[]).includes(
              decor[slot],
            ),
          ).toBe(true);
        }
      }
    }
  }
});

// The office preset is the drawing every room had before skins existed: the
// theme's own palette, the neon sign, the plants and the pet, and nothing the
// hospital hangs. That is what lets an absent field on an old record cost
// nothing.
test("the office preset draws the room every office had before decor", () => {
  const office = ROOM_PRESETS[DEFAULT_ROOM_SKIN]({
    blossom: false,
    hospitalIndex: -1,
  });
  expect(office).toEqual({
    walls: "office",
    curtains: "none",
    sill: "trailing",
    wallArt: "neon",
    trim: "none",
    cabinet: "none",
    floorPlant: "plant",
    ward: "none",
    pet: "shown",
  });
  for (const mode of MODES) expect(sceneVarsFor("office", mode)).toEqual({});
});

// The hospital preset is the hospital skin as it drew before it was a preset:
// clinic palette, curtains, rail, first-aid cabinet, beds, no neon and no pet.
test("the hospital preset draws the hospital skin as it was", () => {
  const ward = ROOM_PRESETS.hospital({ blossom: false, hospitalIndex: 0 });
  expect(ward).toEqual({
    walls: "clinic",
    curtains: "tied",
    sill: "trailing",
    wallArt: "landscape",
    trim: "rail",
    cabinet: "first-aid",
    floorPlant: "plant",
    ward: "beds",
    pet: "none",
  });
  expect(
    ROOM_PRESETS.hospital({ blossom: false, hospitalIndex: 1 }).wallArt,
  ).toBe("chart");
});

// Both rotations are what rooms drew before the menu: the sill alternates
// from ordinary room to room, and hospital rooms alternate their picture.
test("the rotating defaults follow room order", () => {
  const rooms = [
    room("a"),
    room("b"),
    room("c", { skin: "hospital" }),
    room("d", { skin: "hospital" }),
  ];
  expect(rooms.map((r) => resolveRoomDecor(r, rooms).sill)).toEqual([
    "blossom",
    "trailing",
    "blossom",
    "trailing",
  ]);
  expect(presetDecor("hospital", "c", rooms).wallArt).toBe("landscape");
  expect(presetDecor("hospital", "d", rooms).wallArt).toBe("chart");
});

test("a room's choices replace its preset's, and unknown ones are ignored", () => {
  const rooms = [
    room("a", {
      skin: "hospital",
      decor: {
        pet: "shown",
        walls: "office",
        ward: "sofa" as never,
        lamp: "on",
      } as RoomWire["decor"],
    }),
  ];
  const drawn = resolveRoomDecor(rooms[0], rooms);
  expect(drawn.pet).toBe("shown");
  expect(drawn.walls).toBe("office");
  expect(drawn.ward).toBe("beds");
  expect(Object.keys(drawn).sort()).toEqual([...ROOM_DECOR_SLOTS].sort());
});

test("the clinic palette only overrides variables the themes define", () => {
  const known = new Set(THEMES.flatMap((theme) => Object.keys(theme.vars)));
  for (const mode of MODES) {
    for (const name of Object.keys(sceneVarsFor("clinic", mode))) {
      expect({ mode, name, known: known.has(name) }).toEqual({
        mode,
        name,
        known: true,
      });
    }
  }
});

// Day and night are two lightings of ONE room, not two rooms: a variable the
// day map repaints and the night map forgets would leave the theme's own colour
// showing through at night.
test("the clinic palette repaints the same variables in both modes", () => {
  expect(Object.keys(sceneVarsFor("clinic", "light")).sort()).toEqual(
    Object.keys(sceneVarsFor("clinic", "dark")).sort(),
  );
});

test("the clinic palette repaints the floor and both walls", () => {
  for (const mode of MODES) {
    const vars = sceneVarsFor("clinic", mode);
    for (const name of ["--floor-light", "--wall-left", "--wall-right"]) {
      expect(vars[name]).toBeTruthy();
    }
  }
});

test("parseRoomSkin accepts null, undefined and every id", () => {
  expect(parseRoomSkin(null)).toEqual({ ok: true, skin: null });
  expect(parseRoomSkin(undefined)).toEqual({ ok: true, skin: null });
  for (const id of ROOM_SKIN_IDS) {
    expect(parseRoomSkin(id)).toEqual({ ok: true, skin: id });
  }
});

test("parseRoomSkin rejects anything else", () => {
  for (const bad of ["clinic", "", "Hospital", 42, {}, [], true]) {
    expect(parseRoomSkin(bad).ok).toBe(false);
  }
});

// Nothing parses a skin when a room is loaded from disk, so a hand-edited
// agents.json - or a rollback past the version that added a skin - puts an
// unknown string straight into RoomWire. The drawing side is what has to
// survive that, the same way the pet's coat does.
test("an unknown or absent skin draws the office", () => {
  expect(effectiveRoomSkin(undefined)).toBe(DEFAULT_ROOM_SKIN);
  expect(effectiveRoomSkin({})).toBe(DEFAULT_ROOM_SKIN);
  expect(effectiveRoomSkin({ skin: null })).toBe(DEFAULT_ROOM_SKIN);
  expect(effectiveRoomSkin({ skin: "clinic" as RoomSkin })).toBe(
    DEFAULT_ROOM_SKIN,
  );
  expect(
    ROOM_PRESETS[effectiveRoomSkin({ skin: "clinic" as RoomSkin })],
  ).toBeDefined();
});
