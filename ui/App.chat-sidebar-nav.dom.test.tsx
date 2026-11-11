// The desktop sidebar's page rows (task 419ab720; Nil, 2026-11-11: "add
// settings to the side bar: Apps Inbox Tasks Automations Skills Integrations
// Settings Office"): that order, above the Lobby, and a Settings row that
// opens the Settings page and is marked there. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { boot, click, navRow, openFirstDesk, setUpChatSidebarTests, sidebar } =
  await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

/** The data-sidebar-nav rows, in DOM order. */
const navOrder = (view: View) =>
  [
    ...view.container.querySelectorAll(
      "nav[data-chat-sidebar] button[data-sidebar-nav]",
    ),
  ].map((row) => row.getAttribute("data-sidebar-nav"));
/** The data-sidebar-nav rows marked as the page in view. */
const currentNav = (view: View) =>
  [
    ...view.container.querySelectorAll(
      'nav[data-chat-sidebar] button[data-sidebar-nav][aria-current="page"]',
    ),
  ].map((row) => row.getAttribute("data-sidebar-nav"));
const settingsShown = (view: View) =>
  view.baseElement.querySelector('[data-testid="settings-content"]') !== null;
const tasksShown = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;

it("orders the page rows Apps, Inbox, Tasks, Automations, Skills, Integrations, Settings, Office, above the Lobby's rows", async () => {
  const view = await boot();
  // The Lobby section is open, so its Members chat row is drawn (the end
  // marker of the order).
  expect(
    view.container
      .querySelector('nav[data-chat-sidebar] button[data-sidebar-room="lobby"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(navOrder(view)).toEqual([
    "apps",
    "asks",
    "tasks",
    "cronjobs",
    "skills",
    "integrations",
    "settings",
    "office",
    "members-chat",
  ]);
});

it("the Settings row opens Settings beside the sidebar and is the one row marked there; another page row takes the mark", async () => {
  const view = await boot();
  await openFirstDesk(view);
  expect(settingsShown(view)).toBe(false);
  expect(currentNav(view)).toEqual([]);

  await click(navRow(view, "settings"));
  expect(settingsShown(view)).toBe(true);
  expect(sidebar(view)).not.toBeNull();
  expect(currentNav(view)).toEqual(["settings"]);

  await click(navRow(view, "tasks"));
  expect(tasksShown(view)).toBe(true);
  expect(settingsShown(view)).toBe(false);
  expect(currentNav(view)).toEqual(["tasks"]);
});
