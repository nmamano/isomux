// The Agent settings page holds unsaved edits as Settings does (task
// 59538509): a sidebar row goes through its discard prompt, the page keys
// (t, s, a, i) do nothing while it shows, opening it from a page with unsaved
// edits asks that page first, Back drops it with the view under it, and
// Escape with a menu or a dialog over it closes only that. The last two are in
// ui/App.agent-settings-page-escape.dom.test.tsx. The doors are in
// ui/App.agent-settings-page.dom.test.tsx and
// ui/App.agent-settings-page-form.dom.test.tsx; the setup in
// ui/test-support/agent-settings-page-fixture.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  boot,
  click,
  navRow,
  openFirstDesk,
  press,
  scout,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
const {
  discard,
  headerName,
  openRoom,
  openSection,
  pageAgent,
  prompt,
  settingsButton,
  settingsOpen,
  tasksOpen,
  typeName,
} = await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

it("the page keys do nothing while Settings shows the agent; a sidebar page row asks about an unsaved edit, then leaves to that page", async () => {
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
  // The agent's page is Settings drilled into it (task 1f79f2e3).
  expect(settingsOpen(view)).toBe(true);

  await openSection(view, "general");
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

it("the page over Tasks: Close returns to Tasks, and Back returns to Tasks too", async () => {
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
  // Settings is a page on the stack above Tasks (task 1f79f2e3): Back pops
  // it, as Close does.
  expect({ page: pageAgent(view), tasks: tasksOpen(view) }).toEqual({
    page: null,
    tasks: true,
  });
});
