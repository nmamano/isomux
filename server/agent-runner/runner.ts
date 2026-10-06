// The agent runner (internal-docs/os-user-split-design.md, section 2.3). It
// runs as the agent user, listens on a Unix socket, and accepts connections
// from the server uid only. Each connection carries one operation: start a
// process, run a fixed entry from server/agent-runner/entries/, or report this
// user's identity and environment. It never runs a shell of its own.
//
//   bun server/agent-runner/runner.ts --socket <path> --server-uid <uid>

import { spawn, type ChildProcess } from "child_process";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";
import {
  readPeerCredentials,
  socketFileDescriptor,
} from "../unix-socket-server.ts";
import {
  createFrameDecoder,
  encodeData,
  encodeJson,
  FRAME_JSON,
  FRAME_STDERR,
  FRAME_STDIN,
  FRAME_STDOUT,
  type ClientControl,
  type Frame,
  type RunnerControl,
  type RunnerRequest,
} from "./frames.ts";

// The fixed entries. Each one reads one JSON value on stdin and writes one on
// stdout.
export const ENTRY_NAMES = new Set(["diff", "real-node", "diagnose"]);
const ENTRY_DIR = join(import.meta.dir, "entries");

// After the server's connection closes, the process group gets SIGTERM, and
// SIGKILL if it is still there after this delay.
const KILL_GRACE_MS = 5000;
// Pause a child's output while this much is queued for the server.
const HIGH_WATER_BYTES = 4 * 1024 * 1024;

export interface RunnerOptions {
  socketPath: string;
  serverUid: number;
  readPeerUid?: (fd: number) => number | null;
  killGraceMs?: number;
}

interface Connection {
  decode: (chunk: Uint8Array) => Frame[];
  queued: Buffer[];
  queuedBytes: number;
  ended: boolean;
  drainWaiters: (() => void)[];
  started: boolean;
  inputPaused: boolean;
  child: ChildProcess | null;
  // The process group of the spawned process (its pid). It stays set after
  // the leader exits: a descendant can keep the group alive.
  group: number | null;
  groupStopped: boolean;
}

type RunnerSocket = Bun.Socket<Connection>;

function send(socket: RunnerSocket, frames: Buffer[]): void {
  const data = socket.data;
  if (data.ended) return;
  for (const frame of frames) {
    data.queued.push(frame);
    data.queuedBytes += frame.length;
  }
  flush(socket);
}

function flush(socket: RunnerSocket): void {
  const data = socket.data;
  while (data.queued.length > 0) {
    const head = data.queued[0];
    const written = socket.write(head);
    if (written <= 0) return;
    data.queuedBytes -= written;
    if (written < head.length) {
      data.queued[0] = head.subarray(written);
      return;
    }
    data.queued.shift();
  }
  const waiters = data.drainWaiters.splice(0);
  for (const waiter of waiters) waiter();
}

function finish(socket: RunnerSocket, message: RunnerControl): void {
  send(socket, [encodeJson(message)]);
  socket.data.ended = true;
  // end() waits for Bun's own buffer; our queue is empty or the peer is gone.
  if (socket.data.queued.length === 0) socket.end();
  else socket.data.drainWaiters.push(() => socket.end());
}

function fail(socket: RunnerSocket, code: string, message: string): void {
  finish(socket, { type: "error", code, message });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

// False when the group has no process left (or cannot be signalled).
function signalGroup(group: number | null, signal: NodeJS.Signals): boolean {
  if (group === null) return false;
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    return false;
  }
}

function startChild(
  socket: RunnerSocket,
  argv: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
    stderr: "pipe" | "ignore";
    input?: Buffer;
  },
): void {
  let child: ChildProcess;
  try {
    // detached: the child leads its own process group, so the runner can stop
    // everything it started when the server goes away.
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", options.stderr],
    });
  } catch (error) {
    fail(socket, "spawn_failed", (error as Error).message);
    return;
  }
  socket.data.child = child;
  socket.data.group = child.pid ?? null;
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (child.pid === undefined)
      fail(socket, error.code ?? "spawn_failed", error.message);
  });
  child.once("spawn", () => {
    send(socket, [encodeJson({ type: "spawned", pid: child.pid! })]);
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
  child.stdin?.on("error", () => {});
  const forward = (stream: NodeJS.ReadableStream | null, type: number) => {
    stream?.on("data", (chunk: Buffer) => {
      send(socket, encodeData(type as typeof FRAME_STDOUT, chunk));
      if (socket.data.queuedBytes > HIGH_WATER_BYTES) {
        stream.pause();
        socket.data.drainWaiters.push(() => stream.resume());
      }
    });
  };
  forward(child.stdout, FRAME_STDOUT);
  forward(child.stderr, FRAME_STDERR);
  child.once("close", (code, signal) => {
    socket.data.child = null;
    finish(socket, { type: "exit", code, signal });
  });
}

function handleRequest(socket: RunnerSocket, request: RunnerRequest): void {
  if (request.op === "info") {
    const user = userInfo();
    finish(socket, {
      type: "info",
      uid: user.uid,
      gid: user.gid,
      user: user.username,
      home: homedir(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    return;
  }
  if (request.op === "spawn") {
    const { argv, cwd, env, stderr } = request;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string" && part.length > 0) ||
      (cwd !== undefined && typeof cwd !== "string") ||
      (env !== undefined && !isStringRecord(env))
    ) {
      fail(socket, "bad_request", "spawn needs argv, and string cwd and env");
      return;
    }
    startChild(socket, argv, {
      cwd,
      env: { ...process.env, ...env },
      stderr: stderr === "pipe" ? "pipe" : "ignore",
    });
    return;
  }
  if (request.op === "entry") {
    if (typeof request.name !== "string" || !ENTRY_NAMES.has(request.name)) {
      fail(socket, "unknown_entry", "no such entry");
      return;
    }
    startChild(
      socket,
      [process.execPath, join(ENTRY_DIR, `${request.name}.ts`)],
      {
        env: process.env,
        stderr: "pipe",
        input: Buffer.from(JSON.stringify(request.input ?? null)),
      },
    );
    return;
  }
  fail(socket, "bad_request", "unknown operation");
}

function handleFrame(socket: RunnerSocket, frame: Frame): void {
  const data = socket.data;
  if (!data.started) {
    data.started = true;
    if (frame.type !== FRAME_JSON) {
      fail(socket, "bad_request", "the first frame must be a request");
      return;
    }
    let request: RunnerRequest;
    try {
      request = JSON.parse(frame.payload.toString("utf8")) as RunnerRequest;
    } catch {
      fail(socket, "bad_request", "the request is not JSON");
      return;
    }
    handleRequest(socket, request);
    return;
  }
  const child = data.child;
  if (!child) return;
  if (frame.type === FRAME_STDIN) {
    // Backpressure: stop reading the server while the child's stdin is full.
    if (child.stdin && !child.stdin.write(frame.payload) && !data.inputPaused) {
      data.inputPaused = true;
      socket.pause();
      child.stdin.once("drain", () => {
        data.inputPaused = false;
        socket.resume();
      });
    }
    return;
  }
  if (frame.type !== FRAME_JSON) return;
  let control: ClientControl;
  try {
    control = JSON.parse(frame.payload.toString("utf8")) as ClientControl;
  } catch {
    return;
  }
  if (control.type === "stdin-end") child.stdin?.end();
  else if (control.type === "signal" && typeof control.signal === "string")
    signalGroup(data.group, control.signal);
}

// The end of an operation ends its process group, also when the leader has
// already exited: its exit says nothing about the rest of the group.
function stopGroup(data: Connection, graceMs: number): void {
  if (data.groupStopped) return;
  data.groupStopped = true;
  const group = data.group;
  if (!signalGroup(group, "SIGTERM")) return;
  const timer = setTimeout(() => signalGroup(group, "SIGKILL"), graceMs);
  timer.unref?.();
}

export function startRunner(options: RunnerOptions): { stop(): void } {
  const readPeerUid =
    options.readPeerUid ?? ((fd) => readPeerCredentials(fd)?.uid ?? null);
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  if (existsSync(options.socketPath)) {
    if (!lstatSync(options.socketPath).isSocket())
      throw new Error(`${options.socketPath} exists and is not a socket`);
    unlinkSync(options.socketPath);
  }
  const listener = Bun.listen<Connection>({
    unix: options.socketPath,
    socket: {
      open(socket) {
        socket.data = {
          decode: createFrameDecoder(),
          queued: [],
          queuedBytes: 0,
          ended: false,
          drainWaiters: [],
          started: false,
          inputPaused: false,
          child: null,
          group: null,
          groupStopped: false,
        };
        const fd = socketFileDescriptor(socket);
        const uid = fd === null ? null : readPeerUid(fd);
        if (uid !== options.serverUid) {
          socket.data.ended = true;
          // Bun 1.3.11 drops a close made inside open(); the client would
          // wait forever.
          setTimeout(() => socket.terminate(), 0);
        }
      },
      data(socket, chunk) {
        if (socket.data.ended && !socket.data.child) return;
        let frames: Frame[];
        try {
          frames = socket.data.decode(chunk);
        } catch {
          stopGroup(socket.data, graceMs);
          socket.data.ended = true;
          socket.terminate();
          return;
        }
        for (const frame of frames) handleFrame(socket, frame);
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.ended = true;
        stopGroup(socket.data, graceMs);
      },
      error(socket) {
        socket.data.ended = true;
        stopGroup(socket.data, graceMs);
      },
    },
  });
  // Group access lets the server user connect; the peer check refuses every
  // other uid in that group.
  chmodSync(options.socketPath, 0o660);
  return { stop: () => listener.stop(true) };
}

function parseArgs(argv: string[]): RunnerOptions {
  const value = (flag: string): string => {
    const at = argv.indexOf(flag);
    const found = at >= 0 ? argv[at + 1] : undefined;
    if (!found) throw new Error(`missing ${flag}`);
    return found;
  };
  const uidText = value("--server-uid");
  if (!/^\d+$/.test(uidText)) throw new Error("--server-uid must be a uid");
  return { socketPath: value("--socket"), serverUid: Number(uidText) };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (options.serverUid === process.getuid?.()) {
    console.error(
      "[agent-runner] the server uid is this process's own uid; refusing to start.",
    );
    process.exit(1);
  }
  startRunner(options);
  console.log(`[agent-runner] listening on ${options.socketPath}`);
}
