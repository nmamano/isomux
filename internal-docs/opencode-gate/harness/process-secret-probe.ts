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

const target = join(scratchRoot, "process-secrets")
const repo = join(target, "repo")
const profile = join(target, "profile")
const password = `gate-${crypto.randomUUID()}-password`
const providerSecret = `provider-${crypto.randomUUID()}-secret`
const binary = join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")
await resetDirectory(target)
await makeRepo(repo, "PROCESS_SECRET_CANARY")
await mkdir(profile, { recursive: true })
const configPath = join(profile, "gate-config.json")
await writeFile(configPath, JSON.stringify(gateConfig("http://127.0.0.1:41600/v1", providerSecret)))
const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
delete env.OPENCODE_CONFIG_CONTENT
env.OPENCODE_CONFIG = configPath
const server = Bun.spawn(
  [binary, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "41601", "--print-logs", "--log-level", "DEBUG"],
  { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
)
const stdoutPromise = collect(server.stdout)
const stderrPromise = collect(server.stderr)
await waitHealthy("http://127.0.0.1:41601", password)
const cmdline = (await readFile(`/proc/${server.pid}/cmdline`)).toString().replaceAll("\0", " ")
const environEntries = (await readFile(`/proc/${server.pid}/environ`)).toString().split("\0").filter(Boolean)
const environmentKeys = environEntries.map((entry) => entry.slice(0, entry.indexOf("="))).sort()
const environment = environEntries.join("\n")
server.kill("SIGTERM")
await server.exited
const stdout = await stdoutPromise
const stderr = await stderrPromise
await mkdir(evidenceRoot, { recursive: true })
await writeFile(join(evidenceRoot, "process-secret.stdout.log"), stdout)
await writeFile(join(evidenceRoot, "process-secret.stderr.log"), stderr)
await saveJson("process-secret-results.json", {
  date: "2026-08-27",
  pid: server.pid,
  cmdline,
  environmentKeys,
  serverPassword: {
    inCmdline: cmdline.includes(password),
    inEnvironment: environment.includes(password),
    inStdout: stdout.includes(password),
    inStderr: stderr.includes(password),
    inUrl: `http://127.0.0.1:41601`.includes(password),
  },
  providerSecret: {
    inCmdline: cmdline.includes(providerSecret),
    inEnvironment: environment.includes(providerSecret),
    inStdout: stdout.includes(providerSecret),
    inStderr: stderr.includes(providerSecret),
  },
  note: "The server password must be present in the child environment because OpenCode accepts it only through OPENCODE_SERVER_PASSWORD. Raw environment values are not stored.",
})
