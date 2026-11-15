// Where the office starts agent-side work (internal-docs/os-user-split-design.md,
// sections 1 and 2.3). LocalAgentHost is the single-user code path: it spawns
// in this process, as this process's user. In split mode the server installs a
// RunnerAgentHost (server/agent-runner/client.ts), which asks the agent runner
// to do the same work as the agent user.

import { spawn } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir, userInfo } from "os";
import { join } from "path";
import { Readable, Writable } from "stream";
import { resolveCodexLauncherPath } from "./backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "./backends/opencode/runtime.ts";
import { CLAUDE_NATIVE_BIN } from "./cwd-utils.ts";
import { AGENT_ROOT } from "./split/roots.ts";
import {
  isolatedArgv,
  ISOLATION_SETUP_FAILED,
  signalIsolated,
  statusHasExitCode,
} from "./process-isolation.ts";
import {
  runIsomuxDiff,
  type IsomuxDiffRequest,
  type IsomuxDiffRunResult,
} from "./isomux-diff.ts";

// The env tag (internal-docs/member-os-user-design.md, slice 1a). An env
// built for an isolated member carries MEMBER_ENV = that member's user id, as
// an enumerable symbol: a spread keeps it, a spawn and JSON drop it. A member
// host refuses an env that is not tagged with its member, and an office host
// refuses any tagged env, with an error whose code is MEMBER_ENV_REFUSED: a
// spawnChild emits it as "error" (as a failed spawn), the rest reject. A net,
// not the proof.
export const MEMBER_ENV: unique symbol = Symbol("isomux.member-env");
export const MEMBER_ENV_REFUSED = "MEMBER_ENV_REFUSED";

export function tagMemberEnv<T extends object>(env: T, userId: string): T {
  (env as Record<symbol, unknown>)[MEMBER_ENV] = userId;
  return env;
}

// The member whose tag `env` carries, else undefined.
export function memberEnvOwner(env: object | undefined): string | undefined {
  const owner = env ? (env as Record<symbol, unknown>)[MEMBER_ENV] : undefined;
  return typeof owner === "string" ? owner : undefined;
}

// Null when a host whose member is `member` (undefined: an office host) may
// start a process with `env`; else the refusal. No env: the host's own base
// env, always allowed.
export function memberEnvRefusal(
  member: string | undefined,
  env: object | undefined,
): NodeJS.ErrnoException | null {
  if (env === undefined) return null;
  const owner = memberEnvOwner(env);
  if (owner === member) return null;
  return Object.assign(
    new Error(
      member === undefined
        ? "an isolated member's environment cannot start a process as the office user"
        : "this environment was not built for the member whose OS user runs it",
    ),
    { code: MEMBER_ENV_REFUSED },
  );
}

// A child that never started: "error" with `error`, on the next tick, as a
// failed spawn reports it. No "exit" or "close" follows.
export function failedAgentChild(error: Error): AgentChild {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdin = new Writable({
    write: (_chunk, _encoding, done) => done(),
  });
  const stdout = new Readable({ read() {} });
  stdout.push(null);
  Object.assign(child, {
    pid: undefined,
    stdin,
    stdout,
    stderr: null,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => false,
    signalGroup: () => {},
  });
  setTimeout(() => child.emit("error", error), 0);
  return child as unknown as AgentChild;
}

// A process that never started: no output, exit status 127.
export function failedAgentProcess(): AgentProcess {
  return {
    pid: undefined,
    stdin: { write: () => 0, end: () => undefined },
    stdout: new ReadableStream({ start: (c) => c.close() }),
    exited: Promise.resolve(127),
    kill: () => {},
  };
}

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
  // Run argv in its own PID namespace (server/process-isolation.ts). The
  // caller decides; the host only applies it.
  isolate?: boolean;
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
  // The isolated member whose OS user runs this host
  // (server/member-hosts.ts); undefined for an office host.
  readonly member?: string;
  // The environment that agent processes start from: the agent user's own.
  baseEnv(): Record<string, string | undefined>;
  home(): string;
  // Agent space: provider homes, the Codex home, OpenCode profiles and the
  // one-shot folders of this host's agents. AGENT_ROOT on an office host;
  // <member home>/.isomux-agent on a member host, which its runner makes as
  // the member (internal-docs/member-os-user-design.md, section 1.3).
  agentRoot(): string;
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
  // is agent-space data. Only the runner host has entries. `timeoutMs`
  // replaces the default limit, after which the entry is killed.
  runEntry(name: string, input: unknown, timeoutMs?: number): Promise<unknown>;
  // An entry that takes a body after its input (the member file move,
  // server/member-move.ts). Only a runner host has it.
  runEntryStream?(
    name: string,
    input: unknown,
    body: AsyncIterable<Uint8Array>,
    timeoutMs: number,
  ): Promise<unknown>;
  // The engine executables and helper scripts that this host's processes
  // run: the office's on an office host, the member runtime's on a member
  // host (internal-docs/member-os-user-design.md, section 1.1).
  claudeBin(): string;
  codexLauncher(): string;
  // Throws where OpenCode has no binary (openCodeUnsupportedReason).
  openCodeBin(platform?: NodeJS.Platform): string;
  // The terminal sidecar (server/pty-sidecar.ts).
  ptySidecarArgv(): string[];
  // The OpenCode server helper (server/backends/opencode/start-server.ts).
  openCodeHelperArgv(): string[];
}

// A member's agent space, in their home (AgentHost.agentRoot).
export const MEMBER_AGENT_DIR = ".isomux-agent";

export const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.ts");
export const OPENCODE_HELPER_PATH = join(
  import.meta.dir,
  "backends",
  "opencode",
  "start-server.ts",
);

// The office's engine paths, for the local host and the split runner, which
// both run from the code tree. The terminal sidecar runs under the host's
// own Bun (`this.bunPath()`).
export const officeEnginePaths: Pick<
  AgentHost,
  | "claudeBin"
  | "codexLauncher"
  | "openCodeBin"
  | "ptySidecarArgv"
  | "openCodeHelperArgv"
> = {
  claudeBin: () => CLAUDE_NATIVE_BIN,
  codexLauncher: () => resolveCodexLauncherPath(),
  openCodeBin: (platform) => resolveOpenCodeBinary(platform),
  ptySidecarArgv(this: AgentHost) {
    return [this.bunPath(), PTY_SIDECAR_PATH];
  },
  openCodeHelperArgv: () => [process.execPath, "run", OPENCODE_HELPER_PATH],
};

function spawnLocalChild(
  argv: string[],
  options: SpawnChildOptions = {},
): AgentChild {
  const refusal = memberEnvRefusal(undefined, options.env);
  if (refusal) return failedAgentChild(refusal);
  if (options.isolate) return spawnIsolatedLocalChild(argv, options);
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

// Called when a wrapped spawn fails its bwrap setup, on either host. Boot
// sets it to the re-probe (process-isolation-state.ts).
let isolationSetupFailureListener: (() => void) | null = null;

export function setIsolationSetupFailureListener(
  listener: (() => void) | null,
): void {
  isolationSetupFailureListener = listener;
}

export function notifyIsolationSetupFailure(): void {
  isolationSetupFailureListener?.();
}

// The child is the outer bwrap of a new PID namespace
// (server/process-isolation.ts). Signals reach the command inside, and a
// failed bwrap setup is a start error (code ISOLATION_SETUP_FAILED) with no
// "exit", as a failed spawn is.
function spawnIsolatedLocalChild(
  argv: string[],
  options: SpawnChildOptions,
): AgentChild {
  const env = options.env ?? process.env;
  const wrapped = isolatedArgv(argv, { dieWithParent: true, statusFd: 3 });
  const child = spawn(wrapped[0], wrapped.slice(1), {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", options.stderr ?? "pipe", "pipe"],
    detached: true,
  });
  let status = "";
  const statusStream = child.stdio[3] as Readable | null;
  statusStream?.setEncoding("utf8");
  statusStream?.on("data", (chunk: string) => (status += chunk));
  // "exit" waits for "close", when the status is complete.
  let exit: [number | null, NodeJS.Signals | null] | null = null;
  const emit = child.emit.bind(child);
  child.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "exit") {
      exit = args as [number | null, NodeJS.Signals | null];
      return true;
    }
    if (event === "close" && exit !== null) {
      const [code, signal] = exit;
      if (signal === null && !statusHasExitCode(status)) {
        notifyIsolationSetupFailure();
        emit(
          "error",
          Object.assign(
            new Error(
              `bwrap could not set up the PID namespace (exit ${code})`,
            ),
            { code: ISOLATION_SETUP_FAILED },
          ),
        );
        return emit("close", null, null);
      }
      emit("exit", code, signal);
    }
    return emit(event, ...args);
  }) as typeof child.emit;
  return Object.assign(child, {
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (child.pid === undefined || child.exitCode !== null) return false;
      (child as { killed: boolean }).killed = true;
      return signalIsolated(child.pid, signal, "command");
    },
    signalGroup(signal: NodeJS.Signals) {
      // Once the outer bwrap has exited, the namespace died with it
      // (--die-with-parent), and its pid may already be another process's.
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      )
        signalIsolated(child.pid, signal, "namespace");
    },
  }) as unknown as AgentChild;
}

async function runLocal(
  argv: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const refusal = memberEnvRefusal(undefined, options.env);
  if (refusal) throw refusal;
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
  agentRoot: () => AGENT_ROOT,
  username: () => userInfo().username,
  bunPath: () => process.execPath,
  ...officeEnginePaths,
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
  // An isolated member's host runs the entry in their runner.
  host: AgentHost = current,
): Promise<unknown> {
  return host.kind === "runner"
    ? host.runEntry(name, input)
    : Promise.resolve().then(local);
}

export function officeAgentHost(): AgentHost {
  return current;
}

// Called once at boot by the split-mode start (server/split/start.ts), and by
// tests that restore the default afterwards.
export function setOfficeAgentHost(host: AgentHost): void {
  current = host;
}
