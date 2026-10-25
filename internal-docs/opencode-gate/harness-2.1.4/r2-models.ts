// r2 Probe A (task 4840abc5, 2026-10-25): what OPENCODE_DISABLE_MODELS_FETCH=1
// changes for the model catalog and the free-model list, 2.1.4 vs 1.18.35.
// No provider configured, no OPENCODE_DISABLE_FREE_MODELS, real network.
// Usage: bun run r2-models.ts <runDir> <evidencePath>
import { existsSync, readFileSync, statSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { makeProfile, V1_BIN, type Server } from "./common.ts"
import { startServer2 } from "./cc-start.ts"
import { tapAs, list, markPluginSdkOnly } from "./r2-lib.ts"

const root = process.argv[2]!
const evidencePath = process.argv[3]!
mkdirSync(root, { recursive: true })
const passwords: string[] = []
const started: any[] = []
const out: any = {
  item: "r2 Probe A: models catalog and free models with/without OPENCODE_DISABLE_MODELS_FETCH",
  date: "2026-10-25",
  runDir: root,
  method: [
    "Fresh profile per run (HOME/XDG_*/TMPDIR inside the run dir), no OPENCODE_CONFIG, no OPENCODE_CONFIG_CONTENT, no provider, no OPENCODE_DISABLE_FREE_MODELS, GATE_API_KEY unset, real network (no proxy).",
    "2.1.4: startServer2 (cc-start.ts); SSE tap on /api/event from right after health; read GET /api/provider, /api/model, /api/model/default at t0; wait up to 30 s for an event of type models-dev.refreshed; read again (t1).",
    "1.18.35: startServer2 v1 with OPENCODE_SERVER_USERNAME=isomux; plugin SDK marked installed (as Isomux does); NO models.json seeded; SSE taps on /event and /global/event; read GET /provider and /config/providers at t0, wait 30 s, read again.",
    "free = no cost entry with input > 0 (same rule as 2.1.4 core/src/model.ts:227 and :306); strictFree = input and output both 0.",
    "Contact evidence: 2.1.4 models-dev.refreshed event, the kv row for models-dev:catalog in opencode.db (copied after stop), 'Failed to fetch models.dev' log lines; 1.18.35 the cache/opencode/models.json file (written only by ModelsDev.fetchAndWrite) and its size.",
  ],
  runs: [],
}

function v2Count(models: any[]) {
  const byProvider: Record<string, number> = {}
  for (const m of models) byProvider[m.providerID] = (byProvider[m.providerID] ?? 0) + 1
  const free = (m: any) => !(m.cost ?? []).some((c: any) => c.input > 0)
  const strict = (m: any) => (m.cost ?? []).every((c: any) => c.input === 0 && c.output === 0)
  const oc = models.filter((m) => m.providerID === "opencode")
  return {
    models: models.length,
    enabled: models.filter((m) => m.enabled).length,
    providersInModelList: Object.keys(byProvider).length,
    opencodeModels: oc.length,
    freeModels: models.filter(free).length,
    strictFreeModels: models.filter(strict).length,
    freeOpencodeModels: oc.filter(free).length,
    freeOpencodeModelIDs: oc.filter(free).map((m) => m.id),
    enabledModelIDs: models.filter((m) => m.enabled).map((m) => `${m.providerID}/${m.id}`).slice(0, 40),
  }
}

async function v2Read(s: Server) {
  const t = Date.now()
  const prov = await s.api("GET", "/api/provider")
  const model = await s.api("GET", "/api/model")
  const def = await s.api("GET", "/api/model/default")
  const providers = list(prov.body)
  return {
    at: new Date().toISOString(),
    ms: Date.now() - t,
    provider: { status: prov.status, count: providers.length, ids: providers.map((p: any) => p.id ?? p.providerID) },
    model: { status: model.status, ...v2Count(list(model.body)) },
    defaultModel: { status: def.status, id: def.body?.data ? `${def.body.data.providerID}/${def.body.data.id}` : null },
  }
}

function v2Kv(p: any, label: string) {
  const src = join(p.data, "opencode", "opencode.db")
  if (!existsSync(src)) return { db: false }
  const dest = join(root, `dbcopy-${label}`)
  mkdirSync(dest, { recursive: true })
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, join(dest, "opencode.db" + suf))
  const db = new Database(join(dest, "opencode.db"), { readonly: true })
  try {
    const tables = (db.query(`select name from sqlite_master where type='table'`).all() as any[]).map((r) => r.name as string)
    const kvTables = tables.filter((t) => /kv/i.test(t))
    const rows: any[] = []
    for (const t of kvTables) {
      const cols = (db.query(`pragma table_info("${t}")`).all() as any[]).map((c) => c.name as string)
      const keyCol = cols.find((c) => /key|id/i.test(c)) ?? cols[0]
      const valCol = cols.find((c) => /value|data|body/i.test(c))
      for (const r of db.query(`select "${keyCol}" k ${valCol ? `, length("${valCol}") n` : ""} from "${t}"`).all() as any[])
        rows.push({ table: t, key: String(r.k).slice(0, 80), valueBytes: r.n })
    }
    return { db: true, kvTables, rows: rows.filter((r) => /models/i.test(r.key)), allKeys: rows.length }
  } finally {
    db.close()
  }
}

function logGrep(path: string, re: RegExp, max = 10) {
  if (!existsSync(path)) return { count: -1, lines: [] }
  let lines = readFileSync(path, "utf8").split("\n").filter((l) => re.test(l))
  for (const pw of passwords) lines = lines.map((l) => l.split(pw).join("[REDACTED]"))
  return { count: lines.length, lines: lines.slice(0, max).map((l) => l.slice(0, 300)) }
}

async function v2Run(label: string, fetchOff: boolean) {
  const dir = join(root, label)
  const p = makeProfile(dir)
  const logPath = join(dir, "server.log")
  const env: Record<string, string | undefined> = { GATE_API_KEY: undefined }
  if (fetchOff) env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  const t0 = Date.now()
  const s = await startServer2(p, { env, logPath })
  passwords.push(s.password)
  started.push({ label, pid: s.pid, bin: "2.1.4" })
  const r: any = { label, opencode: "2.1.4", env: fetchOff ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}, startMs: Date.now() - t0 }
  try {
    const tap = await tapAs(s, "opencode", join(dir, "events.jsonl"), "/api/event")
    r.t0 = await v2Read(s)
    const tw = Date.now()
    const ev = await tap.waitFor((e) => e.type === "models-dev.refreshed", 30_000).catch(() => null)
    r.refreshedEvent = ev ? { seen: true, afterStartMs: ev.__receivedAt - t0, waitedMs: Date.now() - tw } : { seen: false, waitedMs: Date.now() - tw }
    if (ev) await Bun.sleep(1500)
    r.t1 = await v2Read(s)
    r.eventTypes = [...new Set(tap.events.map((e) => e.type))]
    r.eventsTotal = tap.events.length
    tap.close()
  } finally {
    await s.stop()
  }
  r.kvAfterStop = v2Kv(p, label)
  r.log = {
    lines: readFileSync(logPath, "utf8").split("\n").length,
    failedFetch: logGrep(logPath, /Failed to fetch models\.dev/),
    modelsMentions: logGrep(logPath, /models\.dev|models\.opencode\.ai|ModelsDev/i, 8),
  }
  return r
}

function v1Count(body: any) {
  const all = Array.isArray(body?.all) ? body.all : Array.isArray(body?.providers) ? body.providers : Array.isArray(body) ? body : []
  let models = 0
  const perProvider: Record<string, number> = {}
  let oc: any[] = []
  for (const pr of all) {
    const ms = Object.values(pr.models ?? {}) as any[]
    models += ms.length
    perProvider[pr.id] = ms.length
    if (pr.id === "opencode") oc = ms
  }
  const free = (m: any) => !((m.cost?.input ?? 0) > 0)
  const strict = (m: any) => (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0
  return {
    providers: all.length,
    providerIDsSample: all.map((p: any) => p.id).slice(0, 15),
    models,
    opencodeModels: oc.length,
    freeOpencodeModels: oc.filter(free).length,
    strictFreeOpencodeModels: oc.filter(strict).length,
    freeOpencodeModelIDs: oc.filter(free).map((m: any) => m.id),
    connected: body?.connected,
    default: body?.default,
  }
}

async function v1Read(s: Server, user: string) {
  const t = Date.now()
  const a = await s.api("GET", "/provider")
  const msProvider = Date.now() - t
  const b = await s.api("GET", "/config/providers")
  const cp = b.body?.providers ?? []
  return {
    at: new Date().toISOString(),
    msProvider,
    provider: { status: a.status, ...v1Count(a.body) },
    configProviders: { status: b.status, providers: Array.isArray(cp) ? cp.length : null, ids: Array.isArray(cp) ? cp.map((p: any) => p.id) : null },
  }
}

async function v1Run(label: string, fetchOff: boolean) {
  const dir = join(root, label)
  const p = makeProfile(dir)
  markPluginSdkOnly(p)
  const logPath = join(dir, "server.log")
  const env: Record<string, string | undefined> = { GATE_API_KEY: undefined, OPENCODE_SERVER_USERNAME: "isomux", OPENCODE_DISABLE_SHARE: "1" }
  if (fetchOff) env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  const t0 = Date.now()
  const s = await startServer2(p, { v1: true, env, logPath })
  passwords.push(s.password)
  started.push({ label, pid: s.pid, bin: "1.18.35" })
  const r: any = { label, opencode: "1.18.35", env: fetchOff ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}, startMs: Date.now() - t0 }
  const cache = join(p.cache, "opencode", "models.json")
  try {
    const t1 = await tapAs(s, "isomux", join(dir, "events.jsonl"), `/event?directory=${encodeURIComponent(dir)}`)
    const t2 = await tapAs(s, "isomux", join(dir, "global-events.jsonl"), "/global/event")
    r.t0 = await v1Read(s, "isomux")
    r.cacheAtT0 = existsSync(cache) ? { exists: true, bytes: statSync(cache).size, writtenAfterStartMs: statSync(cache).mtimeMs - t0 } : { exists: false }
    await Bun.sleep(30_000)
    r.t1 = await v1Read(s, "isomux")
    r.cacheAtT1 = existsSync(cache) ? { exists: true, bytes: statSync(cache).size, writtenAfterStartMs: Math.round(statSync(cache).mtimeMs - t0) } : { exists: false }
    const evs = [...t1.events, ...t2.events]
    r.eventTypes = [...new Set(evs.map((e) => e.type ?? e.payload?.type))]
    r.modelsEvents = evs.filter((e) => /models/i.test(JSON.stringify(e).slice(0, 200))).length
    t1.close()
    t2.close()
  } finally {
    await s.stop()
  }
  r.log = {
    lines: readFileSync(logPath, "utf8").split("\n").length,
    modelsMentions: logGrep(logPath, /models\.dev|models\.opencode\.ai|ModelsDev|models\.json/i, 8),
  }
  return r
}

function save() {
  let text = JSON.stringify(out, null, 2)
  for (const pw of passwords) text = text.split(pw).join("[REDACTED]")
  writeFileSync(evidencePath, text + "\n")
}

try {
  out.v1ReadsFetchFlag = {
    method: "strings <1.18.35 bin> | grep -c OPENCODE_DISABLE_MODELS_FETCH",
    count: Number(new TextDecoder().decode(Bun.spawnSync(["bash", "-c", `strings '${V1_BIN}' | grep -c OPENCODE_DISABLE_MODELS_FETCH`]).stdout).trim()),
  }
  out.runs.push(await v2Run("v2-default", false))
  save()
  out.runs.push(await v2Run("v2-fetchoff", true))
  save()
  out.runs.push(await v1Run("v1-default", false))
  save()
  out.runs.push(await v1Run("v1-fetchoff", true))
} catch (e: any) {
  out.fatal = String(e?.stack ?? e)
}
out.serversStarted = started
save()
console.log("wrote", evidencePath)
process.exit(0)
