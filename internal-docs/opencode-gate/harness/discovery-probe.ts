import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gateConfig } from "./config"
import { collect, gateRoot, isolatedEnvironment, makeRepo, resetDirectory, saveJson, scratchRoot, waitHealthy } from "./common"

const target = join(scratchRoot, "discovery")
const repo = join(target, "repo")
const binary = join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")
await resetDirectory(target)
await makeRepo(repo, "DISCOVERY_CANARY")

async function run(name: string, port: number, config: unknown) {
  const profile = join(target, name)
  await mkdir(profile, { recursive: true })
  const configPath = join(profile, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  const password = `GATE_DISCOVERY_${name}`
  const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
  delete env.OPENCODE_CONFIG_CONTENT
  env.OPENCODE_CONFIG = configPath
  const server = Bun.spawn([binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = collect(server.stdout)
  const stderr = collect(server.stderr)
  const url = `http://127.0.0.1:${port}`
  await waitHealthy(url, password)
  const client = createOpencodeClient({
    baseUrl: url,
    directory: repo,
    headers: { authorization: `Basic ${btoa(`gate:${password}`)}` },
  })
  const providers = (await client.provider.list()).data
  server.kill("SIGTERM")
  await server.exited
  return {
    providers: {
      all: providers?.all.map((provider) => provider.id) ?? [],
      connected: providers?.connected ?? [],
    },
    stdout: await stdout,
    stderr: await stderr,
  }
}

const noCredentials = await run("none", 41701, { autoupdate: false })
const configured = await run("configured", 41702, gateConfig("http://127.0.0.1:9/v1"))
await saveJson("provider-discovery-results.json", { date: "2026-08-27", noCredentials, configured })
