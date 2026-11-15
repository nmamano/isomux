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
import {
  failedAgentChild,
  MEMBER_AGENT_DIR,
  memberEnvRefusal,
  officeEnginePaths,
  tagMemberEnv,
  notifyIsolationSetupFailure,
} from "../agent-host.ts";
import {
  memberRuntimePaths,
  type MemberRuntimePaths,
} from "../member-runtime.ts";
import { RUNTIME_HASH_PATTERN } from "../member-share-check.ts";
import { AGENT_ROOT } from "../split/roots.ts";
import { join } from "path";
import { readPeerCredentials } from "../unix-socket-server.ts";
import { CLAUDE_NATIVE_BIN, pathWithBundledClaude } from "../cwd-utils.ts";
import type { IsomuxDiffRequest, IsomuxDiffRunResult } from "../isomux-diff.ts";
import { ISOLATION_SETUP_FAILED } from "../process-isolation.ts";
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

// Where a runner listens. A member's runner (server/member-hosts.ts) also
// names the uid that must listen there: each connection reads it from our
// side of the socket (SO_PEERCRED) and sends nothing before it matches.
export type RunnerTarget =
  | string
  | {
      path: string;
      peer: { uid: number; read: (fd: number) => number | null };
    };

export const RUNNER_PEER_REFUSED = "RUNNER_PEER_REFUSED";

// The fd under a connected net.Socket. Bun keeps it on the handle (checked on
// 1.4.4); null when that shape changes, and the caller refuses.
function clientSocketFd(socket: Socket): number | null {
  const fd: unknown = Reflect.get(
    (Reflect.get(socket, "_handle") as object | undefined) ?? {},
    "fd",
  );
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : null;
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
  // False until a member runner's peer uid matched: nothing is sent before.
  private ready: boolean;

  constructor(
    socketPath: RunnerTarget,
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
    // The runner half-closes after the final report and drains late input.
    // End completes the operation; close our side so the runner can release it.
    this.socket.on("end", () => this.socket.destroy());
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      this.closed = true;
      // A write waiting for room settles when the operation ends.
      for (const item of this.outbox.splice(0)) item.sent?.();
      handlers.close();
    });
    const path = typeof socketPath === "string" ? socketPath : socketPath.path;
    const peer = typeof socketPath === "string" ? null : socketPath.peer;
    this.ready = peer === null;
    if (peer) {
      this.outbox.push({ frame: encodeJson(request), stdinBytes: 0 });
      this.socket.once("connect", () => {
        const fd = clientSocketFd(this.socket);
        const uid = fd === null ? null : peer.read(fd);
        if (uid !== peer.uid) {
          handlers.control({
            type: "error",
            code: RUNNER_PEER_REFUSED,
            message: `the runner socket ${path} is not served by uid ${peer.uid}`,
          });
          this.outbox = [];
          this.socket.destroy();
          return;
        }
        this.ready = true;
        this.pump();
      });
    }
    // Handlers first: Bun can report a failed connect inside connect().
    this.socket.connect(path);
    if (!peer) this.socket.write(encodeJson(request));
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
    if (!this.ready) return;
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
    if (message.type === "stdin-end" || !this.ready) {
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

  constructor(socketPath: RunnerTarget, argv: string[]) {
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
    socketPath: RunnerTarget,
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
        ...(options.isolate ? { isolate: true } : {}),
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
    if (startError?.code === ISOLATION_SETUP_FAILED)
      notifyIsolationSetupFailure();
    if (this.pid === undefined || startError !== null) {
      // The start failed (or the runner was unreachable, or an isolated
      // child's bwrap setup failed after its spawn): Node reports this as
      // "error" with no "exit".
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
    this.stream.control({ type: "signal", signal, scope: "child" });
    this.killed = true;
    return true;
  }

  signalGroup(signal: NodeJS.Signals): void {
    if (!this.exited)
      this.stream.control({ type: "signal", signal, scope: "group" });
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
  socketPath: RunnerTarget,
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

export function runnerAgentFs(socketPath: RunnerTarget): AgentFs {
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
  // The runtime hash the runner says it runs (member data: a member can put
  // its own listener on the socket); null from the code tree.
  bundleHash: string | null;
}

export function readRunnerInfo(socketPath: RunnerTarget): Promise<RunnerInfo> {
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
            const hash = message.bundleHash;
            info = {
              uid,
              gid,
              user,
              home,
              env,
              bundleHash:
                typeof hash === "string" && RUNTIME_HASH_PATTERN.test(hash)
                  ? hash
                  : null,
            };
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

// Ask the runner to exit (its unit starts the runtime that runtime/current
// names). Resolves when the runner closes the connection; never rejects.
export function exitRunner(socketPath: RunnerTarget): Promise<void> {
  return new Promise((resolve) => {
    const stream = new RunnerStream(
      socketPath,
      { op: "exit" },
      {
        control: () => {},
        stdout: () => {},
        stderr: () => {},
        close: () => {
          clearTimeout(timer);
          resolve();
        },
      },
    );
    const timer = setTimeout(() => stream.close(), ENTRY_TIMEOUT_MS);
  });
}

// Run a fixed entry and parse its JSON output.
export function runRunnerEntry(
  socketPath: RunnerTarget,
  name: string,
  input: unknown,
  timeoutMs: number = ENTRY_TIMEOUT_MS,
  // A body for an entry that takes one: its bytes follow the input on the
  // entry's stdin.
  body?: AsyncIterable<Uint8Array>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let status: number | null = null;
    let error: string | null = null;
    let ended = false;
    const stream = new RunnerStream(
      socketPath,
      body
        ? { op: "entry", name, input, stream: true }
        : { op: "entry", name, input },
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
          ended = true;
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
    }, timeoutMs);
    if (body)
      void (async () => {
        try {
          for await (const chunk of body) {
            if (ended) return;
            const sent = stream.write(FRAME_STDIN, chunk);
            if (sent) await sent;
          }
          stream.control({ type: "stdin-end" });
        } catch (err) {
          error = `the body failed: ${(err as Error).message}`;
          stream.close();
        }
      })();
  });
}

// An entry whose stdout is a byte stream, not one JSON value (files-out):
// its chunks in order. The socket stops reading while the consumer is
// behind. Throws after the last chunk when the entry failed.
export async function* runRunnerEntryOut(
  socketPath: RunnerTarget,
  name: string,
  input: unknown,
  timeoutMs: number,
): AsyncGenerator<Uint8Array> {
  const queue: Buffer[] = [];
  let ended = false;
  let paused = false;
  let status: number | null = null;
  let error: string | null = null;
  let wake: (() => void) | null = null;
  // eslint-disable-next-line prefer-const -- the handlers run after it is set
  let stream: RunnerStream;
  const timer = setTimeout(() => {
    error = "timed out";
    stream.close();
  }, timeoutMs);
  stream = new RunnerStream(
    socketPath,
    { op: "entry", name, input },
    {
      control: (message) => {
        if (message.type === "exit")
          status = exitStatus(message.code, message.signal);
        else if (message.type === "error") error = message.message;
      },
      stdout: (chunk) => {
        queue.push(chunk);
        if (queue.length > 64 && !paused) {
          paused = true;
          stream.pause();
        }
        wake?.();
      },
      stderr: (chunk) => process.stderr.write(chunk),
      close: () => {
        ended = true;
        clearTimeout(timer);
        wake?.();
      },
    },
  );
  try {
    for (;;) {
      const chunk = queue.shift();
      if (chunk) {
        if (paused && queue.length < 16) {
          paused = false;
          stream.resume();
        }
        yield chunk;
        continue;
      }
      if (ended) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } finally {
    if (!ended) stream.close();
    clearTimeout(timer);
  }
  if (error !== null || status !== 0)
    throw new Error(
      `agent runner entry ${name} failed: ${error ?? `exit ${status ?? "lost"}`}`,
    );
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

  readonly claudeBin: AgentHost["claudeBin"];
  readonly codexLauncher: AgentHost["codexLauncher"];
  readonly openCodeBin: AgentHost["openCodeBin"];
  readonly ptySidecarArgv: AgentHost["ptySidecarArgv"];
  readonly openCodeHelperArgv: AgentHost["openCodeHelperArgv"];

  constructor(
    private readonly socketPath: RunnerTarget,
    private readonly info: RunnerInfo,
    private readonly runtimePath: string,
    // The member this host runs for (server/member-hosts.ts); undefined for
    // the office runner of split mode.
    readonly member?: string,
    // A member's runtime (server/member-runtime.ts); the office runner runs
    // the engines of the code tree.
    runtime?: MemberRuntimePaths,
  ) {
    this.fs = runnerAgentFs(socketPath);
    const engines = runtime
      ? {
          claudeBin: () => runtime.claudeBin,
          codexLauncher: () => runtime.codexLauncher(),
          openCodeBin: (platform?: NodeJS.Platform) =>
            runtime.openCodeBin(platform),
          ptySidecarArgv: () => [...runtime.ptySidecarArgv],
          openCodeHelperArgv: () => [...runtime.openCodeHelperArgv],
        }
      : officeEnginePaths;
    this.claudeBin = engines.claudeBin;
    this.codexLauncher = engines.codexLauncher;
    this.openCodeBin = engines.openCodeBin;
    this.ptySidecarArgv = engines.ptySidecarArgv;
    this.openCodeHelperArgv = engines.openCodeHelperArgv;
  }

  // A member's runner. Every connection checks the listener's uid
  // (SO_PEERCRED on our side) against `uid`; a reply field is never trusted
  // for it. The host refuses an env that is not tagged with `userId`. Its
  // engines are those of <share>/runtime/<the hash the runner reports>; the
  // caller registers the host only when that hash is the installed one.
  static async connectMember(
    socketPath: string,
    opts: {
      userId: string;
      uid: number;
      share: string;
      readPeerUid?: (fd: number) => number | null;
    },
  ): Promise<{
    host: RunnerAgentHost;
    runtimeHash: string | null;
    exit(): Promise<void>;
  }> {
    const target: RunnerTarget = {
      path: socketPath,
      peer: {
        uid: opts.uid,
        read:
          opts.readPeerUid ?? ((fd) => readPeerCredentials(fd)?.uid ?? null),
      },
    };
    const info = await readRunnerInfo(target);
    const runtime = memberRuntimePaths(
      join(opts.share, "runtime", info.bundleHash ?? "none"),
    );
    const env: Record<string, string> = {
      ...info.env,
      // The runtime is the office's: an engine never updates its own copy.
      DISABLE_AUTOUPDATER: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    // `claude` in the member's terminals and shells is the runtime's.
    env.PATH = pathWithBundledClaude(info.env.PATH ?? "", runtime.claudeBin);
    // The uid is the one the peer check proved, never the runner's word.
    const host = new RunnerAgentHost(
      target,
      { ...info, env, uid: opts.uid },
      runtime.bun,
      opts.userId,
      runtime,
    );
    return {
      host,
      runtimeHash: info.bundleHash,
      exit: () => exitRunner(target),
    };
  }

  static async connect(socketPath: RunnerTarget): Promise<RunnerAgentHost> {
    const info = await readRunnerInfo(socketPath);
    // Terminals and agent shells take PATH from the runner's env, as the
    // server's own PATH does at boot.
    if (info.env.PATH)
      info.env.PATH = pathWithBundledClaude(info.env.PATH, CLAUDE_NATIVE_BIN);
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

  // A member's base env carries the member's tag (server/agent-host.ts), so
  // an env spread from it starts on this host.
  baseEnv(): Record<string, string | undefined> {
    return this.member === undefined
      ? this.info.env
      : tagMemberEnv({ ...this.info.env }, this.member);
  }

  home(): string {
    return this.info.home;
  }

  // The office runner of split mode: AGENT_ROOT. A member's runner: its
  // agent space in the member's home.
  agentRoot(): string {
    return this.member === undefined
      ? AGENT_ROOT
      : join(this.info.home, MEMBER_AGENT_DIR);
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
    const refusal = memberEnvRefusal(this.member, options.env);
    // Never started: the public shape of a RunnerChild with nothing queued.
    if (refusal)
      return Object.assign(failedAgentChild(refusal), {
        queuedInputBytes: 0,
        dispose: () => {},
      }) as unknown as RunnerChild;
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

  runEntry(name: string, input: unknown, timeoutMs?: number): Promise<unknown> {
    return runRunnerEntry(this.socketPath, name, input, timeoutMs);
  }

  runEntryStream(
    name: string,
    input: unknown,
    body: AsyncIterable<Uint8Array>,
    timeoutMs: number,
  ): Promise<unknown> {
    return runRunnerEntry(this.socketPath, name, input, timeoutMs, body);
  }

  runEntryOut(
    name: string,
    input: unknown,
    timeoutMs: number,
  ): AsyncIterable<Uint8Array> {
    return runRunnerEntryOut(this.socketPath, name, input, timeoutMs);
  }
}
