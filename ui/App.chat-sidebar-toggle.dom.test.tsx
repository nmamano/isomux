// The desktop chat sidebar is optional (task c61316be; Nil, 2026-11-11: "add
// an optional sidebar on desktop"): its collapse button turns it off, and the
// chat is then today's, with Back and the back room strip, plus a Show sidebar
// button. The choice is per device; with none, the window width decides. The
// setup is in ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  boot,
  builder,
  chatOpen,
  click,
  openBackAgent,
  openFirstDesk,
  setUpChatSidebarTests,
  setWindowWidth,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const KEY = "isomux-chat-sidebar";
const backButton = (view: View) =>
  view.container.querySelector("button[data-log-back]");
const showButton = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("button[data-show-sidebar]");
const collapseButton = (view: View) =>
  view.container.querySelector<HTMLButtonElement>(
    "nav[data-chat-sidebar] button[data-sidebar-collapse]",
  );
const strip = (view: View) =>
  view.container.querySelector("[data-back-room-strip]");

it("open: the sidebar replaces the chat's Back button; collapsed: Back and Show sidebar return, and the choice outlives a reload at any width", async () => {
  const first = await boot();
  await openFirstDesk(first);
  expect(sidebar(first)).not.toBeNull();
  expect(backButton(first)).toBeNull();
  expect(showButton(first)).toBeNull();
  // Opening on its own default writes no choice.
  expect(window.localStorage.getItem(KEY)).toBeNull();

  await click(collapseButton(first));
  expect(sidebar(first)).toBeNull();
  expect(chatOpen(first)).toBe(true);
  expect(backButton(first)).not.toBeNull();
  expect(showButton(first)).not.toBeNull();
  expect(window.localStorage.getItem(KEY)).toBe("closed");
  first.unmount();

  // A reload on a wide window keeps it collapsed.
  const second = await boot();
  await openFirstDesk(second);
  expect(sidebar(second)).toBeNull();

  await click(showButton(second));
  expect(sidebar(second)).not.toBeNull();
  expect(backButton(second)).toBeNull();
  expect(window.localStorage.getItem(KEY)).toBe("open");
  second.unmount();

  // A reload on a narrow window keeps it open.
  setWindowWidth(900);
  const third = await boot();
  await openFirstDesk(third);
  expect(sidebar(third)).not.toBeNull();
});

it("with no choice stored, starts collapsed on a window under 1100 px and stores nothing", async () => {
  setWindowWidth(1000);
  const view = await boot();
  await openFirstDesk(view);
  expect(sidebar(view)).toBeNull();
  expect(showButton(view)).not.toBeNull();
  expect(backButton(view)).not.toBeNull();
  expect(window.localStorage.getItem(KEY)).toBeNull();
});

it("hides the back room strip of a back agent's chat only while the sidebar is open", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await openBackAgent(view, "r1", builder.id);
  expect(strip(view)).toBeNull();

  await click(collapseButton(view));
  // Today's chat of a back agent: the strip names the front agents.
  expect(strip(view)).not.toBeNull();
});
