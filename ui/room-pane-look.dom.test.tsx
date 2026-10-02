// The room settings pane's save path for the look: a rejected PATCH, Cancel,
// and the pet tiles. Split from room-pane-skin.dom.test.tsx because the DOM
// harness budgets wall clock per file and the tiles are what a mount costs.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
type RoomWire = import("../shared/types.ts").RoomWire;

const calls: Array<{ method: string; path: string; body: unknown }> = [];
let patchFails = false;
setApiShim(async (method, path, body) => {
  calls.push({ method, path, body });
  if (method === "PATCH" && patchFails) throw new Error("offline");
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  return {};
});
afterAll(() => setApiShim(null));

function mount(room: RoomWire) {
  return render(
    onLanguage(
      null,
      createElement(RoomPane, { roomId: room.id, onDeleted() {} }),
      { rooms: [room] },
    ),
  );
}

const patches = () =>
  calls.filter((c) => c.method === "PATCH" && c.path === "/api/rooms/ward");

const ward = (extra: Partial<RoomWire> = {}): RoomWire => ({
  id: "ward",
  name: "Ward",
  type: "office",
  prompt: null,
  canCloseWhenEmpty: true,
  skin: "hospital",
  ...extra,
});

// The section's tiles, by row and option id: the words on them are copy.
function tile(view: ReturnType<typeof mount>, row: string, option: string) {
  const el = view.container.querySelector(
    `[data-decor-row="${row}"] [data-option="${option}"]`,
  );
  if (!el) throw new Error(`no tile ${row}/${option}`);
  return el as HTMLButtonElement;
}

async function pick(
  view: ReturnType<typeof mount>,
  row: string,
  option: string,
) {
  await act(async () => fireEvent.click(tile(view, row, option)));
}

async function save(view: ReturnType<typeof mount>) {
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
}

const cancelDisabled = (view: ReturnType<typeof mount>) =>
  (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled;

// The PATCH is part of the save, not a side effect of it. When it fails the
// reader has to be able to tell: the pane must not settle to "Saved" over a
// look the server never took, and the change must still be theirs to retry.
it("keeps a rejected look dirty, says so, and retries the same body", async () => {
  calls.length = 0;
  patchFails = true;
  const view = mount(ward());
  await act(async () => {});
  await pick(view, "preset", "office");
  await save(view);
  expect(patches()).toHaveLength(1);
  expect(view.queryByRole("button", { name: "Saved" })).toBeNull();
  expect(view.getByRole("button", { name: "Save" })).toBeTruthy();
  // The reader's change is still theirs: the tile holds it, and Cancel is
  // live because the pane is still dirty.
  expect(tile(view, "preset", "office").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(cancelDisabled(view)).toBe(false);
  // A failed cosmetic PATCH must not have spent the settings version, or the
  // retry would come back as a conflict instead of saving.
  expect(
    calls.some((c) => c.method === "PUT" && c.path.endsWith("/settings")),
  ).toBe(false);

  patchFails = false;
  await save(view);
  expect(patches()).toHaveLength(2);
  expect(patches()[1].body).toEqual({ skin: "office", decor: null });
  expect(view.getByRole("button", { name: "Saved" })).toBeTruthy();
  view.unmount();
});

// Cancel puts every staged choice back. A species tile shows the pet and
// opens its coat row, and the coat tiles set the coat.
it("puts staged choices back on Cancel, and saves a pet with its coat", async () => {
  calls.length = 0;
  const view = mount(ward());
  await act(async () => {});
  await pick(view, "preset", "office");
  await pick(view, "ward", "beds");
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Cancel" })),
  );
  expect(tile(view, "preset", "hospital").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(cancelDisabled(view)).toBe(true);

  await pick(view, "pet", "dog");
  await pick(view, "coat", "2");
  expect(tile(view, "pet", "dog").getAttribute("aria-pressed")).toBe("true");
  await save(view);
  expect(patches()[0].body).toEqual({
    pet: { species: "dog", coat: 2 },
    decor: { pet: "shown" },
  });
  view.unmount();
});
