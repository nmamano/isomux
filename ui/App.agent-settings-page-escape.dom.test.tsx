// The Agent settings page holds unsaved edits as Settings does (task
// 59538509): opening it from a page with unsaved edits asks that page first,
// and Escape with a menu or a dialog over it closes only that. Split from
// ui/App.agent-settings-page-guards.dom.test.tsx, which holds the sidebar row,
// the page keys and Back, because the 5 s cap is per file. The doors are in
// ui/App.agent-settings-page.dom.test.tsx and
// ui/App.agent-settings-page-form.dom.test.tsx; the setup in
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
const { discard, openRoom, pageAgent, prompt, settingsButton, settingsOpen } =
  await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

it("Settings with an unsaved room edit: an agent's settings button asks first, and drills Settings into the agent only on Discard", async () => {
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
    settings: true,
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
