// r2 Probe B add-on (2026-10-25): 2.1.4 on a copy of the 1.18.35 profile from r2-v1cred
// (opencode.db with v1 tables + the planted fake auth.json), so the
// 20260805200742_import_legacy_credentials migration runs. Counts of the fake key per route.
// Usage: bun run r2-v2cred.ts <runDir> <v1ProfileDir>
import { cpSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { makeProfile } from "./common.ts"
import { startServer2 } from "./cc-start.ts"
import { rawGet, countOf, list } from "./r2-lib.ts"
const root = process.argv[2]!
const src = process.argv[3]!
const SENT = "sk-fakegate-v1cred-0001"
const p = makeProfile(join(root, "v2-on-v1"))
cpSync(join(src, "data", "opencode"), join(p.data, "opencode"), { recursive: true })
const before = new Database(join(p.data, "opencode", "opencode.db"), { readonly: true })
const tablesBefore = (before.query(`select name from sqlite_master where type='table'`).all() as any[]).map((r) => r.name)
before.close()
const r: any = { date: "2026-10-25", copiedFrom: "r2-v1cred v1 profile data/opencode (stopped server)", hasV1SessionTable: tablesBefore.includes("session"), authJsonFakeKeyCount: countOf(readFileSync(join(p.data, "opencode", "auth.json"), "utf8"), SENT) }
const s = await startServer2(p, { logPath: join(p.dir, "server.log"), env: { GATE_API_KEY: undefined } })
r.pid = s.pid
try {
  await Bun.sleep(3000)
  const rows: any[] = []
  for (const path of ["/api/credential", "/api/provider", "/api/config", "/api/integration", "/api/model"]) {
    const res = await rawGet(s.base, "opencode", s.password, path, 5000)
    let ids: any
    try {
      const j = JSON.parse(res.text)
      if (path === "/api/credential") ids = list(j).map((c: any) => c.integrationID ?? c.integration_id ?? c.integration ?? Object.keys(c))
      if (path === "/api/provider") ids = list(j).map((c: any) => c.id)
      if (path === "/api/integration") ids = list(j).filter((c: any) => (c.connections ?? []).length).map((c: any) => c.id)
    } catch {}
    rows.push({ path, status: res.status, bytes: res.bytes, fakeKeyCount: countOf(res.text, SENT), ids })
  }
  r.routeScan = rows
  await Bun.sleep(12000)
  const late: any[] = []
  for (const path of ["/api/provider", "/api/credential", "/api/config"]) {
    const res = await rawGet(s.base, "opencode", s.password, path, 5000)
    let ids: any
    try { ids = list(JSON.parse(res.text)).map((c: any) => c.id ?? c.integrationID) } catch {}
    late.push({ path, afterMs: 15000, status: res.status, bytes: res.bytes, fakeKeyCount: countOf(res.text, SENT), ids })
  }
  r.routeScanLate = late
} finally { await s.stop() }
r.exited = s.proc.exitCode !== null || s.proc.signalCode !== null
const db = new Database(join(p.data, "opencode", "opencode.db"), { readonly: true })
r.credentialRowsAfter = (db.query(`select count(*) c from credential`).get() as any).c
r.credentialIntegrations = (db.query(`select integration_id i from credential`).all() as any[]).map((x) => x.i)
db.close()
r.logLines = { importOrMigration: readFileSync(join(p.dir, "server.log"), "utf8").split("\n").filter((l) => /legacy|credential|migrat/i.test(l)).length }
writeFileSync(join(root, "v2-on-v1.json"), JSON.stringify(r, null, 2).split(s.password).join("[REDACTED]"))
console.log(JSON.stringify(r, null, 1).split(s.password).join("[REDACTED]"))
process.exit(0)
