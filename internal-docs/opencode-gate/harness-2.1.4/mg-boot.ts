// mg boot timing: start a server on a profile copy, record time to healthy, stop.
// Usage: bun run mg-boot.ts <v1|v2> <copyName> <proxy:on|off> <outDir>
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile, writeJson } from "./common.ts"
import { startServerT as startServer } from "./mg-server.ts"
const [ver, copy, proxy, out] = process.argv.slice(2)
const R = readFileSync("/tmp/t-4840abc5/run/mg-current.txt", "utf8").trim()
Bun.spawnSync(["mkdir", "-p", out!])
const netEnv: Record<string, string> = { OPENCODE_DISABLE_MODELS_FETCH: "1" }
if (proxy === "on") Object.assign(netEnv, { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" })
const p = makeProfile(join(R, copy!))
const t0 = Date.now()
const res: Record<string, unknown> = { date: "2026-10-25", ver, copy, proxy }
try {
  const s = await startServer(p, { v1: ver === "v1", env: netEnv, logPath: join(out!, "server.log"), configContent: ver === "v1" ? { model: "gate/gate-model" } : { model: "gate/gate-model", update: "disable" } })
  res.healthyAfterMs = Date.now() - t0
  res.pid = s.pid
  await s.stop()
} catch (e) { res.error = String(e).slice(0, 300); res.failedAfterMs = Date.now() - t0 }
writeJson(join(out!, "boot.json"), res)
console.log(JSON.stringify(res))
