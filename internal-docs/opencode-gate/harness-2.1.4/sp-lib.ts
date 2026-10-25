// Shared helpers for the sp-* probes (task 4840abc5, 2026-10-25).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Server, EventTap, Profile, StartOptions } from "./common.ts"
import { V1_BIN, V2_BIN, freePort } from "./common.ts"
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"

export const ISOMUX_ID = "isomux-safety"

// A minimal v2 safety plugin: a directory with index.js. It imports only a
// Node built-in. It throws in execute.before for a shell command that holds
// GATE_DENY_ME and an edit/write whose path holds "denied-", and records
// each hook call (tool, input, sessionID) to recordPath.
export function writeSafetyPlugin(dir: string, recordPath: string, id = ISOMUX_ID, extra = ""): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "index.js"),
    `import { appendFileSync } from "node:fs"
const RECORD = ${JSON.stringify(recordPath)}
const rec = (v) => { try { appendFileSync(RECORD, JSON.stringify({ at: Date.now(), ...v }) + "\\n") } catch {} }
${extra}
export default {
  id: ${JSON.stringify(id)},
  setup(ctx) {
    rec({ kind: "setup", plugin: ${JSON.stringify(id)}, directory: ctx.location?.directory })
    ctx.tool.hook("execute.before", (event) => {
      const input = event.input ?? {}
      let deny = null
      if (event.tool === "shell" && String(input.command ?? "").includes("GATE_DENY_ME")) deny = "ISOMUX_DENY shell command holds GATE_DENY_ME"
      if ((event.tool === "edit" || event.tool === "write") && String(input.path ?? input.filePath ?? "").includes("denied-")) deny = "ISOMUX_DENY edit on a denied- path"
      rec({ kind: "hook", plugin: ${JSON.stringify(id)}, tool: event.tool, input, sessionID: event.sessionID, agent: event.agent, decision: deny ? "deny" : "allow" })
      if (deny) throw new Error(deny)
    })
  },
}
`,
  )
  return dir
}

export function readRecords(path: string): any[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

export function locQuery(directory: string) {
  return `location[directory]=${encodeURIComponent(directory)}`
}

// GET /api/plugin scoped by query (the location[directory] deepObject form).
export async function pluginList(server: Server, directory: string) {
  return server.api("GET", `/api/plugin?${locQuery(directory)}`)
}

// Summarize a plugin list body for evidence: non-builtin rows in full, builtins counted.
export function summarizePlugins(body: any) {
  const list = body?.data ?? []
  const rows = list
    .filter((p: any) => p.source?.type !== "builtin")
    .map((p: any) => ({
      id: p.id ?? null,
      source: p.source,
      state: p.state?.status === "failed" ? { status: "failed", error: String(p.state.error).slice(0, 300) } : p.state,
    }))
  return { builtinCount: list.length - rows.length, total: list.length, rows }
}

// The check Isomux can do before the first prompt in a folder. pathCheck: the
// row whose source path is Isomux's own entry file is active with Isomux's id,
// and no other row claims that id. Missing = keep polling until the deadline;
// failed = refuse at once. naiveIdCheck (for contrast): some row with the id
// is active.
export async function awaitIsomuxActive(
  server: Server,
  directory: string,
  pluginDir: string,
  timeoutMs = 10_000,
): Promise<{ verdict: "active" | "failed" | "missing" | "impostor"; naiveIdCheck: boolean; ms: number; polls: number; emptyPolls: number; withoutIsomuxPolls: number; last: any }> {
  const entry = `${pluginDir}/index.js`
  const start = performance.now()
  let polls = 0, emptyPolls = 0, withoutIsomuxPolls = 0
  let last: any = null
  const done = (verdict: any, naive: boolean) => ({ verdict, naiveIdCheck: naive, ms: Math.round(performance.now() - start), polls, emptyPolls, withoutIsomuxPolls, last })
  while (performance.now() - start < timeoutMs) {
    polls++
    const r = await pluginList(server, directory)
    const list: any[] = r.body?.data ?? []
    last = summarizePlugins(r.body)
    if (list.length === 0) emptyPolls++
    // An active row names the entry file; a row that failed before setup (syntax, shape, missing) has no id and names the directory.
    const own = list.find((p) => p.source?.type === "local" && (p.source.path === entry || p.source.path === pluginDir))
    const naive = list.some((p) => p.id === ISOMUX_ID && p.state?.status === "active")
    const others = list.filter((p) => p.id === ISOMUX_ID && p !== own)
    if (!own) { withoutIsomuxPolls++; await Bun.sleep(5); continue }
    if (own.state?.status === "failed") return done("failed", naive)
    if (others.length) return done("impostor", naive)
    if (own.state?.status === "active" && own.id === ISOMUX_ID) return done("active", naive)
    await Bun.sleep(5)
  }
  return done("missing", false)
}

// Tool outcomes for one session from the event stream.
export function toolOutcomes(tap: EventTap, sessionID: string) {
  return tap.events
    .filter((e) => ["session.tool.called", "session.tool.success", "session.tool.failed"].includes(e.type) && e.data?.sessionID === sessionID)
    .map((e) => ({
      type: e.type,
      callID: e.data.id,
      input: e.type === "session.tool.called" ? e.data.input : undefined,
      tool: e.data.tool ?? e.data.name,
      error:
        e.type === "session.tool.failed"
          ? String(JSON.stringify(e.data.error ?? e.data.message ?? e.data).slice(0, 400))
          : undefined,
    }))
}

export function finalText(tap: EventTap, sessionID: string) {
  return tap.events
    .filter((e) => e.type === "session.text.ended" && e.data?.sessionID === sessionID)
    .map((e) => e.data.text)
}

export function redact(text: string, secrets: string[]) {
  let t = text
  for (const s of secrets) if (s) t = t.split(s).join("<redacted>")
  return t
}

export function gateCall(tool: string, args: unknown) {
  return `GATE_CALL:${JSON.stringify({ tool, args })}`
}

// A copy of common.ts startServer whose health fetches time out: the first
// request to a just-bound 1.18.35 server can hang forever (2026-10-25).
export async function startServerT(profile: Profile, opts: StartOptions = {}): Promise<Server> {
  const bin = opts.bin ?? (opts.v1 ? V1_BIN : V2_BIN)
  if (opts.config) writeFileSync(profile.configPath, JSON.stringify(opts.config), { mode: 0o600 })
  const password = opts.password ?? `gate-pw-${crypto.randomUUID()}`
  const port = await freePort()
  const logPath = opts.logPath ?? join(profile.dir, `server-${Date.now()}.log`)
  const env: Record<string, string | undefined> = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: profile.home,
    XDG_CONFIG_HOME: profile.config,
    XDG_DATA_HOME: profile.data,
    XDG_STATE_HOME: profile.state,
    XDG_CACHE_HOME: profile.cache,
    TMPDIR: profile.tmp,
    OPENCODE_CONFIG: existsSync(profile.configPath) ? profile.configPath : undefined,
    OPENCODE_CONFIG_CONTENT:
      opts.configContent === undefined
        ? undefined
        : typeof opts.configContent === "string"
          ? opts.configContent
          : JSON.stringify(opts.configContent),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: password,
    GATE_API_KEY: "GATE_KEY_SENTINEL_7f3a",
    ...opts.env,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", opts.v1 ? "INFO" : "info"]
  const proc = spawn(bin, args, { cwd: opts.cwd ?? profile.dir, env: env as Record<string, string>, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  const base = `http://127.0.0.1:${port}`
  const user = opts.v1 ? (env.OPENCODE_SERVER_USERNAME ?? "opencode") : "opencode"
  const authorization = `Basic ${btoa(`${user}:${password}`)}`
  const healthPath = opts.v1 ? "/global/health" : "/api/info"
  let ok = false
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) break
    try {
      const r = await fetch(base + healthPath, { headers: { authorization }, signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        ok = true
        break
      }
    } catch {}
    await Bun.sleep(50)
  }
  if (!ok) {
    proc.kill("SIGKILL")
    throw new Error(`server did not become healthy; see ${logPath}`)
  }
  const api = async (method: string, path: string, body?: unknown, directory?: string) => {
    const headers: Record<string, string> = { authorization, "content-type": "application/json" }
    if (directory) headers[opts.v1 ? "x-opencode-directory" : "x-opencode-directory"] = encodeURIComponent(directory)
    const r = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const t = await r.text()
    let j: any = t
    try {
      j = JSON.parse(t)
    } catch {}
    return { status: r.status, body: j }
  }
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const done = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
    proc.kill(signal)
    await Promise.race([done, Bun.sleep(10_000)])
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL")
      await done
    }
  }
  return { pid: proc.pid!, port, base, password, proc, logPath, api, stop }
}

