// Moving one conversation between two accounts of the same engine
// (server/session-account-move.ts, task 2008c993). Seam: the module's own
// functions over real folders under the test state root. The agent manager's
// use of them is in server/test-support/provider-fallback.test.ts, and the
// runner entry in server/agent-runner/runner.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { claudeProjectDir } from "./cwd-utils.ts";
import {
  codexHomeOfThread,
  copySessionFiles,
  removeSessionSource,
  type SessionMove,
} from "./session-account-move.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

const made: string[] = [];
const locked: string[] = [];
afterEach(() => {
  // A test that failed between its chmod and its restore.
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
  for (const dir of made.splice(0)) removeStateDir(dir);
});

function scratch(): string {
  const dir = join(STATE_ROOT, `session-move-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  made.push(dir);
  return dir;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// Every file under `root`, by its path relative to `root`, with its text.
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

// What Claude keeps for one session in an account folder (CLAUDE_CONFIG_DIR),
// relative to it: the transcript, its subagents folder, and the per-session
// folders and todo files.
function claudeParts(cwd: string, root: string, sid: string) {
  const project = relative(
    root,
    claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: root }),
  );
  return {
    [join(project, `${sid}.jsonl`)]: `transcript ${sid}\n`,
    [join(project, sid, "subagents", "agent-a1.jsonl")]: `subagent ${sid}\n`,
    [join("session-env", sid, "hook-1.sh")]: `env ${sid}\n`,
    [join("tasks", sid, "1.json")]: `task ${sid}\n`,
    [join("todos", `${sid}-agent-${sid}.json`)]: `todo ${sid}\n`,
    [join("file-history", sid, "abc@v1")]: `history ${sid}\n`,
  };
}

function seed(root: string, parts: Record<string, string>): void {
  for (const [path, text] of Object.entries(parts)) put(join(root, path), text);
}

function claudeFixture() {
  const base = scratch();
  const cwd = join(base, "work");
  const fromRoot = join(base, "member");
  const toRoot = join(base, "office");
  mkdirSync(cwd, { recursive: true });
  const sid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const parts = claudeParts(cwd, fromRoot, sid);
  const otherParts = claudeParts(cwd, fromRoot, other);
  // The account's own files, which belong to no session.
  const own = { ".credentials.json": "secret", "settings.json": "{}" };
  seed(fromRoot, { ...parts, ...otherParts, ...own });
  const move: SessionMove = {
    engine: "claude",
    sessionId: sid,
    cwd,
    fromRoot,
    toRoot,
  };
  return { cwd, fromRoot, toRoot, sid, parts, otherParts, own, move };
}

describe("a Claude conversation", () => {
  it("copies every file of the session and nothing else, then removes only its source", () => {
    const f = claudeFixture();
    copySessionFiles(f.move);
    expect(tree(f.toRoot)).toEqual(f.parts);
    // The copy leaves the source whole.
    expect(tree(f.fromRoot)).toEqual({ ...f.parts, ...f.otherParts, ...f.own });

    removeSessionSource(f.move);
    expect(tree(f.fromRoot)).toEqual({ ...f.otherParts, ...f.own });
    expect(tree(f.toRoot)).toEqual(f.parts);
  });

  it("copies a session that has only its transcript", () => {
    const f = claudeFixture();
    const transcript = Object.keys(f.parts)[0];
    const base = scratch();
    const fromRoot = join(base, "member");
    const toRoot = join(base, "office");
    put(join(fromRoot, transcript), f.parts[transcript]);
    const move: SessionMove = { ...f.move, fromRoot, toRoot };
    copySessionFiles(move);
    expect(tree(toRoot)).toEqual({ [transcript]: f.parts[transcript] });
    removeSessionSource(move);
    expect(tree(fromRoot)).toEqual({});
  });

  it("throws when the session has no transcript in the source, and writes no transcript", () => {
    const f = claudeFixture();
    const move: SessionMove = { ...f.move, sessionId: crypto.randomUUID() };
    expect(() => copySessionFiles(move)).toThrow();
    expect(tree(f.toRoot)).toEqual({});
    // The same folders move a session that has one.
    copySessionFiles(f.move);
    expect(tree(f.toRoot)).toEqual(f.parts);
  });

  it("puts the source over a file already at the final name", () => {
    // A move that stopped after its rename and before the new pin: the next
    // try copies the same conversation again.
    const f = claudeFixture();
    const transcript = Object.keys(f.parts)[0];
    put(join(f.toRoot, transcript), "stale\n");
    copySessionFiles(f.move);
    expect(tree(f.toRoot)).toEqual(f.parts);
  });

  it("throws at a part it cannot read, keeps the source, and a retry leaves no temporary copy", () => {
    const f = claudeFixture();
    const part = join(f.fromRoot, "tasks", f.sid);
    chmodSync(part, 0o000);
    locked.push(part);
    expect(() => copySessionFiles(f.move)).toThrow();
    chmodSync(part, 0o700);
    locked.pop();
    expect(tree(f.fromRoot)).toEqual({ ...f.parts, ...f.otherParts, ...f.own });

    copySessionFiles(f.move);
    // Exactly the session's files: a temporary copy the failed try left in
    // the target is gone.
    expect(tree(f.toRoot)).toEqual(f.parts);
  });
});

// A Codex rollout as Codex names it: sessions/<yyyy>/<mm>/<dd>/
// rollout-<time>-<thread id>.jsonl under CODEX_HOME.
function rolloutPath(threadId: string, day = "26"): string {
  return join(
    "sessions",
    "2026",
    "10",
    day,
    `rollout-2026-10-${day}T10-00-00-${threadId}.jsonl`,
  );
}

function codexFixture() {
  const base = scratch();
  const fromHome = join(base, "member");
  const toHome = join(base, "office");
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const mine = { [rolloutPath(tid)]: `rollout ${tid}\n` };
  const theirs = { [rolloutPath(other, "25")]: `rollout ${other}\n` };
  const own = { "auth.json": "secret", "config.toml": "" };
  seed(fromHome, { ...mine, ...theirs, ...own });
  const move: SessionMove = {
    engine: "codex",
    threadId: tid,
    fromHome,
    toHome,
  };
  return { fromHome, toHome, tid, mine, theirs, own, move };
}

describe("a Codex conversation", () => {
  it("copies the rollout to the same path under the other home, then removes only its source", () => {
    const f = codexFixture();
    copySessionFiles(f.move);
    expect(tree(f.toHome)).toEqual(f.mine);
    expect(tree(f.fromHome)).toEqual({ ...f.mine, ...f.theirs, ...f.own });
    removeSessionSource(f.move);
    expect(tree(f.fromHome)).toEqual({ ...f.theirs, ...f.own });
    expect(tree(f.toHome)).toEqual(f.mine);
  });

  it("throws when the home has no rollout of the thread, and writes nothing", () => {
    const f = codexFixture();
    expect(() =>
      copySessionFiles({ ...f.move, threadId: crypto.randomUUID() }),
    ).toThrow();
    expect(tree(f.toHome)).toEqual({});
    // The same homes move a thread that has one.
    copySessionFiles(f.move);
    expect(tree(f.toHome)).toEqual(f.mine);
  });

  it("finds the home that holds the thread, the first one when both do", () => {
    const f = codexFixture();
    const empty = join(scratch(), "no-sessions");
    expect(codexHomeOfThread(f.tid, [empty, f.toHome, f.fromHome])).toBe(
      f.fromHome,
    );
    copySessionFiles(f.move);
    expect(codexHomeOfThread(f.tid, [f.toHome, f.fromHome])).toBe(f.toHome);
    expect(codexHomeOfThread(f.tid, [f.fromHome, f.toHome])).toBe(f.fromHome);
    expect(codexHomeOfThread(crypto.randomUUID(), [f.fromHome, f.toHome])).toBe(
      null,
    );
  });
});
