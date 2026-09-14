import { expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { PlainTaskText } = await import("./task-links.tsx");
type TaskItem = import("../../shared/types.ts").TaskItem;

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

it("chips only visible lowercase task ids in Markdown text", () => {
  const onOpenTask = mock(() => {});
  const forty = "ce5e7fe01234567890abcdef1234567890abcdef";
  const view = render(
    <Markdown
      content={`ce5e7fe0 CE5E7FE0 deadbeef ${forty} \`ce5e7fe0\` [ce5e7fe0](https://example.com)`}
      tasks={new Map([[task.id, task]])}
      onOpenTask={onOpenTask}
    />,
  );
  const chip = view.getByRole("button", {
    name: "ce5e7fe0 P0: Task hashes open the…",
  });
  expect(chip.getAttribute("title")).toBe(task.title);
  expect(view.container.querySelectorAll(".task-id-chip").length).toBe(1);
  expect(view.container.querySelector("code")?.textContent).toBe(task.id);
  expect(view.getByRole("link").textContent).toBe(task.id);
  expect(view.container.textContent?.includes("deadbeef")).toBe(true);
  expect(view.container.textContent?.includes(forty)).toBe(true);
  fireEvent.click(chip);
  expect(onOpenTask).toHaveBeenCalledWith(task.id);
});

it("updates a chip from the live task map without rebuilding the message", () => {
  const onOpenTask = mock(() => {});
  const view = render(
    <Markdown
      content={task.id}
      tasks={new Map([[task.id, task]])}
      onOpenTask={onOpenTask}
    />,
  );
  view.rerender(
    <Markdown
      content={task.id}
      tasks={
        new Map([[task.id, { ...task, priority: "P1", title: "Renamed task" }]])
      }
      onOpenTask={onOpenTask}
    />,
  );
  expect(view.getByRole("button").getAttribute("aria-label")).toBe(
    "ce5e7fe0 P1: Renamed task",
  );
});

it("keeps the task id in the text node and the visual suffix in an attribute", () => {
  const view = render(
    <Markdown
      content={`before ${task.id} after`}
      tasks={new Map([[task.id, task]])}
      onOpenTask={() => {}}
    />,
  );
  const chip = view.getByRole("button");
  expect(chip.textContent).toBe(task.id);
  expect(chip.getAttribute("data-task-label")).toBe(
    " P0: Task hashes open the…",
  );
});

it("keeps code, links, long hashes, and unknown ids literal in user messages", () => {
  const forty = "ce5e7fe01234567890abcdef1234567890abcdef";
  const view = render(
    <PlainTaskText
      content={`ce5e7fe0 deadbeef ${forty} \`ce5e7fe0\` [ce5e7fe0](https://example.com)`}
      tasks={new Map([[task.id, task]])}
      onOpen={() => {}}
    />,
  );
  expect(view.container.querySelectorAll(".task-id-chip").length).toBe(1);
  const chip = view.getByRole("button");
  expect(chip.textContent).toBe(task.id);
  expect(chip.getAttribute("data-task-label")).toBe(
    " P0: Task hashes open the…",
  );
  expect(view.container.textContent?.includes("deadbeef")).toBe(true);
  expect(view.container.textContent?.includes(forty)).toBe(true);
  expect(view.container.textContent?.includes("`ce5e7fe0`")).toBe(true);
  expect(
    view.container.textContent?.includes("[ce5e7fe0](https://example.com)"),
  ).toBe(true);
});

for (const content of [
  "ce5e7fe01234567890abcdef1234567890abcdef",
  "ce5e7fe01234567890abcdef1234567890abcdef trailing words",
]) {
  it(`does not chip a 40-character hash at the message start: ${content}`, () => {
    const view = render(
      <Markdown
        content={content}
        tasks={new Map([[task.id, task]])}
        onOpenTask={() => {}}
      />,
    );
    expect(view.container.querySelectorAll(".task-id-chip").length).toBe(0);
  });
}
