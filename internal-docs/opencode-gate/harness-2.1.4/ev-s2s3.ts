// S2 (parallel sessions, no crossing) and S3 (restart and resume). Task 4840abc5, 2026-10-25.
import { readFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, writeJson, GATE_ROOT, TURN_END } from "./common.ts"
import { Manifest, sendPrompt, waitTerminal, waitEvent, messages, readLog, copyRedacted, countIn, EVIDENCE } from "./ev-lib.ts"

const ts = Date.now()
const root = `${GATE_ROOT}/run/ev-s2s3-${ts}`
const p = makeProfile(root)
const repoA = makeRepo(`${root}/repoA`)
// repoB gets its own root commit so the two repos are two projects (projectID = root commit hash).
const repoB = `${root}/repoB`
{
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(repoB, { recursive: true })
  Bun.spawnSync(["git", "init", "-q"], { cwd: repoB })
  writeFileSync(`${repoB}/README.md`, "gate repo B (distinct root)\n")
  const g = ["git", "-c", "user.email=gate@example.com", "-c", "user.name=gate"]
  Bun.spawnSync([...g, "add", "."], { cwd: repoB })
  Bun.spawnSync([...g, "commit", "-qm", "init B"], { cwd: repoB })
}
const man = new Manifest(`${EVIDENCE}/ev-s2s3-manifest.json`)
const out: any = { date: "2026-10-25", run: root, opencode: "2.1.4", s2: {}, s3: {} }
const procs: string[] = []
const servers: any[] = []

const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
procs.push(`mock pid=${mock.proc.pid}`)
const cfg = mockProviderConfig(mock)
const s1 = await startServer(p, { config: cfg, logPath: `${root}/server1.log` })
procs.push(`server1 pid=${s1.pid}`); servers.push(s1)
const tap1 = await tapEvents(s1, `${root}/events1.jsonl`)
const ask = [{ action: "shell", resource: "*", effect: "ask" }]
const A = CANARY("A")
const B = CANARY("B")
function CANARY(x: string) {
  return { tag: `EV_CANARY_${x}_${ts}`, file: `ev-${x.toLowerCase()}.txt` }
}
let exitInfo: any = {}
try {
  const [ca, cb] = await Promise.all([
    s1.api("POST", "/api/session", { location: { directory: repoA }, permissions: ask }),
    s1.api("POST", "/api/session", { location: { directory: repoB }, permissions: ask }),
  ])
  const sa = ca.body.data, sb = cb.body.data
  out.s2.sessions = { A: { id: sa.id, status: ca.status, dir: sa.location?.directory }, B: { id: sb.id, status: cb.status, dir: sb.location?.directory } }
  out.s2.createdPermissions = { A: sa.permissions, B: sb.permissions }
  out.s2.projectIDs = { A: sa.projectID, B: sb.projectID, distinct: sa.projectID !== sb.projectID }

  // Turn 1, concurrent: carries S4_CONTEXT_CANARY for the S3 recall.
  await Promise.all([
    sendPrompt(s1, man, "s2-t1-A", sa.id, `first prompt ${A.tag} S4_CONTEXT_CANARY`),
    sendPrompt(s1, man, "s2-t1-B", sb.id, `first prompt ${B.tag} S4_CONTEXT_CANARY`),
  ])
  const t1 = await Promise.all([waitTerminal(tap1, sa.id, 1), waitTerminal(tap1, sb.id, 1)])
  out.s2.turn1 = t1.map((e) => e.type)

  // Turn 2, concurrent: a shell call that asks; each writes its own canary file.
  const call = (c: typeof A) => `${c.tag} GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: `printf ${c.tag} > ${c.file}` } })}`
  await Promise.all([sendPrompt(s1, man, "s2-t2-A", sa.id, call(A)), sendPrompt(s1, man, "s2-t2-B", sb.id, call(B))])
  const [pa, pb] = await Promise.all([
    waitEvent(tap1, (e) => e.type === "permission.asked" && e.data?.sessionID === sa.id),
    waitEvent(tap1, (e) => e.type === "permission.asked" && e.data?.sessionID === sb.id),
  ])
  out.s2.permissionAsked = { A: pa.data, B: pb.data }
  const listA = await s1.api("GET", `/api/session/${sa.id}/permission`)
  const listB = await s1.api("GET", `/api/session/${sb.id}/permission`)
  out.s2.pendingLists = { A: listA, B: listB }
  // Cross-session probes: A's request id under B's path, and B's under A's.
  out.s2.crossGet = {
    AidUnderB: await s1.api("GET", `/api/session/${sb.id}/permission/${pa.data.id}`),
    BidUnderA: await s1.api("GET", `/api/session/${sa.id}/permission/${pb.data.id}`),
  }
  out.s2.crossReply = {
    AidUnderB: await s1.api("POST", `/api/session/${sb.id}/permission/${pa.data.id}/reply`, { decision: "once" }),
    BidUnderA: await s1.api("POST", `/api/session/${sa.id}/permission/${pb.data.id}/reply`, { decision: "once" }),
  }
  await Bun.sleep(300)
  out.s2.afterCrossReply = {
    filesA: existsSync(join(repoA, A.file)),
    filesB: existsSync(join(repoB, B.file)),
    replied: tap1.events.filter((e) => e.type === "permission.replied").map((e) => e.data),
  }
  // Correct replies.
  out.s2.reply = {
    A: await s1.api("POST", `/api/session/${sa.id}/permission/${pa.data.id}/reply`, { decision: "once" }),
    B: await s1.api("POST", `/api/session/${sb.id}/permission/${pb.data.id}/reply`, { decision: "once" }),
  }
  const t2 = await Promise.all([waitTerminal(tap1, sa.id, 2), waitTerminal(tap1, sb.id, 2)])
  out.s2.turn2 = t2.map((e) => e.type)
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null)
  out.s2.files = {
    "repoA/ev-a.txt": read(join(repoA, A.file)),
    "repoA/ev-b.txt": read(join(repoA, B.file)),
    "repoB/ev-b.txt": read(join(repoB, B.file)),
    "repoB/ev-a.txt": read(join(repoB, A.file)),
    profileDir_ev_a: existsSync(join(root, A.file)),
    profileDir_ev_b: existsSync(join(root, B.file)),
  }
  const mA = await messages(s1, sa.id)
  const mB = await messages(s1, sb.id)
  writeJson(`${EVIDENCE}/ev-s2-messages.json`, { A: mA, B: mB })
  const jA = JSON.stringify(mA.data), jB = JSON.stringify(mB.data)
  out.s2.messageCanaries = {
    A_has_A: jA.split(A.tag).length - 1,
    A_has_B: jA.split(B.tag).length - 1,
    B_has_B: jB.split(B.tag).length - 1,
    B_has_A: jB.split(A.tag).length - 1,
    A_messageSessionIDs: [...new Set(mA.data.map((x: any) => x.sessionID))],
    B_messageSessionIDs: [...new Set(mB.data.map((x: any) => x.sessionID))],
    A_count: mA.data.length,
    B_count: mB.data.length,
  }
  // Events: every event that mentions a canary must belong to that canary's session.
  const ev = tap1.events
  const mentions = (tag: string) => ev.filter((e) => JSON.stringify(e).includes(tag))
  const sidOf = (e: any) => e.data?.sessionID ?? e.durable?.aggregateID ?? null
  out.s2.eventCanaries = {
    A_mentions: mentions(A.tag).length,
    A_mentions_sessionIDs: [...new Set(mentions(A.tag).map(sidOf))],
    B_mentions: mentions(B.tag).length,
    B_mentions_sessionIDs: [...new Set(mentions(B.tag).map(sidOf))],
    eventsBySession: { A: ev.filter((e) => e.data?.sessionID === sa.id).length, B: ev.filter((e) => e.data?.sessionID === sb.id).length },
    // tool events of each session carry only that session's tool call ids
    toolIdsA: [...new Set(ev.filter((e) => e.data?.sessionID === sa.id && e.type.startsWith("session.tool.")).map((e) => e.data.id))],
    toolIdsB: [...new Set(ev.filter((e) => e.data?.sessionID === sb.id && e.type.startsWith("session.tool.")).map((e) => e.data.id))],
    toolCalledInputs: ev.filter((e) => e.type === "session.tool.called").map((e) => ({ sid: e.data.sessionID, id: e.data.id, input: e.data.input })),
  }
  // Durable seq of each session is its own sequence.
  out.s2.durable = {
    A: ev.filter((e) => e.durable?.aggregateID === sa.id).map((e) => e.durable.seq),
    B: ev.filter((e) => e.durable?.aggregateID === sb.id).map((e) => e.durable.seq),
    mismatched: ev.filter((e) => e.durable && e.data?.sessionID && e.durable.aggregateID !== e.data.sessionID && e.durable.aggregateID.startsWith("ses")).length,
  }
  const lastSeqA = Math.max(...out.s2.durable.A)
  out.s3.lastSeqBeforeRestart = { A: lastSeqA, B: Math.max(...out.s2.durable.B) }
  // Log endpoint check while alive: replay all and after a mid seq.
  const logAllA = await readLog(s1, sa.id)
  out.s2.logReplayLive = { status: logAllA.status, contentType: logAllA.contentType, count: logAllA.events.length, endedByServer: logAllA.endedByServer, sample: logAllA.rawFrames.map((f) => f.slice(0, 300)) }

  // ---------- S3: SIGTERM, restart same profile ----------
  tap1.close()
  const t0 = Date.now()
  const exitP = new Promise<any>((r) => s1.proc.once("exit", (code, sig) => r({ code, sig })))
  await s1.stop("SIGTERM")
  exitInfo = await Promise.race([exitP, Bun.sleep(200).then(() => ({ code: s1.proc.exitCode, sig: s1.proc.signalCode }))])
  out.s3.server1Exit = { ...exitInfo, ms: Date.now() - t0, signal: "SIGTERM" }

  const s2 = await startServer(p, { config: cfg, logPath: `${root}/server2.log` })
  procs.push(`server2 pid=${s2.pid}`); servers.push(s2)
  const tap2 = await tapEvents(s2, `${root}/events2.jsonl`)
  out.s3.getSessions = {
    A: await s2.api("GET", `/api/session/${sa.id}`),
    B: await s2.api("GET", `/api/session/${sb.id}`),
  }
  const mA2 = await messages(s2, sa.id)
  const mB2 = await messages(s2, sb.id)
  out.s3.messagesAfterRestart = {
    A_count: mA2.data.length,
    B_count: mB2.data.length,
    A_sameIds: JSON.stringify(mA2.data.map((x: any) => x.id)) === JSON.stringify(mA.data.map((x: any) => x.id)),
    B_sameIds: JSON.stringify(mB2.data.map((x: any) => x.id)) === JSON.stringify(mB.data.map((x: any) => x.id)),
    A_types: mA2.data.map((x: any) => x.type),
  }
  out.s3.pendingPermissionsAfterRestart = (await s2.api("GET", "/api/permission/request")).body
  // Durable log replay across the restart: after the last seq before restart there should be nothing yet.
  const logAfterRestart = await readLog(s2, sa.id, lastSeqA)
  out.s3.logAfterLastSeqBeforeTurn = { count: logAfterRestart.events.length, types: logAfterRestart.events.map((e: any) => e.type) }
  const logFromMid = await readLog(s2, sa.id, Math.floor(lastSeqA / 2))
  out.s3.logAfterMidSeq = {
    after: Math.floor(lastSeqA / 2),
    count: logFromMid.events.length,
    seqs: logFromMid.events.map((e: any) => e.durable?.seq ?? e.seq ?? null),
    expected: out.s2.durable.A.filter((x: number) => x > Math.floor(lastSeqA / 2)),
  }
  await Promise.all([sendPrompt(s2, man, "s3-recall-A", sa.id, "GATE_RECALL"), sendPrompt(s2, man, "s3-recall-B", sb.id, "GATE_RECALL")])
  const rec = await Promise.all([waitTerminal(tap2, sa.id, 1), waitTerminal(tap2, sb.id, 1)])
  out.s3.recallTerminals = rec.map((e) => e.type)
  const textEnded = (sid: string) => tap2.events.filter((e) => e.type === "session.text.ended" && e.data?.sessionID === sid).map((e) => e.data.text)
  out.s3.recallText = { A: textEnded(sa.id), B: textEnded(sb.id) }
  const logPost = await readLog(s2, sa.id, lastSeqA)
  out.s3.logAfterLastSeqAfterTurn = { count: logPost.events.length, types: logPost.events.map((e: any) => e.type) }
  // follow=true picks up live events
  const followP = readLog(s2, sa.id, undefined, true, 4000, 9000)
  await Bun.sleep(500)
  await sendPrompt(s2, man, "s3-follow-A", sa.id, "follow check")
  await waitTerminal(tap2, sa.id, 2)
  const fol = await followP
  out.s3.logFollow = { count: fol.events.length, endedByServer: fol.endedByServer, lastTypes: fol.events.slice(-4).map((e: any) => e.type) }
  out.s3.mockLogRecall = readFileSync(`${root}/mock.log`, "utf8").split("\n").filter((l) => l.includes("GATE_RECALL"))
  tap2.close()
  await s2.stop("SIGTERM")
  out.s3.server2Exit = { code: s2.proc.exitCode, sig: s2.proc.signalCode }
  // Evidence copies (redacted)
  const secrets = [s1.password, s2.password]
  copyRedacted(`${root}/events1.jsonl`, `${EVIDENCE}/ev-s2-events.jsonl`, secrets)
  copyRedacted(`${root}/events2.jsonl`, `${EVIDENCE}/ev-s3-events.jsonl`, secrets)
  copyRedacted(`${root}/server1.log`, `${root}/server1.redacted.log`, secrets)
  out.passwordInLogs = { server1: countIn(`${root}/server1.log`, s1.password), server2: countIn(`${root}/server2.log`, s2.password) }
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  for (const sv of servers) await sv.stop("SIGKILL").catch(() => {})
  mock.stop()
  out.processes = procs
  man.save()
  writeJson(`${EVIDENCE}/ev-s2s3.json`, out)
  console.log(JSON.stringify(out, null, 1).slice(0, 20000))
  process.exit(0)
}
