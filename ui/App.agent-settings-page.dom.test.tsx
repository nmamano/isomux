// An agent's settings open as a full page in the view's place (task 59538509),
// not as a dialog over it. On a desktop the chat sidebar stays beside the
// page; Close (and Escape) return to the view the page opened over. The
// doors about the model open it on Engine. Each agent gets its own form. The
// guards (unsaved edits, the page keys, Back, Escape over a menu) are in
// ui/App.agent-settings-page-guards.dom.test.tsx; the page itself in
// ui/components/AgentSettingsPage.dom.test.tsx; the setup in
// ui/test-support/agent-settings-page-fixture.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  boot,
  bootPhone,
  chatOpen,
  click,
  currentRows,
  openFirstDesk,
  press,
  ranger,
  scout,
  setAgents,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
const {
  currentSection,
  discard,
  headerName,
  nameInput,
  openRoom,
  pageAgent,
  prompt,
  settingsButton,
  shows,
  typeName,
} = await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

it("the chat header's name opens the page in the chat's place with the sidebar kept; Close returns to the same chat", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(headerName(view));
  expect({
    ...shows(view),
    // Not the dialog over the chat.
    dialog:
      view.baseElement.querySelector(".edit-agent-dialog-desktop") !== null,
    section: currentSection(view),
  }).toEqual({
    page: scout.id,
    chat: false,
    sidebar: true,
    dialog: false,
    section: "profile",
  });
  await click(view.baseElement.querySelector("[data-page-close]"));
  expect({ ...shows(view), rows: currentRows(view) }).toEqual({
    page: null,
    chat: true,
    sidebar: true,
    rows: [scout.id],
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

it("the gone-model mark opens the page on Engine", async () => {
  setAgents([{ ...scout, goneModel: "opencode/removed" }, ranger]);
  const view = await boot();
  await openFirstDesk(view);
  await click(
    view.container.querySelector(".log-view-shell [data-gone-model]"),
  );
  expect({ page: pageAgent(view), section: currentSection(view) }).toEqual({
    page: scout.id,
    section: "engine",
  });
});

it("an update to the agent while the page shows keeps the page and the member's edit", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(headerName(view));
  await typeName(view, "Renamed");
  await act(async () => {
    shimEmit({
      type: "agent_updated",
      agentId: scout.id,
      changes: { state: "working", topic: "busy" },
    } as never);
  });
  expect({ page: pageAgent(view), name: nameInput(view)?.value }).toEqual({
    page: scout.id,
    name: "Renamed",
  });
});

it("another agent's settings button: a clean page moves to that agent's own form; an unsaved one asks first and moves only on Discard", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await openRoom(view, "r1");
  await click(settingsButton(view, scout.id));
  expect(nameInput(view)?.value).toBe(scout.name);

  await click(settingsButton(view, ranger.id));
  expect({ page: pageAgent(view), name: nameInput(view)?.value }).toEqual({
    page: ranger.id,
    name: ranger.name,
  });

  await typeName(view, "Unsaved");
  await click(settingsButton(view, scout.id));
  expect({
    page: pageAgent(view),
    name: nameInput(view)?.value,
    prompt: prompt(view) !== null,
  }).toEqual({ page: ranger.id, name: "Unsaved", prompt: true });
  await discard(view);
  expect({
    page: pageAgent(view),
    name: nameInput(view)?.value,
    prompt: prompt(view) !== null,
  }).toEqual({ page: scout.id, name: scout.name, prompt: false });
});

it("on a phone the page fills the screen with the section list first; Close returns to the chat", async () => {
  const view = await bootPhone();
  await openFirstDesk(view);
  await click(headerName(view));
  const sections = [
    ...view.baseElement.querySelectorAll("button[data-agent-settings-section]"),
  ].map((el) => el.getAttribute("data-agent-settings-section"));
  expect({
    page: pageAgent(view),
    chat: chatOpen(view),
    sections,
    current: currentSection(view),
  }).toEqual({
    page: scout.id,
    chat: false,
    sections: ["profile", "engine", "instructions", "access"],
    current: null,
  });
  await click(view.baseElement.querySelector("[data-page-close]"));
  expect({ page: pageAgent(view), chat: chatOpen(view) }).toEqual({
    page: null,
    chat: true,
  });
});
