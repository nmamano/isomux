// fx census of a STOPPED db snapshot: counts only, no titles/paths/content (2026-10-25).
// Usage: bun run fx-census.ts <dataDir> <snapDir>
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
const [dataDir, snap] = process.argv.slice(2)
mkdirSync(snap!, { recursive: true })
const src = join(dataDir!, "opencode", "opencode.db")
for (const s of ["", "-wal", "-shm"]) if (existsSync(src + s)) copyFileSync(src + s, join(snap!, "opencode.db" + s))
const db = new Database(join(snap!, "opencode.db"), { readonly: true })
const tables = (db.query("select name from sqlite_master where type='table' order by name").all() as any[]).map((r) => r.name)
const cnt = (t: string) => (tables.includes(t) ? (db.query(`select count(*) n from "${t}"`).get() as any).n : null)
const out: any = { tables: tables.length, session: cnt("session"), message: cnt("message"), part: cnt("part"), session_v2: cnt("session_v2"), session_message: cnt("session_message"), event: cnt("event"), event_sequence: cnt("event_sequence") }
if (tables.includes("kv")) { const r = db.query("select value from kv where key='migration.v1-v2'").get() as any; out.kvMigration = r ? (JSON.parse(r.value)?.phase ?? "present") : null }
if (tables.includes("session")) {
  const rows = db.query("select id, directory, parent_id from session").all() as any[]
  const dirs = [...new Set(rows.map((r) => r.directory as string))]
  const gitAnc = (d: string) => { let c = d; while (c && c !== "/") { if (existsSync(join(c, ".git"))) return true; c = dirname(c) } return false }
  out.v1Dirs = { distinct: dirs.length, exist: dirs.filter((d) => existsSync(d)).length, underGateRoot: dirs.filter((d) => d.startsWith("/tmp/t-4840abc5/")).length, gitAncestor: dirs.filter(gitAnc).length }
  out.v1SessionsDirExists = rows.filter((r) => existsSync(r.directory)).length
  out.v1Children = rows.filter((r) => r.parent_id).length
}
console.log(JSON.stringify(out))
db.close()
