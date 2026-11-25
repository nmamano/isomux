// Task 3cc9d863: migration 20260805200742 (legacy auth.json import), edited in
// 2.2.7. (a) A fresh profile whose data folder holds an auth.json: does the
// first start import it, on 2.2.5 and on 2.2.7? (b) A profile made by 2.2.5,
// then started by 2.2.7: is the migration's row kept, and is it run again?
// Counts rows only; never reads a credential value.
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, cpSync } from "node:fs"
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const { makeProfile, startServer, writeJson, GATE_ROOT } = await import(`${H}/common.ts`)
const ID = "20260805200742_import_legacy_credentials"
const DB = "opencode-v2.db"
const env = { OPENCODE_DB: DB }
const root = `${GATE_ROOT}/run/migrate-${Date.now()}`
const V: Record<string, string> = { "2.2.5": process.env.GATE_V1_BIN!, "2.2.7": process.env.GATE_V2_BIN! }
const AUTH = { gate: { type: "api", key: "LEGACY_KEY_SENTINEL_3cc9" } }
function read(p: any) {
  const db = new Database(join(p.data, "opencode", DB), { readonly: true })
  try {
    const row = db.query("SELECT time_completed FROM migration WHERE id = ?").get(ID) as any
    return {
      migrationRow: row ? row.time_completed : null,
      migrations: (db.query("SELECT count(*) AS n FROM migration").get() as any).n,
      credentials: (db.query("SELECT count(*) AS n FROM credential").get() as any).n,
    }
  } finally { db.close() }
}
async function start(p: any, version: string) {
  const s = await startServer(p, { bin: V[version], env })
  const info = (await s.api("GET", "/api/info")).body?.version
  await s.stop()
  return info
}
const out: any = { date: new Date().toISOString().slice(0, 10), task: "3cc9d863", script: "harness-2.2.7/migrate.ts", fresh: {}, upgrade: {} }
for (const [version, auth] of [["2.2.5", AUTH], ["2.2.7", AUTH], ["2.2.5", []], ["2.2.7", []]] as const) {
  const name = `${version}/${Array.isArray(auth) ? "authNotObject" : "authKey"}`
  const p = makeProfile(join(root, "fresh", name.replace("/", "-")))
  mkdirSync(join(p.data, "opencode"), { recursive: true })
  writeFileSync(join(p.data, "opencode", "auth.json"), JSON.stringify(auth), { mode: 0o600 })
  try { out.fresh[name] = { started: await start(p, version), ...read(p) } } catch (e) { out.fresh[name] = { error: String(e).slice(0, 200) } }
}
{
  const p = makeProfile(join(root, "upgrade"))
  out.upgrade.made = { started: await start(p, "2.2.5"), ...read(p) }
  mkdirSync(join(p.data, "opencode"), { recursive: true })
  writeFileSync(join(p.data, "opencode", "auth.json"), JSON.stringify(AUTH), { mode: 0o600 })
  out.upgrade.on227WithAuthAdded = { started: await start(p, "2.2.7"), ...read(p) }
  out.upgrade.back225 = { started: await start(p, "2.2.5"), ...read(p) }
}
writeJson(`${GATE_ROOT}/evidence/migration-200742.json`, out)
console.log(JSON.stringify(out, null, 1))
process.exit(0)
