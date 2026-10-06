// Server side of the agent runner: RunnerAgentHost (server/agent-host.ts) over
// the runner's Unix socket. Everything the runner returns is agent-space data:
// the server trusts it no further than it trusts the agent user.

import { Socket } from "net";
import { constants as osConstants } from "os";
import type { AgentHost, AgentProcess } from "../agent-host.ts";
import type { IsomuxDiffRequest, IsomuxDiffRunResult } from "../isomux-diff.ts";
import {
  createFrameDecoder,
  encodeData,
  encodeJson,
  FRAME_JSON,
  FRAME_STDERR,
  FRAME_STDIN,
  FRAME_STDOUT,
  type ClientControl,
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
          handlers.control(message);
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
      handlers.close();
    });
    // Handlers first: Bun can report a failed connect inside connect().
    this.socket.connect(socketPath);
    this.socket.write(encodeJson(request));
  }

  // Resolves when the socket has room again; net queues the bytes meanwhile,
  // including those written before the connection opens.
  write(type: typeof FRAME_STDIN, data: Uint8Array): Promise<void> | void {
    if (this.closed) return;
    let full = false;
    for (const frame of encodeData(type, data))
      full = !this.socket.write(frame) || full;
    if (full)
      return new Promise((resolve) => {
        this.socket.once("drain", resolve);
        this.socket.once("close", resolve);
      });
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  control(message: ClientControl): void {
    if (!this.closed) this.socket.write(encodeJson(message));
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

  constructor(
    private readonly socketPath: string,
    private readonly info: RunnerInfo,
    private readonly nodePath: string | null,
  ) {}

  static async connect(socketPath: string): Promise<RunnerAgentHost> {
    const info = await readRunnerInfo(socketPath);
    const probe = (await runRunnerEntry(socketPath, "real-node", {})) as {
      path?: unknown;
    } | null;
    const nodePath = typeof probe?.path === "string" ? probe.path : null;
    return new RunnerAgentHost(socketPath, info, nodePath);
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

  realNodePath(): string | null {
    return this.nodePath;
  }

  spawnPipe(argv: string[]): AgentProcess {
    return new RunnerProcess(this.socketPath, argv);
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
