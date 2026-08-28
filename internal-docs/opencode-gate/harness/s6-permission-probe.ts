import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gateConfig } from "./config"
import {
  collect,
  isolatedEnvironment,
  makeRepo,
  resetDirectory,
  saveJson,
  scratchRoot,
  waitHealthy,
} from "./common"
import { resolveOpenCodeBinary } from "../../../server/backends/opencode/runtime"

const target = join(scratchRoot, "s6-permission-probe")
const repo = join(target, "repo")
const password = "S6_PERMISSION_PROBE_PASSWORD"
const mockUrl = "http://127.0.0.1:41730/v1"
const binary = resolveOpenCodeBinary()
await resetDirectory(target)
await makeRepo(repo, "S6_PERMISSION_PROBE")

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: "41730" },
  stdout: "pipe",
  stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
for (let attempt = 0; attempt < 200; attempt++) {
  try {
    if ((await fetch("http://127.0.0.1:41730/health")).ok) break
  } catch {}
  await Bun.sleep(25)
}

function eventSessionID(event: any): string | undefined {
  return (
    event.properties?.sessionID ??
    event.properties?.part?.sessionID ??
    event.properties?.info?.sessionID
  )
}

function safeEvent(event: any) {
  return {
    type: event.type,
    propertyKeys:
      event.properties && typeof event.properties === "object"
        ? Object.keys(event.properties).sort()
        : [],
    sessionID: eventSessionID(event) ?? null,
    permission:
      typeof event.properties?.permission === "string"
        ? event.properties.permission
        : null,
    tool:
      event.type === "message.part.updated" &&
      event.properties?.part?.type === "tool"
        ? {
            name: event.properties.part.tool,
            status: event.properties.part.state?.status ?? null,
          }
        : null,
    errorName:
      typeof event.properties?.error?.name === "string"
        ? event.properties.error.name
        : null,
    errorMessage:
      typeof event.properties?.error?.data?.message === "string"
        ? event.properties.error.data.message
        : null,
  }
}

async function phase(
  name: string,
  port: number,
  config: Record<string, unknown>,
  run: (ctx: {
    client: ReturnType<typeof createOpencodeClient>
    events: any[]
    headers: { authorization: string }
    serverUrl: string
    createSession(title: string): Promise<string>
    prompt(sessionID: string, text: string, agent?: string): Promise<number>
    waitFor(predicate: (event: any) => boolean, label: string): Promise<any>
  }) => Promise<unknown>,
) {
  const profile = join(target, name)
  await mkdir(profile, { recursive: true })
  const configPath = join(profile, "opencode.json")
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
  delete env.OPENCODE_CONFIG_CONTENT
  env.OPENCODE_CONFIG = configPath
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
  const serverUrl = `http://127.0.0.1:${port}`
  const server = Bun.spawn(
    [binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
  )
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
      try {
        for await (const event of subscribed.stream) events.push(event)
      } catch (error) {
        if (!captureAbort.signal.aborted) throw error
      }
    })()
    for (
      let attempt = 0;
      attempt < 200 && !events.some((event) => event.type === "server.connected");
      attempt++
    ) {
      await Bun.sleep(25)
    }
    if (!events.some((event) => event.type === "server.connected")) {
      throw new Error(`S6 ${name} event subscription did not become ready`)
    }
    const createSession = async (title: string) =>
      (await client.session.create({ body: { title } })).data!.id
    const prompt = async (sessionID: string, text: string, agent?: string) => {
      const response = await fetch(
        `${serverUrl}/session/${encodeURIComponent(sessionID)}/prompt_async?directory=${encodeURIComponent(repo)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: "gate", modelID: "gate-model" },
            ...(agent ? { agent } : {}),
            parts: [{ type: "text", text }],
          }),
        },
      )
      await response.body?.cancel().catch(() => undefined)
      return response.status
    }
    const waitFor = async (
      predicate: (event: any) => boolean,
      label: string,
    ) => {
      for (let attempt = 0; attempt < 1200; attempt++) {
        const found = events.find(predicate)
        if (found) return found
        await Bun.sleep(25)
      }
      throw new Error(
        `S6 ${name} timed out waiting for ${label}: ${events.map((event) => event.type).join(",")}`,
      )
    }
    const result = await run({
      client,
      events,
      headers,
      serverUrl,
      createSession,
      prompt,
      waitFor,
    })
    captureAbort.abort()
    await capture
    return { pid: server.pid, result }
  } finally {
    captureAbort.abort()
    server.kill("SIGTERM")
    await server.exited
    await Promise.all([serverOut, serverErr])
  }
}

const sharedConfig = {
  ...gateConfig(mockUrl),
  permission: { bash: "ask", edit: "ask", question: "deny" },
  agent: {
    "isomux-cron": {
      description: "S6 unattended permission probe",
      mode: "primary",
      permission: { bash: "allow", edit: "allow", question: "deny" },
    },
  },
}

const shared = await phase(
  "shared",
  41731,
  sharedConfig,
  async ({ client, events, headers, serverUrl, createSession, prompt, waitFor }) => {
    const defaultSession = await createSession("default-ask")
    const defaultStatus = await prompt(defaultSession, "GATE_TOOL default ask")
    const defaultPermission = await waitFor(
      (event) =>
        event.type === "permission.asked" &&
        eventSessionID(event) === defaultSession,
      "default permission",
    )
    await fetch(
      `${serverUrl}/permission/${encodeURIComponent(defaultPermission.properties.id)}/reply?directory=${encodeURIComponent(repo)}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ reply: "reject" }),
      },
    )
    await waitFor(
      (event) =>
        event.type === "session.idle" && eventSessionID(event) === defaultSession,
      "default idle",
    )

    const cronSession = await createSession("cron-allow")
    const cronStatus = await prompt(cronSession, "GATE_TOOL cron allow", "isomux-cron")
    await waitFor(
      (event) =>
        event.type === "session.idle" && eventSessionID(event) === cronSession,
      "cron idle",
    )

    const questionSession = await createSession("cron-question-deny")
    const questionStatus = await prompt(
      questionSession,
      "GATE_QUESTION cron deny",
      "isomux-cron",
    )
    await waitFor(
      (event) =>
        event.type === "session.idle" && eventSessionID(event) === questionSession,
      "question deny idle",
    )

    const unknownSession = await createSession("unknown-agent")
    const unknownStatus = await prompt(
      unknownSession,
      "GATE_TOOL unknown agent",
      "isomux-agent-does-not-exist",
    )
    const unknownTerminal = await waitFor(
      (event) =>
        eventSessionID(event) === unknownSession &&
        (event.type === "session.error" ||
          event.type === "session.idle" ||
          event.type === "permission.asked"),
      "unknown agent outcome",
    )
    if (unknownTerminal.type === "permission.asked") {
      await fetch(
        `${serverUrl}/permission/${encodeURIComponent(unknownTerminal.properties.id)}/reply?directory=${encodeURIComponent(repo)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ reply: "reject" }),
        },
      )
      await waitFor(
        (event) =>
          event.type === "session.idle" && eventSessionID(event) === unknownSession,
        "unknown idle after reject",
      )
    }

    const selected = (sessionID: string) =>
      events.filter((event) => eventSessionID(event) === sessionID).map(safeEvent)
    return {
      default: { sessionID: defaultSession, promptStatus: defaultStatus, events: selected(defaultSession) },
      cron: { sessionID: cronSession, promptStatus: cronStatus, events: selected(cronSession) },
      questionDeny: {
        sessionID: questionSession,
        promptStatus: questionStatus,
        events: selected(questionSession),
      },
      unknown: {
        sessionID: unknownSession,
        promptStatus: unknownStatus,
        terminalType: unknownTerminal.type,
        events: selected(unknownSession),
      },
    }
  },
)

const questionAsk = await phase(
  "question-ask",
  41732,
  {
    ...gateConfig(mockUrl),
    permission: { bash: "ask", edit: "ask", question: "ask" },
  },
  async ({ client, events, createSession, prompt, waitFor }) => {
    const sessionID = await createSession("question-ask")
    const promptStatus = await prompt(sessionID, "GATE_QUESTION ask")
    const terminal = await waitFor(
      (event) =>
        eventSessionID(event) === sessionID &&
        (event.type === "question.asked" ||
          event.type === "permission.asked" ||
          event.type === "session.error" ||
          event.type === "session.idle"),
      "question request outcome",
    )
    await client.session.abort({ path: { id: sessionID } })
    await waitFor(
      (event) =>
        event.type === "session.idle" && eventSessionID(event) === sessionID,
      "question abort idle",
    )
    return {
      sessionID,
      promptStatus,
      terminalType: terminal.type,
      terminal: safeEvent(terminal),
      events: events.filter((event) => eventSessionID(event) === sessionID).map(safeEvent),
    }
  },
)

mock.kill("SIGTERM")
await mock.exited
await Promise.all([mockOut, mockErr])
await saveJson("s6-permission-probe-results.json", {
  date: "2026-08-28",
  version: "1.18.23",
  shared,
  questionAsk,
})
