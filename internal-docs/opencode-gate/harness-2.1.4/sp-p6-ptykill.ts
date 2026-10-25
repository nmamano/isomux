// Does the opencode-pty daemon (and its shell) outlive a SIGKILLed 2.1.4 server? 2026-10-25.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, createSession, writeJson, GATE_ROOT } from "./common.ts"
import { startServerT } from "./sp-lib.ts"
import { readProcessHop } from "../../../server/backends/opencode/process-identity.ts"
const root = `${GATE_ROOT}/run/sp-p6k-${Date.now()}`
const p = makeProfile(root); const repo = makeRepo(join(root, "repo"))
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const s = await startServerT(p, { config: mockProviderConfig(mock), cwd: root })
const ses = await createSession(s, repo)
const term = await s.api("POST", `/api/experimental/session/${ses.id}/terminal`, { command: "/bin/sh", args: ["-c", "sleep 40"], cwd: repo, title: "kill", env: {} })
await Bun.sleep(1500)
const kids = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((d) => { try { return readFileSync(`/proc/${d}/cmdline`, "utf8").includes(root) || readProcessHop(d)?.parentPid === s.pid } catch { return false } })
const comm = (x: number) => { try { return readFileSync(`/proc/${x}/comm`, "utf8").trim() } catch { return null } }
const daemon = kids().filter((x) => comm(x) === "opencode-pty")
const shell = daemon.flatMap((d) => readdirSync("/proc").filter((x) => /^\d+$/.test(x)).map(Number).filter((x) => readProcessHop(x)?.parentPid === d))
const before = [...daemon, ...shell].map((x) => ({ pid: x, comm: comm(x), ppid: readProcessHop(x)?.parentPid, ticks: readProcessHop(x)?.startTicks }))
process.kill(s.pid, "SIGKILL")
await Bun.sleep(1500)
const after = before.map((b) => ({ ...b, alive: readProcessHop(b.pid)?.startTicks === b.ticks, ppidNow: readProcessHop(b.pid)?.parentPid, ppidNowComm: comm(readProcessHop(b.pid)?.parentPid ?? 0) }))
for (const a of after) if (a.alive) try { process.kill(a.pid, "SIGTERM") } catch {}
await Bun.sleep(500)
const cleaned = after.map((a) => ({ pid: a.pid, aliveAfterOurKill: readProcessHop(a.pid)?.startTicks === a.ticks }))
mock.stop()
writeJson(`${GATE_ROOT}/evidence/sp-p6-pty-sigkill.json`, { date: "2026-10-25", probe: "sp-p6-ptykill", runDir: root, terminalCreate: term.status, serverPid: s.pid, before, afterServerSigkill: after.map(({ ticks, ...x }) => x), cleaned })
console.log("done", root)
