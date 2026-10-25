// Shared helpers for the OpenCode 2.1.4 gate probes (task 4840abc5).
// Frozen record of the 2026-10-25 run. Every profile, repository and log
// lives under GATE_ROOT; no probe touches a real home or checkout.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export const GATE_ROOT = process.env.GATE_ROOT ?? "/tmp/t-4840abc5"
export const V2_BIN =
  process.env.GATE_V2_BIN ?? `${GATE_ROOT}/oc2/node_modules/@opencode/cli-linux-x64/bin/opencode`
export const V1_BIN =
  process.env.GATE_V1_BIN ?? join(import.meta.dir, "../../../node_modules/opencode-linux-x64/bin/opencode")
export const MOCK = join(import.meta.dir, "mock-openai.ts")
export const HARNESS = import.meta.dir

export async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = s.port
  s.stop(true)
  return port
}

export interface Profile {
  dir: string
  home: string
  config: string
  data: string
  state: string
  cache: string
  tmp: string
  configPath: string
}

export function makeProfile(dir: string): Profile {
  const p: Profile = {
    dir,
    home: join(dir, "home"),
    config: join(dir, "config"),
    data: join(dir, "data"),
    state: join(dir, "state"),
    cache: join(dir, "cache"),
    tmp: join(dir, "tmp"),
    configPath: join(dir, "opencode.json"),
  }
  for (const d of [p.home, p.config, p.data, p.state, p.cache, p.tmp]) mkdirSync(d, { recursive: true, mode: 0o700 })
  return p
}

export function makeRepo(dir: string, git = true): string {
  mkdirSync(dir, { recursive: true })
  if (git && !existsSync(join(dir, ".git"))) {
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
    writeFileSync(join(dir, "README.md"), "gate repo\n")
    Bun.spawnSync(["git", "-c", "user.email=gate@example.com", "-c", "user.name=gate", "add", "."], { cwd: dir })
    Bun.spawnSync(["git", "-c", "user.email=gate@example.com", "-c", "user.name=gate", "commit", "-qm", "init"], {
      cwd: dir,
    })
  }
  return dir
}

export interface Mock {
  port: number
  url: string
  proc: ChildProcess
  stop(): void
}

// The deterministic OpenAI-compatible mock. Its prompt log goes to logPath.
export async function startMock(logPath: string, env: Record<string, string> = {}): Promise<Mock> {
  const port = await freePort()
  const proc = spawn("bun", ["run", MOCK], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
    } catch {}
    await Bun.sleep(50)
  }
  return { port, url: `http://127.0.0.1:${port}/v1`, proc, stop: () => proc.kill("SIGKILL") }
}

// A config that routes every model call to the mock.
export function mockProviderConfig(mock: Mock, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      gate: {
        name: "Gate",
        env: ["GATE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: mock.url },
        models: { "gate-model": { name: "Gate model" } },
      },
    },
    model: "gate/gate-model",
    update: "disable",
    ...extra,
  }
}

export interface Server {
  pid: number
  port: number
  base: string
  password: string
  proc: ChildProcess
  logPath: string
  api(method: string, path: string, body?: unknown, directory?: string): Promise<{ status: number; body: any }>
  stop(signal?: NodeJS.Signals): Promise<void>
}

export interface StartOptions {
  bin?: string
  cwd?: string
  env?: Record<string, string | undefined>
  config?: Record<string, unknown>
  configContent?: Record<string, unknown> | string
  password?: string
  logPath?: string
  // v1 servers take --port 0 and print their URL; v2 needs an explicit port.
  v1?: boolean
}

export async function startServer(profile: Profile, opts: StartOptions = {}): Promise<Server> {
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
      const r = await fetch(base + healthPath, { headers: { authorization } })
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

// One /api/event subscriber that appends every frame to a JSONL file and
// keeps it in memory. The v1 stream is /event.
export interface EventTap {
  events: any[]
  close(): void
  waitFor(pred: (e: any) => boolean, timeoutMs?: number): Promise<any>
}

export async function tapEvents(server: Server, jsonlPath: string, path = "/api/event"): Promise<EventTap> {
  const ac = new AbortController()
  const events: any[] = []
  const waiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = []
  const res = await fetch(server.base + path, {
    headers: { authorization: `Basic ${btoa(`opencode:${server.password}`)}` },
    signal: ac.signal,
  })
  ;(async () => {
    try {
      const rd = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue
            let e: any
            try {
              e = JSON.parse(line.slice(5))
            } catch {
              e = { unparsed: line }
            }
            e.__receivedAt = Date.now()
            events.push(e)
            appendFileSync(jsonlPath, JSON.stringify(e) + "\n")
            for (const w of [...waiters])
              if (w.pred(e)) {
                waiters.splice(waiters.indexOf(w), 1)
                w.resolve(e)
              }
          }
        }
      }
    } catch {}
  })()
  return {
    events,
    close: () => ac.abort(),
    waitFor: (pred, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const hit = events.find(pred)
        if (hit) return resolve(hit)
        const w = { pred, resolve }
        waiters.push(w)
        setTimeout(() => {
          const idx = waiters.indexOf(w)
          if (idx >= 0) {
            waiters.splice(idx, 1)
            reject(new Error("waitFor timed out"))
          }
        }, timeoutMs)
      }),
  }
}

// The end of a v2 turn: one of the execution terminal events for the session.
export const TURN_END = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
export function turnEnded(sessionID: string) {
  return (e: any) => TURN_END.includes(e.type) && e.data?.sessionID === sessionID
}

export async function createSession(server: Server, directory: string, extra: Record<string, unknown> = {}) {
  const r = await server.api("POST", "/api/session", { location: { directory }, ...extra })
  if (r.status !== 200) throw new Error(`session.create ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
  return r.body.data as { id: string; projectID: string; location: { directory: string } }
}

export async function prompt(server: Server, sessionID: string, text: string) {
  const r = await server.api("POST", `/api/session/${sessionID}/prompt`, { text })
  if (r.status !== 200) throw new Error(`prompt ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
  return r.body.data
}

export function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}
