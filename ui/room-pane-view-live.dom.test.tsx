// The room settings pane's "Your view" block: saves against a record that
// changes while the pane is open (tasks 83d34b44, 611c968e). An untouched
// level follows the record, a picked one keeps the member's choice, and
// every written list is built from the record as it is at that write.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { Call } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { level, pick, mount, viewWrites, bodyOf, setRecord, setOnCall } = h;
const { settleUntil, committedSelf } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("an untouched level follows a record change, a picked one does not, and the lists are read after a change that lands during the room writes", async () => {
  const { view, deletedCount } = await mount({ notifRooms: ["other"] });
  // A tuck from the tab bar while the pane is open: the untouched level
  // follows it.
  await act(async () => setRecord({ tucked: ["ward"] }));
  expect(level(view)).toBe("tucked");
  await pick(view, "notify");
  // Another record change: the picked level keeps the member's choice.
  await act(async () => setRecord({ tucked: ["ward", "t2"] }));
  expect(level(view)).toBe("notify");

  // More changes land while the room instructions write is in flight: the
  // view lists are built after them, not before.
  const gate = h.hold();
  const isSettingsPut = (c: Call) =>
    c.method === "PUT" && c.path.endsWith("/instructions");
  setOnCall((c) => (isSettingsPut(c) ? gate.response : undefined));
  try {
    await h.startSave(view);
    await settleUntil(() => h.calls.some(isSettingsPut));
    await act(async () =>
      setRecord({
        tucked: ["t3", "ward", "t2"],
        notifRooms: ["other", "granted"],
      }),
    );
    expect(committedSelf()?.notifRooms).toEqual(["other", "granted"]);
    expect(viewWrites()).toEqual([]);
  } finally {
    await act(async () => gate.release());
  }
  await settleUntil(() => viewWrites().length > 1 && h.saveIdle(view));

  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "PUT /api/me/view/notif-rooms",
  ]);
  expect(bodyOf("/api/me/view/tucked")).toEqual({ tucked: ["t3", "t2"] });
  expect(
    [
      ...(bodyOf("/api/me/view/notif-rooms") as { notifRooms: string[] })
        .notifRooms,
    ].sort(),
  ).toEqual(["granted", "other", "ward"]);
  expect(deletedCount()).toBe(0);
});
