import { Database, SQLiteError } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StoredSessionState } from "../types.ts";
import { openCodeProfilePaths } from "./login-wrapper.ts";

const EXPECTED_SESSION_COLUMNS = [
  "id",
  "project_id",
  "workspace_id",
  "parent_id",
  "slug",
  "directory",
  "path",
  "title",
  "version",
  "share_url",
  "summary_additions",
  "summary_deletions",
  "summary_files",
  "summary_diffs",
  "metadata",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "revert",
  "permission",
  "agent",
  "model",
  "time_created",
  "time_updated",
  "time_compacting",
  "time_archived",
] as const;

const EXPECTED_MESSAGE_COLUMNS = [
  "id",
  "session_id",
  "time_created",
  "time_updated",
  "data",
] as const;

export function inspectOpenCodeStoredSession(
  sessionId: string,
  environmentKey: string | undefined,
): StoredSessionState {
  if (!environmentKey)
    throw new Error("OpenCode session environment identity is required.");
  const databasePath = join(
    openCodeProfilePaths(environmentKey).dataHome,
    "opencode",
    "opencode.db",
  );
  return inspectOpenCodeDatabase(databasePath, sessionId);
}

export function inspectOpenCodeDatabase(
  databasePath: string,
  sessionId: string,
): StoredSessionState {
  if (!existsSync(databasePath)) return "missing";

  let snapshotDir: string | null = null;
  let path = databasePath;
  // Readonly SQLite cannot create a missing -shm file for a WAL database.
  // A clean shutdown can leave that valid state, so inspect a private copy
  // where SQLite may create only temporary coordination files.
  if (existsSync(`${databasePath}-wal`) && !existsSync(`${databasePath}-shm`)) {
    snapshotDir = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-"));
    path = join(snapshotDir, "opencode.db");
    copyFileSync(databasePath, path);
    copyFileSync(`${databasePath}-wal`, `${path}-wal`);
  }

  let database: Database | null = null;
  try {
    database = new Database(path, {
      readonly: snapshotDir === null,
      create: false,
      strict: true,
    });
    database.exec("PRAGMA query_only = ON");
    assertColumns(database, "session", EXPECTED_SESSION_COLUMNS);
    assertColumns(database, "message", EXPECTED_MESSAGE_COLUMNS);
    const session = database
      .query("SELECT 1 AS found FROM session WHERE id = ? LIMIT 1")
      .get(sessionId) as { found: number } | null;
    if (!session) return "missing";
    const message = database
      .query("SELECT 1 AS found FROM message WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { found: number } | null;
    return message ? "durable" : "empty";
  } catch (error) {
    if (isBusy(error)) {
      throw new Error(
        "OpenCode session storage is busy; retry after the active write finishes.",
        { cause: error },
      );
    }
    throw new Error(
      `OpenCode session storage is unreadable or has an unsupported schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    database?.close();
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function assertColumns(
  database: Database,
  table: string,
  expected: readonly string[],
): void {
  const actual = (
    database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>
  ).map((row) => row.name);
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `OpenCode ${table} table schema drifted (expected ${expected.join(", ")}; received ${actual.join(", ") || "no columns"}).`,
    );
  }
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof SQLiteError &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}
