// What the room customization section shows for stored state it did not
// write: a pet species or coat this build does not know, and a hospital
// preset picked in a room that comes after another hospital.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { renderToString } = await import("react-dom/server");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { RoomDecorPicker } = await import("./RoomDecorPicker.tsx");
const { initialRoomLook, pickPreset } = await import("../room-look.ts");
const { resolveRoomDecor } = await import("../office/skins/index.tsx");
type RoomWire = import("../../shared/types.ts").RoomWire;
type RoomPet = import("../../shared/pets.ts").RoomPet;
type RoomLook = import("../room-look.ts").RoomLook;

function room(id: string, extra: Partial<RoomWire> = {}): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: true, ...extra };
}

function render(
  r: RoomWire,
  rooms: RoomWire[] = [r],
  look: RoomLook = initialRoomLook(r),
) {
  const html = renderToString(
    onLanguage(
      null,
      createElement(RoomDecorPicker, { room: r, rooms, look, onChange() {} }),
      { rooms },
    ),
  );
  const host = document.createElement("div");
  host.innerHTML = html;
  return (row: string) =>
    host
      .querySelector(`[data-decor-row="${row}"] [aria-pressed="true"]`)
      ?.getAttribute("data-option");
}

// The scene draws an unknown species as the default animal and a coat past
// the end of its list as the first coat (coatFor). The section has to follow
// the same rules rather than throw, and mark the tiles the scene draws.
it("draws a stored pet this build does not know the way the scene does", () => {
  const unknown = render(
    room("a", { pet: { species: "duck", coat: 0 } as unknown as RoomPet }),
  );
  expect(unknown("pet")).toBe("cat");
  expect(unknown("coat")).toBe("0");
  const pastEnd = render(room("b", { pet: { species: "dog", coat: 42 } }));
  expect(pastEnd("pet")).toBe("dog");
  expect(pastEnd("coat")).toBe("0");
});

// The hospital picture alternates by the room's place among hospital rooms,
// and picking Hospital adds this room to them. What the section shows before
// Save has to be what the scene draws after it.
it("shows the hospital picture the room will draw once saved", () => {
  const ward = room("w", { skin: "hospital" });
  const plain = room("p");
  const staged = render(
    plain,
    [ward, plain],
    pickPreset(initialRoomLook(plain), "hospital"),
  );
  const saved = { ...plain, skin: "hospital" as const };
  const after = resolveRoomDecor(saved, [ward, saved]);
  expect(after.wallArt).toBe("chart");
  expect(staged("wallArt")).toBe(after.wallArt);
});

// The picker draws about 38 small rooms each time a room's settings open. The
// pieces every tile shares (the room, the plants, the pets, the gradients and
// blurs they paint with) are drawn once and each tile points at them, so the
// pane stays cheap on a phone and in the chat sidebar walk test.
const { pickPet } = await import("../room-look.ts");
const { WindowPlant } = await import("../office/Floor.tsx");
const { BlossomJar, CornerPlant } = await import("../office/plants.tsx");
const { HospitalProps } = await import("../office/skins/hospital/props.tsx");
const { PetCorner } = await import("../office/RoomProps.tsx");
const { PET_PALETTES, PET_SPECIES } = await import("../../shared/pets.ts");
type ReactElement = import("react").ReactElement;

/** The picker for an office room with a dog in coat 2 shown: every row,
 *  the coat row included, and a coat that is not the default. */
function picker(): Element {
  const r = room("o");
  const look = pickPet(initialRoomLook(r), { species: "dog", coat: 2 });
  const html = renderToString(
    onLanguage(
      null,
      createElement(RoomDecorPicker, {
        room: r,
        rooms: [r],
        look,
        onChange() {},
      }),
      { rooms: [r] },
    ),
  );
  const host = document.createElement("div");
  host.innerHTML = html;
  const root = host.querySelector("[data-room-decor]");
  if (!root) throw new Error("no picker root");
  return root;
}

const tilesOf = (root: Element) => [...root.querySelectorAll("button svg")];

const tileSvg = (root: Element, row: string, option: string) => {
  const svg = root.querySelector(
    `[data-decor-row="${row}"] [data-option="${option}"] svg`,
  );
  if (!svg) throw new Error(`no tile ${row}/${option}`);
  return svg;
};

/** The tile's drawing with every <use> replaced by what it points at, and
 *  every <defs> removed: what the browser paints, as markup. */
function expanded(root: Element, svg: Element): string {
  const copy = svg.cloneNode(true) as Element;
  for (let round = 0; round < 10; round++) {
    const uses = [...copy.querySelectorAll("use")];
    if (uses.length === 0) break;
    for (const use of uses) {
      const href = use.getAttribute("href") ?? "";
      const target = root.querySelector(`[id="${href.slice(1)}"]`);
      if (!target) throw new Error(`unresolved ${href}`);
      use.replaceWith(target.cloneNode(true));
    }
  }
  for (const d of [...copy.querySelectorAll("defs")]) d.remove();
  return copy.innerHTML;
}

/** A scene drawing on its own, serialized the same way, without <defs>. */
function drawn(el: ReactElement): string {
  const host = document.createElement("div");
  host.innerHTML = renderToString(
    onLanguage(null, createElement("svg", null, el)),
  );
  for (const d of [...host.querySelectorAll("defs")]) d.remove();
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("no svg");
  return svg.innerHTML;
}

it("draws each shared piece once and every tile from it", () => {
  const root = picker();
  const tiles = tilesOf(root);
  // The case covers every row: presets, the slots, the pets and the coats.
  expect(
    root.querySelectorAll('[data-decor-row="coat"] button svg').length,
  ).toBe(PET_PALETTES.dog.length);
  expect(tiles.length).toBeGreaterThan(30);

  // Cost: 2922 nodes here when each tile drew its own copy of everything,
  // 1420 with the shared pieces drawn once.
  expect(root.querySelectorAll("*").length).toBeLessThan(1520);

  // One copy of each gradient and blur, outside the tiles.
  for (const id of [
    "pot-body",
    "pot-lip",
    "plant-soft",
    "pet-volume",
    "pet-cushion",
    "pet-soft",
    "hospital-soft",
  ]) {
    expect(`${id}: ${root.querySelectorAll(`[id="${id}"]`).length}`).toBe(
      `${id}: 1`,
    );
  }
  expect(tiles.filter((svg) => svg.querySelector("defs")).length).toBe(0);

  // Every tile points at the shared drawings (at least the room), and each
  // pointer finds its drawing inside the picker, outside the tiles: the
  // pane must not lean on the office scene being mounted.
  for (const svg of tiles) {
    const uses = [...svg.querySelectorAll("use")];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const href = use.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      const target = root.querySelector(`[id="${href.slice(1)}"]`);
      expect(`${href}: ${target !== null}`).toBe(`${href}: true`);
      expect(target?.closest("button")).toBeNull();
    }
  }

  // The shared drawings must be painted from: Chrome and Firefox skip
  // gradients and filters that live in a display:none svg.
  const shared = root.querySelector('[id="pot-body"]')?.closest("svg");
  expect(shared?.closest("button")).toBeNull();
  expect(shared?.hasAttribute("hidden")).toBe(false);
  expect((shared as SVGElement | undefined)?.style.display).not.toBe("none");
});

it("shows in each tile the scene's own drawing of its option", () => {
  const root = picker();
  const window = drawn(createElement(WindowPlant));
  const blossom = drawn(createElement(BlossomJar));
  const floor = drawn(createElement(CornerPlant));
  const ward = drawn(createElement(HospitalProps));
  const pet = (species: (typeof PET_SPECIES)[number], coat: number) =>
    drawn(createElement(PetCorner, { pet: { species, coat } }));
  const shows = (row: string, option: string, drawing: string) =>
    expanded(root, tileSvg(root, row, option)).includes(drawing);

  expect(shows("sill", "trailing", window)).toBe(true);
  expect(shows("sill", "blossom", blossom)).toBe(true);
  expect(shows("sill", "blossom", window)).toBe(false);
  expect(shows("sill", "trailing", blossom)).toBe(false);
  expect(shows("sill", "none", window) || shows("sill", "none", blossom)).toBe(
    false,
  );
  expect(shows("floorPlant", "plant", floor)).toBe(true);
  expect(shows("floorPlant", "none", floor)).toBe(false);
  expect(shows("ward", "beds", ward)).toBe(true);
  expect(shows("ward", "none", ward)).toBe(false);

  for (const species of PET_SPECIES) {
    expect(`${species}: ${shows("pet", species, pet(species, 0))}`).toBe(
      `${species}: true`,
    );
  }
  expect(shows("pet", "none", pet("cat", 0))).toBe(false);
  // The coat row draws the staged species in each of its coats.
  const coats = PET_PALETTES.dog.length;
  expect(coats).toBeGreaterThan(2);
  for (let coat = 0; coat < coats; coat++) {
    const other = (coat + 1) % coats;
    expect(
      `coat ${coat}: ${shows("coat", String(coat), pet("dog", coat))} ${shows("coat", String(coat), pet("dog", other))}`,
    ).toBe(`coat ${coat}: true false`);
  }

  // The presets draw the room's own pieces the same way. The only room
  // gets the blossom jar; the office preset keeps the default pet, not the
  // staged dog.
  for (const skin of ["office", "hospital"]) {
    expect(shows("preset", skin, blossom)).toBe(true);
    expect(shows("preset", skin, floor)).toBe(true);
  }
  expect(shows("preset", "office", pet("cat", 0))).toBe(true);
  expect(shows("preset", "office", pet("dog", 2))).toBe(false);
  expect(shows("preset", "office", ward)).toBe(false);
  expect(shows("preset", "hospital", ward)).toBe(true);
});
