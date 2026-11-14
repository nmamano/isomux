// The Agent settings page holds unsaved edits as Settings does (task
// 59538509): a sidebar row goes through its discard prompt, the page keys
// (t, s, a, i) do nothing while it shows, opening it from a page with unsaved
// edits asks that page first, Back drops it with the view under it, and
// Escape with a menu or a dialog over it closes only that. The doors are in
// ui/App.agent-settings-page.dom.test.tsx; the setup in
// ui/test-support/agent-settings-page-fixture.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const {
  boot,
  click,
  navRow,
  openFirstDesk,
  press,
  ranger,
  scout,
  setRole,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
const {
  discard,
  headerName,
  openRoom,
  pageAgent,
  prompt,
  settingsButton,
  settingsOpen,
  tasksOpen,
  typeName,
} = await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

it("the page keys do nothing while the page shows; a sidebar page row asks about an unsaved edit, then leaves to that page", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(headerName(view));
  for (const key of ["t", "s", "a", "i"]) {
    await press(key);
    expect({ key, page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
      key,
      page: scout.id,
      tasks: false,
    });
  }
  expect(settingsOpen(view)).toBe(false);

  await typeName(view, "Unsaved");
  await click(navRow(view, "tasks"));
  expect({
    page: pageAgent(view),
    tasks: tasksOpen(view),
    prompt: prompt(view) !== null,
  }).toEqual({ page: scout.id, tasks: false, prompt: true });
  await discard(view);
  expect({ page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
    page: null,
    tasks: true,
  });
});

it("the page over Tasks: Close returns to Tasks, and Back from Tasks drops the page with it", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(navRow(view, "tasks"));
  expect(tasksOpen(view)).toBe(true);
  await openRoom(view, "r1");
  await click(settingsButton(view, scout.id));
  expect({ page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
    page: scout.id,
    tasks: false,
  });
  await click(view.baseElement.querySelector("[data-page-close]"));
  expect({ page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
    page: null,
    tasks: true,
  });

  await click(settingsButton(view, scout.id));
  expect(pageAgent(view)).toBe(scout.id);
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect({ page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
    page: null,
    tasks: false,
  });
});

it("Settings with an unsaved room edit: an agent's settings button asks Settings first, and opens the page only on Discard", async () => {
  setRole("owner");
  setSelfUser({ role: "owner" });
  const view = await boot();
  await openFirstDesk(view);
  await click(navRow(view, "settings"));
  expect(settingsOpen(view)).toBe(true);
  // The room pane, as ui/App.chat-sidebar-dirty.dom.test.tsx opens it.
  await click(
    view.container.querySelector('[data-sidebar-group-toggle="rooms"]'),
  );
  await click(
    [...view.container.querySelectorAll("button")].find(
      (b) =>
        b.textContent === "First room" && !b.closest("nav[data-chat-sidebar]"),
    ) ?? null,
  );
  const roomName = await view.findByPlaceholderText(
    en["settings.room.namePlaceholder"],
  );
  await act(async () =>
    fireEvent.change(roomName, { target: { value: "Edited Room" } }),
  );
  await openRoom(view, "r1");
  await click(settingsButton(view, scout.id));
  expect({
    settings: settingsOpen(view),
    page: pageAgent(view),
    prompt: prompt(view) !== null,
  }).toEqual({ settings: true, page: null, prompt: true });
  await discard(view);
  expect({ settings: settingsOpen(view), page: pageAgent(view) }).toEqual({
    settings: false,
    page: scout.id,
  });
});

it("Escape with a menu or the new-agent dialog over the page closes only that, and the page stays", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await openRoom(view, "r1");
  await click(settingsButton(view, scout.id));
  expect(pageAgent(view)).toBe(scout.id);

  // An agent row's menu, from the sidebar.
  await act(async () =>
    fireEvent.contextMenu(
      view.container.querySelector(
        `nav[data-chat-sidebar] button[data-sidebar-agent="${ranger.id}"]`,
      )!,
      { clientX: 60, clientY: 200 },
    ),
  );
  const menu = () =>
    view.baseElement.querySelector(`[data-agent-menu="${ranger.id}"]`);
  expect(menu()).not.toBeNull();
  await press("Escape");
  expect({ menu: menu() !== null, page: pageAgent(view) }).toEqual({
    menu: false,
    page: scout.id,
  });

  // A room's "+".
  await click(
    view.container.querySelector(
      'nav[data-chat-sidebar] button[data-sidebar-new-agent="r1"]',
    ),
  );
  const spawn = () =>
    view.baseElement.querySelector(".spawn-agent-dialog-desktop");
  expect(spawn()).not.toBeNull();
  await press("Escape");
  expect({ spawn: spawn() !== null, page: pageAgent(view) }).toEqual({
    spawn: false,
    page: scout.id,
  });
});
