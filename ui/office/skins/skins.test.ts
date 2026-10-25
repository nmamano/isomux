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
  for (const theme of THEMES)
    expect(sceneVarsFor("office", theme.id)).toEqual({});
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

// Every walls value but "office" is a tint, and "clinic" - the hospital's
// green - is one of them, so there is one path for room colour (Nil,
// 2026-10-25). A tint keeps the theme: each base it repaints keeps the theme's
// OKLab lightness, so dark walls stay dark under a dark theme and light ones
// light, and only the hue moves. The tint itself does not move with the theme.

const TINTS = ROOM_DECOR_OPTIONS.walls.filter((walls) => walls !== "office");

/** What a tint repaints: the two walls, the two floor tones and the plates
 *  hung on the walls (the name plate among them), so the whole room takes the
 *  colour. */
const TINTED = [
  "--wall-left",
  "--wall-right",
  "--floor-light",
  "--floor-dark",
  "--wall-decor",
  "--wall-decor-inner",
];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** OKLab lightness, and the hue in degrees, of a #rrggbb colour. */
function oklab(hex: string): { L: number; hue: number } {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    hue: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
  };
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// A var() inside a custom property resolves where it is declared, so a theme
// variable built from a repainted base (a wall's cut face, a slab side) has to
// be declared again next to it, with the theme's own expression - or it keeps
// mixing against the theme's colour and the room's edges stay untinted.
test("a tint repaints the walls, the floor and the wall plates, and re-declares what the theme builds from them", () => {
  for (const theme of THEMES) {
    const derived = Object.entries(theme.vars)
      .filter(([, value]) =>
        TINTED.some((base) => String(value).includes(`var(${base})`)),
      )
      .map(([name]) => name);
    for (const walls of TINTS) {
      const vars = sceneVarsFor(walls, theme.id);
      expect({
        theme: theme.id,
        walls,
        names: Object.keys(vars).sort(),
      }).toEqual({
        theme: theme.id,
        walls,
        names: [...TINTED, ...derived].sort(),
      });
      for (const name of derived) {
        expect({ theme: theme.id, walls, name, value: vars[name] }).toEqual({
          theme: theme.id,
          walls,
          name,
          value: theme.vars[name as keyof typeof theme.vars],
        });
      }
    }
  }
});

test("a tint keeps the theme's lightness and gives each room colour its own hue under every theme", () => {
  const hueIn = new Map<string, number>();
  for (const theme of THEMES) {
    const wallHues: number[] = [];
    for (const walls of TINTS) {
      const vars = sceneVarsFor(walls, theme.id);
      for (const name of TINTED) {
        const drawn = oklab(vars[name]);
        const own = oklab(theme.vars[name as keyof typeof theme.vars]);
        expect({
          theme: theme.id,
          walls,
          name,
          dL: Math.abs(drawn.L - own.L) < 0.01,
        }).toEqual({
          theme: theme.id,
          walls,
          name,
          dL: true,
        });
        // The floor and the plates follow the walls' colour.
        const wallHue = oklab(vars["--wall-left"]).hue;
        expect({
          theme: theme.id,
          walls,
          name,
          sameHue: hueGap(drawn.hue, wallHue) < 15,
        }).toEqual({
          theme: theme.id,
          walls,
          name,
          sameHue: true,
        });
      }
      const hue = oklab(vars["--wall-left"]).hue;
      wallHues.push(hue);
      // A tint is one colour whatever the theme.
      const first = hueIn.get(walls) ?? hue;
      hueIn.set(walls, first);
      expect({
        theme: theme.id,
        walls,
        steady: hueGap(hue, first) < 10,
      }).toEqual({
        theme: theme.id,
        walls,
        steady: true,
      });
    }
    // Two room colours that share a hue cannot tell two rooms apart.
    for (let i = 0; i < wallHues.length; i++) {
      for (let j = i + 1; j < wallHues.length; j++) {
        expect({
          theme: theme.id,
          pair: [TINTS[i], TINTS[j]],
          apart: hueGap(wallHues[i], wallHues[j]) >= 25,
        }).toEqual({
          theme: theme.id,
          pair: [TINTS[i], TINTS[j]],
          apart: true,
        });
      }
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
