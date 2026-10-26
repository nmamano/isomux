// Test support: OpenCode profiles with a 2.1.4 database, and a stand-in for
// OpenCode's session export and import (task df0e7b51). Nothing here is
// product code.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { openCodeDatabasePath, openCodeProfilePaths } from "./profile-paths.ts";
import {
  setOpenCodeSessionCliForTests,
  type OpenCodeSessionCli,
} from "./session-transfer.ts";
import { removeStateDir } from "../../test-support/temp-state.ts";

// The profile dirs a test made; other test files keep theirs.
const made = new Set<string>();

// Removes the profiles this fixture made and the stand-in CLI.
export function cleanUpProfileFixtures(): void {
  for (const dir of made) removeStateDir(dir);
  made.clear();
  setOpenCodeSessionCliForTests(null);
}

// The 2.1.4 session_v2 table (storage.test.ts, recorded 2026-10-25).
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

// A v2-ready profile for `key` that stores each session as given.
export function profile(
  key: string,
  sessions: Record<string, "durable" | "empty"> = {},
): string {
  const { profileDir } = openCodeProfilePaths(key);
  made.add(profileDir);
  const path = openCodeDatabasePath(profileDir, "v2");
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.exec(`CREATE TABLE session_v2 (${SESSION_COLUMNS})`);
  database.exec(
    "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  for (const [id, state] of Object.entries(sessions)) {
    database.query("INSERT INTO session_v2 (id) VALUES (?)").run(id);
    if (state === "durable")
      database
        .query(
          "INSERT INTO session_message (id, session_id, type) VALUES (?, ?, 'user')",
        )
        .run(`m-${id}`, id);
  }
  database.close();
  writeFileSync(`${path}.ready`, "");
  return profileDir;
}

// A profile that only OpenCode 1 has used: no v2 database, no ready marker.
export function v1OnlyProfile(key: string): string {
  const { profileDir } = openCodeProfilePaths(key);
  made.add(profileDir);
  const path = openCodeDatabasePath(profileDir, "v1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return profileDir;
}

export interface CliCalls {
  exports: { profileDir: string; sessionId: string }[];
  imports: { profileDir: string; exported: string }[];
}

export function fakeCli(
  overrides: Partial<OpenCodeSessionCli> = {},
): CliCalls & OpenCodeSessionCli {
  const calls: CliCalls = { exports: [], imports: [] };
  const cli: OpenCodeSessionCli = {
    exportSession: async (profileDir, sessionId) => {
      calls.exports.push({ profileDir, sessionId });
      return JSON.stringify({ info: { id: sessionId }, from: profileDir });
    },
    importSession: async (target, exported) => {
      calls.imports.push({ profileDir: target.profileDir, exported });
    },
    ...overrides,
  };
  setOpenCodeSessionCliForTests(cli);
  return Object.assign(calls, cli);
}
