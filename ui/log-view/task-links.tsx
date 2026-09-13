import { useMemo, type ReactNode } from "react";
import { Lexer, defaults } from "marked";
import type { TaskItem } from "../../shared/types.ts";

export type TaskMap = ReadonlyMap<string, TaskItem>;

export const TASK_ID_PATTERN = /\b[0-9a-f]{8}\b/g;

export function taskChipLabel(task: TaskItem): string {
  const words = task.title.trim().split(/\s+/).filter(Boolean);
  const shortTitle = words.slice(0, 4).join(" ");
  const suffix = words.length > 4 ? "…" : "";
  return [task.id, task.priority ?? "", `${shortTitle}${suffix}`]
    .filter(Boolean)
    .join(" ");
}

export function TaskChip({
  task,
  onOpen,
}: {
  task: TaskItem;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="task-id-chip"
      title={task.title}
      data-task-id={task.id}
      onClick={() => onOpen(task.id)}
    >
      {taskChipLabel(task)}
    </button>
  );
}

export function renderTaskText(
  text: string,
  tasks: TaskMap,
  onOpen: (id: string) => void,
  keyPrefix = "task-text",
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TASK_ID_PATTERN)) {
    const index = match.index;
    const id = match[0];
    const task = tasks.get(id);
    if (!task) continue;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <TaskChip key={`${keyPrefix}-${index}`} task={task} onOpen={onOpen} />,
    );
    cursor = index + id.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Preserve the agent-log user bubble's literal text rendering while turning
 * only Markdown text tokens into task chips. Backticks and links stay literal. */
export function PlainTaskText({
  content,
  tasks,
  onOpen,
}: {
  content: string;
  tasks: TaskMap;
  onOpen: (id: string) => void;
}) {
  const nodes = useMemo(
    () =>
      Lexer.lexInline(content, { ...defaults, gfm: true, breaks: false }).map(
        (token, index) =>
          token.type === "text"
            ? renderTaskText(token.raw, tasks, onOpen, `plain-${index}`)
            : token.raw,
      ),
    [content, tasks, onOpen],
  );
  return <>{nodes}</>;
}
