// Task 6dca5910, P8 on 2.2.5: a 2.1.4 profile (OPENCODE_DB=opencode-v2.db, as
// Isomux runs it) -> 2.2.5 -> back to 2.1.4. Sessions, message ids, history
// recall, Isomux's storage inspection and the table schemas at each step.
// Usage: GATE_ROOT=... bun mg-p8-225.ts. Never logs transcript text.
import { Database } from "bun:sqlite"
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const W = `${import.meta.dir}/../../..`
const { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, writeJson, GATE_ROOT } = await import(`${H}/common.ts`)
const { inspectOpenCodeDatabase } = await import(`${W}/server/backends/opencode/storage.ts`)
const BIN214 = process.env.GATE_V1_BIN!
const BIN225 = process.env.GATE_V2_BIN!
const root = `${GATE_ROOT}/run/mg-p8-${Date.now()}`
mkdirSync(root, { recursive: true })
const DB = "opencode-v2.db"
const env = { OPENCODE_DB: DB }
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const config = mockProviderConfig(mock)
const repos = [makeRepo(join(root, "repo-a")), makeRepo(join(root, "repo-b"))]
const out: any = { root, steps: {} }

function dbPath(p: any) { return join(p.data, "opencode", DB) }
function schema(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as any[]).map((r) => r.name)
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[]).map((r) => r.name)
    return { tables, session_v2: cols("session_v2"), session_message: cols("session_message") }
  } finally { db.close() }
}
async function messageIds(s: any, id: string) {
  const r = await s.api("GET", `/api/session/${id}/message?limit=200`)
  const rows = (r.body?.data ?? r.body ?? []) as any[]
  return { status: r.status, ids: Array.isArray(rows) ? rows.map((m: any) => m.id) : [] }
}
async function turn(s: any, tap: any, id: string, text: string) {
  await prompt(s, id, text)
  return (await tap.waitFor(turnEnded(id), 60_000).catch(() => ({ type: "timeout" }))).type
}
async function listSessions(s: any) {
  const r = await s.api("GET", "/api/session?limit=200")
  const rows = (r.body?.data ?? r.body ?? []) as any[]
  return { status: r.status, ids: Array.isArray(rows) ? rows.map((x: any) => x.id).sort() : rows }
}
function mockPrompts() {
  return readFileSync(`${root}/mock.log`, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((j) => j.prompt !== undefined)
}

// Step 1: 2.1.4 makes the profile.
const p = makeProfile(join(root, "profile"))
{
  const s = await startServer(p, { bin: BIN214, config, env })
  const tap = await tapEvents(s, `${root}/events-214.jsonl`)
  const sessions: any[] = []
  for (const [i, repo] of [repos[0], repos[0], repos[1]].entries()) {
    const ses = await createSession(s, repo)
    await s.api("POST", `/api/session/${ses.id}/model`, { model: { providerID: "gate", id: "gate-model" } })
    const ends = [await turn(s, tap, ses.id, `S4_CONTEXT_CANARY first turn ${i}`), await turn(s, tap, ses.id, `GATE_TOOL second turn ${i}`)]
    sessions.push({ id: ses.id, ends })
  }
  // A turn writes its idle row after the terminal event: list once all settled.
  await Bun.sleep(2000)
  for (const x of sessions) x.msgs = (await messageIds(s, x.id)).ids
  out.steps.make214 = { version: (await s.api("GET", "/api/info")).body?.version, sessions: sessions.map((x) => ({ ends: x.ends, msgCount: x.msgs.length })) }
  out.sessions = sessions
  await s.stop()
  out.steps.make214.schema = schema(dbPath(p))
}
const keep = join(root, "profile-keep")
cpSync(p.dir, keep, { recursive: true })

// Step 2: 2.2.5 on the 2.1.4 profile.
{
  const t0 = Date.now()
  const s = await startServer(p, { bin: BIN225, config, env })
  const startMs = Date.now() - t0
  const tap = await tapEvents(s, `${root}/events-225.jsonl`)
  const listed = await listSessions(s)
  const same = []
  for (const x of out.sessions) same.push(JSON.stringify((await messageIds(s, x.id)).ids) === JSON.stringify(x.msgs))
  const before = mockPrompts().length
  const end = await turn(s, tap, out.sessions[0].id, "GATE_RECALL after upgrade")
  const recall = mockPrompts().slice(before).some((j: any) => j.messageCount > 2)
  await Bun.sleep(2000)
  out.sessions[0].msgs225 = (await messageIds(s, out.sessions[0].id)).ids
  out.steps.up225 = {
    version: (await s.api("GET", "/api/info")).body?.version, startMs,
    listedAll: out.sessions.every((x: any) => listed.ids.includes(x.id)), listedCount: listed.ids.length,
    messagesUnchanged: same, continueEnd: end, historyReachedModel: recall,
    isomuxInspect: out.sessions.map((x: any) => inspectOpenCodeDatabase(dbPath(p), x.id, "v2")),
  }
  await s.stop()
  out.steps.up225.schema = schema(dbPath(p))
}

// Step 3: back to 2.1.4 on the profile 2.2.5 migrated.
{
  let s: any
  try { s = await startServer(p, { bin: BIN214, config, env }) } catch (e) { out.steps.back214 = { started: false, error: String(e).slice(0, 200) } }
  if (s) {
    const tap = await tapEvents(s, `${root}/events-back214.jsonl`)
    const listed = await listSessions(s)
    const m0 = (await messageIds(s, out.sessions[0].id)).ids
    const before = mockPrompts().length
    const end = await turn(s, tap, out.sessions[1].id, "GATE_RECALL after rollback")
    const recall = mockPrompts().slice(before).some((j: any) => j.messageCount > 2)
    out.steps.back214 = {
      started: true, version: (await s.api("GET", "/api/info")).body?.version,
      listedAll: out.sessions.every((x: any) => listed.ids.includes(x.id)),
      upgradedTurnKept: JSON.stringify(m0) === JSON.stringify(out.sessions[0].msgs225),
      continueEnd: end, historyReachedModel: recall,
      isomuxInspect: out.sessions.map((x: any) => inspectOpenCodeDatabase(dbPath(p), x.id, "v2")),
      logErrors: readFileSync(s.logPath, "utf8").split("\n").filter((l) => /level=(ERROR|WARN)/.test(l)).map((l) => l.replace(/^.*message="([^"]*)".*$/, "$1")).slice(0, 10),
    }
    await Bun.sleep(2000)
    out.sessions[1].msgsBack = (await messageIds(s, out.sessions[1].id)).ids
    await s.stop()
  }
}

// Step 3b: 2.2.5 again on the profile after the rollback.
{
  const s = await startServer(p, { bin: BIN225, config, env })
  const tap = await tapEvents(s, `${root}/events-again225.jsonl`)
  const m1 = (await messageIds(s, out.sessions[1].id)).ids
  const end = await turn(s, tap, out.sessions[2].id, "GATE_RECALL after second upgrade")
  out.steps.again225 = {
    version: (await s.api("GET", "/api/info")).body?.version,
    rollbackTurnKept: JSON.stringify(m1) === JSON.stringify(out.sessions[1].msgsBack),
    continueEnd: end,
    isomuxInspect: out.sessions.map((x: any) => inspectOpenCodeDatabase(dbPath(p), x.id, "v2")),
  }
  await s.stop()
}

// Step 4: a fresh 2.2.5 profile's schema.
{
  const f = makeProfile(join(root, "fresh225"))
  const s = await startServer(f, { bin: BIN225, config, env })
  await s.stop()
  out.steps.fresh225 = { schema: schema(dbPath(f)) }
}
mock.stop()
for (const x of out.sessions) { x.msgCount = x.msgs.length; delete x.msgs; delete x.msgs225; delete x.msgsBack }
out.sessions = out.sessions.map((x: any, i: number) => ({ i, msgCount: x.msgCount }))
writeJson(`${root}/mg-p8-225.json`, out)
console.log(JSON.stringify(out, null, 1))
