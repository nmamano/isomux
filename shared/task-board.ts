// Task-board rules shared by the server and the UI.

import type { AgentInfo, TaskItem } from "./types.ts";
import { versionOf } from "./blob-version.ts";

// The office socket's query flag that asks for the summary task board (task
// 9ebe887d): the tasks frame then carries open and in-progress tasks with no
// description, and a client fetches the rest over GET /api/tasks. A socket
// without the flag gets the whole board, so a tab loaded before this change
// never sees a row with its description stripped.
export const TASKS_SUMMARY_WS_PARAM = "tasks";
export const TASKS_SUMMARY_WS_VALUE = "summary";

// The most distinct ids one GET /api/tasks?ids= may name.
export const MAX_TASK_IDS_PER_LOOKUP = 100;

// A closed task is done or obsolete.
export function isClosedTask(t: Pick<TaskItem, "status">) {
  return t.status === "done" || t.status === "obsolete";
}

// The default list (GET /api/tasks with no status, and the office's task
// count) leaves out closed tasks and open P4 tasks, the old backlog. An
// in-progress P4 task stays in, as a claimed backlog task left the backlog.
export function inDefaultTaskList(t: Pick<TaskItem, "status" | "priority">) {
  return !isClosedTask(t) && !(t.status === "open" && t.priority === "P4");
}

// A task's optimistic-concurrency token (task 4243ecc0): versionOf() over the
// task's fields in a fixed order, the same hash the room-prompt and
// custom-instructions guards use. Every write changes it unless the write
// leaves the task as it was.
export function taskVersion(task: Omit<TaskItem, "version">): string {
  return versionOf(
    JSON.stringify([
      task.id,
      task.title,
      task.description ?? null,
      task.priority ?? null,
      task.status,
      task.assignee ?? null,
      task.createdBy,
      task.username ?? null,
      task.createdAt,
      task.roomId ?? null,
      // The agent ids (task 83f71be9) join the hash only when a row has one,
      // so a row written before them keeps the version it had.
      ...(task.assigneeAgentId || task.createdByAgentId
        ? [task.assigneeAgentId ?? null, task.createdByAgentId ?? null]
        : []),
      // The GitHub block (task 7fc83592) joins the same way, so a sync write
      // moves the version and older rows keep theirs.
      ...(task.external
        ? [
            task.external.provider,
            task.external.repo,
            task.external.number,
            task.external.url,
            task.external.state,
            task.external.stateReason,
          ]
        : []),
    ]),
  );
}

// The live agent a task name names (task 83f71be9): a case-insensitive match
// on the trimmed name, or undefined when no live agent has it.
export function agentIdForName(
  name: string | undefined,
  agents: Pick<AgentInfo, "id" | "name">[],
): string | undefined {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return undefined;
  return agents.find((a) => a.name.trim().toLowerCase() === wanted)?.id;
}
