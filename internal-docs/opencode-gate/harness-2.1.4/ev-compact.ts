// S4 compaction success path with ev-mock.ts (fills the v2 summary template), plus a
// direct positive control that the mock's 401 carries the sentinel header. 2026-10-25.
import { spawn } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, mockProviderConfig, startServer, tapEvents, writeJson, freePort, GATE_ROOT, type Mock, type Server } from "./common.ts"
import { Manifest, sendPrompt, waitTerminal, countTerminals, messages, writeFixture, copyRedacted, EVIDENCE } from "./ev-lib.ts"

async function startEvMock(logPath: string, env: Record<string, string> = {}): Promise<Mock> {
  const port = await freePort()
  const proc = spawn("bun", ["run", join(import.meta.dir, "ev-mock.ts")], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
  proc.stdout!.on("data", (d) => appendFileSync(logPath, d))
  proc.stderr!.on("data", (d) => appendFileSync(logPath, d))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    await Bun.sleep(50)
  }
  return { port, url: `http://127.0.0.1:${port}/v1`, proc, stop: () => proc.kill("SIGKILL") }
}

const root = `${GATE_ROOT}/run/ev-compact-${Date.now()}`
const p = makeProfile(root)
const repo = makeRepo(`${root}/repo`)
const man = new Manifest(`${EVIDENCE}/ev-compact-manifest.json`)
const out: any = { date: "2026-10-25", run: root }
const servers: Server[] = []
const mock = await startEvMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
out.processes = [`ev-mock pid=${mock.proc.pid}`]
try {
  // Positive control for S9: the mock really sends the sentinel header on a bad key.
  const r = await fetch(`${mock.url}/chat/completions`, { method: "POST", headers: { authorization: "Bearer INVALID_GATE_KEY", "content-type": "application/json" }, body: "{}" })
  out.mockHeaderControl = { status: r.status, sentinelHeaderFound: r.headers.get("x-provider-secret") === "GATE_HEADER_SECRET_SENTINEL" }
  await r.text()

  const s = await startServer(p, { config: mockProviderConfig(mock), logPath: `${root}/server.log` })
  servers.push(s)
  out.processes.push(`server pid=${s.pid}`)
  const tap = await tapEvents(s, `${root}/events.jsonl`)
  const sid = (await s.api("POST", "/api/session", { location: { directory: repo } })).body.data.id
  await sendPrompt(s, man, "c-t1", sid, "EV compaction turn one S4_CONTEXT_CANARY")
  await waitTerminal(tap, sid, 1)
  await sendPrompt(s, man, "c-t2", sid, "EV compaction turn two")
  await waitTerminal(tap, sid, 2)
  await sendPrompt(s, man, "c-t3", sid, "EV compaction turn three")
  await waitTerminal(tap, sid, 3)
  const before = await messages(s, sid)
  const c = await s.api("POST", `/api/session/${sid}/compact`, {})
  man.prompts.push({ label: "compact", sessionID: sid, text: "(POST compact)", sentAt: Date.now(), status: c.status, response: c.body })
  const cend = await waitTerminal(tap, sid, 4, 30000).catch((e) => ({ type: String(e) }))
  await Bun.sleep(300)
  await sendPrompt(s, man, "c-t4", sid, "GATE_RECALL after compaction")
  const t4 = await waitTerminal(tap, sid, countTerminals(tap, sid) + 1, 30000).catch((e) => ({ type: String(e) }))
  await sendPrompt(s, man, "c-t5", sid, `GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: "printf after-compact > ev-after-compact.txt" } })}`)
  const t5 = await waitTerminal(tap, sid, countTerminals(tap, sid) + 1, 30000).catch((e) => ({ type: String(e) }))
  const after = await messages(s, sid)
  const ev = tap.events.filter((e) => e.data?.sessionID === sid)
  out.compaction = {
    sid,
    compactResponse: { status: c.status, type: c.body?.data?.type, delivery: c.body?.data?.delivery },
    compactTerminal: (cend as any).type,
    compactionEvents: ev.filter((e) => e.type.startsWith("session.compaction") && e.type !== "session.compaction.delta").map((e) => ({ type: e.type, data: { ...e.data, text: undefined, summary: typeof e.data.summary === "string" ? e.data.summary.slice(0, 120) : e.data.summary } })),
    compactionDeltas: ev.filter((e) => e.type === "session.compaction.delta").length,
    laterTurnTerminal: (t4 as any).type,
    laterText: ev.filter((e) => e.type === "session.text.ended").map((e) => e.data.text).slice(-2),
    toolTurnAfterCompaction: (t5 as any).type,
    messageTypesBefore: before.data.map((m: any) => m.type),
    messageTypesAfter: after.data.map((m: any) => m.type),
    compactionMessage: after.data.filter((m: any) => m.type === "compaction").map((m: any) => JSON.stringify(m).slice(0, 600)),
    mockRequests: readFileSync(`${root}/mock.log`, "utf8").split("\n").filter((l) => l.includes('"prompt"')).map((l) => JSON.parse(l)).map((x: any) => ({ prompt: x.prompt.slice(0, 60), messageCount: x.messageCount, isSummary: x.isSummary, hasTurnOne: x.hasTurnOne, hasSummaryMark: x.hasSummaryMark })),
  }
  await Bun.sleep(300)
  tap.close()
  await s.stop("SIGTERM")
  writeFixture(`${EVIDENCE}/ev-fx-compaction-ok.jsonl`, tap.events, [sid])
  copyRedacted(`${root}/server.log`, `${root}/server.redacted.log`, [s.password])
} catch (e) {
  out.error = String((e as Error).stack ?? e)
} finally {
  for (const sv of servers) await sv.stop("SIGKILL").catch(() => {})
  mock.stop()
  man.save()
  writeJson(`${EVIDENCE}/ev-compact.json`, out)
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}
