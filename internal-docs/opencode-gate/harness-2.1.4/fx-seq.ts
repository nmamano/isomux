// fx: #53146 single-writer check on MIGRATED sessions (task 4840abc5, 2026-10-25).
// Phases (each a separate process so every server start is a fresh boot):
//   ids     <profileDir> <snapDir> <idsJson>             v1 session ids from a stopped snapshot
//   v1seed  <profileDir> <outDir>                         synthetic v1 profile with 1.18.35 (5 sessions x 4 tool turns)
//   migrate <profileDir> <outDir> <idsJson> <realCfg 0|1> start 2.1.4, wait migration completed, stop
//   check   <profileDir> <snapDir> <idsJson> <outJson>    seq check on a stopped db copy
//   turns   <profileDir> <outDir> <idsJson> <realCfg> <a|b>  a = move + 2 turns, b = 1 turn (after restart)
// Never logs transcript content, titles, directories or credential values.
import { Database } from "bun:sqlite"
import { spawn } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { GATE_ROOT, freePort, makeProfile, makeRepo, mockProviderConfig, tapEvents, writeJson, type EventTap, type Mock, type Profile, type Server } from "./common.ts"
import { startServerT } from "./mg-server.ts"
import { startServer2 } from "./cc-start.ts"
import { ERROR_REGEX, grepCount, plantedControl, redact, turn } from "./cc-lib.ts"

const [phase, ...args] = process.argv.slice(2)
const netEnv = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10)
const within = <T>(p: Promise<T>, ms: number, label: string): Promise<T | { outcome: "harness_timeout"; label: string }> =>
  Promise.race([p, Bun.sleep(ms).then(() => ({ outcome: "harness_timeout" as const, label }))])

export async function startMgMock(logPath: string, env: Record<string, string> = {}): Promise<Mock> {
  const port = await freePort()
  const proc = spawn("bun", ["run", join(import.meta.dir, "mg-mock.ts")], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    await Bun.sleep(50)
  }
  return { port, url: `http://127.0.0.1:${port}/v1`, proc, stop: () => proc.kill("SIGKILL") }
}

function snapshot(p: Profile, dest: string) {
  mkdirSync(dest, { recursive: true })
  const src = join(p.data, "opencode", "opencode.db")
  for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, join(dest, "opencode.db" + suf))
  return join(dest, "opencode.db")
}

// Repo-write sentinel for every v1 session directory: mtime of the dir and its
// git dir (hashed keys, no paths in output).
function repoState(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })
  const dirs = [...new Set((db.query("select directory from session").all() as any[]).map((r) => r.directory as string))]
  db.close()
  const st: Record<string, unknown> = {}
  for (const d of dirs) {
    let cur = d
    let git: string | undefined
    while (cur && cur !== "/") { if (existsSync(join(cur, ".git"))) { git = join(cur, ".git"); break } cur = dirname(cur) }
    st[h(d)] = { exists: existsSync(d), dirMtime: existsSync(d) ? statSync(d).mtimeMs : null, gitMtime: git ? statSync(git).mtimeMs : null, gitCache: git && statSync(git).isDirectory() && existsSync(join(git, "opencode")) ? statSync(join(git, "opencode")).mtimeMs : null }
  }
  return st
}
function repoDiff(a: Record<string, unknown>, b: Record<string, unknown>) {
  return { dirs: Object.keys(a).length, changed: Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).length }
}

export function seqCheck(dbPath: string, ids: string[]) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const sessions = (db.query("select id from session_v2").all() as any[]).map((r) => r.id as string)
    const counter = new Map((db.query("select aggregate_id a, seq from event_sequence").all() as any[]).map((r) => [r.a, r.seq as number]))
    const msg = new Map((db.query("select session_id a, max(seq) m, count(*) c from session_message group by session_id").all() as any[]).map((r) => [r.a, r]))
    const ev = new Map((db.query("select aggregate_id a, max(seq) m, count(*) c from event group by aggregate_id").all() as any[]).map((r) => [r.a, r]))
    const cat = { noCounterRow: 0, counterLtMaxMessageSeq: 0, counterEqMaxMessageSeq: 0, counterGtMaxMessageSeq: 0, counterButNoMessages: 0, noCounterNoMessages: 0 }
    const catEv = { counterLtMaxEventSeq: 0, counterEqMaxEventSeq: 0, counterGtMaxEventSeq: 0, noEvents: 0 }
    const per: unknown[] = []
    for (const id of sessions) {
      const c = counter.get(id)
      const m = msg.get(id)
      const e = ev.get(id)
      if (c === undefined) { cat.noCounterRow++; if (!m) cat.noCounterNoMessages++ }
      else if (!m) cat.counterButNoMessages++
      else if (c < m.m) cat.counterLtMaxMessageSeq++
      else if (c === m.m) cat.counterEqMaxMessageSeq++
      else cat.counterGtMaxMessageSeq++
      if (!e) catEv.noEvents++
      else if (c !== undefined) { if (c < e.m) catEv.counterLtMaxEventSeq++; else if (c === e.m) catEv.counterEqMaxEventSeq++; else catEv.counterGtMaxEventSeq++ }
      const idx = ids.indexOf(id)
      per.push({ s: idx >= 0 ? `s${idx + 1}` : `new-${h(id)}`, imported: idx >= 0, eventSequence: c ?? null, maxMessageSeq: m?.m ?? null, messages: m?.c ?? 0, maxEventSeq: e?.m ?? null, events: e?.c ?? 0 })
    }
    const dupMsg = (db.query("select count(*) c from (select session_id, seq from session_message group by session_id, seq having count(*)>1)").get() as any).c
    const dupEv = (db.query("select count(*) c from (select aggregate_id, seq from event group by aggregate_id, seq having count(*)>1)").get() as any).c
    const quick = (db.query("pragma quick_check").all() as any[]).map((r) => Object.values(r)[0])
    const kv = db.query("select value from kv where key='migration.v1-v2'").get() as any
    const violating = per.filter((x: any) => (x.eventSequence === null && (x.maxMessageSeq !== null || x.maxEventSeq !== null)) || (x.eventSequence !== null && ((x.maxMessageSeq !== null && x.eventSequence < x.maxMessageSeq) || (x.maxEventSeq !== null && x.eventSequence < x.maxEventSeq)))).length
    return {
      quickCheck: quick, kvMigrationPhase: kv ? (JSON.parse(kv.value)?.phase ?? "present") : null,
      sessionsV2: sessions.length, importedV1Ids: ids.length, importedPresent: ids.filter((i) => sessions.includes(i)).length,
      vsMaxSessionMessageSeq: cat, vsMaxEventSeq: catEv,
      violatingSessions_ccLibRule: violating, duplicateSessionMessageSeq: dupMsg, duplicateEventSeq: dupEv, perSession: per,
    }
  } finally { db.close() }
}

function logSummary(paths: string[], secrets: string[]) {
  const res: Record<string, unknown> = {}
  for (const f of paths) {
    if (!existsSync(f)) { res[f.split("/").slice(-2).join("/")] = "missing"; continue }
    const t = readFileSync(f, "utf8")
    res[f.split("/").slice(-2).join("/")] = {
      lines: t.split("\n").length,
      seqPatternCount: grepCount([f])[f],
      perPattern: Object.fromEntries(ERROR_REGEX.split("|").map((p) => [p, grepCount([f], p)[f]])),
      errorLevelLines: grepCount([f], "level=ERROR|\"level\":\"error\"")[f],
      firstErrorLines: t.split("\n").filter((l) => /level=ERROR|"level":"error"/.test(l)).slice(0, 5).map((l) => redact(l, secrets).replace(/\/home\/[^\s"]*/g, "[PATH]").slice(0, 300)),
    }
  }
  return res
}

function v2Env(p: Profile, realCfg: string) {
  const env: Record<string, string | undefined> = { ...netEnv }
  // Isomux layout: the profile's own opencode.json is OPENCODE_CONFIG (real copy only).
  env.OPENCODE_CONFIG = realCfg === "1" && existsSync(p.configPath) ? p.configPath : undefined
  return env
}
function v2StartOpts(p: Profile, mock: Mock, realCfg: string, logPath: string) {
  // startServerT sets OPENCODE_CONFIG when <profile>/opencode.json exists; v2Env overrides.
  return { configContent: mockProviderConfig(mock, { small_model: "gate/gate-model" }), env: v2Env(p, realCfg), logPath }
}

async function pollMigration(s: Server) {
  const timeline: any[] = []
  const t0 = Date.now()
  let last: any
  for (let i = 0; i < 3000; i++) {
    const r = await s.api("GET", "/api/experimental/migration/v1")
    last = r.body
    const st = r.body?.status
    if (timeline.at(-1)?.status !== st) timeline.push({ atMs: Date.now() - t0, http: r.status, status: st })
    if (st === "completed" || st === "error") break
    await Bun.sleep(100)
  }
  return { finalStatus: last?.status, error: last?.status === "error" ? String(last?.error).slice(0, 200) : undefined, timeline, ms: Date.now() - t0 }
}

// Auto-replies "once" to every permission.asked on the tap.
function autoPermit(s: Server, tap: EventTap) {
  const seen = new Set<string>()
  const log: any[] = []
  let stop = false
  ;(async () => {
    while (!stop) {
      for (const e of tap.events) {
        if (e.type !== "permission.asked" || seen.has(e.data?.id)) continue
        seen.add(e.data.id)
        const r = await s.api("POST", `/api/session/${e.data.sessionID}/permission/${e.data.id}/reply`, { decision: "once" })
        log.push({ action: e.data.action, reply: r.status })
      }
      await Bun.sleep(50)
    }
  })()
  return { log, stop: () => { stop = true } }
}

function toolEvents(tap: EventTap, from: number, sid: string) {
  const ev = tap.events.slice(from).filter((e) => e.data?.sessionID === sid)
  return {
    called: ev.filter((e) => e.type === "session.tool.called").length,
    success: ev.filter((e) => e.type === "session.tool.success").length,
    failed: ev.filter((e) => e.type === "session.tool.failed").length,
    failedMsg: ev.filter((e) => e.type === "session.tool.failed").map((e) => String(e.data?.error?.message ?? e.data?.error ?? "").replace(/\/[^\s"]*/g, "[PATH]").slice(0, 160)),
  }
}

const gateCall = (tool: string, a: unknown) => `GATE_CALL:${JSON.stringify({ tool, args: a })}`

if (!import.meta.main) {
  // imported as a library (fx-rss.ts)
} else if (phase === "ids") {
  const [profileDir, snapDir, idsJson] = args
  const p = makeProfile(profileDir!)
  const db = new Database(snapshot(p, snapDir!), { readonly: true })
  const ids = (db.query("select id from session order by time_created").all() as any[]).map((r) => r.id)
  db.close()
  writeFileSync(idsJson!, JSON.stringify(ids))
  console.log(JSON.stringify({ v1Sessions: ids.length }))
} else if (phase === "check") {
  const [profileDir, snapDir, idsJson, outJson] = args
  const p = makeProfile(profileDir!)
  const res = seqCheck(snapshot(p, snapDir!), JSON.parse(readFileSync(idsJson!, "utf8")))
  writeJson(outJson!, { date: "2026-10-25", ...res })
  console.log(JSON.stringify({ ...res, perSession: undefined }))
} else if (phase === "migrate") {
  const [profileDir, outDir, idsJson, realCfg] = args
  mkdirSync(outDir!, { recursive: true })
  const p = makeProfile(profileDir!)
  const pre = snapshot(p, join(outDir!, "pre-snap"))
  const repoBefore = repoState(pre)
  const mock = await startMgMock(join(outDir!, "mock.log"), { MOCK_SHELL_TOOL: "shell" })
  const res: any = { date: "2026-10-25", phase, binary: "2.1.4" }
  const t0 = Date.now()
  const s = await startServerT(p, v2StartOpts(p, mock, realCfg!, join(outDir!, "server.log")))
  res.healthyMs = Date.now() - t0
  res.pid = s.pid
  try {
    res.migration = await pollMigration(s)
    const l = await s.api("GET", "/api/session?limit=200")
    const ids: string[] = JSON.parse(readFileSync(idsJson!, "utf8"))
    const vis = new Set((l.body?.data ?? []).map((x: any) => x.id))
    res.sessionList = { http: l.status, count: l.body?.data?.length, importedVisible: ids.filter((i) => vis.has(i)).length, v1Ids: ids.length }
  } catch (e) { res.error = String(e).slice(0, 300) }
  await s.stop("SIGTERM")
  mock.stop()
  res.exit = { code: s.proc.exitCode, signal: s.proc.signalCode }
  res.repoWriteSentinel = repoDiff(repoBefore, repoState(pre))
  res.logs = logSummary([join(outDir!, "server.log"), join(p.data, "opencode", "log", "opencode.log")], [s.password])
  writeJson(join(outDir!, "result.json"), res)
  console.log(JSON.stringify(res))
} else if (phase === "turns") {
  const [profileDir, outDir, idsJson, realCfg, spec] = args
  mkdirSync(outDir!, { recursive: true })
  const p = makeProfile(profileDir!)
  const pre = snapshot(p, join(outDir!, "pre-snap"))
  const repoBefore = repoState(pre)
  const ids: string[] = JSON.parse(readFileSync(idsJson!, "utf8"))
  const mock = await startMgMock(join(outDir!, "mock.log"), { MOCK_SHELL_TOOL: "shell" })
  const res: any = { date: "2026-10-25", phase, spec, binary: "2.1.4", sessions: [] }
  const t0 = Date.now()
  const s = await startServerT(p, v2StartOpts(p, mock, realCfg!, join(outDir!, "server.log")))
  res.healthyMs = Date.now() - t0
  res.pid = s.pid
  const tap = await tapEvents(s, join(outDir!, "events.jsonl"))
  const permit = autoPermit(s, tap)
  try {
    res.migrationStatus = (await s.api("GET", "/api/experimental/migration/v1")).body?.status
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const r: any = { s: `s${i + 1}` }
      const g = await s.api("GET", `/api/session/${id}`)
      r.getHttp = g.status
      let dir: string | undefined = g.body?.data?.location?.directory
      const scratch = join(dirname(profileDir!), `scratch-${spec === "a" ? "" : ""}${h(profileDir!)}-s${i + 1}`)
      if (spec === "a") {
        const gone = !dir || !existsSync(dir)
        const outside = !!dir && !dir.startsWith(`${GATE_ROOT}/`)
        r.folder = gone ? "gone" : outside ? "exists-outside-gate-root" : "exists-under-gate-root"
        if (gone || outside) {
          // Folder gone, or a real directory we must not write into: move to a scratch git repo.
          makeRepo(scratch)
          const mv = await s.api("POST", `/api/session/${id}/move`, { directory: scratch })
          r.move = { http: mv.status, tag: mv.status >= 300 ? mv.body?._tag : undefined }
          // When the source folder still exists, 2.1.4 queues the move in the session
          // inbox and applies it asynchronously (core/src/session/move.ts:129-156); the
          // 204 comes back before the location changes. Wait for it.
          const tm = Date.now()
          r.move.appliedMs = null
          for (let k = 0; k < 300; k++) {
            const gg = await s.api("GET", `/api/session/${id}`)
            if (gg.body?.data?.location?.directory === scratch) { r.move.appliedMs = Date.now() - tm; break }
            await Bun.sleep(100)
          }
          dir = scratch
        }
        const sw = await s.api("POST", `/api/session/${id}/model`, { model: { id: "gate-model", providerID: "gate" } })
        r.modelSwitchHttp = sw.status
      }
      const g2 = await s.api("GET", `/api/session/${id}`)
      dir = g2.body?.data?.location?.directory
      r.locationUnderGateRoot = !!dir && dir.startsWith(`${GATE_ROOT}/`)
      if (!r.locationUnderGateRoot) { r.skipped = "location outside gate root; not writing"; res.sessions.push(r); continue }
      const f = join(dir!, "fx-edit.txt")
      const prompts = spec === "a"
        ? [`fx t1 ${gateCall("shell", { command: `printf original > fx-edit.txt` })}`, `fx t2 ${gateCall("edit", { path: f, oldString: "original", newString: "changed" })}`]
        : [`fx t3 ${gateCall("shell", { command: `printf after-restart >> fx-restart.txt` })}`]
      r.turns = []
      for (const pr of prompts) {
        const from = tap.events.length
        const t: any = await within(turn(s, tap, id, pr, 60_000), 75_000, "turn")
        r.turns.push({ outcome: t.outcome, error: t.error ? JSON.stringify(t.error).replace(/\/[^\s"]*/g, "[PATH]").slice(0, 300) : undefined, ms: t.ms, tools: toolEvents(tap, from, id) })
      }
      r.fileAfter = existsSync(f) ? readFileSync(f, "utf8") : null
      if (spec === "b") r.restartFile = existsSync(join(dir!, "fx-restart.txt")) ? readFileSync(join(dir!, "fx-restart.txt"), "utf8") : null
      res.sessions.push(r)
    }
  } catch (e) { res.error = String(e).slice(0, 300) }
  await Bun.sleep(500)
  permit.stop()
  res.permissionReplies = permit.log
  tap.close()
  await s.stop("SIGTERM")
  mock.stop()
  res.exit = { code: s.proc.exitCode, signal: s.proc.signalCode }
  res.repoWriteSentinel = repoDiff(repoBefore, repoState(pre))
  res.allTurnsSucceeded = res.sessions.every((x: any) => x.turns?.length && x.turns.every((t: any) => t.outcome === "session.execution.succeeded"))
  res.logs = logSummary([join(outDir!, "server.log"), join(p.data, "opencode", "log", "opencode.log")], [s.password])
  writeJson(join(outDir!, "result.json"), res)
  console.log(JSON.stringify({ ...res, sessions: res.sessions.map((x: any) => ({ s: x.s, folder: x.folder, move: x.move, turns: x.turns?.map((t: any) => t.outcome + ":" + JSON.stringify(t.tools)) , file: x.fileAfter, skipped: x.skipped })) }))
} else if (phase === "v1seed") {
  const [profileDir, outDir] = args
  mkdirSync(outDir!, { recursive: true })
  const p = makeProfile(profileDir!)
  const mock = await startMgMock(join(outDir!, "mock.log"), { MOCK_SHELL_TOOL: "bash" })
  // Same seeding as cc-p7a-overlap.ts: models.json cache and a marked plugin SDK dir.
  const mc = join(p.cache, "opencode")
  mkdirSync(mc, { recursive: true })
  copyFileSync(`${GATE_ROOT}/run/cc-seed/models.json`, join(mc, "models.json"))
  const d = join(p.config, "opencode")
  mkdirSync(join(d, "node_modules"), { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "1.18.35" }
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies }))
  writeFileSync(join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }))
  const cfg = join(p.dir, "v1-config.json")
  writeFileSync(cfg, JSON.stringify({
    $schema: "https://opencode.ai/config.json", autoupdate: false, model: "gate/gate-model", small_model: "gate/gate-model", share: "disabled",
    permission: { bash: "allow", edit: "allow" },
    provider: { gate: { name: "Gate mock", npm: "@ai-sdk/openai-compatible", env: [], models: { "gate-model": { name: "Gate model", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } }, options: { apiKey: "GATE_KEY_SENTINEL_7f3a", baseURL: mock.url } } },
  }), { mode: 0o600 })
  const res: any = { date: "2026-10-25", phase, binary: "1.18.35", sessions: [] }
  const t0 = Date.now()
  const s = await startServer2(p, { v1: true, env: { ...netEnv, OPENCODE_CONFIG: cfg }, logPath: join(outDir!, "server.log") })
  res.healthyMs = Date.now() - t0
  res.pid = s.pid
  // 1.18.35 scopes /event to one instance directory: one tap per repo.
  const taps: EventTap[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const repo = makeRepo(join(dirname(profileDir!), `syn-repo-${i + 1}`))
      const tap = await tapEvents(s, join(outDir!, `events-${i + 1}.jsonl`), `/event?directory=${encodeURIComponent(repo)}`)
      taps.push(tap)
      const c = await s.api("POST", `/session?directory=${encodeURIComponent(repo)}`, {})
      const sid = c.body?.id
      const r: any = { s: `s${i + 1}`, createHttp: c.status, turns: [] }
      for (let k = 0; k < 4; k++) {
        const text = k % 2 === 0
          ? `syn ${k} ${gateCall("bash", { command: `printf 'line ${k}\\n' >> syn.txt`, description: "gate" })}`
          : `syn ${k} ${gateCall("write", { filePath: join(repo, `w-${k}.txt`), content: `w ${k}\n` })}`
        const startIdx = tap.events.length
        const pr = await s.api("POST", `/session/${sid}/prompt_async?directory=${encodeURIComponent(repo)}`, { parts: [{ type: "text", text }], model: { providerID: "gate", modelID: "gate-model" } })
        let outcome = pr.status >= 300 ? `prompt_${pr.status}` : "timeout"
        let err = false
        const tt = Date.now()
        while (pr.status < 300 && Date.now() - tt < 60_000) {
          const evs = tap.events.slice(startIdx)
          if (evs.some((e) => e.type === "session.error" && e.properties?.sessionID === sid)) err = true
          if (evs.some((e) => e.type === "session.idle" && e.properties?.sessionID === sid)) { outcome = err ? "idle_after_error" : "idle"; break }
          await Bun.sleep(50)
        }
        const m = await s.api("GET", `/session/${sid}/message?directory=${encodeURIComponent(repo)}`)
        const tools = (Array.isArray(m.body) ? m.body : []).slice(-2).flatMap((x: any) => (x.parts ?? []).filter((q: any) => q.type === "tool").map((q: any) => `${q.tool}:${q.state?.status}`))
        r.turns.push({ outcome, tools })
      }
      r.synFile = existsSync(join(repo, "syn.txt")) ? readFileSync(join(repo, "syn.txt"), "utf8").split("\n").filter(Boolean).length : 0
      res.sessions.push(r)
    }
  } catch (e) { res.error = String(e).slice(0, 300) }
  for (const t of taps) t.close()
  await s.stop("SIGTERM")
  mock.stop()
  res.exit = { code: s.proc.exitCode, signal: s.proc.signalCode }
  writeJson(join(outDir!, "result.json"), res)
  console.log(JSON.stringify(res))
} else {
  throw new Error(`unknown phase ${phase}`)
}
