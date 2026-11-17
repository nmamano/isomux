// The office's stored shape (task ea29a8e2): written on pagehide or a hidden
// tab, only once the state is in (never from placeholders), measured from the
// real tab bar and the room in view, rounded to whole px. A part not in view
// keeps its stored value: the desks while the lobby or the back room is
// open. Hooks and setup: ui/test-support/office-shape-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const {
  SHAPE,
  SHAPE_KEY,
  all,
  backRoomOpen,
  drawn,
  expected,
  frame,
  fullState,
  hidePage,
  hideTab,
  loadAll,
  mount,
  one,
  realTabs,
  selfFrame,
  sessionContext,
  settle,
  size,
  store,
  stored,
} = await import("./test-support/office-shape-fixture.tsx");
const { OFFICE_SHAPE_DEFAULT } = await import("./office-shape.ts");
const { SCENE_H, SCENE_W } = await import("./office/grid.ts");
type OfficeShape = import("./office-shape.ts").OfficeShape;

setUpChatSidebarTests();

const sortDesks = (s: unknown) => {
  const shape = s as OfficeShape;
  return { ...shape, desks: [...shape.desks].sort((a, b) => a.desk - b.desk) };
};

it("stores the drawn shape on pagehide or a hidden tab, only once the state is in, and keeps the desks while the room is not in view", async () => {
  // Nothing stored: the default draws, and a page hide before full_state
  // stores nothing.
  let view = await mount();
  await frame(sessionContext);
  expect(drawn(view)).toEqual(expected(OFFICE_SHAPE_DEFAULT));
  await hidePage();
  await hideTab();
  expect(stored()).toBeNull();
  view.unmount();

  // A stored shape: a page hide before full_state keeps it byte for byte,
  // whatever the placeholders measure.
  store(SHAPE);
  const before = window.localStorage.getItem(SHAPE_KEY);
  view = await mount();
  await frame(sessionContext);
  for (const el of all(view, "[data-room-tab-placeholder]")) size(el, 55);
  await hidePage();
  await hideTab();
  expect(window.localStorage.getItem(SHAPE_KEY)).toBe(before);

  // Loaded, r1 in view with r3 tucked and two members online: the measured
  // shape, rounded to whole px.
  await loadAll(["r3"]);
  const tabs = realTabs(view);
  expect(tabs.length).toBe(2);
  size(tabs[0], 111.4);
  size(tabs[1], 93);
  size(one(view, "[data-online-chip]")!, 128.6);
  size(one(view, "[data-tucked-chip]")!, 64);
  size(one(view, '[data-desk-tag="0"]')!, 84, 22);
  size(one(view, '[data-desk-tag="1"]')!, 70.2, 34);
  await hidePage();
  const measured: OfficeShape = {
    tabs: [111, 93],
    online: 129,
    tucked: 64,
    desks: [
      { desk: 0, w: 84, h: 22 },
      { desk: 1, w: 70, h: 34 },
    ],
  };
  expect(sortDesks(stored())).toEqual(measured);

  // The lobby in view: the bar is measured, the desks keep their value.
  await act(async () => {
    fireEvent.click(one(view, "[data-lobby-tab] button")!);
  });
  size(realTabs(view)[0], 150);
  size(realTabs(view)[1], 93);
  for (const el of all(view, "[data-desk-tag]")) size(el, 1, 1);
  await hideTab();
  const lobbyShape = { ...measured, tabs: [150, 93] };
  expect(sortDesks(stored())).toEqual(lobbyShape);

  // The back room in view: the desks keep their value too.
  await act(async () => {
    fireEvent.click(one(view, '[data-room-tab-button="r1"]')!);
  });
  await act(async () => {
    fireEvent.click(one(view, "[data-trap-door]")!);
  });
  await settle();
  expect(backRoomOpen(view)).toBe(true);
  for (const el of all(view, "[data-desk-tag]")) size(el, 2, 2);
  size(realTabs(view)[0], 150);
  size(realTabs(view)[1], 93);
  await hidePage();
  expect(sortDesks(stored())).toEqual(lobbyShape);
  view.unmount();

  // The next load draws what was stored.
  view = await mount();
  await frame(sessionContext);
  expect(drawn(view)).toEqual(expected(lobbyShape));
});

it("stores the online and tucked chips as 0 when none is drawn, and the name tags in scene px when the scene is scaled", async () => {
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame([]));
  await frame(fullState);
  // No presence frame: no online chip; nothing tucked: no tucked chip.
  expect(one(view, "[data-online-chip]")).toBeNull();
  expect(one(view, "[data-tucked-chip]")).toBeNull();
  for (const el of realTabs(view)) size(el, 100);
  // The scene drawn at half its size (SCENE_W 950 wide): a tag's screen box
  // is half its box in the scene, where the placeholder draws it.
  size(one(view, "[data-floor-scene]")!, SCENE_W / 2, SCENE_H / 2);
  size(one(view, '[data-desk-tag="0"]')!, 50, 10);
  size(one(view, '[data-desk-tag="1"]')!, 30, 12);
  await hidePage();
  expect(stored()).not.toBeNull();
  const s = sortDesks(stored());
  expect(s.tabs).toEqual([100, 100, 100]);
  expect(s.online).toBe(0);
  expect(s.tucked).toBe(0);
  expect(s.desks).toEqual([
    { desk: 0, w: 100, h: 20 },
    { desk: 1, w: 60, h: 24 },
  ]);
});
