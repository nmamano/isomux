// Task 3cc9d863: which flag-gated tools does each config path turn on?
// Per version and case: a fresh profile and repo, one prompt to a mock that
// records the tools the model is offered. Never logs transcript text.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const { makeProfile, makeRepo, mockProviderConfig, startServer, tapEvents, createSession, prompt, turnEnded, writeJson, GATE_ROOT, freePort } = await import(`${H}/common.ts`)

const MARKERS = ["todowrite", "schedule_create", "schedule_list", "artifact_create", "artifact_update", "execute"]
let seen: { tools: string[]; text: string }[] = []
const port = await freePort()
const mockServer = Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "gate-model", object: "model" }] })
    if (u.pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 })
    const body: any = await req.json()
    const tools = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name)
    seen.push({ tools, text: JSON.stringify(body.tools ?? []) + JSON.stringify((body.messages ?? []).filter((m: any) => m.role === "system")) })
    const id = `m-${Date.now()}`
    const chunk = (delta: any, finish: string | null = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "gate-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(chunk({ role: "assistant" }) + chunk({ content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})
const mock = { url: `http://127.0.0.1:${port}/v1` } as any

const CASES: Record<string, { env?: Record<string, string>; project?: unknown; user?: unknown }> = {
  base: {},
  envFlagsAll: { env: { OPENCODE_FLAGS: "all" } },
  projectAllFlags: { project: { experimental: { all_flags: true } } },
  projectNamed: { project: { experimental: { todo: true, schedules: true, artifacts: true } } },
  userDirAllFlags: { user: { experimental: { all_flags: true } } },
  projectAllFlagsProjectConfigOff: { project: { experimental: { all_flags: true } }, env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } },
}
const versions: [string, string][] = [["2.2.5", process.env.GATE_V1_BIN!], ["2.2.7", process.env.GATE_V2_BIN!]]
const root = `${GATE_ROOT}/run/flags-${Date.now()}`
const out: any = { date: new Date().toISOString().slice(0, 10), task: "3cc9d863", script: "harness-2.2.7/flags.ts", markers: MARKERS, results: {} }
for (const [version, bin] of versions) {
  for (const [name, c] of Object.entries(CASES)) {
    if (version === "2.2.5" && name === "envFlagsAll") { out.results[`${version}/${name}`] = "n/a: 2.2.5 has no OPENCODE_FLAGS"; continue }
    const dir = join(root, version, name)
    const p = makeProfile(dir)
    if (c.user) { mkdirSync(join(p.config, "opencode"), { recursive: true }); writeFileSync(join(p.config, "opencode", "opencode.json"), JSON.stringify(c.user)) }
    const repo = makeRepo(join(dir, "repo"))
    if (c.project) writeFileSync(join(repo, "opencode.json"), JSON.stringify(c.project))
    const s = await startServer(p, { bin, config: mockProviderConfig(mock), env: c.env })
    try {
      const tap = await tapEvents(s, join(dir, "events.jsonl"))
      const ses = await createSession(s, repo)
      seen = []
      await prompt(s, ses.id, "hello")
      const end = (await tap.waitFor(turnEnded(ses.id), 60_000).catch(() => ({ type: "timeout" }))).type
      const first = seen.toSorted((a, b) => b.tools.length - a.tools.length)[0]
      if (first) writeFileSync(join(dir, "tools.json"), first.text)
      out.results[`${version}/${name}`] = {
        end, requests: seen.length,
        version: (await s.api("GET", "/api/info")).body?.version,
        offered: first?.tools.sort() ?? null,
        markersInToolDefinitions: first ? MARKERS.filter((m) => first.text.includes(m)) : null,
      }
    } catch (e) { out.results[`${version}/${name}`] = { error: String(e).slice(0, 300) } }
    finally { await s.stop() }
  }
}
writeJson(`${GATE_ROOT}/evidence/flags.json`, out)
console.log(JSON.stringify(out, null, 1))
mockServer.stop(true)
process.exit(0)
