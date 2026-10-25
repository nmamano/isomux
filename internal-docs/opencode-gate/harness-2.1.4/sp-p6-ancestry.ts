// P6 ancestry: Isomux's real authority broker (peer credentials + process
// ancestry walk) against tool calls of a real 2.1.4 server: foreground shell,
// background shell, a setsid orphan from a tool, a persistent terminal, and a
// process the server did not start. 2026-10-25.
import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { OpenCodeAuthorityBroker } from "../../../server/backends/opencode/authority-broker.ts"
import { readProcessHop } from "../../../server/backends/opencode/process-identity.ts"
import {
  makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded,
  writeJson, GATE_ROOT,
} from "./common.ts"
import { gateCall, toolOutcomes } from "./sp-lib.ts"

const root = `${GATE_ROOT}/run/sp-p6a-${Date.now()}`
const p = makeProfile(root)
const repo = makeRepo(join(root, "repo"))
const sock = join(root, "broker", "authority.sock")
mkdirSync(join(root, "broker"), { recursive: true, mode: 0o700 })
const upstreamHits: string[] = []
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => (upstreamHits.push(new URL(r.url).pathname), Response.json({ ok: true })) })
const brokerLog: string[] = []
const origInfo = console.info
console.info = (...a: any[]) => {
  const line = a.join(" ")
  if (line.includes("[opencode-office-proxy]")) brokerLog.push(line)
  else origInfo(...a)
}
const broker = new OpenCodeAuthorityBroker(sock, process.getuid!(), `http://127.0.0.1:${upstream.port}`)
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const s = await startServer(p, { config: mockProviderConfig(mock), cwd: root })
const tap = await tapEvents(s, join(root, "events.jsonl"))
const binding = broker.bind("probe-agent", "probe-token-not-secret")
const handle = binding.activate(s.pid)
const out: any = { date: "2026-10-25", probe: "sp-p6-ancestry", runDir: root, serverPid: s.pid, serverHop: readProcessHop(s.pid), cases: {} }

const curl = (tag: string) =>
  `curl -s -o /dev/null -w '%{http_code}' --unix-socket ${sock} -H 'X-Isomux-Turn: ${handle}' http://isomux/agents > ${root}/${tag}-status.txt`
// The client records its own chain (pid ppid comm) up to pid 1.
const chain = (tag: string) =>
  `p=$$; while [ "$p" -gt 1 ]; do echo "$p $(cut -d' ' -f4 /proc/$p/stat) $(cat /proc/$p/comm)"; p=$(cut -d' ' -f4 /proc/$p/stat); done > ${root}/${tag}-chain.txt`

async function waitFile(path: string, ms = 20_000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (existsSync(path) && readFileSync(path, "utf8").length > 0) return readFileSync(path, "utf8").trim()
    await Bun.sleep(100)
  }
  return null
}
function readChain(tag: string) {
  const f = join(root, `${tag}-chain.txt`)
  if (!existsSync(f)) return null
  return readFileSync(f, "utf8").trim().split("\n").map((l) => {
    const [pid, ppid, comm] = l.split(" ")
    return { pid: Number(pid), ppid: Number(ppid), comm, isServer: Number(pid) === s.pid }
  }).reduce((acc: any[], hop: any) => (acc.some((h) => h.isServer) ? acc : [...acc, hop]), [])
}

try {
  const ses = await createSession(s, repo)
  let n = 0
  async function toolCase(tag: string, args: Record<string, unknown>) {
    const logStart = brokerLog.length
    n++
    await prompt(s, ses.id, `${tag} ${gateCall("shell", args)}`)
    const end = await tap.waitFor((e) => ["session.execution.succeeded", "session.execution.failed"].includes(e.type) && e.data?.sessionID === ses.id && tap.events.filter((x) => ["session.execution.succeeded", "session.execution.failed"].includes(x.type) && x.data?.sessionID === ses.id).length >= n, 30_000).catch(() => ({ type: "timeout" }))
    const status = await waitFile(join(root, `${tag}-status.txt`))
    await Bun.sleep(300)
    out.cases[tag] = { turnEnd: end.type, brokerStatus: status, clientChain: readChain(tag), brokerLog: brokerLog.slice(logStart).map((l) => l.replace(/agent=\S+ /, "")) }
  }
  await toolCase("foreground", { command: `${chain("foreground")}; ${curl("foreground")}` })
  await toolCase("background", { command: `${chain("background")}; sleep 1; ${curl("background")}`, background: true })
  // A tool that detaches its child (setsid + exit): the client is reparented away from the server.
  await toolCase("setsidOrphan", { command: `setsid sh -c 'sleep 1; ${chain("setsidOrphan").replace(/'/g, "'\\''")}; ${curl("setsidOrphan").replace(/'/g, "'\\''")}' > /dev/null 2>&1 < /dev/null &` })

  // Persistent terminal (client-created; no tool writes into it).
  {
    const logStart = brokerLog.length
    const create = await s.api("POST", `/api/experimental/session/${ses.id}/terminal`, {
      command: "/bin/sh",
      args: ["-c", `${chain("pty")}; ${curl("pty")}; sleep 5`],
      cwd: repo,
      title: "sp-probe",
      env: {},
    })
    const status = await waitFile(join(root, "pty-status.txt"))
    // the daemon: a process whose cmdline names opencode-pty daemon under this profile
    const daemons: any[] = []
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue
      let cmd = ""
      try { cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replaceAll("\0", " ") } catch { continue }
      if (!(cmd.includes("opencode-pty") && cmd.includes("daemon"))) continue
      out.ptyDaemonsSeen = (out.ptyDaemonsSeen ?? 0) + 1
      const ppid0 = readProcessHop(Number(d))?.parentPid
      if (cmd.includes(root) || ppid0 === s.pid) {
        out.ptyDaemonRuntimeDirUnderProfile = cmd.includes(root)
        const hop = readProcessHop(Number(d))
        const walk: number[] = []
        let cur = Number(d)
        for (let i = 0; i < 32 && cur > 1; i++) { const h = readProcessHop(cur); if (!h) break; walk.push(cur); cur = h.parentPid }
        daemons.push({ pid: Number(d), parentPid: hop?.parentPid, parentIsServer: hop?.parentPid === s.pid, chainReachesServer: walk.includes(s.pid), chainComms: walk.map((x) => { try { return readFileSync(`/proc/${x}/comm`, "utf8").trim() } catch { return "?" } }) })
      }
    }
    out.cases.persistentTerminal = {
      createStatus: create.status,
      createError: create.status !== 200 ? JSON.stringify(create.body).slice(0, 300) : undefined,
      brokerStatus: status,
      clientChain: readChain("pty"),
      daemons,
      brokerLog: brokerLog.slice(logStart).map((l) => l.replace(/agent=\S+ /, "")),
    }
    const ptys = await s.api("GET", `/api/experimental/session/${ses.id}/terminal`)
    out.cases.persistentTerminal.list = (ptys.body?.data ?? []).map((x: any) => ({ id: x.id, pid: x.pid, status: x.status }))
  }

  // Control: a process the server did not start (this probe's own child).
  {
    const logStart = brokerLog.length
    // async: a spawnSync would block this process, which also runs the broker
    const proc = Bun.spawn(["sh", "-c", curl("control")])
    const exit = await proc.exited
    out.cases.controlNotServerChild = {
      exit,
      brokerStatus: await waitFile(join(root, "control-status.txt"), 5000),
      brokerLog: brokerLog.slice(logStart).map((l) => l.replace(/agent=\S+ /, "")),
    }
  }
  // Control: wrong turn handle from a real tool call.
  {
    const logStart = brokerLog.length
    await prompt(s, ses.id, `badhandle ${gateCall("shell", { command: curl("badhandle").replace(handle, "not-a-handle") })}`)
    n++
    await tap.waitFor(() => tap.events.filter((x) => x.type === "session.execution.succeeded" && x.data?.sessionID === ses.id).length >= n, 30_000).catch(() => {})
    out.cases.controlWrongHandle = { brokerStatus: await waitFile(join(root, "badhandle-status.txt"), 5000), brokerLog: brokerLog.slice(logStart).map((l) => l.replace(/agent=\S+ /, "")) }
  }
  out.toolOutcomes = toolOutcomes(tap, ses.id).map((t) => t.type.split(".").pop())
  out.upstreamHits = upstreamHits.length
  out.serverChildrenBeforeStop = Bun.spawnSync(["ps", "-o", "pid,ppid,comm", "--ppid", String(s.pid)]).stdout.toString().trim().split("\n")
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  binding.unbind()
  broker.close()
  tap.close()
  await s.stop()
  mock.stop()
  upstream.stop(true)
  await Bun.sleep(500)
  // anything still alive that names this run dir
  out.leftAfterStop = Bun.spawnSync(["pgrep", "-af", root]).stdout.toString().trim().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" ").replace(root, "<run>"))
  writeJson(`${GATE_ROOT}/evidence/sp-p6-ancestry.json`, out)
  console.info = origInfo
  console.log("done", root)
}
