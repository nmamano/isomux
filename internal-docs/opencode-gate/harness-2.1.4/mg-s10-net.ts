// mg S10: one 2.1.4 serve, one session and turn on the mock, then idle until
// 60 s after start. Run it under strace to list outbound destinations.
// Usage: bun run mg-s10-net.ts <modelsFetch:on|off> <outDir>
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, tapEvents, createSession, prompt, turnEnded, writeJson } from "./common.ts"
import { startServerT as startServer } from "./mg-server.ts"
const [mf, out] = process.argv.slice(2)
const t0 = Date.now()
const p = makeProfile(join(out!, "profile"))
const repo = makeRepo(join(out!, "repo"))
const mock = await startMock(join(out!, "mock.log"), { MOCK_SHELL_TOOL: "shell" })
const s = await startServer(p, { configContent: mockProviderConfig(mock), env: mf === "off" ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}, logPath: join(out!, "server.log") })
const res: Record<string, unknown> = { date: "2026-10-25", modelsFetch: mf, serverPid: s.pid, mockPort: mock.port, serverPort: s.port }
const tap = await tapEvents(s, join(out!, "events.jsonl"))
const ses = await createSession(s, repo)
await prompt(s, ses.id, "hello mg s10")
res.turn = (await tap.waitFor(turnEnded(ses.id), 30000).catch(() => null))?.type ?? "timeout"
tap.close()
while (Date.now() - t0 < 60_000) await Bun.sleep(500)
res.ranMs = Date.now() - t0
await s.stop(); mock.stop()
writeJson(join(out!, "run.json"), res)
console.log(JSON.stringify(res))
