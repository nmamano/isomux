import { OpenCode } from "@opencode-ai/client"
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

const target = join(scratchRoot, "v2")
const repoA = join(target, "repo-a")
const repoB = join(target, "repo-b")
const profile = join(target, "profile")
const password = "GATE_SERVER_PASSWORD_V2_SENTINEL"
const serverUrl = "http://127.0.0.1:41211"
const mockUrl = "http://127.0.0.1:41200/v1"
const binary = join(gateRoot, "node_modules/opencode-v2/bin/opencode.exe")

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

const env = isolatedEnvironment(profile, gateConfig(mockUrl), password)
let server: ReturnType<typeof Bun.spawn>
let serverOut: Promise<string>
let serverErr: Promise<string>

function startServer() {
  server = Bun.spawn(
    [binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "41211", "--print-logs", "--log-level", "DEBUG"],
    { cwd: target, env, stdout: "pipe", stderr: "pipe" },
  )
  serverOut = collect(server.stdout)
  serverErr = collect(server.stderr)
}

startServer()
const healthBefore = await waitHealthy(serverUrl, password)
const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
const client = OpenCode.make({ baseUrl: serverUrl, headers })
const events: unknown[] = []
const eventAbort = new AbortController()
const eventTask = (async () => {
  try {
    for await (const event of client.event.subscribe({ signal: eventAbort.signal })) events.push(event)
  } catch (error) {
    if (!eventAbort.signal.aborted) throw error
  }
})()

const providerWithoutRealCredential = await client.provider.list()
const sessionA = await client.session.create({
  title: "gate-a",
  model: { providerID: "gate", id: "gate-model" },
  location: { directory: repoA },
})
const sessionB = await client.session.create({
  title: "gate-b",
  model: { providerID: "gate", id: "gate-model" },
  location: { directory: repoB },
})

let prompts: unknown
let promptError: unknown
try {
  prompts = await Promise.all([
    client.session.prompt({ sessionID: sessionA.id, text: "V2_A CANARY_REPO_A_ONLY" }),
    client.session.prompt({ sessionID: sessionB.id, text: "V2_B CANARY_REPO_B_ONLY" }),
  ])
  await Promise.all([client.session.wait({ sessionID: sessionA.id }), client.session.wait({ sessionID: sessionB.id })])
} catch (error) {
  promptError = error
}
const messagesA = await client.message.list({ sessionID: sessionA.id })
const messagesB = await client.message.list({ sessionID: sessionB.id })
const getA = await client.session.get({ sessionID: sessionA.id })
const getB = await client.session.get({ sessionID: sessionB.id })

eventAbort.abort()
await eventTask
server.kill("SIGTERM")
await server.exited
const firstOut = await serverOut
const firstErr = await serverErr

startServer()
const healthAfter = await waitHealthy(serverUrl, password)
const resumedA = await client.session.get({ sessionID: sessionA.id })
const resumedB = await client.session.get({ sessionID: sessionB.id })
const resumedMessagesA = await client.message.list({ sessionID: sessionA.id })
const resumedMessagesB = await client.message.list({ sessionID: sessionB.id })

let fork: unknown
let forkError: unknown
try {
  fork = await client.session.fork({ sessionID: sessionA.id, boundary: { type: "through" } })
} catch (error) {
  forkError = String(error)
}
let compaction: unknown
let compactionError: unknown
try {
  compaction = await client.session.compact({ sessionID: sessionA.id })
  await client.session.wait({ sessionID: sessionA.id })
} catch (error) {
  compactionError = String(error)
}

server.kill("SIGTERM")
await server.exited
mock.kill("SIGTERM")
await mock.exited

const secondOut = await serverOut
const secondErr = await serverErr
await mkdir(evidenceRoot, { recursive: true })
await writeFile(join(evidenceRoot, "v2-server.stdout.log"), `${firstOut}${secondOut}`)
await writeFile(join(evidenceRoot, "v2-server.stderr.log"), `${firstErr}${secondErr}`)
await writeFile(join(evidenceRoot, "v2-mock.stdout.log"), await mockOut)
await writeFile(join(evidenceRoot, "v2-mock.stderr.log"), await mockErr)
await writeFile(join(evidenceRoot, "v2-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n")

const serializedA = JSON.stringify({ messagesA, resumedMessagesA })
const serializedB = JSON.stringify({ messagesB, resumedMessagesB })
await saveJson("v2-results.json", {
  date: "2026-08-27",
  healthBefore,
  healthAfter,
  sessionA,
  sessionB,
  prompts,
  promptError,
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
  isolation: {
    idsDistinct: sessionA.id !== sessionB.id,
    aContainsOwn: serializedA.includes("CANARY_REPO_A_ONLY"),
    aContainsOther: serializedA.includes("CANARY_REPO_B_ONLY"),
    bContainsOwn: serializedB.includes("CANARY_REPO_B_ONLY"),
    bContainsOther: serializedB.includes("CANARY_REPO_A_ONLY"),
    aDirectory: getA.location?.directory,
    bDirectory: getB.location?.directory,
  },
  providerWithoutRealCredential,
  profileFiles: await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: profile, onlyFiles: true })),
  canaryA: await readFile(join(repoA, "canary.txt"), "utf8"),
  canaryB: await readFile(join(repoB, "canary.txt"), "utf8"),
})
