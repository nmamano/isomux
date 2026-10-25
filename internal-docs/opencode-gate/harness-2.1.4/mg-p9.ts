// mg P9: a member config with v1 keys and a v1-shaped plugin in
// OPENCODE_CONFIG_DIR, under 2.1.4. Usage: bun run mg-p9.ts <withConfigDir:1|0>
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, makeRepo, startMock, mockProviderConfig, tapEvents, createSession, prompt, turnEnded, writeJson } from "./common.ts"
import { startServerT as startServer } from "./mg-server.ts"

const withDir = process.argv[2] !== "0"
const R = readFileSync("/tmp/t-4840abc5/run/mg-current.txt", "utf8").trim()
const root = join(R, `p9-${withDir ? "configdir" : "control"}-${Date.now()}`)
const markers = join(root, "markers")
mkdirSync(markers, { recursive: true })
const p = makeProfile(join(root, "profile"))
const repo = makeRepo(join(root, "repo"))
const member = join(root, "member-config")
mkdirSync(join(member, "plugin"), { recursive: true })
const mock = await startMock(join(root, "mock.log"), { MOCK_SHELL_TOOL: "shell" })

const v1Plugin = (name: string) => `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(join(markers, name + ".toplevel"))}, "x")
export const OldPlugin = async ({ client }) => {
  appendFileSync(${JSON.stringify(join(markers, name + ".init"))}, "x")
  return {
    "tool.execute.before": async (input, output) => {
      appendFileSync(${JSON.stringify(join(markers, name + ".hook"))}, String(input && input.tool))
      throw new Error("v1 plugin denies every tool")
    },
  }
}
`
// The configured entry ./old.js and a discovered plugin/ file.
writeFileSync(join(member, "old.js"), v1Plugin("configured"))
writeFileSync(join(member, "plugin", "discovered.js"), v1Plugin("discovered"))
writeFileSync(
  join(member, "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { bash: "allow" },
    plugin: ["./old.js"],
    provider: { memberv1: { name: "Member v1", npm: "@ai-sdk/openai-compatible", options: { baseURL: mock.url, apiKey: "member-fake" }, models: { m1: { name: "m1" } } } },
    mode: { build: { temperature: 0.1 } },
    autoupdate: true,
  }),
)
// The default global dir carries a v2 plugin that only marks its import: with
// OPENCODE_CONFIG_DIR set it must not load (the dir is replaced, not added).
mkdirSync(join(p.config, "opencode", "plugin"), { recursive: true })
writeFileSync(
  join(p.config, "opencode", "plugin", "xdg.js"),
  `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(join(markers, "xdg.toplevel"))}, "x")\nexport default { id: "mg.xdg", setup() { appendFileSync(${JSON.stringify(join(markers, "xdg.setup"))}, "x") } }\n`,
)

const result: Record<string, unknown> = { date: "2026-10-25", item: "P9", binary: "2.1.4", withConfigDir: withDir }
const s = await startServer(p, {
  configContent: mockProviderConfig(mock),
  env: { OPENCODE_CONFIG_DIR: withDir ? member : undefined, OPENCODE_DISABLE_MODELS_FETCH: "1" },
  logPath: join(root, "server.log"),
})
result.started = true
try {
  const tap = await tapEvents(s, join(root, "events.jsonl"))
  const ses = await createSession(s, repo)
  result.sessionCreated = !!ses.id
  // Plugin list for the location, polled until it stops changing.
  let plugins: any[] = []
  let prev = ""
  for (let i = 0; i < 40; i++) {
    const r = await s.api("GET", `/api/plugin?location[directory]=${encodeURIComponent(repo)}`)
    plugins = r.body?.data ?? []
    const sig = JSON.stringify(plugins.map((x: any) => [x.id, x.state?.status]))
    if (sig === prev && i > 3) break
    prev = sig
    await Bun.sleep(250)
  }
  result.pluginsNonBuiltin = plugins
    .filter((x: any) => x.source?.type !== "builtin")
    .map((x: any) => ({ id: x.id ?? null, source: x.source, state: x.state?.status, error: x.state?.error ? String(x.state.error?.message ?? JSON.stringify(x.state.error)).slice(0, 300) : undefined, ref: x.state?.ref }))
  result.pluginCounts = { total: plugins.length, builtin: plugins.filter((x: any) => x.source?.type === "builtin").length, failed: plugins.filter((x: any) => x.state?.status === "failed").length }
  await prompt(s, ses.id, 'run GATE_CALL:{"tool":"shell","args":{"command":"printf ok > p9-out.txt"}}')
  const end = await tap.waitFor(turnEnded(ses.id), 60_000).catch(() => null)
  result.turn = {
    end: end?.type ?? "timeout",
    toolEvents: tap.events.filter((e) => e.data?.sessionID === ses.id && /session\.tool\.(success|failed|called)/.test(e.type)).map((e) => e.type),
    shellFileWritten: existsSync(join(repo, "p9-out.txt")),
  }
  const prov = await s.api("GET", `/api/provider?location[directory]=${encodeURIComponent(repo)}`)
  const provIds = (prov.body?.data ?? []).map((x: any) => x.id)
  result.providers = { httpStatus: prov.status, hasMemberV1: provIds.includes("memberv1"), hasGate: provIds.includes("gate"), count: provIds.length }
  const cfg = await s.api("GET", `/api/config?location[directory]=${encodeURIComponent(repo)}`)
  result.configDocuments = JSON.stringify(cfg.body).length > 0 ? { httpStatus: cfg.status, topKeys: Object.keys(cfg.body?.data ?? cfg.body ?? {}) } : null
  const cfgText = JSON.stringify(cfg.body ?? "")
  result.configMentionsMemberDir = cfgText.includes(member)
  result.configMentionsXdgDir = cfgText.includes(join(p.config, "opencode"))
  tap.close()
} catch (e) {
  result.error = String(e).slice(0, 400)
} finally {
  await s.stop()
  mock.stop()
}
result.markers = Object.fromEntries(readdirSync(markers).map((f) => [f, readFileSync(join(markers, f), "utf8").length]))
result.markerControl = "every marker file the plugins write is listed with its byte count; absent = never written"
const log = readFileSync(join(root, "server.log"), "utf8")
const pick = log.split("\n").filter((l) => /level=(WARN|ERROR)|plugin|unsupported|deprecated|autoupdate|mode/i.test(l))
result.logSummary = {
  lines: log.split("\n").length,
  warn: (log.match(/level=WARN/g) ?? []).length,
  error: (log.match(/level=ERROR/g) ?? []).length,
  info: (log.match(/level=INFO/g) ?? []).length,
  relevantMessages: [...new Set(pick.map((l) => (l.match(/message=("[^"]*"|\S+)/)?.[1] ?? l.slice(0, 80))))],
  relevantLines: pick.slice(0, 30).map((l) => l.replace(/timestamp=\S+ /, "").replace(/run=\S+ /, "").slice(0, 400)),
}
writeJson(join(root, "result.json"), result)
console.log(JSON.stringify(result, null, 1))
console.log("ROOT", root)
