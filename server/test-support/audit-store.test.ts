import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
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
afterEach(() => { for (const db of handles.splice(0)) db.close(); for (const root of roots.splice(0)) removeStateDir(root); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "audit-test-")); roots.push(root);
  const db = openOfficeDatabase(join(root, "office.sqlite")); handles.push(db);
  const audit = createAuditStore(db);
  const state = new OfficeState();
  state.beforeTaskChange = createTaskStore(() => audit).change;
  return { root, db, audit, state };
}
const actor = { kind: "member" as const, id: "member-1", name: "Member" };
const run = <T>(operation: string, fn: () => T) => withAuditContext(actor, operation, fn);
describe("task audit transactions", () => {
  it("rejects actorless writes before changing the board or database", () => {
    const { state, db } = setup();
    expect(() => state.addTask("task", "member")).toThrow();
    expect(state.tasks).toHaveLength(0);
    expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
  });
  it("rolls back create, update and delete with no board changes or events on audit failure", async () => {
    const { state, db } = setup();
    await run("tasks.create", () => state.addTask("task", "member"));
    const before = JSON.stringify(state.tasks);
    const disk = db.query("SELECT * FROM tasks").all();
    let events = 0; state.onChange(() => events++);
    db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
    for (const [operation, fn] of [
      ["tasks.create", () => state.addTask("new", "member")],
      ["tasks.update", () => state.updateTask(state.tasks[0].id, {title:"changed"})],
      ["tasks.delete", () => state.deleteTask(state.tasks[0].id)],
    ] as const) {
      expect(await run(operation, fn).then(() => null, error => error)).toBeInstanceOf(Error);
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
    const rows = audit.list({targetId:id}).items;
    expect(rows).toHaveLength(3);
    expect(rows[0].deletedTask?.title).toBe("second");
    expect(rows[1].taskChanges?.title).toEqual({old:"first",new:"second"});
    expect(rows[0].actor).toEqual(actor);
    expect(audit.list({actorId:"other"}).items).toHaveLength(0);
    expect(audit.list({limit:1}).nextBefore).toBe(rows[0].sequence);
  });
});
it("imports old backup tasks once, normalizes them, and preserves the original", () => {
  const { root, audit, db } = setup();
  const path = join(root, "tasks.json");
  const source = JSON.stringify([{id:"old",title:"old",status:"backlog",device:"member",version:"stale",createdBy:"member",createdAt:1}]);
  writeFileSync(path, source);
  importLegacyTasks(audit, root);
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(source);
  expect(JSON.parse((db.query("SELECT record FROM tasks").get() as {record:string}).record)).toEqual({id:"old",title:"old",status:"open",priority:"P4",username:"member",createdBy:"member",createdAt:1});
  expect(audit.list().items).toHaveLength(0);
  const taskStore = createTaskStore(() => audit, root);
  const state = new OfficeState();
  state.setTasksDirect([{id:"old",title:"old",status:"open",priority:"P4",username:"member",createdBy:"member",createdAt:1}]);
  state.beforeTaskChange = taskStore.change;
  withAuditContextSync(actor, "tasks.update", () => state.updateTask("old", {title:"changed"}));
  expect(() => taskStore.load()).not.toThrow();
  expect(taskStore.load()[0].title).toBe("changed");
  expect(readFileSync(path, "utf8")).toBe(source);
  expect(readdirSync(root).some(name => name.startsWith("tasks.json.corrupt-"))).toBe(false);
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(1);
});
it("keeps source JSON and rolls back every imported row on a failed transaction", () => {
  const { root, audit, db } = setup();
  const source = JSON.stringify([{id:"one",title:"one"},{id:"two",title:"two"}]);
  db.exec("CREATE TRIGGER import_fail BEFORE INSERT ON tasks WHEN NEW.id = 'two' BEGIN SELECT RAISE(ABORT, 'import failure'); END");
  writeFileSync(join(root,"tasks.json"), source);
  expect(() => importLegacyTasks(audit,root)).toThrow();
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
  expect(readFileSync(join(root,"tasks.json"),"utf8")).toBe(source);
});
it("snapshots an open WAL consistently and sets WAL on a restored snapshot", async () => {
  const { root, db, state } = setup();
  db.exec("PRAGMA wal_autocheckpoint=0");
  await run("tasks.create", () => state.addTask("snapshot", "member"));
  const path = join(root,"restored.sqlite");
  await snapshotOfficeDatabase(join(root,"office.sqlite"), path);
  await run("tasks.create", () => state.addTask("later", "member"));
  const restored = openOfficeDatabase(path); handles.push(restored);
  expect(restored.query("PRAGMA journal_mode").get()).toEqual({journal_mode:"wal"});
  expect(restored.query("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
  expect(restored.query("SELECT * FROM tasks").all()).toHaveLength(1);
  expect(restored.query("SELECT * FROM audit").all()).toHaveLength(1);
});
it("fails and removes an interrupted SQLite snapshot", async () => {
  const {root,db} = setup();
  db.exec("CREATE TABLE large(value TEXT); INSERT INTO large VALUES (hex(randomblob(1000000)))");
  const destination = join(root,"interrupted.sqlite");
  expect(await snapshotOfficeDatabase(join(root,"office.sqlite"),destination,0).then(() => null, error => error)).toBeInstanceOf(Error);
  expect(existsSync(destination)).toBe(false);
});
it("quarantines malformed legacy JSON without deleting its bytes", () => {
  const {root,audit,db} = setup();
  const path = join(root,"tasks.json");
  writeFileSync(path,"malformed source");
  expect(() => importLegacyTasks(audit,root)).not.toThrow();
  const files = readdirSync(root).filter(name => name.startsWith("tasks.json.corrupt-"));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(root,files[0]),"utf8")).toBe("malformed source");
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

it("quarantines duplicate legacy task ids and preserves the original bytes", () => {
  const {root,audit,db} = setup();
  const source = JSON.stringify([{id:"dup",title:"one"},{id:"dup",title:"two"}]);
  writeFileSync(join(root,"tasks.json"),source);
  expect(() => importLegacyTasks(audit,root)).not.toThrow();
  const files = readdirSync(root).filter(name => name.startsWith("tasks.json.corrupt-"));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(root,files[0]),"utf8")).toBe(source);
  expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
});
