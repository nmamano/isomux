// The room settings pane's "Your view" block: a hide (task 83d34b44). Hiding
// takes the room out of the viewer's rooms, and the pane with it, so it must be
// the last write of a save.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim, ApiError } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { box, click, save, mount, viewWrites, bodyOf, setRecord, setOnCall } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("a hide writes tucked first and shown last, keeps other rooms' entries, and moves the selection once the room is gone", async () => {
  const { view, deletedCount } = await mount({
    tucked: ["other"],
    hidden: ["granted"],
    notifRooms: ["ward", "other"],
  });
  // The server's answer to the shown write: the self record, then the
  // projected full_state without the room.
  setOnCall((c) => {
    if (c.method === "PUT" && c.path === "/api/me/view/shown") {
      setRecord({ hidden: ["granted", "ward"], notifRooms: ["other"] });
      h.dispatchToStore({
        type: "full_state",
        agents: [],
        recentCwds: [],
        office: { prompt: null, name: "Office" },
        rooms: [h.OTHER],
        killedAgents: [],
      });
    }
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
  expect(bodyOf("/api/me/view/tucked")).toEqual({ tucked: ["other", "ward"] });
  // Complement over the fresh accessible list: still-hidden "granted" stays
  // out, "other" stays in.
  expect(bodyOf("/api/me/view/shown")).toEqual({ shown: ["other"] });
  expect(deletedCount()).toBe(1);
  expect(box(view, "shown")).toBeNull();
  view.unmount();
});

it("a failed write during a hide keeps the room, shows the error, and sends no shown write", async () => {
  const { view, deletedCount } = await mount({});
  setOnCall((c) => {
    if (c.path === "/api/me/view/tucked")
      throw new ApiError(500, "boom", "tucked write failed");
    return undefined;
  });
  await click(view, "tucked");
  await click(view, "shown");
  await save(view);

  expect(viewWrites()).toEqual(["PUT /api/me/view/tucked"]);
  expect(deletedCount()).toBe(0);
  expect(view.container.textContent).toContain("tucked write failed");
  // The form keeps the member's choices for a retry.
  expect(box(view, "shown")!.checked).toBe(false);

  // Retry: the same writes go out, and only now does the room go.
  h.resetCalls();
  await save(view);
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "GET /api/me/rooms",
    "PUT /api/me/view/shown",
  ]);
  expect(deletedCount()).toBe(1);
  view.unmount();
});
