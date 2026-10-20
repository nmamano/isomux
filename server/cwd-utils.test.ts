import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  cwdProblem,
  diagnoseProcessExit,
  inspectCodexStoredSession,
  validateCwd,
} from "./cwd-utils.ts";
import { renderLogText } from "../shared/i18n/log-message.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

const THREAD_ID = "019a7b3c-1111-7222-8333-123456789abc";
const roots: string[] = [];

function codexHome(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-codex-inspect-"));
  roots.push(root);
  if (contents !== undefined) {
    const sessions = join(root, "sessions", "2026", "08", "28");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-test-${THREAD_ID}.jsonl`), contents);
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("inspectCodexStoredSession", () => {
  it("distinguishes missing, header-only, and durable rollouts", () => {
    expect(
      inspectCodexStoredSession(THREAD_ID, { CODEX_HOME: codexHome() }),
    ).toBe("missing");
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome('{"type":"session_meta"}\n'),
      }),
    ).toBe("empty");
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome(
          '{"type":"session_meta"}\n{"type":"response_item"}\n',
        ),
      }),
    ).toBe("durable");
  });

  it("keeps the existing assume-durable rule for an unreadable tail", () => {
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome('{"type":"session_meta"}\n{"partial"'),
      }),
    ).toBe("durable");
  });
});

// Why a cwd cannot be used, per cause (task beb6089b). The session start
// writes each cause as a message each reader words, so the cause and the
// resolved path must come back as data, not as an English sentence.
describe("cwdProblem", () => {
  const scratch = () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-cwd-problem-"));
    roots.push(root);
    return root;
  };

  it("finds nothing wrong with a directory", () => {
    const dir = scratch();
    expect(cwdProblem(dir)).toBeNull();
    expect(validateCwd(dir)).toBe(dir);
  });

  it("names a path that does not exist", () => {
    const missing = join(scratch(), "gone");
    expect(cwdProblem(missing)).toEqual({ kind: "missing", path: missing });
    expect(() => validateCwd(missing)).toThrow(missing);
  });

  it("resolves ~ before it reports the path", () => {
    const name = `isomux-cwd-problem-missing-${process.pid}`;
    expect(cwdProblem(`~/${name}`)).toEqual({
      kind: "missing",
      path: join(homedir(), name),
    });
  });

  it("names a path that is a file", () => {
    const file = join(scratch(), "a-file");
    writeFileSync(file, "x");
    expect(cwdProblem(file)).toEqual({ kind: "not_directory", path: file });
    expect(() => validateCwd(file)).toThrow(file);
  });

  it("names a path it cannot reach, with the OS error", () => {
    const locked = join(scratch(), "locked");
    mkdirSync(locked);
    const inside = join(locked, "inside");
    mkdirSync(inside);
    chmodSync(locked, 0o000);
    try {
      const problem = cwdProblem(inside);
      expect(problem).toMatchObject({ kind: "inaccessible", path: inside });
      // The OS error as the OS wrote it: an errno, not an Isomux sentence.
      expect(problem?.message).toContain("EACCES");
      expect(() => validateCwd(inside)).toThrow(inside);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// The hint written after a Claude process exits stands alone in the log, so
// both causes are messages each reader words, and the missing-session one
// carries its own /resume hint (tasks beb6089b, c37a7365).
describe("diagnoseProcessExit", () => {
  it("words a missing cwd as a message, with the path as a value", () => {
    const missing = join(tmpdir(), `isomux-exit-cwd-${process.pid}-gone`);
    const hint = diagnoseProcessExit(missing, null, {});
    expect(hint).not.toBeNull();
    // The path is a value in the sentence, not part of the template.
    expect(Object.values(hint!.params ?? {})).toContain(missing);
  });

  it("words a missing session as a message, with one /resume hint", () => {
    const configDir = mkdtempSync(join(tmpdir(), "isomux-exit-session-"));
    roots.push(configDir);
    const cwd = mkdtempSync(join(tmpdir(), "isomux-exit-cwd-"));
    roots.push(cwd);
    const hint = diagnoseProcessExit(
      cwd,
      "0b1f0c3e-0000-4000-8000-000000000000",
      { CLAUDE_CONFIG_DIR: configDir },
    );
    expect(hint).not.toBeNull();
    const english = renderLogText(translatorFor("en"), hint!);
    expect(english.split("/resume").length - 1).toBe(1);
  });
});
