import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { evidenceRoot, saveJson } from "./common"

const positive = "GATE_POSITIVE_CONTROL_SENTINEL"
const controlPath = join(evidenceRoot, "secret-scan-positive-control.txt")
await mkdir(evidenceRoot, { recursive: true })
await writeFile(controlPath, `${positive}\n`)
const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: evidenceRoot, onlyFiles: true }))
async function hits(needle: string) {
  const result = []
  for (const file of files) {
    const text = await readFile(join(evidenceRoot, file), "utf8").catch(() => "")
    if (text.includes(needle)) result.push(file)
  }
  return result
}

await saveJson("secret-scan-results.json", {
  date: "2026-08-27",
  positiveControl: { needle: positive, hits: await hits(positive) },
  providerCredential: { needle: "GATE_PROVIDER_SENTINEL", hits: await hits("GATE_PROVIDER_SENTINEL") },
  v1ServerPassword: { needle: "GATE_SERVER_PASSWORD_V1_SENTINEL", hits: await hits("GATE_SERVER_PASSWORD_V1_SENTINEL") },
  v2ServerPassword: { needle: "GATE_SERVER_PASSWORD_V2_SENTINEL", hits: await hits("GATE_SERVER_PASSWORD_V2_SENTINEL") },
  leakedProviderHeader: { needle: "GATE_HEADER_SECRET_SENTINEL", hits: await hits("GATE_HEADER_SECRET_SENTINEL") },
})
