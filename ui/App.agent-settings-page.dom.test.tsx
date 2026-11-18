// An agent's settings open as a full page in the view's place (task 59538509),
// not as a dialog over it. On a desktop the chat sidebar stays beside the
// page; Close (and Escape) return to the view the page opened over. On a
// phone the page fills the screen. Which section and whose form the page
// shows are in ui/App.agent-settings-page-form.dom.test.tsx; the guards
// (unsaved edits, the page keys, Back, Escape over a menu) in
// ui/App.agent-settings-page-guards.dom.test.tsx and
// ui/App.agent-settings-page-escape.dom.test.tsx; the page itself in
// ui/components/AgentSettingsPage.dom.test.tsx; the setup in
// ui/test-support/agent-settings-page-fixture.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  boot,
  bootPhone,
  chatOpen,
  click,
  currentRows,
  openFirstDesk,
  press,
  scout,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
const {
  currentSection,
  headerName,
  navSettingsLit,
  settingsOpen,
  pageAgent,
  shows,
} = await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

it("the chat header's name opens Settings drilled into the agent in the chat's place, the nav lights Settings, the sidebar stays; Close returns to the same chat", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(headerName(view));
  expect({
    ...shows(view),
    // Not the dialog over the chat.
    dialog:
      view.baseElement.querySelector(".edit-agent-dialog-desktop") !== null,
    section: currentSection(view),
    // The page is Settings drilled into the agent (task 1f79f2e3).
    settings: settingsOpen(view),
    nav: navSettingsLit(view),
  }).toEqual({
    page: scout.id,
    chat: false,
    sidebar: true,
    dialog: false,
    section: "engine",
    settings: true,
    nav: true,
  });
  await click(view.baseElement.querySelector("[data-page-close]"));
  expect({
    ...shows(view),
    rows: currentRows(view),
    settings: settingsOpen(view),
  }).toEqual({
    page: null,
    chat: true,
    sidebar: true,
    rows: [scout.id],
    settings: false,
  });
});

it("Escape closes the page and the chat under it stays open", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(headerName(view));
  expect(pageAgent(view)).toBe(scout.id);
  await press("Escape");
  expect({ ...shows(view), rows: currentRows(view) }).toEqual({
    page: null,
    chat: true,
    sidebar: true,
    rows: [scout.id],
  });
});

it("on a phone the page fills the screen with the section list first; Close returns to the chat", async () => {
  const view = await bootPhone();
  await openFirstDesk(view);
  await click(headerName(view));
  const sections = [
    ...view.baseElement.querySelectorAll("button[data-settings-part]"),
  ].map((el) => el.getAttribute("data-settings-part"));
  expect({
    page: pageAgent(view),
    chat: chatOpen(view),
    sections,
    current: currentSection(view),
  }).toEqual({
    page: scout.id,
    chat: false,
    sections: ["general", "access", "instructions", "engine"],
    current: null,
  });
  await click(view.baseElement.querySelector("[data-page-close]"));
  expect({ page: pageAgent(view), chat: chatOpen(view) }).toEqual({
    page: null,
    chat: true,
  });
});
