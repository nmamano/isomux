// mg P8: migration and rollback on a copy of a real office profile.
// Usage: bun run mg-p8.ts <phase> where phase = v2first | v1keep | v1copy1 | v2again
// Never logs transcript content, titles, directories or credential values.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { startServerT as startServer } from "./mg-server.ts"
import { makeProfile, freePort, tapEvents, turnEnded, mockProviderConfig, writeJson, type Mock } from "./common.ts"

const phase = process.argv[2]!
const R = readFileSync("/tmp/t-4840abc5/run/mg-current.txt", "utf8").trim()
const target = process.env.MG_TARGET ?? (phase === "v1keep" ? "keep" : "copy1")
const v1 = phase.startsWith("v1")
const out = join(R, process.env.MG_TARGET ? `p8-${phase}-${process.env.MG_TARGET}` : `p8-${phase}`)
Bun.spawnSync(["mkdir", "-p", out])
const result: Record<string, unknown> = { date: "2026-10-25", phase, target, binary: v1 ? "1.18.35" : "2.1.4" }
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12)

const v1sessions = JSON.parse(readFileSync(join(R, "census", "v1-sessions.json"), "utf8")) as Array<{
  i: number; id: string; global: boolean; child: boolean; dirCat: string; dirExists: boolean; gitAncestor: boolean; msgs: number; parts: number
}>
const SAMPLE = [0, 7, 16, 17, 25]
const CONTINUE = 17

// Repo-write sentinel: for every existing session directory, the git dir's
// mtime and the v1 project-id cache file (<gitdir>/opencode). Keys are hashes.
function repoState() {
  const db = new (require("bun:sqlite").Database)(join(R, "census", "db-copy1-before2", "opencode.db"), { readonly: true })
  const dirs = [...new Set((db.query("SELECT directory FROM session").all() as any[]).map((r) => r.directory as string))]
  db.close()
  const state: Record<string, unknown> = {}
  for (const d of dirs) {
    let cur = d
    let git: string | undefined
    while (cur && cur !== "/") {
      if (existsSync(join(cur, ".git"))) { git = join(cur, ".git"); break }
      cur = dirname(cur)
    }
    if (!git) { state[h(d)] = { git: false, exists: existsSync(d) }; continue }
    const st = statSync(git)
    const cache = join(git, "opencode")
    state[h(d)] = {
      git: true,
      gitIsDir: st.isDirectory(),
      gitMtimeMs: st.mtimeMs,
      cacheExists: st.isDirectory() && existsSync(cache),
      cacheMtimeMs: st.isDirectory() && existsSync(cache) ? statSync(cache).mtimeMs : null,
      cacheSha: st.isDirectory() && existsSync(cache) ? h(readFileSync(cache, "utf8")) : null,
      missingDirExists: existsSync(d),
    }
  }
  return state
}

async function startMgMock(logPath: string, env: Record<string, string> = {}): Promise<Mock> {
  const port = await freePort()
  const proc = spawn("bun", ["run", join(import.meta.dir, "mg-mock.ts")], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    await Bun.sleep(50)
  }
  return { port, url: `http://127.0.0.1:${port}/v1`, proc, stop: () => proc.kill("SIGKILL") }
}
function mockLines(logPath: string) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((j) => j.messageCount !== undefined)
}

const repoBefore = repoState()
const mockLog = join(out, "mock.log")
const mock = await startMgMock(mockLog, { MOCK_SHELL_TOOL: v1 ? "bash" : "shell" })
const p = makeProfile(join(R, target))
// Any outbound HTTP(S) other than loopback goes to a closed port: no real
// provider, models.dev or npm request can leave the host.
const netEnv = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const v1Config = {
  provider: {
    gate: {
      name: "Gate mock",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: { "gate-model": { name: "Gate model", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } },
      options: { apiKey: "mg-fake-key", baseURL: mock.url },
    },
  },
  model: "gate/gate-model",
  small_model: "gate/gate-model",
}
const t0 = Date.now()
const s = await startServer(p, {
  v1,
  configContent: v1 ? v1Config : mockProviderConfig(mock, { small_model: "gate/gate-model" }),
  env: netEnv,
  logPath: join(out, "server.log"),
})
result.healthyAfterMs = Date.now() - t0
try {
  if (!v1) {
    // Migration status poll.
    const timeline: unknown[] = []
    let last: any
    const tm = Date.now()
    for (let i = 0; i < 6000; i++) {
      const r = await s.api("GET", "/api/experimental/migration/v1")
      last = r.body
      const st = r.body?.status ?? r.body?.data?.status
      const prev = timeline.at(-1) as any
      const sig = JSON.stringify({ st, label: r.body?.progress?.label })
      if (!prev || prev.sig !== sig) timeline.push({ sig, atMs: Date.now() - tm, httpStatus: r.status, status: st, progress: r.body?.progress ?? null })
      if (st === "completed" || st === "idle" || st === "error") break
      await Bun.sleep(100)
    }
    result.migration = { finalStatus: last?.status, error: last?.status === "error" ? String(last.error).slice(0, 300) : undefined, pollMsFromHealthy: Date.now() - tm, timeline, firstSeenStatus: (timeline[0] as any)?.status }
    // A second read after done.
    result.migrationSecondRead = (await s.api("GET", "/api/experimental/migration/v1")).body?.status

    // Session list (all pages).
    const all: any[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = await s.api("GET", `/api/session?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      if (r.status !== 200) { result.sessionListError = r.status; break }
      all.push(...r.body.data)
      cursor = r.body.cursor?.next
      if (r.body.data.length < 200 || !cursor) break
    }
    const ids = new Set(all.map((x) => x.id))
    const v1ids = v1sessions.map((x) => x.id)
    const globalOnes = v1sessions.filter((x) => x.global)
    result.sessions = {
      v2ListCount: all.length,
      v1DbCount: v1sessions.length,
      v1IdsVisible: v1ids.filter((id) => ids.has(id)).length,
      v1GlobalCount: globalOnes.length,
      v1GlobalVisible: globalOnes.filter((x) => ids.has(x.id)).length,
      v1GlobalStillProjectGlobal: globalOnes.filter((x) => all.find((y) => y.id === x.id)?.projectID === "global").length,
      v1GlobalRehomed: globalOnes.filter((x) => { const y = all.find((z) => z.id === x.id); return y && y.projectID !== "global" }).length,
      v1NonGitMissingDirCount: v1sessions.filter((x) => !x.gitAncestor).length,
      v1NonGitMissingDirVisible: v1sessions.filter((x) => !x.gitAncestor && ids.has(x.id)).length,
      v1ChildCount: v1sessions.filter((x) => x.child).length,
      v1ChildVisible: v1sessions.filter((x) => x.child && ids.has(x.id)).length,
      perSession: v1sessions.map((x) => { const y = all.find((z) => z.id === x.id); return { i: x.i, global: x.global, dirCat: x.dirCat, gitAncestor: x.gitAncestor, visible: !!y, v2ProjectIsGlobal: y ? y.projectID === "global" : null, v2HasParent: y ? !!y.parentID : null } }),
    }
    // Sample message reads.
    const sample: unknown[] = []
    for (const i of SAMPLE) {
      const v = v1sessions[i]!
      const msgs: any[] = []
      let c: string | undefined
      let status = 0
      for (let k = 0; k < 50; k++) {
        const r = await s.api("GET", `/api/session/${v.id}/message?limit=200&order=asc${c ? `&cursor=${encodeURIComponent(c)}` : ""}`)
        status = r.status
        if (r.status !== 200) break
        msgs.push(...r.body.data)
        c = r.body.cursor?.next
        if (r.body.data.length < 200 || !c) break
      }
      const byType: Record<string, number> = {}
      let contentItems = 0
      for (const m of msgs) {
        byType[m.type] = (byType[m.type] ?? 0) + 1
        if (Array.isArray(m.content)) contentItems += m.content.length
      }
      sample.push({ i, httpStatus: status, v1Messages: v.msgs, v1Parts: v.parts, v2Messages: msgs.length, v2ByType: byType, v2ContentItems: contentItems })
    }
    result.sampleReads = sample
    // Credentials.
    const cr = await s.api("GET", "/api/credential")
    result.credentials = { httpStatus: cr.status, entries: Array.isArray(cr.body?.data) ? cr.body.data.map((e: any) => ({ integrationID: e.integrationID, label: e.label, keys: Object.keys(e).sort(), valueType: e.value?.type ?? e.type ?? null })) : cr.body }
    // Continue one old session.
    const v = v1sessions[CONTINUE]!
    const tap = await tapEvents(s, join(out, "events.jsonl"))
    const sw = await s.api("POST", `/api/session/${v.id}/model`, { model: { id: "gate-model", providerID: "gate" } })
    const before = mockLines(mockLog).length
    const pr = await s.api("POST", `/api/session/${v.id}/prompt`, { text: "GATE_RECALL mg continue" })
    let end: any = null
    try { end = await tap.waitFor(turnEnded(v.id), 60_000) } catch {}
    await Bun.sleep(300)
    const lines = mockLines(mockLog).slice(before)
    const recallLine = lines.find((l) => l.recall)
    const after = await s.api("GET", `/api/session/${v.id}/message?limit=5&order=desc`)
    const answer = JSON.stringify(after.body?.data ?? []).match(/RECALLED:[A-Z0-9_]+/)?.[0] ?? null
    result.continueOldSession = {
      i: CONTINUE, v1Messages: v.msgs, dirCat: v.dirCat, dirExists: v.dirExists, modelSwitchStatus: sw.status, promptStatus: pr.status,
      promptError: pr.status !== 200 ? JSON.stringify(pr.body).slice(0, 300) : undefined,
      turnEnd: end?.type ?? "timeout", turnEndError: end?.type === "session.execution.failed" ? JSON.stringify(end.data).slice(0, 400) : undefined,
      mockRequests: lines.length, mockRecallRequest: recallLine ? { messageCount: recallLine.messageCount, roles: recallLine.roles, historyChars: recallLine.historyChars } : null,
      answerMarker: answer,
      eventTypes: [...new Set(tap.events.map((e) => e.type))],
    }
    tap.close()
    const plug = await s.api("GET", "/api/plugin")
    result.plugins = Array.isArray(plug.body?.data) ? plug.body.data.map((x: any) => ({ id: x.id, source: x.source, status: x.state?.status })) : plug.status
  } else {
    // v1 1.18.35
    const doc = await s.api("GET", "/doc")
    result.v1DocHasExperimentalSession = typeof doc.body === "object" && !!doc.body?.paths?.["/experimental/session"]
    result.v1ExperimentalSessionParams = doc.body?.paths?.["/experimental/session"]?.get?.parameters?.map((x: any) => x.name)
    const list = await s.api("GET", "/experimental/session?limit=1000&roots=false")
    const arr: any[] = Array.isArray(list.body) ? list.body : Array.isArray(list.body?.data) ? list.body.data : Array.isArray(list.body?.items) ? list.body.items : []
    const ids = new Set(arr.map((x) => x.id))
    let getOk = 0
    const getFail: unknown[] = []
    // Per-session GET is off by default: on 2026-10-25 the first v1 run made
    // v1 open an instance per session directory (and write <gitdir>/opencode).
    for (const v of process.env.MG_GET_EACH === "1" ? v1sessions : []) {
      const r = await s.api("GET", `/session/${v.id}`)
      if (r.status === 200 && r.body?.id === v.id) getOk++
      else getFail.push({ i: v.i, status: r.status, err: JSON.stringify(r.body).slice(0, 200) })
    }
    result.sessions = { listHttpStatus: list.status, listShape: Array.isArray(list.body) ? "array" : typeof list.body === "object" ? Object.keys(list.body ?? {}) : typeof list.body, listCount: arr.length, v1DbCount: v1sessions.length, v1IdsVisible: v1sessions.filter((x) => ids.has(x.id)).length, getByIdOk: getOk, getByIdFail: getFail }
    const sample: unknown[] = []
    for (const i of SAMPLE) {
      const v = v1sessions[i]!
      const r = await s.api("GET", `/session/${v.id}/message`)
      const msgs = Array.isArray(r.body) ? r.body : []
      sample.push({ i, httpStatus: r.status, v1DbMessages: v.msgs, v1DbParts: v.parts, apiMessages: msgs.length, apiParts: msgs.reduce((n: number, m: any) => n + (m.parts?.length ?? 0), 0), err: r.status !== 200 ? JSON.stringify(r.body).slice(0, 300) : undefined })
    }
    result.sampleReads = sample
    // Continue one old session through prompt_async; wait for a new assistant message.
    const v = v1sessions[CONTINUE]!
    const before = mockLines(mockLog).length
    const msgsBefore = (await s.api("GET", `/session/${v.id}/message`)).body
    const nBefore = Array.isArray(msgsBefore) ? msgsBefore.length : -1
    // The session's own directory (a deleted /tmp worktree) is gone; the
    // request names a scratch repo under the run dir as the instance directory.
    const scratch = (await import("./common.ts")).makeRepo(join(R, "scratch-repo-v1"))
    const dirQ = process.env.MG_V1_SCRATCH === "0" ? "" : `?directory=${encodeURIComponent(scratch)}`
    result.v1ContinueDirectory = dirQ ? "scratch repo under run dir" : "session default"
    const pr = await s.api("POST", `/session/${v.id}/prompt_async${dirQ}`, { model: { providerID: "gate", modelID: "gate-model" }, parts: [{ type: "text", text: "GATE_RECALL mg continue" }] })
    let answer: string | null = null
    let nAfter = nBefore
    let lastErr: unknown = null
    for (let k = 0; k < 300; k++) {
      await Bun.sleep(200)
      const r = await s.api("GET", `/session/${v.id}/message`)
      if (!Array.isArray(r.body)) { lastErr = { status: r.status, body: JSON.stringify(r.body).slice(0, 200) }; continue }
      nAfter = r.body.length
      const tail = r.body.slice(nBefore)
      const done = tail.find((m: any) => m.info?.role === "assistant" && (m.info?.time?.completed || m.info?.error))
      if (done) {
        answer = JSON.stringify(tail).match(/RECALLED:[A-Z0-9_]+/)?.[0] ?? null
        if (done.info?.error) lastErr = { assistantError: JSON.stringify(done.info.error).slice(0, 300) }
        break
      }
    }
    const lines = mockLines(mockLog).slice(before)
    const recallLine = lines.find((l) => l.recall)
    result.continueOldSession = {
      i: CONTINUE, v1DbMessages: v.msgs, promptStatus: pr.status, promptError: pr.status >= 300 ? JSON.stringify(pr.body).slice(0, 300) : undefined,
      apiMessagesBefore: nBefore, apiMessagesAfter: nAfter, answerMarker: answer, lastErr,
      mockRequests: lines.length, mockRecallRequest: recallLine ? { messageCount: recallLine.messageCount, roles: recallLine.roles, historyChars: recallLine.historyChars } : null,
    }
  }
} catch (e) {
  result.error = String(e).slice(0, 500)
} finally {
  await s.stop()
  mock.stop()
}
result.serverExit = { code: s.proc.exitCode, signal: s.proc.signalCode }
const repoAfter = repoState()
result.repoWriteSentinel = {
  dirs: Object.keys(repoBefore).length,
  changed: Object.keys(repoBefore).filter((k) => JSON.stringify(repoBefore[k]) !== JSON.stringify(repoAfter[k])).map((k) => ({ key: k, before: repoBefore[k], after: repoAfter[k] })),
}
const log = existsSync(join(out, "server.log")) ? readFileSync(join(out, "server.log"), "utf8") : ""
result.serverLog = {
  bytes: log.length,
  lines: log.split("\n").length,
  errorLines: (log.match(/level=ERROR|"level":"error"|\bERROR\b/g) ?? []).length,
  warnLines: (log.match(/level=WARN|"level":"warn"|\bWARN\b/g) ?? []).length,
  migrationLines: (log.match(/[Mm]igrat/g) ?? []).length,
  v1InstancesCreated: (log.match(/message="creating instance"/g) ?? []).length,
  infoLines: (log.match(/level=INFO/g) ?? []).length,
  skippedV1Rows: (log.match(/Skipped V1 migration row/g) ?? []).length,
  reassigned: (log.match(/Reassigned V1 session/g) ?? []).length,
  resolveTimeout: (log.match(/Stopped resolving V1 session directories/g) ?? []).length,
  gateKeyInLog: (log.match(/GATE_KEY_SENTINEL_7f3a/g) ?? []).length,
  fakeKeyInLog: (log.match(/sk-fake-gate/g) ?? []).length,
}
writeJson(join(out, "result.json"), result)
console.log(JSON.stringify(result, null, 1).slice(0, 6000))
