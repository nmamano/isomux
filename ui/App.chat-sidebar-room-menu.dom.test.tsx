// A room header's menu in the desktop sidebar (task 5dac6b9b; Nil,
// 2026-11-12: "Add the room menu"): a "..." button, and a right-click on the
// header, open Room settings, Tuck room or Untuck room, Move up and Move
// down. The moves and the tuck write the member's order and tucked list
// through the same calls as the room tab bar, so both always agree. Drag
// reorder is checked in a browser (HTML5 drag); its order rule is in
// ui/chat-sidebar.test.ts. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ALL_ROOMS,
  boot,
  click,
  roomHeader,
  setRole,
  setRooms,
  setSelfUser,
  setUpChatSidebarTests,
  viewWrites,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const menuButton = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-room-menu="${roomId}"]`,
  );
/** The open room menu's items, by id; exactly one menu is open. */
function menuItems(view: View): Map<string, HTMLElement> {
  const items = [
    ...view.baseElement.querySelectorAll<HTMLElement>("[data-room-menu]"),
  ];
  const ids = items.map((el) => el.getAttribute("data-room-menu")!);
  expect(new Set(ids).size).toBe(ids.length);
  expect(items.every((el) => el.getAttribute("role") === "menuitem")).toBe(
    true,
  );
  return new Map(items.map((el) => [el.getAttribute("data-room-menu")!, el]));
}
const disabled = (el: HTMLElement | undefined) =>
  el === undefined
    ? null
    : (el as HTMLButtonElement).disabled ||
      el.getAttribute("aria-disabled") === "true";
/** The ordinary rooms' headers in the sidebar, top to bottom. */
const headerOrder = (view: View) =>
  [
    ...view.container.querySelectorAll(
      "nav[data-chat-sidebar] button[data-sidebar-room]",
    ),
  ]
    .map((el) => el.getAttribute("data-sidebar-room"))
    .filter((id) => id !== "lobby");
const writes = (path: string) =>
  viewWrites.filter((w) => w.path === path).map((w) => w.body);

it("Move up and Move down reorder the shown rooms, disabled at the ends, and write the member's full order", async () => {
  setRooms(ALL_ROOMS);
  setSelfUser({ tucked: ["r3"] });
  const view = await boot();
  expect(headerOrder(view).slice(0, 2)).toEqual(["r1", "r2"]);

  await click(menuButton(view, "r1"));
  let items = menuItems(view);
  expect({
    up: disabled(items.get("up")),
    down: disabled(items.get("down")),
  }).toEqual({ up: true, down: false });
  // Settings and a tuck are offered on a shown room; untuck is not.
  expect([
    items.has("settings"),
    items.has("tuck"),
    items.has("untuck"),
  ]).toEqual([true, true, false]);
  // Another room's "..." replaces the open menu (menuItems: one menu).
  await click(menuButton(view, "r2"));
  items = menuItems(view);
  expect({
    up: disabled(items.get("up")),
    down: disabled(items.get("down")),
  }).toEqual({ up: false, down: true });

  await click(items.get("up") ?? null);
  // The order covers every room, tucked ones included, as the tab bar's.
  expect(writes("/api/me/view/order")).toEqual([{ order: ["r2", "r1", "r3"] }]);
  expect(headerOrder(view).slice(0, 2)).toEqual(["r2", "r1"]);
});

it("a right-click on a room header opens the same menu; Tuck room moves the room under Tucked rooms, and Untuck brings one back", async () => {
  setRooms(ALL_ROOMS);
  setSelfUser({ tucked: ["r3"] });
  const view = await boot();
  const header = roomHeader(view, "r1");
  expect(header).not.toBeNull();
  await act(async () =>
    fireEvent.contextMenu(header!, { clientX: 40, clientY: 200 }),
  );
  await click(menuItems(view).get("tuck") ?? null);
  expect(writes("/api/me/view/tucked")).toEqual([{ tucked: ["r3", "r1"] }]);
  const underTucked = (id: string) =>
    roomHeader(view, id)?.closest("[data-sidebar-tucked-rooms]") != null;

  // Both tucked rooms now sit in the Tucked rooms list.
  const more = view.container.querySelector<HTMLButtonElement>(
    "nav[data-chat-sidebar] button[data-sidebar-more-rooms]",
  );
  if (more?.getAttribute("aria-expanded") !== "true") await click(more);
  expect([underTucked("r1"), underTucked("r3"), underTucked("r2")]).toEqual([
    true,
    true,
    false,
  ]);

  await click(menuButton(view, "r3"));
  const items = menuItems(view);
  expect([items.has("tuck"), items.has("untuck")]).toEqual([false, true]);
  await click(items.get("untuck") ?? null);
  expect(writes("/api/me/view/tucked")[1]).toEqual({ tucked: ["r1"] });
  expect(underTucked("r3")).toBe(false);
});

it("Room settings opens Settings on that room", async () => {
  setRole("owner");
  setSelfUser({ role: "owner" });
  const view = await boot();
  await click(menuButton(view, "r2"));
  await click(menuItems(view).get("settings") ?? null);
  expect(
    view.baseElement.querySelector('[data-testid="settings-content"]'),
  ).not.toBeNull();
  // Settings' own list marks the room it opened on.
  const current = [
    ...view.baseElement.querySelectorAll('button[aria-current="true"]'),
  ].filter((el) => el.closest("nav[data-chat-sidebar]") === null);
  expect(current.map((el) => el.textContent?.trim())).toEqual(["Second room"]);
});

// Found in the browser review (2026-11-12): over the task board, Escape
// closed the board and left the menu open over the office. The board takes
// Escape first (a window capture listener that stops it), so the menu may
// not outrank it; like the desk menu (App closes it on every Escape), it
// must close with the page.
it("Escape closes the open room menu, also over a page that takes Escape first", async () => {
  const view = await boot();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
  });
  expect(view.container.querySelector("[data-tasks-page]")).not.toBeNull();
  await click(menuButton(view, "r1"));
  expect(menuItems(view).size).toBe(4);

  await act(async () =>
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true }),
  );
  expect(view.baseElement.querySelectorAll("[data-room-menu]").length).toBe(0);
});
