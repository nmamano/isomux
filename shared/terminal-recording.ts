// The file format of a terminal recording (task 749cb7fd). The server writes
// it (server/terminal-recorder.ts); the replay view and the agent route read
// it. The layout follows asciicast v2: a header line, then one JSON array per
// event. The "u" and "x" events are Isomux's own.

import type { AuditActor } from "./audit.ts";

// The member who typed, as the server's authenticated socket names them.
export type TerminalRecordingTypist = Pick<AuditActor, "kind" | "id" | "name">;

export interface TerminalRecordingHeader {
  version: 2;
  width: number;
  height: number;
  // Unix seconds at the start of the recording.
  timestamp: number;
  isomux: {
    agentId: string;
    recordingId: string;
    startedBy: TerminalRecordingTypist;
    // Every member who opened the terminal saw the panel notice.
    notice: "panel";
  };
}

// t is seconds since the start of the recording, in milliseconds precision.
export type TerminalRecordingEvent =
  // Output, after redaction.
  | [t: number, kind: "o", data: string]
  // Resize, "COLSxROWS".
  | [t: number, kind: "r", size: string]
  // A member started typing. No keystrokes and no count.
  | [t: number, kind: "u", typist: TerminalRecordingTypist]
  // The 100 MB cap stopped capture, or the recording ended.
  | [t: number, kind: "x", reason: "cap" | "end"];

export interface ParsedTerminalRecording {
  header: TerminalRecordingHeader;
  events: TerminalRecordingEvent[];
}

// Under the state root. Flat, so a recording outlives its agent.
export const TERMINAL_RECORDINGS_DIR = "terminal-recordings";

// The largest terminal side a recording keeps. A resize comes from a member's
// socket, and the replay applies it, so a size no terminal has is dropped.
export const MAX_TERMINAL_SIDE = 1000;

export function isTerminalSize(cols: number, rows: number): boolean {
  return [cols, rows].every(
    (side) => Number.isInteger(side) && side >= 1 && side <= MAX_TERMINAL_SIDE,
  );
}

export const TERMINAL_RECORDING_ID_PATTERN = /^tr-[0-9a-f]{16}$/;

export function isTerminalRecordingId(id: string): boolean {
  return TERMINAL_RECORDING_ID_PATTERN.test(id);
}

function isEvent(value: unknown): value is TerminalRecordingEvent {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [t, kind, data] = value as unknown[];
  if (typeof t !== "number") return false;
  if (kind === "o" || kind === "r") return typeof data === "string";
  if (kind === "x") return data === "cap" || data === "end";
  if (kind === "u")
    return (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { id?: unknown }).id === "string" &&
      typeof (data as { name?: unknown }).name === "string"
    );
  return false;
}

function isHeader(value: unknown): value is TerminalRecordingHeader {
  if (typeof value !== "object" || value === null) return false;
  const header = value as Partial<TerminalRecordingHeader>;
  return (
    header.version === 2 &&
    typeof header.width === "number" &&
    typeof header.height === "number" &&
    isTerminalSize(header.width, header.height) &&
    typeof header.timestamp === "number" &&
    typeof header.isomux?.agentId === "string" &&
    typeof header.isomux.recordingId === "string" &&
    typeof header.isomux.startedBy?.id === "string" &&
    typeof header.isomux.startedBy.name === "string"
  );
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// Parses a recording. A recording that the server did not close (a crash)
// has no "end" event; a torn last line is skipped. Throws on a missing or
// malformed header.
export function parseTerminalRecording(text: string): ParsedTerminalRecording {
  const lines = text.split("\n");
  const header = parseLine(lines[0]);
  if (!isHeader(header)) throw new Error("not a terminal recording");
  const events: TerminalRecordingEvent[] = [];
  for (const line of lines.slice(1)) {
    const event = line ? parseLine(line) : undefined;
    if (isEvent(event)) events.push(event);
  }
  return { header, events };
}
