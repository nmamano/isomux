// Ask history (task ff590b5e): every closed ask, with how it closed, in the
// ask_history table of office.sqlite. The asks store (server/asks.ts) holds
// open entries only and records each entry here after it removes it. Kept
// like the logs: no retention cap.
//
// What happened before the close (task 62aa552f), the create and each edit,
// is in the ask_events table, recorded by the store after each change, while
// the ask is open. A record carries its ask's events.
//
// A row's `seq` orders the closes and is the list's page cursor. An ask id
// names one ask: the store does not reuse an id that is in the history,
// either table.
//
// LEAF: imports only bun:sqlite, the office database and shared types.

import type { Database } from "bun:sqlite";
import { officeAuditStore } from "./audit-store.ts";
import type { AskClosure, AskEntry, AskEvent } from "../shared/types.ts";

export const ASK_HISTORY_LIMIT_DEFAULT = 50;
export const ASK_HISTORY_LIMIT_MAX = 200;

export interface AskHistoryRecord {
  seq: number;
  entry: AskEntry;
  closure: AskClosure;
  // What happened before the close, oldest first.
  events: AskEvent[];
}

export interface AskHistoryQuery {
  // Only the asks for this member.
  memberUserId?: string;
  // Only rows older than this seq.
  before?: number;
  limit: number;
}

export interface AskHistory {
  // Durable write. MUST THROW on failure.
  record(entry: AskEntry, closure: AskClosure): void;
  // An event of an ask, open or closed. Durable write. MUST THROW on failure.
  recordEvent(agentId: string, askId: string, event: AskEvent): void;
  has(id: string): boolean;
  // The agent's closed ask with this id, or null.
  get(agentId: string, id: string): AskHistoryRecord | null;
  // The closed ask with this id, whatever its agent, or null.
  getById(id: string): AskHistoryRecord | null;
  // The agent's closed asks, newest close first.
  list(
    agentId: string,
    query: AskHistoryQuery,
  ): { items: AskHistoryRecord[]; nextBefore: number | null };
}

interface Row {
  seq: number;
  record: string;
}
const parse = (row: Row): AskHistoryRecord => {
  const { entry, closure } = JSON.parse(row.record) as Omit<
    AskHistoryRecord,
    "seq" | "events"
  >;
  return { seq: row.seq, entry, closure, events: [] };
};

export function createAskHistory(db: Database): AskHistory {
  // The records with their asks' events, in one query for the page.
  function withEvents(
    agentId: string,
    records: AskHistoryRecord[],
  ): AskHistoryRecord[] {
    if (records.length === 0) return records;
    const ids = records.map((r) => r.entry.id);
    const rows = db
      .query(
        `SELECT ask_id,record FROM ask_events WHERE agent_id=? AND ask_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`,
      )
      .all(agentId, ...ids) as { ask_id: string; record: string }[];
    const byAsk = new Map<string, AskEvent[]>();
    for (const row of rows) {
      const events = byAsk.get(row.ask_id) ?? [];
      events.push(JSON.parse(row.record) as AskEvent);
      byAsk.set(row.ask_id, events);
    }
    return records.map((r) => ({ ...r, events: byAsk.get(r.entry.id) ?? [] }));
  }

  return {
    record(entry, closure) {
      db.query(
        "INSERT INTO ask_history(id,agent_id,member_user_id,closed_at,record) VALUES (?,?,?,?,?)",
      ).run(
        entry.id,
        entry.agentId,
        entry.memberUserId ?? null,
        closure.at,
        JSON.stringify({ entry, closure }),
      );
    },
    recordEvent(agentId, askId, event) {
      db.query(
        "INSERT INTO ask_events(ask_id,agent_id,record) VALUES (?,?,?)",
      ).run(askId, agentId, JSON.stringify(event));
    },
    has(id) {
      return db
        .query(
          "SELECT 1 FROM ask_history WHERE id=? UNION ALL SELECT 1 FROM ask_events WHERE ask_id=? LIMIT 1",
        )
        .get(id, id)
        ? true
        : false;
    },
    get(agentId, id) {
      const row = db
        .query(
          "SELECT seq,record FROM ask_history WHERE agent_id=? AND id=? ORDER BY seq DESC LIMIT 1",
        )
        .get(agentId, id) as Row | null;
      return row ? withEvents(agentId, [parse(row)])[0] : null;
    },
    getById(id) {
      const row = db
        .query(
          "SELECT seq,agent_id,record FROM ask_history WHERE id=? ORDER BY seq DESC LIMIT 1",
        )
        .get(id) as (Row & { agent_id: string }) | null;
      return row ? withEvents(row.agent_id, [parse(row)])[0] : null;
    },
    list(agentId, { memberUserId, before, limit }) {
      const where = ["agent_id=?"];
      const args: (string | number)[] = [agentId];
      if (memberUserId !== undefined) {
        where.push("member_user_id=?");
        args.push(memberUserId);
      }
      if (before !== undefined) {
        where.push("seq<?");
        args.push(before);
      }
      // One more than the page, to know whether a next page exists.
      args.push(limit + 1);
      const rows = db
        .query(
          `SELECT seq,record FROM ask_history WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        )
        .all(...args) as Row[];
      const items = withEvents(agentId, rows.slice(0, limit).map(parse));
      return {
        items,
        nextBefore: rows.length > limit ? items[items.length - 1].seq : null,
      };
    },
  };
}

// The history in the office database, resolved on each call: a test can
// replace the database file under a running office (officeAuditStore).
export function officeAskHistory(): AskHistory {
  const current = () => createAskHistory(officeAuditStore().db);
  return {
    record: (entry, closure) => current().record(entry, closure),
    recordEvent: (agentId, askId, event) =>
      current().recordEvent(agentId, askId, event),
    has: (id) => current().has(id),
    get: (agentId, id) => current().get(agentId, id),
    getById: (id) => current().getById(id),
    list: (agentId, query) => current().list(agentId, query),
  };
}
