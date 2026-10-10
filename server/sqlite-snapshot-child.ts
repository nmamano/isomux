// A separate process keeps VACUUM's synchronous work off the office event loop
// and lets the parent kill a stalled backup. Never serve this as an HTTP route.
import { Database } from "bun:sqlite";
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Snapshot paths required");
const db = new Database(source, { readwrite: true });
try {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.query("VACUUM INTO ?").run(destination);
} finally { db.close(); }
const snapshot = new Database(destination, { readonly: true });
try {
  const rows = snapshot.query("PRAGMA integrity_check").all() as {integrity_check:string}[];
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("SQLite snapshot integrity check failed");
} finally { snapshot.close(); }
