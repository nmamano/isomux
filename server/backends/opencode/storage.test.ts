import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectOpenCodeDatabase } from "./storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const SESSION_COLUMNS = `
  id TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT,
  directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, metadata TEXT, cost REAL, tokens_input INTEGER,
  tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
  tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT,
  model TEXT, time_created INTEGER, time_updated INTEGER,
  time_compacting INTEGER, time_archived INTEGER`;

function fixture(): { root: string; path: string; database: Database } {
  const root = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-test-"));
  roots.push(root);
  const path = join(root, "opencode.db");
  const database = new Database(path);
  database.exec(`CREATE TABLE session (${SESSION_COLUMNS})`);
  database.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  return { root, path, database };
}

describe("OpenCode stored session inspection", () => {
  it("distinguishes missing, empty, and durable sessions", () => {
    const { path, database } = fixture();
    database.query("INSERT INTO session (id) VALUES (?)").run("empty");
    database.query("INSERT INTO session (id) VALUES (?)").run("durable");
    database
      .query("INSERT INTO message (id, session_id) VALUES (?, ?)")
      .run("message-1", "durable");
    expect(inspectOpenCodeDatabase(path, "missing")).toBe("missing");
    expect(inspectOpenCodeDatabase(path, "empty")).toBe("empty");
    expect(inspectOpenCodeDatabase(path, "durable")).toBe("durable");
    database.close();
  });

  it("reads a clean-shutdown WAL snapshot when no shm file exists", () => {
    const source = fixture();
    source.database.exec("PRAGMA journal_mode = WAL");
    source.database.exec("PRAGMA wal_autocheckpoint = 0");
    source.database.query("INSERT INTO session (id) VALUES (?)").run("wal");
    source.database
      .query("INSERT INTO message (id, session_id) VALUES (?, ?)")
      .run("message-wal", "wal");
    const target = join(source.root, "snapshot.db");
    copyFileSync(source.path, target);
    copyFileSync(`${source.path}-wal`, `${target}-wal`);
    expect(inspectOpenCodeDatabase(target, "wal")).toBe("durable");
    source.database.close();
  });

  it("fails loudly on schema drift and corruption", () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-bad-"));
    roots.push(root);
    const drift = join(root, "drift.db");
    const database = new Database(drift);
    database.exec("CREATE TABLE session (id TEXT)");
    database.exec("CREATE TABLE message (id TEXT)");
    database.close();
    expect(() => inspectOpenCodeDatabase(drift, "session")).toThrow(
      "unsupported schema",
    );
    const corrupt = join(root, "corrupt.db");
    writeFileSync(corrupt, "not sqlite");
    expect(() => inspectOpenCodeDatabase(corrupt, "session")).toThrow(
      "unreadable or has an unsupported schema",
    );
  });
});
