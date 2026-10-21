// The on-disk names of a session transcript, plain or compressed:
//
//   <logsDir>/<agentId>/<sessionId>.jsonl     one log entry per line
//   <logsDir>/<agentId>/<sessionId>.jsonl.gz  the same bytes, gzipped
//
// Every reader and writer of logs/ goes through this module, so the two
// suffixes live in one place. When both files exist (a crash between the
// rename and the unlink of a compress or an inflate), the .jsonl wins and the
// .gz is stale.

import { join } from "path";
import {
  closeSync,
  existsSync,
  fsyncSync,
  futimesSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { constants as zlibConstants, gunzipSync, gzip, gzipSync } from "zlib";
import { isSafeId } from "./log-search.ts";

export const TRANSCRIPT_SUFFIX = ".jsonl";
export const COMPRESSED_TRANSCRIPT_SUFFIX = ".jsonl.gz";
const TMP_SUFFIX = ".tmp";

export interface TranscriptFile {
  path: string;
  compressed: boolean;
}

// The session id of a transcript file name: exactly `<safeId>.jsonl` or
// `<safeId>.jsonl.gz`, never a temp file. null for any other name.
export function sessionIdOfTranscript(
  name: string,
): { sessionId: string; compressed: boolean } | null {
  for (const [suffix, compressed] of [
    [COMPRESSED_TRANSCRIPT_SUFFIX, true],
    [TRANSCRIPT_SUFFIX, false],
  ] as const) {
    if (!name.endsWith(suffix)) continue;
    const sessionId = name.slice(0, -suffix.length);
    return isSafeId(sessionId) ? { sessionId, compressed } : null;
  }
  return null;
}

// The file that holds the session: the .jsonl when it exists, else the .gz,
// else null.
export function resolveTranscript(
  agentDir: string,
  sessionId: string,
): TranscriptFile | null {
  const plain = join(agentDir, sessionId + TRANSCRIPT_SUFFIX);
  if (existsSync(plain)) return { path: plain, compressed: false };
  const packed = join(agentDir, sessionId + COMPRESSED_TRANSCRIPT_SUFFIX);
  if (existsSync(packed)) return { path: packed, compressed: true };
  return null;
}

// The whole transcript as text. Throws when the file cannot be read or a .gz
// cannot be decompressed.
export function readTranscriptSync(file: TranscriptFile): string {
  return readTranscriptBytes(file).toString("utf8");
}

function readTranscriptBytes(file: TranscriptFile): Buffer {
  const raw = readFileSync(file.path);
  return file.compressed ? gunzipSync(raw) : raw;
}

function readPrefix(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

// At most the first `maxBytes` bytes of the transcript text. For a .gz it
// decompresses only a prefix of the file, larger each time until the text is
// long enough, so a listing never inflates a whole old session.
export function readTranscriptHeadSync(
  file: TranscriptFile,
  maxBytes: number,
): string {
  if (!file.compressed) return readPrefix(file.path, maxBytes).toString("utf8");
  const size = statSync(file.path).size;
  for (let take = maxBytes; ; take *= 4) {
    const prefix = readPrefix(file.path, Math.min(take, size));
    const text = gunzipSync(prefix, {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    });
    if (text.length >= maxBytes || prefix.length >= size)
      return text.subarray(0, maxBytes).toString("utf8");
  }
}

// The transcript text as a byte stream, decompressed for a .gz.
export function transcriptByteStream(
  file: TranscriptFile,
): ReadableStream<Uint8Array> {
  const raw = Bun.file(file.path).stream();
  return file.compressed
    ? raw.pipeThrough(new DecompressionStream("gzip"))
    : raw;
}

// Writes `bytes` to `target` through `<target>.tmp`, durably: the data and
// the rename are on disk before this returns, so the caller may then delete
// the source. A leftover temp file from a crash is replaced.
function writeDurably(
  agentDir: string,
  target: string,
  bytes: Uint8Array,
  mtimeMs: number,
): void {
  const tmp = target + TMP_SUFFIX;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      const seconds = mtimeMs / 1000;
      futimesSync(fd, seconds, seconds);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const dirFd = openSync(agentDir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// Turns a compressed session back into a plain .jsonl before an append. Does
// nothing when the .jsonl exists or there is no .gz. Throws when it fails, and
// then leaves the .gz in place and no .jsonl.
export function inflateTranscript(agentDir: string, sessionId: string): void {
  const plain = join(agentDir, sessionId + TRANSCRIPT_SUFFIX);
  const packed = join(agentDir, sessionId + COMPRESSED_TRANSCRIPT_SUFFIX);
  if (existsSync(plain) || !existsSync(packed)) return;
  const bytes = readTranscriptBytes({ path: packed, compressed: true });
  writeDurably(agentDir, plain, bytes, statSync(packed).mtimeMs);
  unlinkSync(packed);
}

// Gzips <sessionId>.jsonl to <sessionId>.jsonl.gz with the same mtime, then
// removes the .jsonl. The .gz is on disk (fsynced, directory too) before the
// unlink. A stale .gz from a crash is replaced. Returns the sizes before and
// after.
export function compressTranscript(
  agentDir: string,
  sessionId: string,
): { bytesBefore: number; bytesAfter: number } {
  const plain = join(agentDir, sessionId + TRANSCRIPT_SUFFIX);
  const source = statSync(plain);
  const gz = gzipSync(readFileSync(plain));
  return commitCompressed(agentDir, sessionId, source, gz)!;
}

export interface GzippedTranscript {
  source: { size: number; mtimeMs: number };
  gz: Buffer;
}

// The first half of a compress that does not block the server: reads the
// .jsonl and gzips it on the thread pool. Nothing on disk changes.
export async function gzipTranscript(
  agentDir: string,
  sessionId: string,
): Promise<GzippedTranscript> {
  const plain = join(agentDir, sessionId + TRANSCRIPT_SUFFIX);
  const { size, mtimeMs } = statSync(plain);
  const data = readFileSync(plain);
  const gz = await new Promise<Buffer>((resolve, reject) =>
    gzip(data, (err, out) => (err ? reject(err) : resolve(out))),
  );
  return { source: { size, mtimeMs }, gz };
}

// The second half, in one synchronous block: when the .jsonl is still what
// was gzipped, writes the .gz and removes the .jsonl. null, with nothing
// changed, when an append landed in between.
export function commitCompressed(
  agentDir: string,
  sessionId: string,
  source: { size: number; mtimeMs: number },
  gz: Buffer,
): { bytesBefore: number; bytesAfter: number } | null {
  const plain = join(agentDir, sessionId + TRANSCRIPT_SUFFIX);
  const packed = join(agentDir, sessionId + COMPRESSED_TRANSCRIPT_SUFFIX);
  const now = statSync(plain);
  if (now.size !== source.size || now.mtimeMs !== source.mtimeMs) return null;
  writeDurably(agentDir, packed, gz, source.mtimeMs);
  unlinkSync(plain);
  return { bytesBefore: source.size, bytesAfter: gz.length };
}
