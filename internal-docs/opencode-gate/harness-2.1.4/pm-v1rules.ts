// pm: today's (OpenCode 1.18.35) effective per-agent rules for Isomux's DEFAULT_OPENCODE_CONFIG.
import { makeProfile, makeRepo, startServer, writeJson, GATE_ROOT } from "./common.ts"
const root = `${GATE_ROOT}/run/pm-v1rules-${Date.now()}`
const p = makeProfile(root)
const repo = makeRepo(`${root}/repo`)
// Same trick as supervisor.ts markPluginSdkInstalled: v1 skips its plugin SDK npm install.
import { mkdirSync, writeFileSync } from "node:fs"
for (const d of [`${p.config}/opencode`]) {
  mkdirSync(d, { recursive: true })
  const dependencies = { "@opencode-ai/plugin": "1.18.35" }
  writeFileSync(`${d}/package.json`, JSON.stringify({ dependencies }))
  writeFileSync(`${d}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }))
  mkdirSync(`${d}/node_modules`)
}
// Copied from server/backends/opencode/supervisor.ts:42-77 (OPENCODE_SAFETY_TOOL = isomux_safety_active).
const ISOMUX_V1 = {
  autoupdate: false, share: "disabled", default_agent: "build",
  permission: { bash: "ask", edit: "ask", question: "deny", isomux_safety_active: "deny" },
  agent: {
    build: { permission: { bash: "ask", edit: "ask", question: "deny" } },
    "isomux-interactive-bypass": { description: "Isomux interactive non-asking agent", mode: "primary", permission: { bash: "ask", edit: "ask", task: "allow", question: "deny" } },
    "isomux-cron": { description: "Isomux unattended cron run", mode: "primary", permission: { bash: "ask", edit: "ask", task: "deny", question: "deny" } },
  },
}
console.log("starting")
const s = await startServer(p, { v1: true, config: ISOMUX_V1, configContent: ISOMUX_V1, cwd: repo })
console.log("healthy", s.port)
const r = await s.api("GET", "/agent", undefined, repo)
const want = ["build", "isomux-interactive-bypass", "isomux-cron"]
const out: any = { date: "2026-10-25", opencode: "1.18.35", method: "GET /agent on a v1 server with supervisor.ts DEFAULT_OPENCODE_CONFIG in OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT", status: r.status, agents: {} }
for (const a of (Array.isArray(r.body) ? r.body : [])) if (want.includes(a.name)) out.agents[a.name] = a.permission
writeJson(`${GATE_ROOT}/evidence/pm-v1-effective-rules.json`, out)
console.log(JSON.stringify(out).slice(0, 3000))
await s.stop()
