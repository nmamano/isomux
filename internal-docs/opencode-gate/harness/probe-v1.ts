import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gateConfig } from "./config"
import {
  collect,
  evidenceRoot,
  gateRoot,
  isolatedEnvironment,
  makeRepo,
  resetDirectory,
  saveJson,
  scratchRoot,
  waitHealthy,
} from "./common"

const target = join(scratchRoot, "v1")
const repoA = join(target, "repo-a")
const repoB = join(target, "repo-b")
const profile = join(target, "profile")
const password = "GATE_SERVER_PASSWORD_V1_SENTINEL"
const serverUrl = "http://127.0.0.1:41212"
const mockUrl = "http://127.0.0.1:41200/v1"
const binary = join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")

await resetDirectory(target)
await makeRepo(repoA, "CANARY_REPO_A_ONLY")
await makeRepo(repoB, "CANARY_REPO_B_ONLY")
await mkdir(profile, { recursive: true })

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: "41200" },
  stdout: "pipe",
  stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
await Bun.sleep(150)

const configPath = join(profile, "gate-config.json")
await writeFile(configPath, JSON.stringify(gateConfig(mockUrl)))
const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
let server: ReturnType<typeof Bun.spawn>
let serverOut: Promise<string>
let serverErr: Promise<string>
function startServer() {
  server = Bun.spawn(
    [binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "41212", "--print-logs", "--log-level", "DEBUG"],
    { cwd: target, env, stdout: "pipe", stderr: "pipe" },
  )
  serverOut = collect(server.stdout)
  serverErr = collect(server.stderr)
  void server.exited.then(async (code) => {
    if (code !== 0) console.error(`server-exit=${code}\n${await serverErr}`)
  })
}

startServer()
const healthBefore = await waitHealthy(serverUrl, password)
console.log("stage=healthy")
const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
const clientA = createOpencodeClient({ baseUrl: serverUrl, headers, directory: repoA })
const clientB = createOpencodeClient({ baseUrl: serverUrl, headers, directory: repoB })
const eventsA: any[] = []
const eventsB: any[] = []
const permissionResponses: Array<Record<string, unknown>> = []
const denyNext = new Set<string>()
const abortA = new AbortController()
const abortB = new AbortController()

async function capture(client: typeof clientA, events: any[], signal: AbortSignal) {
  const result = await client.event.subscribe({ signal })
  try {
    for await (const event of result.stream) {
      events.push(event)
      if (event.type === "permission.updated" || event.type === "permission.asked") {
        const permission = event.properties
        const response = denyNext.delete(permission.sessionID) ? "reject" : "once"
        permissionResponses.push({ sessionID: permission.sessionID, permissionID: permission.id, response })
        const reply = await fetch(`${serverUrl}/permission/${permission.id}/reply?directory=${encodeURIComponent(permission.sessionID === sessionA?.id ? repoA : repoB)}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ reply: response }),
        })
        if (!reply.ok) throw new Error(`permission reply failed: ${reply.status} ${await reply.text()}`)
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

const captureA = capture(clientA, eventsA, abortA.signal)
const captureB = capture(clientB, eventsB, abortB.signal)
const sessionA = (await clientA.session.create({ body: { title: "gate-a" } })).data!
const sessionB = (await clientB.session.create({ body: { title: "gate-b" } })).data!
console.log("stage=sessions-created")

function prompt(client: typeof clientA, id: string, text: string) {
  return client.session.prompt({
    path: { id },
    body: {
      model: { providerID: "gate", modelID: "gate-model" },
      parts: [{ type: "text", text }],
    },
  })
}

const textResults = await Promise.all([
  prompt(clientA, sessionA.id, "V1_A CANARY_REPO_A_ONLY"),
  prompt(clientB, sessionB.id, "V1_B CANARY_REPO_B_ONLY"),
])
console.log("stage=text-complete")
const toolAllowed = await prompt(clientA, sessionA.id, "GATE_TOOL allow once")
console.log("stage=tool-complete")
const failedToolRecovery = await prompt(clientB, sessionB.id, "GATE_FAIL exercise failed tool and recovery")
console.log("stage=failed-tool-complete")
denyNext.add(sessionB.id)
const toolDenied = await prompt(clientB, sessionB.id, "GATE_TOOL_DENY reject this tool")
console.log("stage=denied-tool-complete")

await clientA.session.promptAsync({
  path: { id: sessionA.id },
  body: {
    model: { providerID: "gate", modelID: "gate-model" },
    parts: [{ type: "text", text: "GATE_ABORT long stream" }],
  },
})
await Bun.sleep(250)
const abortResult = await clientA.session.abort({ path: { id: sessionA.id } })
console.log("stage=abort-complete")
await Bun.sleep(100)

const messagesA = (await clientA.session.messages({ path: { id: sessionA.id } })).data!
const messagesB = (await clientB.session.messages({ path: { id: sessionB.id } })).data!
const getA = (await clientA.session.get({ path: { id: sessionA.id } })).data!
const getB = (await clientB.session.get({ path: { id: sessionB.id } })).data!

server.kill("SIGTERM")
await server.exited
const firstOut = await serverOut
const firstErr = await serverErr
startServer()
const healthAfter = await waitHealthy(serverUrl, password)
console.log("stage=restarted")
const resumedA = (await clientA.session.get({ path: { id: sessionA.id } })).data!
const resumedB = (await clientB.session.get({ path: { id: sessionB.id } })).data!
const resumedMessagesA = (await clientA.session.messages({ path: { id: sessionA.id } })).data!
const resumedMessagesB = (await clientB.session.messages({ path: { id: sessionB.id } })).data!

let fork: unknown
let forkError: unknown
try {
  fork = (await clientA.session.fork({ path: { id: sessionA.id }, body: {} })).data
} catch (error) {
  forkError = String(error)
}
let compaction: unknown
let compactionError: unknown
try {
  compaction = (await clientA.session.summarize({ path: { id: sessionA.id }, body: { providerID: "gate", modelID: "gate-model" } })).data
} catch (error) {
  compactionError = String(error)
}

abortA.abort()
abortB.abort()
await Promise.all([captureA, captureB])
server.kill("SIGTERM")
await server.exited
mock.kill("SIGTERM")
await mock.exited
const secondOut = await serverOut
const secondErr = await serverErr

await mkdir(evidenceRoot, { recursive: true })
await writeFile(join(evidenceRoot, "v1-server.stdout.log"), `${firstOut}${secondOut}`)
await writeFile(join(evidenceRoot, "v1-server.stderr.log"), `${firstErr}${secondErr}`)
await writeFile(join(evidenceRoot, "v1-mock.stdout.log"), await mockOut)
await writeFile(join(evidenceRoot, "v1-mock.stderr.log"), await mockErr)
await writeFile(join(evidenceRoot, "v1-events-a.jsonl"), eventsA.map((event) => JSON.stringify(event)).join("\n") + "\n")
await writeFile(join(evidenceRoot, "v1-events-b.jsonl"), eventsB.map((event) => JSON.stringify(event)).join("\n") + "\n")

const serializedA = JSON.stringify({ messagesA, resumedMessagesA, eventsA })
const serializedB = JSON.stringify({ messagesB, resumedMessagesB, eventsB })
const toolParts = [...messagesA, ...messagesB]
  .flatMap((message: any) => message.parts)
  .filter((part: any) => part.type === "tool")
const callPairing = toolParts.map((part: any) => ({ callID: part.callID, state: part.state?.status, tool: part.tool }))
await saveJson("v1-results.json", {
  date: "2026-08-27",
  healthBefore,
  healthAfter,
  sessionA,
  sessionB,
  textResults: textResults.map((result) => result.data),
  toolAllowed: toolAllowed.data,
  failedToolRecovery: failedToolRecovery.data,
  toolDenied: toolDenied.data,
  abortResult: abortResult.data,
  getA,
  getB,
  resumedA,
  resumedB,
  messagesA,
  messagesB,
  resumedMessagesA,
  resumedMessagesB,
  fork,
  forkError,
  compaction,
  compactionError,
  permissionResponses,
  callPairing,
  isolation: {
    idsDistinct: sessionA.id !== sessionB.id,
    aContainsOwn: serializedA.includes("CANARY_REPO_A_ONLY"),
    aContainsOther: serializedA.includes("CANARY_REPO_B_ONLY"),
    bContainsOwn: serializedB.includes("CANARY_REPO_B_ONLY"),
    bContainsOther: serializedB.includes("CANARY_REPO_A_ONLY"),
    aDirectory: getA.directory,
    bDirectory: getB.directory,
  },
  profileFiles: await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: profile, onlyFiles: true })),
  toolOutputA: await readFile(join(repoA, "gate-output.txt"), "utf8").catch(() => null),
  toolOutputB: await readFile(join(repoB, "gate-output.txt"), "utf8").catch(() => null),
})
