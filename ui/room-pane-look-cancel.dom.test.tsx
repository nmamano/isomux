// The room settings pane's look section: Cancel, and the pet tiles. Split from
// room-pane-look.dom.test.tsx because the DOM harness budgets wall clock per
// file and each mount of the tile section costs about two seconds.

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
setApiShim(async (method, path, body) => {
  calls.push({ method, path, body });
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
