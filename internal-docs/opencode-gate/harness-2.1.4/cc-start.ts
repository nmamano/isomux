// Copy of common.ts startServer with bounded health fetches and, for v1, a wait
// for the "listening" line before the first request (task 4840abc5, cc probe).
import { spawn } from "node:child_process"
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { V1_BIN, V2_BIN, freePort, type Profile, type Server } from "./common.ts"

export interface StartOptions2 {
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

export async function startServer2(profile: Profile, opts: StartOptions2 = {}): Promise<Server> {
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
      // v1 accepts a connection before it serves; a request sent then can hang
      // (seen 2026-10-25), so wait for the listening line and bound each try.
      if (opts.v1 && !(existsSync(logPath) && readFileSync(logPath, "utf8").includes("listening on"))) {
        await Bun.sleep(50)
        continue
      }
      const r = await fetch(base + healthPath, { headers: { authorization }, signal: AbortSignal.timeout(1000) })
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

