import { join } from "node:path"
import { gateRoot, saveJson } from "./common"

function version(path: string) {
  const result = Bun.spawnSync([path, "--version"])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

await saveJson("versions-after.json", {
  date: "2026-08-27",
  v2Cli: version(join(gateRoot, "node_modules/opencode-v2/bin/opencode.exe")),
  v2Client: (await import("@opencode-ai/client/package.json", { with: { type: "json" } })).default.version,
  v1Cli: version(join(gateRoot, "node_modules/opencode-v1/bin/opencode.exe")),
  v1Sdk: (await import("@opencode-ai/sdk/package.json", { with: { type: "json" } })).default.version,
  disableAutoUpdate: "OPENCODE_DISABLE_AUTOUPDATE=1 in every harness launch and autoupdate=false in every gate config",
})
