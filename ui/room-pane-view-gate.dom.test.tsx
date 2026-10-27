// The room settings pane's "Your view" block: a record change that lands
// between two of the save's view writes reaches the later write (tasks
// 83d34b44, 611c968e). The first write's response is held by hand, so the
// change commits before the second write is built: the lists must not all
// come from one copy of the record taken before the first write.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { Call } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { act } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { pick, mount, viewWrites, bodyOf, setRecord, setOnCall } = h;
const { settleUntil, committedSelf } = h;

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("each list is read from the record as it is at that write", async () => {
  const { view } = await mount({ tucked: ["ward"], notifRooms: [] });
  await pick(view, "notify");

  const gate = h.hold();
  const isTuckedPut = (c: Call) => c.path === "/api/me/view/tucked";
  setOnCall((c) => (isTuckedPut(c) ? gate.response : undefined));
  try {
    await h.startSave(view);
    await settleUntil(() => h.calls.some(isTuckedPut));
    await act(async () => setRecord({ tucked: ["z"], notifRooms: ["n2"] }));
    expect(committedSelf()?.notifRooms).toEqual(["n2"]);
    expect(viewWrites()).toEqual(["PUT /api/me/view/tucked"]);
  } finally {
    await act(async () => gate.release());
  }
  await settleUntil(() => viewWrites().length > 1 && h.saveIdle(view));

  expect(viewWrites()).toEqual([
    "PUT /api/me/view/tucked",
    "PUT /api/me/view/notif-rooms",
  ]);
  expect(bodyOf("/api/me/view/tucked")).toEqual({ tucked: [] });
  expect(
    [
      ...(bodyOf("/api/me/view/notif-rooms") as { notifRooms: string[] })
        .notifRooms,
    ].sort(),
  ).toEqual(["n2", "ward"]);
});
