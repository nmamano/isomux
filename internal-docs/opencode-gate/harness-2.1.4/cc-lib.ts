// Helpers for the cc (P7 concurrency) probes, task 4840abc5, 2026-10-25.
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Server, EventTap } from "./common.ts"
import { TURN_END } from "./common.ts"

export const ERROR_PATTERNS = [
  "UNIQUE constraint failed",
  "SQLITE_CONSTRAINT",
  "Sequence mismatch",
  "Replay diverged",
  "already exists at aggregate",
  "InvalidDurableEvent",
]
export const ERROR_REGEX = ERROR_PATTERNS.join("|")

// grep -c -E over each file; returns per-file counts. Used for both the real
// files and a planted control file.
export function grepCount(files: string[], regex = ERROR_REGEX): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of files) {
    if (!existsSync(f)) {
      out[f] = -1
      continue
    }
    const r = Bun.spawnSync(["grep", "-c", "-E", regex, f])
    out[f] = Number(new TextDecoder().decode(r.stdout).trim() || "0")
  }
  return out
}

// Proves each alternative of the pattern matches a planted line.
export function plantedControl(dir: string) {
  const f = join(dir, "planted-control.log")
  const results: Record<string, number> = {}
  for (const p of ERROR_PATTERNS) {
    appendFileSync(f, `timestamp=x level=ERROR message="planted ${p} control line"\n`)
  }
  const total = grepCount([f])[f]
  for (const p of ERROR_PATTERNS) results[p] = grepCount([f], p)[f]
  return { file: f, linesPlanted: ERROR_PATTERNS.length, totalMatched: total, perPattern: results }
}

// Copy db + -wal + -shm (server must be stopped) and run read-only checks.
export function copyAndCheck(dataDir: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  const src = join(dataDir, "opencode", "opencode.db")
  const copied: string[] = []
  for (const suf of ["", "-wal", "-shm"]) {
    if (existsSync(src + suf)) {
      copyFileSync(src + suf, join(dest, "opencode.db" + suf))
      copied.push("opencode.db" + suf)
    }
  }
  return { copied, ...checkDb(join(dest, "opencode.db")) }
}

export function checkDb(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    const tables = new Set((db.query(`select name from sqlite_master where type='table'`).all() as any[]).map((r) => r.name))
    const integrity = (db.query(`pragma quick_check`).all() as any[]).map((r) => Object.values(r)[0])
    const seqRows = db.query(`select aggregate_id a, seq from event_sequence`).all() as any[]
    const seqMap = new Map(seqRows.map((r) => [r.a, r.seq]))
    const msgMax = new Map(
      (db.query(`select session_id a, max(seq) m, count(*) c from session_message group by session_id`).all() as any[]).map((r) => [r.a, r]),
    )
    const evMax = new Map(
      (db.query(`select aggregate_id a, max(seq) m, count(*) c from event group by aggregate_id`).all() as any[]).map((r) => [r.a, r]),
    )
    const sessions = (db.query(`select id from session_v2`).all() as any[]).map((r) => r.id as string)
    const dupMsg = (db.query(`select count(*) c from (select session_id, seq from session_message group by session_id, seq having count(*)>1)`).get() as any).c
    const dupEv = (db.query(`select count(*) c from (select aggregate_id, seq from event group by aggregate_id, seq having count(*)>1)`).get() as any).c
    const violations: any[] = []
    let sessionMessages = 0
    let events = 0
    for (const id of sessions) {
      const es = seqMap.get(id)
      const mm = msgMax.get(id)?.m
      const me = evMax.get(id)?.m
      sessionMessages += msgMax.get(id)?.c ?? 0
      events += evMax.get(id)?.c ?? 0
      const bad =
        (es === undefined && (mm !== undefined || me !== undefined)) ||
        (es !== undefined && mm !== undefined && es < mm) ||
        (es !== undefined && me !== undefined && es < me)
      if (bad) violations.push({ session: id, event_sequence: es ?? null, maxMessageSeq: mm ?? null, maxEventSeq: me ?? null })
    }
    // Non-session aggregates in event too.
    const otherViolations: any[] = []
    for (const [a, r] of evMax) {
      if (sessions.includes(a)) continue
      const es = seqMap.get(a)
      if (es === undefined || es < r.m) otherViolations.push({ aggregate: a, event_sequence: es ?? null, maxEventSeq: r.m })
    }
    const suspended = tables.has("session_v2")
      ? (db.query(`select count(*) c from session_v2 where time_suspended is not null`).get() as any).c
      : null
    const idle = tables.has("session_v2")
      ? (db.query(`select idle_outcome o, count(*) c from session_v2 group by idle_outcome`).all() as any[])
      : null
    return {
      quickCheck: integrity,
      sessions: sessions.length,
      sessionMessageRows: sessionMessages,
      eventRows: events,
      eventSequenceRows: seqRows.length,
      duplicateSessionMessageSeq: dupMsg,
      duplicateEventSeq: dupEv,
      violatingSessions: violations.length,
      violations,
      otherAggregateViolations: otherViolations.length,
      sessionsWithSuspendedClaim: suspended,
      idleOutcomes: idle,
      perSession: sessions.map((id) => ({
        s: id.slice(-6),
        es: seqMap.get(id) ?? null,
        mm: msgMax.get(id)?.m ?? null,
        me: evMax.get(id)?.m ?? null,
      })),
    }
  } finally {
    db.close()
  }
}

// Sends one v2 prompt and waits for the next terminal event for that session,
// looking only at events that arrive after the prompt was sent.
export async function turn(server: Server, tap: EventTap, sessionID: string, text: string, timeoutMs = 90_000) {
  const startIdx = tap.events.length
  const t0 = Date.now()
  const r = await server.api("POST", `/api/session/${sessionID}/prompt`, { text })
  if (r.status !== 200) return { outcome: "prompt_rejected", status: r.status, body: JSON.stringify(r.body).slice(0, 300), ms: Date.now() - t0 }
  for (;;) {
    for (let i = startIdx; i < tap.events.length; i++) {
      const e = tap.events[i]
      if (TURN_END.includes(e.type) && e.data?.sessionID === sessionID)
        return { outcome: e.type, reason: e.data?.reason, error: e.data?.error, ms: Date.now() - t0 }
    }
    if (Date.now() - t0 > timeoutMs) return { outcome: "timeout", ms: Date.now() - t0 }
    if (server.proc.exitCode !== null || server.proc.signalCode !== null) {
      // Give the tap a moment to flush frames written before exit.
      await Bun.sleep(300)
      for (let i = startIdx; i < tap.events.length; i++) {
        const e = tap.events[i]
        if (TURN_END.includes(e.type) && e.data?.sessionID === sessionID)
          return { outcome: e.type, reason: e.data?.reason, error: e.data?.error, ms: Date.now() - t0 }
      }
      return { outcome: "server_exited_no_terminal", ms: Date.now() - t0 }
    }
    await Bun.sleep(50)
  }
}

export function redact(s: string, secrets: string[]) {
  let out = s
  for (const x of secrets) if (x) out = out.split(x).join("[REDACTED]")
  return out
}
