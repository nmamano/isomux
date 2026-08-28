import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

export async function assertOpenCodeServerStopped(profileDir: string): Promise<void> {
  let pid: number
  try {
    const record = JSON.parse(await readFile(join(profileDir, "server.lock"), "utf8")) as unknown
    if (!isRecord(record) || typeof record.pid !== "number") return
    pid = record.pid
  } catch {
    return
  }
  try {
    process.kill(pid, 0)
  } catch {
    return
  }
  throw new Error(
    "The shared OpenCode server restarted while this command was waiting. Send your message again to get a fresh login command.",
  )
}

export async function preserveOpenCodeAuthProviders(
  profileDir: string,
  beforePath: string,
  provider: string,
): Promise<void> {
  const targetPath = join(profileDir, "data", "opencode", "auth.json")
  const current = await readAuthRecord(targetPath, "current")
  if (!isRecord(current[provider])) {
    throw new Error(`OpenCode login did not create the requested ${provider} credential.`)
  }
  let before: Record<string, unknown> = {}
  try {
    before = await readAuthRecord(beforePath, "prior")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  await writeMergedAuth(profileDir, { ...before, ...current })
}

async function writeMergedAuth(
  profileDir: string,
  merged: Record<string, unknown>,
): Promise<void> {
  const targetPath = join(profileDir, "data", "opencode", "auth.json")
  const targetDir = dirname(targetPath)
  const temporaryPath = join(targetDir, `.auth.json.${randomUUID()}.tmp`)
  await mkdir(targetDir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(merged)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, targetPath)
    await writeFile(join(profileDir, "server.replace"), "authentication changed\n", { mode: 0o600 })
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function readAuthRecord(path: string, label: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!isRecord(parsed)) throw new Error(`OpenCode ${label} auth file has an invalid shape.`)
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

if (import.meta.main) {
  const [action, profileDir, sourcePath, provider] = process.argv.slice(2)
  if (action === "--assert-stopped" && profileDir) {
    await assertOpenCodeServerStopped(profileDir)
  } else if (!profileDir || !sourcePath || !provider) {
    throw new Error("OpenCode login merge requires a profile, source, and provider.")
  } else if (action === "--preserve") {
    await preserveOpenCodeAuthProviders(profileDir, sourcePath, provider)
  } else {
    throw new Error("Unknown OpenCode login merge action.")
  }
}
