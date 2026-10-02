// Task-board rules shared by the server and the UI.

import type { TaskItem } from "./types.ts";
import { versionOf } from "./blob-version.ts";

// The default list (GET /api/tasks with no status, and the board's Active
// filter) leaves out done tasks and open P4 tasks, the old backlog. An
// in-progress P4 task stays in, as a claimed backlog task left the backlog.
export function inDefaultTaskList(t: Pick<TaskItem, "status" | "priority">) {
  return t.status !== "done" && !(t.status === "open" && t.priority === "P4");
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
    ]),
  );
}
