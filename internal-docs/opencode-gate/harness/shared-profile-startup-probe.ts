import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  collect,
  evidenceRoot,
  gateRoot,
  isolatedEnvironment,
  resetDirectory,
  scratchRoot,
} from "./common"

const binary = join(gateRoot, "node_modules/opencode-linux-x64/bin/opencode")
const target = join(scratchRoot, "shared-profile-startup")
const evidencePath = join(evidenceRoot, "shared-profile-startup.jsonl")
const password = "GATE_SHARED_PROFILE_STARTUP_PASSWORD"
const serverCounts = [2, 8] as const
const trialsPerCount = 50
const firstPort = 41600
const runId = `${Date.now()}-${process.pid}`

type Child = {
  process: ReturnType<typeof Bun.spawn>
  stdout: Promise<string>
  stderr: Promise<string>
}

function startServer(cwd: string, env: Record<string, string>, port: number): Child {
  const process = Bun.spawn(
    [
      binary,
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "ERROR",
    ],
    { cwd, env, stdout: "pipe", stderr: "pipe" },
  )
  return { process, stdout: collect(process.stdout), stderr: collect(process.stderr) }
}

async function waitForStart(child: Child, port: number): Promise<boolean> {
  const authorization = `Basic ${btoa(`gate:${password}`)}`
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.process.exitCode !== null) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
        headers: { authorization },
        signal: AbortSignal.timeout(250),
      })
      if (response.ok) return true
    } catch {}
    await Bun.sleep(50)
  }
  return false
}

function safeText(value: string): string {
  const credentialShape =
    /(sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}|authorization\s*[:=]|GATE_SHARED_PROFILE_STARTUP_PASSWORD)/gi
  return value.replace(credentialShape, "[REDACTED]").slice(-4_000)
}

async function record(value: unknown) {
  await mkdir(evidenceRoot, { recursive: true })
  await appendFile(evidencePath, `${JSON.stringify(value)}\n`)
}

await record({
  kind: "run_start",
  runId,
  runtime: "OpenCode 1.18.23",
  serverCounts,
  trialsPerCount,
  condition: "fresh shared profile and same working directory",
})

for (const serverCount of serverCounts) {
  for (let trial = 1; trial <= trialsPerCount; trial++) {
    const trialRoot = join(target, `${runId}-${serverCount}-${trial}`)
    const profile = join(trialRoot, "profile")
    const cwd = join(trialRoot, "repo")
    await resetDirectory(trialRoot)
    await mkdir(profile, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const env = isolatedEnvironment(profile, {}, password) as Record<string, string>
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    env.OPENCODE_DISABLE_CLAUDE_CODE = "1"
    const children = Array.from({ length: serverCount }, (_, index) =>
      startServer(cwd, env, firstPort + index),
    )
    const healthy = await Promise.all(
      children.map((child, index) => waitForStart(child, firstPort + index)),
    )
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill("SIGTERM")
    }
    await Promise.all(children.map((child) => child.process.exited))
    const outputs = await Promise.all(
      children.map(async (child, index) => ({
        index,
        exitCode: child.process.exitCode,
        stdout: safeText(await child.stdout),
        stderr: safeText(await child.stderr),
      })),
    )
    await record({
      kind: "trial",
      runId,
      serverCount,
      trial,
      healthy,
      passed: healthy.every(Boolean),
      outputs: outputs.filter((output, index) => !healthy[index]),
    })
    console.log(
      `serverCount=${serverCount} trial=${trial}/${trialsPerCount} healthy=${healthy.filter(Boolean).length}/${serverCount}`,
    )
  }
}

await record({ kind: "run_complete", runId })
