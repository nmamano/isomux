// Follow-up (2026-10-25): does `opencode serve` resume turns whose claim was kept
// (reject -> interrupted reason "shutdown"; SIGTERM mid-turn) on the next boot?
// Usage: bun run ev-s4-restart.ts <s4-run-dir> <shell_deny sessionID>
import { readFileSync, existsSync } from "node:fs"
import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, writeJson, TURN_END, type Server } from "./common.ts"
import { Manifest, sendPrompt, waitEvent, EVIDENCE, copyRedacted } from "./ev-lib.ts"

const [runDir, denySid] = process.argv.slice(2)
const p = makeProfile(runDir)
const repo = makeRepo(`${runDir}/repo`)
const man = new Manifest(`${EVIDENCE}/ev-s4-restart${process.argv[4] ?? ""}-manifest.json`)
const tagOut = process.argv[4] ?? ""
const out: any = { date: "2026-10-25", run: runDir, denySid }
const servers: Server[] = []
const procs: string[] = []
const mock = await startMock(`${runDir}/mock-restart.log`, { MOCK_SHELL_TOOL: "shell" })
procs.push(`mock pid=${mock.proc.pid}`)
const cfg = mockProviderConfig(mock)
const pick = (evs: any[], sid: string) => evs.filter((e) => e.data?.sessionID === sid).map((e) => ({ type: e.type, reason: e.data.reason, seq: e.durable?.seq }))
try {
  // Boot 1 on the S4 profile: watch the denied session for 10 s.
  const s1 = await startServer(p, { config: cfg, logPath: `${runDir}/server-restart1.log` })
  servers.push(s1); procs.push(`server-restart1 pid=${s1.pid}`)
  const tap1 = await tapEvents(s1, `${runDir}/events-restart1.jsonl`)
  out.deniedBefore = (await s1.api("GET", `/api/session/${denySid}`)).body?.data
  await Bun.sleep(10000)
  out.boot1 = {
    deniedSessionEvents: pick(tap1.events, denySid),
    allExecutionEvents: tap1.events.filter((e) => e.type.startsWith("session.execution")).map((e) => ({ type: e.type, sid: e.data.sessionID, reason: e.data.reason })),
    permissionAsked: tap1.events.filter((e) => e.type === "permission.asked").map((e) => ({ sid: e.data.sessionID, resources: e.data.resources })),
    mockRequests: existsSync(`${runDir}/mock-restart.log`) ? readFileSync(`${runDir}/mock-restart.log`, "utf8").split("\n").filter((l) => l.includes('"prompt"')).length : 0,
    deniedAfter: (await s1.api("GET", `/api/session/${denySid}`)).body?.data,
  }
  // In-flight turn at SIGTERM.
  const r = await s1.api("POST", "/api/session", { location: { directory: repo } })
  const sid = r.body.data.id
  out.inflightSid = sid
  await sendPrompt(s1, man, "inflight", sid, "GATE_ABORT inflight at sigterm")
  await waitEvent(tap1, (e) => e.type === "session.execution.started" && e.data?.sessionID === sid)
  await Bun.sleep(700)
  await s1.stop("SIGTERM")
  await Bun.sleep(200)
  tap1.close()
  out.boot1Exit = { code: s1.proc.exitCode, sig: s1.proc.signalCode }
  out.boot1InflightEvents = pick(tap1.events, sid)
  // Boot 2: does the in-flight turn resume?
  const s2 = await startServer(p, { config: cfg, logPath: `${runDir}/server-restart2.log` })
  servers.push(s2); procs.push(`server-restart2 pid=${s2.pid}`)
  const tap2 = await tapEvents(s2, `${runDir}/events-restart2.jsonl`)
  await Bun.sleep(10000)
  out.boot2 = {
    inflightEvents: pick(tap2.events, sid),
    deniedEvents: pick(tap2.events, denySid),
    allExecutionEvents: tap2.events.filter((e) => e.type.startsWith("session.execution")).map((e) => ({ type: e.type, sid: e.data.sessionID, reason: e.data.reason })),
    inflightSession: (await s2.api("GET", `/api/session/${sid}`)).body?.data,
    inflightMessages: ((await s2.api("GET", `/api/session/${sid}/message?order=asc`)).body?.data ?? []).map((m: any) => ({ type: m.type, text: JSON.stringify(m.payload ?? m.content ?? "").slice(0, 160) })),
    mockPrompts: readFileSync(`${runDir}/mock-restart.log`, "utf8").split("\n").filter((l) => l.includes('"prompt"')),
  }
  // A prompt on the denied session still works?
  await sendPrompt(s2, man, "denied-next", denySid, "EV after deny next turn")
  const end = await waitEvent(tap2, (e) => TURN_END.includes(e.type) && e.data?.sessionID === denySid, 20000).catch((e) => ({ type: String(e) }))
  out.deniedNextTurn = { terminal: end.type, events: pick(tap2.events, denySid).slice(-6) }
  tap2.close()
  await s2.stop("SIGTERM")
  out.boot2Exit = { code: s2.proc.exitCode, sig: s2.proc.signalCode }
  copyRedacted(`${runDir}/events-restart1.jsonl`, `${EVIDENCE}/ev-s4-restart${tagOut}-boot1-events.jsonl`, servers.map((x) => x.password))
  copyRedacted(`${runDir}/events-restart2.jsonl`, `${EVIDENCE}/ev-s4-restart${tagOut}-boot2-events.jsonl`, servers.map((x) => x.password))
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  for (const sv of servers) await sv.stop("SIGKILL").catch(() => {})
  mock.stop()
  out.processes = procs
  man.save()
  writeJson(`${EVIDENCE}/ev-s4-restart${tagOut}.json`, out)
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}
