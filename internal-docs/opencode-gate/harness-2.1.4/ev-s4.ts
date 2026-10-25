// S4 fixtures (+ data for S5/S6/S9). Task 4840abc5, 2026-10-25. OpenCode 2.1.4, mock provider.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, startServer, tapEvents, writeJson, GATE_ROOT, TURN_END, type Server, type EventTap } from "./common.ts"
import { Manifest, sendPrompt, waitTerminal, waitEvent, countTerminals, messages, readLog, writeFixture, copyRedacted, countIn, EVIDENCE } from "./ev-lib.ts"

const ts = Date.now()
const root = `${GATE_ROOT}/run/ev-s4-${ts}`
const p = makeProfile(root)
const repo = makeRepo(`${root}/repo`)
const man = new Manifest(`${EVIDENCE}/ev-s4-manifest.json`)
const out: any = { date: "2026-10-25", run: root, opencode: "2.1.4", fixtures: {} }
const procs: string[] = []
const servers: Server[] = []
const fixtureSessions: Record<string, string[]> = {}

const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const mockFix = await startMock(`${root}/mock-fixed.log`, { MOCK_SHELL_TOOL: "shell", MOCK_FIXED_CALLID: "1" })
procs.push(`mock pid=${mock.proc.pid}`, `mock-fixed pid=${mockFix.proc.pid}`)
const provider = (name: string, env: string, url: string) => ({
  name,
  env: [env],
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: url },
  models: { "gate-model": { name: "Gate model" } },
})
const cfg = {
  providers: {
    gate: provider("Gate", "GATE_API_KEY", mock.url),
    gatefix: provider("Gate fixed ids", "GATE_API_KEY", mockFix.url),
    gatebad: provider("Gate bad key", "GATE_BAD_KEY", mock.url),
  },
  model: "gate/gate-model",
  update: "disable",
}
const ask = [{ action: "shell", resource: "*", effect: "ask" }]
let s: Server
let tap: EventTap
const call = (tool: string, args: unknown) => `GATE_CALL:${JSON.stringify({ tool, args })}`
async function newSession(fx: string, extra: Record<string, unknown> = {}) {
  const r = await s.api("POST", "/api/session", { location: { directory: repo }, ...extra })
  if (r.status !== 200) throw new Error(`create ${fx} ${r.status} ${JSON.stringify(r.body)}`)
  ;(fixtureSessions[fx] ??= []).push(r.body.data.id)
  return r.body.data.id as string
}
const ofSession = (sid: string) => tap.events.filter((e) => e.data?.sessionID === sid)
const types = (sid: string) => ofSession(sid).map((e) => e.type)
const textsEnded = (sid: string) => ofSession(sid).filter((e) => e.type === "session.text.ended").map((e) => e.data.text)
const mockPrompts = (needle: string, file = `${root}/mock.log`) =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.includes(needle)).map((l) => { try { return JSON.parse(l) } catch { return l } })

try {
  s = await startServer(p, { config: cfg, logPath: `${root}/server.log`, env: { GATE_BAD_KEY: "INVALID_GATE_KEY" } })
  servers.push(s)
  procs.push(`server pid=${s.pid}`)
  tap = await tapEvents(s, `${root}/events.jsonl`)

  // 1. text + reasoning
  {
    const sid = await newSession("text_reasoning")
    await sendPrompt(s, man, "text_reasoning", sid, "EV text streaming check")
    const end = await waitTerminal(tap, sid, 1)
    out.fixtures.text_reasoning = { sid, terminal: end.type, texts: textsEnded(sid), reasoning: ofSession(sid).filter((e) => e.type === "session.reasoning.ended").map((e) => e.data.text), deltaCount: ofSession(sid).filter((e) => e.type === "session.text.delta").length }
  }
  // 2. shell ask + allow (once)
  {
    const sid = await newSession("shell_allow", { permissions: ask })
    await sendPrompt(s, man, "shell_allow", sid, call("shell", { command: "printf allowed > ev-allow.txt" }))
    const asked = await waitEvent(tap, (e) => e.type === "permission.asked" && e.data?.sessionID === sid)
    const reply = await s.api("POST", `/api/session/${sid}/permission/${asked.data.id}/reply`, { decision: "once" })
    const end = await waitTerminal(tap, sid, 1)
    out.fixtures.shell_allow = { sid, asked: asked.data, reply: reply.status, terminal: end.type, file: existsSync(join(repo, "ev-allow.txt")) ? readFileSync(join(repo, "ev-allow.txt"), "utf8") : null, texts: textsEnded(sid), replied: ofSession(sid).filter((e) => e.type === "permission.replied").map((e) => e.data) }
  }
  // 3. shell ask + deny (reject)
  {
    const sid = await newSession("shell_deny", { permissions: ask })
    await sendPrompt(s, man, "shell_deny", sid, call("shell", { command: "printf denied > ev-deny.txt" }))
    const asked = await waitEvent(tap, (e) => e.type === "permission.asked" && e.data?.sessionID === sid)
    const reply = await s.api("POST", `/api/session/${sid}/permission/${asked.data.id}/reply`, { decision: "reject" })
    const end = await waitTerminal(tap, sid, 1)
    out.fixtures.shell_deny = { sid, reply: reply.status, terminal: end.type, fileExists: existsSync(join(repo, "ev-deny.txt")), toolFailed: ofSession(sid).filter((e) => e.type === "session.tool.failed").map((e) => e.data), texts: textsEnded(sid), replied: ofSession(sid).filter((e) => e.type === "permission.replied").map((e) => e.data) }
  }
  // 4. write then edit
  {
    const sid = await newSession("edit_write")
    await sendPrompt(s, man, "write", sid, call("write", { path: "ev-edit.txt", content: "alpha beta\n" }))
    const e1 = await waitTerminal(tap, sid, 1)
    const afterWrite = existsSync(join(repo, "ev-edit.txt")) ? readFileSync(join(repo, "ev-edit.txt"), "utf8") : null
    await sendPrompt(s, man, "edit", sid, call("edit", { path: "ev-edit.txt", oldString: "alpha", newString: "gamma" }))
    const e2 = await waitTerminal(tap, sid, 2)
    out.fixtures.edit_write = {
      sid,
      terminals: [e1.type, e2.type],
      afterWrite,
      afterEdit: existsSync(join(repo, "ev-edit.txt")) ? readFileSync(join(repo, "ev-edit.txt"), "utf8") : null,
      toolTerminals: ofSession(sid).filter((e) => e.type === "session.tool.success" || e.type === "session.tool.failed").map((e) => ({ type: e.type, id: e.data.id, metadataKeys: Object.keys(e.data.metadata ?? {}), error: e.data.error })),
      texts: textsEnded(sid),
    }
  }
  // 5. failed tool (exit 7) + recovery text
  {
    const sid = await newSession("tool_fail")
    await sendPrompt(s, man, "tool_fail", sid, "GATE_FAIL run the failing command")
    const end = await waitTerminal(tap, sid, 1)
    out.fixtures.tool_fail = { sid, terminal: end.type, toolTerminals: ofSession(sid).filter((e) => e.type === "session.tool.success" || e.type === "session.tool.failed").map((e) => ({ type: e.type, id: e.data.id, content: e.data.content, error: e.data.error, metadata: e.data.metadata })), texts: textsEnded(sid) }
  }
  // 6. abort variants
  const abortRun = async (fx: string, opts: { query?: string; follow?: "steer" | "queue"; tool?: boolean }) => {
    const sid = await newSession(fx)
    const tag = `EV_FOLLOWUP_${fx}`
    await sendPrompt(s, man, fx, sid, opts.tool ? "GATE_ABORT_TOOL long tool" : "GATE_ABORT slow turn")
    await waitEvent(tap, (e) => e.type === "session.execution.started" && e.data?.sessionID === sid)
    if (opts.tool) await waitEvent(tap, (e) => e.type === "session.tool.called" && e.data?.sessionID === sid, 15000)
    else await Bun.sleep(600)
    let follow: any
    if (opts.follow) follow = await sendPrompt(s, man, `${fx}-followup`, sid, tag, { delivery: opts.follow })
    await Bun.sleep(150)
    const inboxBefore = await s.api("GET", `/api/session/${sid}/inbox`)
    const t0 = Date.now()
    const intr = await s.api("POST", `/api/session/${sid}/interrupt${opts.query ?? ""}`)
    const end = await waitTerminal(tap, sid, 1, 15000)
    const ackToTerminalMs = end.__receivedAt - t0
    await Bun.sleep(4000)
    const inboxAfter = await s.api("GET", `/api/session/${sid}/inbox`)
    const res: any = {
      sid,
      interruptQuery: opts.query ?? "(none)",
      followDelivery: opts.follow ?? null,
      followResponse: follow,
      interruptResponse: intr,
      ackToTerminalMs,
      terminalsAfter4s: ofSession(sid).filter((e) => TURN_END.includes(e.type)).map((e) => ({ type: e.type, reason: e.data.reason, error: e.data.error })),
      executionStarted: ofSession(sid).filter((e) => e.type === "session.execution.started").length,
      followupReachedModel: opts.follow ? mockPrompts(tag).length : null,
      inboxBefore: inboxBefore.body,
      inboxAfter: inboxAfter.body,
      toolTerminals: ofSession(sid).filter((e) => e.type === "session.tool.success" || e.type === "session.tool.failed").map((e) => ({ type: e.type, id: e.data.id, error: e.data.error })),
      textsEnded: textsEnded(sid),
    }
    // Is the session usable afterwards?
    const before = countTerminals(tap, sid)
    await sendPrompt(s, man, `${fx}-after`, sid, `EV after abort ${fx}`)
    const after = await waitTerminal(tap, sid, before + 1, 20000).catch((e) => ({ type: String(e) }))
    await Bun.sleep(300)
    res.nextTurn = { terminal: after.type, texts: textsEnded(sid).slice(-2), followupReachedModelAtEnd: opts.follow ? mockPrompts(tag).length : null, terminalsTotal: countTerminals(tap, sid) }
    const msgs = await messages(s, sid)
    res.messageTypes = msgs.data.map((m: any) => m.type)
    out.fixtures[fx] = res
  }
  await abortRun("abort_plain", {})
  await abortRun("abort_resume_false", { query: "?resume=false" })
  await abortRun("abort_steer_default", { follow: "steer" })
  await abortRun("abort_steer_resume_false", { follow: "steer", query: "?resume=false" })
  await abortRun("abort_steer_resume_true", { follow: "steer", query: "?resume=true" })
  await abortRun("abort_queue_default", { follow: "queue" })
  await abortRun("abort_tool", { tool: true })

  // 7. fork
  {
    const parent = await newSession("fork")
    await sendPrompt(s, man, "fork-p1", parent, "EV fork turn one")
    await waitTerminal(tap, parent, 1)
    await sendPrompt(s, man, "fork-p2", parent, "EV fork turn two S4_CONTEXT_CANARY")
    await waitTerminal(tap, parent, 2)
    await sendPrompt(s, man, "fork-p3", parent, "EV fork turn three")
    await waitTerminal(tap, parent, 3)
    const pm = await messages(s, parent)
    const userTwo = pm.data.find((m: any) => m.type === "user" && JSON.stringify(m).includes("EV fork turn two"))
    const fk = await s.api("POST", `/api/session/${parent}/fork`, { before: userTwo.id })
    const child = fk.body?.data?.id
    if (child) fixtureSessions.fork.push(child)
    const cm = await messages(s, child)
    const fk2 = await s.api("POST", `/api/session/${parent}/fork`, {})
    const child2 = fk2.body?.data?.id
    if (child2) fixtureSessions.fork.push(child2)
    const cm2 = await messages(s, child2)
    // child's first new turn: GATE_RECALL. Turn two (with the canary) must be absent from the before-fork child.
    await sendPrompt(s, man, "fork-child-recall", child, "GATE_RECALL child")
    await waitTerminal(tap, child, 1)
    await sendPrompt(s, man, "fork-child2-recall", child2, "GATE_RECALL child2")
    await waitTerminal(tap, child2, 1)
    // child writes a file too
    await sendPrompt(s, man, "fork-child-write", child, call("write", { path: "ev-fork-child.txt", content: "child\n" }))
    await waitTerminal(tap, child, 2)
    const pmAfter = await messages(s, parent)
    const cmAfter = await messages(s, child)
    const summary = (ms: any[]) => ms.map((m: any) => ({ id: m.id, type: m.type, text: JSON.stringify(m).match(/EV fork turn \w+|GATE_RECALL child2?|RECALLED:\w+|ev-fork-child/g)?.slice(0, 2) }))
    out.fixtures.fork = {
      parent,
      before: userTwo.id,
      forkResponse: { status: fk.status, keys: Object.keys(fk.body?.data ?? {}), parentID: fk.body?.data?.parentID, body: fk.body },
      forkNoBeforeResponse: { status: fk2.status, parentID: fk2.body?.data?.parentID },
      parentMessages: summary(pm.data),
      childMessagesAtFork: summary(cm.data),
      childNoBeforeMessagesAtFork: summary(cm2.data),
      childIdsReuseParentIds: cm.data.filter((m: any) => pm.data.some((x: any) => x.id === m.id)).length,
      childRecall: textsEnded(child),
      child2Recall: textsEnded(child2),
      childAfter: summary(cmAfter.data),
      parentUnchanged: JSON.stringify(pmAfter.data) === JSON.stringify(pm.data),
      parentCountBeforeAfter: [pm.data.length, pmAfter.data.length],
      childWriteFile: existsSync(join(repo, "ev-fork-child.txt")),
      forkedEvents: tap.events.filter((e) => e.type === "session.forked").map((e) => e.data),
      mockRecallRequests: mockPrompts("GATE_RECALL child"),
    }
  }
  // 8. compaction
  {
    const sid = await newSession("compaction")
    await sendPrompt(s, man, "compact-t1", sid, "EV compaction turn one S4_CONTEXT_CANARY")
    await waitTerminal(tap, sid, 1)
    await sendPrompt(s, man, "compact-t2", sid, "EV compaction turn two")
    await waitTerminal(tap, sid, 2)
    const c = await s.api("POST", `/api/session/${sid}/compact`, {})
    man.prompts.push({ label: "compact", sessionID: sid, text: "(POST compact)", sentAt: Date.now(), status: c.status, response: c.body })
    const cend = await waitTerminal(tap, sid, 3, 30000).catch((e) => ({ type: String(e) }))
    await Bun.sleep(300)
    await sendPrompt(s, man, "compact-t3", sid, "GATE_RECALL after compaction")
    const t3 = await waitTerminal(tap, sid, countTerminals(tap, sid) + 1, 30000).catch((e) => ({ type: String(e) }))
    const ms = await messages(s, sid)
    out.fixtures.compaction = {
      sid,
      compactResponse: c,
      compactTerminal: cend.type,
      compactionEvents: ofSession(sid).filter((e) => e.type.startsWith("session.compaction")).map((e) => ({ type: e.type, keys: Object.keys(e.data) })),
      laterTurnTerminal: t3.type,
      laterTexts: textsEnded(sid).slice(-1),
      messageTypes: ms.data.map((m: any) => m.type),
      summaryRequests: mockPrompts("anchored summary").length,
    }
  }
  // 9. auth error (bad key provider)
  {
    const sid = await newSession("auth_error", { model: { id: "gate-model", providerID: "gatebad" } })
    await sendPrompt(s, man, "auth_error", sid, "EV auth error turn")
    const end = await waitTerminal(tap, sid, 1, 90000).catch((e) => ({ type: String(e) }))
    await Bun.sleep(500)
    const ms = await messages(s, sid)
    writeJson(`${root}/auth-messages.json`, ms)
    out.fixtures.auth_error = {
      sid,
      terminal: end.type,
      terminalData: (end as any).data,
      stepFailed: ofSession(sid).filter((e) => e.type === "session.step.failed").map((e) => e.data),
      retries: ofSession(sid).filter((e) => e.type === "session.retry.scheduled").map((e) => e.data),
      statuses: ofSession(sid).filter((e) => e.type === "session.status").map((e) => e.data.status),
      types: [...new Set(types(sid))],
      messageTypes: ms.data.map((m: any) => m.type),
      sessionOutcome: (await s.api("GET", `/api/session/${sid}`)).body?.data?.outcome,
    }
  }
  // 10. fixed provider call ids (both sessions get call_gate_001), plus a second turn in one session
  {
    const x1 = await newSession("fixed_ids", { model: { id: "gate-model", providerID: "gatefix" } })
    const x2 = await newSession("fixed_ids", { model: { id: "gate-model", providerID: "gatefix" } })
    await Promise.all([sendPrompt(s, man, "fixed-x1-t1", x1, "GATE_TOOL one"), sendPrompt(s, man, "fixed-x2-t1", x2, "GATE_TOOL one")])
    await Promise.all([waitTerminal(tap, x1, 1), waitTerminal(tap, x2, 1)])
    await sendPrompt(s, man, "fixed-x1-t2", x1, "GATE_TOOL two")
    const t2 = await waitTerminal(tap, x1, 2).catch((e) => ({ type: String(e) }))
    const m1 = await messages(s, x1)
    out.fixtures.fixed_ids = {
      x1, x2,
      x1Terminals: ofSession(x1).filter((e) => TURN_END.includes(e.type)).map((e) => e.type),
      x2Terminals: ofSession(x2).filter((e) => TURN_END.includes(e.type)).map((e) => e.type),
      x1t2: t2.type,
      toolIds: tap.events.filter((e) => e.type === "session.tool.called" && [x1, x2].includes(e.data?.sessionID)).map((e) => ({ sid: e.data.sessionID, id: e.data.id, assistantMessageID: e.data.assistantMessageID })),
      x1ToolPartsInMessages: JSON.stringify(m1.data).split('"call_gate_001"').length - 1,
      x1Messages: m1.data.map((m: any) => ({ id: m.id, type: m.type, contentTypes: (m.content ?? []).map((c: any) => `${c.type}:${c.id ?? ""}:${c.state?.status ?? c.status ?? ""}`) })),
    }
  }
  // log replay endpoint on a fixture session
  {
    const sid = fixtureSessions.text_reasoning[0]
    const seqs = ofSession(sid).filter((e) => e.durable).map((e) => e.durable.seq)
    const full = await readLog(s, sid)
    const mid = await readLog(s, sid, 2)
    out.logReplay = { sid, tapDurableSeqs: seqs, replayAll: full.events.map((e: any) => e.type + (e.seq !== undefined ? `@${e.seq}` : "")), replayAfter2: mid.events.map((e: any) => e.type + (e.seq !== undefined ? `@${e.seq}` : "")) }
  }
  const sample = await messages(s, fixtureSessions.shell_allow[0])
  writeJson(`${EVIDENCE}/ev-s4-message-sample-shell-allow.json`, sample)
  await Bun.sleep(500)
  tap.close()
  await s.stop("SIGTERM")
  out.serverExit = { code: s.proc.exitCode, sig: s.proc.signalCode }
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  for (const sv of servers) await sv.stop("SIGKILL").catch(() => {})
  mock.stop()
  mockFix.stop()
  out.processes = procs
  out.fixtureSessions = fixtureSessions
  man.notes.fixtureSessions = fixtureSessions
  man.save()
  // fixtures: one JSONL per fixture, filtered by its sessions
  const all = existsSync(`${root}/events.jsonl`) ? readFileSync(`${root}/events.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
  out.fixtureFiles = {}
  for (const [fx, sids] of Object.entries(fixtureSessions)) out.fixtureFiles[fx] = writeFixture(`${EVIDENCE}/ev-fx-${fx.replaceAll("_", "-")}.jsonl`, all, sids)
  const pw = servers.map((x) => x.password)
  copyRedacted(`${root}/events.jsonl`, `${EVIDENCE}/ev-s4-all-events.jsonl`, pw)
  // S9 header-leak check
  const SENT = "GATE_HEADER_SECRET_SENTINEL"
  const files = { events: `${root}/events.jsonl`, authMessages: `${root}/auth-messages.json`, serverLog: `${root}/server.log`, mockLog: `${root}/mock.log` }
  out.s9 = {
    sentinel: { name: SENT, counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, SENT)])) },
    badKey: { name: "INVALID_GATE_KEY", counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, "INVALID_GATE_KEY")])) },
    gateKey: { name: "GATE_KEY_SENTINEL_7f3a", counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, "GATE_KEY_SENTINEL_7f3a")])) },
    controlBodyMessage: { needle: "invalid gate credential", counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, "invalid gate credential")])) },
    controlSessionID: { counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, fixtureSessions.auth_error?.[0] ?? "none")])) },
    password: { counts: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, countIn(f, pw[0] ?? "none")])) },
  }
  copyRedacted(`${root}/server.log`, `${root}/server.redacted.log`, pw)
  writeJson(`${EVIDENCE}/ev-s4.json`, out)
  console.log(JSON.stringify(out, null, 1).slice(0, 60000))
  process.exit(0)
}
