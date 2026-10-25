import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { openCodeDatabasePath, openCodeProfilePaths } from "./profile-paths.ts";
import {
  inspectOpenCodeDatabase,
  inspectOpenCodeStoredSession,
} from "./storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// The session_v2 and session_message tables of @opencode/cli 2.1.4, as a
// fresh 2.1.4 profile created them on 2026-10-25 (task e47be82a). 2.1.4 has
// no session or message table.
const SESSION_COLUMNS = `
  id TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT,
  fork_session_id TEXT, fork_boundary TEXT, slug TEXT, directory TEXT,
  path TEXT, title TEXT, version TEXT, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, metadata TEXT, cost REAL, tokens_input INTEGER,
  tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
  tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT,
  model TEXT, time_created INTEGER, time_updated INTEGER, time_idle INTEGER,
  time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER,
  time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER`;

function fixture(): { root: string; path: string; database: Database } {
  const root = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-test-"));
  roots.push(root);
  const path = join(root, "opencode.db");
  const database = new Database(path);
  database.exec(`CREATE TABLE session_v2 (${SESSION_COLUMNS})`);
  database.exec(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  return { root, path, database };
}

const addMessage = (
  database: Database,
  id: string,
  session: string,
  type: string,
) =>
  database
    .query(
      "INSERT INTO session_message (id, session_id, type) VALUES (?, ?, ?)",
    )
    .run(id, session, type);

describe("OpenCode stored session inspection", () => {
  it("distinguishes missing, empty, and durable sessions", () => {
    const { path, database } = fixture();
    for (const id of ["empty", "selected", "durable", "answered"])
      database.query("INSERT INTO session_v2 (id) VALUES (?)").run(id);
    // A model pick before the first prompt stores an item no one wrote.
    addMessage(database, "m-switch", "selected", "model-switched");
    addMessage(database, "m-system", "selected", "system");
    addMessage(database, "m-user", "durable", "user");
    addMessage(database, "m-answer", "answered", "assistant");
    expect(inspectOpenCodeDatabase(path, "missing")).toBe("missing");
    expect(inspectOpenCodeDatabase(path, "empty")).toBe("empty");
    // MUTANT: any item counts, so a session with no conversation resumes.
    expect(inspectOpenCodeDatabase(path, "selected")).toBe("empty");
    expect(inspectOpenCodeDatabase(path, "durable")).toBe("durable");
    expect(inspectOpenCodeDatabase(path, "answered")).toBe("durable");
    database.close();
  });

  it("reads a clean-shutdown WAL snapshot when no shm file exists", () => {
    const source = fixture();
    source.database.exec("PRAGMA journal_mode = WAL");
    source.database.exec("PRAGMA wal_autocheckpoint = 0");
    source.database.query("INSERT INTO session_v2 (id) VALUES (?)").run("wal");
    addMessage(source.database, "message-wal", "wal", "user");
    const target = join(source.root, "snapshot.db");
    copyFileSync(source.path, target);
    copyFileSync(`${source.path}-wal`, `${target}-wal`);
    expect(inspectOpenCodeDatabase(target, "wal")).toBe("durable");
    source.database.close();
  });

  // Task 8ee6d90e: the profile is owner-only. For another user a denied stat
  // must keep the stored id, never read as a missing session.
  it.skipIf(process.getuid?.() === 0)(
    "fails instead of answering missing when the folder denies access",
    () => {
      const { root, path, database } = fixture();
      database.query("INSERT INTO session_v2 (id) VALUES (?)").run("durable");
      database.close();
      expect(inspectOpenCodeDatabase(join(root, "absent.db"), "durable")).toBe(
        "missing",
      );
      chmodSync(root, 0o600);
      try {
        expect(() => inspectOpenCodeDatabase(path, "durable")).toThrow();
      } finally {
        chmodSync(root, 0o700);
      }
    },
  );

  it("fails loudly on schema drift and corruption", () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-bad-"));
    roots.push(root);
    // Only a column the inspection never queries is gone: the column check,
    // not a failed query, refuses it.
    const drifted = fixture();
    drifted.database.exec("ALTER TABLE session_v2 DROP COLUMN time_archived");
    drifted.database.close();
    expect(() => inspectOpenCodeDatabase(drifted.path, "session")).toThrow(
      /session_v2 table schema drifted/,
    );
    const driftedMessages = fixture();
    driftedMessages.database.exec(
      "ALTER TABLE session_message DROP COLUMN seq",
    );
    driftedMessages.database.close();
    expect(() =>
      inspectOpenCodeDatabase(driftedMessages.path, "session"),
    ).toThrow(/session_message table schema drifted/);
    // An OpenCode 1 database: 2.1.4's tables are not there.
    const v1Root = mkdtempSync(join(tmpdir(), "isomux-opencode-storage-v1-"));
    roots.push(v1Root);
    const v1 = new Database(join(v1Root, "opencode.db"));
    v1.exec("CREATE TABLE session (id TEXT)");
    v1.exec("CREATE TABLE message (id TEXT, session_id TEXT)");
    v1.close();
    expect(() =>
      inspectOpenCodeDatabase(join(v1Root, "opencode.db"), "session"),
    ).toThrow(/session_v2 table schema drifted/);
    const corrupt = join(root, "corrupt.db");
    writeFileSync(corrupt, "not sqlite");
    expect(() => inspectOpenCodeDatabase(corrupt, "session")).toThrow(
      "unreadable or has an unsupported schema",
    );
  });
});

// Task 75904a56: 2.1.4 runs on a copy, opencode-v2.db, made at a profile's
// first 2.1.4 start. Until then the profile has only the version 1 database,
// and a resume check reads its session and message tables (OpenCode 1.18.35).
describe("OpenCode stored sessions across the version 2 cut-over", () => {
  const V1_SESSION_COLUMNS = `
    id TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT,
    directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER,
    summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, revert TEXT,
    permission TEXT, agent TEXT, model TEXT, time_created INTEGER,
    time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER`;

  let keys = 0;
  function profile() {
    const key = `storage-cutover-${process.pid}-${++keys}`;
    const { profileDir } = openCodeProfilePaths(key);
    roots.push(profileDir);
    mkdirSync(dirname(openCodeDatabasePath(profileDir, "v1")), {
      recursive: true,
    });
    return { key, profileDir };
  }

  function versionOne(profileDir: string, sessions: Record<string, number>) {
    const database = new Database(openCodeDatabasePath(profileDir, "v1"));
    database.exec(`CREATE TABLE session (${V1_SESSION_COLUMNS})`);
    database.exec(
      "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    for (const [id, messages] of Object.entries(sessions)) {
      database.query("INSERT INTO session (id) VALUES (?)").run(id);
      for (let n = 0; n < messages; n++)
        database
          .query("INSERT INTO message (id, session_id) VALUES (?, ?)")
          .run(`${id}-${n}`, id);
    }
    database.close();
  }

  function versionTwo(profileDir: string, sessions: Record<string, number>) {
    const database = new Database(openCodeDatabasePath(profileDir, "v2"));
    database.exec(`CREATE TABLE session_v2 (${SESSION_COLUMNS})`);
    database.exec(
      "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    for (const [id, messages] of Object.entries(sessions)) {
      database.query("INSERT INTO session_v2 (id) VALUES (?)").run(id);
      for (let n = 0; n < messages; n++)
        addMessage(database, `${id}-${n}`, id, "user");
    }
    database.close();
  }

  it("reads the version 1 database of a profile that 2.1.4 has not started on yet", () => {
    const { key, profileDir } = profile();
    versionOne(profileDir, { durable: 2, empty: 0 });
    expect(inspectOpenCodeStoredSession("durable", key)).toBe("durable");
    expect(inspectOpenCodeStoredSession("empty", key)).toBe("empty");
    expect(inspectOpenCodeStoredSession("absent", key)).toBe("missing");
  });

  // The import runs in the server after its start: until it completes,
  // opencode-v2.db lacks sessions that opencode.db holds.
  it("reads the version 1 database while the version 2 one is not ready", () => {
    const { key, profileDir } = profile();
    versionOne(profileDir, { "only-in-v1": 1 });
    versionTwo(profileDir, {});
    expect(inspectOpenCodeStoredSession("only-in-v1", key)).toBe("durable");
  });

  it("reads only the version 2 database once it is ready", () => {
    const { key, profileDir } = profile();
    // The version 1 file stays for a rollback; 2.1.4 never writes it.
    versionOne(profileDir, { "only-in-v1": 1, both: 0 });
    versionTwo(profileDir, { both: 1, "only-in-v2": 0 });
    writeFileSync(`${openCodeDatabasePath(profileDir, "v2")}.ready`, "");
    expect(inspectOpenCodeStoredSession("only-in-v1", key)).toBe("missing");
    expect(inspectOpenCodeStoredSession("both", key)).toBe("durable");
    expect(inspectOpenCodeStoredSession("only-in-v2", key)).toBe("empty");
  });

  it("answers missing for a profile with no database", () => {
    const { key } = profile();
    expect(inspectOpenCodeStoredSession("any", key)).toBe("missing");
  });
});
