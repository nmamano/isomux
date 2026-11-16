// The pull of an office move (task 78733adf, slice 2a; design:
// internal-docs/office-move-design.md "The pull"). The old office, locked
// for the move, serves its home to the new office:
//
// - the manifest: a job that walks the home through moveScope and writes
//   NDJSON entries to the move scratch folder;
// - batches: a stream of records (entry header, length-prefixed content
//   chunks, a {bytes, sha256, changed?} trailer; or an error record), never
//   a tar;
// - sealing: every response is AES-256-GCM under a key derived per response
//   (HKDF-SHA256 of the code key with a fresh random salt), the nonce is the
//   chunk counter, and the AAD binds the route, the manifest, the batch, the
//   item list, the chunk index and the final flag.
//
// The sealing and the record reader are shared with the new office (2b).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { createMoveOutsideScope } from "./office-move-outside.ts";
import { errMessage } from "../shared/errors.ts";
import {
  moveScope,
  type MoveEntryKind,
  type MoveScope,
} from "./office-move-scope.ts";
import type {
  MoveExcludedUnit,
  MoveOutsideFolder,
} from "../shared/office-move.ts";

/** The most plaintext in one sealed chunk. */
export const MOVE_SEAL_CHUNK_BYTES = 1024 * 1024;
/** The most body a batch request reads (after the session check). */
export const MOVE_BATCH_BODY_MAX_BYTES = 1024 * 1024;

const SALT_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const SEAL_INFO = "isomux-move-1 seal";
/** The 16 bytes every SQLite database starts with. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
/** The smallest SQLite database with a page. */
const SQLITE_MIN_BYTES = 512;
const SQLITE_SIDE_SUFFIXES = ["-wal", "-shm", "-journal"];
/** The most content in one data record. */
const DATA_RECORD_BYTES = 1024 * 1024;
/** The most bytes of a JSON record (header, trailer, error). */
const JSON_RECORD_MAX_BYTES = 1024 * 1024;

/** One manifest entry (NDJSON line). */
export interface MoveManifestEntry {
  /** The path relative to the home. */
  p: string;
  t: "f" | "d" | "l";
  /** Size in bytes (lstat). */
  s: number;
  /** mtime in ms. */
  m: number;
  mode: number;
  /** The link target, for t "l". */
  l?: string;
  /** 1 for a SQLite database (it goes as a snapshot). */
  q?: 1;
}

export type { MoveExcludedUnit } from "../shared/office-move.ts";

export interface MoveManifestSummary {
  entries: number;
  /** Regular file bytes only (the new office's free-space check). */
  totalBytes: number;
  excluded: MoveExcludedUnit[];
  /** Sockets, fifos and devices left out. */
  skipped: number;
  /** Paths the walk could not read. */
  unreadable: string[];
}

/** One item of a batch request. A range only on a regular, non-SQLite
 *  file. */
export interface MoveBatchItem {
  path: string;
  offset?: number;
  length?: number;
}

/** What a sealed response binds in its AAD. */
export interface MoveSealContext {
  route: "manifest" | "batch";
  manifestId: string;
  /** The batch number; 0 for the manifest data. */
  batch: number;
  /** sha256 hex of the item list (moveItemsHash); "" for the manifest. */
  itemsHash: string;
  /** Slice 5b: the index of the outside folder in the manifest job's list;
   *  absent for the home (whose context string is unchanged). */
  outside?: number;
}

const sha256Hex = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

/** sha256 (hex) of a batch's item list, canonical JSON. */
export function moveItemsHash(items: MoveBatchItem[]): string {
  return sha256Hex(
    JSON.stringify(
      items.map((i) => [i.path, i.offset ?? null, i.length ?? null]),
    ),
  );
}

// ---- bytes ----

/** A FIFO of byte chunks that hands out exact lengths. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private head = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  /** The next n bytes (n <= length), as one Buffer. */
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const avail = c.byteLength - this.head;
      const used = Math.min(avail, n - filled);
      out.set(c.subarray(this.head, this.head + used), filled);
      filled += used;
      this.head += used;
      if (this.head === c.byteLength) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.length -= n;
    return out;
  }
}

/** Reads from an async source into a queue until it holds n bytes; false
 *  when the source ended first. */
async function fill(
  queue: ByteQueue,
  source: AsyncIterator<Uint8Array>,
  n: number,
): Promise<boolean> {
  while (queue.length < n) {
    const r = await source.next();
    if (r.done) return false;
    queue.push(r.value);
  }
  return true;
}

// ---- sealing ----

function contextString(ctx: MoveSealContext): string {
  const base = [ctx.route, ctx.manifestId, ctx.batch, ctx.itemsHash];
  // The home's string is the one of an office before slice 5b.
  return JSON.stringify(
    ctx.outside === undefined ? base : [...base, ctx.outside],
  );
}

function responseKey(key: Uint8Array, salt: Uint8Array, ctx: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, salt, `${SEAL_INFO}${ctx}`, 32));
}

function chunkAad(ctx: string, index: number, final: boolean): Buffer {
  return Buffer.from(`${ctx}|${index}|${final ? 1 : 0}`);
}

function chunkNonce(index: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(BigInt(index), NONCE_BYTES - 8);
  return nonce;
}

function sealChunk(
  key: Buffer,
  ctx: string,
  index: number,
  final: boolean,
  plain: Uint8Array,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, chunkNonce(index));
  cipher.setAAD(chunkAad(ctx, index, final));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.byteLength);
  return Buffer.concat([len, body, cipher.getAuthTag()]);
}

async function* sealedFrames(
  key: Uint8Array,
  ctx: MoveSealContext,
  plain: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const salt = randomBytes(SALT_BYTES);
  const c = contextString(ctx);
  const k = responseKey(key, salt, c);
  yield salt;
  const queue = new ByteQueue();
  let index = 0;
  for await (const piece of plain) {
    queue.push(piece);
    // Strictly more than a chunk: the chunk sent now is not the last.
    while (queue.length > MOVE_SEAL_CHUNK_BYTES)
      yield sealChunk(k, c, index++, false, queue.take(MOVE_SEAL_CHUNK_BYTES));
  }
  yield sealChunk(k, c, index, true, queue.take(queue.length));
}

/** Seals a plaintext stream: salt header, then frames. Cancelling the
 *  stream returns the plaintext iterator, so its cleanup runs. */
export function sealMoveStream(
  key: Uint8Array,
  ctx: MoveSealContext,
  plain: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const frames = sealedFrames(key, ctx, plain);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await frames.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        console.error("[move] a sealed response failed:", errMessage(err));
        controller.error(err);
      }
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
}

/** Opens a sealed stream and yields the plaintext. Throws MoveSealError on
 *  a bad tag, a wrong context, a frame out of order or a stream without its
 *  final chunk. */
export async function* openMoveStream(
  key: Uint8Array,
  ctx: MoveSealContext,
  sealed: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const source = sealed[Symbol.asyncIterator]();
  const queue = new ByteQueue();
  try {
    if (!(await fill(queue, source, SALT_BYTES)))
      throw new MoveSealError("The sealed stream ends before its salt.");
    const c = contextString(ctx);
    const k = responseKey(key, queue.take(SALT_BYTES), c);
    for (let index = 0; ; index++) {
      if (!(await fill(queue, source, 4)))
        throw new MoveSealError(
          "The sealed stream ends before its last chunk.",
        );
      const len = queue.take(4).readUInt32BE(0);
      if (len > MOVE_SEAL_CHUNK_BYTES)
        throw new MoveSealError("A sealed chunk is too large.");
      if (!(await fill(queue, source, len + TAG_BYTES)))
        throw new MoveSealError("The sealed stream is cut in a chunk.");
      const body = queue.take(len);
      const tag = queue.take(TAG_BYTES);
      // The last chunk is the one nothing follows.
      const final = !(await fill(queue, source, 1));
      let plain: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", k, chunkNonce(index));
        decipher.setAAD(chunkAad(c, index, final));
        decipher.setAuthTag(tag);
        plain = Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw new MoveSealError(
          "A sealed chunk does not open: wrong key, context or order, or a cut stream.",
        );
      }
      yield plain;
      if (final) return;
    }
  } finally {
    await source.return?.();
  }
}

export class MoveSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveSealError";
  }
}

// ---- records ----

const REC_ENTRY = 1;
const REC_DATA = 2;
const REC_END = 3;
const REC_ERROR = 4;

function record(kind: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([head, payload]);
}

const jsonRecord = (kind: number, value: unknown) =>
  record(kind, Buffer.from(JSON.stringify(value)));

/** One event of a batch's record stream. */
export type MoveRecordEvent =
  | {
      type: "entry";
      path: string;
      t: "f" | "d" | "l";
      mode: number;
      mtime: number;
      link?: string;
      q?: 1;
      offset?: number;
    }
  | { type: "data"; bytes: Uint8Array }
  /** The end of an entry: what was read. `changed` when the file's size or
   *  mtime moved while it was read. */
  | { type: "end"; bytes: number; sha256: string; changed?: true }
  /** An item that failed. It can also end an entry whose content was cut. */
  | { type: "error"; path: string; error: string };

class MoveRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveRecordError";
  }
}

function parseJsonRecord(payload: Buffer): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new MoveRecordError("A record does not parse.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new MoveRecordError("A record is not an object.");
  return v as Record<string, unknown>;
}

function entryEvent(r: Record<string, unknown>): MoveRecordEvent {
  if (
    typeof r.path !== "string" ||
    (r.t !== "f" && r.t !== "d" && r.t !== "l") ||
    typeof r.mode !== "number" ||
    typeof r.mtime !== "number" ||
    (r.link !== undefined && typeof r.link !== "string") ||
    (r.q !== undefined && r.q !== 1) ||
    (r.offset !== undefined && typeof r.offset !== "number")
  )
    throw new MoveRecordError("An entry header is malformed.");
  return {
    type: "entry",
    path: r.path,
    t: r.t,
    mode: r.mode,
    mtime: r.mtime,
    ...(r.link !== undefined ? { link: r.link } : {}),
    ...(r.q === 1 ? { q: 1 as const } : {}),
    ...(r.offset !== undefined ? { offset: r.offset } : {}),
  };
}

/** Parses a batch's plaintext. Throws on a malformed stream, or when an
 *  entry's content does not match its trailer (count or sha256). */
export async function* readMoveRecords(
  plain: AsyncIterable<Uint8Array>,
): AsyncGenerator<MoveRecordEvent> {
  const source = plain[Symbol.asyncIterator]();
  const queue = new ByteQueue();
  let open: { hash: ReturnType<typeof createHash>; bytes: number } | null =
    null;
  try {
    for (;;) {
      if (!(await fill(queue, source, 5))) {
        if (queue.length > 0 || open)
          throw new MoveRecordError("The record stream is cut.");
        return;
      }
      const head = queue.take(5);
      const kind = head.readUInt8(0);
      const len = head.readUInt32BE(1);
      const max = kind === REC_DATA ? DATA_RECORD_BYTES : JSON_RECORD_MAX_BYTES;
      if (len > max) throw new MoveRecordError("A record is too large.");
      if (!(await fill(queue, source, len)))
        throw new MoveRecordError("The record stream is cut in a record.");
      const payload = queue.take(len);
      switch (kind) {
        case REC_ENTRY:
          if (open)
            throw new MoveRecordError("An entry starts inside another.");
          open = { hash: createHash("sha256"), bytes: 0 };
          yield entryEvent(parseJsonRecord(payload));
          break;
        case REC_DATA:
          if (!open) throw new MoveRecordError("Content outside an entry.");
          open.hash.update(payload);
          open.bytes += payload.byteLength;
          yield { type: "data", bytes: payload };
          break;
        case REC_END: {
          if (!open) throw new MoveRecordError("A trailer outside an entry.");
          const r = parseJsonRecord(payload);
          const got = open.hash.digest("hex");
          if (r.bytes !== open.bytes || r.sha256 !== got)
            throw new MoveRecordError(
              "An entry's content does not match its trailer.",
            );
          open = null;
          yield {
            type: "end",
            bytes: r.bytes,
            sha256: got,
            ...(r.changed === true ? { changed: true as const } : {}),
          };
          break;
        }
        case REC_ERROR: {
          const r = parseJsonRecord(payload);
          if (typeof r.path !== "string" || typeof r.error !== "string")
            throw new MoveRecordError("An error record is malformed.");
          open = null;
          yield { type: "error", path: r.path, error: r.error };
          break;
        }
        default:
          throw new MoveRecordError("A record has an unknown kind.");
      }
    }
  } finally {
    await source.return?.();
  }
}

// ---- the batch ----

// The walk and the batch use sync calls for metadata and small reads: in
// Bun each awaited fs/promises call costs a fraction of a millisecond, which
// made a big home take most of an hour. They give the event loop a turn at
// least every YIELD_EVERY_MS instead.
const YIELD_EVERY_MS = 10;

function createBreather(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };
}

export interface MoveBatchSource {
  scope: MoveScope;
  /** The move scratch folder (SQLite snapshots, named per request). */
  scratchDir: string;
  /** VACUUM INTO src -> dst on a read-only connection. Production:
   *  snapshotOfficeDatabase with a time limit that grows with the file. */
  snapshot(src: string, dst: string): Promise<void>;
  /** Slice 5b: an outside folder's root must still be its own realpath at
   *  each batch (a link there gives every item an error record). */
  exactRoot?: boolean;
}

class ItemRefused extends Error {}

/** Slice 4: the pairing ended while a batch was served. */
class PairingEnded extends Error {
  constructor() {
    super("The move pairing ended.");
    this.name = "PairingEnded";
  }
}

function kindOf(st: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): MoveEntryKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

// A relative path with "/" separators, no empty, "." or ".." part.
function cleanRelPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    return false;
  if (path.startsWith("/")) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

const OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function startsWithSqliteMagic(fd: number): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  return (
    readSync(fd, head, 0, head.length, 0) === head.length &&
    head.equals(SQLITE_MAGIC)
  );
}

/** Whether `abs` is a regular file that starts with the SQLite magic. Never
 *  follows a link. */
function isSqliteFile(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(abs, OPEN_FLAGS);
    const st = fstatSync(fd);
    return (
      st.isFile() && st.size >= SQLITE_MIN_BYTES && startsWithSqliteMagic(fd)
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sqliteBase(path: string): string | null {
  for (const suffix of SQLITE_SIDE_SUFFIXES)
    if (path.endsWith(suffix) && path.length > suffix.length)
      return path.slice(0, -suffix.length);
  return null;
}

function checkRange(
  item: MoveBatchItem,
): { offset: number; length: number | null } | null {
  if (item.offset === undefined && item.length === undefined) return null;
  const offset = item.offset ?? 0;
  const length = item.length ?? null;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ItemRefused("The range's offset is not a whole number of bytes.");
  if (length !== null && (!Number.isSafeInteger(length) || length < 1))
    throw new ItemRefused("The range's length is not a whole number of bytes.");
  return { offset, length };
}

/** The content of an open file as data records and a trailer, read in
 *  pieces (bounded memory). */
function* fileContent(
  fd: number,
  from: number,
  length: number | null,
): Generator<Buffer> {
  const before = fstatSync(fd);
  const hash = createHash("sha256");
  let sent = 0;
  let position = from;
  for (;;) {
    const cap =
      length === null
        ? DATA_RECORD_BYTES
        : Math.min(DATA_RECORD_BYTES, length - sent);
    if (cap <= 0) break;
    // Sized to what the file holds, so a small file does not allocate a
    // whole record; a file that grew is read on in later pieces.
    const want = Math.min(cap, Math.max(4096, before.size - position));
    const buf = Buffer.allocUnsafe(want);
    const bytesRead = readSync(fd, buf, 0, want, position);
    if (bytesRead === 0) break;
    const piece = buf.subarray(0, bytesRead);
    hash.update(piece);
    sent += bytesRead;
    position += bytesRead;
    yield record(REC_DATA, piece);
  }
  const after = fstatSync(fd);
  const changed =
    after.size !== before.size || after.mtimeMs !== before.mtimeMs;
  yield jsonRecord(REC_END, {
    bytes: sent,
    sha256: hash.digest("hex"),
    ...(changed ? { changed: true } : {}),
  });
}

const EMPTY_SHA256 = sha256Hex("");

async function* oneItem(
  src: MoveBatchSource,
  realHome: string,
  parents: Map<string, boolean>,
  item: MoveBatchItem,
  snapshots: boolean,
): AsyncGenerator<Buffer> {
  const path = item?.path;
  if (!cleanRelPath(path))
    throw new ItemRefused("The path is not a plain path in the home.");
  const range = checkRange(item);
  // The path alone can already be out of the move.
  if (!moveScope(src.scope, path, "file").in)
    throw new ItemRefused("The path is not part of the move.");
  // Every folder on the way must be a real folder: a link there could lead
  // out of the home.
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const parent = path.slice(0, slash);
    let ok = parents.get(parent);
    if (ok === undefined) {
      const expected = join(realHome, parent);
      try {
        ok = realpathSync(expected) === expected;
      } catch {
        ok = false;
      }
      parents.set(parent, ok);
    }
    if (!ok)
      throw new ItemRefused("A folder on the path is a link or is gone.");
  }
  const abs = join(realHome, path);
  const st = lstatSync(abs);
  const kind = kindOf(st);
  if (!moveScope(src.scope, path, kind).in)
    throw new ItemRefused("The path is not part of the move.");
  const base = sqliteBase(path);
  if (base !== null && isSqliteFile(join(realHome, base)))
    throw new ItemRefused(
      "A SQLite side file moves inside its database's snapshot.",
    );
  const header = {
    path,
    mode: st.mode & 0o7777,
    mtime: st.mtimeMs,
  };
  if (kind !== "file") {
    if (range) throw new ItemRefused("A range needs a regular file.");
    if (kind === "dir") {
      yield jsonRecord(REC_ENTRY, { ...header, t: "d" });
    } else {
      yield jsonRecord(REC_ENTRY, {
        ...header,
        t: "l",
        link: readlinkSync(abs),
      });
    }
    yield jsonRecord(REC_END, { bytes: 0, sha256: EMPTY_SHA256 });
    return;
  }
  let fd: number | null = openSync(abs, OPEN_FLAGS);
  let snapshot: string | null = null;
  try {
    const fst = fstatSync(fd);
    // The file opened must be the one checked: a swap fails here.
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino)
      throw new ItemRefused("The file changed between the check and the open.");
    const sqlite = fst.size >= SQLITE_MIN_BYTES && startsWithSqliteMagic(fd);
    if (sqlite) {
      if (range)
        throw new ItemRefused("A SQLite file moves whole, as a snapshot.");
      // Slice 4: the office still runs; the pass after the lock takes it.
      if (!snapshots)
        throw new ItemRefused(
          "A SQLite file moves only after the lock, as a snapshot.",
        );
      closeSync(fd);
      fd = null;
      snapshot = join(src.scratchDir, `snapshot-${randomUUID()}.sqlite`);
      try {
        await src.snapshot(abs, snapshot);
      } catch (err) {
        throw new ItemRefused(`The SQLite snapshot failed: ${errMessage(err)}`);
      }
      fd = openSync(snapshot, OPEN_FLAGS);
      yield jsonRecord(REC_ENTRY, { ...header, t: "f", q: 1 });
      yield* fileContent(fd, 0, null);
      return;
    }
    yield jsonRecord(REC_ENTRY, {
      ...header,
      t: "f",
      ...(range ? { offset: range.offset } : {}),
    });
    yield* fileContent(fd, range?.offset ?? 0, range?.length ?? null);
  } finally {
    if (fd !== null) closeSync(fd);
    if (snapshot) rmSync(snapshot, { force: true });
  }
}

/** A batch's plaintext record stream. Each item is checked again (scope,
 *  no absolute path or "..", the parent's realpath, O_NOFOLLOW + dev/ino).
 *  A failing item gives an error record; the stream goes on. Stopping the
 *  iterator deletes the snapshot in use. */
export function writeMoveBatch(
  src: MoveBatchSource,
  items: MoveBatchItem[],
  opts: MoveBatchOpts = {},
): AsyncIterable<Uint8Array> {
  return batchRecords(src, items, opts);
}

/** Slice 4: how a batch runs. */
export interface MoveBatchOpts {
  /** Ends the stream (the pairing ended): the snapshot in use is deleted. */
  signal?: AbortSignal;
  /** False while the office still runs (state `paired`): a SQLite file, as
   *  the bytes opened show it, gets an error record and no VACUUM INTO.
   *  Default true. */
  snapshots?: boolean;
}

/** Slice 4: the order of walkMoveManifest's entries. Entries are grouped by
 *  their folder; the groups come in depth-first name order (a folder before
 *  what it holds), and the names in a group in JS string order. Negative
 *  when `a` comes first. */
export function compareMoveWalkOrder(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a.lastIndexOf("/");
  const ib = b.lastIndexOf("/");
  const pa = ia < 0 ? "" : a.slice(0, ia);
  const pb = ib < 0 ? "" : b.slice(0, ib);
  if (pa === pb) return codeUnitOrder(a.slice(ia + 1), b.slice(ib + 1));
  // Folder groups: the root first, then depth first in name order (an
  // ancestor before what it holds).
  if (pa === "") return -1;
  if (pb === "") return 1;
  const sa = pa.split("/");
  const sb = pb.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i++)
    if (sa[i] !== sb[i]) return codeUnitOrder(sa[i], sb[i]);
  return sa.length - sb.length;
}

/** The order of Array.prototype.sort with no comparator (UTF-16 code
 *  units), which the walk uses. */
const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function* batchRecords(
  src: MoveBatchSource,
  items: MoveBatchItem[],
  opts: MoveBatchOpts,
): AsyncGenerator<Uint8Array> {
  let realHome: string | null;
  try {
    realHome = realpathSync(src.scope.home);
  } catch {
    realHome = null;
  }
  // Slice 5b: an outside folder that is gone or became a link is read no
  // more.
  const rootGone =
    realHome === null ||
    (src.exactRoot === true && realHome !== src.scope.home);
  const parents = new Map<string, boolean>();
  const breathe = createBreather();
  const snapshots = opts.snapshots !== false;
  const ended = () => {
    if (opts.signal?.aborted) throw new PairingEnded();
  };
  for (const item of items) {
    ended();
    const path = typeof item?.path === "string" ? item.path : "";
    if (rootGone) {
      yield jsonRecord(REC_ERROR, {
        path,
        error: "The folder is gone or is a link now.",
      });
      continue;
    }
    try {
      for await (const rec of oneItem(
        src,
        realHome!,
        parents,
        item,
        snapshots,
      )) {
        ended();
        yield rec;
        await breathe();
      }
    } catch (err) {
      if (err instanceof PairingEnded) throw err;
      const error =
        err instanceof ItemRefused
          ? err.message
          : `The item could not be read: ${errMessage(err)}`;
      yield jsonRecord(REC_ERROR, { path, error });
    }
    await breathe();
  }
}

// ---- the manifest ----

interface Listed {
  name: string;
  rel: string;
  st: Stats;
  kind: MoveEntryKind;
}

/** Walks the home through moveScope and writes the NDJSON manifest to
 *  `outFile` (0600). A bound unit is walked only to count it. */
export async function walkMoveManifest(
  scope: MoveScope,
  outFile: string,
  opts: { onProgress?(entries: number): void; signal?: AbortSignal } = {},
): Promise<MoveManifestSummary> {
  const realHome = realpathSync(scope.home);
  const out = openSync(outFile, "w", 0o600);
  chmodSync(outFile, 0o600);
  const breathe = createBreather();
  const summary: MoveManifestSummary = {
    entries: 0,
    totalBytes: 0,
    excluded: [],
    skipped: 0,
    unreadable: [],
  };
  const units = new Map<string, MoveExcludedUnit>();
  let pending = "";
  const flush = (force: boolean) => {
    if (pending.length > 0 && (force || pending.length > 1024 * 1024)) {
      writeSync(out, pending);
      pending = "";
    }
  };
  const count = (unit: string, st: Stats) => {
    let u = units.get(unit);
    if (!u) {
      u = { unit, entries: 0, bytes: 0 };
      units.set(unit, u);
    }
    u.entries++;
    if (st.isFile()) u.bytes += st.size;
  };
  const stopped = () => {
    if (opts.signal?.aborted) throw new PairingEnded();
  };
  const list = async (rel: string): Promise<Listed[] | null> => {
    stopped();
    let names: string[];
    try {
      names = readdirSync(rel ? join(realHome, rel) : realHome);
    } catch {
      summary.unreadable.push(rel);
      return null;
    }
    names.sort();
    const listed: Listed[] = [];
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      try {
        const st = lstatSync(join(realHome, childRel));
        listed.push({ name, rel: childRel, st, kind: kindOf(st) });
      } catch {
        summary.unreadable.push(childRel);
      }
      await breathe();
      stopped();
    }
    return listed;
  };
  // A bound unit's folder: counted, never listed.
  const countUnit = async (unit: string, rel: string) => {
    const stack = [rel];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const e of (await list(dir)) ?? []) {
        count(unit, e.st);
        if (e.kind === "dir") stack.push(e.rel);
      }
      await breathe();
    }
  };
  try {
    const stack = [""];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const listed = await list(dir);
      if (!listed) continue;
      const sqlite = new Set<string>();
      for (const e of listed) {
        if (
          e.kind === "file" &&
          e.st.size >= SQLITE_MIN_BYTES &&
          moveScope(scope, e.rel, "file").in &&
          isSqliteFile(join(realHome, e.rel))
        )
          sqlite.add(e.name);
        await breathe();
      }
      const subdirs: string[] = [];
      for (const e of listed) {
        if (e.kind === "other") {
          summary.skipped++;
          continue;
        }
        const verdict = moveScope(scope, e.rel, e.kind);
        if (!verdict.in) {
          if (verdict.why === "bound") {
            count(verdict.unit, e.st);
            if (e.kind === "dir") await countUnit(verdict.unit, e.rel);
          }
          continue;
        }
        const base = sqliteBase(e.name);
        if (base !== null && sqlite.has(base)) continue;
        const entry: MoveManifestEntry = {
          p: e.rel,
          t: e.kind === "dir" ? "d" : e.kind === "symlink" ? "l" : "f",
          s: e.st.size,
          m: e.st.mtimeMs,
          mode: e.st.mode & 0o7777,
        };
        if (e.kind === "symlink") {
          try {
            entry.l = readlinkSync(join(realHome, e.rel));
          } catch {
            summary.unreadable.push(e.rel);
            continue;
          }
        }
        if (sqlite.has(e.name)) entry.q = 1;
        if (e.kind === "file") summary.totalBytes += entry.s;
        if (e.kind === "dir") subdirs.push(e.rel);
        summary.entries++;
        pending += `${JSON.stringify(entry)}\n`;
        stopped();
        flush(false);
      }
      // Depth first, in name order.
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
      opts.onProgress?.(summary.entries);
      await breathe();
    }
    flush(true);
  } finally {
    closeSync(out);
  }
  summary.excluded = [...units.values()].sort((a, b) =>
    a.unit.localeCompare(b.unit),
  );
  return summary;
}

/** Slice 5b: one folder outside the home in a ready manifest. Its entries
 *  are relative to `path`; `?outside=<i>` of the data route and a batch's
 *  `outside: i` index this list. */
export interface MoveOutsideManifest extends MoveManifestSummary {
  path: string;
  mode: number;
  mtime: number;
}

export type MoveManifestStatus =
  | { state: "running"; id: string; entries: number }
  | ({
      state: "ready";
      id: string;
      /** Slice 5b: the folders outside the home, frozen at the job's start
       *  (C4). */
      outside: MoveOutsideManifest[];
      /** The units record of the lock (move-units.json). */
      units: unknown[];
      secretCount: number;
      finishedAt: number;
    } & MoveManifestSummary)
  | { state: "failed"; id: string; error: string };

/** The pull's routes: the MOVE-locked server's (slice 2a), and the running
 *  office's in `paired` (slice 4). */
export interface MovePullDeps {
  manifests: MoveManifestJobs;
  batch: MoveBatchSource;
}

export interface MoveManifestJobs {
  /** One job at a time. */
  start(
    sessionHash: string,
  ): { ok: true; id: string } | { ok: false; message: string };
  status(id: string, sessionHash: string): MoveManifestStatus | null;
  /** The NDJSON file of a ready job of this session, or null. Slice 5b:
   *  `outside` picks a folder of the job's own list; out of range is null. */
  dataFile(id: string, sessionHash: string, outside?: number): string | null;
  /** Slice 5b: the job's outside folder `i`, as the job froze it, or null. */
  outsideFolder(id: string, sessionHash: string, i: number): string | null;
  /** Records that the data of a ready job was served (done needs it). */
  markServed(id: string): void;
  served(id: string, sessionHash: string): boolean;
  /** Slice 4: the pairing ended. Stops a running walk and deletes every
   *  manifest file. */
  clear(): void;
}

interface ManifestJob {
  /** Slice 4: clear() stops the walk. */
  abort: AbortController;
  sessionHash: string;
  file: string;
  /** Slice 5b: the outside folders, frozen at the start (C4), and their
   *  NDJSON files, in the same order. */
  outside: string[];
  outsideFiles: string[];
  status: MoveManifestStatus;
  served: boolean;
}

/** Slice 5b: walks one outside folder. It must be a real folder and its own
 *  realpath (a link fails the job). */
async function walkOutsideFolder(
  path: string,
  file: string,
  signal: AbortSignal,
): Promise<MoveOutsideManifest> {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw new Error(`The folder ${path} cannot be read: ${errMessage(err)}`, {
      cause: err,
    });
  }
  let real: string | null = null;
  try {
    real = realpathSync(path);
  } catch {
    real = null;
  }
  if (!st.isDirectory() || real !== path)
    throw new Error(`The folder ${path} is a link or not a folder.`);
  const summary = await walkMoveManifest(createMoveOutsideScope(path), file, {
    signal,
  });
  return { path, mode: st.mode & 0o7777, mtime: st.mtimeMs, ...summary };
}

export function createMoveManifestJobs(deps: {
  scope: MoveScope;
  /** The move scratch folder. */
  dir: string;
  units(): unknown[];
  secretCount(): number;
  /** Slice 5b: the folders outside the home that move, read once at each
   *  job's start (C4). */
  outside?(): MoveOutsideFolder[];
  now(): Date;
}): MoveManifestJobs {
  const jobs = new Map<string, ManifestJob>();
  const mine = (id: string, sessionHash: string) => {
    const job = jobs.get(id);
    return job && job.sessionHash === sessionHash ? job : null;
  };
  const removeFiles = (job: ManifestJob) => {
    for (const f of [job.file, ...job.outsideFiles]) rmSync(f, { force: true });
  };
  const index = (job: ManifestJob, i: number) =>
    Number.isSafeInteger(i) && i >= 0 && i < job.outside.length;
  return {
    start(sessionHash) {
      for (const job of jobs.values())
        if (job.status.state === "running")
          return { ok: false, message: "A manifest walk is already running." };
      // A new walk replaces the earlier ones: the new office pulls from it.
      for (const [oldId, job] of jobs) {
        removeFiles(job);
        jobs.delete(oldId);
      }
      let outside: string[];
      try {
        outside = (deps.outside?.() ?? []).map((f) => f.path);
      } catch (err) {
        return {
          ok: false,
          message: `The folders outside the home cannot be read: ${errMessage(err)}`,
        };
      }
      const id = randomBytes(12).toString("base64url");
      mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
      const file = join(deps.dir, `${id}.ndjson`);
      const job: ManifestJob = {
        abort: new AbortController(),
        sessionHash,
        file,
        outside,
        outsideFiles: outside.map((_, i) =>
          join(deps.dir, `${id}.outside-${i}.ndjson`),
        ),
        status: { state: "running", id, entries: 0 },
        served: false,
      };
      jobs.set(id, job);
      const walk = async () => {
        const home = await walkMoveManifest(deps.scope, file, {
          signal: job.abort.signal,
          onProgress: (entries) => {
            if (job.status.state === "running")
              job.status = { state: "running", id, entries };
          },
        });
        const folders: MoveOutsideManifest[] = [];
        for (let i = 0; i < outside.length; i++)
          folders.push(
            await walkOutsideFolder(
              outside[i],
              job.outsideFiles[i],
              job.abort.signal,
            ),
          );
        return { home, folders };
      };
      void walk().then(
        ({ home, folders }) => {
          if (job.abort.signal.aborted) return;
          let units: unknown[] = [];
          let secretCount = 0;
          try {
            units = deps.units();
            secretCount = deps.secretCount();
          } catch (err) {
            console.error(
              "[move] could not read the units or the secrets:",
              errMessage(err),
            );
          }
          job.status = {
            state: "ready",
            id,
            ...home,
            units,
            secretCount,
            outside: folders,
            finishedAt: deps.now().getTime(),
          };
        },
        (err: unknown) => {
          removeFiles(job);
          if (job.abort.signal.aborted) return;
          console.error("[move] the manifest walk failed:", errMessage(err));
          job.status = { state: "failed", id, error: errMessage(err) };
        },
      );
      return { ok: true, id };
    },
    status(id, sessionHash) {
      return mine(id, sessionHash)?.status ?? null;
    },
    dataFile(id, sessionHash, outside) {
      const job = mine(id, sessionHash);
      if (!job || job.status.state !== "ready") return null;
      if (outside === undefined) return job.file;
      return index(job, outside) ? job.outsideFiles[outside] : null;
    },
    outsideFolder(id, sessionHash, i) {
      const job = mine(id, sessionHash);
      return job && index(job, i) ? job.outside[i] : null;
    },
    markServed(id) {
      const job = jobs.get(id);
      if (job && job.status.state === "ready") job.served = true;
    },
    served(id, sessionHash) {
      return mine(id, sessionHash)?.served ?? false;
    },
    clear() {
      for (const [id, job] of jobs) {
        job.abort.abort();
        removeFiles(job);
        jobs.delete(id);
      }
    },
  };
}
