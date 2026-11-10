import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  claudeProjectDir,
  claudeStoredSessionState,
  cwdProblem,
  diagnoseProcessExit,
  inspectCodexStoredSession,
  pathWithBundledClaude,
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
// Task 5d8e6cd4: a Claude process killed during its first turn leaves a
// transcript with bookkeeping lines only, and the CLI answers its resume with
// "No conversation found". Only that proof reads as "empty"; any doubt reads
// as "durable", which keeps the resume.
describe("claudeStoredSessionState", () => {
  const SESSION = "00000000-aaaa-4bbb-8ccc-000000000001";
  const CWD = "/work/project";
  // The shape of the incident's file: an owner line and a queued input that
  // was taken, and no conversation entry.
  const BOOKKEEPING =
    [
      { type: "session-owner", sessionId: SESSION },
      { type: "queue-operation", operation: "enqueue", sessionId: SESSION },
      { type: "queue-operation", operation: "dequeue", sessionId: SESSION },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const ENTRY =
    JSON.stringify({
      type: "user",
      uuid: "11111111-2222-4333-8444-555555555555",
    }) + "\n";

  function configDir(contents?: string): string {
    const root = mkdtempSync(join(tmpdir(), "isomux-claude-inspect-"));
    roots.push(root);
    if (contents !== undefined) {
      const dir = claudeProjectDir(CWD, { CLAUDE_CONFIG_DIR: root });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${SESSION}.jsonl`), contents);
    }
    return root;
  }
  const state = (root: string) =>
    claudeStoredSessionState(CWD, SESSION, { CLAUDE_CONFIG_DIR: root });

  // MUTANTS: the uuid test dropped (dies on "a conversation entry"); the
  // line-end test dropped (dies on "a last line with no line end"); the size
  // limit dropped (dies on "larger than the limit"); a non-object line read
  // as bookkeeping (dies on "a line that is not an object").
  it("is empty only for a whole file of bookkeeping lines", () => {
    const cases: [string, string | undefined, "empty" | "durable"][] = [
      ["bookkeeping only", BOOKKEEPING, "empty"],
      ["an empty file", "", "empty"],
      ["a conversation entry", BOOKKEEPING + ENTRY, "durable"],
      [
        "a last line with no line end",
        BOOKKEEPING + '{"type":"user"}',
        "durable",
      ],
      ["a line that does not parse", BOOKKEEPING + "{oops\n", "durable"],
      ["a line that is not an object", BOOKKEEPING + "42\n", "durable"],
      [
        "larger than the limit, with no entry",
        BOOKKEEPING.repeat(Math.ceil((65 * 1024) / BOOKKEEPING.length)),
        "durable",
      ],
      ["no file", undefined, "durable"],
    ];
    for (const [label, contents, expected] of cases)
      expect([label, state(configDir(contents))]).toEqual([label, expected]);
  });

  it("reads the session under the config dir it is given", () => {
    const root = configDir(BOOKKEEPING);
    expect(state(root)).toBe("empty");
    // The same id under another config dir is not proven empty.
    expect(state(configDir())).toBe("durable");
  });
});

describe("cwdProblem", () => {
  const scratch = () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-cwd-problem-"));
    roots.push(root);
    return root;
  };

  it("passes a directory and names a missing path or a file", () => {
    const dir = scratch();
    expect(cwdProblem(dir)).toBeNull();
    expect(validateCwd(dir)).toBe(dir);
    const missing = join(dir, "gone");
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    for (const [path, kind] of [
      [missing, "missing"],
      [file, "not_directory"],
    ] as const) {
      expect(cwdProblem(path)).toEqual({ kind, path });
      expect(() => validateCwd(path)).toThrow(path);
    }
  });

  it("resolves ~ before it reports the path", () => {
    const name = `isomux-cwd-problem-missing-${process.pid}`;
    expect(cwdProblem(`~/${name}`)).toEqual({
      kind: "missing",
      path: join(homedir(), name),
    });
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

// Terminals and agent shells find the agents' `claude` through PATH, not a
// link in /usr/local/bin (task 88e54847).
describe("pathWithBundledClaude", () => {
  const bin = "/opt/isomux/node_modules/sdk/claude";
  const dir = "/opt/isomux/node_modules/sdk";
  const cases: [string, string, string][] = [
    ["appends after every entry", "/usr/bin:/bin", `/usr/bin:/bin:${dir}`],
    [
      "leaves a PATH that ends with it as it is",
      `/usr/bin:${dir}`,
      `/usr/bin:${dir}`,
    ],
    ["does not move it from the front", `${dir}:/usr/bin`, `${dir}:/usr/bin`],
    ["does not add a second copy", `/a:${dir}:/b`, `/a:${dir}:/b`],
    ["an empty PATH gets the directory alone", "", dir],
    [
      "a longer entry is not a match",
      `${dir}2:${dir}/x`,
      `${dir}2:${dir}/x:${dir}`,
    ],
    ["a parent entry is not a match", "/opt/isomux", `/opt/isomux:${dir}`],
    ["keeps the other entries as they are", "/a::/b", `/a::/b:${dir}`],
  ];
  for (const [name, path, expected] of cases) {
    it(name, () => {
      expect(pathWithBundledClaude(path, bin)).toBe(expected);
    });
  }
});
