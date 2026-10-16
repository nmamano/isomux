// Two pages stacked over an agent chat close top first (task d6c09d1c): t then
// s shows Settings over Tasks, and each way out closes Settings to Tasks, then
// Tasks to the chat, then Back goes to the office. The steps are in
// ui/test-support/over-chat-fixture.ts.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const {
  Harness,
  chatShowing,
  clickClose,
  expectBackToOffice,
  expectChatEntry,
  goBack,
  press,
  setUpOverChat,
} = await import("./test-support/over-chat-fixture.ts");
type View = import("./test-support/over-chat-fixture.ts").View;

setUpOverChat();

const tasksOpen = (view: View) =>
  view.baseElement.querySelector("[data-tasks-page]") !== null;
const settingsOpen = (view: View) =>
  view.baseElement.querySelector('[data-testid="settings-content"]') !== null;

async function settingsOverTasks(): Promise<View> {
  const view = render(createElement(Harness));
  expect(chatShowing(view)).toBe(true);
  await press("t");
  await press("s");
  expect(settingsOpen(view)).toBe(true);
  expect(window.location.pathname).toBe("/settings");
  return view;
}

function expectTasks(view: View): void {
  expect(settingsOpen(view)).toBe(false);
  expect(tasksOpen(view)).toBe(true);
  expect(window.location.pathname).toBe("/tasks");
  expect(window.history.state).toEqual({ isomux: true, page: "tasks" });
}

async function expectChatThenOffice(view: View): Promise<void> {
  expect(tasksOpen(view)).toBe(false);
  expectChatEntry(view);
  await expectBackToOffice(view);
  expect(tasksOpen(view)).toBe(false);
  expect(settingsOpen(view)).toBe(false);
}

describe("Settings over Tasks over a chat", () => {
  it("Escape closes Settings, then Tasks", async () => {
    const view = await settingsOverTasks();
    await press("Escape");
    expectTasks(view);
    await press("Escape");
    await expectChatThenOffice(view);
  });

  it("Close closes Settings, then Tasks", async () => {
    const view = await settingsOverTasks();
    await clickClose(view);
    expectTasks(view);
    await clickClose(view);
    await expectChatThenOffice(view);
  });

  it("Back closes Settings, then Tasks", async () => {
    const view = await settingsOverTasks();
    await goBack();
    expectTasks(view);
    await goBack();
    await expectChatThenOffice(view);
  });
});
