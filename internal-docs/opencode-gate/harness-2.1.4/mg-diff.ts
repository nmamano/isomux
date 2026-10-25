// mg census diff: names what changed between two censuses, with path
// components that could carry real names replaced by short hashes.
// Usage: bun run mg-diff.ts <before.json> <after.json> <out.json> [label]
import { createHash } from "node:crypto"
const [a, b, out, label] = process.argv.slice(2)
const A = JSON.parse(await Bun.file(a!).text())
const B = JSON.parse(await Bun.file(b!).text())
const KNOWN = new Set([
  "config", "data", "state", "cache", "home", "tmp", "opencode", "log", "snapshot", "repos", "tool-output", "opencode.db",
  "opencode.db-wal", "opencode.db-shm", "auth.json", "mcp-auth.json", "opencode.log", "opencode.log.1", "opencode.json",
  "isomux-safety-plugin.js", "server.lock", "node_modules", "package.json", "package-lock.json", ".gitignore", "bin",
  "models.json", "locks", "shell", "npm", "storage", "bun", ".bun", "install", "service.json", "kv.json", "prompt-history.jsonl",
])
const mask = (p: string) =>
  p
    .split("/")
    .map((c) => (KNOWN.has(c) || /^\d{4}-\d{2}-\d{2}T[\d-]+\.log$/.test(c) ? c : "h:" + createHash("sha256").update(c).digest("hex").slice(0, 8)))
    .join("/")
const added: unknown[] = []
const removed: unknown[] = []
const changed: unknown[] = []
for (const [p, v] of Object.entries<any>(B.files)) {
  const o = A.files[p]
  if (!o) added.push({ path: mask(p), type: v.type, size: v.size, mode: v.mode })
  else if (o.type !== v.type || o.sha256 !== v.sha256 || o.mode !== v.mode)
    changed.push({ path: mask(p), type: v.type, sizeBefore: o.size, sizeAfter: v.size, modeBefore: o.mode, modeAfter: v.mode, contentChanged: o.sha256 !== v.sha256 })
}
for (const [p, v] of Object.entries<any>(A.files)) if (!B.files[p]) removed.push({ path: mask(p), type: v.type, size: v.size })
const tables: Record<string, unknown> = {}
for (const t of new Set([...Object.keys(A.tables), ...Object.keys(B.tables)]))
  if (A.tables[t] !== B.tables[t]) tables[t] = { before: A.tables[t] ?? "absent", after: B.tables[t] ?? "absent" }
const res = {
  label,
  date: "2026-10-25",
  method: "mg-census.ts: every path with size+sha256+mode; tables via bun:sqlite readonly on a db copy taken with the server stopped. Path components outside a fixed list of OpenCode layout names are hashed (h:<8 hex>).",
  fileCountBefore: A.fileCount,
  fileCountAfter: B.fileCount,
  added,
  removed,
  changed,
  tablesChanged: tables,
  tablesBefore: Object.keys(A.tables).length,
  tablesAfter: Object.keys(B.tables).length,
  extraBefore: { ...A.extra, credentials: A.extra.credentials?.map((c: any) => c.integration_id) },
  extraAfter: { ...B.extra, credentials: B.extra.credentials?.map((c: any) => c.integration_id) },
}
await Bun.write(out!, JSON.stringify(res, null, 2) + "\n")
console.log(JSON.stringify(res, null, 1))
