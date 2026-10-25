// P7a overlap (task 4840abc5, 2026-10-25): 1.18.35 and 2.1.4 on the SAME
// profile at the same time. Case "cutover": v1 running, v2 starts. Case
// "rollback-v1origin": v1 profile, v2 migrated it and is running, v1 starts.
// Case "rollback-fresh": v2-only profile running, v1 starts.
// Usage: bun run cc-p7a-overlap.ts <evidencePath>
import { writeFileSync, readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  GATE_ROOT,
  makeProfile,
  makeRepo,
  startMock,
  mockProviderConfig,
  startServer,
  tapEvents,
  createSession,
  type Server,
  type EventTap,
  type Profile,
} from "./common.ts"
import { startServer2 } from "./cc-start.ts"
import { checkDb, turn, grepCount, plantedControl, ERROR_REGEX } from "./cc-lib.ts"

const evidencePath = process.argv[2] ?? `${GATE_ROOT}/evidence/cc-p7a-overlap.json`
const root = `${GATE_ROOT}/run/cc-p7a-${Date.now()}`
mkdirSync(root, { recursive: true })
const log = (...a: any[]) => console.log(new Date().toISOString(), ...a)
const mock = await startMock(join(root, "mock.log"))
// No network: models.dev and npm reach a dead proxy fast (v1 waited ~6 min at boot without this on 2026-10-25).
const netEnv = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const passwords: string[] = []
const started: { label: string; pid: number }[] = []
const servers: Server[] = []
const out: any = { item: "P7a", date: "2026-10-25", runDir: root, v1: "opencode 1.18.35", v2: "opencode 2.1.4", cases: [] }

function v1Config() {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "gate/gate-model",
    small_model: "gate/gate-model",
    share: "disabled",
    provider: {
      gate: {
        name: "Gate mock",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "gate-model": { name: "Gate model", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } },
        },
        options: { apiKey: "GATE_KEY_SENTINEL_7f3a", baseURL: mock.url },
      },
    },
  }
}

// Same as supervisor.ts markPluginSdkInstalled: v1 skips its plugin SDK npm install
// (without it, v1's first request waited ~6 min on 2026-10-25).
function markPluginSdk(p: Profile) {
  // v1 blocks its first requests on the models.dev fetch (models.json landed 6 min
  // after start on 2026-10-25); seed the cache with that fetched copy.
  const mc = join(p.cache, "opencode")
  mkdirSync(mc, { recursive: true })
  if (!existsSync(join(mc, "models.json"))) copyFileSync(`${GATE_ROOT}/run/cc-seed/models.json`, join(mc, "models.json"))
  const d = join(p.config, "opencode")
  if (existsSync(join(d, "node_modules"))) return
  mkdirSync(d, { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "1.18.35" }
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies }))
  writeFileSync(join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }))
  mkdirSync(join(d, "node_modules"))
}

async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T | { outcome: "harness_timeout"; label: string; ms: number }> {
  return Promise.race([p, Bun.sleep(ms).then(() => ({ outcome: "harness_timeout" as const, label, ms }))])
}

async function startV1(p: Profile, label: string) {
  markPluginSdk(p)
  const cfg = join(p.dir, "v1-config.json")
  writeFileSync(cfg, JSON.stringify(v1Config()), { mode: 0o600 })
  const t0 = Date.now()
  try {
    const s = await startServer2(p, { v1: true, env: { ...netEnv, OPENCODE_CONFIG: cfg }, logPath: join(p.dir, `${label}.log`) })
    passwords.push(s.password)
    started.push({ label, pid: s.pid })
    servers.push(s)
    return { ok: true as const, s, ms: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e), ms: Date.now() - t0, logPath: join(p.dir, `${label}.log`) }
  }
}

async function startV2(p: Profile, label: string) {
  const cfg = join(p.dir, "v2-config.json")
  writeFileSync(cfg, JSON.stringify(mockProviderConfig(mock)), { mode: 0o600 })
  const t0 = Date.now()
  try {
    const s = await startServer2(p, { env: { ...netEnv, OPENCODE_CONFIG: cfg }, logPath: join(p.dir, `${label}.log`) })
    passwords.push(s.password)
    started.push({ label, pid: s.pid })
    servers.push(s)
    return { ok: true as const, s, ms: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e), ms: Date.now() - t0, logPath: join(p.dir, `${label}.log`) }
  }
}

// v1 turn: POST /session/:id/prompt_async, wait for session.idle or session.error on /event.
async function v1Session(s: Server, dir: string) {
  const r: any = await within(s.api("POST", `/session?directory=${encodeURIComponent(dir)}`, {}), 60_000, "v1 POST /session")
  if (r.outcome === "harness_timeout") return { status: 0, id: undefined, body: "harness_timeout 60s" }
  return { status: r.status, id: r.body?.id as string | undefined, body: r.status === 200 ? undefined : JSON.stringify(r.body).slice(0, 300) }
}
async function v1Turn(s: Server, tap: EventTap, dir: string, sessionID: string, text: string, timeoutMs = 60_000) {
  return within(v1TurnInner(s, tap, dir, sessionID, text, timeoutMs), timeoutMs + 15_000, "v1 turn")
}
async function v1TurnInner(s: Server, tap: EventTap, dir: string, sessionID: string, text: string, timeoutMs = 60_000) {
  const startIdx = tap.events.length
  const t0 = Date.now()
  const r = await s.api("POST", `/session/${sessionID}/prompt_async?directory=${encodeURIComponent(dir)}`, {
    parts: [{ type: "text", text }],
    model: { providerID: "gate", modelID: "gate-model" },
  })
  if (r.status >= 300) return { outcome: "prompt_rejected", status: r.status, body: JSON.stringify(r.body).slice(0, 300) }
  let error: any
  while (Date.now() - t0 < timeoutMs) {
    for (let i = startIdx; i < tap.events.length; i++) {
      const e = tap.events[i]
      const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID
      if (e.type === "session.error" && sid === sessionID) error = e.properties?.error
      if (e.type === "session.idle" && sid === sessionID) {
        // Final assistant text from the message list.
        const m = await s.api("GET", `/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        const last = Array.isArray(m.body) ? m.body[m.body.length - 1] : undefined
        const texts = (last?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)
        const tools = (last?.parts ?? []).filter((p: any) => p.type === "tool").map((p: any) => `${p.tool}:${p.state?.status}`)
        const allTools = (Array.isArray(m.body) ? m.body : []).slice(-3).flatMap((x: any) => (x.parts ?? []).filter((p: any) => p.type === "tool").map((p: any) => `${p.tool}:${p.state?.status}`))
        return { outcome: error ? "idle_after_error" : "idle", error: error ? JSON.stringify(error).slice(0, 400) : undefined, lastText: texts.join("").slice(0, 120), tools: allTools.length ? allTools : tools, assistantError: last?.info?.error ? JSON.stringify(last.info.error).slice(0, 400) : undefined, ms: Date.now() - t0 }
      }
    }
    if (s.proc.exitCode !== null || s.proc.signalCode !== null) return { outcome: "server_exited" }
    await Bun.sleep(50)
  }
  return { outcome: "timeout", error: error ? JSON.stringify(error).slice(0, 400) : undefined }
}

function exited(s: Server) {
  return { exitCode: s.proc.exitCode, signal: s.proc.signalCode, alive: s.proc.exitCode === null && s.proc.signalCode === null }
}

function dbState(p: Profile, label: string) {
  const src = join(p.data, "opencode", "opencode.db")
  if (!existsSync(src)) return { exists: false }
  const dest = join(root, `dbcopy-${label}`)
  mkdirSync(dest, { recursive: true })
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, join(dest, "opencode.db" + suf))
  const db = new Database(join(dest, "opencode.db"), { readonly: true })
  try {
    const tables = (db.query(`select name from sqlite_master where type='table' order by name`).all() as any[]).map((r) => r.name)
    const count = (t: string) => (tables.includes(t) ? (db.query(`select count(*) c from "${t}"`).get() as any).c : null)
    const v1mig = tables.includes("__drizzle_migrations") ? (db.query(`select count(*) c from __drizzle_migrations`).get() as any).c : null
    const kv = tables.includes("kv") ? (db.query(`select key, substr(value,1,200) v from kv where key like 'migration%'`).all() as any[]) : null
    const sessionCols = tables.includes("session") ? (db.query(`pragma table_info(session)`).all() as any[]).map((c) => c.name).length : null
    const res: any = {
      tables: tables.length,
      hasV1Session: tables.includes("session"),
      hasV1Message: tables.includes("message"),
      hasV2Session: tables.includes("session_v2"),
      rows: { session: count("session"), message: count("message"), part: count("part"), session_v2: count("session_v2"), session_message: count("session_message"), event: count("event"), event_sequence: count("event_sequence") },
      v1DrizzleMigrations: v1mig,
      v2MigrationRows: count("migration"),
      kvMigration: kv,
      v1SessionColumns: sessionCols,
      quickCheck: (db.query(`pragma quick_check`).all() as any[]).map((r) => Object.values(r)[0]),
    }
    db.close()
    if (res.hasV2Session) {
      const c = checkDb(join(dest, "opencode.db"))
      res.seqCheck = { violatingSessions: c.violatingSessions, duplicateSessionMessageSeq: c.duplicateSessionMessageSeq, otherAggregateViolations: c.otherAggregateViolations }
    }
    return res
  } catch (e: any) {
    db.close()
    return { error: String(e) }
  }
}

function logLines(path: string, re: RegExp, max = 25) {
  if (!existsSync(path)) return []
  let lines = readFileSync(path, "utf8").split("\n").filter((l) => re.test(l))
  for (const p of passwords) lines = lines.map((l) => l.split(p).join("[REDACTED]"))
  return lines.slice(0, max).map((l) => l.slice(0, 400))
}

function logSummary(path: string) {
  return {
    file: path,
    lines: existsSync(path) ? readFileSync(path, "utf8").split("\n").length : 0,
    seqPatternCount: grepCount([path])[path],
    errorLevelCount: grepCount([path], "level=ERROR|^ERROR")[path],
    errorLines: logLines(path, /level=ERROR|^ERROR/),
    warnLines: logLines(path, /level=WARN|^WARN/, 10),
    migrationLines: logLines(path, /migrat|bootstrap|v1/i, 15),
  }
}

async function v2Turns(s: Server, tap: EventTap, dir: string, n: number, tag: string) {
  const res: any[] = []
  for (let i = 0; i < n; i++) {
    const ses: any = await within(createSession(s, dir), 60_000, "v2 session.create").catch((e) => ({ outcome: "error", error: String(e).slice(0, 300) }))
    if (!ses.id) {
      res.push({ create: ses })
      continue
    }
    res.push({ session: ses.id.slice(-6), ...(await within(turn(s, tap, ses.id, `${tag}-${i} GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `printf ${tag}-${i} >> v2-${tag}.txt` } })}`, 60_000), 75_000, "v2 turn")) })
  }
  return res
}

async function v1Turns(s: Server, tap: EventTap, dir: string, n: number, tag: string) {
  const res: any[] = []
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const ses = await v1Session(s, dir)
    if (!ses.id) {
      res.push({ create: ses })
      continue
    }
    ids.push(ses.id)
    res.push({ session: ses.id.slice(-6), ...(await v1Turn(s, tap, dir, ses.id, `${tag}-${i} GATE_CALL:${JSON.stringify({ tool: "bash", args: { command: `printf ${tag}-${i} >> v1-${tag}.txt`, description: "gate" } })}`)) })
  }
  return { res, ids }
}

async function v2ListSessions(s: Server) {
  const r = await s.api("GET", "/api/session")
  const items = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.data?.items) ? r.body.data.items : []
  return { status: r.status, count: items.length, ids: items.map((x: any) => x.id as string) }
}

// ---- Case 1: cut-over. v1 live, v2 starts on the same profile.
async function cutover() {
  const c: any = { case: "cutover: 1.18.35 running, 2.1.4 starts on the same profile" }
  const p = makeProfile(join(root, "cutover"))
  const repo = makeRepo(join(root, "cutover", "repo"))
  const a = await startV1(p, "cutover-v1")
  c.v1Start = { ok: a.ok, ms: a.ms, error: a.ok ? undefined : a.error }
  if (!a.ok) return c
  const v1 = a.s
  const v1tap = await tapEvents(v1, join(root, "cutover-v1-events.jsonl"), `/event?directory=${encodeURIComponent(repo)}`)
  const before = await v1Turns(v1, v1tap, repo, 3, "v1pre")
  c.v1TurnsBeforeV2 = before.res
  c.dbBeforeV2 = dbState(p, "cutover-0-v1only-live")
  const b = await startV2(p, "cutover-v2")
  c.v2Start = { ok: b.ok, ms: b.ms, error: b.ok ? undefined : b.error, v1AliveAfterV2Start: exited(v1) }
  if (b.ok) {
    const v2 = b.s
    const v2tap = await tapEvents(v2, join(root, "cutover-v2-events.jsonl"))
    await Bun.sleep(3000) // let the forked v1 import run
    const list = await v2ListSessions(v2)
    c.v2SeesV1Sessions = { listStatus: list.status, v2Count: list.count, v1SessionsVisible: before.ids.filter((id) => list.ids.includes(id)).length, v1SessionsCreated: before.ids.length }
    c.dbAfterV2Start = dbState(p, "cutover-1-both-live")
    // v1's next turn on an existing session, then on a new session.
    c.v1NextTurnExistingSession = before.ids[0]
      ? await v1Turn(v1, v1tap, repo, before.ids[0], `v1post-existing GATE_CALL:${JSON.stringify({ tool: "bash", args: { command: "printf v1post >> v1-post.txt", description: "gate" } })}`)
      : null
    const after = await v1Turns(v1, v1tap, repo, 1, "v1post-new")
    c.v1TurnNewSessionAfterV2 = after.res
    c.v2Turns = await v2Turns(v2, v2tap, repo, 2, "v2live")
    // A turn on an imported v1 session through v2.
    if (before.ids[1] && list.ids.includes(before.ids[1]))
      c.v2TurnOnImportedV1Session = await turn(v2, v2tap, before.ids[1], `v2-on-v1 GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: "printf v2onv1 >> v2-on-v1.txt" } })}`, 60_000)
    c.v1AfterV2Turns = await v1Turn(v1, v1tap, repo, before.ids[2]!, "plain v1 turn after v2 turns")
    const list2 = await v2ListSessions(v2)
    c.v2SeesV1SessionCreatedAfterImport = after.ids.map((id) => list2.ids.includes(id))
    c.aliveBeforeStop = { v1: exited(v1), v2: exited(v2) }
    v2tap.close()
    await v2.stop()
  }
  v1tap.close()
  await v1.stop()
  c.dbAfterBothStopped = dbState(p, "cutover-2-stopped")
  c.logs = { v1: logSummary(join(p.dir, "cutover-v1.log")), v2: logSummary(join(p.dir, "cutover-v2.log")) }
  // v1 alone again on the migrated db: the real rollback after a cut-over.
  const r = await startV1(p, "cutover-v1-again")
  c.v1RestartAloneAfterMigration = { ok: r.ok, ms: r.ms, error: r.ok ? undefined : r.error }
  if (r.ok) {
    const t = await tapEvents(r.s, join(root, "cutover-v1again-events.jsonl"), `/event?directory=${encodeURIComponent(repo)}`)
    const l = await r.s.api("GET", `/session?directory=${encodeURIComponent(repo)}`)
    c.v1RestartAloneAfterMigration.sessionList = { status: l.status, count: Array.isArray(l.body) ? l.body.length : null }
    c.v1RestartAloneAfterMigration.turnExisting = before.ids[0] ? await v1Turn(r.s, t, repo, before.ids[0], "plain v1 turn on old session") : null
    c.v1RestartAloneAfterMigration.turnNew = (await v1Turns(r.s, t, repo, 1, "v1again")).res
    t.close()
    await r.s.stop()
  }
  c.logs.v1Again = logSummary(join(p.dir, "cutover-v1-again.log"))
  c.dbFinal = dbState(p, "cutover-3-final")
  return c
}

// ---- Case 2: rollback. v2 live on a profile, v1 starts on it.
async function rollback(v1Origin: boolean) {
  const name = v1Origin ? "rollback-v1origin" : "rollback-fresh"
  const c: any = { case: v1Origin ? "rollback: v1 profile migrated by 2.1.4; 2.1.4 running, 1.18.35 starts" : "rollback: fresh 2.1.4 profile; 2.1.4 running, 1.18.35 starts" }
  const p = makeProfile(join(root, name))
  const repo = makeRepo(join(root, name, "repo"))
  let v1ids: string[] = []
  if (v1Origin) {
    const a = await startV1(p, `${name}-v1-seed`)
    c.v1SeedStart = { ok: a.ok, ms: a.ms, error: a.ok ? undefined : a.error }
    if (a.ok) {
      const t = await tapEvents(a.s, join(root, `${name}-v1seed-events.jsonl`), `/event?directory=${encodeURIComponent(repo)}`)
      const r = await v1Turns(a.s, t, repo, 2, "v1seed")
      c.v1SeedTurns = r.res
      v1ids = r.ids
      t.close()
      await a.s.stop()
    }
  }
  const b = await startV2(p, `${name}-v2`)
  c.v2Start = { ok: b.ok, ms: b.ms, error: b.ok ? undefined : b.error }
  if (!b.ok) return c
  const v2 = b.s
  const v2tap = await tapEvents(v2, join(root, `${name}-v2-events.jsonl`))
  await Bun.sleep(3000)
  c.v2TurnsBeforeV1 = await v2Turns(v2, v2tap, repo, 3, "v2pre")
  c.dbBeforeV1 = dbState(p, `${name}-0-v2-live`)
  const a = await startV1(p, `${name}-v1`)
  c.v1Start = { ok: a.ok, ms: a.ms, error: a.ok ? undefined : a.error, v2AliveAfterV1Start: exited(v2) }
  if (a.ok) {
    const v1 = a.s
    const v1tap = await tapEvents(v1, join(root, `${name}-v1-events.jsonl`), `/event?directory=${encodeURIComponent(repo)}`)
    const l = await v1.api("GET", `/session?directory=${encodeURIComponent(repo)}`)
    c.v1SessionList = { status: l.status, count: Array.isArray(l.body) ? l.body.length : null, body: Array.isArray(l.body) ? undefined : JSON.stringify(l.body).slice(0, 300) }
    if (v1ids[0]) c.v1TurnOnOwnOldSession = await v1Turn(v1, v1tap, repo, v1ids[0], "plain v1 turn on old session")
    c.v1TurnsWhileV2Live = (await v1Turns(v1, v1tap, repo, 2, "v1live")).res
    c.v2TurnsAfterV1 = await v2Turns(v2, v2tap, repo, 2, "v2post")
    c.dbBothLive = dbState(p, `${name}-1-both-live`)
    c.aliveBeforeStop = { v1: exited(v1), v2: exited(v2) }
    v1tap.close()
    await v1.stop()
  } else {
    c.v1StartLogTail = logLines(join(p.dir, `${name}-v1.log`), /./, 40)
  }
  v2tap.close()
  await v2.stop()
  c.dbAfterBothStopped = dbState(p, `${name}-2-stopped`)
  c.logs = {
    v1Seed: v1Origin ? logSummary(join(p.dir, `${name}-v1-seed.log`)) : undefined,
    v2: logSummary(join(p.dir, `${name}-v2.log`)),
    v1: logSummary(join(p.dir, `${name}-v1.log`)),
  }
  // Can v2 still start after v1 touched the db?
  const again = await startV2(p, `${name}-v2-again`)
  c.v2RestartAfterV1 = { ok: again.ok, ms: again.ms, error: again.ok ? undefined : again.error }
  if (again.ok) {
    const t = await tapEvents(again.s, join(root, `${name}-v2again-events.jsonl`))
    c.v2RestartAfterV1.turns = await v2Turns(again.s, t, repo, 1, "v2again")
    t.close()
    await again.s.stop()
  }
  c.logs.v2Again = logSummary(join(p.dir, `${name}-v2-again.log`))
  c.dbFinal = dbState(p, `${name}-3-final`)
  return c
}

process.on("SIGTERM", async () => {
  for (const s of servers) s.proc.kill("SIGKILL")
  mock.stop()
  save()
  process.exit(1)
})
function save() {
  let text = JSON.stringify(out, null, 2)
  for (const p of passwords) text = text.split(p).join("[REDACTED]")
  text = text.split("GATE_KEY_SENTINEL_7f3a").join("[GATE_KEY_SENTINEL]")
  writeFileSync(evidencePath, text + "\n")
}
// ---- Case 3: both live, alternating turns on the SAME v1-created session.
async function alternate() {
  const c: any = { case: "both live: alternate 1.18.35 and 2.1.4 turns on one v1-created session (imported by 2.1.4)" }
  const p = makeProfile(join(root, "alternate"))
  const repo = makeRepo(join(root, "alternate", "repo"))
  const a = await startV1(p, "alternate-v1")
  if (!a.ok) return { ...c, v1Start: a }
  const v1 = a.s
  const v1tap = await tapEvents(v1, join(root, "alternate-v1-events.jsonl"), `/event?directory=${encodeURIComponent(repo)}`)
  const seed = await v1Turns(v1, v1tap, repo, 1, "seed")
  const S = seed.ids[0]!
  c.seed = seed.res
  const b = await startV2(p, "alternate-v2")
  if (!b.ok) return { ...c, v2Start: b }
  const v2 = b.s
  const v2tap = await tapEvents(v2, join(root, "alternate-v2-events.jsonl"))
  await Bun.sleep(3000)
  c.dbAfterImport = dbState(p, "alternate-0-import")
  c.rounds = []
  for (let r = 0; r < 4; r++) {
    const x = await v1Turn(v1, v1tap, repo, S, `alt-v1-${r} GATE_CALL:${JSON.stringify({ tool: "bash", args: { command: `printf v1-${r} >> alt.txt`, description: "gate" } })}`)
    const y = await within(turn(v2, v2tap, S, `alt-v2-${r} GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `printf v2-${r} >> alt.txt` } })}`, 60_000), 75_000, "v2 turn")
    c.rounds.push({ r, v1: x, v2: y })
  }
  // Does each side see the other's turns?
  const m1 = await v1.api("GET", `/session/${S}/message?directory=${encodeURIComponent(repo)}`)
  const m2 = await v2.api("GET", `/api/session/${S}/message`)
  const l2 = Array.isArray(m2.body?.data) ? m2.body.data : Array.isArray(m2.body?.data?.items) ? m2.body.data.items : []
  c.historyCounts = { v1Messages: Array.isArray(m1.body) ? m1.body.length : null, v2Messages: l2.length }
  c.aliveBeforeStop = { v1: exited(v1), v2: exited(v2) }
  v1tap.close(); v2tap.close()
  await v2.stop(); await v1.stop()
  c.dbAfterBothStopped = dbState(p, "alternate-1-stopped")
  c.logs = { v1: logSummary(join(p.dir, "alternate-v1.log")), v2: logSummary(join(p.dir, "alternate-v2.log")) }
  c.eventStreamSeqPattern = grepCount([join(root, "alternate-v1-events.jsonl"), join(root, "alternate-v2-events.jsonl")])
  return c
}
if (process.argv[3] === "alternate") {
  try { out.cases.push(await alternate()) } catch (e: any) { out.fatal = String(e?.stack ?? e) } finally { for (const s of servers) await s.stop().catch(() => {}); mock.stop() }
  out.grepControl = plantedControl(root)
  out.serversStarted = started
  save()
  process.exit(0)
}
try {
  out.cases.push(await cutover())
  save()
  log("cutover done")
  out.cases.push(await rollback(true))
  save()
  log("rollback v1origin done")
  out.cases.push(await rollback(false))
  log("rollback fresh done")
} catch (e: any) {
  out.fatal = String(e?.stack ?? e)
  log("FATAL", e)
} finally {
  for (const s of servers) await s.stop().catch(() => {})
  mock.stop()
}
out.grepControl = plantedControl(root)
out.grepRegex = ERROR_REGEX
out.serversStarted = started
let text = JSON.stringify(out, null, 2)
for (const p of passwords) text = text.split(p).join("[REDACTED]")
text = text.split("GATE_KEY_SENTINEL_7f3a").join("[GATE_KEY_SENTINEL]")
writeFileSync(evidencePath, text + "\n")
log("wrote", evidencePath)
process.exit(0)
