// r2 helpers (task 4840abc5, 2026-10-25): an SSE tap with a chosen username
// (v1 under Isomux uses OPENCODE_SERVER_USERNAME=isomux), and model counting.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EventTap, Profile, Server } from "./common.ts"

export async function tapAs(server: Server, user: string, jsonlPath: string, path: string): Promise<EventTap> {
  const ac = new AbortController()
  const events: any[] = []
  const waiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = []
  const res = await fetch(server.base + path, {
    headers: { authorization: `Basic ${btoa(`${user}:${server.password}`)}` },
    signal: ac.signal,
  })
  ;(async () => {
    try {
      const rd = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue
            let e: any
            try {
              e = JSON.parse(line.slice(5))
            } catch {
              e = { unparsed: line }
            }
            e.__receivedAt = Date.now()
            events.push(e)
            appendFileSync(jsonlPath, JSON.stringify(e) + "\n")
            for (const w of [...waiters])
              if (w.pred(e)) {
                waiters.splice(waiters.indexOf(w), 1)
                w.resolve(e)
              }
          }
        }
      }
    } catch {}
  })()
  return {
    events,
    close: () => ac.abort(),
    waitFor: (pred, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const hit = events.find(pred)
        if (hit) return resolve(hit)
        const w = { pred, resolve }
        waiters.push(w)
        setTimeout(() => {
          const idx = waiters.indexOf(w)
          if (idx >= 0) {
            waiters.splice(idx, 1)
            reject(new Error("waitFor timed out"))
          }
        }, timeoutMs)
      }),
  }
}

// Raw GET with a bounded read (SSE routes return what arrived in ms).
export async function rawGet(base: string, user: string, password: string, path: string, ms = 4000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  let status = 0
  let text = ""
  let note: string | undefined
  try {
    const r = await fetch(base + path, { headers: { authorization: `Basic ${btoa(`${user}:${password}`)}` }, signal: ac.signal })
    status = r.status
    const rd = r.body!.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { value, done } = await rd.read()
      if (done) break
      text += dec.decode(value, { stream: true })
      if (text.length > 50_000_000) break
    }
  } catch (e: any) {
    note = ac.signal.aborted ? `read stopped after ${ms} ms (stream)` : String(e?.message ?? e).slice(0, 120)
  } finally {
    clearTimeout(timer)
  }
  return { status, text, bytes: text.length, note }
}

export function countOf(hay: string, needle: string) {
  return hay.split(needle).length - 1
}

// Same as supervisor.ts markPluginSdkInstalled: v1 skips its plugin SDK npm install.
export function markPluginSdkOnly(p: Profile) {
  const d = join(p.config, "opencode")
  if (existsSync(join(d, "node_modules"))) return
  mkdirSync(d, { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "1.18.35" }
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies }))
  writeFileSync(join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }))
  mkdirSync(join(d, "node_modules"))
}

export function list(body: any): any[] {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.data?.items)) return body.data.items
  if (Array.isArray(body?.items)) return body.items
  return []
}
