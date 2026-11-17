// The office while it loads (task ea29a8e2): nothing in the loading room
// scene acts - no wall door is a control (no New room door), the door drop
// zones take no pointer, and a click on the trap door or an empty desk opens
// nothing, not even once the state arrives. Loaded, the same controls act.
// Hooks and setup: ui/test-support/office-shape-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const {
  SHAPE,
  all,
  backRoomOpen,
  dialogOpen,
  emptyDeskHits,
  frame,
  fullState,
  loadAll,
  mount,
  one,
  selfFrame,
  sessionContext,
  settle,
  store,
  tabIds,
} = await import("./test-support/office-shape-fixture.tsx");

setUpChatSidebarTests();

it("a click in the loading scene opens nothing, then or once the state arrives; loaded, the same controls act", async () => {
  store(SHAPE);
  let view = await mount();
  await frame(sessionContext);
  await frame(selfFrame([]));

  // The room scene is drawn (its desk placeholders), and no wall door is a
  // control.
  expect(all(view, "[data-desk-placeholder]").length).toBe(2);
  expect(all(view, ".isomux-wall-door").length).toBe(0);
  // The drop zones hold their place and take no pointer.
  const zones = all(view, "[data-door-drop]");
  expect(zones.length).toBe(2);
  for (const z of zones) expect(z.style.pointerEvents).toBe("none");
  // The trap door is drawn; a click or a key on it, and a click on each empty
  // desk, does nothing.
  const hatch = one(view, "[data-trap-door]");
  expect(hatch).not.toBeNull();
  const hits = emptyDeskHits(view);
  expect(hits.length).toBeGreaterThan(0);
  await act(async () => {
    for (const z of zones) fireEvent.click(z);
    fireEvent.click(hatch!);
    fireEvent.keyDown(hatch!, { key: "Enter" });
    for (const hit of hits) fireEvent.click(hit);
  });
  expect(dialogOpen(view)).toBe(false);
  expect(backRoomOpen(view)).toBe(false);

  // The state arrives: none of those clicks opens anything late.
  await frame(fullState);
  await settle();
  expect(tabIds(view)).toEqual(["r1", "r2", "r3"]);
  expect(dialogOpen(view)).toBe(false);
  expect(backRoomOpen(view)).toBe(false);

  // Loaded (r1, between the lobby and r2): both doors are controls, the drop
  // zone takes the pointer, an empty desk opens the spawn dialog.
  expect(all(view, ".isomux-wall-door").length).toBe(2);
  const loadedZones = all(view, "[data-door-drop]");
  expect(loadedZones.length).toBe(1);
  expect(loadedZones[0].style.pointerEvents).not.toBe("none");
  await act(async () => {
    fireEvent.click(emptyDeskHits(view)[0]);
  });
  expect(dialogOpen(view)).toBe(true);
  view.unmount();

  // And the trap door opens the back room.
  view = await mount();
  await loadAll();
  await act(async () => {
    fireEvent.click(one(view, "[data-trap-door]")!);
  });
  await settle();
  expect(backRoomOpen(view)).toBe(true);
});
