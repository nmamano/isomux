// pm P4 addendum: no model configured. Does OPENCODE_DISABLE_FREE_MODELS=1 stop the fallback to OpenCode's free cloud model?
import { mkdirSync, writeFileSync } from "node:fs"
import { makeProfile, startServer, tapEvents, createSession, GATE_ROOT } from "./common.ts"
import { runCall, redact } from "./pm-lib.ts"
const root = `${GATE_ROOT}/run/pm-p4free-${Date.now()}`
const p = makeProfile(root)
mkdirSync(`${root}/cwd`, { recursive: true })
mkdirSync(`${root}/repo`, { recursive: true })
const s = await startServer(p, { cwd: `${root}/cwd`, env: { OPENCODE_DISABLE_FREE_MODELS: "1" } })
const tap = await tapEvents(s, `${root}/events.jsonl`)
const ses = await createSession(s, `${root}/repo`)
const got = await runCall(s, tap, ses.id, "hello FREE_MARKER", { timeoutMs: 30000 })
const mine = tap.events.filter((e) => e.data?.sessionID === ses.id)
const res = {
  date: "2026-10-25", opencode: "2.1.4", method: "no OPENCODE_CONFIG / CONTENT, no provider; OPENCODE_DISABLE_FREE_MODELS=1; one prompt",
  end: got.end,
  models: [...new Set(mine.filter((e) => e.data?.model).map((e) => JSON.stringify(e.data.model)))],
  textEnded: mine.filter((e) => e.type === "session.text.ended").length,
  failure: mine.filter((e) => /failed/.test(e.type)).map((e) => ({ type: e.type, error: (e.data?.error?.message ?? e.data?.error?.type ?? "").slice(0, 200) })),
}
writeFileSync(`${GATE_ROOT}/evidence/pm-p4-free-models.json`, JSON.stringify(redact(res, [s.password]), null, 2).split(root).join("<run>") + "\n")
console.log(JSON.stringify(res))
tap.close(); await s.stop()
