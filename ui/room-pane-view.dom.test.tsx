// The room settings pane's "Your view" block (task 83d34b44): the viewer's own
// shown / tucked / notifications choices for this room, saved through the same
// /api/me/view routes Settings > Rooms uses. The hide path is in
// room-pane-view-hide.dom.test.tsx and the live-record saves in
// room-pane-view-live.dom.test.tsx (the DOM harness budgets wall clock per
// file).

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { box, click, save, mount, viewWrites } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("shows no view block for the lobby", async () => {
  const { view } = await mount({}, { rooms: [h.LOBBY, h.WARD], roomId: "lobby" });
  expect(box(view, "shown")).toBeNull();
  view.unmount();
});

it("reads the choices from the viewer's record, writes nothing while untouched, and gates tucked and notifications on shown", async () => {
  const { view } = await mount({ tucked: ["ward"], notifRooms: ["ward"] });
  expect(box(view, "shown")!.checked).toBe(true);
  expect(box(view, "tucked")!.checked).toBe(true);
  expect(box(view, "notif")!.checked).toBe(true);
  await save(view);
  expect(viewWrites()).toEqual([]);

  await click(view, "shown");
  // Hiding clears notifications and locks both; tucked keeps its flag.
  expect(box(view, "notif")!.checked).toBe(false);
  expect(box(view, "notif")!.disabled).toBe(true);
  expect(box(view, "tucked")!.disabled).toBe(true);
  expect(box(view, "tucked")!.checked).toBe(true);
  view.unmount();
});
