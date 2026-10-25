// mg P8 second 2.1.4 start on the migrated copy1: message pagination, and
// continuing an old session after moving it to a scratch directory.
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, freePort, startServer, tapEvents, turnEnded, mockProviderConfig, writeJson, type Mock } from "./common.ts"

const R = readFileSync("/tmp/t-4840abc5/run/mg-current.txt", "utf8").trim()
const out = join(R, "p8-v2again")
Bun.spawnSync(["mkdir", "-p", out])
const v1sessions = JSON.parse(readFileSync(join(R, "census", "v1-sessions.json"), "utf8")) as any[]
const result: Record<string, unknown> = { date: "2026-10-25", phase: "v2again", target: "copy1", binary: "2.1.4" }

async function startMgMock(logPath: string): Promise<Mock> {
  const port = await freePort()
  const proc = spawn("bun", ["run", join(import.meta.dir, "mg-mock.ts")], { env: { ...process.env, MOCK_SHELL_TOOL: "shell", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    await Bun.sleep(50)
  }
  return { port, url: `http://127.0.0.1:${port}/v1`, proc, stop: () => proc.kill("SIGKILL") }
}
const mockLines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((j) => j.messageCount !== undefined) : [])

const mockLog = join(out, "mock.log")
const mock = await startMgMock(mockLog)
const p = makeProfile(join(R, "copy1"))
const netEnv = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OPENCODE_DISABLE_MODELS_FETCH: "1" }
const s = await startServer(p, { configContent: mockProviderConfig(mock, { small_model: "gate/gate-model" }), env: netEnv, logPath: join(out, "server.log") })
try {
  result.migrationStatus = (await s.api("GET", "/api/experimental/migration/v1")).body?.status
  // Pagination for the 242-message session.
  const v = v1sessions[16]
  const first = await s.api("GET", `/api/session/${v.id}/message?limit=200&order=asc`)
  const cur = first.body?.cursor
  result.paginationCursorKeys = cur ? Object.keys(cur) : null
  const second = await s.api("GET", `/api/session/${v.id}/message?limit=200&cursor=${encodeURIComponent(cur?.next ?? "")}`)
  const secondWithOrder = await s.api("GET", `/api/session/${v.id}/message?limit=200&order=asc&cursor=${encodeURIComponent(cur?.next ?? "")}`)
  const nolimit = await s.api("GET", `/api/session/${v.id}/message`)
  result.pagination = {
    firstStatus: first.status, firstCount: first.body?.data?.length,
    secondNoOrderStatus: second.status, secondNoOrderCount: second.body?.data?.length, secondNoOrderErrTag: second.body?._tag, secondNoOrderErr: second.status !== 200 ? String(second.body?.message ?? "").slice(0, 200) : undefined,
    secondWithOrderStatus: secondWithOrder.status, secondWithOrderErrTag: secondWithOrder.body?._tag, secondWithOrderErr: secondWithOrder.status !== 200 ? String(secondWithOrder.body?.message ?? "").slice(0, 200) : undefined,
    noLimitStatus: nolimit.status, noLimitCount: nolimit.body?.data?.length,
    v1Messages: v.msgs,
    total: (first.body?.data?.length ?? 0) + (second.status === 200 ? second.body.data.length : 0),
  }
  // Move the old session (deleted /tmp worktree) to a scratch git repo, then GATE_RECALL.
  const scratch = makeRepo(join(R, "scratch-repo"))
  const ses = v1sessions[17]
  const tap = await tapEvents(s, join(out, "events.jsonl"))
  const mv = await s.api("POST", `/api/session/${ses.id}/move`, { directory: scratch })
  const sw = await s.api("POST", `/api/session/${ses.id}/model`, { model: { id: "gate-model", providerID: "gate" } })
  const before = mockLines(mockLog).length
  const msgsBefore = (await s.api("GET", `/api/session/${ses.id}/message`)).body?.data?.length
  const pr = await s.api("POST", `/api/session/${ses.id}/prompt`, { text: "GATE_RECALL mg continue" })
  let end: any = null
  try { end = await tap.waitFor(turnEnded(ses.id), 60_000) } catch {}
  await Bun.sleep(300)
  const lines = mockLines(mockLog).slice(before)
  const recall = lines.find((l) => l.recall)
  const after = await s.api("GET", `/api/session/${ses.id}/message`)
  const marker = JSON.stringify(after.body?.data ?? []).match(/RECALLED:[A-Z0-9_]+/)?.[0] ?? null
  result.continueAfterMove = {
    i: 17, v1Messages: ses.msgs, moveStatus: mv.status, moveErr: mv.status >= 300 ? String(mv.body?._tag) : undefined, modelSwitchStatus: sw.status, promptStatus: pr.status,
    promptErrTag: pr.status !== 200 ? pr.body?._tag : undefined,
    turnEnd: end?.type ?? "timeout", messagesBefore: msgsBefore, messagesAfter: after.body?.data?.length,
    mockRequests: lines.length, mockRecallRequest: recall ? { messageCount: recall.messageCount, roles: recall.roles, historyChars: recall.historyChars } : null,
    answerMarker: marker,
  }
  // A control: a brand-new session in the same scratch repo gets RECALLED:EMPTY.
  const fresh = await s.api("POST", "/api/session", { location: { directory: scratch } })
  const fid = fresh.body?.data?.id
  await s.api("POST", `/api/session/${fid}/prompt`, { text: "GATE_RECALL mg control" })
  let fend: any = null
  try { fend = await tap.waitFor(turnEnded(fid), 60_000) } catch {}
  const fmsgs = await s.api("GET", `/api/session/${fid}/message`)
  result.controlFreshSession = { createStatus: fresh.status, turnEnd: fend?.type ?? "timeout", answerMarker: JSON.stringify(fmsgs.body?.data ?? []).match(/RECALLED:[A-Z0-9_]+/)?.[0] ?? null }
  tap.close()
  const plug = await s.api("GET", `/api/plugin?location[directory]=${encodeURIComponent(scratch)}`)
  result.pluginsAtScratch = Array.isArray(plug.body?.data) ? plug.body.data.map((x: any) => ({ id: x.id, source: x.source, status: x.state?.status })) : { status: plug.status }
  result.sessionCountNow = (await s.api("GET", "/api/session?limit=200")).body?.data?.length
} catch (e) {
  result.error = String(e).slice(0, 500)
} finally {
  await s.stop()
  mock.stop()
}
writeJson(join(out, "result.json"), result)
console.log(JSON.stringify(result, null, 1))
