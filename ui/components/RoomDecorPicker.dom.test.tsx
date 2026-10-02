// What the room customization section shows for stored state it did not
// write: a pet species or coat this build does not know, and a hospital
// preset picked in a room that comes after another hospital.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { renderToString } = await import("react-dom/server");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { RoomDecorPicker, stagedRoomDecor } =
  await import("./RoomDecorPicker.tsx");
const { initialRoomLook, pickPreset } = await import("../room-look.ts");
const { resolveRoomDecor } = await import("../office/skins/index.tsx");
type RoomWire = import("../../shared/types.ts").RoomWire;
type RoomPet = import("../../shared/pets.ts").RoomPet;

function room(id: string, extra: Partial<RoomWire> = {}): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: true, ...extra };
}

function render(r: RoomWire) {
  const html = renderToString(
    onLanguage(
      null,
      createElement(RoomDecorPicker, {
        room: r,
        rooms: [r],
        look: initialRoomLook(r),
        onChange() {},
      }),
      { rooms: [r] },
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
  const rooms = [ward, plain];
  const staged = stagedRoomDecor(
    plain,
    rooms,
    pickPreset(initialRoomLook(plain), "hospital"),
  );
  const saved = { ...plain, skin: "hospital" as const };
  const after = resolveRoomDecor(saved, [ward, saved]);
  expect(after.wallArt).toBe("chart");
  expect(staged.wallArt).toBe(after.wallArt);
});
