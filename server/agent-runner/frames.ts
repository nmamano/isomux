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
      stderr?: "pipe" | "ignore";
    }
  | { op: "entry"; name: string; input: unknown }
  | { op: "info" };

// Control messages after the request.
export type ClientControl =
  | { type: "stdin-end" }
  | { type: "signal"; signal: NodeJS.Signals };

export type RunnerControl =
  | { type: "spawned"; pid: number }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string }
  | {
      type: "info";
      uid: number;
      gid: number;
      user: string;
      home: string;
      env: Record<string, string>;
    };
