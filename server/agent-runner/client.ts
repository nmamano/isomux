// Server side of the agent runner: RunnerAgentHost (server/agent-host.ts) over
// the runner's Unix socket. Everything the runner returns is agent-space data:
// the server trusts it no further than it trusts the agent user.

import { EventEmitter } from "events";
import { Socket } from "net";
import { constants as osConstants } from "os";
import { Readable, Writable } from "stream";
import type {
  AgentChild,
  AgentFs,
  AgentHost,
  AgentProcess,
  RunOptions,
  RunResult,
  SpawnChildOptions,
} from "../agent-host.ts";
import type { IsomuxDiffRequest, IsomuxDiffRunResult } from "../isomux-diff.ts";
import {
  createFrameDecoder,
  encodeData,
  encodeJson,
  FRAME_JSON,
  FRAME_STDERR,
  FRAME_STDIN,
  FRAME_STDOUT,
  STDIN_WINDOW_BYTES,
  type ClientControl,
  type FsRequest,
  type RunnerControl,
  type RunnerRequest,
} from "./frames.ts";

const ENTRY_TIMEOUT_MS = 60_000;

function exitStatus(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  const number = signal
    ? (osConstants.signals as Record<string, number>)[signal]
    : undefined;
  return number ? 128 + number : 1;
}

// One operation on its own connection. Callbacks get the runner's frames; the
// connection ends after the runner's final control message.
class RunnerStream {
  readonly socket: Socket;
  private closed = false;
  // Stdin bytes the runner has not yet put into the child's pipe, and the
  // stdin frames (and the stdin-end after them) that wait for room under
  // STDIN_WINDOW_BYTES. A signal never waits here.
  private unackedStdin = 0;
  private outbox: { frame: Buffer; stdinBytes: number; sent?: () => void }[] =
    [];

  constructor(
    socketPath: string,
    request: RunnerRequest,
    handlers: {
      control(message: RunnerControl): void;
      stdout(chunk: Buffer): void;
      stderr(chunk: Buffer): void;
      close(): void;
    },
  ) {
    const decode = createFrameDecoder();
    this.socket = new Socket();
    this.socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = decode(chunk);
      } catch {
        this.socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME_STDOUT) handlers.stdout(frame.payload);
        else if (frame.type === FRAME_STDERR) handlers.stderr(frame.payload);
        else if (frame.type === FRAME_JSON) {
          let message: RunnerControl;
          try {
            message = JSON.parse(
              frame.payload.toString("utf8"),
            ) as RunnerControl;
          } catch {
            continue;
          }
          if (message.type === "stdin-ack") this.acknowledge(message.bytes);
          else handlers.control(message);
        }
      }
    });
    // A failed connect emits error and then close; close settles the caller.
    // The runner never half-closes; an end is the end of the operation. Bun's
    // net does not close the socket on its own after the peer's end.
    this.socket.on("end", () => this.socket.destroy());
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      this.closed = true;
      // A write waiting for room settles when the operation ends.
      for (const item of this.outbox.splice(0)) item.sent?.();
      handlers.close();
    });
    // Handlers first: Bun can report a failed connect inside connect().
    this.socket.connect(socketPath);
    this.socket.write(encodeJson(request));
  }

  // Input held back by the window.
  get queuedInputBytes(): number {
    return this.outbox.reduce((sum, item) => sum + item.stdinBytes, 0);
  }

  private acknowledge(bytes: unknown): void {
    if (typeof bytes !== "number" || !(bytes > 0)) return;
    this.unackedStdin = Math.max(0, this.unackedStdin - bytes);
    this.pump();
  }

  // Send what the window allows; net queues the bytes meanwhile, including
  // those written before the connection opens.
  private pump(): void {
    while (
      this.outbox.length > 0 &&
      (this.outbox[0].stdinBytes === 0 ||
        this.unackedStdin < STDIN_WINDOW_BYTES)
    ) {
      const item = this.outbox.shift()!;
      this.unackedStdin += item.stdinBytes;
      const room = this.socket.write(item.frame);
      const sent = item.sent;
      if (!sent) continue;
      if (room) sent();
      else {
        this.socket.once("drain", sent);
        this.socket.once("close", sent);
      }
    }
  }

  // Resolves once the input is on the socket and the socket has room again.
  write(type: typeof FRAME_STDIN, data: Uint8Array): Promise<void> | void {
    if (this.closed) return;
    const frames = encodeData(type, data);
    if (frames.length === 0) return;
    let resolveSent!: () => void;
    let sentNow = false;
    const done = new Promise<void>((resolve) => (resolveSent = resolve));
    const sent = () => {
      sentNow = true;
      resolveSent();
    };
    frames.forEach((frame, index) =>
      this.outbox.push({
        frame,
        stdinBytes: frame.length - 5,
        sent: index === frames.length - 1 ? sent : undefined,
      }),
    );
    this.pump();
    return sentNow ? undefined : done;
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  control(message: ClientControl): void {
    if (this.closed) return;
    // The end of input goes after the input; a signal goes at once.
    if (message.type === "stdin-end") {
      this.outbox.push({ frame: encodeJson(message), stdinBytes: 0 });
      this.pump();
    } else this.socket.write(encodeJson(message));
  }

  close(): void {
    this.socket.destroy();
  }
}

// A process the runner started, shaped like the part of a Bun Subprocess that
// callers use.
export class RunnerProcess implements AgentProcess {
  pid: number | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly stdin: AgentProcess["stdin"];
  private readonly stream: RunnerStream;

  constructor(socketPath: string, argv: string[]) {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let stream: RunnerStream | undefined;
    // Backpressure: the socket stops reading while the reader is behind.
    this.stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      pull: () => stream?.resume(),
    });
    let settled = false;
    let resolveExit!: (status: number) => void;
    this.exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let status: number | null = null;
    this.stream = stream = new RunnerStream(
      socketPath,
      { op: "spawn", argv, stderr: "pipe" },
      {
        control: (message) => {
          if (message.type === "spawned") this.pid = message.pid;
          else if (message.type === "exit")
            status = exitStatus(message.code, message.signal);
          else if (message.type === "error") {
            console.error(
              `[agent-runner] cannot start ${argv[0]}: ${message.code} ${message.message}`,
            );
            status = 127;
          }
        },
        stdout: (chunk) => {
          output.enqueue(new Uint8Array(chunk));
          if ((output.desiredSize ?? 1) <= 0) stream?.pause();
        },
        // Same sink as the stderr: "inherit" of a local spawn.
        stderr: (chunk) => process.stderr.write(chunk),
        close: () => {
          if (settled) return;
          settled = true;
          try {
            output.close();
          } catch {}
          // A connection that ends without an exit report is a lost process.
          resolveExit(status ?? 1);
        },
      },
    );
    this.stdin = {
      write: (data) =>
        this.stream.write(
          FRAME_STDIN,
          typeof data === "string" ? Buffer.from(data) : data,
        ),
      end: () => this.stream.control({ type: "stdin-end" }),
    };
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.stream.control({ type: "signal", signal });
  }
}

// The defined values only: JSON drops undefined, and the runner uses this as
// the whole environment, so a key set to undefined stays unset in the child.
function definedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (typeof value === "string") out[key] = value;
  return out;
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

// A runner process with Node streams, for the callers that hold a Node
// ChildProcess today (the Claude SDK's spawn hook, the Codex client). The
// runner sends all output before its exit report, so "exit" and "close" come
// after the last stdout chunk is pushed.
export class RunnerChild extends EventEmitter implements AgentChild {
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable | null;
  private readonly stream: RunnerStream;
  private exited = false;

  constructor(
    socketPath: string,
    argv: string[],
    env: Record<string, string | undefined>,
    options: SpawnChildOptions,
  ) {
    super();
    let stream: RunnerStream | undefined;
    // Backpressure: the socket stops reading while stdout's reader is behind.
    this.stdout = new Readable({ read: () => stream?.resume() });
    this.stderr =
      options.stderr === "ignore" ? null : new Readable({ read() {} });
    let startError: NodeJS.ErrnoException | null = null;
    this.stream = stream = new RunnerStream(
      socketPath,
      {
        op: "spawn",
        argv,
        cwd: options.cwd,
        fullEnv: definedEnv(env),
        stderr: options.stderr ?? "pipe",
      },
      {
        control: (message) => {
          if (message.type === "spawned") {
            this.pid = message.pid;
            this.emit("spawn");
          } else if (message.type === "exit") {
            this.exitCode = message.code;
            this.signalCode = message.signal as NodeJS.Signals | null;
          } else if (message.type === "error")
            startError = errnoError(message.code, message.message);
        },
        stdout: (chunk) => {
          if (!this.stdout.push(chunk)) stream?.pause();
        },
        stderr: (chunk) => {
          this.stderr?.push(chunk);
        },
        close: () => this.finish(argv[0], startError),
      },
    );
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const wait = this.stream.write(FRAME_STDIN, chunk);
        if (wait) void wait.then(() => callback());
        else callback();
      },
      final: (callback) => {
        this.stream.control({ type: "stdin-end" });
        callback();
      },
    });
    // A write after the end of the connection goes nowhere, as a write to a
    // dead child's pipe; the caller learns of the end from "exit".
    this.stdin.on("error", () => {});
  }

  private finish(
    program: string,
    startError: NodeJS.ErrnoException | null,
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.push(null);
    this.stderr?.push(null);
    if (this.pid === undefined) {
      // The start failed (or the runner was unreachable): Node reports this
      // as "error" with no "exit".
      this.emit(
        "error",
        startError ??
          errnoError("ECONNREFUSED", "the agent runner is not reachable"),
      );
      this.emit("close", null, null);
      return;
    }
    if (this.exitCode === null && this.signalCode === null) {
      // The connection ended without an exit report: the process is lost.
      console.error(`[agent-runner] lost the connection to ${program}`);
      this.exitCode = 1;
    }
    this.emit("exit", this.exitCode, this.signalCode);
    // As in Node, "close" waits until a reader has taken the last output.
    const code = this.exitCode;
    const signal = this.signalCode;
    const drained = [this.stdout, this.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (
            !stream ||
            stream.readableEnded ||
            stream.readableFlowing !== true
          )
            setImmediate(resolve);
          else stream.once("end", resolve);
        }),
    );
    void Promise.all(drained).then(() => this.emit("close", code, signal));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exited) return false;
    this.stream.control({ type: "signal", signal });
    this.killed = true;
    return true;
  }

  signalGroup(signal: NodeJS.Signals): void {
    if (!this.exited) this.stream.control({ type: "signal", signal });
  }

  // Input this process has not sent: the runner holds at most the window.
  get queuedInputBytes(): number {
    return this.stream.queuedInputBytes;
  }

  // End the connection: the runner then stops the whole process group.
  dispose(): void {
    this.stream.close();
  }
}

// One file operation. readText resolves with the file's bytes.
export function runnerFs(
  socketPath: string,
  request: FsRequest,
  input?: Buffer,
): Promise<{ value?: boolean; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let answer: { value?: boolean } | null = null;
    let error: NodeJS.ErrnoException | null = null;
    const stream = new RunnerStream(
      socketPath,
      { op: "fs", ...request },
      {
        control: (message) => {
          if (message.type === "fs") answer = { value: message.value };
          else if (message.type === "error")
            error = errnoError(message.code, message.message);
        },
        stdout: (chunk) => {
          chunks.push(chunk);
        },
        stderr: () => {},
        close: () => {
          if (answer) resolve({ ...answer, data: Buffer.concat(chunks) });
          else
            reject(
              error ??
                errnoError(
                  "ECONNRESET",
                  "the agent runner closed the connection",
                ),
            );
        },
      },
    );
    if (input !== undefined) {
      void stream.write(FRAME_STDIN, input);
      stream.control({ type: "stdin-end" });
    }
  });
}

export function runnerAgentFs(socketPath: string): AgentFs {
  return {
    readText: async (path) =>
      (await runnerFs(socketPath, { call: "readText", path })).data.toString(
        "utf8",
      ),
    writeText: async (path, text, { mode, exclusive }) => {
      await runnerFs(
        socketPath,
        { call: "writeText", path, mode, exclusive },
        Buffer.from(text),
      );
    },
    mkdir: async (path, mode) => {
      await runnerFs(socketPath, { call: "mkdir", path, mode });
    },
    rm: async (path) => {
      await runnerFs(socketPath, { call: "rm", path });
    },
    exists: async (path) =>
      (await runnerFs(socketPath, { call: "exists", path })).value === true,
    chmod: async (path, mode) => {
      await runnerFs(socketPath, { call: "chmod", path, mode });
    },
  };
}

export interface RunnerInfo {
  uid: number;
  gid: number;
  user: string;
  home: string;
  env: Record<string, string>;
}

export function readRunnerInfo(socketPath: string): Promise<RunnerInfo> {
  return new Promise((resolve, reject) => {
    let info: RunnerInfo | null = null;
    let error: string | null = null;
    new RunnerStream(
      socketPath,
      { op: "info" },
      {
        control: (message) => {
          if (message.type === "info") {
            const { uid, gid, user, home, env } = message;
            info = { uid, gid, user, home, env };
          } else if (message.type === "error") error = message.message;
        },
        stdout: () => {},
        stderr: () => {},
        close: () =>
          info
            ? resolve(info)
            : reject(
                new Error(error ?? "the agent runner closed the connection"),
              ),
      },
    );
  });
}

// Run a fixed entry and parse its JSON output.
export function runRunnerEntry(
  socketPath: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let status: number | null = null;
    let error: string | null = null;
    const stream = new RunnerStream(
      socketPath,
      { op: "entry", name, input },
      {
        control: (message) => {
          if (message.type === "exit")
            status = exitStatus(message.code, message.signal);
          else if (message.type === "error") error = message.message;
        },
        stdout: (chunk) => {
          chunks.push(chunk);
        },
        stderr: (chunk) => process.stderr.write(chunk),
        close: () => {
          clearTimeout(timer);
          if (error === null && status === 0) {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              return;
            } catch {
              error = "the entry output is not JSON";
            }
          }
          reject(
            new Error(
              `agent runner entry ${name} failed: ${error ?? `exit ${status ?? "lost"}`}`,
            ),
          );
        },
      },
    );
    const timer = setTimeout(() => {
      error = "timed out";
      stream.close();
    }, ENTRY_TIMEOUT_MS);
  });
}

const DIFF_KINDS = new Set([
  "ok",
  "clean",
  "not_repo",
  "git_error",
  "bad_commit",
  "bad_dir",
]);

export class RunnerAgentHost implements AgentHost {
  readonly kind = "runner" as const;
  readonly fs: AgentFs;

  constructor(
    private readonly socketPath: string,
    private readonly info: RunnerInfo,
    private readonly runtimePath: string,
  ) {
    this.fs = runnerAgentFs(socketPath);
  }

  static async connect(socketPath: string): Promise<RunnerAgentHost> {
    const info = await readRunnerInfo(socketPath);
    const probe = (await runRunnerEntry(socketPath, "bun-path", {})) as {
      path?: unknown;
    } | null;
    if (typeof probe?.path !== "string" || !probe.path) {
      throw new Error("Agent runner did not report its Bun executable");
    }
    return new RunnerAgentHost(socketPath, info, probe.path);
  }

  get uid(): number {
    return this.info.uid;
  }

  baseEnv(): Record<string, string | undefined> {
    return this.info.env;
  }

  home(): string {
    return this.info.home;
  }

  username(): string {
    return this.info.user;
  }

  bunPath(): string {
    return this.runtimePath;
  }

  spawnPipe(argv: string[]): AgentProcess {
    return new RunnerProcess(this.socketPath, argv);
  }

  spawnChild(argv: string[], options: SpawnChildOptions = {}): RunnerChild {
    return new RunnerChild(
      this.socketPath,
      argv,
      options.env ?? this.info.env,
      options,
    );
  }

  run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    const keep = (options.output ?? "pipe") === "pipe";
    const child = this.spawnChild(argv, {
      cwd: options.cwd,
      env: options.env,
      stderr: keep ? "pipe" : "ignore",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      if (keep) out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code: number | null, signal: string | null) => {
        if (child.pid === undefined) return;
        resolve({
          exitCode: exitStatus(code, signal),
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
  }

  async isomuxDiff(req: IsomuxDiffRequest): Promise<IsomuxDiffRunResult> {
    const cwd = req.dir ?? req.agentCwd;
    let result: unknown;
    try {
      result = await runRunnerEntry(this.socketPath, "diff", req);
    } catch (error) {
      return { kind: "git_error", cwd, message: (error as Error).message };
    }
    const kind = (result as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !DIFF_KINDS.has(kind))
      return {
        kind: "git_error",
        cwd,
        message: "the agent runner returned no diff",
      };
    return result as IsomuxDiffRunResult;
  }

  runEntry(name: string, input: unknown): Promise<unknown> {
    return runRunnerEntry(this.socketPath, name, input);
  }
}
