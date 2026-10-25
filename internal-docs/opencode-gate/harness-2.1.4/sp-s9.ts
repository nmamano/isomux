// S9: the server password and the provider key sentinel in logs, profile data,
// the event stream, API error bodies, /proc cmdlines, and a tool's env.
// Two servers: password via OPENCODE_SERVER_PASSWORD (legacy) and via
// OPENCODE_PASSWORD. Counts only; no secret value is saved. 2026-10-25.
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, tapEvents, createSession, prompt, writeJson, GATE_ROOT } from "./common.ts"
import { gateCall, startServerT } from "./sp-lib.ts"
import { readProcessHop } from "../../../server/backends/opencode/process-identity.ts"

const KEY = "GATE_KEY_SENTINEL_7f3a"
const root = `${GATE_ROOT}/run/sp-s9-${Date.now()}`
const mock = await startMock(`${root}-mock.log`, { MOCK_SHELL_TOOL: "shell" })
const out: any = { date: "2026-10-25", probe: "sp-s9", runDir: root, servers: {} }

function count(text: string, needle: string) {
  return needle ? text.split(needle).length - 1 : 0
}
function grepR(dir: string, needle: string) {
  const r = Bun.spawnSync(["grep", "-r", "-a", "-c", "-F", "--", needle, dir])
  const perFile = r.stdout.toString().trim().split("\n").filter(Boolean).map((l) => {
    const i = l.lastIndexOf(":")
    return { file: l.slice(0, i).replace(dir, "<data>"), lines: Number(l.slice(i + 1)) }
  })
  return { filesScanned: perFile.length, filesWithMatch: perFile.filter((x) => x.lines > 0).length, matchLines: perFile.reduce((a, x) => a + x.lines, 0), matches: perFile.filter((x) => x.lines > 0) }
}
function tree(pid: number): number[] {
  const kids = new Map<number, number[]>()
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue
    const h = readProcessHop(Number(d))
    if (h) kids.set(h.parentPid, [...(kids.get(h.parentPid) ?? []), h.pid])
  }
  const all = [pid]
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]!) ?? []))
  return all
}

for (const mode of ["legacyServerPassword", "opencodePassword"] as const) {
  const dir = join(root, mode)
  const p = makeProfile(dir)
  const repo = makeRepo(join(dir, "repo"))
  const password = `gate-pw-${crypto.randomUUID()}`
  const env: Record<string, string | undefined> =
    mode === "opencodePassword" ? { OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_PASSWORD: password } : {}
  const s = await startServerT(p, { config: mockProviderConfig(mock), password, env, cwd: dir })
  const evPath = join(dir, "events.jsonl")
  const tap = await tapEvents(s, evPath)
  const errorBodies: string[] = []
  const r: any = {}
  try {
    const ses = await createSession(s, repo)
    // A shell that writes its env to a file (not to the tool output) and stays alive while /proc is read.
    await prompt(s, ses.id, `env ${gateCall("shell", { command: "env > env-out.txt; sleep 4" })}`)
    await Bun.sleep(2000)
    const pids = tree(s.pid)
    let cmdlineText = ""
    for (const x of pids) try { cmdlineText += readFileSync(`/proc/${x}/cmdline`, "utf8") + "\n" } catch {}
    r.cmdline = { processes: pids.length, comms: pids.map((x) => { try { return readFileSync(`/proc/${x}/comm`, "utf8").trim() } catch { return "?" } }), password: count(cmdlineText, password), key: count(cmdlineText, KEY), controlServeArg: count(cmdlineText, "serve") }
    await tap.waitFor((e) => e.type === "session.execution.succeeded" && e.data?.sessionID === ses.id, 30_000).catch(() => {})
    // API error bodies
    for (const [m, path, body] of [
      ["GET", "/api/session/ses_doesnotexist", undefined],
      ["POST", `/api/session/${ses.id}/prompt`, { nope: 1 }],
      ["GET", `/api/plugin?location[directory]=${encodeURIComponent(join(dir, "missing-dir"))}`, undefined],
      ["PATCH", `/api/session/${ses.id}`, { permissions: "bad" }],
      ["GET", "/api/provider/doesnotexist", undefined],
      ["GET", "/api/provider/gate", undefined],
      ["GET", "/api/provider", undefined],
      ["GET", "/api/config", undefined],
    ] as const) {
      const res = await s.api(m, path, body)
      errorBodies.push(`${m} ${path.split("?")[0]} ${res.status} ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)}`)
    }
    const bad = await fetch(s.base + "/api/session", { headers: { authorization: `Basic ${btoa("opencode:wrong-password")}` } })
    errorBodies.push(`401 ${await bad.text()} ${JSON.stringify([...bad.headers])}`)
    r.errorStatuses = errorBodies.map((b) => b.split(" ").slice(0, 3).join(" "))
    const envOut = existsSync(join(repo, "env-out.txt")) ? readFileSync(join(repo, "env-out.txt"), "utf8") : ""
    r.toolEnv = {
      captured: envOut.length > 0,
      nameOPENCODE_SERVER_PASSWORD: envOut.split("\n").filter((l) => l.startsWith("OPENCODE_SERVER_PASSWORD=")).length,
      nameOPENCODE_PASSWORD: envOut.split("\n").filter((l) => l.startsWith("OPENCODE_PASSWORD=")).length,
      passwordValue: count(envOut, password),
      keySentinel: count(envOut, KEY),
      controlNameGATE_API_KEY: envOut.split("\n").filter((l) => l.startsWith("GATE_API_KEY=")).length,
      controlPATH: envOut.split("\n").filter((l) => l.startsWith("PATH=")).length,
    }
    await Bun.sleep(500)
  } finally {
    tap.close()
    await s.stop()
  }
  await Bun.sleep(500)
  const serverOut = readFileSync(s.logPath, "utf8")
  const ocLog = join(p.data, "opencode/log/opencode.log")
  const ocLogText = existsSync(ocLog) ? readFileSync(ocLog, "utf8") : ""
  const events = readFileSync(evPath, "utf8")
  const errText = errorBodies.join("\n")
  r.counts = {
    serverStdoutStderr: { password: count(serverOut, password), key: count(serverOut, KEY), controlLines: serverOut.split("\n").length, controlHttpLog: count(serverOut, "Sent HTTP response") },
    opencodeLog: { exists: existsSync(ocLog), password: count(ocLogText, password), key: count(ocLogText, KEY), controlLines: ocLogText.split("\n").length },
    profileDataDir: { password: grepR(p.data, password), key: grepR(p.data, KEY), controlGateCall: grepR(p.data, "GATE_CALL").matchLines, controlEnvCommand: grepR(p.data, "env > env-out.txt").matchLines },
    eventStream: { password: count(events, password), key: count(events, KEY), controlEvents: events.split("\n").length - 1 },
    apiErrorBodies: { password: count(errText, password), key: count(errText, KEY), bodies: errorBodies.length },
  }
  out.servers[mode] = r
}
mock.stop()
writeJson(`${GATE_ROOT}/evidence/sp-s9-secrets.json`, out)
console.log("done", root)
