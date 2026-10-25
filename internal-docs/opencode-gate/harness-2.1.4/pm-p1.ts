// pm P1: Isomux's permission config in v2 names, real tool calls per agent and action.
import { mkdirSync, writeFileSync } from "node:fs"
import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, writeJson, GATE_ROOT } from "./common.ts"
import { AGENTS, isomuxV2Config, gateCall, runCall, redact } from "./pm-lib.ts"

const root = `${GATE_ROOT}/run/pm-p1-${Date.now()}`
mkdirSync(root, { recursive: true })
const outside = `${root}/outside`
mkdirSync(outside, { recursive: true })
writeFileSync(`${outside}/secret.txt`, "outside-file\n")
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })

const actions = (mockPort: number): Array<{ key: string; tool: string; args: any; external?: boolean }> => [
  { key: "shell", tool: "shell", args: { command: "printf p1 > p1-shell.txt" } },
  { key: "edit", tool: "edit", args: { path: "README.md", oldString: "gate repo", newString: "gate repo edited" } },
  { key: "write", tool: "write", args: { path: "p1-write.txt", content: "x" } },
  { key: "question", tool: "question", args: { questions: [{ header: "Gate", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }] } },
  { key: "subagent", tool: "subagent", args: { agent: "general", description: "gate sub", prompt: "say hi" } },
  { key: "read", tool: "read", args: { path: "README.md" } },
  { key: "read_env", tool: "read", args: { path: ".env" } },
  { key: "webfetch", tool: "webfetch", args: { url: `http://127.0.0.1:${mockPort}/health`, format: "text" } },
  { key: "glob", tool: "glob", args: { pattern: "*.md" } },
  { key: "grep", tool: "grep", args: { pattern: "gate" } },
  { key: "ext_read", tool: "read", args: { path: `${outside}/secret.txt` }, external: true },
  { key: "ext_write", tool: "write", args: { path: `${outside}/new.txt`, content: "x" }, external: true },
  { key: "ext_shell_workdir", tool: "shell", args: { command: "ls", workdir: outside }, external: true },
  { key: "ext_shell_cd", tool: "shell", args: { command: `cd ${outside} && ls` }, external: true },
  { key: "ext_shell_cat", tool: "shell", args: { command: `cat ${outside}/secret.txt` }, external: true },
]

const expected: Record<string, Record<string, string>> = {}
for (const a of AGENTS)
  expected[a] = {
    shell: "ask", edit: "ask", write: "ask", question: "deny",
    subagent: a === "isomux-cron" ? "deny" : "allow",
    read: "allow", read_env: "ask", webfetch: "allow", glob: "allow", grep: "allow",
    ext_read: "ask", ext_write: "ask", ext_shell_workdir: "ask", ext_shell_cd: "ask", ext_shell_cat: "ask",
  }
const expectedAction: Record<string, string> = { shell: "shell", edit: "edit", write: "edit", read_env: "read" }

function verdict(key: string, exp: string, outcome: string, external?: boolean) {
  if (external) return outcome.split(/[:,]/).includes("external_directory")
  if (exp === "ask") return outcome.startsWith("ask:") && outcome.split(/[:,]/).includes(expectedAction[key] ?? key)
  if (exp === "allow") return outcome === "allow"
  if (exp === "deny") return outcome.startsWith("deny")
  return false
}

const result: any = { date: "2026-10-25", opencode: "2.1.4", item: "P1", method: "", variants: {} }
result.method =
  "Per variant: fresh profile; OPENCODE_CONFIG file = mock provider + Isomux v2 config; OPENCODE_CONFIG_CONTENT = Isomux v2 config (as start-server.ts does). " +
  "GET /api/config and GET /api/agent with x-opencode-directory=<repo>. Then per agent and action: POST /api/session {location, agent}, prompt with GATE_CALL, " +
  "every permission.asked in the session tree answered 'once', outcome from permission.asked / session.tool.success / session.tool.failed."
const passwords: string[] = []
for (const variant of ["literal", "proposed"] as const) {
  const dir = `${root}/${variant}`
  const p = makeProfile(dir)
  const iso = isomuxV2Config(variant)
  const s = await startServer(p, { config: { ...mockProviderConfig(mock), ...iso }, configContent: iso })
  passwords.push(s.password)
  const tap = await tapEvents(s, `${dir}/events.jsonl`)
  const v: any = { config_top_layer: iso, agents_api: {}, calls: {}, mismatches: [] }
  const probeRepo = makeRepo(`${dir}/repo-probe`)
  const cfg = await s.api("GET", "/api/config", undefined, probeRepo)
  v.config_api = { status: cfg.status, documents: Array.isArray(cfg.body) ? cfg.body.map((d: any) => ({ type: d.type, path: d.path ?? null, keys: d.info ? Object.keys(d.info) : undefined, permissions: d.info?.permissions })) : cfg.body }
  const ag = await s.api("GET", "/api/agent", undefined, probeRepo)
  const list = ag.body?.data ?? ag.body
  for (const a of Array.isArray(list) ? list : []) if ([...AGENTS, "general"].includes(a.id)) v.agents_api[a.id] = { mode: a.mode, permissions: a.permissions }
  v.agents_api_status = ag.status
  for (const agent of AGENTS) {
    const repo = makeRepo(`${dir}/repo-${agent}`)
    writeFileSync(`${repo}/.env`, "GATE_ENV_FILE=1\n")
    v.calls[agent] = {}
    for (const a of actions(mock.port)) {
      const ses = await createSession(s, repo, { agent })
      const res = await runCall(s, tap, ses.id, gateCall(a.tool, a.args), { reply: "once" })
      const exp = expected[agent][a.key]
      const ok = verdict(a.key, exp, res.outcome, a.external)
      v.calls[agent][a.key] = { expected: exp, outcome: res.outcome, match: ok, end: res.end, asks: res.asks.map((x) => ({ session: x.session, action: x.action, resources: x.resources, decision: x.decision })), tools: res.tools }
      if (!ok) v.mismatches.push({ agent, action: a.key, expected: exp, outcome: res.outcome })
      console.log(variant, agent, a.key, exp, res.outcome, ok ? "OK" : "MISMATCH", res.end)
    }
  }
  tap.close()
  await s.stop()
  result.variants[variant] = v
}
mock.stop()
const out = redact(result, passwords)
let text = JSON.stringify(out, null, 2).split(root).join("<run>")
writeFileSync(`${GATE_ROOT}/evidence/pm-p1-observed.json`, text + "\n")
console.log("runDir", root)
