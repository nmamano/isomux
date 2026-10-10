// The live board belongs to OfficeState. This store commits a proposed change
// and its history before OfficeState applies it or emits an event.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { TaskItem } from "../shared/types.ts";
import type { TaskChange } from "../shared/office-state.ts";
import { STATE_ROOT } from "./config.ts";
import { officeAuditStore, type AuditStore } from "./audit-store.ts";
import { requireAuditContext } from "./audit-context.ts";

type StoredTask = Omit<TaskItem, "version">;
function stored(task: TaskItem | StoredTask): StoredTask {
  const { version: _version, ...record } = task as TaskItem;
  return record;
}
function normalize(records: unknown): StoredTask[] {
  if (!Array.isArray(records)) throw new Error("Task import must be an array");
  const ids = new Set<string>();
  return records.map((value) => {
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.title !== "string"
    )
      throw new Error("Invalid imported task");
    if (ids.has(value.id)) throw new Error("Duplicate imported task id");
    ids.add(value.id);
    const { version: _version, device, ...task } = value;
    if (task.username === undefined && device !== undefined)
      task.username = device;
    if (task.status === "backlog") {
      task.status = "open";
      task.priority = "P4";
    }
    return task as StoredTask;
  });
}
export function importLegacyTasks(store: AuditStore, root = STATE_ROOT): void {
  const path = join(root, "tasks.json");
  const count = store.db.query("SELECT count(*) AS n FROM tasks").get() as {
    n: number;
  };
  if (count.n || !existsSync(path)) return;
  let tasks: StoredTask[];
  try {
    tasks = normalize(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    // Keep the original bytes, including malformed content, for recovery.
    // If the rename itself fails, propagate it rather than orphan the source.
    try {
      renameSync(path, quarantine);
    } catch (renameError) {
      console.error(
        `[tasks] could not quarantine ${path} as ${quarantine}; source retained`,
        renameError,
      );
      throw renameError;
    }
    console.error(
      `[tasks] could not import ${path}; preserved as ${quarantine}`,
      error,
    );
    return;
  }
  store.db.transaction(() => {
    const insert = store.db.query("INSERT INTO tasks(id,record) VALUES (?,?)");
    for (const task of tasks) insert.run(task.id, JSON.stringify(task));
  })();
  // Keep the source byte for byte so older code can read it after rollback.
  // The nonempty tasks table above prevents a second import on later boots.
}
function loadFromStore(store: AuditStore, root: string): StoredTask[] {
  importLegacyTasks(store, root);
  return (
    store.db.query("SELECT record FROM tasks ORDER BY rowid").all() as {
      record: string;
    }[]
  ).map((r) => JSON.parse(r.record));
}
export function loadTasks(): StoredTask[] {
  return loadFromStore(officeAuditStore(), STATE_ROOT);
}
// Tests only: whole-board fixture seeding. Production mutations
// use change(), never a whole-board save. No audit backfill for imported state.
export function saveTasks(tasks: StoredTask[]): void {
  const { db } = officeAuditStore();
  db.transaction(() => {
    db.exec("DELETE FROM tasks");
    for (const task of tasks)
      db.query("INSERT INTO tasks(id,record) VALUES (?,?)").run(
        task.id,
        JSON.stringify(stored(task)),
      );
  })();
}
export function createTaskStore(
  getStore: () => AuditStore = officeAuditStore,
  root = STATE_ROOT,
) {
  function change(change: TaskChange): void {
    const context = requireAuditContext();
    const store = getStore();
    store.db.transaction(() => {
      const row = store.db
        .query("SELECT record FROM tasks WHERE id=?")
        .get(change.task.id) as { record: string } | null;
      const before: Record<string, unknown> = row ? JSON.parse(row.record) : {};
      const after = change.kind === "deleted" ? {} : stored(change.task);
      const taskChanges: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        const oldValue = before[key] ?? null;
        const newValue = (after as Record<string, unknown>)[key] ?? null;
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
          taskChanges[key] = { old: oldValue, new: newValue };
      }
      if (change.kind === "deleted")
        store.db.query("DELETE FROM tasks WHERE id=?").run(change.task.id);
      else
        store.db
          .query(
            "INSERT INTO tasks(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
          )
          .run(change.task.id, JSON.stringify(after));
      store.insert({
        actor: context.actor,
        operation: context.operation,
        targets: [change.task.id],
        fields: Object.keys(taskChanges),
        taskChanges,
        ...(change.kind === "deleted"
          ? { deletedTask: stored(change.task) }
          : {}),
      });
    })();
  }
  return {
    load: () => loadFromStore(getStore(), root),
    change,
    create: (task: TaskItem) => change({ kind: "created", task }),
    update: (task: TaskItem) => change({ kind: "updated", task }),
    delete: (task: TaskItem) => change({ kind: "deleted", task }),
  };
}
