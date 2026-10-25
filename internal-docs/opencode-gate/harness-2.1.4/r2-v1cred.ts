// r2 Probe B (task 4840abc5, 2026-10-25): v1 credential baseline.
// 1.18.35 started like Isomux (OPENCODE_SERVER_USERNAME=isomux, OPENCODE_SERVER_PASSWORD,
// HOME/XDG in the profile) with a FAKE data/opencode/auth.json and the mock provider.
// (1) bash tool: do the server's auth env vars reach the tool? (counts only)
// (2) does any GET route return the stored key? (counts only). Same check on 2.1.4.
// Usage: bun run r2-v1cred.ts <runDir> <evidencePath>
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, type Server, type EventTap } from "./common.ts"
import { startServer2 } from "./cc-start.ts"
import { tapAs, rawGet, countOf, markPluginSdkOnly, list } from "./r2-lib.ts"

const root = process.argv[2]!
const evidencePath = process.argv[3]!
mkdirSync(root, { recursive: true })
const SENT = "sk-fakegate-v1cred-0001"
const GATE = "GATE_KEY_SENTINEL_7f3a"
const USER = "isomux"
const passwords: string[] = []
const started: any[] = []
const mock = await startMock(join(root, "mock.log"))
started.push({ label: "mock", pid: mock.proc.pid })
const out: any = {
  item: "r2 Probe B: v1 credential baseline (1.18.35) and 2.1.4 comparison",
  date: "2026-10-25",
  runDir: root,
  method: [
    "1.18.35 env as Isomux start-server.ts:286-306 (HOME/XDG_* in the profile, OPENCODE_CONFIG=<profile>/v1-config.json, OPENCODE_DISABLE_AUTOUPDATE=1, OPENCODE_DISABLE_SHARE=1, OPENCODE_SERVER_USERNAME=isomux, OPENCODE_SERVER_PASSWORD=gate-pw-<uuid>); --port explicit (startServer2) instead of 0; real network; plugin SDK marked installed like config-layers.ts markPluginSdkInstalled.",
    "Fake credential planted before first start: <profile>/data/opencode/auth.json = {openai:{type:api,key:<fake sentinel sk-fakegate-v1cred-0001>}}, mode 0600.",
    "Mock provider 'gate' in v1 config with options.apiKey GATE_KEY_SENTINEL_7f3a (used as a positive control for the response scan).",
    "(1) One turn: POST /session?directory=<repo>, POST /session/:id/prompt_async with GATE_CALL bash `env | grep -c '^PATH=' > c0.txt; env | grep -c OPENCODE_SERVER_PASSWORD > c1.txt; env | grep -c OPENCODE_SERVER_USERNAME > c2.txt` (c0 = control, a var that must be present); wait for session.idle on /event; read the three files (integers only).",
    "(2) GET /doc -> every GET path. Called: paths with no path params, and paths whose only path params are the session id (filled with the probe session). Each called with ?directory=<repo>, Basic isomux:<pw>, read bounded to 4 s (SSE routes give what arrived). Count of the fake key and of GATE_KEY_SENTINEL_7f3a in each body. Bodies are not saved.",
    "2.1.4: fresh profile, same auth.json planted before first start, no provider config; GET /api/credential, /api/provider, /api/config (+ /api/integration) with Basic opencode:<pw>; count of the fake key in each body.",
  ],
}

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
        models: { "gate-model": { name: "Gate model", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } },
        options: { apiKey: GATE, baseURL: mock.url },
      },
    },
  }
}

function plantAuth(p: any) {
  const d = join(p.data, "opencode")
  mkdirSync(d, { recursive: true })
  const f = join(d, "auth.json")
  writeFileSync(f, JSON.stringify({ openai: { type: "api", key: SENT } }), { mode: 0o600 })
  chmodSync(f, 0o600)
  return { path: "<profile>/data/opencode/auth.json", mode: (statSync(f).mode & 0o777).toString(8), sentinelCountInFile: countOf(readFileSync(f, "utf8"), SENT) }
}

async function v1Turn(s: Server, tap: EventTap, dir: string, sessionID: string, text: string, timeoutMs = 90_000) {
  const startIdx = tap.events.length
  const t0 = Date.now()
  const r = await s.api("POST", `/session/${sessionID}/prompt_async?directory=${encodeURIComponent(dir)}`, {
    parts: [{ type: "text", text }],
    model: { providerID: "gate", modelID: "gate-model" },
  })
  if (r.status >= 300) return { outcome: "prompt_rejected", status: r.status }
  while (Date.now() - t0 < timeoutMs) {
    for (let i = startIdx; i < tap.events.length; i++) {
      const e = tap.events[i]
      const sid = e.properties?.sessionID ?? e.properties?.info?.sessionID
      if (e.type === "session.idle" && sid === sessionID) {
        const m = await s.api("GET", `/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        const msgs = Array.isArray(m.body) ? m.body : []
        const tools = msgs.flatMap((x: any) => (x.parts ?? []).filter((p: any) => p.type === "tool").map((p: any) => `${p.tool}:${p.state?.status}`))
        const last = msgs[msgs.length - 1]
        const text = (last?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("").slice(0, 60)
        return { outcome: "idle", tools, lastText: text, ms: Date.now() - t0 }
      }
    }
    await Bun.sleep(50)
  }
  return { outcome: "timeout" }
}

async function v1Probe() {
  const r: any = {}
  const p = makeProfile(join(root, "v1"))
  const repo = makeRepo(join(root, "v1", "repo"))
  markPluginSdkOnly(p)
  r.auth = plantAuth(p)
  const cfg = join(p.dir, "v1-config.json")
  writeFileSync(cfg, JSON.stringify(v1Config()), { mode: 0o600 })
  const s = await startServer2(p, {
    v1: true,
    cwd: p.dir,
    logPath: join(p.dir, "server.log"),
    env: { GATE_API_KEY: undefined, OPENCODE_CONFIG: cfg, OPENCODE_DISABLE_SHARE: "1", OPENCODE_SERVER_USERNAME: USER },
  })
  passwords.push(s.password)
  started.push({ label: "v1 1.18.35", pid: s.pid })
  try {
    const tap = await tapAs(s, USER, join(root, "v1-events.jsonl"), `/event?directory=${encodeURIComponent(repo)}`)
    // Did 1.18.35 load the planted credential? (provider ids only)
    const prov = await s.api("GET", `/provider?directory=${encodeURIComponent(repo)}`)
    r.providerConnected = prov.body?.connected
    const ses = await s.api("POST", `/session?directory=${encodeURIComponent(repo)}`, {})
    const sid = ses.body?.id as string
    r.session = { status: ses.status, created: !!sid }
    const cmd = "env | grep -c '^PATH=' > c0.txt; env | grep -c OPENCODE_SERVER_PASSWORD > c1.txt; env | grep -c OPENCODE_SERVER_USERNAME > c2.txt"
    r.turn = await v1Turn(s, tap, repo, sid, `r2-env GATE_CALL:${JSON.stringify({ tool: "bash", args: { command: cmd, description: "gate" } })}`)
    const read = (f: string) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8").trim() : "missing")
    r.envCounts = { c0_PATH_control: read("c0.txt"), c1_OPENCODE_SERVER_PASSWORD: read("c1.txt"), c2_OPENCODE_SERVER_USERNAME: read("c2.txt") }
    // Routes.
    const doc = await rawGet(s.base, USER, s.password, "/doc", 10_000)
    let spec: any = {}
    try {
      spec = JSON.parse(doc.text)
    } catch {}
    r.doc = { status: doc.status, bytes: doc.bytes, openapi: spec.openapi, paths: Object.keys(spec.paths ?? {}).length }
    const gets = Object.entries(spec.paths ?? {})
      .filter(([, v]: any) => v.get)
      .map(([k, v]: any) => ({ path: k, params: (v.get.parameters ?? []).filter((x: any) => x.in === "path").map((x: any) => x.name), requiredQuery: (v.get.parameters ?? []).filter((x: any) => x.in === "query" && x.required).map((x: any) => x.name) }))
    r.getRoutes = gets.map((g) => g.path)
    const extra = ["/provider", "/config", "/config/providers", "/auth", "/provider/auth"]
    const rows: any[] = []
    const seen = new Set<string>()
    const targets = [...gets, ...extra.filter((e) => !gets.some((g) => g.path === e)).map((e) => ({ path: e, params: [], requiredQuery: [], notInDoc: true }))]
    for (const g of targets as any[]) {
      const sessionParams = g.params.filter((n: string) => /^(sessionID|id)$/.test(n) && /session/.test(g.path))
      if (g.params.length && sessionParams.length !== g.params.length) {
        rows.push({ path: g.path, called: false, reason: `path params ${g.params.join(",")}` })
        continue
      }
      let path = g.path as string
      for (const n of sessionParams) path = path.replace(`{${n}}`, sid).replace(`:${n}`, sid)
      if (seen.has(path)) continue
      seen.add(path)
      const q = `${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(repo)}`
      const res = await rawGet(s.base, USER, s.password, path + q, 4000)
      rows.push({
        path: g.path,
        called: true,
        notInDoc: g.notInDoc || undefined,
        requiredQuery: g.requiredQuery.length ? g.requiredQuery : undefined,
        status: res.status,
        bytes: res.bytes,
        note: res.note,
        fakeKeyCount: countOf(res.text, SENT),
        gateKeyControlCount: countOf(res.text, GATE),
      })
    }
    r.routeScan = rows
    r.routeScanSummary = {
      routesInDoc: gets.length,
      called: rows.filter((x) => x.called).length,
      skipped: rows.filter((x) => !x.called).length,
      routesWithFakeKey: rows.filter((x) => x.fakeKeyCount > 0).map((x) => x.path),
      routesWithGateKeyControl: rows.filter((x) => x.gateKeyControlCount > 0).map((x) => x.path),
    }
    tap.close()
  } finally {
    await s.stop()
  }
  r.exited = s.proc.exitCode !== null || s.proc.signalCode !== null
  return r
}

async function v2Probe() {
  const r: any = {}
  const p = makeProfile(join(root, "v2"))
  r.auth = plantAuth(p)
  const s = await startServer2(p, { logPath: join(p.dir, "server.log"), env: { GATE_API_KEY: undefined } })
  passwords.push(s.password)
  started.push({ label: "v2 2.1.4", pid: s.pid })
  try {
    await Bun.sleep(2000)
    const rows: any[] = []
    for (const path of ["/api/credential", "/api/provider", "/api/config", "/api/integration"]) {
      const res = await rawGet(s.base, "opencode", s.password, path, 5000)
      let ids: any
      try {
        const j = JSON.parse(res.text)
        if (path === "/api/credential") ids = list(j).map((c: any) => c.integrationID ?? c.integration_id ?? c.id)
        if (path === "/api/provider") ids = list(j).map((c: any) => c.id)
        if (path === "/api/integration") ids = list(j).filter((c: any) => (c.connections ?? []).length).map((c: any) => c.id)
      } catch {}
      rows.push({ path, status: res.status, bytes: res.bytes, fakeKeyCount: countOf(res.text, SENT), ids })
    }
    r.routeScan = rows
  } finally {
    await s.stop()
  }
  r.exited = s.proc.exitCode !== null || s.proc.signalCode !== null
  return r
}

function save() {
  let text = JSON.stringify(out, null, 2)
  for (const pw of passwords) text = text.split(pw).join("[REDACTED]")
  writeFileSync(evidencePath, text + "\n")
}
try {
  out.v1 = await v1Probe()
  save()
  out.v2 = await v2Probe()
} catch (e: any) {
  out.fatal = String(e?.stack ?? e)
} finally {
  mock.stop()
}
out.processesStarted = started
save()
console.log("wrote", evidencePath)
process.exit(0)
