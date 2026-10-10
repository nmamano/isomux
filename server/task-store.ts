// Task persistence stays on the server. The JSON backend keeps the existing
// array format; callers change one record through an instance-owned store.
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { TaskItem } from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

const TASKS_FILE = join(STATE_ROOT, "tasks.json");

// Returned without versions: OfficeState.setTasksDirect stamps them.
export function loadTasks(): Omit<TaskItem, "version">[] {
  try {
    if (!existsSync(TASKS_FILE)) return [];
    const records = JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as Array<
      Omit<TaskItem, "status" | "version"> & {
        status: TaskItem["status"] | "backlog";
        device?: string;
        version?: string;
      }
    >;
    // Migrate legacy `device` field → `username` (the field's actual semantics
    // has always been "the member's name").
    let migrated = 0;
    for (const r of records) {
      if (r.device !== undefined && r.username === undefined) {
        r.username = r.device;
        migrated++;
      }
      delete (r as { device?: unknown }).device;
    }
    if (migrated > 0) {
      console.log(
        `[migration] migrated ${migrated} task(s) from device → username`,
      );
    }
    // "backlog" stopped being a status in 2026-10 (task 77460aea): a backlog
    // task becomes an open P4 task. Written back at once, so the file holds
    // the new shape; a rerun finds nothing to change.
    let backlog = 0;
    for (const r of records) {
      delete r.version;
      if (r.status === "backlog") {
        r.status = "open";
        r.priority = "P4";
        backlog++;
      }
    }
    const tasks = records as Omit<TaskItem, "version">[];
    if (backlog > 0) {
      saveTasks(tasks);
      console.log(
        `[migration] migrated ${backlog} backlog task(s) to open + P4`,
      );
    }
    return tasks;
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Omit<TaskItem, "version">[]) {
  try {
    atomicWriteFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error("Failed to save tasks:", err);
  }
}

// OfficeState owns the board. This JSON backend still rewrites the whole file,
// using the live board so a later successful write also saves earlier changes
// whose writes failed. A database backend can use each record without this getter.
export function createTaskStore(getBoard: () => TaskItem[]) {
  return {
    load: loadTasks,
    create(_task: TaskItem): void {
      saveTasks(getBoard());
    },
    update(_task: TaskItem): void {
      saveTasks(getBoard());
    },
    delete(_id: string): void {
      saveTasks(getBoard());
    },
  };
}
