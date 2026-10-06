// The room settings pane's "Your view" block: a record change that lands
// between two of the save's view writes reaches the later write (task
// 83d34b44). The first write's response is held by hand, so the change
// commits before the second write is built.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { Call } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { click, mount, viewWrites, bodyOf, setRecord, setOnCall } = h;
const { settleUntil, committedSelf } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("writes only the touched controls, each list read from the record as it is at that write", async () => {
  const { view } = await mount({ tucked: ["ward"], notifRooms: [] });
  await click(view, "notif");
  await click(view, "tucked");

  const gate = h.hold();
  const isNotifPut = (c: Call) => c.path === "/api/me/view/notif-rooms";
  setOnCall((c) => (isNotifPut(c) ? gate.response : undefined));
  try {
    await h.startSave(view);
    await settleUntil(() => h.calls.some(isNotifPut));
    await act(async () => setRecord({ tucked: ["z", "ward"] }));
    expect(committedSelf()?.tucked).toEqual(["z", "ward"]);
    expect(viewWrites()).toEqual(["PUT /api/me/view/notif-rooms"]);
  } finally {
    await act(async () => gate.release());
  }
  await settleUntil(() => viewWrites().length > 1 && h.saveIdle(view));

  expect(viewWrites()).toEqual([
    "PUT /api/me/view/notif-rooms",
    "PUT /api/me/view/tucked",
  ]);
  expect(bodyOf("/api/me/view/notif-rooms")).toEqual({ notifRooms: ["ward"] });
  expect(bodyOf("/api/me/view/tucked")).toEqual({ tucked: ["z"] });
});
