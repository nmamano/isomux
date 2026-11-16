// Wire format between the office server and the agent runner
// (internal-docs/os-user-split-design.md, section 2.3). Every frame is
// [u32 big-endian length][u8 type][payload]; the length counts the type byte
// and the payload. One Unix connection carries one operation, and its first
// frame is a JSON request.

export const FRAME_JSON = 1;
export const FRAME_STDIN = 2;
export const FRAME_STDOUT = 3;
export const FRAME_STDERR = 4;

export const MAX_FRAME_BYTES = 1024 * 1024;
// Stdin bytes the server may send that the runner has not yet put into the
// child's pipe (runner.ts pumpStdin).
export const STDIN_WINDOW_BYTES = 1024 * 1024;

export type FrameType =
  | typeof FRAME_JSON
  | typeof FRAME_STDIN
  | typeof FRAME_STDOUT
  | typeof FRAME_STDERR;

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

export function encodeFrame(type: FrameType, payload: Uint8Array): Buffer {
  if (payload.length + 1 > MAX_FRAME_BYTES)
    throw new Error("agent runner frame is too large");
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

export function encodeJson(value: unknown): Buffer {
  return encodeFrame(FRAME_JSON, Buffer.from(JSON.stringify(value)));
}

// Split a byte stream into frames that are larger than MAX_FRAME_BYTES.
export function encodeData(type: FrameType, data: Uint8Array): Buffer[] {
  const chunk = MAX_FRAME_BYTES - 1;
  const frames: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunk)
    frames.push(encodeFrame(type, data.subarray(at, at + chunk)));
  return frames;
}

// Incremental decoder: push bytes as they arrive, get every complete frame.
// Throws on an unknown type or a length outside 1..MAX_FRAME_BYTES; the
// caller closes the connection.
export function createFrameDecoder(): (chunk: Uint8Array) => Frame[] {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length
      ? Buffer.concat([pending, chunk])
      : Buffer.from(chunk);
    const frames: Frame[] = [];
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES)
        throw new Error("agent runner frame has a bad length");
      if (pending.length < 4 + length) break;
      const type = pending[4];
      if (type < FRAME_JSON || type > FRAME_STDERR)
        throw new Error("agent runner frame has an unknown type");
      frames.push({
        type: type as FrameType,
        payload: Buffer.from(pending.subarray(5, 4 + length)),
      });
      pending = pending.subarray(4 + length);
    }
    return frames;
  };
}

// Requests (server -> runner, first frame).
export type RunnerRequest =
  | {
      op: "spawn";
      argv: string[];
      cwd?: string;
      // Overlay on the runner's own environment.
      env?: Record<string, string>;
      // The whole environment, in place of the runner's own and env.
      fullEnv?: Record<string, string>;
      stderr?: "pipe" | "ignore";
      // Wrap argv in its own PID namespace (server/process-isolation.ts).
      isolate?: boolean;
    }
  // stream: the input is the first line of the entry's stdin, and the
  // client's stdin frames follow it (a fixed entry that takes a body).
  | { op: "entry"; name: string; input: unknown; stream?: boolean }
  | ({ op: "fs" } & FsRequest)
  | { op: "info" }
  // Close the listener and exit 0 (a member runner: its unit starts the new
  // bundle). Answered with "exiting" before the listener closes.
  | { op: "exit" };

// The largest file a readText returns. The server holds the whole file, and
// the agent user controls it. The client counts the bytes too: a runner
// reply is member data.
export const RUNNER_READ_MAX = 256 * 1024 * 1024;

// The longest path a realpath answers (Linux PATH_MAX).
export const RUNNER_PATH_MAX = 4096;

// File operations in agent space, done by the runner as the agent user. A
// readText or readBytes answers with stdout frames, a stat with the fs
// message's stat; a writeText takes its bytes as stdin
// frames up to stdin-end. Each answers with an "fs" message or an "error"
// whose code is the errno name.
export type FsRequest =
  | { call: "readText"; path: string }
  | { call: "readBytes"; path: string; max: number }
  | { call: "stat"; path: string }
  | { call: "writeText"; path: string; mode: number; exclusive?: boolean }
  | { call: "mkdir"; path: string; mode: number }
  | { call: "rm"; path: string; recursive?: boolean }
  | { call: "exists"; path: string }
  | { call: "enter"; path: string }
  // The path with every link resolved, as the agent user sees it, as stdout
  // bytes (at most RUNNER_PATH_MAX).
  | { call: "realpath"; path: string }
  | { call: "chmod"; path: string; mode: number };

// Control messages after the request.
export type ClientControl =
  | { type: "stdin-end" }
  // scope: the child alone (kill) or its whole group (signalGroup). Only a
  // wrapped child tells the two apart; absent is "group".
  | { type: "signal"; signal: NodeJS.Signals; scope?: "child" | "group" };

export type RunnerControl =
  | { type: "spawned"; pid: number }
  | { type: "exit"; code: number | null; signal: string | null }
  // stat: the fields of AgentFileStat (server/agent-host.ts).
  | { type: "fs"; value?: boolean; stat?: unknown }
  // This many stdin bytes are in the child's pipe.
  | { type: "stdin-ack"; bytes: number }
  | { type: "error"; code: string; message: string }
  | { type: "exiting" }
  | {
      type: "info";
      uid: number;
      gid: number;
      user: string;
      home: string;
      env: Record<string, string>;
      // The sha256 of the runtime this runner runs (member-runtime.ts); null
      // when it runs from the code tree.
      bundleHash: string | null;
    };
