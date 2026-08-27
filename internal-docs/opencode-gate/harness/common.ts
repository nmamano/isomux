import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const gateRoot = join(import.meta.dir, "..")
export const evidenceRoot = join(gateRoot, "evidence")
export const scratchRoot = "/tmp/isomux-opencode-gate"

export async function resetDirectory(path: string) {
  if (!path.startsWith(`${scratchRoot}/`)) throw new Error(`refusing to reset ${path}`)
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })
}

export async function makeRepo(path: string, canary: string) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "canary.txt"), `${canary}\n`)
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: path })
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
}

export function isolatedEnvironment(root: string, config: unknown, password: string) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    USER: "isomux-gate",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_USERNAME: "gate",
    OPENCODE_SERVER_PASSWORD: password,
  }
}

export async function waitHealthy(url: string, password: string) {
  const auth = `Basic ${btoa(`gate:${password}`)}`
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const response = await fetch(`${url}/global/health`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return (await response.json()) as { healthy: boolean; version: string }
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error(`server did not become healthy at ${url}`)
}

export async function collect(readable: ReadableStream<Uint8Array> | null) {
  if (!readable) return ""
  return new Response(readable).text()
}

export async function saveJson(path: string, value: unknown) {
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, path), `${JSON.stringify(value, null, 2)}\n`)
}
