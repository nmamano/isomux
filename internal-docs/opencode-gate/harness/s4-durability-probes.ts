import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gateConfig } from "./config"
import { collect, isolatedEnvironment, makeRepo, resetDirectory, saveJson, scratchRoot, waitHealthy } from "./common"
import { resolveOpenCodeBinary } from "../../../server/backends/opencode/runtime"

const target = join(scratchRoot, "s4-durability-probes")
const repoA = join(target, "repo-a")
const repoB = join(target, "repo-b")
const profile = join(target, "profile")
const password = "S4_DURABILITY_PROBE_PASSWORD"
const mockUrl = "http://127.0.0.1:41820/v1"
const serverUrl = "http://127.0.0.1:41821"
const binary = resolveOpenCodeBinary()

await resetDirectory(target)
await makeRepo(repoA, "S4_REPO_A")
await makeRepo(repoB, "S4_REPO_B")
await mkdir(profile, { recursive: true })
const configPath = join(profile, "opencode.json")
await writeFile(configPath, JSON.stringify({ ...gateConfig(mockUrl), permission: { bash: "allow", edit: "allow", question: "deny" } }), { mode: 0o600 })

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: "41820" }, stdout: "pipe", stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
for (let attempt = 0; attempt < 200; attempt++) {
  try { if ((await fetch("http://127.0.0.1:41820/health")).ok) break } catch {}
  await Bun.sleep(25)
}

const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
const server = Bun.spawn([binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "41821"], {
  cwd: target, env, stdout: "pipe", stderr: "pipe",
})
const serverOut = collect(server.stdout)
const serverErr = collect(server.stderr)

try {
  await waitHealthy(serverUrl, password)
  const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
  const clientA = createOpencodeClient({ baseUrl: serverUrl, headers, directory: repoA })
  const clientB = createOpencodeClient({ baseUrl: serverUrl, headers, directory: repoB })
  const parent = (await clientA.session.create({ body: { title: "s4-parent" } })).data!
  const prompt = (client: typeof clientA, id: string, text: string) => client.session.prompt({
    path: { id },
    body: { model: { providerID: "gate", modelID: "gate-model" }, parts: [{ type: "text", text }] },
  })
  await prompt(clientA, parent.id, "TURN_ONE S4_CONTEXT_CANARY")
  await prompt(clientA, parent.id, "TURN_TWO SHOULD_BE_REMOVED")
  await prompt(clientA, parent.id, "TURN_THREE SHOULD_BE_REMOVED")
  const parentBefore = (await clientA.session.messages({ path: { id: parent.id } })).data!
  const users = parentBefore.filter((message: any) => message.info?.role === "user")
  if (!users[0]?.info?.id || !users[1]?.info?.id) throw new Error("S4 fork probe did not find two user messages")
  const child = (await clientA.session.fork({ path: { id: parent.id }, body: { messageID: users[1].info.id } })).data!
  const childAfterFork = (await clientA.session.messages({ path: { id: child.id } })).data!
  const parentAfterFork = (await clientA.session.messages({ path: { id: parent.id } })).data!
  await prompt(clientA, child.id, "CHILD_FIRST GATE_RECALL")
  const childAfterPrompt = (await clientA.session.messages({ path: { id: child.id } })).data!
  const parentAfterChildPrompt = (await clientA.session.messages({ path: { id: parent.id } })).data!
  await Promise.all([
    prompt(clientA, parent.id, "PARENT_PARALLEL_ONLY"),
    prompt(clientA, child.id, "CHILD_PARALLEL_ONLY"),
  ])
  const parentAfterParallel = (await clientA.session.messages({ path: { id: parent.id } })).data!
  const childAfterParallel = (await clientA.session.messages({ path: { id: child.id } })).data!

  const emptyFork = (await clientA.session.fork({ path: { id: parent.id }, body: { messageID: users[0].info.id } })).data!
  const emptyForkMessages = (await clientA.session.messages({ path: { id: emptyFork.id } })).data!

  await prompt(clientB, parent.id, "GATE_CWD RETARGET_TO_REPO_B")
  const cwdA = await readFile(join(repoA, "s4-cwd-observed.txt"), "utf8").catch(() => null)
  const cwdB = await readFile(join(repoB, "s4-cwd-observed.txt"), "utf8").catch(() => null)
  const parentAfterCwd = (await clientB.session.messages({ path: { id: parent.id } })).data!

  const summarize = (messages: any[]) => messages.map((message) => ({
    id: message.info?.id,
    role: message.info?.role,
    text: (message.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join(""),
  }))
  await saveJson("s4-durability-probe-results.json", {
    date: "2026-08-28",
    version: "1.18.23",
    fork: {
      parentID: parent.id,
      boundaryMessageID: users[1].info.id,
      childID: child.id,
      parentBefore: summarize(parentBefore),
      parentAfterFork: summarize(parentAfterFork),
      parentAfterChildPrompt: summarize(parentAfterChildPrompt),
      childAfterFork: summarize(childAfterFork),
      childAfterPrompt: summarize(childAfterPrompt),
      parentAfterParallel: summarize(parentAfterParallel),
      childAfterParallel: summarize(childAfterParallel),
      emptyForkMessageCount: emptyForkMessages.length,
    },
    cwd: { repoA, repoB, cwdA, cwdB, parentAfterCwd: summarize(parentAfterCwd) },
  })
} finally {
  server.kill("SIGTERM")
  await server.exited
  mock.kill("SIGTERM")
  await mock.exited
  await Promise.all([serverOut, serverErr, mockOut, mockErr])
}
