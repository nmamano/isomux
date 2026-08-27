import { createOpencodeClient } from "@opencode-ai/sdk"
import { closeSync, openSync } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  evidenceRoot,
  gateRoot,
  isolatedEnvironment,
  makeRepo,
  resetDirectory,
  saveJson,
  scratchRoot,
  waitHealthy,
} from "./common"

const target = join(scratchRoot, "security")
const targetVersion = process.argv[2] === "v2" ? "v2" : "v1"
const repo = join(target, "hostile-repo")
const markerRoot = join(target, "markers")
const pluginMarker = join(markerRoot, "plugin-executed")
const mcpMarker = join(markerRoot, "mcp-executed")
const binary = join(gateRoot, `node_modules/opencode-${targetVersion}/bin/opencode.exe`)
const pluginDirectory = targetVersion === "v2" ? ".opencode/plugins" : ".opencode/plugin"
await resetDirectory(target)
await makeRepo(repo, "SECURITY_CANARY")
await mkdir(join(repo, pluginDirectory), { recursive: true })
await mkdir(join(repo, ".claude", "skills", "compat-gate"), { recursive: true })
await mkdir(markerRoot, { recursive: true })

await writeFile(
  join(repo, pluginDirectory, "gate.js"),
  targetVersion === "v2"
    ? `Bun.write(${JSON.stringify(pluginMarker)}, "executed")\nexport default { id: "gate.marker", setup: async () => {} }\n`
    : `Bun.write(${JSON.stringify(pluginMarker)}, "executed")\nexport const GatePlugin = async () => ({})\n`,
)
await writeFile(
  join(repo, ".claude", "skills", "compat-gate", "SKILL.md"),
  "---\nname: compat-gate\ndescription: harmless compatibility marker\n---\ncompatibility marker\n",
)
await writeFile(
  join(repo, "opencode.json"),
  JSON.stringify({
    mcp: {
      gate: {
        type: "local",
        command: ["/bin/sh", "-c", `printf executed > ${mcpMarker}; exec sleep 10`],
        enabled: true,
      },
    },
  }),
)

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function runCase(name: string, port: number, pure: boolean, controls: Record<string, string>) {
  const profile = join(target, `profile-${name}`)
  await mkdir(profile, { recursive: true })
  const password = `GATE_SECURITY_PASSWORD_${name}`
  const env = { ...isolatedEnvironment(profile, { autoupdate: false }, password), ...controls }
  await mkdir(evidenceRoot, { recursive: true })
  const stdoutPath = join(evidenceRoot, `security-${targetVersion}-${name}.stdout.log`)
  const stderrPath = join(evidenceRoot, `security-${targetVersion}-${name}.stderr.log`)
  const stdoutFd = openSync(stdoutPath, "w")
  const stderrFd = openSync(stderrPath, "w")
  const args = [binary, "serve"]
  if (pure) args.push("--pure")
  args.push("--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG")
  const server = Bun.spawn(
    args,
    { cwd: repo, env, stdout: stdoutFd, stderr: stderrFd },
  )
  const url = `http://127.0.0.1:${port}`
  await waitHealthy(url, password)
  const headers = { authorization: `Basic ${btoa(`gate:${password}`)}` }
  const client = createOpencodeClient({ baseUrl: url, headers, directory: repo })
  let config: unknown
  if (!pure) {
    void fetch(`${url}/config?directory=${encodeURIComponent(repo)}`, { headers }).catch(() => undefined)
    for (let attempt = 0; attempt < 4_800 && !(await exists(pluginMarker)); attempt++) {
      await Bun.sleep(50)
    }
    config = "config request initiated to activate the project plugin; response not awaited"
  } else {
    config = targetVersion === "v2"
      ? await fetch(`${url}/config?directory=${encodeURIComponent(repo)}`, { headers }).then((response) => response.json())
      : (await client.config.get()).data
  }
  const mcp = pure
    ? targetVersion === "v2"
      ? await fetch(`${url}/mcp?directory=${encodeURIComponent(repo)}`, { headers }).then((response) => response.json())
      : (await client.mcp.status()).data
    : "not requested in plugin positive-control case"
  const skillsResponse = pure
    ? await fetch(`${url}/skill?directory=${encodeURIComponent(repo)}`, { headers })
    : undefined
  const skills = skillsResponse ? await skillsResponse.text() : "not requested in plugin positive-control case"
  await Bun.sleep(300)
  const result = {
    name,
    pure,
    controls,
    config,
    mcp,
    skillsStatus: skillsResponse?.status,
    skills,
    pluginExecuted: await exists(pluginMarker),
    mcpExecuted: await exists(mcpMarker),
  }
  server.kill(pure ? "SIGTERM" : "SIGKILL")
  await server.exited
  closeSync(stdoutFd)
  closeSync(stderrFd)
  return result
}

const portOffset = targetVersion === "v2" ? 600 : 0
const noPure = await runCase("no-pure", 41212 + portOffset, false, {})
await writeFile(pluginMarker, "reset").then(() => Bun.file(pluginMarker).delete())
await writeFile(mcpMarker, "reset").then(() => Bun.file(mcpMarker).delete())
const pureOnly = await runCase("pure-only", 41213 + portOffset, true, {})
await writeFile(pluginMarker, "reset").then(() => Bun.file(pluginMarker).delete())
await writeFile(mcpMarker, "reset").then(() => Bun.file(mcpMarker).delete())
const enforced = await runCase("enforced", 41214 + portOffset, true, {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
})

await saveJson(`security-results-${targetVersion}.json`, { date: "2026-08-27", targetVersion, noPure, pureOnly, enforced })
