// r2 Probe A add-on (2026-10-25): 2.1.4 catalog size as seen through GET /api/integration,
// default vs OPENCODE_DISABLE_MODELS_FETCH=1; read at t0 and after models-dev.refreshed (or 20 s).
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeProfile } from "./common.ts"
import { startServer2 } from "./cc-start.ts"
import { tapAs, list } from "./r2-lib.ts"
const root = process.argv[2]!
const res: any[] = []
for (const [label, off] of [["v2-default", false], ["v2-fetchoff", true]] as const) {
  const p = makeProfile(join(root, label))
  const s = await startServer2(p, { env: { GATE_API_KEY: undefined, ...(off ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}) }, logPath: join(root, label, "server.log") })
  const r: any = { label, pid: s.pid }
  try {
    const tap = await tapAs(s, "opencode", join(root, label, "events.jsonl"), "/api/event")
    const read = async () => {
      const i = await s.api("GET", "/api/integration")
      const items = list(i.body)
      const kinds: Record<string, number> = {}
      for (const x of items) kinds[x.type ?? x.kind ?? "?"] = (kinds[x.type ?? x.kind ?? "?"] ?? 0) + 1
      return { status: i.status, count: items.length, kinds, sampleKeys: items[0] ? Object.keys(items[0]) : [], sample: items[0] ? JSON.stringify(items[0]).slice(0, 300) : JSON.stringify(i.body).slice(0, 300) }
    }
    r.t0 = await read()
    const ev = await tap.waitFor((e) => e.type === "models-dev.refreshed", 20_000).catch(() => null)
    r.refreshed = !!ev
    await Bun.sleep(1500)
    r.t1 = await read()
    tap.close()
  } finally { await s.stop() }
  r.exited = s.proc.exitCode !== null || s.proc.signalCode !== null
  res.push(r)
}
writeFileSync(join(root, "integration.json"), JSON.stringify(res, null, 2))
console.log(JSON.stringify(res, null, 1))
process.exit(0)
