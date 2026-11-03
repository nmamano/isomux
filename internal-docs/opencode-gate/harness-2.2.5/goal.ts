// Task 6dca5910 C3: does POST /api/session/:id/prompt with "/goal ..." run the goal command on 2.2.5?
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, GATE_ROOT } = await import(`${H}/common.ts`)
const root = `${GATE_ROOT}/run/goal-${Date.now()}`
const p = makeProfile(root)
const mock = await startMock(`${root}/mock.log`)
const s = await startServer(p, { config: mockProviderConfig(mock) })
const tap = await tapEvents(s, `${root}/events.jsonl`)
const out: any = { root, version: (await s.api("GET", "/api/info")).body?.version }
try {
  const repo = makeRepo(join(root, "repo"))
  const ses = await createSession(s, repo)
  await s.api("POST", `/api/session/${ses.id}/model`, { model: { providerID: "gate", id: "gate-model" } })
  const text = "/goal say GOALCANARY until done"
  out.promptReply = await prompt(s, ses.id, text).then(() => "ok", (e: Error) => e.message)
  out.end = (await tap.waitFor(turnEnded(ses.id), 30_000).catch(() => ({ type: "timeout" }))).type
  await Bun.sleep(8000)
  const log = (await Bun.file(`${root}/mock.log`).text()).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
  out.modelRequests = log.length
  out.literalSlashReachedModel = log.some((r: any) => String(r.prompt).includes(text))
  out.kickoffLike = log.filter((r: any) => !String(r.prompt).includes(text) && String(r.prompt).includes("GOALCANARY")).length
  out.executions = tap.events.filter((e: any) => e.data?.sessionID === ses.id && String(e.type).startsWith("session.execution.")).map((e: any) => e.type)
  out.commandEvents = tap.events.filter((e: any) => /command|goal/i.test(String(e.type))).map((e: any) => e.type)
  const kv = await s.api("GET", `/api/session/${ses.id}`)
  out.sessionGoalMentions = JSON.stringify(kv.body).includes("goal")
} finally {
  await s.stop?.(); mock.stop?.()
  console.log(JSON.stringify(out, null, 2))
}
