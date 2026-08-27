import { createOpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { gateConfig } from "./config"
import {
  collect,
  gateRoot,
  isolatedEnvironment,
  makeRepo,
  resetDirectory,
  saveJson,
  scratchRoot,
  waitHealthy,
} from "./common"

const count = Number(process.argv[2])
if (![1, 8, 16].includes(count)) throw new Error("count must be 1, 8, or 16")
const port = 41300 + count
const mockPort = 41400 + count
const target = join(scratchRoot, `rss-v1-${count}`)
const profile = join(target, "profile")
const repo = join(target, "repo")
const password = `GATE_RSS_PASSWORD_${count}`
const binary = join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")
await resetDirectory(target)
await makeRepo(repo, `RSS_CANARY_${count}`)
await mkdir(profile, { recursive: true })
const configPath = join(profile, "gate-config.json")
await writeFile(configPath, JSON.stringify(gateConfig(`http://127.0.0.1:${mockPort}/v1`)))

const mock = Bun.spawn(["bun", join(import.meta.dir, "mock-openai.ts")], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PORT: String(mockPort), GATE_ABORT_MS: "15000" },
  stdout: "pipe",
  stderr: "pipe",
})
const mockOut = collect(mock.stdout)
const mockErr = collect(mock.stderr)
await Bun.sleep(100)

const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
const server = Bun.spawn([binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: repo,
  env,
  stdout: "pipe",
  stderr: "pipe",
})
const serverOut = collect(server.stdout)
const serverErr = collect(server.stderr)
const url = `http://127.0.0.1:${port}`
await waitHealthy(url, password)

async function processTree(root: number) {
  const seen = new Set<number>()
  const visit = async (pid: number) => {
    if (seen.has(pid)) return
    seen.add(pid)
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => "")
    for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) await visit(child)
  }
  await visit(root)
  return [...seen]
}

async function rss(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, "utf8")
  return Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0)
}

async function sample(label: string) {
  const pids = await processTree(server.pid)
  const values = await Promise.all(pids.map(async (pid) => ({ pid, rssKiB: await rss(pid) })))
  return { label, at: new Date().toISOString(), mainPid: server.pid, processes: values, totalRssKiB: values.reduce((sum, item) => sum + item.rssKiB, 0) }
}

async function memoryEvents() {
  const cgroup = (await readFile("/proc/self/cgroup", "utf8")).trim().split(":").at(-1)
  if (!cgroup) return null
  const path = join("/sys/fs/cgroup", cgroup, "memory.events")
  return { path, text: await readFile(path, "utf8").catch(() => null) }
}

const cgroupBefore = await memoryEvents()
const idleServer = await sample("server-idle-no-sessions")
const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
const client = createOpencodeClient({ baseUrl: url, headers, directory: repo })
const sessions = []
for (let index = 0; index < count; index++) sessions.push((await client.session.create({ body: { title: `rss-${index}` } })).data!)
const createdIdle = await sample(`${count}-created-idle-sessions`)

await Promise.all(
  sessions.map((session, index) =>
    client.session.promptAsync({
      path: { id: session.id },
      body: {
        model: { providerID: "gate", modelID: "gate-model" },
        parts: [{ type: "text", text: `GATE_ABORT rss-${count}-${index}` }],
      },
    }),
  ),
)
let status = (await client.session.status()).data
for (let attempt = 0; attempt < 300; attempt++) {
  if (Object.values(status ?? {}).filter((item: any) => item.type === "busy").length === count) break
  await Bun.sleep(100)
  status = (await client.session.status()).data
}
const midTurn = await sample(`${count}-mid-turn-sessions`)
await Promise.all(sessions.map((session) => client.session.abort({ path: { id: session.id } })))
const cgroupAfter = await memoryEvents()

server.kill("SIGTERM")
await server.exited
mock.kill("SIGTERM")
await mock.exited
await saveJson(`rss-v1-${count}.json`, {
  date: "2026-08-27",
  host: hostname(),
  kernel: (await readFile("/proc/sys/kernel/osrelease", "utf8")).trim(),
  cliVersion: "1.18.23",
  sdkVersion: "1.18.23",
  count,
  definition: "mid-turn means prompt_async accepted, status sampled as busy, and mock held the response open",
  status,
  idleServer,
  createdIdle,
  midTurn,
  incrementsKiB: {
    createdIdleOverServer: createdIdle.totalRssKiB - idleServer.totalRssKiB,
    midTurnOverServer: midTurn.totalRssKiB - idleServer.totalRssKiB,
  },
  cgroupBefore,
  cgroupAfter,
  stdout: await serverOut,
  stderr: await serverErr,
  mockStdout: await mockOut,
  mockStderr: await mockErr,
})
