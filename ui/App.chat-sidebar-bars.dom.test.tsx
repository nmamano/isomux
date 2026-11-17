// While the desktop sidebar is open, a top-bar button that does the same as a
// sidebar entry is hidden (task c61316be; Nil, 2026-11-11: "the nav bar
// buttons become redundant with the side bar"); with the sidebar hidden, the
// bars are as before. The setup is in ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { boot, click, openFirstDesk, setUpChatSidebarTests, sidebar } =
  await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

/** The ids of the top-bar buttons (NavActions marks each with
 *  data-nav-action) outside the sidebar. */
function barActions(view: View): string[] {
  return [...view.container.querySelectorAll("[data-nav-action]")]
    .filter((el) => el.closest("nav[data-chat-sidebar]") === null)
    .map((el) => el.getAttribute("data-nav-action")!)
    .sort();
}

async function hideSidebar(view: View): Promise<void> {
  await click(
    view.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-collapse]",
    ),
  );
  expect(sidebar(view)).toBeNull();
}

// The top-bar buttons with a sidebar twin (agreed with the worker,
// 2026-11-11).
const OFFICE_TWINS = new Set([
  "tasks",
  "cronjobs",
  "apps",
  "skills",
  "integrations",
  "inbox",
  "settings",
]);
const CHAT_TWINS = new Set(["tasks", "inbox"]);

it("office top bar: with the sidebar open, the buttons it repeats are gone and the rest stay; hidden, the bar is whole", async () => {
  const view = await boot();
  const open = barActions(view);
  await hideSidebar(view);
  const whole = barActions(view);
  // Today's bar has every twin, so the open bar's gaps are real.
  expect(whole.filter((id) => OFFICE_TWINS.has(id)).length).toBe(
    OFFICE_TWINS.size,
  );
  expect(open).toEqual(whole.filter((id) => !OFFICE_TWINS.has(id)));
  // Something with no twin stays (the theme switch).
  expect(open.length).toBeGreaterThan(0);
});

it("chat header: with the sidebar open, its Tasks and Inbox buttons are gone and the rest stay; hidden, the header is whole", async () => {
  const view = await boot();
  await openFirstDesk(view);
  const open = barActions(view);
  await hideSidebar(view);
  const whole = barActions(view);
  expect(whole.filter((id) => CHAT_TWINS.has(id)).length).toBe(CHAT_TWINS.size);
  expect(open).toEqual(whole.filter((id) => !CHAT_TWINS.has(id)));
  expect(open.length).toBeGreaterThan(0);
});
