// Which section and whose form the Agent settings page shows (task
// 59538509). A door that names no section opens it on Engine (Nil,
// 2026-11-16), as the doors about the model do. Each agent gets its own form,
// and an update to the agent keeps the member's edit. Where the page shows
// and what Close returns to are in ui/App.agent-settings-page.dom.test.tsx;
// the guards in ui/App.agent-settings-page-guards.dom.test.tsx; the setup in
// ui/test-support/agent-settings-page-fixture.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  boot,
  click,
  openFirstDesk,
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
  openSection,
  pageAgent,
  prompt,
  settingsButton,
  typeName,
} = await import("./test-support/agent-settings-page-fixture.ts");

setUpChatSidebarTests();

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
  await openSection(view, "general");
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
  await openSection(view, "general");
  expect(nameInput(view)?.value).toBe(scout.name);

  await click(settingsButton(view, ranger.id));
  await openSection(view, "general");
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
  expect(prompt(view)).toBeNull();
  await openSection(view, "general");
  expect({ page: pageAgent(view), name: nameInput(view)?.value }).toEqual({
    page: scout.id,
    name: scout.name,
  });
});
