// P5: project code that 2.1.4 loads or runs when a session opens in a repo,
// with and without OPENCODE_DISABLE_PROJECT_CONFIG=1; npm plugin install
// location and first-turn time (local registry). 2026-10-25.
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash } from "node:crypto"
import {
  makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded,
  writeJson, GATE_ROOT,
} from "./common.ts"
import { writeSafetyPlugin, locQuery, gateCall, toolOutcomes, summarizePlugins, pluginList } from "./sp-lib.ts"

const root = `${GATE_ROOT}/run/sp-p5-${Date.now()}`
mkdirSync(root, { recursive: true })
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
// A logging proxy in front of the mock: records which project texts reach the model request.
const modelSeen: Array<{ agentsMd: boolean; claudeMd: boolean; nested: boolean; skills: string[] }> = []
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const body = req.method === "POST" ? await req.text() : undefined
    if (body && u.pathname.endsWith("/chat/completions"))
      modelSeen.push({
        agentsMd: body.includes("P5_AGENTS_MD_MARKER"),
        claudeMd: body.includes("P5_CLAUDE_MD_MARKER"),
        nested: body.includes("P5_NESTED_AGENTS_MARKER"),
        skills: ["p5-claude-skill", "p5-opencode-skill", "p5-agents-skill"].filter((n) => body.includes(n)),
      })
    return fetch(`http://127.0.0.1:${mock.port}${u.pathname}`, { method: req.method, headers: req.headers, body })
  },
})
const viaProxy = { ...mock, url: `http://127.0.0.1:${proxy.port}/v1` }

// ---- local npm registry with one real v2 plugin package ----
const regLog: string[] = []
const pkgDir = join(root, "npm-src")
mkdirSync(join(pkgDir, "package"), { recursive: true })
function buildTarball(markDir: string) {
  writeFileSync(join(pkgDir, "package/package.json"), JSON.stringify({ name: "p5-npm-plugin", version: "1.0.0", type: "module", main: "index.js" }))
  writeFileSync(
    join(pkgDir, "package/index.js"),
    `import { appendFileSync } from "node:fs"
appendFileSync(process.env.P5_NPM_MARK ?? ${JSON.stringify(join(markDir, "npm-plugin-import"))}, "imported\\n")
export default { id: "p5-npm-plugin", setup() {} }
`,
  )
  Bun.spawnSync(["tar", "czf", join(pkgDir, "pkg.tgz"), "-C", pkgDir, "package"])
  const buf = readFileSync(join(pkgDir, "pkg.tgz"))
  return {
    buf,
    shasum: createHash("sha1").update(buf).digest("hex"),
    integrity: "sha512-" + createHash("sha512").update(buf).digest("base64"),
  }
}
let tarball = buildTarball(join(root, "markers-npm"))
const registry = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const u = new URL(req.url)
    regLog.push(`${req.method} ${u.pathname}`)
    if (u.pathname === "/p5-npm-plugin")
      return Response.json({
        name: "p5-npm-plugin",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "p5-npm-plugin",
            version: "1.0.0",
            type: "module",
            main: "index.js",
            dist: { tarball: `http://127.0.0.1:${registry.port}/p5-npm-plugin/-/p5-npm-plugin-1.0.0.tgz`, shasum: tarball.shasum, integrity: tarball.integrity },
          },
        },
      })
    if (u.pathname.endsWith(".tgz")) return new Response(tarball.buf)
    return new Response("not found", { status: 404 })
  },
})

function tree(dir: string, max = 60): string[] {
  if (!existsSync(dir)) return ["<absent>"]
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (out.length >= max || depth > 4) return
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n)
      out.push(relative(dir, full) + (statSync(full).isDirectory() ? "/" : ""))
      if (statSync(full).isDirectory()) walk(full, depth + 1)
    }
  }
  walk(dir, 0)
  return out
}

function buildProjectRepo(dir: string, mark: string) {
  makeRepo(dir)
  mkdirSync(mark, { recursive: true })
  const w = (rel: string, text: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  w(
    ".opencode/plugins/p.js",
    `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(join(mark, "plugin-import"))}, "imported\\n")
export default { id: "p5-project-plugin", setup() { appendFileSync(${JSON.stringify(join(mark, "plugin-setup"))}, "setup\\n") } }
`,
  )
  w(
    "opencode.json",
    JSON.stringify({
      mcp: { servers: { p5probe: { type: "local", command: ["/bin/sh", "-c", `echo spawned >> ${join(mark, "mcp-spawned")}; exec sleep 20`] } } },
      formatter: { p5fmt: { command: ["/bin/sh", "-c", `echo "$0" >> ${join(mark, "formatter-ran")}`, "$FILE"], extensions: [".txt"] } },
      agents: { "p5-json-agent": { description: "agent from project opencode.json", mode: "subagent" } },
    }),
  )
  w(".claude/skills/p5-claude-skill/SKILL.md", "---\nname: p5-claude-skill\ndescription: skill from .claude/skills\n---\nP5 claude skill body\n")
  w(".opencode/skills/p5-opencode-skill/SKILL.md", "---\nname: p5-opencode-skill\ndescription: skill from .opencode/skills\n---\nP5 opencode skill body\n")
  w(".agents/skills/p5-agents-skill/SKILL.md", "---\nname: p5-agents-skill\ndescription: skill from .agents/skills\n---\nP5 agents skill body\n")
  w("AGENTS.md", "P5_AGENTS_MD_MARKER project instructions\n")
  w("CLAUDE.md", "P5_CLAUDE_MD_MARKER project instructions\n")
  w(".opencode/agents/p5-md-agent.md", "---\ndescription: agent from .opencode/agents\nmode: subagent\n---\nYou are the p5 md agent.\n")
  w(".opencode/commands/p5-command.md", "---\ndescription: command from .opencode/commands\n---\nRun the p5 command.\n")
  w("file.txt", "original\n")
  w("sub/AGENTS.md", "P5_NESTED_AGENTS_MARKER nested instructions\n")
  w("sub/x.txt", "nested file\n")
}

function buildNpmRepo(dir: string) {
  makeRepo(dir)
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode/opencode.json"), JSON.stringify({ plugins: ["p5-npm-plugin@1.0.0"] }))
}

const markers = (mark: string) =>
  Object.fromEntries(
    ["plugin-import", "plugin-setup", "mcp-spawned", "formatter-ran", "npm-plugin-import"].map((m) => [
      m,
      existsSync(join(mark, m)) ? readFileSync(join(mark, m), "utf8").trim().split("\n").length : 0,
    ]),
  )

const out: any = { date: "2026-10-25", probe: "sp-p5", runDir: root, runs: {} }

for (const mode of ["default", "disableProjectConfig"] as const) {
  const p = makeProfile(join(root, mode))
  writeFileSync(join(p.home, ".npmrc"), `registry=http://127.0.0.1:${registry.port}/\n`)
  const isoRec = join(p.dir, "iso.jsonl")
  const pluginDir = writeSafetyPlugin(join(p.dir, "isomux-safety"), isoRec)
  const mark = join(p.dir, "markers")
  const npmMark = join(p.dir, "markers-npm")
  mkdirSync(npmMark, { recursive: true })
  const repo = join(p.dir, "repo")
  buildProjectRepo(repo, mark)
  const npmRepo = join(p.dir, "npmrepo")
  buildNpmRepo(npmRepo)
  const env: Record<string, string> = {
    npm_config_registry: `http://127.0.0.1:${registry.port}/`,
    P5_NPM_MARK: join(npmMark, "npm-plugin-import"),
  }
  if (mode === "disableProjectConfig") env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  const memberConfig = join(p.config, "opencode")
  const before = { memberConfig: tree(memberConfig), cache: tree(p.cache), npmRepoDotOpencode: tree(join(npmRepo, ".opencode")) }
  const regBefore = regLog.length
  const s = await startServer(p, { config: mockProviderConfig(viaProxy), configContent: { plugins: [pluginDir] }, env })
  const tap = await tapEvents(s, join(p.dir, "events.jsonl"))
  const r: any = { env: Object.keys(env).filter((k) => k.startsWith("OPENCODE")) }
  try {
    // project repo: open a session, settle, list, one edit turn
    const t0 = performance.now()
    const seenBefore = modelSeen.length
    const ses = await createSession(s, repo)
    r.settle = (await s.api("GET", `/api/model?${locQuery(repo)}`)).status
    r.markersAfterOpen = markers(mark)
    await prompt(s, ses.id, `edit ${gateCall("edit", { path: join(repo, "file.txt"), oldString: "original", newString: "changed" })}`)
    r.turnEnd = (await tap.waitFor(turnEnded(ses.id), 60_000).catch(() => ({ type: "timeout" }))).type
    r.firstTurnMs = Math.round(performance.now() - t0)
    r.tools = toolOutcomes(tap, ses.id).map((t) => t.type.split(".").pop())
    await Bun.sleep(1500)
    r.markersAfterTurn = markers(mark)
    const names = (b: any) => (b?.data ?? []).map((x: any) => x.id ?? x.name)
    r.skills = names((await s.api("GET", `/api/skill?${locQuery(repo)}`)).body).filter((n: string) => n?.startsWith("p5"))
    r.agents = names((await s.api("GET", `/api/agent?${locQuery(repo)}`)).body).filter((n: string) => n?.startsWith("p5"))
    r.commands = names((await s.api("GET", `/api/command?${locQuery(repo)}`)).body).filter((n: string) => n?.startsWith("p5"))
    const mcp = await s.api("GET", `/api/mcp?${locQuery(repo)}`)
    r.mcp = (mcp.body?.data ?? []).map((m: any) => ({ name: m.name ?? m.id, status: m.status?.status ?? m.status }))
    r.mcpRaw = JSON.stringify(mcp.body?.data ?? mcp.body).slice(0, 400)
    r.plugins = summarizePlugins((await pluginList(s, repo)).body).rows.map((x: any) => ({ id: x.id, status: x.state.status, path: x.source?.path?.replace(p.dir, "<profile>") }))
    const instr = await s.api("GET", `/api/experimental/session/${ses.id}/instructions/entries`)
    const instrText = JSON.stringify(instr.body)
    r.instructions = { status: instr.status, agentsMd: instrText.includes("P5_AGENTS_MD_MARKER"), claudeMd: instrText.includes("P5_CLAUDE_MD_MARKER") }
    const evText = readFileSync(join(p.dir, "events.jsonl"), "utf8")
    r.eventsMention = { agentsMd: evText.includes("P5_AGENTS_MD_MARKER") || evText.includes(join(repo, "AGENTS.md")), claudeMd: evText.includes("P5_CLAUDE_MD_MARKER") }
    r.modelRequestsForRepo = modelSeen.slice(seenBefore)
    r.instructionKeys = Object.fromEntries(
      readFileSync(join(p.dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.includes("session.instructions.updated")).map((l) => JSON.parse(l)).map((e) => [e.location.directory === repo ? "repo" : "other", Object.keys(e.data.delta).sort()]),
    )
    const seenNested = modelSeen.length
    await prompt(s, ses.id, `read ${gateCall("read", { path: join(repo, "sub/x.txt") })}`)
    r.readTurnEnd = (await tap.waitFor((e) => e.type === "session.execution.succeeded" && e.data?.sessionID === ses.id && e.__receivedAt > Date.now() - 100000 && tap.events.filter((x) => x.type === "session.execution.succeeded" && x.data?.sessionID === ses.id).length >= 2, 60_000).catch(() => ({ type: "timeout" }))).type
    r.nestedAgentsMdReachedModel = modelSeen.slice(seenNested).some((x) => x.nested)
    r.readTools = toolOutcomes(tap, ses.id).map((t) => t.type.split(".").pop())
    r.fileAfterEdit = readFileSync(join(repo, "file.txt"), "utf8").trim()

    // npm plugin repo: time the first turn, see where the package lands
    const n0 = performance.now()
    const nses = await createSession(s, npmRepo)
    const nset = await s.api("GET", `/api/model?${locQuery(npmRepo)}`)
    const settledMs = Math.round(performance.now() - n0)
    await prompt(s, nses.id, `npm ${gateCall("shell", { command: "printf ok > npm-turn.txt" })}`)
    const nend = (await tap.waitFor(turnEnded(nses.id), 120_000).catch(() => ({ type: "timeout" }))).type
    r.npm = {
      settleStatus: nset.status,
      settleMs: settledMs,
      firstTurnMs: Math.round(performance.now() - n0),
      turnEnd: nend,
      registryRequests: regLog.slice(regBefore),
      plugins: summarizePlugins((await pluginList(s, npmRepo)).body).rows.map((x: any) => ({ id: x.id, status: x.state.status, source: x.source?.type })),
      npmPluginImported: existsSync(join(npmMark, "npm-plugin-import")),
    }
  } finally {
    tap.close()
    await s.stop()
  }
  await Bun.sleep(500)
  r.after = { memberConfig: tree(memberConfig), cache: tree(p.cache).filter((x) => x.includes("npm") || x.includes("p5")), npmRepoDotOpencode: tree(join(npmRepo, ".opencode")), repoDotOpencode: tree(join(repo, ".opencode")) }
  r.before = before
  out.runs[mode] = r
}
registry.stop(true)
proxy.stop(true)
mock.stop()
writeJson(`${GATE_ROOT}/evidence/sp-p5-project-code.json`, out)
console.log("done", root)
