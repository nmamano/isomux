// The room settings pane's "Your view" block: a hide (tasks 83d34b44,
// 611c968e). Hiding takes the room out of the viewer's rooms, and the pane
// with it, so it is the last write of a save; it writes only the shown list,
// because the server drops a hidden room's notifications and push.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { setApiShim, ApiError } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { level, pick, save, mount, viewWrites, bodyOf, setRecord, setOnCall } =
  h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

// One mount for the whole story: the pane's render is most of this file's
// cost (task 79d6d664), so the failed hide and its retry share it.
it("a failed hide keeps the room; the retry writes only the shown list, keeps other rooms' entries, and moves the selection once the room is gone", async () => {
  const { view, deletedCount } = await mount({
    tucked: ["other"],
    hidden: ["granted"],
    notifRooms: ["ward", "other"],
    pushRooms: ["ward"],
  });
  expect(level(view)).toBe("push");
  setOnCall((c) => {
    if (c.method === "PUT" && c.path === "/api/me/view/shown")
      throw new ApiError(500, "boom", "shown write failed");
    return undefined;
  });
  await pick(view, "hidden");
  await save(view);

  expect(viewWrites()).toEqual(["GET /api/me/rooms", "PUT /api/me/view/shown"]);
  expect(deletedCount()).toBe(0);
  expect(view.container.textContent).toContain("shown write failed");
  // The form keeps the member's choice for a retry.
  expect(level(view)).toBe("hidden");

  // Retry. The server's answer to the shown write: the self record, then the
  // projected full_state without the room.
  h.resetCalls();
  setOnCall((c) => {
    if (c.method === "PUT" && c.path === "/api/me/view/shown") {
      setRecord({
        hidden: ["granted", "ward"],
        notifRooms: ["other"],
        pushRooms: [],
      });
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
  await save(view);

  expect(viewWrites()).toEqual(["GET /api/me/rooms", "PUT /api/me/view/shown"]);
  // Complement over the fresh accessible list: still-hidden "granted" stays
  // out, "other" stays in.
  expect(bodyOf("/api/me/view/shown")).toEqual({ shown: ["other"] });
  expect(deletedCount()).toBe(1);
  expect(level(view)).toBeNull();
  view.unmount();
});
