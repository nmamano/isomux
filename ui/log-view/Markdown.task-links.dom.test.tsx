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
  // The text node holds the id alone, so find and copy see the id; the
  // priority and title are a visual suffix in an attribute.
  expect(chip.textContent).toBe(task.id);
  expect(chip.getAttribute("data-task-label")).toBe(
    " P0: Task hashes open the…",
  );
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

// A task id inside a file path stays text (task 64cbacee): Nil's phone showed
// "~/nil/isomux-media/<id>/" with a chip in the middle of the path. The run of
// non-whitespace around the id decides, also when marked splits that run into
// tokens before the id (a code span, strong, emphasis or a backslash).
const ID = task.id;
const PATH_IDS = [
  `~/nil/isomux-media/${ID}/`,
  `(~/nil/isomux-media/${ID}/)`,
  `/tmp/t-${ID}`,
  `C:\\Users\\${ID}`,
  `\`code\`/${ID}`,
  `**x**/${ID}`,
  `a/*b*/${ID}`,
];
const PROSE_IDS = [`${ID},`, `(${ID})`, `t-${ID}`, `${ID}.`];

for (const text of PATH_IDS) {
  it(`keeps a task id in a path as text: ${text}`, () => {
    const md = render(
      <Markdown
        content={`See ${text} now.`}
        tasks={new Map([[task.id, task]])}
        onOpenTask={() => {}}
      />,
    );
    // No placeholder either, so the id is never tried as an ask.
    expect(md.container.querySelectorAll("[data-chip-id]").length).toBe(0);
    expect(md.container.textContent?.includes(ID)).toBe(true);
    md.unmount();
    const plain = render(
      <PlainTaskText
        content={`See ${text} now.`}
        tasks={new Map([[task.id, task]])}
        onOpen={() => {}}
      />,
    );
    expect(plain.container.querySelectorAll(".task-id-chip").length).toBe(0);
    expect(plain.container.textContent).toBe(`See ${text} now.`);
  });
}

for (const text of PROSE_IDS) {
  it(`still chips a task id in prose: ${text}`, () => {
    const md = render(
      <Markdown
        content={`See ${text} now.`}
        tasks={new Map([[task.id, task]])}
        onOpenTask={() => {}}
      />,
    );
    expect(md.container.querySelectorAll(".task-id-chip").length).toBe(1);
    md.unmount();
    const plain = render(
      <PlainTaskText
        content={`See ${text} now.`}
        tasks={new Map([[task.id, task]])}
        onOpen={() => {}}
      />,
    );
    expect(plain.container.querySelectorAll(".task-id-chip").length).toBe(1);
  });
}

it("chips the id in prose and not the same id in a path, in one message", () => {
  const content = `Saved to ~/nil/isomux-media/${ID}/ for ${ID}.`;
  const md = render(
    <Markdown
      content={content}
      tasks={new Map([[task.id, task]])}
      onOpenTask={() => {}}
    />,
  );
  expect(md.container.querySelectorAll(".task-id-chip").length).toBe(1);
  // The chip is the last id: the path keeps its own text.
  expect(md.container.textContent?.trimEnd()).toBe(content);
  expect(
    md.container.querySelector(".task-id-chip")?.previousSibling?.textContent,
  ).toBe(`Saved to ~/nil/isomux-media/${ID}/ for `);
  md.unmount();
  const plain = render(
    <PlainTaskText
      content={content}
      tasks={new Map([[task.id, task]])}
      onOpen={() => {}}
    />,
  );
  expect(plain.container.querySelectorAll(".task-id-chip").length).toBe(1);
  expect(
    plain.container.querySelector(".task-id-chip")?.previousSibling
      ?.textContent,
  ).toBe(`Saved to ~/nil/isomux-media/${ID}/ for `);
});

// The path check must stay linear in the message length (task 64cbacee
// review). Ids joined with no whitespace make one long run: a check that
// walks the run once per id is quadratic, and Markdown repeats the scan for
// each token, so 400 ids froze the render for seconds. A linear render takes
// a few tens of ms here; marked itself is slow on long runs, so the Markdown
// case keeps its run short.
const hexIds = (n: number) =>
  Array.from({ length: n }, (_, i) => (0x10000000 + i).toString(16));

it("renders a long run of comma-joined ids in linear time in Markdown", () => {
  const content = `ids: ${hexIds(400).join(",")} end`;
  const started = performance.now();
  const view = render(
    <Markdown content={content} tasks={new Map()} onOpenTask={() => {}} />,
  );
  const elapsed = performance.now() - started;
  // The ids are prose, so each one is still a placeholder.
  expect(view.container.querySelectorAll("[data-chip-id]").length).toBe(400);
  expect(elapsed).toBeLessThan(1000);
});

it("renders a long run of comma-joined ids in linear time in a user bubble", () => {
  const content = `ids: ${hexIds(1000)
    .map((id) => `${id},${"z".repeat(100)},`)
    .join("")} end`;
  const first = hexIds(1)[0];
  const started = performance.now();
  const view = render(
    <PlainTaskText
      content={content}
      tasks={new Map([[first, { ...task, id: first }]])}
      onOpen={() => {}}
    />,
  );
  const elapsed = performance.now() - started;
  expect(view.container.querySelectorAll(".task-id-chip").length).toBe(1);
  expect(view.container.textContent).toBe(content);
  expect(elapsed).toBeLessThan(1000);
});
