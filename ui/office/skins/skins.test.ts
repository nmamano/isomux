// What the skin registry owes, independent of any scene: an entry for every id
// the server can store, an identity entry for the office, and - for a skin that
// repaints the room - only variables the themes actually define. A typo'd
// variable name is invisible at runtime (the scene keeps the theme's value and
// the room simply does not change), so the name check is the test that earns
// its place here.

import { expect, test } from "bun:test";
import { ROOM_SKIN_MODULES } from "./index.tsx";
import {
  DEFAULT_ROOM_SKIN,
  ROOM_SKIN_IDS,
  effectiveRoomSkin,
  parseRoomSkin,
  type RoomSkin,
} from "../../../shared/room-skins.ts";
import { THEMES } from "../../themes.ts";

const MODES = ["light", "dark"] as const;

test("every skin id has a module", () => {
  for (const id of ROOM_SKIN_IDS) {
    expect(ROOM_SKIN_MODULES[id]).toBeDefined();
  }
  expect(Object.keys(ROOM_SKIN_MODULES).sort()).toEqual(
    [...ROOM_SKIN_IDS].sort(),
  );
});

// The office is the drawing every room has had since before skins existed, so
// its entry has to be the identity: no variables, no layers. That is what lets
// an absent field on an old record cost nothing.
test("the office skin overrides nothing and adds nothing", () => {
  const office = ROOM_SKIN_MODULES[DEFAULT_ROOM_SKIN];
  for (const mode of MODES) expect(office.vars(mode)).toEqual({});
  expect(office.Walls).toBeUndefined();
  expect(office.Props).toBeUndefined();
});

test("a skin only overrides variables the themes define", () => {
  const known = new Set(THEMES.flatMap((theme) => Object.keys(theme.vars)));
  for (const id of ROOM_SKIN_IDS) {
    for (const mode of MODES) {
      for (const name of Object.keys(ROOM_SKIN_MODULES[id].vars(mode))) {
        expect({ id, mode, name, known: known.has(name) }).toEqual({
          id,
          mode,
          name,
          known: true,
        });
      }
    }
  }
});

// Day and night are two lightings of ONE room, not two rooms: a variable the
// day map repaints and the night map forgets would leave the theme's own colour
// showing through at night.
test("a skin repaints the same variables in both modes", () => {
  for (const id of ROOM_SKIN_IDS) {
    expect(Object.keys(ROOM_SKIN_MODULES[id].vars("light")).sort()).toEqual(
      Object.keys(ROOM_SKIN_MODULES[id].vars("dark")).sort(),
    );
  }
});

test("the hospital repaints the floor and both walls", () => {
  for (const mode of MODES) {
    const vars = ROOM_SKIN_MODULES.hospital.vars(mode);
    for (const name of ["--floor-light", "--wall-left", "--wall-right"]) {
      expect(vars[name]).toBeTruthy();
    }
  }
  expect(ROOM_SKIN_MODULES.hospital.Walls).toBeDefined();
  expect(ROOM_SKIN_MODULES.hospital.Props).toBeDefined();
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
    ROOM_SKIN_MODULES[effectiveRoomSkin({ skin: "clinic" as RoomSkin })],
  ).toBeDefined();
});
