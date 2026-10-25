// P3 fail-closed: failed plugin loads are fail-open; the check Isomux can do;
// the activation race in 20 fresh folders; other per-folder signals. 2026-10-25.
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded,
  writeJson, GATE_ROOT,
} from "./common.ts"
import { writeSafetyPlugin, readRecords, pluginList, summarizePlugins, awaitIsomuxActive, toolOutcomes, gateCall, ISOMUX_ID, locQuery } from "./sp-lib.ts"

const root = `${GATE_ROOT}/run/sp-p3f-${Date.now()}`
mkdirSync(root, { recursive: true })
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const out: any = { date: "2026-10-25", probe: "sp-p3-failclosed", runDir: root, failOpen: {}, race: {} }

// ---------- Part 1: broken plugins (server F) ----------
{
  const p = makeProfile(join(root, "F"))
  const rec = join(p.dir, "records.jsonl")
  const badSetup = join(p.dir, "bad-setup")
  mkdirSync(badSetup, { recursive: true })
  writeFileSync(join(badSetup, "index.js"), `export default { id: "${ISOMUX_ID}", setup() { throw new Error("SETUP_THROWS_PROBE") } }\n`)
  const badSyntax = join(p.dir, "bad-syntax")
  mkdirSync(badSyntax, { recursive: true })
  writeFileSync(join(badSyntax, "index.js"), `export default { id: "isomux-syntax", setup( { ) }\n`)
  const v1Shape = join(p.dir, "v1-shape")
  mkdirSync(v1Shape, { recursive: true })
  writeFileSync(join(v1Shape, "index.js"), `export default { id: "isomux-v1", server: async () => ({ "tool.execute.before": async () => { throw new Error("x") } }) }\n`)
  const missingDir = join(p.dir, "does-not-exist")
  const fileEntry = writeSafetyPlugin(join(p.dir, "as-file"), rec, "isomux-as-file")
  const plugins = [badSetup, badSyntax, v1Shape, missingDir, join(fileEntry, "index.js")]
  const s = await startServer(p, { config: mockProviderConfig(mock), configContent: { plugins } })
  const tap = await tapEvents(s, join(p.dir, "events.jsonl"))
  try {
    const repo = makeRepo(join(p.dir, "repo"))
    const ses = await createSession(s, repo)
    const settle = await s.api("GET", `/api/model?${locQuery(repo)}`)
    const list = summarizePlugins((await pluginList(s, repo)).body)
    const checks: any = {}
    for (const [name, dir] of [["badSetup", badSetup], ["badSyntax", badSyntax], ["v1Shape", v1Shape], ["missingDir", missingDir], ["fileEntry", fileEntry]] as const) {
      const c = await awaitIsomuxActive(s, repo, dir, 3000)
      checks[name] = { verdict: c.verdict, ms: c.ms }
    }
    await prompt(s, ses.id, `failopen ${gateCall("shell", { command: "echo GATE_DENY_ME > failopen-side.txt" })}`)
    const end = await tap.waitFor(turnEnded(ses.id), 30_000).catch(() => ({ type: "timeout" }))
    const logText = await Bun.file(s.logPath).text()
    out.failOpen = {
      configuredPlugins: plugins.map((x) => x.replace(p.dir, "<profile>")),
      settleStatus: settle.status,
      pluginList: list,
      isomuxCheckVerdicts: checks,
      promptEnd: end.type,
      tools: toolOutcomes(tap, ses.id).map((t) => t.type),
      unguardedSideFileExists: existsSync(join(repo, "failopen-side.txt")),
      logLines: {
        failedToLoad: (logText.match(/failed to load plugin/g) ?? []).length,
        pathMustBeDirectory: (logText.match(/configured plugin path must be a directory/g) ?? []).length,
      },
    }
  } finally {
    tap.close()
    await s.stop()
  }
}

// ---------- Part 2: race in fresh folders (server G, good plugin) ----------
{
  const p = makeProfile(join(root, "G"))
  const rec = join(p.dir, "records.jsonl")
  const pluginDir = writeSafetyPlugin(join(p.dir, "isomux-safety"), rec)
  const entry = join(pluginDir, "index.js")
  const s = await startServer(p, { config: mockProviderConfig(mock), configContent: { plugins: [pluginDir] } })
  const tap = await tapEvents(s, join(p.dir, "events.jsonl"))
  try {
    out.race.locationGetShape = Object.keys((await s.api("GET", `/api/location?${locQuery(p.dir)}`)).body?.data ?? {})
    // A: create session, then poll GET /api/plugin until the Isomux row is active.
    const A: any[] = []
    for (let i = 0; i < 20; i++) {
      const repo = makeRepo(join(p.dir, `freshA-${i}`))
      const t0 = performance.now()
      const t0wall = Date.now()
      const ses = await createSession(s, repo)
      const createMs = performance.now() - t0
      let polls = 0, empty = 0, nonEmptyWithout = 0, failed = 0
      let activeMs = -1
      const shapes: string[] = []
      while (performance.now() - t0 < 10_000) {
        polls++
        const list: any[] = (await pluginList(s, repo)).body?.data ?? []
        const own = list.find((x) => x.source?.type === "local" && x.source.path === entry)
        const shape = list.length === 0 ? "empty" : !own ? `nonEmptyWithout(${list.length})` : own.state.status
        if (shapes[shapes.length - 1] !== shape) shapes.push(shape)
        if (list.length === 0) empty++
        else if (!own) nonEmptyWithout++
        else if (own.state.status === "failed") failed++
        else { activeMs = performance.now() - t0; break }
        await Bun.sleep(2)
      }
      await Bun.sleep(150)
      const updated = tap.events
        .filter((e) => e.type === "plugin.updated" && e.location?.directory === repo)
        .map((e) => e.__receivedAt - t0wall)
      A.push({ i, createMs: Math.round(createMs), activeMs: Math.round(activeMs), polls, empty, nonEmptyWithout, failed, shapes, pluginUpdatedAtMs: updated, sessionID: ses.id })
    }
    // B: GET /api/model right after create (it awaits plugin activation, 5 s cap), then one GET /api/plugin.
    const B: any[] = []
    for (let i = 0; i < 20; i++) {
      const repo = makeRepo(join(p.dir, `freshB-${i}`))
      const t0 = performance.now()
      await createSession(s, repo)
      const m = await s.api("GET", `/api/model?${locQuery(repo)}`)
      const modelMs = performance.now() - t0
      const list: any[] = (await pluginList(s, repo)).body?.data ?? []
      const own = list.find((x) => x.source?.type === "local" && x.source.path === entry)
      B.push({ i, modelStatus: m.status, modelMs: Math.round(modelMs), listLen: list.length, isomux: own?.state?.status ?? "missing" })
    }
    // B2: GET /api/model as the very first request to a fresh folder (no session yet).
    const B2: any[] = []
    for (let i = 0; i < 5; i++) {
      const repo = makeRepo(join(p.dir, `freshB2-${i}`))
      const m = await s.api("GET", `/api/model?${locQuery(repo)}`)
      const list: any[] = (await pluginList(s, repo)).body?.data ?? []
      const own = list.find((x) => x.source?.type === "local" && x.source.path === entry)
      B2.push({ i, modelStatus: m.status, isomux: own?.state?.status ?? "missing" })
    }
    // C: prompt GATE_DENY_ME at once after create, with no check (does the prompt wait for activation?).
    const C: any[] = []
    for (let i = 0; i < 8; i++) {
      const repo = makeRepo(join(p.dir, `freshC-${i}`))
      const ses = await createSession(s, repo)
      await prompt(s, ses.id, `race ${gateCall("shell", { command: "echo GATE_DENY_ME > race-side.txt" })}`)
      const end = await tap.waitFor(turnEnded(ses.id), 30_000).catch(() => ({ type: "timeout" }))
      C.push({ i, end: end.type, tools: toolOutcomes(tap, ses.id).map((t) => t.type.split(".").pop()), sideFileExists: existsSync(join(repo, "race-side.txt")) })
    }
    // D: does POST /api/location/reload emit plugin.updated per folder?
    const before = tap.events.length
    const reload = await s.api("POST", `/api/location/reload?${locQuery(join(p.dir, "freshA-0"))}`)
    await Bun.sleep(1500)
    const after = tap.events.slice(before).filter((e) => e.type === "plugin.updated").map((e) => e.location?.directory?.replace(p.dir, "<profile>"))
    out.race.reload = { status: reload.status, pluginUpdatedLocations: after }
    const counts = {
      runs: A.length,
      everEmptyBeforeActive: A.filter((r) => r.empty > 0).length,
      everNonEmptyWithoutIsomux: A.filter((r) => r.nonEmptyWithout > 0).length,
      everFailed: A.filter((r) => r.failed > 0).length,
      neverActive: A.filter((r) => r.activeMs < 0).length,
      activeMs: { min: Math.min(...A.map((r) => r.activeMs)), max: Math.max(...A.map((r) => r.activeMs)), median: A.map((r) => r.activeMs).sort((a, b) => a - b)[10] },
      firstPluginUpdatedBeforeOrAtActive: A.filter((r) => r.pluginUpdatedAtMs.length && r.pluginUpdatedAtMs[0] <= r.activeMs + 5).length,
      pluginUpdatedPerFolder: A.map((r) => r.pluginUpdatedAtMs.length),
    }
    out.race.A_pollAfterCreate = { counts, runs: A }
    out.race.B_modelBarrier = {
      counts: { runs: B.length, status200: B.filter((r) => r.modelStatus === 200).length, isomuxActiveRightAfter: B.filter((r) => r.isomux === "active").length },
      runs: B,
    }
    out.race.B2_modelFirstRequest = B2
    out.race.C_promptWithoutCheck = {
      counts: { runs: C.length, denied: C.filter((r) => r.tools.includes("failed") && !r.sideFileExists).length, ran: C.filter((r) => r.sideFileExists).length },
      runs: C,
    }
  } finally {
    tap.close()
    await s.stop()
  }
}
mock.stop()
writeJson(`${GATE_ROOT}/evidence/sp-p3-failclosed-race.json`, out)
console.log("done", root)
