// Each backend's resume check states the PROBLEM only, as a message each
// reader words (tasks beb6089b, c37a7365). The hint what to do next ("/resume ...") belongs to the
// log entry that shows the failure, so a backend that also gave one put the
// hint in the log twice.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";
import { opencodeBackend } from "./opencode/adapter.ts";
import { openCodeProfilePaths } from "./opencode/profile-paths.ts";
import type { Backend } from "./types.ts";
import {
  localizeLogParts,
  renderLogText,
} from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";

const SESSION = "0b1f0c3e-1111-4222-8333-444455556666";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-resume-check-"));
  dirs.push(dir);
  return dir;
}

// The columns storage.ts checks for (as in opencode/storage.test.ts).
const SESSION_COLUMNS = `
  id TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT,
  directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  summary_diffs TEXT, metadata TEXT, cost REAL, tokens_input INTEGER,
  tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
  tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT,
  model TEXT, time_created INTEGER, time_updated INTEGER,
  time_compacting INTEGER, time_archived INTEGER`;

// An OpenCode profile whose database has the session but no message.
function openCodeEmptySession(environmentKey: string): void {
  const { profileDir, dataHome } = openCodeProfilePaths(environmentKey);
  dirs.push(profileDir);
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const database = new Database(join(dataHome, "opencode", "opencode.db"));
  database.exec(`CREATE TABLE session (${SESSION_COLUMNS})`);
  database.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  database.query("INSERT INTO session (id) VALUES (?)").run(SESSION);
  database.close();
}

type Opts = Parameters<Backend["checkSessionResumable"]>[1];
const cases: [string, Backend, () => Opts][] = [
  [
    "Claude, no session file",
    claudeBackend,
    () => ({ cwd: tempDir(), env: { CLAUDE_CONFIG_DIR: tempDir() } }),
  ],
  [
    "Codex, no rollout file",
    codexBackend,
    () => ({ cwd: tempDir(), env: { CODEX_HOME: tempDir() } }),
  ],
  [
    "OpenCode, no stored session",
    opencodeBackend,
    () => ({
      cwd: tempDir(),
      environmentKey: `beb6089b-missing-${process.pid}`,
    }),
  ],
  [
    "OpenCode, a session with no messages",
    opencodeBackend,
    () => {
      const environmentKey = `beb6089b-empty-${process.pid}`;
      openCodeEmptySession(environmentKey);
      return { cwd: tempDir(), environmentKey };
    },
  ],
];

describe("checkSessionResumable", () => {
  for (const [name, backend, opts] of cases) {
    it(`${name}: one message each reader words, with no /resume hint`, () => {
      const problem = backend.checkSessionResumable(SESSION, opts());
      // The enabling condition: the session really is not resumable.
      expect(problem).not.toBeNull();
      expect(typeof problem).toBe("object");
      const english = renderLogText(translatorFor("en"), problem!);
      const catalan = localizeLogParts(translatorFor("ca"), [problem]);
      expect(catalan).not.toBeNull();
      expect(catalan).not.toBe(english);
      expect(english).not.toContain("/resume");
    });
  }
});
