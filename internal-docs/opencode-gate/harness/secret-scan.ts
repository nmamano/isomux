import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  OC1_CREDENTIAL_CANARIES,
  scanCredentialCanaries,
} from "../../../server/backends/opencode/credential-scan"
import { evidenceRoot, saveJson } from "./common"

const positive = "GATE_POSITIVE_CONTROL_SENTINEL"
await mkdir(evidenceRoot, { recursive: true })
const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: evidenceRoot, onlyFiles: true }))
const artifacts = await Promise.all(
  files.map(async (file) => ({
    path: file,
    text: await readFile(join(evidenceRoot, file), "utf8").catch(() => ""),
  })),
)
const control = { className: "synthetic control", value: positive }

await saveJson("secret-scan-results.json", {
  date: "2026-08-27",
  positiveControl: {
    source: "direct synthetic input outside the scanned tree",
    hits: scanCredentialCanaries([{ path: "direct-input", text: positive }], [control]),
  },
  hits: scanCredentialCanaries(artifacts, OC1_CREDENTIAL_CANARIES),
})
