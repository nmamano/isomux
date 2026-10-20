// Task-board rules shared by the server and the UI.

import type { AgentInfo, TaskItem } from "./types.ts";
import { versionOf } from "./blob-version.ts";

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
