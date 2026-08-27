import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, writeFile } from "node:fs/promises"
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

const target = join(scratchRoot, "auth-error")
const repo = join(target, "repo")
const profile = join(target, "profile")
const binary = join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")
await resetDirectory(target)
await makeRepo(repo, "AUTH_ERROR_CANARY")
await mkdir(profile, { recursive: true })
const configPath = join(profile, "gate-config.json")
await writeFile(configPath, JSON.stringify(gateConfig("http://127.0.0.1:41500/v1", "INVALID_GATE_KEY")))

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: "41500" },
  stdout: "pipe",
  stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
const password = "GATE_AUTH_SERVER_PASSWORD"
const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
const server = Bun.spawn([binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "41501"], {
  cwd: repo,
  env,
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = collect(server.stdout)
const stderr = collect(server.stderr)
await waitHealthy("http://127.0.0.1:41501", password)
const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:41501", headers, directory: repo })
const eventAbort = new AbortController()
const events: any[] = []
const eventTask = (async () => {
  const response = await client.event.subscribe({ signal: eventAbort.signal })
  try {
    for await (const event of response.stream) events.push(event)
  } catch (error) {
    if (!eventAbort.signal.aborted) throw error
  }
})()
const session = (await client.session.create({ body: { title: "auth-error" } })).data!
let result: unknown
let thrown: unknown
try {
  result = (
    await client.session.prompt({
      path: { id: session.id },
      body: {
        model: { providerID: "gate", modelID: "gate-model" },
        parts: [{ type: "text", text: "AUTH_ERROR_FIXTURE" }],
      },
    })
  ).data
} catch (error) {
  thrown = error
}
eventAbort.abort()
await eventTask
server.kill("SIGTERM")
await server.exited
mock.kill("SIGTERM")
await mock.exited
await mkdir(evidenceRoot, { recursive: true })
await writeFile(join(evidenceRoot, "auth-error-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n")
await saveJson("auth-error-results.json", {
  date: "2026-08-27",
  session,
  result,
  thrown,
  errorEvents: events.filter((event) => event.type.includes("error") || event.properties?.info?.error),
  stdout: await stdout,
  stderr: await stderr,
  mockStdout: await mockOut,
  mockStderr: await mockErr,
})
