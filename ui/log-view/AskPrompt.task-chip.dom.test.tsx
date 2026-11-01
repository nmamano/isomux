// Task chips in an ask prompt (task 43574c2c): the chat's TaskChip, for the
// tasks in the store, when App provides the opener. Code spans and link text
// stay literal, as in the chat (ui/log-view/Markdown.task-links.dom.test.tsx).
// The click through the real App and Inbox is in
// ui/App.inbox-task-chip.dom.test.tsx.

import { expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { AskPrompt } = await import("./AskPrompt.tsx");
const { InlineMarkdown } = await import("../members-chat/InlineMarkdown.tsx");
const { TaskOpener } = await import("./task-links.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
type TaskItem = import("../../shared/types.ts").TaskItem;
type ReactNode = import("react").ReactNode;

const task = (id: string, title: string): TaskItem =>
  ({
    id,
    title,
    priority: "P1",
    status: "open",
    createdBy: "Nil",
    username: "Nil",
    createdAt: 1,
    roomId: "r1",
  }) as TaskItem;

const VISIBLE = task("ce5e7fe0", "Inbox chips open the task");
const OTHER = task("0a1b2c3d", "A second task in bold");
// deadbeef is a task the member cannot see: the store does not carry it.
const PROMPT = [
  `Merge ${VISIBLE.id} now? **Also ${OTHER.id}**.`,
  `Not \`${VISIBLE.id}\`, not [see ${VISIBLE.id}](https://example.com/x),`,
  "and not deadbeef.",
].join(" ");
// What the reader sees: the markdown syntax gone, every id kept once (a chip's
// text is its id; the label is CSS).
const SHOWN = [
  `Merge ${VISIBLE.id} now? Also ${OTHER.id}.`,
  `Not ${VISIBLE.id}, not see ${VISIBLE.id},`,
  "and not deadbeef.",
].join(" ");

function withState(children: ReactNode, opener?: (id: string) => void) {
  const state = { ...initialState, tasks: [VISIBLE, OTHER], tasksLoaded: true };
  const inner = createElement(StateCtx.Provider, { value: state }, children);
  return opener
    ? createElement(TaskOpener.Provider, { value: opener }, inner)
    : inner;
}

const chipIds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(".task-id-chip")].map(
    (chip) => chip.dataset.taskId,
  );

it("draws the store's tasks as chips that open the task, and leaves code, link text and unknown ids plain", async () => {
  const open = mock((_id: string) => {});
  const view = render(
    withState(createElement(AskPrompt, { content: PROMPT }), open),
  );
  const root = view.container;

  expect(chipIds(root)).toEqual([VISIBLE.id, OTHER.id]);
  // The chat's chip: a button labelled with the task, its id as text.
  const chip = root.querySelector<HTMLButtonElement>(
    `button.task-id-chip[data-task-id="${VISIBLE.id}"]`,
  )!;
  expect(chip.getAttribute("aria-label")?.startsWith(`${VISIBLE.id} P1:`)).toBe(
    true,
  );
  expect(root.querySelector("strong .task-id-chip") !== null).toBe(true);
  expect(root.querySelector("code")?.textContent).toBe(VISIBLE.id);
  expect(root.querySelector("a")?.querySelector("button")).toBeNull();
  expect(root.textContent).toBe(SHOWN);

  await act(async () => fireEvent.click(chip));
  expect(open.mock.calls).toEqual([[VISIBLE.id]]);
});

it("keeps every id plain without an opener, and in inline markdown that is not an ask prompt", () => {
  const bare = render(withState(createElement(AskPrompt, { content: PROMPT })));
  expect(bare.container.querySelector("button")).toBeNull();
  expect(bare.container.textContent).toBe(SHOWN);

  // The members chat draws InlineMarkdown with no task props, inside App's
  // opener.
  const chat = render(
    withState(
      createElement(InlineMarkdown, { content: `Merge ${VISIBLE.id} now?` }),
      () => {},
    ),
  );
  expect(chat.container.querySelector("button")).toBeNull();
});
