// Where the office starts agent-side work (internal-docs/os-user-split-design.md,
// sections 1 and 2.3). LocalAgentHost is the single-user code path: it spawns
// in this process, as this process's user. In split mode the server installs a
// RunnerAgentHost (server/agent-runner/client.ts), which asks the agent runner
// to do the same work as the agent user.

import { spawn } from "child_process";
import type { EventEmitter } from "events";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir, userInfo } from "os";
import type { Readable, Writable } from "stream";
import {
  runIsomuxDiff,
  type IsomuxDiffRequest,
  type IsomuxDiffRunResult,
} from "./isomux-diff.ts";

// The part of a child process that callers use. A Bun Subprocess satisfies it.
export interface AgentProcess {
  readonly pid: number | undefined;
  readonly stdin: {
    write(data: string | Uint8Array): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

// A long-lived child with Node streams, shaped like the part of a Node
// ChildProcess that the Claude SDK and the Codex client use. Events: "spawn",
// "exit" (code, signal), "close" (code, signal) after the output ends, and
// "error" (an Error with the errno name in code when the start failed).
export interface AgentChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  // Signal the child's whole process group: the child leads its own group.
  signalGroup(signal: NodeJS.Signals): void;
}

export interface SpawnChildOptions {
  cwd?: string;
  // The whole environment of the child; a missing key is not set. Default:
  // the host's base environment.
  env?: Record<string, string | undefined>;
  stderr?: "pipe" | "ignore";
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  // "ignore" drops the output; stdout and stderr are then "".
  output?: "pipe" | "ignore";
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// File operations in agent space. A failure rejects with an Error whose code
// is the errno name (ENOENT, EACCES, ...).
export interface AgentFs {
  readText(path: string): Promise<string>;
  writeText(
    path: string,
    text: string,
    options: { mode: number; exclusive?: boolean },
  ): Promise<void>;
  // Recursive; mode applies to the directories it creates.
  mkdir(path: string, mode: number): Promise<void>;
  // A missing path is not an error.
  rm(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface AgentHost {
  readonly kind: "local" | "runner";
  // The environment that agent processes start from: the agent user's own.
  baseEnv(): Record<string, string | undefined>;
  home(): string;
  username(): string;
  // The Bun executable used by this host, accessible to the agent user.
  bunPath(): string;
  // Start argv with piped stdin and stdout; stderr goes to the office log.
  spawnPipe(argv: string[]): AgentProcess;
  spawnChild(argv: string[], options?: SpawnChildOptions): AgentChild;
  // Run argv to its end and collect its output.
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  readonly fs: AgentFs;
  isomuxDiff(req: IsomuxDiffRequest): Promise<IsomuxDiffRunResult>;
  // A fixed entry (server/agent-runner/entries) as the agent user; its result
  // is agent-space data. Only the runner host has entries.
  runEntry(name: string, input: unknown): Promise<unknown>;
}

function spawnLocalChild(
  argv: string[],
  options: SpawnChildOptions = {},
): AgentChild {
  // detached: the child leads its own process group, so signalGroup reaches
  // its descendants too.
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", options.stderr ?? "pipe"],
    detached: true,
  });
  return Object.assign(child, {
    signalGroup(signal: NodeJS.Signals) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {}
    },
  }) as unknown as AgentChild;
}

async function runLocal(
  argv: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const output = options.output ?? "pipe";
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: output,
    stderr: output,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    proc.stderr ? new Response(proc.stderr).text() : "",
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export const localAgentFs: AgentFs = {
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, text, { mode, exclusive }) =>
    writeFile(path, text, { mode, flag: exclusive ? "wx" : "w" }),
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
  },
  rm: (path) => rm(path, { force: true }),
  exists: async (path) => existsSync(path),
  chmod: (path, mode) => chmod(path, mode),
};

export const localAgentHost: AgentHost = {
  kind: "local",
  baseEnv: () => process.env,
  home: () => homedir(),
  username: () => userInfo().username,
  bunPath: () => process.execPath,
  spawnPipe: (argv) =>
    Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
  spawnChild: spawnLocalChild,
  run: runLocal,
  fs: localAgentFs,
  runEntry: () =>
    Promise.reject(new Error("fixed entries run only in the agent runner")),
  isomuxDiff: async (req) => {
    try {
      return runIsomuxDiff(req);
    } catch (error) {
      return {
        kind: "git_error",
        cwd: req.dir ?? req.agentCwd,
        message: (error as Error).message,
      };
    }
  },
};

let current: AgentHost = localAgentHost;

// Work in agent space that is more than one file operation: the runner's
// fixed entry in split mode, the same code in process otherwise. The caller
// checks the shape of the result.
export function inAgentSpace<T>(
  name: string,
  input: unknown,
  local: () => T | Promise<T>,
): Promise<unknown> {
  const host = current;
  return host.kind === "runner"
    ? host.runEntry(name, input)
    : Promise.resolve().then(local);
}

export function getAgentHost(): AgentHost {
  return current;
}

// Called once at boot by the split-mode start (server/split/start.ts), and by
// tests that restore the default afterwards.
export function setAgentHost(host: AgentHost): void {
  current = host;
}
