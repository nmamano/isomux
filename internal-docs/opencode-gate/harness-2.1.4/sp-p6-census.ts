// P6 census: start, one session, shell + edit turns, stop; on 2.1.4 and on
// 1.18.35, HOME/XDG/TMPDIR inside the profile. The server runs under strace
// (-f, file/socket syscalls) to attribute every path written and every socket
// bound or connected; ss lists listeners per server pid; /proc lists children
// before and after stop. 2026-10-25. Usage: bun run sp-p6-census.ts v2|v1
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { markPluginSdkInstalled } from "../../../server/backends/opencode/config-layers.ts"
import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, writeJson, GATE_ROOT, V1_BIN, V2_BIN } from "./common.ts"
import { gateCall, startServerT } from "./sp-lib.ts"
import { readProcessHop } from "../../../server/backends/opencode/process-identity.ts"

const version = process.argv[2] === "v1" ? "v1" : "v2"
const root = `${GATE_ROOT}/run/sp-p6c-${version}-${Date.now()}`
const p = makeProfile(root)
const repo = makeRepo(join(root, "repo"))
writeFileSync(join(repo, "file.txt"), "original\n")
const trace = join(root, "strace.txt")
const wrapper = join(root, "strace-wrap.sh")
writeFileSync(
  wrapper,
  `#!/bin/sh\nexec strace -f -qq -s 300 -o ${trace} -e trace=openat,open,creat,mkdir,mkdirat,rename,renameat,renameat2,unlink,unlinkat,symlink,symlinkat,link,linkat,bind,connect,socket -- ${version === "v1" ? V1_BIN : V2_BIN} "$@"\n`,
)
chmodSync(wrapper, 0o755)

const realHome = homedir()
const realDirs = [".config/opencode", ".local/share/opencode", ".cache/opencode", ".local/state/opencode"]
const statReal = () => Object.fromEntries(realDirs.map((d) => {
  try { const st = statSync(join(realHome, d)); return [`~/${d}`, { mtimeMs: Math.round(st.mtimeMs) }] } catch { return [`~/${d}`, "absent"] }
}))
const tmpOpencode = () => readdirSync("/tmp").filter((n) => n.startsWith("opencode")).map((n) => ({ name: n, mtimeMs: Math.round(statSync(join("/tmp", n)).mtimeMs) }))
const ref = join(root, "ref")
writeFileSync(ref, "")
await Bun.sleep(20)
const before = { realDirs: statReal(), tmpOpencode: tmpOpencode() }

function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>()
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue
    const h = readProcessHop(Number(d))
    if (h) kids.set(h.parentPid, [...(kids.get(h.parentPid) ?? []), h.pid])
  }
  const out: number[] = []
  const walk = (x: number) => { for (const k of kids.get(x) ?? []) { out.push(k); walk(k) } }
  walk(pid)
  return out
}
const comm = (pid: number) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim() } catch { return null } }
function ssFor(pids: number[], flags: string) {
  const text = Bun.spawnSync(["ss", "-H", flags]).stdout.toString()
  return text.split("\n").filter((l) => pids.some((x) => l.includes(`pid=${x},`))).map((l) => l.replace(/\s+/g, " ").replace(root, "<profile>"))
}

const mock = await startMock(`${root}/mock.log`, version === "v2" ? { MOCK_SHELL_TOOL: "shell" } : {})
const out: any = { date: "2026-10-25", probe: "sp-p6-census", version, runDir: root, before }
const v1Config = {
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  model: "gate/gate-model",
  small_model: "gate/gate-model",
  permission: { bash: "allow", edit: "allow" },
  provider: {
    gate: {
      name: "Gate mock",
      npm: "@ai-sdk/openai-compatible",
      env: ["GATE_API_KEY"],
      models: { "gate-model": { name: "Gate model", tool_call: true, limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } } },
      options: { baseURL: mock.url },
    },
  },
}
// As Isomux does for 1.18.35 (config-layers.ts markPluginSdkInstalled): skip the SDK install in the config dir.
if (version === "v1") await markPluginSdkInstalled(join(p.config, "opencode"))
const s = await startServerT(p, { bin: wrapper, v1: version === "v1", config: version === "v2" ? mockProviderConfig(mock) : v1Config, cwd: root })
const tracerPid = s.pid
await Bun.sleep(300)
const serverPid = descendants(tracerPid).find((x) => comm(x) === "opencode") ?? tracerPid
out.serverComm = comm(serverPid)
try {
  if (version === "v2") {
    const tap = await tapEvents(s, join(root, "events.jsonl"))
    const ses = await createSession(s, repo)
    for (const text of [
      `shell ${gateCall("shell", { command: "printf ok > census-shell.txt" })}`,
      `edit ${gateCall("edit", { path: join(repo, "file.txt"), oldString: "original", newString: "changed" })}`,
    ]) {
      const n = tap.events.filter((e) => e.type === "session.execution.succeeded" && e.data?.sessionID === ses.id).length
      await prompt(s, ses.id, text)
      await tap.waitFor(() => tap.events.filter((e) => e.type === "session.execution.succeeded" && e.data?.sessionID === ses.id).length > n, 30_000).catch(() => {})
    }
    out.toolResults = tap.events.filter((e) => ["session.tool.success", "session.tool.failed"].includes(e.type)).map((e) => e.type.split(".").pop())
    // also a persistent terminal (v2 only), to census its daemon
    const term = await s.api("POST", `/api/experimental/session/${ses.id}/terminal`, { command: "/bin/sh", args: ["-c", "echo census-pty; sleep 30"], cwd: repo, title: "census", env: {} })
    out.terminalCreate = term.status
    await Bun.sleep(1500)
    tap.close()
  } else {
    const ses = await s.api("POST", "/session", {}, repo)
    out.v1SessionStatus = ses.status
    const id = ses.body?.id
    out.toolResults = []
    for (const text of [
      `shell ${gateCall("bash", { command: "printf ok > census-shell.txt", description: "write file" })}`,
      `read ${gateCall("read", { filePath: join(repo, "file.txt") })}`,
      `edit ${gateCall("edit", { filePath: join(repo, "file.txt"), oldString: "original", newString: "changed" })}`,
    ]) {
      const r = await s.api("POST", `/session/${id}/message`, { model: { providerID: "gate", modelID: "gate-model" }, parts: [{ type: "text", text }] }, repo)
      out.toolResults.push(r.status)
    }
    const msgs = await s.api("GET", `/session/${id}/message`, undefined, repo)
    out.toolStates = (msgs.body ?? []).flatMap((m: any) => m.parts ?? []).filter((x: any) => x.type === "tool").map((x: any) => `${x.tool}:${x.state?.status}`)
  }
  out.sideEffects = { shellFile: existsSync(join(repo, "census-shell.txt")), editApplied: readFileSync(join(repo, "file.txt"), "utf8").trim() === "changed" }
  const tree = [serverPid, ...descendants(serverPid)]
  out.processesDuringRun = tree.map((x) => ({ pid: x, comm: comm(x), startTicks: readProcessHop(x)?.startTicks }))
  out.listeners = { tcp: ssFor(tree, "-ltnp"), unix: ssFor(tree, "-lxp"), udp: ssFor(tree, "-lunp") }
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  // Signal the real server (strace is its parent), as a supervisor would.
  const exited = new Promise<void>((r) => (s.proc.exitCode !== null ? r() : s.proc.once("exit", () => r())))
  try { process.kill(serverPid, "SIGTERM") } catch {}
  await Promise.race([exited, Bun.sleep(10_000)])
  out.stoppedBySigterm = s.proc.exitCode !== null || s.proc.signalCode !== null
  await s.stop()
  mock.stop()
}
await Bun.sleep(1500)
out.leftAfterStop = (out.processesDuringRun ?? []).filter((x: any) => x.startTicks && readProcessHop(x.pid)?.startTicks === x.startTicks).map((x: any) => ({ pid: x.pid, comm: x.comm }))
out.after = { realDirs: statReal(), tmpOpencode: tmpOpencode() }
out.realDirsChanged = Object.keys(before.realDirs).filter((k) => JSON.stringify(before.realDirs[k]) !== JSON.stringify(out.after.realDirs[k]))
// /tmp top level entries newer than ref (other probes run at the same time; strace attributes)
const refMs = statSync(ref).mtimeMs
const newerTmp = readdirSync("/tmp").filter((n) => { try { return statSync(join("/tmp", n)).mtimeMs > refMs } catch { return false } })

// strace: paths written/created/removed/bound outside the profile, and connects
const lines = existsSync(trace) ? readFileSync(trace, "utf8").split("\n") : []
const writes = new Map<string, Set<string>>()
const sockets: Record<string, number> = {}
const connects = new Map<string, number>()
const binds = new Map<string, number>()
let profileWrites = 0
for (const l of lines) {
  const m = /^\d+\s+(\w+)\((.*)\)\s+=\s+(-?\d+)/.exec(l)
  if (!m) continue
  const [, sc, args, ret] = m
  const inProgress = / = -1 EINPROGRESS/.test(l)
  if (Number(ret) < 0 && !inProgress) continue
  if (sc === "socket") { const fam = /AF_\w+/.exec(args)?.[0] + "/" + (/SOCK_\w+/.exec(args)?.[0] ?? "?"); sockets[fam] = (sockets[fam] ?? 0) + 1; continue }
  if (sc === "connect" || sc === "bind") {
    if (/AF_UNSPEC|AF_NETLINK/.test(args)) continue
    const a = /sun_path="([^"]*)"/.exec(args)?.[1] ?? ((/inet_addr\("([^"]+)"\)/.exec(args) ?? /inet_pton\(AF_INET6, "([^"]+)"/.exec(args))?.[1] + ":" + (/sin6?_port=htons\((\d+)\)/.exec(args)?.[1] ?? "?"))
    const key = a.replace(root, "<profile>")
    const map = sc === "connect" ? connects : binds
    map.set(key, (map.get(key) ?? 0) + 1)
    continue
  }
  const isWrite = sc.startsWith("open") || sc === "creat" ? /O_WRONLY|O_RDWR|O_CREAT/.test(args) || sc === "creat" : true
  if (!isWrite) continue
  for (const path of [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]!)) {
    if (!path.startsWith("/")) continue
    if (path.startsWith(root)) { profileWrites++; continue }
    if (/^\/dev\/(null|tty|pts|ptmx|urandom|random|shm)/.test(path) || path.startsWith("/proc/") || path.startsWith("/sys/")) continue
    const key = path.replace(/\d{6,}/g, "<n>")
    if (!writes.has(key)) writes.set(key, new Set())
    writes.get(key)!.add(sc)
  }
}
out.strace = {
  lines: lines.length,
  positiveControlProfileWrites: profileWrites,
  writesOutsideProfile: [...writes.entries()].map(([k, v]) => ({ path: k, ops: [...v] })),
  socketsOpened: sockets,
  binds: Object.fromEntries(binds),
  connects: Object.fromEntries([...connects.entries()].filter(([k]) => !k.startsWith("/proc"))),
}
// Only report /tmp names that strace attributes to this server; count the rest.
const attributed = newerTmp.filter((n) => out.strace.writesOutsideProfile.some((w: any) => w.path.startsWith(join("/tmp", n))))
out.tmpTopLevelNewer = { total: newerTmp.length, attributedToServer: attributed, otherProcessesCount: newerTmp.length - attributed.length }
writeJson(`${GATE_ROOT}/evidence/sp-p6-census-${version}.json`, out)
console.log("done", root)
