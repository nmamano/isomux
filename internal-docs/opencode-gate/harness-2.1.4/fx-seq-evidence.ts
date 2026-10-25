// fx: assemble evidence/fx-seq-migrated.json from the run dir (counts only), 2026-10-25.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { grepCount, plantedControl, ERROR_REGEX } from "./cc-lib.ts"
import { writeJson } from "./common.ts"
const R = readFileSync("/tmp/t-4840abc5/run/fx-current.txt", "utf8").trim()
const j = (f: string) => JSON.parse(readFileSync(join(R, f), "utf8"))
const jl = (f: string) => { const t = readFileSync(join(R, f), "utf8").trim().split("\n"); return t.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) }
const clean = (r: any) => {
  const x = JSON.parse(JSON.stringify(r))
  delete x.pid
  for (const v of Object.values<any>(x.logs ?? {})) if (v?.firstErrorLines) v.firstErrorLines = v.firstErrorLines.map((l: string) => l.split("\\nparams:")[0].replace(/run=\w+ /, "").slice(0, 260))
  return x
}
const seq = (f: string) => { const c = j(f); return { ...c, perSession: c.perSession.map((p: any) => ({ s: p.s, imported: p.imported, eventSequence: p.eventSequence, maxMessageSeq: p.maxMessageSeq, messages: p.messages, maxEventSeq: p.maxEventSeq })) } }
const logs = (dirs: string[], profileLog: string) => {
  const files = [...dirs.map((d) => join(R, d, "server.log")), profileLog]
  const err = grepCount(files)
  const info = grepCount(files, "level=INFO")
  return { method: `grep -c -E '${ERROR_REGEX}' per file; knownLineControl = grep -c 'level=INFO' on the same file`, files: files.map((f) => ({ file: f.replace(R, "<run>"), seqErrorPatternCount: err[f], knownLineControl_levelINFO: info[f] })) }
}
const flow = (pfx: string, profileLogDir: string, idsFile: string) => ({
  migrate: clean(j(`${pfx}-migrate/result.json`)),
  seqCheckAfterMigration: seq(`${pfx}-check1.json`),
  turnsA_moveAndTwoToolTurns: clean(j(`${pfx}-turns-a/result.json`)),
  seqCheckAfterTurnsA: seq(`${pfx}-check2.json`),
  turnsB_afterSigtermRestart_oneToolTurn: clean(j(`${pfx}-turns-b/result.json`)),
  seqCheckAfterRestartTurn: seq(`${pfx}-check3.json`),
  serverLogGrep: logs([`${pfx}-migrate`, `${pfx}-turns-a`, `${pfx}-turns-b`], join(profileLogDir, "data/opencode/log/opencode.log")),
})
const planted = plantedControl(R)
const out = {
  item: "#53146 single-writer / event_sequence check on v1-imported sessions (2.1.4)",
  date: "2026-10-25",
  binaries: { v2: "opencode 2.1.4", v1: "opencode 1.18.35 (synthetic seed only)" },
  runDir: R,
  method: [
    "Real office profile copied with cp -a after a /proc scan (ls -l /proc/*/fd and /proc/*/cwd | grep -c <profile id>) found 0 holders, with a positive control (a sleep holding a file and cwd under a path with the id: 2 fd hits, 2 cwd hits) and server.lock = 0 bytes; sha256 of opencode.db, -wal, -shm equal to the source.",
    "2.1.4 started on the copy in the Isomux profile layout (HOME/XDG_*/TMPDIR inside the copy, the copy's opencode.json as OPENCODE_CONFIG, mock provider in OPENCODE_CONFIG_CONTENT, OPENCODE_DISABLE_MODELS_FETCH=1, OPENCODE_DISABLE_FREE_MODELS=1, HTTP(S)_PROXY to a closed port), GET /api/experimental/migration/v1 polled until completed, SIGTERM.",
    "Seq check (fx-seq.ts seqCheck) on a copy of db+wal+shm taken with the server stopped: per session_v2 row, event_sequence.seq vs max(session_message.seq) and max(event.seq).",
    "Second start: every imported session moved (POST /api/session/:id/move) to its own scratch git repo under the run dir, model switched to the mock, then turn 1 = GATE_CALL shell (printf original > fx-edit.txt), turn 2 = GATE_CALL edit (original -> changed); every permission.asked answered once. SIGTERM. Seq check. Third start: 1 GATE_CALL shell turn per session. SIGTERM. Seq check.",
    "Server logs (--print-logs stdout/stderr and data/opencode/log/opencode.log) grepped with cc-lib ERROR_REGEX; planted-line control and a known-line control on the same files.",
    "Same flow on a synthetic v1 profile seeded by 1.18.35 with the mock (5 sessions x 4 turns, bash and write tool calls); one of its 5 repos renamed away before the 2.1.4 start so one session takes the folder-gone move path.",
    "Positive controls on copies of the finished synthetic profile: event_sequence of one session lowered (by 5, and set to 0) with the server stopped, then 1 turn.",
  ],
  preconditions: {
    procScan: { fdHits: 0, cwdHits: 0, control: { fdHits: 2, cwdHits: 2, afterControlStopped: { fdHits: 0, cwdHits: 0 } } },
    serverLockBytes: 0,
    sha256Match: { "opencode.db": true, "opencode.db-wal": true, "opencode.db-shm": true },
    fileCount: { source: 25, copy: 25 },
    sourceDbShaPrefixBeforeAndAfterBothCopies: "b54aa35e3cd2d02d (unchanged)",
  },
  realProfile: {
    copy: "copy2 (fresh copy; copy1 was the first attempt, see firstAttemptCopy1)",
    v1Census: jl("census0.log")[0],
    v1CountersBeforeImport: jl("preseq.log")[1],
    ...flow("c2", join(R, "copy2"), "c2-ids.json"),
    firstAttemptCopy1: {
      note: "Same migrate + seq check gave the same counters. In turns-a the move of s1/s2 returned 204 but the location had not changed yet when the probe re-read it, so the probe skipped writing (never ran tools in a real folder). 2.1.4 queues a move in the session inbox when the source folder still exists (core/src/session/move.ts:129-156); fx-seq.ts now waits for the location (appliedMs). Copy1 is not used for the verdict.",
      seqCheckAfterMigration: seq("real-check1.json"),
      turnsA: clean(j("real-turns-a/result.json")).sessions.map((s: any) => ({ s: s.s, move: s.move, skipped: s.skipped, turns: s.turns?.map((t: any) => t.outcome) })),
    },
  },
  syntheticProfile: {
    seedBy1_18_35: j("syn2-v1seed/result.json").sessions.map((s: any) => ({ s: s.s, turns: s.turns.map((t: any) => `${t.outcome}:${t.tools.join(",")}`) })),
    folderGoneSessions: 1,
    v1Census: jl("syn2-census0.log")[0],
    v1CountersBeforeImport: jl("syn2-preseq.log")[1],
    ...flow("syn2", join(R, "syn2/profile"), "syn2-ids.json"),
  },
  positiveControls: {
    lowerBy5: { edit: jl("ctl-lower.log")[0], turn: clean(j("ctl-turns/result.json")).sessions[0].turns, logs: clean(j("ctl-turns/result.json")).logs, seqCheckAfter: seq("ctl-check.json").vsMaxSessionMessageSeq, note: "no collision: the events that took seq 69..73 did not insert a session_message row on an occupied seq; the counter ended equal to max again" },
    setTo0: { edit: jl("ctl2-lower.log")[0], turn: clean(j("ctl2-turns/result.json")).sessions[0].turns, logs: clean(j("ctl2-turns/result.json")).logs, note: "#53146 reproduced: UNIQUE constraint failed on insert into session_message; the turn produced no terminal event (probe timeout 60 s)" },
  },
  plantedPatternControl: { ...planted, file: planted.file.replace(R, "<run>") },
}
writeJson("/tmp/t-4840abc5/evidence/fx-seq-migrated.json", out)
console.log(JSON.stringify({ ok: true, planted: planted.perPattern }))
