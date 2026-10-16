// The room settings pane's "Your view" block: the Devices box (task
// 0c3fa26f), the room's entry in the member's pushRooms. Gated by Displayed
// like the Notifications box, and saved with the full-list route.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { box, click, save, mount, viewWrites, bodyOf } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("a hide clears and locks the box; a tick saves the room into pushRooms, other rooms kept", async () => {
  const { view } = await mount({ pushRooms: ["other"], notifRooms: [] });
  expect(box(view, "push")!.checked).toBe(false);
  expect(box(view, "push")!.disabled).toBe(false);

  await click(view, "push");
  expect(box(view, "push")!.checked).toBe(true);
  await click(view, "shown");
  expect(box(view, "push")!.checked).toBe(false);
  expect(box(view, "push")!.disabled).toBe(true);
  await click(view, "shown");
  expect(box(view, "push")!.disabled).toBe(false);

  await click(view, "push");
  await save(view);
  // Only the touched box writes: Notifications stays off.
  expect(viewWrites()).toEqual(["PUT /api/me/view/push-rooms"]);
  expect(bodyOf("/api/me/view/push-rooms")).toEqual({
    pushRooms: ["other", "ward"],
  });
  view.unmount();
});
