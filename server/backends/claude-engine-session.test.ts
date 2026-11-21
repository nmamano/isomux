// Claude's part of the office's own link to an agent's conversation (task
// 3a2de351). Claude Code's sweep (2.1.322) deletes a transcript by its mtime
// in the background a few seconds after a process starts, and skips no
// session, not even the one that process resumes. So before the CLI starts
// on a resumed session, the session's files are put back from the store and
// touched: in this process for a local host, by the runner for a runner host
// (split office, isolated member), which gets the step with the spawn.
// The engine's own "No conversation found" decides when nothing helps, so
// the office preflight no longer refuses a missing transcript.
//
// Seams: FakeSdkClient (the moment the SDK would start the CLI) for a local
// host; for a runner host, the real SDK client with a recording office host,
// whose spawnChild is where the SDK starts the CLI.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  officeAgentHost,
  setOfficeAgentHost,
  type AgentHost,
  type SpawnChildOptions,
} from "../agent-host.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { keepSessionFiles } from "../engine-session-store.ts";
import { FakeSdkClient } from "../test-support/fake-sdk-client.ts";
import {
  claudeBackend,
  createClaudeBackend,
  type SdkClient,
} from "./claude.ts";
import type { CreateSessionOptions } from "./types.ts";

const SID = "c1a0de55-0000-4000-8000-000000000001";
const AGENT = "agent-claude-engine-session";
const DAY_MS = 24 * 60 * 60 * 1000;
const FILES = [
  `${SID}.jsonl`,
  `${SID}/subagents/agent-a.jsonl`,
  `${SID}/tool-results/t1.txt`,
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "claude-engine-session-"));
  dirs.push(base);
  const cwd = join(base, "work");
  mkdirSync(cwd, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: join(base, "claude-home") };
  const root = claudeProjectDir(cwd, env);
  const agentStore = join(base, "agent-root", "engine-sessions", AGENT);
  const store = join(agentStore, SID);
  const opts: CreateSessionOptions = {
    agentId: AGENT,
    cwd,
    systemPrompt: "prompt",
    modelFamily: "haiku",
    effort: "high",
    permissionMode: "default",
    env,
    engineSessionStore: store,
  } as CreateSessionOptions;
  return { base, cwd, env, root, agentStore, store, opts };
}

// The engine's files of the session, `ageDays` old.
function engineFiles(root: string, ageDays: number): void {
  const t = new Date(Date.now() - ageDays * DAY_MS);
  for (const f of FILES) {
    const p = join(root, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `content of ${f}\n`);
    utimesSync(p, t, t);
  }
}

// What each file looked like when the SDK was asked to start the CLI.
type Seen = Record<string, { ino: number; mtimeMs: number } | null>;
function look(root: string): Seen {
  const seen: Seen = {};
  for (const f of FILES) {
    try {
      const s = statSync(join(root, f));
      seen[f] = { ino: s.ino, mtimeMs: s.mtimeMs };
    } catch {
      seen[f] = null;
    }
  }
  return seen;
}

class LookingSdkClient extends FakeSdkClient {
  seen: Seen | null = null;
  constructor(private readonly root: string) {
    super();
  }
  override resumeSession(...args: Parameters<SdkClient["resumeSession"]>) {
    this.seen = look(this.root);
    return super.resumeSession(...args);
  }
}

const freshMs = () => Date.now() - 60_000;

describe("a resumed Claude session on a local host", () => {
  // The sweep took the files; the store has them.
  // MUTANTS: resumeSession runs no prepare step (the files are missing when
  // the CLI starts); the step after the SDK call (same); the restored files
  // keep their old mtime (the new process sweeps them again); the session's
  // folder not restored (the transcript points at tool results by path).
  it("puts back every file of the session from its store, touched, before the CLI starts", () => {
    const f = fixture();
    engineFiles(f.root, 40);
    keepSessionFiles({
      root: f.root,
      entries: claudeBackend.sessionFiles!(SID, { cwd: f.cwd, env: f.env })!
        .entries,
      agentStore: f.agentStore,
      sessionId: SID,
    });
    rmSync(f.root, { recursive: true });
    const sdk = new LookingSdkClient(f.root);
    createClaudeBackend(sdk).resumeSession(SID, f.opts).close();
    expect(sdk.resumeCalls).toHaveLength(1);
    for (const file of FILES) {
      const seen = sdk.seen?.[file];
      expect([file, seen === null || seen === undefined]).toEqual([
        file,
        false,
      ]);
      expect([file, seen!.ino]).toEqual([
        file,
        statSync(join(f.store, file)).ino,
      ]);
      expect([file, seen!.mtimeMs > freshMs()]).toEqual([file, true]);
    }
  });

  // A schedule run resumes with no store: the touch alone keeps the run's
  // own CLI from sweeping the session it resumes.
  // MUTANTS: the step skipped when engineSessionStore is absent; only the
  // transcript touched.
  it("touches the session's files when the session has no store", () => {
    const f = fixture();
    engineFiles(f.root, 40);
    const sdk = new LookingSdkClient(f.root);
    const { engineSessionStore: _none, ...noStore } = f.opts;
    createClaudeBackend(sdk).resumeSession(SID, noStore).close();
    for (const file of FILES)
      expect([file, (sdk.seen?.[file]?.mtimeMs ?? 0) > freshMs()]).toEqual([
        file,
        true,
      ]);
  });

  // MUTANT: checkSessionResumable keeps its "missing" answer for an office
  // env (the office refuses before the engine can answer).
  it("leaves a missing transcript to the engine's own verdict", () => {
    const f = fixture();
    expect(
      claudeBackend.checkSessionResumable(SID, { cwd: f.cwd, env: f.env }),
    ).toBeNull();
  });
});

describe("a resumed Claude session on a runner host", () => {
  // The office cannot touch the agent user's or the member's files: the
  // runner runs the step as that user, before it spawns the CLI.
  // MUTANTS: the descriptor not passed from resumeSession to the SDK
  // client; realV1SdkClient not passing it to withAgentSpawn;
  // spawnClaudeThroughHost not passing it to spawnChild; the store or the
  // root of another session.
  it("hands the step to the host with the spawn of the CLI", async () => {
    const f = fixture();
    const before = officeAgentHost();
    const spawned: { argv: string[]; options: SpawnChildOptions }[] = [];
    setOfficeAgentHost({
      ...before,
      kind: "runner",
      claudeBin: () => "/bin/true",
      baseEnv: () => ({}),
      spawnChild: (argv: string[], options: SpawnChildOptions = {}) => {
        spawned.push({ argv, options });
        return spawn("sleep", ["5"], { stdio: "pipe" });
      },
    } as unknown as AgentHost);
    try {
      const session = claudeBackend.resumeSession(SID, f.opts);
      try {
        const deadline = Date.now() + 2000;
        while (spawned.length === 0 && Date.now() < deadline)
          await Bun.sleep(5);
        expect(spawned).toHaveLength(1);
        expect(spawned[0].argv.join(" ")).toContain(SID);
        const prepare = spawned[0].options.prepare;
        expect(prepare?.root).toBe(f.root);
        expect(prepare?.store).toBe(f.store);
        expect(prepare?.entries).toContain(`${SID}.jsonl`);
        expect(prepare?.entries).toContain(`${SID}/`);
      } finally {
        session.close();
      }
    } finally {
      setOfficeAgentHost(before);
    }
  });
});
