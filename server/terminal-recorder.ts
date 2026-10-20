// Records an agent terminal session to one file under the state root when
// the office setting "Record terminals" is on (task 749cb7fd). The file holds
// the redacted output, the resizes and who typed when; never a keystroke.
// Format: shared/terminal-recording.ts.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import {
  isTerminalRecordingId,
  isTerminalSize,
  parseTerminalRecording,
  TERMINAL_RECORDINGS_DIR,
  type TerminalRecordingEvent,
  type TerminalRecordingHeader,
  type TerminalRecordingTypist,
} from "../shared/terminal-recording.ts";
import type { TerminalRecordingSummaryWire } from "../shared/contract-shapes.ts";
import { STATE_ROOT } from "./config.ts";
import { createRedactingTextStream } from "./log-redaction.ts";
import { runAtServerStop } from "./server-stop.ts";

export {
  isTerminalRecordingId,
  parseTerminalRecording,
  TERMINAL_RECORDINGS_DIR,
} from "../shared/terminal-recording.ts";

// The recordings still being written, for the prune that spares them.
export function liveTerminalRecordingIds(): Set<string> {
  return new Set([...live].map((recording) => recording.id));
}

// A sanity cap per recording: `tail -f` is unbounded.
export const TERMINAL_RECORDING_CAP_BYTES = 100 * 1024 * 1024;
// A member's input continues the current "u" burst while less than this
// passed since their previous input, or while no output came since the
// burst started (a silent password prompt is one burst at any typing speed).
export const INPUT_BURST_GAP_MS = 2000;
const FLUSH_MS = 250;
const FLUSH_BYTES = 64 * 1024;

export interface TerminalRecordingOptions {
  agentId: string;
  cols: number;
  rows: number;
  startedBy: AuditActor;
  // Defaults to STATE_ROOT.
  root?: string;
  // Test seams.
  now?: () => number;
  capBytes?: number;
  flushMs?: number;
}

export interface TerminalRecording {
  readonly id: string;
  output(data: string): void;
  resize(cols: number, rows: number): void;
  input(actor: TerminalRecordingTypist): void;
  // Writes what is buffered. Resolves even when the write fails.
  flush(): Promise<void>;
  // Writes the held tail and the "end" event. Resolves in every case,
  // including after a write failure stopped the recording.
  close(): Promise<void>;
}

// A server stop or restart ends every terminal session at once (systemd
// signals the server and every sidecar together): each live recording still
// gets its held tail and its "end".
const live = new Set<TerminalRecording>();
runAtServerStop(() =>
  Promise.all([...live].map((recording) => recording.close())),
);

function typist(actor: TerminalRecordingTypist): TerminalRecordingTypist {
  return { kind: actor.kind, id: actor.id, name: actor.name };
}

export function startTerminalRecording(
  options: TerminalRecordingOptions,
): TerminalRecording {
  const now = options.now ?? Date.now;
  const capBytes = options.capBytes ?? TERMINAL_RECORDING_CAP_BYTES;
  const flushMs = options.flushMs ?? FLUSH_MS;
  const dir = join(options.root ?? STATE_ROOT, TERMINAL_RECORDINGS_DIR);
  const id = `tr-${randomBytes(8).toString("hex")}`;
  const path = join(dir, `${id}.cast`);
  const start = now();
  const redactor = createRedactingTextStream();

  // stopped: a write failed or the cap was reached; nothing more is queued.
  let stopped = false;
  // A write failed: no later append runs, so the file has no silent hole.
  let writeFailed = false;
  let closing: Promise<void> | null = null;
  let bytes = 0;
  let pending: string[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastTypist: string | null = null;
  let lastInputAt = 0;
  let outputSinceBurst = false;

  function fail(error: unknown) {
    if (writeFailed) return;
    writeFailed = true;
    stopped = true;
    pending = [];
    pendingBytes = 0;
    console.error(`[terminal-recorder] recording ${id} stopped:`, error);
  }

  const header: TerminalRecordingHeader = {
    version: 2,
    width: options.cols,
    height: options.rows,
    timestamp: start / 1000,
    isomux: {
      agentId: options.agentId,
      recordingId: id,
      startedBy: typist(options.startedBy),
      notice: "panel",
    },
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const fd = openSync(path, "wx", 0o600);
    try {
      const line = JSON.stringify(header) + "\n";
      writeSync(fd, line);
      bytes = Buffer.byteLength(line);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    fail(error);
  }

  function seconds(): number {
    return Math.round(now() - start) / 1000;
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length > 0) {
      const data = pending.join("");
      pending = [];
      pendingBytes = 0;
      writing = writing.then(async () => {
        if (writeFailed) return;
        try {
          await appendFile(path, data, { mode: 0o600 });
        } catch (error) {
          fail(error);
        }
      });
    }
    return writing;
  }

  // Queues one line. Returns false when the line would pass the cap.
  function queue(event: TerminalRecordingEvent, force = false): boolean {
    const line = JSON.stringify(event) + "\n";
    const size = Buffer.byteLength(line);
    if (!force && bytes + size > capBytes) return false;
    bytes += size;
    pending.push(line);
    pendingBytes += size;
    if (pendingBytes >= FLUSH_BYTES) void flush();
    else if (!timer) {
      timer = setTimeout(() => void flush(), flushMs);
      timer.unref?.();
    }
    return true;
  }

  function hitCap(t: number) {
    // The held tail is written when it still fits; the text past the cap is
    // dropped by design.
    const tail = redactor.end();
    if (tail) queue([t, "o", tail]);
    queue([t, "x", "cap"], true);
    stopped = true;
  }

  function record(event: TerminalRecordingEvent) {
    if (stopped || closing) return;
    if (!queue(event)) hitCap(event[0]);
  }

  const recording: TerminalRecording = {
    id,
    output(data) {
      if (stopped || closing) return;
      outputSinceBurst = true;
      const text = redactor.push(data);
      if (text) record([seconds(), "o", text]);
    },
    resize(cols, rows) {
      if (isTerminalSize(cols, rows))
        record([seconds(), "r", `${cols}x${rows}`]);
    },
    input(actor) {
      if (stopped || closing) return;
      const at = now();
      const burst =
        actor.id === lastTypist &&
        (at - lastInputAt < INPUT_BURST_GAP_MS || !outputSinceBurst);
      lastInputAt = at;
      if (burst) return;
      lastTypist = actor.id;
      outputSinceBurst = false;
      record([seconds(), "u", typist(actor)]);
    },
    flush,
    close() {
      if (!closing) {
        if (!stopped) {
          const t = seconds();
          const tail = redactor.end();
          if (tail && !queue([t, "o", tail])) hitCap(t);
          if (!stopped) queue([t, "x", "end"], true);
        }
        closing = flush();
        live.delete(recording);
      }
      return closing;
    },
  };
  live.add(recording);
  return recording;
}

export type TerminalRecordingSummary = TerminalRecordingSummaryWire & {
  startedBy: TerminalRecordingTypist;
};

// The first and the last line of a file, read without loading the whole file.
function edgeLines(
  path: string,
  size: number,
): { first: string; last: string } {
  const fd = openSync(path, "r");
  try {
    const read = (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const n = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, n).toString("utf8");
    };
    const head = read(0, Math.min(size, 64 * 1024));
    const tail = read(Math.max(0, size - 4096), Math.min(size, 4096));
    const lines = tail.split("\n").filter(Boolean);
    return { first: head.split("\n")[0], last: lines.at(-1) ?? "" };
  } finally {
    closeSync(fd);
  }
}

function summarize(path: string, id: string): TerminalRecordingSummary | null {
  try {
    const size = statSync(path).size;
    const { first, last } = edgeLines(path, size);
    const { header } = parseTerminalRecording(first);
    const startedAt = Math.round(header.timestamp * 1000);
    const summary: TerminalRecordingSummary = {
      id,
      agentId: header.isomux.agentId,
      startedAt,
      startedBy: header.isomux.startedBy,
      bytes: size,
    };
    const lastEvent = parseTerminalRecording(`${first}\n${last}`).events[0];
    if (lastEvent?.[1] === "x" && lastEvent[2] === "end")
      summary.endedAt = startedAt + Math.round(lastEvent[0] * 1000);
    if (lastEvent?.[1] === "x" && lastEvent[2] === "cap") summary.capped = true;
    return summary;
  } catch {
    return null;
  }
}

// Newest first.
export function listTerminalRecordings(options: {
  root?: string;
  agentId?: string;
}): TerminalRecordingSummary[] {
  const dir = join(options.root ?? STATE_ROOT, TERMINAL_RECORDINGS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items: TerminalRecordingSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".cast")) continue;
    const id = name.slice(0, -".cast".length);
    if (!isTerminalRecordingId(id)) continue;
    const summary = summarize(join(dir, name), id);
    if (!summary) continue;
    if (options.agentId !== undefined && summary.agentId !== options.agentId)
      continue;
    items.push(summary);
  }
  return items.sort(
    (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1),
  );
}

// The file of a recording, or null for an id that is not a recording id.
export function terminalRecordingPath(
  id: string,
  root?: string,
): string | null {
  if (!isTerminalRecordingId(id)) return null;
  return join(root ?? STATE_ROOT, TERMINAL_RECORDINGS_DIR, `${id}.cast`);
}
