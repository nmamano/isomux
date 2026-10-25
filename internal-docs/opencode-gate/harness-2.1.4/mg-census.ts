// mg census: every path in a profile with size + sha256 (no content), plus a
// SQLite table list with row counts from a copy of the DB (read-only open).
// Usage: bun run mg-census.ts <profileDir> <outJson> <dbCopyDir>
import { readdirSync, lstatSync, readlinkSync, mkdirSync, copyFileSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"

const [profile, out, dbCopyDir] = process.argv.slice(2)
if (!profile || !out || !dbCopyDir) throw new Error("usage")

async function sha(path: string) {
  const h = createHash("sha256")
  const f = Bun.file(path)
  const r = f.stream().getReader()
  for (;;) {
    const { value, done } = await r.read()
    if (done) break
    h.update(value)
  }
  return h.digest("hex")
}

const files: Record<string, { type: string; size?: number; sha256?: string; mode?: string; target?: string }> = {}
async function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    const rel = relative(profile, p)
    const mode = (st.mode & 0o7777).toString(8)
    if (st.isSymbolicLink()) files[rel] = { type: "symlink", mode, target: createHash("sha256").update(readlinkSync(p)).digest("hex").slice(0, 16) }
    else if (st.isDirectory()) {
      files[rel] = { type: "dir", mode }
      await walk(p)
    } else if (st.isFile()) files[rel] = { type: "file", size: st.size, sha256: await sha(p), mode }
    else files[rel] = { type: "other", mode }
  }
}
await walk(profile)

// DB census on a copy (db + wal + shm), opened read-only.
const src = join(profile, "data", "opencode", "opencode.db")
mkdirSync(dbCopyDir, { recursive: true, mode: 0o700 })
const tables: Record<string, number> = {}
let extra: Record<string, unknown> = {}
if (existsSync(src)) {
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, join(dbCopyDir, "opencode.db" + suf))
  const db = new Database(join(dbCopyDir, "opencode.db"), { readonly: true })
  const names = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  for (const { name } of names) tables[name] = (db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
  const has = (t: string) => t in tables
  if (has("session")) {
    extra.v1_sessions = tables.session
    extra.v1_sessions_global_project = (db.query("SELECT COUNT(*) AS n FROM session WHERE project_id='global'").get() as any).n
    extra.v1_root_sessions = (db.query("SELECT COUNT(*) AS n FROM session WHERE parent_id IS NULL").get() as any).n
    extra.v1_archived_sessions = (db.query("SELECT COUNT(*) AS n FROM session WHERE time_archived IS NOT NULL").get() as any).n
  }
  if (has("session_v2")) {
    extra.v2_sessions = tables.session_v2
  }
  if (has("kv")) {
    const row = db.query("SELECT value FROM kv WHERE key='migration.v1-v2'").get() as any
    extra.kv_migration_state = row ? JSON.parse(row.value)?.phase ?? "present" : null
  }
  if (has("credential")) {
    extra.credentials = db.query("SELECT integration_id, label FROM credential ORDER BY integration_id").all()
  }
  if (has("__drizzle_migrations")) extra.v1_drizzle_migrations = tables.__drizzle_migrations
  db.close()
}
await Bun.write(out, JSON.stringify({ at: new Date().toISOString(), profileRel: true, fileCount: Object.keys(files).length, files, tables, extra }, null, 2))
console.log(JSON.stringify({ fileCount: Object.keys(files).length, tableCount: Object.keys(tables).length, extra: { ...extra, credentials: undefined } }))
