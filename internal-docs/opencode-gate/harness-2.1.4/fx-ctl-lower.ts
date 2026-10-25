// fx control: lower one session's event_sequence below max(session_message.seq) in a
// STOPPED control copy only (the #53146 precondition), to prove the instrument sees a collision.
import { Database } from "bun:sqlite"
const [dbPath, id, by] = process.argv.slice(2)
if (!dbPath!.startsWith("/tmp/t-4840abc5/run/fx-") || !/\/ctl[0-9]*\//.test(dbPath!)) throw new Error("control copy only")
const db = new Database(dbPath!)
const before = (db.query("select seq from event_sequence where aggregate_id=?").get(id!) as any)?.seq
const r = by!.startsWith("set:") ? db.query("update event_sequence set seq = ? where aggregate_id = ?").run(Number(by!.slice(4)), id!) : db.query("update event_sequence set seq = seq - ? where aggregate_id = ?").run(Number(by), id!)
const after = (db.query("select seq from event_sequence where aggregate_id=?").get(id!) as any)?.seq
const mm = (db.query("select max(seq) m from session_message where session_id=?").get(id!) as any).m
console.log(JSON.stringify({ changed: r.changes, before, after, maxMessageSeq: mm }))
db.close()
