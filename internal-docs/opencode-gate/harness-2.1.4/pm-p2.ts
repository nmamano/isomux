// pm P2: scope of an "always" answer, and the once + session-rule workaround.
import { mkdirSync, writeFileSync } from "node:fs"
import { makeProfile, makeRepo, startMock, mockProviderConfig, startServer, tapEvents, createSession, writeJson, GATE_ROOT, type Server, type EventTap } from "./common.ts"
import { isomuxV2Config, gateCall, runCall, redact } from "./pm-lib.ts"

const root = `${GATE_ROOT}/run/pm-p2-${Date.now()}`
mkdirSync(root, { recursive: true })
const p = makeProfile(`${root}/profile`)
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=gate@example.com", "-c", "user.name=gate", ...args], { cwd }).exitCode
// Distinct root commits, so each repo is its own OpenCode project.
function uniqueRepo(dir: string, tag: string) {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  writeFileSync(`${dir}/README.md`, `gate repo ${tag} ${Date.now()}\n`)
  git(dir, "add", ".")
  git(dir, "commit", "-qm", `init ${tag}`)
  return dir
}
const repo1 = uniqueRepo(`${root}/repo1`, "one")
const repo1clone = `${root}/repo1-clone`
Bun.spawnSync(["git", "clone", "-q", repo1, repo1clone])
const repo2 = uniqueRepo(`${root}/repo2`, "two")
const mock = await startMock(`${root}/mock.log`, { MOCK_SHELL_TOOL: "shell" })
const iso = isomuxV2Config("proposed")
const config = { ...mockProviderConfig(mock), ...iso }
const passwords: string[] = []
const out: any = { date: "2026-10-25", opencode: "2.1.4", item: "P2", steps: [] }
const step = (name: string, data: any) => {
  out.steps.push({ name, ...data })
  console.log(name, JSON.stringify(data).slice(0, 400))
}
const brief = (r: any) => ({ outcome: r.outcome, asks: r.asks.map((a: any) => ({ session: a.session, action: a.action, resources: a.resources, save: a.save, decision: a.decision })), tools: r.tools.map((t: any) => ({ session: t.session, type: t.type, output: t.output, error: t.error })), children: r.children })

let s: Server
let tap: EventTap
async function boot(tag: string) {
  s = await startServer(p, { config, configContent: iso, logPath: `${root}/server-${tag}.log` })
  passwords.push(s.password)
  tap = await tapEvents(s, `${root}/events-${tag}.jsonl`)
}
async function down() {
  tap.close()
  await s.stop()
}
let savedPid = ""
let savedDir = ""
const saved = async () => ({ noQuery: (await s.api("GET", "/api/permission/saved")).body, byProject: (await s.api("GET", `/api/permission/saved?projectID=${savedPid}`, undefined, savedDir)).body })

// Part 1: stock "always".
await boot("1")
const cmd = "printf p2 > p2-always.txt"
const A = await createSession(s, repo1)
const B = await createSession(s, repo1)
const Cl = await createSession(s, repo1clone)
savedPid = A.projectID
savedDir = repo1
step("project ids", { A: A.projectID, B: B.projectID, clone: Cl.projectID, sameProjectForClone: A.projectID === Cl.projectID })
step("A shell, answered always", brief(await runCall(s, tap, A.id, gateCall("shell", { command: cmd }), { reply: "always" })))
step("saved after always", { saved: await saved() })
step("B same command (same repo, other session)", brief(await runCall(s, tap, B.id, gateCall("shell", { command: cmd }), { reply: "reject" })))
step("B other printf command (prefix rule printf *)", brief(await runCall(s, tap, B.id, gateCall("shell", { command: "printf other > p2-other.txt" }), { reply: "reject" })))
step("clone session same command (other directory, same root commit)", brief(await runCall(s, tap, Cl.id, gateCall("shell", { command: cmd }), { reply: "reject" })))
const R2 = await createSession(s, repo2)
step("repo2 session same command (other project) - control that asks are visible", brief(await runCall(s, tap, R2.id, gateCall("shell", { command: cmd }), { reply: "reject" })))
await down()
await boot("2")
const C = await createSession(s, repo1)
step("after restart: saved", { saved: await saved() })
step("after restart: new session C same command", brief(await runCall(s, tap, C.id, gateCall("shell", { command: cmd }), { reply: "reject" })))
// Cleanup path: DELETE the saved rule, then C asks again.
const list = (await saved()).byProject?.data ?? []
for (const item of list) step("DELETE saved", { id: item.id, status: (await s.api("DELETE", `/api/permission/saved/${item.id}`)).status })
step("after DELETE: saved", { saved: await saved() })
step("after DELETE: C same command", brief(await runCall(s, tap, C.id, gateCall("shell", { command: cmd }), { reply: "reject" })))

// Part 2: workaround in repo2: once + PATCH session permissions.
const base = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "ask" },
]
const cmd2 = "printf w > p2-work.txt"
const A2 = await createSession(s, repo2, { permissions: base })
savedPid = A2.projectID
savedDir = repo2
const B2 = await createSession(s, repo2, { permissions: base })
// A child created BEFORE the patch.
const pre = await runCall(s, tap, A2.id, gateCall("subagent", { agent: "general", description: "pre child", prompt: "say hi" }))
step("A2 subagent before PATCH (child C1)", brief(pre))
const c1 = pre.children[0]
step("A2 shell, answered once", brief(await runCall(s, tap, A2.id, gateCall("shell", { command: cmd2 }), { reply: "once" })))
const patched = [...base, { action: "shell", resource: cmd2, effect: "allow" }]
const pr = await s.api("PATCH", `/api/session/${A2.id}`, { permissions: patched })
step("PATCH A2 permissions", { status: pr.status, sessionPermissionsEvent: tap.events.filter((e) => e.type === "session.permissions" && e.data?.sessionID === A2.id).length })
step("GET A2 after PATCH", { permissions: (await s.api("GET", `/api/session/${A2.id}`)).body?.data?.permissions })
step("A2 same command after PATCH", brief(await runCall(s, tap, A2.id, gateCall("shell", { command: cmd2 }), { reply: "reject" })))
step("B2 same command", brief(await runCall(s, tap, B2.id, gateCall("shell", { command: cmd2 }), { reply: "reject" })))
step("saved after workaround (repo2)", { saved: await saved() })
const childPrompt = `GATE_CALL:${JSON.stringify({ tool: "shell", args: { command: cmd2 } })}`
const post = await runCall(s, tap, A2.id, gateCall("subagent", { agent: "general", description: "post child", prompt: childPrompt }), { reply: "reject" })
step("A2 new subagent after PATCH runs the command (child C2)", brief(post))
const c2 = post.children[0]
if (c1) {
  const cont = await runCall(s, tap, A2.id, gateCall("subagent", { agent: "general", description: "pre child again", prompt: childPrompt, sessionID: c1 }), { reply: "reject" })
  step("A2 continues pre-PATCH child C1 with the command", brief(cont))
}
step("child permissions", {
  C1: c1 ? (await s.api("GET", `/api/session/${c1}`)).body?.data?.permissions : null,
  C2: c2 ? (await s.api("GET", `/api/session/${c2}`)).body?.data?.permissions : null,
})
await down()
await boot("3")
step("after restart 2: GET A2", { permissions: (await s.api("GET", `/api/session/${A2.id}`)).body?.data?.permissions })
step("after restart 2: A2 same command", brief(await runCall(s, tap, A2.id, gateCall("shell", { command: cmd2 }), { reply: "reject" })))
step("after restart 2: B2 same command", brief(await runCall(s, tap, B2.id, gateCall("shell", { command: cmd2 }), { reply: "reject" })))
step("after restart 2: saved", { saved: await saved() })
await down()
mock.stop()
const text = JSON.stringify(redact(out, passwords), null, 2).split(root).join("<run>")
writeFileSync(`${GATE_ROOT}/evidence/pm-p2-always-scope.json`, text + "\n")
console.log("runDir", root)
