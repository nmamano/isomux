// The room settings pane's "Your view" block: saves against a record that
// changes while the pane is open (task 83d34b44). Untouched controls follow
// the record; every written list is built from the record as it is at that
// write.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { Call } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { box, click, mount, viewWrites, bodyOf, setRecord, setOnCall } = h;
const { settleUntil, committedSelf } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("an untouched control follows a record change, and a list is read after a change that lands during the room writes", async () => {
  const { view, deletedCount } = await mount({ notifRooms: ["other"] });
  await click(view, "notif");
  // A tuck from the tab bar while the pane is open: the untouched control
  // follows it, the touched one keeps the member's choice.
  await act(async () => setRecord({ tucked: ["ward"] }));
  expect(box(view, "tucked")!.checked).toBe(true);
  expect(box(view, "notif")!.checked).toBe(true);

  // A notifications change elsewhere lands while the room settings write is
  // in flight: the notifications list is built after it, not before.
  const gate = h.hold();
  const isSettingsPut = (c: Call) =>
    c.method === "PUT" && c.path.endsWith("/settings");
  setOnCall((c) => (isSettingsPut(c) ? gate.response : undefined));
  try {
    await h.startSave(view);
    await settleUntil(() => h.calls.some(isSettingsPut));
    await act(async () => setRecord({ notifRooms: ["other", "granted"] }));
    expect(committedSelf()?.notifRooms).toEqual(["other", "granted"]);
    expect(viewWrites()).toEqual([]);
  } finally {
    await act(async () => gate.release());
  }
  await settleUntil(() => viewWrites().length > 0 && h.saveIdle(view));

  expect(viewWrites()).toEqual(["PUT /api/me/view/notif-rooms"]);
  expect(bodyOf("/api/me/view/notif-rooms")).toEqual({
    notifRooms: ["other", "granted", "ward"],
  });
  expect(deletedCount()).toBe(0);
});
