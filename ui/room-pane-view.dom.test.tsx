// The room settings pane's "Your view" block (tasks 83d34b44, 611c968e): the
// viewer's own view level for this room, saved through the same
// /api/me/view routes Settings > Rooms uses. The level writes are in
// room-pane-view-push.dom.test.tsx, the hide in room-pane-view-hide.dom.test.tsx
// and the live-record saves in room-pane-view-live.dom.test.tsx (the DOM
// harness budgets wall clock per file).

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { View } from "./test-support/room-view-harness.ts";

setUpDomTestFile();
const { setApiShim } = await import("./api.ts");
const h = await import("./test-support/room-view-harness.ts");
const { level, pick, save, mount, viewWrites } = h;
const { expectEveryStepNamed, expectLegend } =
  await import("./test-support/view-level-dom.ts");
const { ROOM_VIEW_LEVELS } = await import("../shared/room-view-level.ts");
const legendOf = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-room-view-legend]");

h.installApiShim();
afterAll(() => setApiShim(null));
beforeEach(() => h.resetCalls());

it("shows no view control for the lobby", async () => {
  const { view } = await mount(
    {},
    { rooms: [h.LOBBY, h.WARD], roomId: "lobby" },
  );
  expect(level(view)).toBeNull();
  expect(legendOf(view)).toBeNull();
  view.unmount();
});

it("reads the level from the viewer's record, writes nothing while untouched or picked back, and reads a tucked room with notifications as tucked", async () => {
  const { view } = await mount({ notifRooms: ["ward"], pushRooms: ["ward"] });
  expect(level(view)).toBe("push");
  await save(view);
  expect(viewWrites()).toEqual([]);

  await pick(view, "tucked");
  await pick(view, "push");
  await save(view);
  expect(viewWrites()).toEqual([]);
  view.unmount();

  // A record from before the levels, or from a server that has not
  // normalized it yet.
  const old = await mount({ tucked: ["ward"], notifRooms: ["ward"] });
  expect(level(old.view)).toBe("tucked");
  old.view.unmount();
});

it("names all five steps of the control, the same control as the Settings > Rooms table, and explains each level under it", async () => {
  const { view } = await mount({});
  const group = view.container.querySelector<HTMLElement>(
    '[role="radiogroup"][data-view-level]',
  )!;
  expectEveryStepNamed(group);
  const stepName = (l: string) =>
    group
      .querySelector(`[role="radio"][data-view-level="${l}"]`)!
      .getAttribute("aria-label")!;
  const legend = legendOf(view)!;
  expectLegend(legend, ROOM_VIEW_LEVELS, stepName);
  // Under the control.
  expect(
    group.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.unmount();
});
