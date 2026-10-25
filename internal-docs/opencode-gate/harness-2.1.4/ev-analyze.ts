// S5 (tool pairing) and S6 (turn completion) analysis over the ev evidence files.
// Task 4840abc5, 2026-10-25. Usage: bun run ev-analyze.ts  -> evidence/ev-analysis.json
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { EVIDENCE } from "./ev-lib.ts"
import { writeJson } from "./common.ts"

const TERM = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const TOOL_TERM = ["session.tool.success", "session.tool.failed"]
const load = (f: string) => readFileSync(`${EVIDENCE}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))

// Streams: each is one server's /api/event capture (or a session-filtered slice of one).
const fixtureFiles = readdirSync(EVIDENCE).filter((f) => f.startsWith("ev-fx-") && f.endsWith(".jsonl")).sort()
const streams: Record<string, any[]> = {}
for (const f of fixtureFiles) streams[f] = load(f)
for (const f of ["ev-s2-events.jsonl", "ev-s3-events.jsonl", ...readdirSync(EVIDENCE).filter((f) => /^ev-s4-restart.*-boot\d-events\.jsonl$/.test(f)).sort()]) if (existsSync(`${EVIDENCE}/${f}`)) streams[f] = load(f)

const manifests = ["ev-s4-manifest.json", "ev-s2s3-manifest.json", "ev-compact-manifest.json", ...readdirSync(EVIDENCE).filter((f) => /^ev-s4-restart.*manifest\.json$/.test(f))].filter((f) => existsSync(`${EVIDENCE}/${f}`)).map((f) => JSON.parse(readFileSync(`${EVIDENCE}/${f}`, "utf8")))
const promptsBySession: Record<string, any[]> = {}
const manifestNames = ["ev-s4-manifest.json", "ev-s2s3-manifest.json", "ev-compact-manifest.json", ...readdirSync(EVIDENCE).filter((f) => /^ev-s4-restart.*manifest\.json$/.test(f))].filter((f) => existsSync(`${EVIDENCE}/${f}`))
manifests.forEach((m, i) => { for (const p of m.prompts) (promptsBySession[p.sessionID] ??= []).push({ ...p, manifest: manifestNames[i] }) })
// Which prompts a stream could have seen: fixture files come from the S4 server only; S2/S3 by label prefix.
const promptInStream = (file: string, p: any) =>
  file === "ev-fx-compaction-ok.jsonl" ? p.manifest === "ev-compact-manifest.json"
  : file.startsWith("ev-fx-") ? p.manifest === "ev-s4-manifest.json"
  : file === "ev-s2-events.jsonl" ? p.manifest === "ev-s2s3-manifest.json" && p.label.startsWith("s2-")
  : file === "ev-s3-events.jsonl" ? p.manifest === "ev-s2s3-manifest.json" && p.label.startsWith("s3-")
  : false

// ---------- S5 ----------
interface Call { file: string; sessionID: string; id: string; seq: string[]; assistantMessageIDs: Set<string>; names: Set<string> }
const calls: Call[] = []
const permissionSources: Array<{ file: string; sessionID: string; sourceId: string; matched: boolean }> = []
for (const [file, evs] of Object.entries(streams)) {
  const byKey = new Map<string, Call>()
  for (const e of evs) {
    if (!e.type?.startsWith("session.tool.")) continue
    const key = `${e.data.sessionID}|${e.data.assistantMessageID}|${e.data.id}`
    let c = byKey.get(key)
    if (!c) {
      c = { file, sessionID: e.data.sessionID, id: e.data.id, seq: [], assistantMessageIDs: new Set(), names: new Set() }
      byKey.set(key, c)
      calls.push(c)
    }
    c.seq.push(e.type)
    c.assistantMessageIDs.add(e.data.assistantMessageID)
    if (e.data.name) c.names.add(e.data.name)
  }
  for (const e of evs.filter((x) => x.type === "permission.asked")) {
    const sid = e.data.source?.id
    permissionSources.push({ file, sessionID: e.data.sessionID, sourceId: sid, matched: [...byKey.values()].some((c) => c.sessionID === e.data.sessionID && c.id === sid) })
  }
}
const s5calls = calls.map((c) => {
  const terminals = c.seq.filter((t) => TOOL_TERM.includes(t))
  const iStart = c.seq.indexOf("session.tool.input.started")
  const iCalled = c.seq.indexOf("session.tool.called")
  const iTerm = c.seq.findIndex((t) => TOOL_TERM.includes(t))
  return {
    file: c.file,
    sessionID: c.sessionID,
    id: c.id,
    names: [...c.names],
    sequence: c.seq.filter((t) => t !== "session.tool.input.delta" && t !== "session.tool.progress"),
    hasInputStarted: iStart >= 0,
    hasCalled: iCalled >= 0,
    terminalCount: terminals.length,
    terminal: terminals[0] ?? null,
    ordered: iStart === 0 && iCalled > iStart && iTerm > iCalled && c.seq.slice(iTerm + 1).length === 0,
    oneAssistantMessage: c.assistantMessageIDs.size === 1,
  }
})
// Uniqueness of the bare id across sessions (per server stream; fixtures from the same server share one mock counter)
const s4Streams = fixtureFiles
const idSessions = new Map<string, Set<string>>()
const idTriples = new Map<string, number>()
for (const c of calls.filter((c) => s4Streams.includes(c.file))) {
  ;(idSessions.get(c.id) ?? idSessions.set(c.id, new Set()).get(c.id)!).add(c.sessionID)
}
for (const c of calls) {
  const k = `${c.file}|${c.sessionID}|${c.id}`
  idTriples.set(k, (idTriples.get(k) ?? 0) + 1)
}
const s5 = {
  totalCalls: s5calls.length,
  allHaveInputStarted: s5calls.every((c) => c.hasInputStarted),
  allHaveCalled: s5calls.every((c) => c.hasCalled),
  allExactlyOneTerminal: s5calls.every((c) => c.terminalCount === 1),
  allOrderedStartedCalledTerminal: s5calls.every((c) => c.ordered),
  allOneAssistantMessage: s5calls.every((c) => c.oneAssistantMessage),
  violations: s5calls.filter((c) => !(c.hasInputStarted && c.hasCalled && c.terminalCount === 1 && c.ordered && c.oneAssistantMessage)),
  terminalsByType: s5calls.reduce((a: any, c) => ((a[c.terminal ?? "none"] = (a[c.terminal ?? "none"] ?? 0) + 1), a), {}),
  permissionSourceIdMatchesToolId: permissionSources,
  idsSharedAcrossSessionsInS4Server: [...idSessions.entries()].filter(([, s]) => s.size > 1).map(([id, s]) => ({ id, sessions: s.size })),
  sameIdTwiceInOneSession: [...idTriples.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k.split("|").slice(1).join("|"), assistantMessages: n })),
  calls: s5calls,
}

// ---------- S6 ----------
const s6sessions: any[] = []
const periodsAll: any[] = []
for (const [file, evs] of Object.entries(streams)) {
  const sids = [...new Set(evs.map((e) => e.data?.sessionID).filter((x) => typeof x === "string" && x.startsWith("ses")))]
  for (const sid of sids) {
    const se = evs.map((e, i) => ({ e, i })).filter(({ e }) => e.data?.sessionID === sid)
    const periods: any[] = []
    let cur: any = null
    const orphanTerminals: any[] = []
    for (const { e, i } of se) {
      if (e.type === "session.execution.started") {
        if (cur) periods.push(cur)
        cur = { file, sid, startIdx: i, startSeq: e.durable?.seq, terminals: [], lastTextEnded: -1, lastToolTerminal: -1, lastTextEndedSeq: -1, lastToolTerminalSeq: -1, eventsAfterTerminal: [] }
        continue
      }
      if (!cur) {
        if (TERM.includes(e.type)) orphanTerminals.push(e.type)
        continue
      }
      if (TERM.includes(e.type)) cur.terminals.push({ type: e.type, idx: i, seq: e.durable?.seq, reason: e.data.reason, errorType: e.data.error?.type })
      else if (cur.terminals.length) cur.eventsAfterTerminal.push(e.type)
      if (e.type === "session.text.ended") (cur.lastTextEnded = i), (cur.lastTextEndedSeq = e.durable?.seq ?? -1)
      if (TOOL_TERM.includes(e.type)) (cur.lastToolTerminal = i), (cur.lastToolTerminalSeq = e.durable?.seq ?? -1)
    }
    if (cur) periods.push(cur)
    for (const p of periods) {
      const t = p.terminals[0]
      p.exactlyOneTerminal = p.terminals.length === 1
      p.terminalAfterLastTextAndTool = !!t && t.idx > p.lastTextEnded && t.idx > p.lastToolTerminal
      p.terminalAfterBySeq = !!t && t.seq > p.lastTextEndedSeq && t.seq > p.lastToolTerminalSeq
      periodsAll.push(p)
    }
    const prompts = (promptsBySession[sid] ?? []).filter((p) => promptInStream(file, p) && p.text !== "(POST compact)")
    s6sessions.push({
      file,
      sid,
      prompts: prompts.map((p) => p.label + (p.delivery ? `[${p.delivery}]` : "")),
      compactCalls: (promptsBySession[sid] ?? []).filter((p) => promptInStream(file, p) && p.text === "(POST compact)").length,
      busyPeriods: periods.length,
      terminals: periods.flatMap((p) => p.terminals.map((t: any) => t.type.replace("session.execution.", "") + (t.reason ? `:${t.reason}` : "") + (t.errorType ? `:${t.errorType}` : ""))),
      orphanTerminals,
    })
  }
}
// Prompt-vs-terminal accounting: only meaningful where the stream saw the whole life of the session.
const accounting = s6sessions
  .filter((s) => s.prompts.length > 0)
  .map((s) => ({ file: s.file, sid: s.sid, prompts: s.prompts.length + s.compactCalls, terminals: s.terminals.length, equal: s.prompts.length + s.compactCalls === s.terminals.length, detail: s.prompts, terminalsList: s.terminals }))
const statusEvents: Record<string, number> = {}
for (const [file, evs] of Object.entries(streams)) statusEvents[file] = evs.filter((e) => e.type === "session.status" || e.type === "session.idle").length
const allTypes = new Set<string>()
for (const evs of Object.values(streams)) for (const e of evs) allTypes.add(e.type)
const s6 = {
  busyPeriods: periodsAll.length,
  everyBusyPeriodExactlyOneTerminal: periodsAll.every((p) => p.exactlyOneTerminal),
  periodsWithoutTerminal: periodsAll.filter((p) => p.terminals.length === 0).map((p) => ({ file: p.file, sid: p.sid })),
  periodsWithMultipleTerminals: periodsAll.filter((p) => p.terminals.length > 1).map((p) => ({ file: p.file, sid: p.sid })),
  terminalAfterLastTextEndedAndToolTerminal_byArrival: periodsAll.filter((p) => p.terminals.length).every((p) => p.terminalAfterLastTextAndTool),
  terminalAfter_byDurableSeq: periodsAll.filter((p) => p.terminals.length).every((p) => p.terminalAfterBySeq),
  eventsSeenAfterTerminalInSamePeriod: [...new Set(periodsAll.flatMap((p) => p.eventsAfterTerminal))],
  promptAccounting: accounting,
  promptsNotOneToOne: accounting.filter((a) => !a.equal),
  interruptedReasons: periodsAll.flatMap((p) => p.terminals).filter((t: any) => t.type.endsWith("interrupted")).reduce((a: any, t: any) => ((a[t.reason] = (a[t.reason] ?? 0) + 1), a), {}),
  failedErrorTypes: periodsAll.flatMap((p) => p.terminals).filter((t: any) => t.type.endsWith("failed")).map((t: any) => t.errorType),
  sessionStatusOrIdleEventCounts: statusEvents,
  sessionStatusOrIdleTotal: Object.values(statusEvents).reduce((a, b) => a + b, 0),
  instrumentControl_distinctEventTypesSeen: allTypes.size,
  instrumentControl_executionStartedSeen: Object.values(streams).flat().filter((e) => e.type === "session.execution.started").length,
  sessions: s6sessions,
}
const out = { date: "2026-10-25", opencode: "2.1.4", inputs: Object.keys(streams), manifests: manifestNames, s5, s6 }
writeJson(`${EVIDENCE}/ev-analysis.json`, out)
const brief = {
  s5: { totalCalls: s5.totalCalls, allHaveInputStarted: s5.allHaveInputStarted, allHaveCalled: s5.allHaveCalled, allExactlyOneTerminal: s5.allExactlyOneTerminal, allOrdered: s5.allOrderedStartedCalledTerminal, allOneAssistantMessage: s5.allOneAssistantMessage, violations: s5.violations.length, terminalsByType: s5.terminalsByType, permissionSourceMatches: s5.permissionSourceIdMatchesToolId.map((p) => p.matched), idsSharedAcrossSessions: s5.idsSharedAcrossSessionsInS4Server, sameIdTwiceInOneSession: s5.sameIdTwiceInOneSession },
  s6: { ...s6, sessions: undefined, promptAccounting: undefined },
}
console.log(JSON.stringify(brief, null, 1))
