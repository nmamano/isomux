// The room settings pane's "Your view" block: each level change writes only
// the lists it changes, in the order shown, tucked, notifications, push (task
// 611c968e). The server drops a tucked room's notifications, so the tucked
// write goes before the notifications write. Every write keeps the other
// rooms' entries. The fake server applies each write to the record.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { Call } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { level, pick, save, mount, viewWrites, setRecord, setOnCall } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

const FIELD: Record<string, "tucked" | "notifRooms" | "pushRooms"> = {
  "/api/me/view/tucked": "tucked",
  "/api/me/view/notif-rooms": "notifRooms",
  "/api/me/view/push-rooms": "pushRooms",
};
function applyWrites(c: Call) {
  const field = FIELD[c.path];
  if (c.method === "PUT" && field)
    setRecord({ [field]: (c.body as Record<string, string[]>)[field] });
  return undefined;
}
// The written lists, sorted: where the room lands in a list is free.
const sentLists = () =>
  h.calls
    .filter((c) => c.method === "PUT" && FIELD[c.path])
    .map((c) => {
      const field = FIELD[c.path];
      return {
        [field]: [...(c.body as Record<string, string[]>)[field]].sort(),
      };
    });

it("every step up and down writes only the lists it changes, tucked before notifications before push", async () => {
  const { view } = await mount({
    tucked: ["t"],
    notifRooms: ["other"],
    pushRooms: ["other"],
  });
  const step = async (to: string) => {
    h.resetCalls();
    setOnCall(applyWrites);
    await pick(view, to);
    await save(view);
    expect(level(view)).toBe(to);
  };

  await step("push");
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/notif-rooms",
    "PUT /api/me/view/push-rooms",
  ]);
  expect(sentLists()).toEqual([
    { notifRooms: ["other", "ward"] },
    { pushRooms: ["other", "ward"] },
  ]);

  // Push off keeps the notifications: one write.
  await step("notify");
  expect(viewWrites()).toEqual(["PUT /api/me/view/push-rooms"]);
  expect(sentLists()).toEqual([{ pushRooms: ["other"] }]);

  await step("tucked");
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "PUT /api/me/view/notif-rooms",
  ]);
  expect(sentLists()).toEqual([
    { tucked: ["t", "ward"] },
    { notifRooms: ["other"] },
  ]);

  // Untuck before the notifications write, or the server would drop it.
  await step("push");
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "PUT /api/me/view/notif-rooms",
    "PUT /api/me/view/push-rooms",
  ]);
  expect(sentLists()).toEqual([
    { tucked: ["t"] },
    { notifRooms: ["other", "ward"] },
    { pushRooms: ["other", "ward"] },
  ]);

  await step("shown");
  expect(viewWrites()).toEqual([
    "PUT /api/me/view/notif-rooms",
    "PUT /api/me/view/push-rooms",
  ]);
  expect(sentLists()).toEqual([
    { notifRooms: ["other"] },
    { pushRooms: ["other"] },
  ]);
  view.unmount();
});
