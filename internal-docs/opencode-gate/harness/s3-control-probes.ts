import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gateConfig } from "./config"
import { collect, isolatedEnvironment, makeRepo, resetDirectory, saveJson, scratchRoot, waitHealthy } from "./common"
import { resolveOpenCodeBinary } from "../../../server/backends/opencode/runtime"

const target = join(scratchRoot, "s3-control-probes")
const repo = join(target, "repo")
const password = "S3_CONTROL_PROBE_PASSWORD"
const mockUrl = "http://127.0.0.1:41720/v1"
const binary = resolveOpenCodeBinary()
await resetDirectory(target)
await makeRepo(repo, "S3_CONTROL_PROBE")

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: "41720" }, stdout: "pipe", stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    if ((await fetch("http://127.0.0.1:41720/health")).ok) break
  } catch {}
  await Bun.sleep(25)
}

async function phase(name: string, port: number, permission: Record<string, string>, run: (ctx: {
  client: ReturnType<typeof createOpencodeClient>
  sessionId: string
  events: any[]
  prompt(text: string): Promise<unknown>
  waitFor(predicate: (event: any) => boolean): Promise<any>
}) => Promise<unknown>) {
  const profile = join(target, name)
  await mkdir(profile, { recursive: true })
  const config = { ...gateConfig(mockUrl), permission }
  const configPath = join(profile, "opencode.json")
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
  delete env.OPENCODE_CONFIG_CONTENT
  env.OPENCODE_CONFIG = configPath
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
  const serverUrl = `http://127.0.0.1:${port}`
  const server = Bun.spawn([binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo, env, stdout: "pipe", stderr: "pipe",
  })
  const serverOut = collect(server.stdout)
  const serverErr = collect(server.stderr)
  const events: any[] = []
  const captureAbort = new AbortController()
  try {
    await waitHealthy(serverUrl, password)
    const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
    const client = createOpencodeClient({ baseUrl: serverUrl, headers, directory: repo })
    const capture = (async () => {
      const subscribed = await client.event.subscribe({ signal: captureAbort.signal })
      try { for await (const event of subscribed.stream) events.push(event) } catch (error) { if (!captureAbort.signal.aborted) throw error }
    })()
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.type === "server.connected"); attempt++) {
      await Bun.sleep(25)
    }
    if (!events.some((event) => event.type === "server.connected")) {
      throw new Error(`S3 ${name} event subscription did not become ready`)
    }
    const session = (await client.session.create({ body: { title: name } })).data!
    const prompt = (text: string) => client.session.promptAsync({
      path: { id: session.id },
      body: { model: { providerID: "gate", modelID: "gate-model" }, parts: [{ type: "text", text }] },
    })
    const waitFor = async (predicate: (event: any) => boolean) => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        const found = events.find(predicate)
        if (found) return found
        await Bun.sleep(25)
      }
      throw new Error(`S3 ${name} probe timed out after ${events.map((event) => event.type).join(",")}`)
    }
    const result = await run({ client, sessionId: session.id, events, prompt, waitFor })
    captureAbort.abort()
    await capture
    return result
  } finally {
    captureAbort.abort()
    server.kill("SIGTERM")
    await server.exited
    await Promise.all([serverOut, serverErr])
  }
}

const permissionAbort = await phase(
  "permission-question", 41721, { bash: "ask", edit: "ask", question: "deny" },
  async ({ client, sessionId, events, prompt, waitFor }) => {
    await prompt("GATE_TOOL permission abort")
    const permission = await waitFor((event) => event.type === "permission.asked")
    const abortResult = (await client.session.abort({ path: { id: sessionId } })).data
    await waitFor((event) => event.type === "session.idle" && event.properties.sessionID === sessionId)
    return {
      pendingPermissionID: permission.properties.id,
      abortResult,
      eventTypes: events.map((event) => event.type),
    }
  },
)

const questionDeny = await phase(
  "question-deny", 41723, { bash: "ask", edit: "ask", question: "deny" },
  async ({ sessionId, events, prompt, waitFor }) => {
    await prompt("GATE_QUESTION denied")
    await waitFor((event) => event.type === "session.idle" && event.properties.sessionID === sessionId)
    return {
      permissionAsked: events.some((event) => event.type === "permission.asked"),
      toolStates: events
        .filter((event) => event.type === "message.part.updated" && event.properties.part?.type === "tool")
        .map((event) => ({ tool: event.properties.part.tool, status: event.properties.part.state?.status })),
    }
  },
)

const toolAbort = await phase(
  "tool-abort", 41722, { bash: "allow", edit: "ask", question: "deny" },
  async ({ client, sessionId, events, prompt, waitFor }) => {
    await prompt("GATE_ABORT_TOOL running")
    const running = await waitFor((event) =>
      event.type === "message.part.updated" &&
      event.properties.part?.type === "tool" &&
      event.properties.part?.state?.status === "running")
    const abortStartedAt = Date.now()
    const abortResult = (await client.session.abort({ path: { id: sessionId } })).data
    const abortElapsedMs = Date.now() - abortStartedAt
    await waitFor((event) => event.type === "session.idle" && event.properties.sessionID === sessionId)
    return {
      runningPartID: running.properties.part.id,
      abortResult,
      abortElapsedMs,
      toolStates: events
        .filter((event) => event.type === "message.part.updated" && event.properties.part?.type === "tool")
        .map((event) => ({ partID: event.properties.part.id, status: event.properties.part.state?.status })),
      stepFinishObserved: events.some((event) => event.properties?.part?.type === "step-finish"),
    }
  },
)

mock.kill("SIGTERM")
await mock.exited
await Promise.all([mockOut, mockErr])
await saveJson("s3-control-probe-results.json", {
  date: "2026-08-28",
  version: "1.18.23",
  permissionAbort,
  questionDeny,
  toolAbort,
})
