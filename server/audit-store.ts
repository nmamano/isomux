import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import type { AuditEntry, AuditFilter, AuditPage } from "../shared/audit.ts";

export const OFFICE_DATABASE = "office.sqlite";
export type AuditWrite = Omit<AuditEntry, "sequence" | "time"> & { time?: number };
export function openOfficeDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
  chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  const version = db.query("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version > 1) throw new Error("Unsupported office database version");
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, owner_id TEXT,
        operation TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_targets (
        sequence INTEGER NOT NULL REFERENCES audit(sequence), target TEXT NOT NULL,
        PRIMARY KEY(sequence, target));
      CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor_kind, actor_id, sequence);
      CREATE INDEX IF NOT EXISTS audit_owner ON audit(owner_id, sequence);
      CREATE INDEX IF NOT EXISTS audit_operation ON audit(operation, sequence);
      CREATE INDEX IF NOT EXISTS audit_time ON audit(time, sequence);
      CREATE INDEX IF NOT EXISTS audit_target ON audit_targets(target, sequence);
      PRAGMA user_version=1;`);
  })();
  return db;
  } catch (error) { db.close(); throw error; }
}

export function createAuditStore(db: Database) {
  function insert(input: AuditWrite): number {
    const entry = { ...input, time: input.time ?? Date.now(), targets: [...new Set(input.targets)] };
    const result = db.query(`INSERT INTO audit(time,actor_kind,actor_id,owner_id,operation,record) VALUES (?,?,?,?,?,?)`)
      .run(entry.time, entry.actor.kind, entry.actor.id, entry.actor.ownerId ?? null, entry.operation, JSON.stringify(entry));
    const sequence = Number(result.lastInsertRowid);
    for (const target of entry.targets) db.query("INSERT INTO audit_targets(sequence,target) VALUES (?,?)").run(sequence, target);
    return sequence;
  }
  function list(filter: AuditFilter = {}, tasksOnly = false): AuditPage {
    const where: string[] = tasksOnly ? ["operation IN ('tasks.create','tasks.update','tasks.claim','tasks.done','tasks.delete','tasks.restore')"] : [];
    const args: (string | number)[] = [];
    for (const [key, column] of [["actorKind","actor_kind"],["actorId","actor_id"],["ownerId","owner_id"],["operation","operation"]] as const) {
      if (filter[key] !== undefined) { where.push(`${column}=?`); args.push(filter[key]); }
    }
    if (filter.targetId !== undefined) { where.push("sequence IN (SELECT sequence FROM audit_targets WHERE target=?)"); args.push(filter.targetId); }
    for (const [key, op, column] of [["from",">=","time"],["to","<=","time"],["before","<","sequence"]] as const) {
      if (filter[key] !== undefined) { where.push(`${column}${op}?`); args.push(filter[key]); }
    }
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    args.push(limit + 1);
    const rows = db.query(`SELECT sequence,record FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sequence DESC LIMIT ?`).all(...args) as {sequence:number; record:string}[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(r => ({ ...JSON.parse(r.record), sequence: r.sequence }) as AuditEntry);
    return { items, nextBefore: more ? items[items.length - 1].sequence : null };
  }
  return { db, insert, append: db.transaction(insert), list };
}
export type AuditStore = ReturnType<typeof createAuditStore>;
let singleton: { path: string; inode: number; store: AuditStore } | undefined;
export function officeAuditStore(): AuditStore {
  const path = join(STATE_ROOT, OFFICE_DATABASE);
  // Test roots can be replaced between harnesses. Never retain an unlinked DB.
  if (singleton && (!existsSync(path) || statSync(path).ino !== singleton.inode)) {
    singleton.store.db.close(); singleton = undefined;
  }
  if (!singleton) singleton = { path, store: createAuditStore(openOfficeDatabase(path)), inode: statSync(path).ino };
  return singleton.store;
}
export function recordAudit(input: AuditWrite): void {
  // A file/process mutation has already succeeded. An audit failure must not
  // turn it into a retryable HTTP failure and run that action twice.
  try { officeAuditStore().append(input); }
  catch (error) { console.error("[audit] could not record completed write", error); }
}
