import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, GATE_ROOT } from "./common.ts"
const root = `${GATE_ROOT}/run/smoke-${Date.now()}`
const p = makeProfile(root)
const repo = makeRepo(`${root}/repo`)
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const s = await startServer(p, { config: mockProviderConfig(mock) })
const tap = await tapEvents(s, `${root}/events.jsonl`)
const ses = await createSession(s, repo)
await prompt(s, ses.id, 'run GATE_CALL:{"tool":"shell","args":{"command":"printf ok > out.txt"}}')
const end = await tap.waitFor(turnEnded(ses.id), 30000)
console.log("end", end.type, "file", await Bun.file(`${repo}/out.txt`).text().catch(() => "missing"))
console.log([...new Set(tap.events.map((e) => e.type))].join(" "))
tap.close(); await s.stop(); mock.stop()
