// fx: per-session v1 event_sequence vs max(event.seq) on a stopped snapshot (counts only).
import { Database } from "bun:sqlite"
const db = new Database(process.argv[2]!, { readonly: true })
const cols = (t: string) => (db.query(`pragma table_info("${t}")`).all() as any[]).map((r) => r.name)
const ids = (db.query("select id from session order by time_created").all() as any[]).map((r) => r.id)
console.log(JSON.stringify({ eventCols: cols("event"), seqCols: cols("event_sequence") }))
const per = ids.map((id, i) => ({
  s: `s${i + 1}`,
  v1EventSequence: (db.query("select seq from event_sequence where aggregate_id=?").get(id) as any)?.seq ?? null,
  v1MaxEventSeq: (db.query("select max(seq) m, count(*) c from event where aggregate_id=?").get(id) as any),
  v1Messages: (db.query("select count(*) c from message where session_id=?").get(id) as any).c,
}))
console.log(JSON.stringify(per))
const nonSession = (db.query("select count(*) c from event_sequence where aggregate_id not in (select id from session)").get() as any).c
console.log(JSON.stringify({ nonSessionCounters: nonSession }))
