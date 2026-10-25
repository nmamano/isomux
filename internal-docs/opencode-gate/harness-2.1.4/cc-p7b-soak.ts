// P7b soak (task 4840abc5, 2026-10-25): one 2.1.4 server, one profile, 16
// sessions over 2 git repos, tool-calling turns, one SIGTERM and one SIGKILL
// mid-turn, restart on the same profile, more turns on the SAME sessions.
// Usage: bun run cc-p7b-soak.ts <runLabel> <evidencePath>
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  GATE_ROOT,
  makeProfile,
  makeRepo,
  startMock,
  mockProviderConfig,
  startServer,
  tapEvents,
  createSession,
  writeJson,
  type Server,
  type EventTap,
} from "./common.ts"
import { copyAndCheck, grepCount, plantedControl, turn, ERROR_REGEX } from "./cc-lib.ts"

const label = process.argv[2] ?? "r1"
const evidencePath = process.argv[3] ?? `${GATE_ROOT}/evidence/cc-p7b-${label}.json`
const root = `${GATE_ROOT}/run/cc-p7b-${Date.now()}-${label}`
const profile = makeProfile(join(root, "profile"))
const repos = [makeRepo(join(root, "repoA")), makeRepo(join(root, "repoB"))]
const N = 16
const ev: any = { item: "P7b", label, date: "2026-10-25", runDir: root, binary: "opencode 2.1.4", phases: [], restarts: [], dbChecks: [] }
const log = (...a: any[]) => console.log(new Date().toISOString(), ...a)

const mock = await startMock(join(root, "mock.log"), { MOCK_SHELL_TOOL: "shell", GATE_ABORT_MS: "7000" })
const config = mockProviderConfig(mock)
let startNo = 0
const serverLogs: string[] = []
const eventFiles: string[] = []
const passwords: string[] = []

async function boot(): Promise<{ s: Server; tap: EventTap }> {
  startNo++
  const logPath = join(root, `server-${startNo}.log`)
  const t0 = Date.now()
  const s = await startServer(profile, { config, logPath })
  passwords.push(s.password)
  serverLogs.push(logPath)
  const jsonl = join(root, `events-${startNo}.jsonl`)
  eventFiles.push(jsonl)
  const tap = await tapEvents(s, jsonl)
  log("server", startNo, "pid", s.pid, "healthy in", Date.now() - t0, "ms")
  return { s, tap }
}

// Prompt kinds. Each makes a tool call: shell write, write tool, edit tool.
function promptFor(kind: number, i: number, r: string, dir: string) {
  if (kind === 0)
    return `turn ${r} GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `printf '${r}\\n' >> shell-${i}.txt && git status --short | wc -l` } })}`
  if (kind === 1)
    return `turn ${r} GATE_CALL:${JSON.stringify({ tool: "write", args: { path: join(dir, `w-${i}.txt`), content: `written ${r}\n` } })}`
  return `turn ${r} GATE_CALL:${JSON.stringify({ tool: "edit", args: { path: join(dir, `e-${i}.txt`), oldString: "MARK", newString: `MARK\nedit ${r}` } })}`
}

const sessions: { id: string; dir: string; i: number }[] = []
const turns: any[] = []
const toolStats = () => {
  const counts: Record<string, number> = {}
  return counts
}
void toolStats

async function normalRounds(s: Server, tap: EventTap, phase: string, rounds: number) {
  const t0 = Date.now()
  const res = await Promise.all(
    sessions.map(async (ss) => {
      const out: any[] = []
      for (let r = 0; r < rounds; r++) {
        const kind = (r + ss.i) % 3
        const tr = await turn(s, tap, ss.id, promptFor(kind, ss.i, `${phase}-${r}`, ss.dir))
        out.push({ phase, session: ss.i, round: r, kind: ["shell", "write", "edit"][kind], ...tr })
      }
      return out
    }),
  )
  const flat = res.flat()
  turns.push(...flat)
  ev.phases.push({ phase, kind: "normal", rounds, turns: flat.length, ms: Date.now() - t0, outcomes: tally(flat) })
  log(phase, tally(flat))
}

function tally(list: any[]) {
  const t: Record<string, number> = {}
  for (const x of list) {
    const k = x.outcome + (x.reason ? `:${x.reason}` : "")
    t[k] = (t[k] ?? 0) + 1
  }
  return t
}

// Kill round: even sessions sit in a slow shell call, odd sessions wait on a
// slow model stream (GATE_ABORT, 7 s). Kill once all 16 are mid-turn.
async function killRound(s: Server, tap: EventTap, phase: string, signal: "SIGTERM" | "SIGKILL") {
  const startIdx = tap.events.length
  const pending = sessions.map((ss) => {
    const text =
      ss.i % 2 === 0
        ? `slow ${phase} GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `sleep 8; printf done >> ${join(ss.dir, `slow-${phase}-${ss.i}.txt`)}` } })}`
        : `slow ${phase} GATE_ABORT GATE_CALL:${JSON.stringify({ tool: "write", args: { path: join(ss.dir, `slowwrite-${ss.i}.txt`), content: "late\n" } })}`
    return turn(s, tap, ss.id, text, 60_000).then((tr) => ({ phase, session: ss.i, kind: ss.i % 2 === 0 ? "slow-shell" : "slow-model", ...tr }))
  })
  // Wait until every session is mid-turn: execution.started for all, tool.called for the shell ones.
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    const after = tap.events.slice(startIdx)
    const started = new Set(after.filter((e) => e.type === "session.execution.started").map((e) => e.data?.sessionID))
    const called = new Set(after.filter((e) => e.type === "session.tool.called").map((e) => e.data?.sessionID))
    if (sessions.every((ss) => started.has(ss.id) && (ss.i % 2 === 1 || called.has(ss.id)))) {
      ready = true
      break
    }
    await Bun.sleep(50)
  }
  await Bun.sleep(700)
  const terminalBeforeKill = tap.events.slice(startIdx).filter((e) => ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(e.type)).length
  const tk = Date.now()
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    s.proc.once("exit", (code, sig) => resolve({ code, signal: sig })),
  )
  s.proc.kill(signal)
  const ex = await Promise.race([exited, Bun.sleep(15_000).then(() => null)])
  let forced = false
  if (!ex) {
    forced = true
    s.proc.kill("SIGKILL")
  }
  const exit = ex ?? (await exited)
  const exitMs = Date.now() - tk
  const results = await Promise.all(pending)
  turns.push(...results)
  tap.close()
  // Shell children that outlive the server (SIGKILL leaves them orphaned).
  const orphans = new TextDecoder().decode(Bun.spawnSync(["pgrep", "-af", `slow-`]).stdout).split("\n").filter((l) => l.includes(root))
  const r = {
    phase,
    signal,
    allMidTurnAtKill: ready,
    terminalEventsBeforeKill: terminalBeforeKill,
    exit,
    exitMs,
    forcedSigkillAfter15s: forced,
    outcomes: tally(results),
    orphanShellProcessesRightAfterExit: orphans.length,
  }
  ev.restarts.push(r)
  log(phase, JSON.stringify(r))
  return r
}

function dbCheck(when: string) {
  const c = copyAndCheck(profile.data, join(root, `dbcopy-${ev.dbChecks.length + 1}`))
  const { perSession, ...summary } = c
  ev.dbChecks.push({ when, ...summary, perSession })
  log("dbcheck", when, "violating", c.violatingSessions, "dupMsg", c.duplicateSessionMessageSeq, "suspended", c.sessionsWithSuspendedClaim, "quick", c.quickCheck.join(","))
}

async function afterRestart(s: Server, tap: EventTap, phase: string) {
  // Does the foreground server resume suspended turns by itself? Watch 5 s.
  await Bun.sleep(5000)
  const auto = tap.events.filter((e) => sessions.some((ss) => ss.id === e.data?.sessionID))
  const active = await s.api("GET", "/api/session/active")
  const watch = {
    phase,
    sessionEventsIn5sWithoutPrompt: auto.length,
    sessionEventTypes: [...new Set(auto.map((e) => e.type))],
    activeEndpoint: { status: active.status, body: JSON.stringify(active.body).slice(0, 400) },
  }
  const msgs: any[] = []
  for (const ss of sessions.slice(0, 2)) {
    const m = await s.api("GET", `/api/session/${ss.id}/message`)
    const list = Array.isArray(m.body?.data) ? m.body.data : Array.isArray(m.body?.data?.items) ? m.body.data.items : []
    msgs.push({ session: ss.i, status: m.status, count: list.length, last: list.slice(-3).map((x: any) => JSON.stringify(x).slice(0, 600)) })
  }
  ;(watch as any).messagesBeforeContinue = msgs
  // Continue each interrupted session with a new prompt.
  const res = await Promise.all(
    sessions.map(async (ss) => ({
      phase: `${phase}-continue`,
      session: ss.i,
      kind: "continue-shell",
      ...(await turn(s, tap, ss.id, `continue after restart GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `printf cont >> cont-${ss.i}.txt` } })}`)),
    })),
  )
  turns.push(...res)
  const r = { ...watch, continueOutcomes: tally(res) }
  ev.phases.push({ phase: `${phase}-continue`, kind: "continue", ...r })
  log(phase, "continue", JSON.stringify(r))
}

try {
  let { s, tap } = await boot()
  for (let i = 0; i < N; i++) {
    const dir = repos[i % 2]!
    writeFileSync(join(dir, `e-${i}.txt`), "MARK\n")
    const ses = await createSession(s, dir)
    sessions.push({ id: ses.id, dir, i })
  }
  await normalRounds(s, tap, "A", 3)
  await killRound(s, tap, "K1-SIGTERM", "SIGTERM")
  dbCheck("after SIGTERM mid-turn (server stopped)")
  ;({ s, tap } = await boot())
  await afterRestart(s, tap, "R1")
  await normalRounds(s, tap, "B", 2)
  await killRound(s, tap, "K2-SIGKILL", "SIGKILL")
  dbCheck("after SIGKILL mid-turn (server stopped)")
  ;({ s, tap } = await boot())
  await afterRestart(s, tap, "R2")
  await normalRounds(s, tap, "C", 2)
  tap.close()
  await s.stop("SIGTERM")
  dbCheck("after final idle SIGTERM (server stopped)")
} catch (e: any) {
  ev.fatal = String(e?.stack ?? e)
  log("FATAL", e)
} finally {
  mock.stop()
}

// Tool outcome counts from the event streams.
const toolCounts: Record<string, number> = {}
const callName = new Map<string, string>()
for (const f of eventFiles) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue
    const e = JSON.parse(line)
    if (e.type === "session.tool.input.started") callName.set(e.data.id, e.data.name)
    if (["session.tool.success", "session.tool.failed", "session.tool.called"].includes(e.type)) {
      const k = `${f.endsWith("events-1.jsonl") ? "s1" : f.endsWith("events-2.jsonl") ? "s2" : "s3"}:${e.type}:${callName.get(e.data?.id) ?? "?"}${e.type === "session.tool.failed" ? ":" + (e.data?.error?.message ?? "") : ""}`
      toolCounts[k] = (toolCounts[k] ?? 0) + 1
    }
  }
}
ev.toolEventCounts = toolCounts
ev.turnsTotal = turns.length
ev.turnOutcomes = tally(turns)
ev.turnsByPhase = Object.fromEntries([...new Set(turns.map((t) => t.phase))].map((p) => [p, tally(turns.filter((t) => t.phase === p))]))
ev.nonTerminalTurnsOutsideKillRounds = turns.filter((t) => !t.phase.startsWith("K") && !t.outcome.startsWith("session.execution.")).map((t) => ({ phase: t.phase, session: t.session, outcome: t.outcome, body: t.body }))
ev.failedTurnsOutsideKillRounds = turns.filter((t) => !t.phase.startsWith("K") && t.outcome !== "session.execution.succeeded").map((t) => ({ phase: t.phase, session: t.session, kind: t.kind, outcome: t.outcome, reason: t.reason, error: t.error }))
ev.sideEffects = {
  // A shell side effect that landed after the server was stopped (the sleep 8 outlived it).
  slowShellDoneFiles_SIGTERM: [...Array(N).keys()].filter((i) => existsSync(join(repos[i % 2]!, `slow-K1-SIGTERM-${i}.txt`))).length,
  slowShellDoneFiles_SIGKILL: [...Array(N).keys()].filter((i) => existsSync(join(repos[i % 2]!, `slow-K2-SIGKILL-${i}.txt`))).length,
  slowShellTurnsPerKill: N / 2,
}
ev.grep = {
  regex: ERROR_REGEX,
  method: "grep -c -E <regex> <file> per file",
  serverLogs: grepCount(serverLogs),
  eventStreams: grepCount(eventFiles),
  control: plantedControl(root),
  // Context: error-level lines of any kind.
  errorLevelLines: grepCount(serverLogs, "level=ERROR"),
  distinctErrorMessages: [
    ...new Set(
      serverLogs.flatMap((f) =>
        existsSync(f)
          ? readFileSync(f, "utf8")
              .split("\n")
              .filter((l) => l.includes("level=ERROR") || l.includes("level=WARN"))
              .map((l) => (/(level=\w+).*?message="([^"]*)"/.exec(l) ?? []).slice(1).join(" "))
          : [],
      ),
    ),
  ],
}
ev.processes = { mockPid: mock.proc.pid }
let text = JSON.stringify(ev, null, 2)
for (const p of passwords) text = text.split(p).join("[REDACTED]")
writeFileSync(evidencePath, text + "\n")
log("wrote", evidencePath, "turns", turns.length, JSON.stringify(ev.turnOutcomes))
process.exit(0)
