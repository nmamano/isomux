import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { openOfficeDatabase, createAuditStore } from "../audit-store.ts";
import { createTaskStore, importLegacyTasks } from "../task-store.ts";
import { withAuditContext, withAuditContextSync } from "../audit-context.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { snapshotOfficeDatabase } from "../sqlite-snapshot.ts";
import { removeStateDir } from "./temp-state.ts";
const roots: string[] = [];
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) removeStateDir(root);
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "audit-test-"));
  roots.push(root);
  const db = openOfficeDatabase(join(root, "office.sqlite"));
  handles.push(db);
  const audit = createAuditStore(db);
  const state = new OfficeState();
  state.beforeTaskChange = createTaskStore(() => audit).change;
  return { root, db, audit, state };
}
const actor = { kind: "member" as const, id: "member-1", name: "Member" };
const run = <T>(operation: string, fn: () => T) =>
  withAuditContext(actor, operation, fn);
describe("task audit transactions", () => {
  it("rolls back create, update and delete with no board changes or events on audit failure", async () => {
    const { state, db } = setup();
    await run("tasks.create", () => state.addTask("task", "member"));
    const before = JSON.stringify(state.tasks);
    const disk = db.query("SELECT * FROM tasks").all();
    let events = 0;
    state.onChange(() => events++);
    db.exec(
      "CREATE TRIGGER audit_fail BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
    );
    for (const [operation, fn] of [
      ["tasks.create", () => state.addTask("new", "member")],
      [
        "tasks.update",
        () => state.updateTask(state.tasks[0].id, { title: "changed" }),
      ],
      ["tasks.delete", () => state.deleteTask(state.tasks[0].id)],
    ] as const) {
      expect(
        await run(operation, fn).then(
          () => null,
          (error) => error,
        ),
      ).toBeInstanceOf(Error);
      expect(JSON.stringify(state.tasks)).toBe(before);
      expect(db.query("SELECT * FROM tasks").all()).toEqual(disk);
      expect(events).toBe(0);
      expect(db.query("SELECT * FROM audit").all()).toHaveLength(1);
    }
  });
  it("keeps changes and deleted final contents with the actor snapshot", async () => {
    const { state, audit } = setup();
    await run("tasks.create", () => state.addTask("first", "member"));
    const id = state.tasks[0].id;
    await run("tasks.update", () => state.updateTask(id, { title: "second" }));
    await run("tasks.delete", () => state.deleteTask(id));
    const rows = audit.list({ targetId: id }).items;
    expect(rows).toHaveLength(3);
    expect(rows[0].deletedTask?.title).toBe("second");
    expect(rows[1].taskChanges?.title).toEqual({ old: "first", new: "second" });
    expect(rows[0].actor).toEqual(actor);
    expect(audit.list({ actorId: "other" }).items).toHaveLength(0);
    expect(audit.list({ limit: 1 }).nextBefore).toBe(rows[0].sequence);
  });
});
it("keeps source JSON and rolls back every imported row on a failed transaction", () => {
  const { root, audit, db } = setup();
  const source = JSON.stringify([
    { id: "one", title: "one" },
    { id: "two", title: "two" },
  ]);
  db.exec(
    "CREATE TRIGGER import_fail BEFORE INSERT ON tasks WHEN NEW.id = 'two' BEGIN SELECT RAISE(ABORT, 'import failure'); END",
  );
  writeFileSync(join(root, "tasks.json"), source);
  expect(() => importLegacyTasks(audit, root)).toThrow();
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
  expect(readFileSync(join(root, "tasks.json"), "utf8")).toBe(source);
});
it("a timed-out or failed snapshot rejects and leaves no file at the destination", async () => {
  const { root, db } = setup();
  db.exec(
    "CREATE TABLE large(value TEXT); INSERT INTO large VALUES (hex(randomblob(1000000)))",
  );
  const source = join(root, "office.sqlite");
  // A 0 ms budget kills the child before VACUUM can finish.
  const timedOut = join(root, "timed-out.sqlite");
  expect(
    await snapshotOfficeDatabase(source, timedOut, 0).then(
      () => null,
      (error: Error) => error.message,
    ),
  ).toMatch(/timed out/);
  expect(existsSync(timedOut)).toBe(false);
  // A partial file at the destination when the child fails (VACUUM INTO
  // refuses a non-empty file): the parent removes it, so no private copy of
  // the office database stays behind.
  const partial = join(root, "partial.sqlite");
  writeFileSync(partial, "partial snapshot");
  expect(
    await snapshotOfficeDatabase(source, partial).then(
      () => null,
      (error: Error) => error.message,
    ),
  ).toMatch(/snapshot failed/);
  expect(existsSync(partial)).toBe(false);
});
it("quarantines malformed legacy JSON without deleting its bytes", () => {
  const { root, audit, db } = setup();
  const path = join(root, "tasks.json");
  writeFileSync(path, "malformed source");
  expect(() => importLegacyTasks(audit, root)).not.toThrow();
  const files = readdirSync(root).filter((name) =>
    name.startsWith("tasks.json.corrupt-"),
  );
  expect(files).toHaveLength(1);
  expect(readFileSync(join(root, files[0]), "utf8")).toBe("malformed source");
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

it("quarantines duplicate legacy task ids and preserves the original bytes", () => {
  const { root, audit, db } = setup();
  const source = JSON.stringify([
    { id: "dup", title: "one" },
    { id: "dup", title: "two" },
  ]);
  writeFileSync(join(root, "tasks.json"), source);
  expect(() => importLegacyTasks(audit, root)).not.toThrow();
  const files = readdirSync(root).filter((name) =>
    name.startsWith("tasks.json.corrupt-"),
  );
  expect(files).toHaveLength(1);
  expect(readFileSync(join(root, files[0]), "utf8")).toBe(source);
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
});

describe("frozen tasks.json copy after the import", () => {
  const legacy = (ids: string[]) =>
    JSON.stringify(ids.map((id) => ({ id, title: id })));
  // The import boot: the tasks table is empty at entry, so the file stays.
  function imported(ids: string[], subdir?: string) {
    const env = setup();
    const legacyRoot = subdir ? join(env.root, subdir) : env.root;
    mkdirSync(legacyRoot, { recursive: true });
    const path = join(legacyRoot, "tasks.json");
    writeFileSync(path, legacy(ids));
    const taskStore = createTaskStore(() => env.audit, legacyRoot);
    expect(taskStore.load().map((task) => task.id)).toEqual(ids);
    expect(readFileSync(path, "utf8")).toBe(legacy(ids));
    return { ...env, legacyRoot, path, taskStore };
  }
  const corrupt = (root: string) =>
    readdirSync(root).filter((name) => name.startsWith("tasks.json.corrupt-"));
  function logged<T>(fn: () => T) {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      return {
        result: fn(),
        warned: warn.mock.calls.length,
        errors: error.mock.calls.length,
      };
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }

  it("counts a task deleted after the import as known and retires the file", () => {
    const { path, taskStore, db, audit } = imported(["kept", "gone"]);
    const state = new OfficeState();
    state.setTasksDirect(
      (
        db.query("SELECT record FROM tasks ORDER BY rowid").all() as {
          record: string;
        }[]
      ).map((row) => JSON.parse(row.record)),
    );
    state.beforeTaskChange = taskStore.change;
    withAuditContextSync(actor, "tasks.delete", () => state.deleteTask("gone"));
    expect(db.query("SELECT id FROM tasks").all()).toEqual([{ id: "kept" }]);
    expect(audit.list({ targetId: "gone" }).items).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
    expect(taskStore.load().map((task) => task.id)).toEqual(["kept"]);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a file with a task the database never saw, and warns", () => {
    // Old code after a rollback wrote a new task into tasks.json.
    const { path, taskStore, root } = imported(["old"]);
    writeFileSync(path, legacy(["old", "made-after-rollback"]));
    const { result, warned } = logged(() => taskStore.load());
    expect(result.map((task) => task.id)).toEqual(["old"]);
    expect(readFileSync(path, "utf8")).toBe(
      legacy(["old", "made-after-rollback"]),
    );
    expect(warned).toBe(1);
    expect(corrupt(root)).toHaveLength(0);
  });

  // One row per refusal class: the JSON parse, and the record check the
  // import shares (its duplicate-id refusal is pinned by the import's
  // "quarantines duplicate legacy task ids" test).
  for (const [name, source] of [
    ["not JSON", "not json"],
    ["an entry without a title", JSON.stringify([{ id: "old" }])],
  ] as const)
    it(`keeps an unverifiable file (${name}) when the board is not empty`, () => {
      const { path, taskStore, root } = imported(["old"]);
      writeFileSync(path, source);
      const { result } = logged(() => taskStore.load());
      expect(result.map((task) => task.id)).toEqual(["old"]);
      expect(readFileSync(path, "utf8")).toBe(source);
      expect(corrupt(root)).toHaveLength(0);
    });

  it("loads the board when the file cannot be deleted", () => {
    const { path, taskStore, legacyRoot } = imported(["old"], "legacy");
    chmodSync(legacyRoot, 0o555);
    try {
      // Precondition: the directory refuses new entries, so unlink fails too.
      expect(() => writeFileSync(join(legacyRoot, "probe"), "")).toThrow();
      const { result, errors } = logged(() => taskStore.load());
      expect(result.map((task) => task.id)).toEqual(["old"]);
      expect(existsSync(path)).toBe(true);
      expect(errors).toBeGreaterThan(0);
    } finally {
      chmodSync(legacyRoot, 0o755);
    }
  });
});
