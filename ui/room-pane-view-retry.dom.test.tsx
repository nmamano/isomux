// The room settings pane's "Your view" block: a save whose notifications
// write fails after the tucked write landed (tasks 83d34b44, 611c968e). The
// retry resends only what still differs.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim, ApiError } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { level, pick, save, mount, viewWrites, setRecord, setOnCall } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("a notifications write that fails after the tucked write landed: the retry sends only notifications and push", async () => {
  const { view, deletedCount } = await mount({
    tucked: ["ward"],
    notifRooms: [],
    pushRooms: [],
  });
  setOnCall((c) => {
    // The server's record frame for the tucked write that succeeds.
    if (c.path === "/api/me/view/tucked") setRecord({ tucked: [] });
    if (c.method === "PUT" && c.path === "/api/me/view/notif-rooms")
      throw new ApiError(500, "boom", "notifications write failed");
    return undefined;
  });
  await pick(view, "push");
  await save(view);

  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "PUT /api/me/view/notif-rooms",
  ]);
  expect(view.container.textContent).toContain("notifications write failed");
  expect(level(view)).toBe("push");

  h.resetCalls();
  await save(view);
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/notif-rooms",
    "PUT /api/me/view/push-rooms",
  ]);
  expect(deletedCount()).toBe(0);
  view.unmount();
});
