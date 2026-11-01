// A task chip in an Inbox ask (task 43574c2c), through the real App and
// store: it opens the task on the Tasks page over the Inbox, and Back returns
// to the Asks tab. What a prompt chips and what it leaves plain is in
// ui/log-view/AskPrompt.task-chip.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { ask, boot, go, inboxButton, selectedTab, setAsks, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type TaskItem = import("../shared/types.ts").TaskItem;

setUpInboxTests();

const task = {
  id: "ce5e7fe0",
  title: "Inbox chips open the task",
  priority: "P1",
  status: "open",
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
} as TaskItem;

it("opens an ask's task chip on the Tasks page over the Inbox, and Back returns to the Asks tab", async () => {
  setAsks([{ ...ask("q1", "a1"), prompt: `Merge ${task.id} now?` }]);
  const view = await boot();
  await act(async () => shimEmit({ type: "tasks", tasks: [task] } as never));
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");

  const chip = view.container.querySelector<HTMLButtonElement>(
    `[data-ask="q1"] button.task-id-chip[data-task-id="${task.id}"]`,
  );
  expect(chip).not.toBeNull();
  await act(async () => fireEvent.click(chip!));
  expect(window.location.pathname).toBe("/tasks");
  // The task's detail is open.
  expect(
    view.container.querySelector(`input[value="${task.title}"]`) !== null,
  ).toBe(true);

  await go("back");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelector('[data-ask="q1"]') !== null).toBe(true);
});
