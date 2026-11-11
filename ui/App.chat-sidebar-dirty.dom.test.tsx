// A sidebar click never drops a page's unsaved edits without asking (task
// c61316be). Settings and the task board each guard an edit with an in-page
// discard prompt (Escape, their own rows); a sidebar entry that leaves the
// page goes through the same prompt: the page stays until the member
// discards. The setup is in ui/test-support/chat-sidebar-fixture.tsx; the
// pages' own guards in ui/App.settings-dirty.dom.test.tsx and
// ui/App.dirty.dom.test.tsx.

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
  scout,
  setRole,
  setSelfUser,
  setUpChatSidebarTests,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

/** The discard prompt (ui/components/UnsavedChangesPrompt.tsx): its box, or
 *  null. Its first button discards. */
function prompt(view: View): HTMLElement | null {
  const text = [...view.container.querySelectorAll("span")].find(
    (span) => span.textContent === en["common.discardPrompt"],
  );
  return text?.parentElement ?? null;
}
async function discard(view: View): Promise<void> {
  const box = prompt(view);
  expect(box).not.toBeNull();
  await click(box!.querySelector("button"));
}

const settingsOpen = (view: View) =>
  view.baseElement.querySelector('[data-testid="settings-content"]') !== null;
const tasksOpen = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;

it("Settings with an unsaved room edit: a sidebar row asks first, and leaves only on discard", async () => {
  setRole("owner");
  setSelfUser({ role: "owner" });
  const view = await boot();
  await openFirstDesk(view);
  await click(
    view.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-self]",
    ),
  );
  expect(settingsOpen(view)).toBe(true);
  // The room pane, as ui/App.settings-dirty.dom.test.tsx opens it.
  await click(
    view.container.querySelector('[data-sidebar-group-toggle="rooms"]'),
  );
  await click(
    [...view.container.querySelectorAll("button")].find(
      (b) =>
        b.textContent === "First room" && !b.closest("nav[data-chat-sidebar]"),
    ) ?? null,
  );
  const nameField = await view.findByPlaceholderText(
    en["settings.room.namePlaceholder"],
  );
  await act(async () =>
    fireEvent.change(nameField, { target: { value: "Edited Room" } }),
  );
  expect(prompt(view)).toBeNull();

  await click(navRow(view, "tasks"));
  expect({
    prompt: prompt(view) !== null,
    settings: settingsOpen(view),
    tasks: tasksOpen(view),
    sidebar: sidebar(view) !== null,
  }).toEqual({ prompt: true, settings: true, tasks: false, sidebar: true });

  await discard(view);
  expect({ settings: settingsOpen(view), tasks: tasksOpen(view) }).toEqual({
    settings: false,
    tasks: true,
  });
});

it("Tasks with an unsaved new task: an agent row asks first, and opens the chat only on discard", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  const quickAdd = view.getByPlaceholderText(en["tasks.quickAdd"]);
  await act(async () => {
    fireEvent.change(quickAdd, { target: { value: "unsaved title" } });
    fireEvent.keyDown(quickAdd, { key: "Enter", bubbles: true });
  });
  // The panel is open with the unsaved value: the board is dirty.
  expect(view.getByDisplayValue("unsaved title")).toBeDefined();

  await click(
    view.container.querySelector(
      `nav[data-chat-sidebar] button[data-sidebar-agent="${scout.id}"]`,
    ),
  );
  expect({
    prompt: prompt(view) !== null,
    tasks: tasksOpen(view),
  }).toEqual({ prompt: true, tasks: true });

  await discard(view);
  expect(tasksOpen(view)).toBe(false);
  expect(view.container.querySelector(".log-view-shell")).not.toBeNull();
});
