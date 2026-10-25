// pm P4: config layers. (a) project config vs Isomux rules, (b) /etc/opencode, (c) env vars.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { makeProfile, startMock, mockProviderConfig, startServer, tapEvents, createSession, GATE_ROOT, HARNESS, type Server } from "./common.ts"
import { isomuxV2Config, gateCall, runCall, redact } from "./pm-lib.ts"

const root = `${GATE_ROOT}/run/pm-p4-${Date.now()}`
mkdirSync(root, { recursive: true })
const only = process.argv[2] // optional: run one part
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=gate@example.com", "-c", "user.name=gate", ...args], { cwd }).exitCode
function uniqueRepo(dir: string, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  writeFileSync(`${dir}/README.md`, `gate repo ${dir} ${Date.now()}\n`)
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(`${dir}/${f}`.replace(/\/[^/]*$/, ""), { recursive: true })
    writeFileSync(`${dir}/${f}`, c)
  }
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const passwords: string[] = []
const servers: Server[] = []
const out: any = { date: "2026-10-25", opencode: "2.1.4", item: "P4", parts: {} }
const iso = isomuxV2Config("proposed")
const base = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "ask" },
]
const outside = `${root}/outside`
mkdirSync(outside, { recursive: true })
writeFileSync(`${outside}/secret.txt`, "outside-file\n")

async function boot(name: string, opts: Parameters<typeof startServer>[1] = {}) {
  const p = makeProfile(`${root}/${name}`)
  const s = await startServer(p, { cwd: mkcwd(name), logPath: `${root}/${name}/server.log`, ...opts })
  passwords.push(s.password)
  servers.push(s)
  return { p, s }
}
function mkcwd(name: string) {
  const d = `${root}/cwd-${name}`
  mkdirSync(d, { recursive: true })
  return d
}
async function pollAgents(s: Server, dir: string, want: (ids: string[]) => boolean, ms = 15000) {
  const t0 = Date.now()
  let ids: string[] = []
  let first: string[] | null = null
  let body: any
  while (Date.now() - t0 < ms) {
    const r = await s.api("GET", "/api/agent", undefined, dir)
    body = r.body?.data ?? r.body
    ids = Array.isArray(body) ? body.map((a: any) => a.id) : []
    if (!first) first = ids
    if (want(ids)) return { ok: true, ms: Date.now() - t0, firstResponseIds: first, ids, body }
    await Bun.sleep(100)
  }
  return { ok: false, ms: Date.now() - t0, firstResponseIds: first, ids, body }
}
const docs = async (s: Server, dir?: string) => {
  const r = await s.api("GET", "/api/config", undefined, dir)
  return Array.isArray(r.body) ? r.body.map((d: any) => ({ type: d.type, path: d.path ?? null, keys: d.info ? Object.keys(d.info) : undefined })) : r.body
}

// (a) project config against Isomux's rules.
async function partA() {
  const res: any = { method: "Isomux 'proposed' v2 config in OPENCODE_CONFIG + OPENCODE_CONFIG_CONTENT; a repo per case with project config; GATE_CALL per action, every ask answered once; with and without Isomux rules in POST /api/session {permissions}.", cases: {} }
  const { s, p } = await boot("a", { config: { ...mockProviderConfig(mock), ...iso }, configContent: iso })
  const tap = await tapEvents(s, `${root}/a/events.jsonl`)
  // Agent catalog race: GET /api/agent on a directory no session has opened yet.
  const fresh = uniqueRepo(`${root}/a-fresh`)
  res.agentCatalog = await pollAgents(s, fresh, (ids) => ids.includes("isomux-cron"))
  res.agentCatalog.body = undefined
  const md = `---\ndescription: project override of an Isomux agent\nmode: primary\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: allow\n---\nproject agent body\n`
  const cases: Record<string, { files: Record<string, string>; agent: string; calls: string[] }> = {
    A_project_toplevel_shell_allow: { files: { "opencode.json": JSON.stringify({ permissions: [{ action: "shell", resource: "*", effect: "allow" }] }) }, agent: "build", calls: ["shell", "write", "question", "ext_read"] },
    B_project_agents_build_allow_all: { files: { "opencode.json": JSON.stringify({ agents: { build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } } }) }, agent: "build", calls: ["shell", "write", "question", "ext_read"] },
    C_project_agent_md_isomux_cron_allow_all: { files: { ".opencode/agents/isomux-cron.md": md }, agent: "isomux-cron", calls: ["shell", "write", "question", "subagent", "ext_read"] },
    D_project_default_agent_and_own_agent: { files: { "opencode.json": JSON.stringify({ default_agent: "proj", agents: { proj: { mode: "primary", description: "project agent", permissions: [{ action: "*", resource: "*", effect: "allow" }] } } }) }, agent: "", calls: ["shell"] },
  }
  const callArgs: Record<string, [string, any]> = {
    shell: ["shell", { command: "printf a > p4a.txt" }],
    write: ["write", { path: "p4a-write.txt", content: "x" }],
    question: ["question", { questions: [{ header: "Gate", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }] }],
    subagent: ["subagent", { agent: "general", description: "sub", prompt: "say hi" }],
    ext_read: ["read", { path: `${outside}/secret.txt` }],
  }
  for (const [name, c] of Object.entries(cases)) {
    const repo = uniqueRepo(`${root}/a-${name}`, c.files)
    const r: any = { agent: c.agent || "(none: default_agent)", top_only: {}, with_session_rules: {} }
    for (const mode of ["top_only", "with_session_rules"] as const) {
      for (const call of c.calls) {
        const extra: any = c.agent ? { agent: c.agent } : {}
        if (mode === "with_session_rules") extra.permissions = c.agent === "isomux-cron" ? [...base, { action: "subagent", resource: "*", effect: "deny" }] : base
        const ses = await createSession(s, repo, extra)
        const got = await runCall(s, tap, ses.id, gateCall(...callArgs[call]), { reply: "once" })
        r[mode][call] = got.outcome
        if (call === c.calls[0] && mode === "top_only") r.sessionAgent = (await s.api("GET", `/api/session/${ses.id}`)).body?.data?.agent ?? null
        console.log("A", name, mode, call, got.outcome)
      }
    }
    const ag = await pollAgents(s, repo, (ids) => ids.includes("isomux-cron"))
    const list = Array.isArray(ag.body) ? ag.body : []
    r.effectiveAgentRules = Object.fromEntries(list.filter((a: any) => [c.agent || "build", "proj"].includes(a.id)).map((a: any) => [a.id, a.permissions]))
    r.configDocuments = await docs(s, repo)
    res.cases[name] = r
  }
  tap.close()
  await s.stop()
  out.parts.a = res
}

// (b) /etc/opencode under strace.
async function partB() {
  const res: any = { etcExists: existsSync("/etc/opencode"), method: "server started via harness/pm-strace-wrap.sh (strace -f -e trace=%file), one session opened in a repo, then grep the trace" }
  const trace = `${root}/b/strace.txt`
  mkdirSync(`${root}/b`, { recursive: true })
  const { s } = await boot("b", { bin: `${HARNESS}/pm-strace-wrap.sh`, env: { PM_STRACE_OUT: trace }, config: mockProviderConfig(mock) })
  const repo = uniqueRepo(`${root}/b-repo`)
  await createSession(s, repo)
  await pollAgents(s, repo, (ids) => ids.includes("build"))
  await Bun.sleep(1500)
  await s.stop()
  await Bun.sleep(500)
  const t = readFileSync(trace, "utf8").split("\n")
  res.traceLines = t.length
  res.etcOpencodeLines = t.filter((l) => l.includes("/etc/opencode")).map((l) => l.replace(/^\d+\s+/, ""))
  res.etcOpencodeCount = res.etcOpencodeLines.length
  res.controlProjectOpencodeJsonCount = t.filter((l) => l.includes(`${repo}/opencode.json`)).length
  out.parts.b = res
}

// (c) env vars.
async function partC() {
  const res: any = {}
  // c1 OPENCODE_CONFIG: provider only in a file outside the cwd and the repo.
  {
    const dir = `${root}/c1-file`
    mkdirSync(dir, { recursive: true })
    const file = `${dir}/isomux-config.json`
    writeFileSync(file, JSON.stringify(mockProviderConfig(mock)))
    const r: any = {}
    for (const withFile of [true, false]) {
      const { s } = await boot(`c1-${withFile}`, { env: { OPENCODE_CONFIG: withFile ? file : undefined } })
      const tap = await tapEvents(s, `${root}/c1-${withFile}/events.jsonl`)
      const repo = uniqueRepo(`${root}/c1-repo-${withFile}`)
      const ses = await createSession(s, repo)
      const mockHits = () => readFileSync(`${root}/mock.log`, "utf8").split("\n").filter((l) => l.includes("C1_MARKER")).length
      const before = mockHits()
      const got = await runCall(s, tap, ses.id, "hello C1_MARKER", { timeoutMs: 20000 })
      const mockRequestsWithMarker = mockHits() - before
      const text = tap.events.filter((e) => e.type === "session.text.ended" && e.data?.sessionID === ses.id).map((e) => e.data?.text).join("")
      const failed = tap.events.find((e) => e.type === "session.execution.failed" && e.data?.sessionID === ses.id)
      r[withFile ? "withOPENCODE_CONFIG" : "control_without"] = { end: got.end, mockRequestsWithMarker, answerHasMarker: /ANSWER:hello C1_MARKER/.test(text), failure: failed?.data?.error?.message?.slice(0, 200) ?? failed?.data?.error?.type ?? null, documents: await docs(s, repo) }
      tap.close()
      await s.stop()
    }
    res.OPENCODE_CONFIG = r
  }
  // c2/c3 OPENCODE_CONFIG_CONTENT wins default_agent; malformed content is dropped.
  {
    const proj = { default_agent: "proj", agents: { proj: { mode: "primary", description: "project agent", permissions: [{ action: "shell", resource: "*", effect: "deny" }] } } }
    const r: any = {}
    const variants: Array<[string, string | undefined]> = [
      ["content_valid", JSON.stringify({ default_agent: "build", permissions: [{ action: "shell", resource: "*", effect: "ask" }] })],
      ["content_malformed", '{"default_agent":"build","permissions":[{"action":"shell","resource":"*","effect":"ask"}]'],
      ["control_no_content", undefined],
    ]
    for (const [name, content] of variants) {
      const { s } = await boot(`c2-${name}`, { config: mockProviderConfig(mock), configContent: content })
      const tap = await tapEvents(s, `${root}/c2-${name}/events.jsonl`)
      const repo = uniqueRepo(`${root}/c2-repo-${name}`, { "opencode.json": JSON.stringify(proj) })
      const ses = await createSession(s, repo)
      const got = await runCall(s, tap, ses.id, gateCall("shell", { command: "printf c2 > c2.txt" }), { reply: "reject" })
      const d = await docs(s, repo)
      const log = readFileSync(s.logPath, "utf8")
      r[name] = {
        shellOutcome: got.outcome,
        meaning: got.outcome.startsWith("ask") ? "build agent (content default_agent and shell ask applied)" : got.outcome.startsWith("deny") ? "proj agent (project default_agent won)" : "other",
        sessionAgent: (await s.api("GET", `/api/session/${ses.id}`)).body?.data?.agent ?? null,
        pathlessDocumentPresent: Array.isArray(d) && d.some((x: any) => x.type === "document" && x.path === null),
        documents: d,
        logRejectedMalformed: log.split("\n").filter((l) => l.includes("rejected malformed JSON")).length,
        logMentionsContentSource: log.split("\n").filter((l) => l.includes("OPENCODE_CONFIG_CONTENT")).length,
      }
      console.log("C2", name, JSON.stringify(r[name]).slice(0, 300))
      tap.close()
      await s.stop()
    }
    res.OPENCODE_CONFIG_CONTENT = r
  }
  // c4 OPENCODE_CONFIG_DIR replaces the global dir.
  {
    const r: any = {}
    for (const withDir of [true, false]) {
      const name = `c4-${withDir}`
      const p = makeProfile(`${root}/${name}`)
      mkdirSync(`${p.config}/opencode`, { recursive: true })
      writeFileSync(`${p.config}/opencode/opencode.json`, JSON.stringify({ agents: { "xdg-marker": { mode: "primary", description: "from XDG_CONFIG_HOME/opencode" } } }))
      const ucd = `${root}/${name}-userdir`
      mkdirSync(ucd, { recursive: true })
      writeFileSync(`${ucd}/opencode.json`, JSON.stringify({ agents: { "dir-marker": { mode: "primary", description: "from OPENCODE_CONFIG_DIR" } } }))
      const s = await startServer(p, { cwd: mkcwd(name), config: mockProviderConfig(mock), env: { OPENCODE_CONFIG_DIR: withDir ? ucd : undefined } })
      passwords.push(s.password)
      const repo = uniqueRepo(`${root}/${name}-repo`)
      await createSession(s, repo)
      const ag = await pollAgents(s, repo, (ids) => ids.includes(withDir ? "dir-marker" : "xdg-marker"))
      r[withDir ? "withOPENCODE_CONFIG_DIR" : "control_without"] = { pollOk: ag.ok, hasXdgMarker: ag.ids.includes("xdg-marker"), hasDirMarker: ag.ids.includes("dir-marker"), documents: await docs(s, repo) }
      if (withDir) {
        await Bun.sleep(2000)
        const again = await pollAgents(s, repo, () => true, 1000)
        r.withOPENCODE_CONFIG_DIR.hasXdgMarkerAfter2s = again.ids.includes("xdg-marker")
      }
      await s.stop()
    }
    res.OPENCODE_CONFIG_DIR = r
  }
  // c5 autoupdate: a CONNECT-logging proxy sees every outbound HTTPS host.
  {
    const r: any = {}
    for (const disabled of [true, false]) {
      const hosts: string[] = []
      const proxy = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(sock, data) {
            const line = data.toString().split("\r\n")[0]
            hosts.push(line.split(" ").slice(0, 2).join(" "))
            sock.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            sock.end()
          },
        },
      })
      const purl = `http://127.0.0.1:${proxy.port}`
      const cfg: any = mockProviderConfig(mock)
      if (!disabled) delete cfg.update
      const name = `c5-${disabled}`
      const { s } = await boot(name, {
        config: cfg,
        env: { HTTPS_PROXY: purl, HTTP_PROXY: purl, https_proxy: purl, http_proxy: purl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_AUTOUPDATE: disabled ? "1" : undefined },
      })
      const tap = await tapEvents(s, `${root}/${name}/events.jsonl`)
      const repo = uniqueRepo(`${root}/${name}-repo`)
      const ses = await createSession(s, repo)
      await runCall(s, tap, ses.id, "hello", { timeoutMs: 15000 })
      await Bun.sleep(8000)
      tap.close()
      await s.stop()
      proxy.stop(true)
      r[disabled ? "OPENCODE_DISABLE_AUTOUPDATE=1" : "unset_and_no_update_key"] = { proxiedRequests: [...new Set(hosts)], count: hosts.length, updateLike: hosts.filter((h) => /opencode\.ai|github|npmjs|registry/.test(h)).length }
      console.log("C5", disabled, JSON.stringify(r).slice(0, 400))
    }
    res.OPENCODE_DISABLE_AUTOUPDATE = r
  }
  // c7/c8/c9 auth env vars and what a shell tool sees.
  {
    const r: any = {}
    const pwA = `gate-pw-${crypto.randomUUID()}`
    const pwB = `gate-pw-${crypto.randomUUID()}`
    passwords.push(pwA, pwB)
    const curl = async (s: Server, user: string, pw: string) =>
      (await fetch(`${s.base}/api/info`, { headers: { authorization: `Basic ${btoa(`${user}:${pw}`)}` } })).status
    const envCount = async (s: Server, tap: any, name: string) => {
      const ses = await createSession(s, uniqueRepo(`${root}/c7-repo-${crypto.randomUUID().slice(0, 8)}`))
      const got = await runCall(s, tap, ses.id, gateCall("shell", { command: `env | grep -c ${name}` }), { reply: "once" })
      return got.tools.find((t) => t.session === "self")?.output?.trim() ?? got.outcome
    }
    {
      const { s } = await boot("c7-username", { config: mockProviderConfig(mock), password: pwA, env: { OPENCODE_SERVER_USERNAME: "isomux" } })
      r.OPENCODE_SERVER_USERNAME = { set: "isomux", isomux_user_status: await curl(s, "isomux", pwA), opencode_user_status: await curl(s, "opencode", pwA), wrong_password_status: await curl(s, "opencode", "wrong") }
      const tap = await tapEvents(s, `${root}/c7-username/events.jsonl`)
      r.shellEnvCounts_OPENCODE_SERVER_PASSWORD_mode = {
        OPENCODE_SERVER_PASSWORD: await envCount(s, tap, "OPENCODE_SERVER_PASSWORD"),
        OPENCODE_SERVER_USERNAME: await envCount(s, tap, "OPENCODE_SERVER_USERNAME"),
        control_XDG_CONFIG_HOME: await envCount(s, tap, "XDG_CONFIG_HOME"),
        control_GATE_API_KEY: await envCount(s, tap, "GATE_API_KEY"),
      }
      tap.close()
      await s.stop()
    }
    {
      const { s } = await boot("c8-password", { config: mockProviderConfig(mock), password: pwA, env: { OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_PASSWORD: pwA } })
      r.OPENCODE_PASSWORD_only = { right_status: await curl(s, "opencode", pwA), wrong_status: await curl(s, "opencode", "wrong") }
      const tap = await tapEvents(s, `${root}/c8-password/events.jsonl`)
      r.shellEnvCounts_OPENCODE_PASSWORD_mode = { OPENCODE_PASSWORD: await envCount(s, tap, "OPENCODE_PASSWORD") }
      tap.close()
      await s.stop()
    }
    {
      const { s } = await boot("c8-both", { config: mockProviderConfig(mock), password: pwA, env: { OPENCODE_SERVER_PASSWORD: pwB, OPENCODE_PASSWORD: pwA } })
      r.both_set_different = { OPENCODE_PASSWORD_value_status: await curl(s, "opencode", pwA), OPENCODE_SERVER_PASSWORD_value_status: await curl(s, "opencode", pwB) }
      await s.stop()
    }
    {
      const { s } = await boot("c8-legacy", { config: mockProviderConfig(mock), password: pwB, env: { OPENCODE_SERVER_PASSWORD: pwB } })
      r.OPENCODE_SERVER_PASSWORD_only = { right_status: await curl(s, "opencode", pwB), wrong_status: await curl(s, "opencode", "wrong"), no_auth_status: (await fetch(`${s.base}/api/info`)).status }
      await s.stop()
    }
    res.auth = r
  }
  out.parts.c = res
}

try {
  if (!only || only === "a") await partA()
  if (!only || only === "b") await partB()
  if (!only || only === "c") await partC()
} finally {
  for (const s of servers) await s.stop().catch(() => {})
  mock.stop()
  const text = JSON.stringify(redact(out, passwords), null, 2).split(root).join("<run>")
  writeFileSync(`${GATE_ROOT}/evidence/pm-p4-layers${only ? "-" + only : ""}.json`, text + "\n")
  console.log("runDir", root)
}
