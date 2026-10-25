// ev probe helpers (task 4840abc5, 2026-10-25). Built on common.ts; never edits it.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import type { Server, EventTap } from "./common.ts"
import { TURN_END } from "./common.ts"

export const EVIDENCE = "/tmp/t-4840abc5/evidence"

// Every prompt the probe sends, so the analysis can count terminals per prompt.
export interface PromptRecord {
  label: string
  sessionID: string
  text: string
  sentAt: number
  delivery?: string
  status?: number
  response?: unknown
}

export class Manifest {
  prompts: PromptRecord[] = []
  notes: Record<string, unknown> = {}
  constructor(public path: string) {}
  save() {
    writeFileSync(this.path, JSON.stringify({ prompts: this.prompts, notes: this.notes }, null, 2) + "\n")
  }
}

export async function sendPrompt(
  s: Server,
  m: Manifest,
  label: string,
  sessionID: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const rec: PromptRecord = { label, sessionID, text, sentAt: Date.now(), ...(extra.delivery ? { delivery: String(extra.delivery) } : {}) }
  const r = await s.api("POST", `/api/session/${sessionID}/prompt`, { text, ...extra })
  rec.status = r.status
  rec.response = r.body
  m.prompts.push(rec)
  if (r.status !== 200) throw new Error(`prompt ${label} ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`)
  return r.body
}

// Waits for the N-th terminal for a session (1-based), counting from the start of the tap.
export async function waitTerminal(tap: EventTap, sessionID: string, nth: number, timeoutMs = 30_000) {
  const t0 = Date.now()
  for (;;) {
    const ends = tap.events.filter((e) => TURN_END.includes(e.type) && e.data?.sessionID === sessionID)
    if (ends.length >= nth) return ends[nth - 1]
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting terminal #${nth} for ${sessionID}`)
    await Bun.sleep(25)
  }
}

export function countTerminals(tap: EventTap, sessionID: string) {
  return tap.events.filter((e) => TURN_END.includes(e.type) && e.data?.sessionID === sessionID).length
}

export async function waitEvent(tap: EventTap, pred: (e: any) => boolean, timeoutMs = 30_000) {
  const t0 = Date.now()
  for (;;) {
    const hit = tap.events.find(pred)
    if (hit) return hit
    if (Date.now() - t0 > timeoutMs) throw new Error("waitEvent timeout")
    await Bun.sleep(25)
  }
}

export async function messages(s: Server, sessionID: string) {
  const all: any[] = []
  let cursor: string | undefined
  let order = "?order=asc&limit=200"
  for (let i = 0; i < 20; i++) {
    const r = await s.api("GET", `/api/session/${sessionID}/message${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=200` : order}`)
    if (r.status !== 200) return { status: r.status, body: r.body, data: all }
    all.push(...(r.body.data ?? []))
    cursor = r.body.cursor?.next
    if (!cursor || (r.body.data ?? []).length === 0) break
  }
  return { status: 200, data: all }
}

// Reads the durable session log (no follow) until the stream ends or idleMs passes with no frame.
export async function readLog(s: Server, sessionID: string, after?: number, follow = false, idleMs = 1500, maxMs = 8000) {
  const ac = new AbortController()
  const q = new URLSearchParams()
  if (after !== undefined) q.set("after", String(after))
  if (follow) q.set("follow", "true")
  const res = await fetch(`${s.base}/api/experimental/session/${sessionID}/log?${q}`, {
    headers: { authorization: `Basic ${btoa(`opencode:${s.password}`)}` },
    signal: ac.signal,
  })
  const out: any[] = []
  const raw: string[] = []
  let ended = false
  const rd = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const t0 = Date.now()
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > idleMs || Date.now() - t0 > maxMs) ac.abort()
  }, 50)
  try {
    for (;;) {
      const { value, done } = await rd.read()
      if (done) {
        ended = true
        break
      }
      last = Date.now()
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        raw.push(frame)
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue
          try {
            out.push(JSON.parse(line.slice(5)))
          } catch {
            out.push({ unparsed: line })
          }
        }
      }
    }
  } catch {}
  clearInterval(timer)
  return { status: res.status, contentType: res.headers.get("content-type"), events: out, rawFrames: raw.slice(0, 3), endedByServer: ended }
}

// Session-filtered fixture file from a tap.
export function writeFixture(path: string, events: any[], sessionIDs: string[]) {
  const set = new Set(sessionIDs)
  const lines = events.filter((e) => set.has(e.data?.sessionID)).map((e) => JSON.stringify(e))
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""))
  return lines.length
}

export function redact(text: string, secrets: string[]) {
  let t = text
  for (const s of secrets) if (s) t = t.split(s).join("<redacted>")
  return t
}

export function copyRedacted(src: string, dst: string, secrets: string[]) {
  if (!existsSync(src)) return false
  writeFileSync(dst, redact(readFileSync(src, "utf8"), secrets))
  return true
}

export function countIn(path: string, needle: string) {
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8").split(needle).length - 1
}

export { appendFileSync }
