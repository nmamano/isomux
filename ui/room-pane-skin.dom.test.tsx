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

// Every option draws itself: a tile with no picture would be a text tile. The
// stored look shows, an untouched pane sends nothing, and a picked preset is a
// reset that rides the name's PATCH. One mount: the tiles are what a mount
// costs here, and the DOM harness budgets each file.
it("draws every tile, sends nothing untouched, and saves a preset with the name", async () => {
  calls.length = 0;
  const view = mount(ward({ decor: { curtains: "none" } }));
  await act(async () => {});
  const tiles = view.container.querySelectorAll("[data-room-decor] button");
  expect(tiles.length).toBeGreaterThan(20);
  for (const t of tiles) {
    expect(t.querySelector("svg")).not.toBeNull();
    expect(t.getAttribute("aria-label")).toBeTruthy();
  }
  expect(tile(view, "preset", "hospital").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(tile(view, "ward", "beds").getAttribute("aria-pressed")).toBe("true");
  expect(tile(view, "curtains", "none").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(tile(view, "pet", "none").getAttribute("aria-pressed")).toBe("true");
  // No coat row while the pet is not drawn.
  expect(view.container.querySelector('[data-decor-row="coat"]')).toBeNull();
  expect(cancelDisabled(view)).toBe(true);
  await save(view);
  expect(patches()).toHaveLength(0);

  await act(async () =>
    // The name input has no label association of its own (it predates this
    // pane's labelled controls), so it is queried as the pane's one text input.
    fireEvent.change(view.container.querySelector("input")!, {
      target: { value: "Ward B" },
    }),
  );
  await pick(view, "preset", "office");
  expect(cancelDisabled(view)).toBe(false);
  // The staged preset draws its own values at once.
  expect(tile(view, "wallArt", "neon").getAttribute("aria-pressed")).toBe(
    "true",
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: /^Save/ })),
  );
  expect(patches()).toHaveLength(1);
  expect(patches()[0].body).toEqual({
    name: "Ward B",
    skin: "office",
    decor: null,
  });
  view.unmount();
});

// The lobby draws its own scene and takes no skin, so it has no control at all.
it("offers no look for the lobby", async () => {
  calls.length = 0;
  const view = mount({
    id: "lobby",
    name: "Lobby",
    type: "lobby",
    prompt: null,
    canCloseWhenEmpty: false,
  });
  await act(async () => {});
  expect(view.container.querySelector("[data-room-decor]")).toBeNull();
  view.unmount();
});
