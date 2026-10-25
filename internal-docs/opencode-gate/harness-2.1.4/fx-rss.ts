// fx S8: 2.1.4 server memory, idle and with N sessions mid-turn (task 4840abc5, 2026-10-25).
// Usage (inside systemd-run --user --scope -p MemoryMax=4G): bun run fx-rss.ts <N> <outJson> <runDir>
// RSS and PSS of the server process plus all descendants from /proc/<pid>/smaps_rollup.
// The mock (mg-mock, GATE_ABORT_MS=180000) holds every response open, so turns stay busy.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, mockProviderConfig, tapEvents, writeJson, TURN_END } from "./common.ts"
import { startServerT } from "./mg-server.ts"
import { startMgMock } from "./fx-seq.ts"

const N = Number(process.argv[2])
const outJson = process.argv[3]!
const runDir = process.argv[4]!
mkdirSync(runDir, { recursive: true })
const netEnv = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }

function cgroupEventsPath() {
  const line = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").find((l) => l.startsWith("0::"))!
  return { cgroup: line.slice(3), path: join("/sys/fs/cgroup", line.slice(3), "memory.events"), maxPath: join("/sys/fs/cgroup", line.slice(3), "memory.max") }
}
function memEvents(p: string) {
  const o: Record<string, number> = {}
  for (const l of readFileSync(p, "utf8").trim().split("\n")) { const [k, v] = l.split(" "); o[k!] = Number(v) }
  return o
}
function descendants(root: number) {
  const kids = new Map<number, number[]>()
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8")
      const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid)!.push(Number(d))
    } catch {}
  }
  const out: number[] = []
  const q = [root]
  while (q.length) { const p = q.shift()!; out.push(p); for (const c of kids.get(p) ?? []) q.push(c) }
  return out
}
function sample(label: string, root: number) {
  const procs: any[] = []
  let rss = 0, pss = 0
  for (const pid of descendants(root)) {
    try {
      const t = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
      const r = Number(/^Rss:\s+(\d+) kB/m.exec(t)?.[1] ?? 0)
      const p = Number(/^Pss:\s+(\d+) kB/m.exec(t)?.[1] ?? 0)
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
      procs.push({ comm, rssKiB: r, pssKiB: p })
      rss += r; pss += p
    } catch {}
  }
  return { label, at: new Date().toISOString(), processes: procs, totalRssKiB: rss, totalPssKiB: pss, totalRssMiB: +(rss / 1024).toFixed(1), totalPssMiB: +(pss / 1024).toFixed(1) }
}

const cg = cgroupEventsPath()
const res: any = { item: "S8 memory", date: "2026-10-25", binary: "opencode 2.1.4", N, cgroup: { scope: cg.cgroup.split("/").pop(), memoryMax: existsSync(cg.maxPath) ? readFileSync(cg.maxPath, "utf8").trim() : null, eventsBefore: memEvents(cg.path) } }
const p = makeProfile(join(runDir, "profile"))
const repo = makeRepo(join(runDir, "repo"))
const mockLog = join(runDir, "mock.log")
const mock = await startMgMock(mockLog, { MOCK_SHELL_TOOL: "shell", GATE_ABORT_MS: "180000" })
const s = await startServerT(p, { configContent: mockProviderConfig(mock), env: netEnv, logPath: join(runDir, "server.log") })
try {
  const tap = await tapEvents(s, join(runDir, "events.jsonl"))
  // Warm the location the same way for every N (plugin activation, config) so idle is comparable.
  await s.api("GET", `/api/plugin?location[directory]=${encodeURIComponent(repo)}`)
  await Bun.sleep(8000)
  res.idle = sample("server-idle-no-sessions", s.pid)
  if (N > 0) {
    const ids: string[] = []
    for (let i = 0; i < N; i++) {
      const r = await s.api("POST", "/api/session", { location: { directory: repo } })
      ids.push(r.body.data.id)
    }
    await Bun.sleep(3000)
    res.createdIdle = sample(`${N}-created-idle-sessions`, s.pid)
    const before = tap.events.length
    const pr = await Promise.all(ids.map((id, i) => s.api("POST", `/api/session/${id}/prompt`, { text: `GATE_ABORT fx rss hold ${i}` })))
    res.promptHttp = pr.map((r) => r.status)
    // Busy = execution.started and step.started seen, no terminal event, and the
    // mock has received the request (it holds it for 180 s).
    const t0 = Date.now()
    const busy = () => ids.filter((id) => {
      const ev = tap.events.slice(before).filter((e) => e.data?.sessionID === id)
      const st = ev.filter((e) => e.type === "session.status").at(-1)
      return ev.some((e) => e.type === "session.execution.started") && ev.some((e) => e.type === "session.step.started") && !ev.some((e) => TURN_END.includes(e.type)) && (!st || st.data?.status?.type === "busy")
    }).length
    const mockReqs = () => (existsSync(mockLog) ? readFileSync(mockLog, "utf8").split("\n").filter((l) => l.includes('"messageCount"')).length : 0)
    while (Date.now() - t0 < 60_000 && (busy() < N || mockReqs() < N)) await Bun.sleep(100)
    await Bun.sleep(3000)
    const b = busy()
    res.midTurn = sample(`${N}-mid-turn-sessions`, s.pid)
    res.busyConfirmed = `${b}/${N}`
    res.busyRecheckAfterSample = `${busy()}/${N}`
    res.mockRequestsHeld = mockReqs()
    res.sessionStatusEventsSeen = tap.events.slice(before).filter((e) => e.type === "session.status").length
    res.terminalEventsDuringHold = tap.events.slice(before).filter((e) => TURN_END.includes(e.type)).length
    res.msToAllBusy = Date.now() - t0 - 3000
    res.increments = { midTurnMinusIdle: { rssMiB: +((res.midTurn.totalRssKiB - res.idle.totalRssKiB) / 1024).toFixed(1), pssMiB: +((res.midTurn.totalPssKiB - res.idle.totalPssKiB) / 1024).toFixed(1) }, createdMinusIdle: { rssMiB: +((res.createdIdle.totalRssKiB - res.idle.totalRssKiB) / 1024).toFixed(1) } }
    await Promise.all(ids.map((id) => s.api("POST", `/api/session/${id}/interrupt?resume=false`)))
  }
  tap.close()
} catch (e) { res.error = String(e).slice(0, 300) }
await s.stop("SIGTERM")
mock.stop()
await Bun.sleep(500)
res.cgroup.eventsAfter = memEvents(cg.path)
res.serverExit = { code: s.proc.exitCode, signal: s.proc.signalCode }
writeJson(outJson, res)
console.log(JSON.stringify({ N, idle: res.idle?.totalRssMiB, idlePss: res.idle?.totalPssMiB, created: res.createdIdle?.totalRssMiB, mid: res.midTurn?.totalRssMiB, midPss: res.midTurn?.totalPssMiB, inc: res.increments, busy: res.busyConfirmed, recheck: res.busyRecheckAfterSample, mockHeld: res.mockRequestsHeld, statusEv: res.sessionStatusEventsSeen, procs: res.midTurn?.processes?.length ?? res.idle?.processes?.length, oomBefore: res.cgroup.eventsBefore.oom_kill, oomAfter: res.cgroup.eventsAfter.oom_kill, error: res.error }))
