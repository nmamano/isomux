import { createOpencodeClient } from "@opencode-ai/sdk"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

const target = join(scratchRoot, "s2-auth-probes")
const repo = join(target, "repo")
const profile = join(target, "profile")
const binary = resolveOpenCodeBinary()
const port = 41711
const password = "S2_PROBE_SERVER_PASSWORD"

await resetDirectory(target)
await makeRepo(repo, "S2_AUTH_PROBE_CANARY")
await mkdir(profile, { recursive: true })
const configPath = join(profile, "opencode.json")
await writeFile(
  configPath,
  JSON.stringify({ autoupdate: false, share: "disabled" }),
  { mode: 0o600 },
)

const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
const server = Bun.spawn(
  [binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
)
const stdout = collect(server.stdout)
const stderr = collect(server.stderr)

try {
  const baseUrl = `http://127.0.0.1:${port}`
  await waitHealthy(baseUrl, password)
  const client = createOpencodeClient({
    baseUrl,
    directory: repo,
    headers: { authorization: `Basic ${btoa(`gate:${password}`)}` },
  })

  const before = (await client.provider.list()).data!
  const openai = before.all.find((provider) => provider.id === "openai")
  if (!openai) throw new Error("Pinned OC1 did not expose the OpenAI provider")
  const catalogModelID = Object.keys(openai.models)[0]
  if (!catalogModelID) throw new Error("Pinned OC1 exposed no OpenAI model")
  const modelID = catalogModelID.startsWith("openai/")
    ? catalogModelID.slice("openai/".length)
    : catalogModelID

  const eventAbort = new AbortController()
  const events: unknown[] = []
  const eventTask = (async () => {
    const response = await client.event.subscribe({ signal: eventAbort.signal })
    try {
      for await (const event of response.stream) events.push(event)
    } catch (error) {
      if (!eventAbort.signal.aborted) throw error
    }
  })()
  const session = (await client.session.create({ body: { title: "s2-missing-auth" } })).data!
  let promptResult: unknown
  let promptError: unknown
  let promptThrown: unknown
  try {
    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        model: { providerID: "openai", modelID },
        parts: [{ type: "text", text: "S2_MISSING_AUTH" }],
      },
    })
    promptResult = response.data
    promptError = "error" in response ? response.error : undefined
  } catch (error) {
    promptThrown = error instanceof Error
      ? { name: error.name, message: error.message }
      : { type: typeof error }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      events.some(
        (event) =>
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "session.error",
      )
    ) break
    await Bun.sleep(50)
  }
  eventAbort.abort()
  await eventTask

  const authPath = join(profile, "data", "opencode", "auth.json")
  await mkdir(join(profile, "data", "opencode"), { recursive: true })
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: "api", key: "S2_RELOAD_PROBE_SENTINEL" } }),
    { mode: 0o600 },
  )
  await chmod(authPath, 0o600)

  let after = (await client.provider.list()).data!
  for (let attempt = 0; attempt < 40 && !after.connected.includes("openai"); attempt++) {
    await Bun.sleep(50)
    after = (await client.provider.list()).data!
  }

  await saveJson("s2-auth-probe-results.json", {
    date: "2026-08-28",
    serverPid: server.pid,
    missingCredential: {
      providerID: "openai",
      modelID,
      promptReturned: promptResult !== undefined,
      promptError,
      promptThrown,
      errorEvents: events.filter(
        (event) =>
          event &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "session.error",
      ),
    },
    liveReload: {
      sameServerPid: server.pid,
      connectedBefore: before.connected,
      connectedAfter: after.connected,
      openaiModelIDsAfter: Object.keys(
        after.all.find((provider) => provider.id === "openai")?.models ?? {},
      ).slice(0, 10),
      reloadedWithoutRestart: after.connected.includes("openai"),
      authFileRelativePath: "data/opencode/auth.json",
      authFileMode: "0600",
    },
    stdout: await Promise.race([stdout, Promise.resolve("captured after shutdown")]),
  })
} finally {
  server.kill("SIGTERM")
  await server.exited
  const serverStderr = await stderr
  if (serverStderr.trim()) process.stderr.write("Pinned server wrote private stderr; inspect scratch output only.\n")
}
