// mg S10: a profile outside node_modules survives a package reinstall.
// Usage: bun run mg-s10-reinstall.ts <phase:first|after> <outDir> <bin>
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, tapEvents, createSession, prompt, turnEnded, writeJson } from "./common.ts"
import { startServerT as startServer } from "./mg-server.ts"
const [phase, out, bin] = process.argv.slice(2)
const p = makeProfile(join(out!, "isomux-state", "opencode", "profiles", "p1"))
const repo = makeRepo(join(out!, "repo"))
const mock = await startMock(join(out!, `mock-${phase}.log`), { MOCK_SHELL_TOOL: "shell" })
const s = await startServer(p, { bin, configContent: mockProviderConfig(mock), env: { OPENCODE_DISABLE_MODELS_FETCH: "1" }, logPath: join(out!, `server-${phase}.log`) })
const res: Record<string, unknown> = { date: "2026-10-25", phase, version: (await s.api("GET", "/api/info")).body?.version }
if (phase === "first") {
  const tap = await tapEvents(s, join(out!, "events.jsonl"))
  const ses = await createSession(s, repo)
  await prompt(s, ses.id, "GATE_RECALL mg reinstall S4_CONTEXT_CANARY")
  res.turn = (await tap.waitFor(turnEnded(ses.id), 30000).catch(() => null))?.type ?? "timeout"
  tap.close()
  res.sessionID = ses.id
}
const list = await s.api("GET", "/api/session?limit=50")
res.sessions = list.body?.data?.map((x: any) => x.id)
await s.stop(); mock.stop()
writeJson(join(out!, `reinstall-${phase}.json`), res)
console.log(JSON.stringify(res))
