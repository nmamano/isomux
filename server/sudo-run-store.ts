// The sudo runs in progress (task 43a28eed), kept on disk so that after a
// restart the agent hears that its run's result is unknown. A row is written
// when sudo starts the command and holds no password.

import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFileSync } from "./persistence.ts";

export interface SudoRunRow {
  requestId: string;
  agentId: string;
  command: string;
  startedAt: number;
  memberUserId: string;
}

export interface SudoRunStore {
  add(row: SudoRunRow): void;
  remove(requestId: string): void;
  list(): SudoRunRow[];
}

function isRow(v: unknown): v is SudoRunRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.requestId === "string" &&
    typeof r.agentId === "string" &&
    typeof r.command === "string" &&
    typeof r.startedAt === "number" &&
    typeof r.memberUserId === "string"
  );
}

// An unreadable or corrupt file reads as no rows: the rows only feed the
// restart notice.
export function createSudoRunStore(path: string): SudoRunStore {
  function read(): SudoRunRow[] {
    if (!existsSync(path)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(value) ? value.filter(isRow) : [];
    } catch {
      return [];
    }
  }
  const write = (rows: SudoRunRow[]) =>
    atomicWriteFileSync(path, JSON.stringify(rows), 0o600);
  return {
    add: (row) => write([...read(), row]),
    remove: (requestId) =>
      write(read().filter((row) => row.requestId !== requestId)),
    list: read,
  };
}
