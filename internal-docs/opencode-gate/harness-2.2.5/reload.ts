// Task 6dca5910: does a plugin reload during a turn let a tool call skip the
// last plugin's execute.before hook? Mock model; GATE_V2_BIN picks the version.
// TOOL=read (a read of a secret- path) or TOOL=shell (a GATE_DENY_ME command).
// Reviewer condition 1: the guard decides the read deny BEFORE it records.
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, GATE_ROOT } = await import(`${H}/common.ts`)
const { writeSafetyPlugin, readRecords, awaitIsomuxActive, toolOutcomes, gateCall } = await import(`${H}/sp-lib.ts`)

const SETUP_MS = Number(process.env.SLOW_SETUP_MS ?? "3000")
const root = `${GATE_ROOT}/run/reload-${Date.now()}`
const p = makeProfile(root)
const recordPath = join(root, "hook-records.jsonl")
const pluginDir = writeSafetyPlugin(join(root, "isomux-safety"), recordPath)
{ const f = join(pluginDir, "index.js"); const src = (await Bun.file(f).text()).replace('      rec({ kind: "hook"', '      if (event.tool === "read" && String(input.path ?? "").includes("secret-")) deny = "ISOMUX_DENY read of a secret- path"\n      rec({ kind: "hook"'); writeFileSync(f, src); if (src.indexOf("secret-") < 0 || src.indexOf("secret-") > src.indexOf('rec({ kind: "hook"')) throw new Error("guard edit did not apply before rec") }
const TOOL = process.env.TOOL === "shell" ? "shell" : "read"
const RULES = [["shell","ask"],["edit","ask"],["question","deny"],["external_directory","ask"]].map(([action, effect]) => ({ action, resource: "*", effect }))
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell", GATE_ABORT_MS: "1500" })
const firstDir = process.env.DUAL ? writeSafetyPlugin(join(root, "isomux-safety-first"), recordPath, "isomux-safety-first") : null
const s = await startServer(p, { config: mockProviderConfig(mock, firstDir ? { plugins: [firstDir] } : {}), configContent: { plugins: [pluginDir] } })
const tap = await tapEvents(s, `${root}/events.jsonl`)
const slowFile = (repo: string) => join(repo, ".opencode/plugins/slow.js")
const writeSlow = (repo: string, rev: number) =>
  writeFileSync(slowFile(repo), `// rev ${rev}
import { appendFileSync } from "node:fs"
export default { id: "project-slow", async setup(ctx) {
  appendFileSync(${JSON.stringify(join(root, "slow.jsonl"))}, JSON.stringify({ at: Date.now(), kind: "setup-start", rev: ${rev} }) + "\\n")
  await new Promise((r) => setTimeout(r, ${SETUP_MS}))
  appendFileSync(${JSON.stringify(join(root, "slow.jsonl"))}, JSON.stringify({ at: Date.now(), kind: "setup-end", rev: ${rev} }) + "\\n")
} }
`)

async function run(name: string, touch: boolean) {
  const repo = makeRepo(join(root, name))
  mkdirSync(join(repo, ".opencode/plugins"), { recursive: true })
  writeSlow(repo, 1)
  writeFileSync(join(repo, "secret-x.txt"), "SECRET_CANARY_6dca\n")
  const ses = await createSession(s, repo, { permissions: RULES })
  const pin = await s.api("POST", `/api/session/${ses.id}/model`, { model: { providerID: "gate", id: "gate-model" } })
  if (pin.status !== 200 && pin.status !== 204) throw new Error(`model pin ${pin.status} ${JSON.stringify(pin.body).slice(0, 200)}`)
  const check = await awaitIsomuxActive(s, repo, pluginDir, 20_000)
  const t0 = Date.now()
  await prompt(s, ses.id, `GATE_ABORT ${TOOL === "read" ? gateCall("read", { path: join(repo, "secret-x.txt") }) : gateCall("shell", { command: "echo GATE_DENY_ME > side.txt" })}`)
  let touchedAt: number | null = null
  if (touch) { await Bun.sleep(300); writeSlow(repo, 2); touchedAt = Date.now() }
  const end = (await tap.waitFor(turnEnded(ses.id), 60_000).catch(() => ({ type: "timeout" }))).type
  const hooks = readRecords(recordPath).filter((x: any) => x.kind === "hook" && x.sessionID === ses.id)
  return {
    name, touch, check: check?.ok ?? check, end, promptAt: t0, touchedAt,
    sideFileExists: existsSync(join(repo, "side.txt")),
    isomuxHookCalls: hooks.map((h: any) => ({ at: h.at, plugin: h.plugin, decision: h.decision })),
    isomuxSetups: readRecords(recordPath).filter((x: any) => x.kind === "setup" && x.directory === repo).map((x: any) => x.at),
    tools: toolOutcomes(tap, ses.id),
    hookDenied: hooks.some((h: any) => h.decision === "deny"),
    toolFailedByIsomux: toolOutcomes(tap, ses.id).some((t: any) => t.type === "session.tool.failed" && String(t.error).includes("ISOMUX_DENY")),
    asks: tap.events.filter((e: any) => String(e.type).startsWith("permission") && e.data?.sessionID === ses.id).map((e: any) => e.type),
    secretInEvents: tap.events.some((e: any) => e.data?.sessionID === ses.id && JSON.stringify(e).includes("SECRET_CANARY_6dca")),
    freeModel: tap.events.filter((e: any) => e.data?.sessionID === ses.id && JSON.stringify(e).includes("free-limit")).length,
    endError: tap.events.filter((e: any) => e.data?.sessionID === ses.id && e.type === "session.execution.failed").map((e: any) => e.data?.error?.type),
  }
}

const out: any = { root, tool: TOOL, version: (await s.api("GET", "/api/info")).body?.version, setupMs: SETUP_MS, dual: !!firstDir, results: [] }
try {
  out.results.push(await run("control", false))
  out.results.push(await run("reload", true))
  out.slow = readRecords(join(root, "slow.jsonl"))
} catch (e) { out.error = String(e) } finally {
  writeFileSync(join(root, "result.json"), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await s.stop?.(); await mock.stop?.()
  process.exit(0)
}
