import { createContext, useMemo, type ReactNode } from "react";
import { Lexer, defaults } from "marked";
import type { TaskItem } from "../../shared/types.ts";
import { noTranslate } from "../no-translate.ts";
import { AskIdText } from "./ask-refs.tsx";

export type TaskMap = ReadonlyMap<string, TaskItem>;

const TASK_ID_PATTERN = /\b[0-9a-f]{8}\b/g;

const TASK_ID_LENGTH = 8;
// How far the path check looks each way from an id. Bounded, so a long run
// of joined ids still renders in linear time.
export const PATH_REACH = 64;

/** True when the task id at index is part of a file path, not a reference
 * (task 64cbacee): a "/" or "\" in the same non-whitespace run, at most
 * PATH_REACH characters away. */
export function idInPath(text: string, index: number): boolean {
  const isSeparator = (char: string) => char === "/" || char === "\\";
  const isSpace = (char: string) => /\s/.test(char);
  for (let i = index - 1; i >= Math.max(0, index - PATH_REACH); i--) {
    if (isSpace(text[i])) break;
    if (isSeparator(text[i])) return true;
  }
  const end = index + TASK_ID_LENGTH;
  for (let i = end; i < Math.min(text.length, end + PATH_REACH); i++) {
    if (isSpace(text[i])) break;
    if (isSeparator(text[i])) return true;
  }
  return false;
}

/** The task id matches in text, minus ids inside a path. */
function taskIdMatches(text: string): RegExpExecArray[] {
  return [...text.matchAll(TASK_ID_PATTERN)].filter(
    (match) => !idInPath(text, match.index),
  );
}

// Opens a task on the board. App provides it; with no opener, ids stay plain
// text (ask prompts, AskPrompt).
export const TaskOpener = createContext<((id: string) => void) | null>(null);

export function taskChipLabel(task: TaskItem): string {
  const words = task.title.trim().split(/\s+/).filter(Boolean);
  const shortTitle = words.slice(0, 4).join(" ");
  const suffix = words.length > 4 ? "…" : "";
  const head = task.priority ? `${task.id} ${task.priority}` : task.id;
  return `${head}: ${shortTitle}${suffix}`;
}

export function taskChipSuffix(task: TaskItem): string {
  return taskChipLabel(task).slice(task.id.length);
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
      {...noTranslate("task-id-chip")}
      title={task.title}
      data-chip-id={task.id}
      aria-label={taskChipLabel(task)}
      data-task-id={task.id}
      data-task-label={taskChipSuffix(task)}
      onClick={() => onOpen(task.id)}
    >
      {task.id}
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
  for (const match of taskIdMatches(text)) {
    const index = match.index;
    const id = match[0];
    const task = tasks.get(id);
    if (index > cursor) nodes.push(text.slice(cursor, index));
    // An id that is no task may be an ask (AskIdText, ask-refs.tsx).
    nodes.push(
      task ? (
        <TaskChip key={`${keyPrefix}-${index}`} task={task} onOpen={onOpen} />
      ) : (
        <AskIdText key={`${keyPrefix}-${index}`} id={id} />
      ),
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
