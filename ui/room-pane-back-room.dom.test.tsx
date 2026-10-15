import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { createElement } = await import("react");
type RoomWire = import("../shared/types.ts").RoomWire;

const calls: Array<{ method: string; path: string; body: unknown }> = [];
// The next PATCH fails with this error, once.
let failNextPatch: Error | null = null;
setApiShim(async (method, path, body) => {
  calls.push({ method, path, body });
  if (method === "PATCH" && failNextPatch) {
    const e = failNextPatch;
    failNextPatch = null;
    throw e;
  }
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  return {};
});
afterAll(() => setApiShim(null));

function mount(room: RoomWire, agents: unknown[] = []) {
  return render(
    onLanguage(
      null,
      createElement(RoomPane, { roomId: room.id, onDeleted() {} }),
      { rooms: [room], agents: agents as never },
    ),
  );
}

const patches = () =>
  calls.filter((c) => c.method === "PATCH" && c.path === "/api/rooms/r1");

const room = (extra: Partial<RoomWire> = {}): RoomWire => ({
  id: "r1",
  name: "One",
  type: "office",
  prompt: null,
  canCloseWhenEmpty: true,
  ...extra,
});

const toggle = (view: ReturnType<typeof mount>) =>
  view.container.querySelector<HTMLInputElement>(
    '[data-room-setting="backRoom"]',
  );

async function save(view: ReturnType<typeof mount>) {
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: /^Save/ })),
  );
}

// A room with no field draws the switch off; checking it sends backRoom:true
// alone in the PATCH, and an untouched pane sends nothing.
it("turns the back room on through the room PATCH", async () => {
  calls.length = 0;
  const view = mount(room());
  await act(async () => {});
  expect(toggle(view)?.checked).toBe(false);
  await save(view);
  expect(patches()).toHaveLength(0);
  await act(async () => fireEvent.click(toggle(view)!));
  expect(toggle(view)?.checked).toBe(true);
  await save(view);
  expect(patches()).toHaveLength(1);
  expect(patches()[0].body).toEqual({ backRoom: true });
  view.unmount();
});

// Turning it off while agents sit in the back is refused by the server: the
// pane shows the server's message and stays dirty, so Save sends it again.
it("shows a refused turn-off and keeps it to save again", async () => {
  calls.length = 0;
  const view = mount(room({ backRoom: true }));
  await act(async () => {});
  expect(toggle(view)?.checked).toBe(true);
  await act(async () => fireEvent.click(toggle(view)!));
  failNextPatch = new ApiError(409, "back_room_in_use", "server says no");
  await save(view);
  expect(patches()).toHaveLength(1);
  expect(patches()[0].body).toEqual({ backRoom: false });
  expect(view.container.textContent).toContain("server says no");
  expect(toggle(view)?.checked).toBe(false);
  await save(view);
  expect(patches()).toHaveLength(2);
  expect(patches()[1].body).toEqual({ backRoom: false });
  view.unmount();
});

it("keeps the switch on and locked while agents sit in the back room", async () => {
  calls.length = 0;
  const { deskOfBackSeat } = await import("../shared/desks.ts");
  const { translatorFor } = await import("../shared/i18n/translate.ts");
  const back = {
    id: "b1",
    name: "b1",
    roomId: "r1",
    desk: deskOfBackSeat({ table: 0, stool: 0 }),
  };
  const view = mount(room({ backRoom: true }), [back]);
  await act(async () => {});
  expect(toggle(view)?.checked).toBe(true);
  expect(toggle(view)?.disabled).toBe(true);
  expect(view.container.textContent).toContain(
    translatorFor("en").tn("settings.room.backRoomInUse", 1),
  );
  view.unmount();
  // A front agent does not lock it.
  const front = mount(room({ backRoom: true }), [{ ...back, desk: 0 }]);
  await act(async () => {});
  expect(toggle(front)?.disabled).toBe(false);
  front.unmount();
});

it("offers no back room switch for the lobby", async () => {
  const view = mount({
    id: "lobby",
    name: "Lobby",
    type: "lobby",
    prompt: null,
    canCloseWhenEmpty: false,
  });
  await act(async () => {});
  expect(toggle(view)).toBeNull();
  view.unmount();
});
