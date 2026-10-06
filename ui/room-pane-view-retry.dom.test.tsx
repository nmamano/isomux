// The room settings pane's "Your view" block: a hide whose shown write fails
// after the tucked write landed (task 83d34b44). Each successful write moves
// its own baseline, so the retry resends only what still differs.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim, ApiError } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { click, save, mount, viewWrites, setRecord, setOnCall } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("a shown write that fails after a tucked write landed: the retry sends only the shown write", async () => {
  const { view, deletedCount } = await mount({});
  setOnCall((c) => {
    // The server's record frame for the tucked write that succeeds.
    if (c.path === "/api/me/view/tucked") setRecord({ tucked: ["ward"] });
    if (c.method === "PUT" && c.path === "/api/me/view/shown")
      throw new ApiError(500, "boom", "shown write failed");
    return undefined;
  });
  await click(view, "tucked");
  await click(view, "shown");
  await save(view);

  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "GET /api/me/rooms",
    "PUT /api/me/view/shown",
  ]);
  expect(deletedCount()).toBe(0);
  expect(view.container.textContent).toContain("shown write failed");

  h.resetCalls();
  await save(view);
  expect(viewWrites()).toEqual(["GET /api/me/rooms", "PUT /api/me/view/shown"]);
  expect(deletedCount()).toBe(1);
});
