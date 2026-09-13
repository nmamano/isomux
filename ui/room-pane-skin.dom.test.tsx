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

// The name and the look are the room's two cosmetic fields and they ride one
// PATCH. A look changed on its own has to reach the server even though the name
// never moved - the pane used to send nothing at all unless the name changed.
it("saves a changed look on its own, and carries the name when both move", async () => {
  calls.length = 0;
  // The room starts on a skin the pickers no longer offer, which is the only
  // way a look can still CHANGE while one id is selectable: its own skin stays
  // in its list, so hospital -> office is a real edit through the real control.
  const view = mount({
    id: "ward",
    name: "Ward",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
    skin: "hospital",
  });
  await act(async () => {});
  const select = view.getByLabelText("Room look") as HTMLSelectElement;
  expect(select.value).toBe("hospital");
  expect(
    (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  await act(async () =>
    fireEvent.change(select, { target: { value: "office" } }),
  );
  // A look the reader has not saved yet is an unsaved change, so Cancel wakes
  // up and the discard guard has something to guard.
  expect(
    (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);

  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(patches()).toHaveLength(1);
  expect(patches()[0].body).toEqual({ skin: "office" });

  view.unmount();

  // Both moving at once is its own mount: this room has one change available
  // to it (its held-back skin -> the offered one), so the two cases cannot
  // share a pane.
  calls.length = 0;
  const both = mount({
    id: "ward",
    name: "Ward",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
    skin: "hospital",
  });
  await act(async () => {});
  await act(async () =>
    // The name input has no label association of its own (it predates this
    // pane's labelled controls), so it is queried as the pane's one text input.
    fireEvent.change(both.container.querySelector("input")!, {
      target: { value: "Ward B" },
    }),
  );
  await act(async () =>
    fireEvent.change(both.getByLabelText("Room look"), {
      target: { value: "office" },
    }),
  );
  await act(async () =>
    fireEvent.click(both.getByRole("button", { name: "Save" })),
  );
  expect(patches()).toHaveLength(1);
  expect(patches()[0].body).toEqual({ name: "Ward B", skin: "office" });
  both.unmount();
});

it("shows the room's stored look, and sends no PATCH when it is untouched", async () => {
  calls.length = 0;
  const view = mount({
    id: "ward",
    name: "Ward",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
    skin: "hospital",
  });
  await act(async () => {});
  expect((view.getByLabelText("Room look") as HTMLSelectElement).value).toBe(
    "hospital",
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(patches()).toHaveLength(0);
  view.unmount();
});

// The PATCH is part of the save, not a side effect of it. When it fails the
// reader has to be able to tell: the pane must not settle to "Saved" over a
// look the server never took, and the change must still be theirs to retry.
it("keeps a rejected look dirty, says so, and retries the same body", async () => {
  calls.length = 0;
  patchFails = true;
  // Same reason as the first case: the room's own held-back skin is what makes
  // a change reachable while one id is offered.
  const view = mount({
    id: "ward",
    name: "Ward",
    type: "office",
    prompt: null,
    canCloseWhenEmpty: true,
    skin: "hospital",
  });
  await act(async () => {});
  const select = view.getByLabelText("Room look") as HTMLSelectElement;
  await act(async () =>
    fireEvent.change(select, { target: { value: "office" } }),
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(patches()).toHaveLength(1);
  expect(view.queryByRole("button", { name: "Saved" })).toBeNull();
  expect(view.getByRole("button", { name: "Save" })).toBeTruthy();
  // The reader's change is still theirs: the field holds it, and Cancel is
  // live because the pane is still dirty.
  expect(select.value).toBe("office");
  expect(
    (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  // A failed cosmetic PATCH must not have spent the settings version, or the
  // retry would come back as a conflict instead of saving.
  expect(
    calls.some((c) => c.method === "PUT" && c.path.endsWith("/settings")),
  ).toBe(false);

  patchFails = false;
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Save" })),
  );
  expect(patches()).toHaveLength(2);
  expect(patches()[1].body).toEqual({ skin: "office" });
  expect(view.getByRole("button", { name: "Saved" })).toBeTruthy();
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
  expect(view.queryByLabelText("Room look")).toBeNull();
  view.unmount();
});
