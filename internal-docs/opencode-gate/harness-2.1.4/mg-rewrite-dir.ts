// mg: point one v1 session row at a scratch directory, in a profile COPY only
// (server stopped). Usage: bun run mg-rewrite-dir.ts <copyDir> <sessionIndex> <newDir>
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
const [copy, idx, dir] = process.argv.slice(2)
if (!copy!.startsWith("/tmp/t-4840abc5/run/mg-")) throw new Error("copies under the mg run dir only")
const R = readFileSync("/tmp/t-4840abc5/run/mg-current.txt", "utf8").trim()
const v1 = JSON.parse(readFileSync(`${R}/census/v1-sessions.json`, "utf8"))
const id = v1[Number(idx)].id
const db = new Database(`${copy}/data/opencode/opencode.db`)
const r = db.query("UPDATE session SET directory = ? WHERE id = ?").run(dir!, id)
console.log(JSON.stringify({ table: "session", changed: r.changes }))
db.close()
