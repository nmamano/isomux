// Where the desktop sidebar shows (task c61316be; Nil, 2026-11-11: "Sidebar on
// chat and pages", then "the side bar should also appear on the office view",
// then "clicking something on the side bar does not close the sidebar"):
// beside the office view (a room, the lobby, a back room screen), an agent's
// chat and every page, Settings included; never on a phone or in the site
// embed. That no entry of the sidebar hides it is in
// ui/App.chat-sidebar-walk.dom.test.tsx. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { DEMO_FEATURES } = await import("../shared/features.ts");
const {
  backRoomRow,
  backScreen,
  boot,
  chatOpen,
  click,
  navRow,
  openFirstDesk,
  press,
  roomHeader,
  setUpChatSidebarTests,
  setWindowWidth,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const officeCurrent = (view: View) =>
  navRow(view, "office")?.getAttribute("aria-current") ?? null;
const roomTab = (view: View, roomId: string) =>
  view.container.querySelector<HTMLElement>(
    `[data-room-tab-button="${roomId}"]`,
  );

it("shows beside the office view: the lobby, a room and its back room screen, with the Office row current; beside a chat it is not current", async () => {
  const view = await boot();
  expect(chatOpen(view)).toBe(false);
  expect(sidebar(view)).not.toBeNull();
  expect(officeCurrent(view)).toBe("page");

  await click(roomTab(view, "r1"));
  expect(sidebar(view)).not.toBeNull();
  // With no open agent, the room in view opens.
  expect(roomHeader(view, "r1")?.getAttribute("aria-expanded")).toBe("true");

  await press("b");
  expect(backScreen(view)).toBe(true);
  expect(sidebar(view)).not.toBeNull();
  // On its back room screen, the room's Back room row opens too.
  expect(backRoomRow(view, "r1")?.getAttribute("aria-expanded")).toBe("true");
  expect(officeCurrent(view)).toBe("page");

  await press("b");
  expect(backScreen(view)).toBe(false);
  await openFirstDesk(view);
  expect(sidebar(view)).not.toBeNull();
  expect(officeCurrent(view)).toBeNull();
});

it("stays beside Settings, also when Settings opens over a page", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  expect(view.container.querySelector("[data-tasks-page]")).not.toBeNull();
  expect(sidebar(view)).not.toBeNull();

  await press("s");
  expect(
    view.baseElement.querySelector('[data-testid="settings-content"]'),
  ).not.toBeNull();
  expect(sidebar(view)).not.toBeNull();
});

it("is not in the site embed: neither the sidebar nor a Show sidebar button", async () => {
  const view = await boot({ ...DEMO_FEATURES, embed: true });
  // The embed draws the office (with no room tabs).
  expect(view.container.querySelector("[data-floor-scene]")).not.toBeNull();
  expect(sidebar(view)).toBeNull();
  expect(view.container.querySelector("[data-show-sidebar]")).toBeNull();
});

it("is not on a phone, in the office or a chat", async () => {
  setWindowWidth(390);
  // This browser chose the sidebar open before (a desktop window made narrow),
  // so only the phone check keeps it off, not the narrow-width default.
  window.localStorage.setItem("isomux-chat-sidebar", "open");
  const view = await boot();
  // The store reads the width again on a resize, after its 150 ms debounce.
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(sidebar(view)).toBeNull();
  expect(view.container.querySelector("[data-show-sidebar]")).toBeNull();

  await openFirstDesk(view);
  // The chat is in its phone layout (LogView lays out its shell as a row on
  // a phone, a column on a desktop), so the window really reads as a phone.
  const shell = view.container.querySelector<HTMLElement>(".log-view-shell");
  expect(shell?.style.flexDirection).toBe("row");
  expect(sidebar(view)).toBeNull();
  // A phone is not a collapsed desktop: no Show sidebar either.
  expect(view.container.querySelector("[data-show-sidebar]")).toBeNull();
});
