// Task 62a7fe97. A background agent's final report rides on its settle
// breadcrumb (metadata.taskEvent.report). The line stays one line until the
// member opens it; open, the report renders as Markdown. A breadcrumb with no
// report is plain text, not a control.
import { expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type TaskItem = import("../../shared/types.ts").TaskItem;

const LABEL = "agent settled: Audit the codebase";
const REPORT = "**Verdict:** fine.\n\n- first point\n- second point";

function renderBreadcrumb(taskEvent: Record<string, unknown>) {
  return render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "crumb",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content: LABEL,
          metadata: { taskEvent },
        }}
      />,
    ),
  );
}

it("opens a background agent's report from its breadcrumb, as Markdown", () => {
  const view = renderBreadcrumb({
    taskId: "a1",
    phase: "completed",
    report: REPORT,
  });
  const buttons = view.container.querySelectorAll("button");
  expect(buttons.length).toBe(1);
  const button = buttons[0];
  expect(button.textContent).toContain(LABEL);
  // Closed by default: the report is not in the chat yet.
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(view.container.textContent).not.toContain("first point");

  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const strong = view.container.querySelector("strong");
  expect(strong?.textContent).toBe("Verdict:");
  const items = [...view.container.querySelectorAll("li")].map(
    (li) => li.textContent,
  );
  expect(items).toEqual(["first point", "second point"]);
  // Rendered, not shown as source.
  expect(view.container.textContent).not.toContain("**");

  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(view.container.textContent).not.toContain("first point");
  view.unmount();
});

it("keeps a breadcrumb without a report as plain text", () => {
  for (const taskEvent of [
    { taskId: "b1", phase: "completed" },
    { taskId: "b1", phase: "completed", report: "" },
  ]) {
    const view = renderBreadcrumb(taskEvent);
    expect(view.container.textContent).toContain(LABEL);
    expect(view.container.querySelectorAll("button").length).toBe(0);
    expect(view.container.querySelectorAll("[aria-expanded]").length).toBe(0);
    view.unmount();
  }
});

// Until this task the report rendered as the agent's message, where a task id
// is a chip that opens the task. The report keeps that.
it("chips the task ids in an opened report", () => {
  const task = {
    id: "ce5e7fe0",
    title: "A task the report names",
    priority: "P1",
    status: "open",
    createdBy: "Nil",
    username: "Nil",
    createdAt: 1,
    roomId: "r1",
  } as TaskItem;
  const onOpenTask = mock(() => {});
  const view = render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "crumb",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content: LABEL,
          metadata: {
            taskEvent: {
              taskId: "a1",
              phase: "completed",
              report: `Filed ${task.id} for the rest.`,
            },
          },
        }}
        tasks={new Map([[task.id, task]])}
        onOpenTask={onOpenTask}
      />,
    ),
  );
  fireEvent.click(view.container.querySelector("button[aria-expanded]")!);
  // ENABLING CONDITION: the report is open.
  expect(view.container.textContent).toContain("for the rest");
  const chips = view.container.querySelectorAll(".task-id-chip");
  expect(chips.length).toBe(1);
  fireEvent.click(chips[0]);
  expect(onOpenTask).toHaveBeenCalledWith(task.id);
  view.unmount();
});
