// Ask ids in chat text (task 84aadfab): with an AskRefs value, Markdown and
// the user bubble's PlainTaskText chip an 8-hex id that is not a task but
// resolves to an ask. The value here is a stand-in for App's; App's own value
// (the store first, then GET /api/asks/<id>) is in ui/App.ask-chips.dom.test.tsx.

import { expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { PlainTaskText } = await import("./task-links.tsx");
const { AskRefs } = await import("./ask-refs.tsx");
type AskRefsValue = import("./ask-refs.tsx").AskRefsValue;
type ResolvedAsk = import("./ask-refs.tsx").ResolvedAsk;
type TaskItem = import("../../shared/types.ts").TaskItem;
type ReactNode = import("react").ReactNode;

const ASK: ResolvedAsk = {
  id: "a6b624d3",
  agentId: "a1",
  prompt: "Deploy the new build now?\nThe tests are green.",
  closed: false,
};

const task = {
  id: "ce5e7fe0",
  title: "Task hashes open the correct board detail",
  priority: "P0",
  status: "in_progress",
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r1",
} as TaskItem;

// A stand-in for App's value: `known` answers resolve, everything else is
// not known yet.
function refs(
  known: Record<string, ResolvedAsk | null>,
  version = 0,
): AskRefsValue & {
  request: ReturnType<typeof mock>;
  open: ReturnType<typeof mock>;
} {
  return {
    resolve: (id: string) => (id in known ? known[id] : undefined),
    request: mock(() => {}),
    open: mock(() => {}),
    version,
  };
}

const withRefs = (value: AskRefsValue | null, children: ReactNode) => (
  <AskRefs.Provider value={value}>{children}</AskRefs.Provider>
);

const requested = (value: ReturnType<typeof refs>) =>
  new Set(
    value.request.mock.calls.flatMap((call) => [...(call[0] as string[])]),
  );

const askChips = (root: HTMLElement) =>
  root.querySelectorAll<HTMLButtonElement>("button[data-ask-chip]");

it("chips an id that resolves to an ask in Markdown text; a click opens the ask, not a task", () => {
  const onOpenTask = mock(() => {});
  const value = refs({ [ASK.id]: ASK });
  const view = render(
    withRefs(
      value,
      <Markdown
        content={`See ${ASK.id} first.`}
        tasks={new Map()}
        onOpenTask={onOpenTask}
      />,
    ),
  );
  const chips = askChips(view.container);
  expect(chips.length).toBe(1);
  const chip = chips[0];
  expect(chip.getAttribute("data-ask-chip")).toBe(ASK.id);
  expect(chip.classList.contains("task-id-chip")).toBe(true);
  expect(chip.hasAttribute("data-task-id")).toBe(false);
  // The id alone is the text, so find and copy see the id; the prompt's
  // first line is the title, and its first words the visual suffix.
  expect(chip.textContent).toBe(ASK.id);
  expect(chip.getAttribute("title")).toBe("Deploy the new build now?");
  const label = chip.getAttribute("data-task-label") ?? "";
  expect(label).toContain("Deploy the new build");
  expect(label).not.toContain("now?");
  expect(label).not.toContain("tests");
  fireEvent.click(chip);
  expect(value.open).toHaveBeenCalledWith(ASK.id);
  expect(onOpenTask).not.toHaveBeenCalled();
});

it("asks for an unknown id and chips it once it resolves, on the same message", () => {
  const first = refs({});
  const view = render(
    withRefs(
      first,
      <Markdown
        content={`See ${ASK.id}.`}
        tasks={new Map()}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(requested(first).has(ASK.id)).toBe(true);
  expect(askChips(view.container).length).toBe(0);
  expect(view.container.textContent).toContain(ASK.id);

  const resolved = refs({ [ASK.id]: ASK }, 1);
  view.rerender(
    withRefs(
      resolved,
      <Markdown
        content={`See ${ASK.id}.`}
        tasks={new Map()}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(askChips(view.container).length).toBe(1);
});

it("leaves an id that is no ask as plain text", () => {
  const value = refs({ [ASK.id]: null });
  const view = render(
    withRefs(
      value,
      <Markdown
        content={`See ${ASK.id}.`}
        tasks={new Map()}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(view.container.querySelector("button")).toBeNull();
  expect(view.container.textContent).toContain(ASK.id);
});

it("lets a task win over an ask with the same id, and never asks about a task's id", () => {
  const value = refs({ [task.id]: { ...ASK, id: task.id } });
  const view = render(
    withRefs(
      value,
      <Markdown
        content={`See ${task.id}.`}
        tasks={new Map([[task.id, task]])}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(askChips(view.container).length).toBe(0);
  expect(
    view.container.querySelector(`button[data-task-id="${task.id}"]`),
  ).not.toBeNull();
  expect(requested(value).has(task.id)).toBe(false);

  // With no task opener the task's id is plain text, still never an ask.
  const noOpener = refs({ [task.id]: { ...ASK, id: task.id } });
  const plain = render(
    withRefs(
      noOpener,
      <Markdown
        content={`See ${task.id}.`}
        tasks={new Map([[task.id, task]])}
      />,
    ),
  );
  expect(plain.container.querySelector("button")).toBeNull();
  expect(plain.container.textContent).toContain(task.id);
  expect(requested(noOpener).has(task.id)).toBe(false);
});

it("keeps ids in code, link text and long hashes literal, and asks about none of them", () => {
  const forty = "a6b624d31234567890abcdef1234567890abcdef";
  const value = refs({ [ASK.id]: ASK });
  const view = render(
    withRefs(
      value,
      <Markdown
        content={`\`${ASK.id}\` [${ASK.id}](https://example.com) ${forty}`}
        tasks={new Map()}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(askChips(view.container).length).toBe(0);
  expect(view.container.querySelector("code")?.textContent).toBe(ASK.id);
  expect(view.getByRole("link").textContent).toBe(ASK.id);
  expect(view.container.textContent).toContain(forty);
  expect(requested(value).size).toBe(0);
});

// Each chip is revisited when what it shows changes: an ask chip whose id
// becomes a task's turns into the task chip, and one that no longer
// resolves goes back to plain text.
it("turns an ask chip into a task chip, or back into text, as the id's meaning changes", () => {
  const md = (value: AskRefsValue, tasks: Map<string, TaskItem>) =>
    withRefs(
      value,
      <Markdown
        content={`See ${ASK.id}.`}
        tasks={tasks}
        onOpenTask={() => {}}
      />,
    );
  const view = render(md(refs({ [ASK.id]: ASK }), new Map()));
  expect(askChips(view.container).length).toBe(1);

  const asTask = { ...task, id: ASK.id };
  view.rerender(md(refs({ [ASK.id]: ASK }, 1), new Map([[ASK.id, asTask]])));
  expect(askChips(view.container).length).toBe(0);
  expect(
    view.container.querySelector(`button[data-task-id="${ASK.id}"]`),
  ).not.toBeNull();

  view.rerender(md(refs({ [ASK.id]: ASK }, 2), new Map()));
  expect(askChips(view.container).length).toBe(1);

  view.rerender(md(refs({ [ASK.id]: null }, 3), new Map()));
  expect(view.container.querySelector("button")).toBeNull();
  expect(view.container.textContent).toContain(`See ${ASK.id}.`);
});

it("keeps every id plain with no AskRefs value, as task ids are with no opener", () => {
  const view = render(
    withRefs(
      null,
      <Markdown
        content={`See ${ASK.id}.`}
        tasks={new Map()}
        onOpenTask={() => {}}
      />,
    ),
  );
  expect(view.container.querySelector("button")).toBeNull();
  expect(view.container.textContent).toContain(ASK.id);
});

it("chips an ask id in a user bubble once it resolves; a click opens the ask", () => {
  const content = `Check ${ASK.id} and \`${ASK.id}\` and ${task.id}`;
  const first = refs({});
  const onOpenTask = mock(() => {});
  const view = render(
    withRefs(
      first,
      <PlainTaskText
        content={content}
        tasks={new Map([[task.id, task]])}
        onOpen={onOpenTask}
      />,
    ),
  );
  expect(askChips(view.container).length).toBe(0);
  expect(requested(first).has(ASK.id)).toBe(true);
  expect(requested(first).has(task.id)).toBe(false);

  const resolved = refs({ [ASK.id]: ASK }, 1);
  view.rerender(
    withRefs(
      resolved,
      <PlainTaskText
        content={content}
        tasks={new Map([[task.id, task]])}
        onOpen={onOpenTask}
      />,
    ),
  );
  const chips = askChips(view.container);
  expect(chips.length).toBe(1);
  expect(chips[0].textContent).toBe(ASK.id);
  // The code span stays literal, backticks and all; the task keeps its chip.
  expect(view.container.textContent).toContain(`\`${ASK.id}\``);
  expect(
    view.container.querySelector(`button[data-task-id="${task.id}"]`),
  ).not.toBeNull();
  fireEvent.click(chips[0]);
  expect(resolved.open).toHaveBeenCalledWith(ASK.id);
  expect(onOpenTask).not.toHaveBeenCalled();
});

// A chip's title and label are plain text (task b2f055c6): the prompt's
// inline markup (colour, bold, code, a link) gives its text only, in
// Markdown and in a user bubble alike, and the label's first words are
// counted on that text.
it("draws a marked-up prompt's title and label as its plain text, in Markdown and in a user bubble", () => {
  const marked: ResolvedAsk = {
    ...ASK,
    prompt:
      ":blue[**Quick action**] Run `bun test` on [main](https://example.com) now?\nThe tests are green.",
  };
  const value = refs({ [ASK.id]: marked });
  const content = `See ${ASK.id} first.`;
  for (const surface of [
    <Markdown content={content} tasks={new Map()} onOpenTask={() => {}} />,
    <PlainTaskText content={content} tasks={new Map()} onOpen={() => {}} />,
  ]) {
    const view = render(withRefs(value, surface));
    const chips = askChips(view.container);
    expect(chips.length).toBe(1);
    const label = chips[0].getAttribute("data-task-label") ?? "";
    expect({
      title: chips[0].getAttribute("title"),
      words: label.includes("Quick action Run bun"),
      past: label.includes("test"),
      raw: /:blue\[|\*\*|`|\]\(/.test(label),
    }).toEqual({
      title: "Quick action Run bun test on main now?",
      words: true,
      past: false,
      raw: false,
    });
    view.unmount();
  }
});
