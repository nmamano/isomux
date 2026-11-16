// The backup of each isolated member's agent space
// (internal-docs/member-os-user-design.md, slice 3c). Their space is in their
// home, 0700 as them, so the office's walk of the state root never sees it:
// the member's runner lists it and sends the files, as them (member-backup-send.ts),
// and the office writes them beside the copy of the state root:
//
//   <copy>/members/<userId>/member.json        what this copy holds of them
//   <copy>/members/<userId>/space/...          their agent space, files only
//   <copy>/members/<userId>/manifest.jsonl.gz  one line per entry of space/
//
// The member's runner runs as them, so they control every byte of both streams. The
// office trusts only the bytes: it checks each path (a normalised relative
// path, listed once, under a listed folder, not one the exclusions leave
// out), picks every destination, writes each file O_EXCL|O_NOFOLLOW 0600 in
// folders it made itself, never makes a link, and holds each stream to the
// sizes listed first. A file they do not send is counted and named in
// member.json.
//
// Nothing of hers fails the office's copy: a member who is not ready, who
// does not fit in the free space, whose stream breaks or stalls, or whose
// tree does not verify is "carried": their tree of the newest copy that has
// one is hard-linked into this copy (zero bytes), and member.json names the
// copy where it was made. With no such copy they are "skipped": member.json
// only.

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { errMessage } from "../shared/errors.ts";
import type { AgentHost } from "./agent-host.ts";
import { pacer } from "./backup-pacer.ts";
import { MOVE_FILE_MAX } from "./member-move.ts";
import type {
  SpaceEntry,
  SpaceFileHeader,
  SpaceFilesInput,
} from "./member-backup-send.ts";
import { memberSpaceExcluded } from "./member-space-exclusions.ts";

export const MEMBERS_DIR = "members";
export const MEMBER_MARKER = "member.json";
export const MEMBER_SPACE = "space";
export const MEMBER_MANIFEST = "manifest.jsonl.gz";

// The whole time one member may take, both calls together, and the longest
// the member's runner may send nothing.
export const MEMBER_TOTAL_MS = 10 * 60 * 1000;
export const MEMBER_STALL_MS = 60 * 1000;
// Bounds on their listing.
export const LIST_MAX_ENTRIES = 1_000_000;
export const LIST_MAX_BYTES = 64 * 1024 * 1024;
const LINE_MAX = 64 * 1024;
const PATH_MAX = 4096;
const HEADER_MAX = 64 * 1024;
// The names of left-out files kept in member.json.
const LEFT_OUT_NAMES = 100;

export interface MemberBackupSource {
  userId: string;
  osUser: { name: string; uid: number };
  // Null when the member's runner is not ready; `notReady` says why.
  host: AgentHost | null;
  notReady?: string;
}

export interface LeftOut {
  counts: Record<string, number>;
  // The first LEFT_OUT_NAMES paths, relative to their space.
  names: string[];
}

export interface MemberMarker {
  userId: string;
  osUser: { name: string; uid: number };
  state: "copied" | "carried" | "skipped";
  // When this copy's run started.
  at: number;
  // copied and carried: when the run that copied their tree started, and
  // (carried) the name of that copy.
  copiedAt?: number;
  carriedFrom?: string;
  // carried and skipped: why this run did not copy their space.
  reason?: string;
  leftOut?: LeftOut;
  // Links in their space: in the manifest, never made in the copy.
  links?: number;
}

// One manifest line, as the office's (backup.ts), plus o: the mode, and t:
// a link's target.
export interface MemberManifestLine {
  p: string;
  k: "d" | "f" | "l";
  s?: number;
  m?: string;
  c?: string;
  o?: number;
  t?: string;
}

// The newest copy of their tree before this run.
export interface PreviousMemberTree {
  copyName: string;
  dir: string;
  marker: MemberMarker;
}

export interface MemberCopyContext {
  partial: string;
  startedAt: number;
  previous: PreviousMemberTree | null;
  // Does a copy of this many bytes, folders and entries fit now (D1)?
  fits(bytes: number, folders: number, entries: number): boolean;
  // Throws when free space ran out during their writes.
  checkSpace(bytesWritten: number): void;
  link?: (from: string, to: string) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MemberCopyResult {
  userId: string;
  state: MemberMarker["state"];
  reason?: string;
  files: number;
  bytes: number;
  newBytes: number;
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function readMemberMarker(dir: string): MemberMarker | null {
  try {
    const value = JSON.parse(
      readFileSync(join(dir, MEMBER_MARKER), "utf8"),
    ) as MemberMarker;
    if (
      typeof value?.userId !== "string" ||
      !["copied", "carried", "skipped"].includes(value.state)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export async function readMemberManifest(
  dir: string,
): Promise<MemberManifestLine[]> {
  const text = (
    await gunzipAsync(await fsp.readFile(join(dir, MEMBER_MANIFEST)))
  ).toString("utf8");
  const lines: MemberManifestLine[] = [];
  const pace = pacer();
  for (let start = 0; start < text.length;) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    await pace();
    if (line) lines.push(JSON.parse(line) as MemberManifestLine);
  }
  return lines;
}

async function writeMemberManifest(
  dir: string,
  lines: MemberManifestLine[],
): Promise<void> {
  const text: string[] = [];
  const pace = pacer();
  for (const line of lines) {
    text.push(JSON.stringify(line));
    await pace();
  }
  text.push("");
  await fsp.writeFile(
    join(dir, MEMBER_MANIFEST),
    await gzipAsync(text.join("\n")),
    { mode: 0o600 },
  );
}

function writeMarker(dir: string, marker: MemberMarker): void {
  writeFileSync(join(dir, MEMBER_MARKER), `${JSON.stringify(marker)}\n`, {
    mode: 0o600,
  });
}

// Their space/ is what the manifest says: every folder and file there, each
// file of its size, and nothing else. Links are not made in a copy.
export async function verifyMemberTree(
  space: string,
  manifest: MemberManifestLine[],
): Promise<void> {
  const pace = pacer();
  const expected = new Map<string, MemberManifestLine>();
  for (const line of manifest) {
    if (line.k !== "l") expected.set(line.p, line);
    await pace();
  }
  let found = 0;
  const stack = [""];
  while (stack.length > 0) {
    // Also per folder: an empty one has no names to pace.
    await pace();
    const dirRel = stack.pop()!;
    for (const name of readdirSync(join(space, dirRel))) {
      found++;
      await pace();
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const want = expected.get(rel);
      if (!want) throw new Error(`${rel} is not in their manifest`);
      const st = lstatSync(join(space, rel));
      const kind = st.isDirectory() ? "d" : st.isFile() ? "f" : null;
      if (kind !== want.k) throw new Error(`${rel} is not a ${want.k}`);
      if (kind === "f" && st.size !== want.s)
        throw new Error(`${rel} has ${st.size} bytes, expected ${want.s}`);
      if (kind === "d") stack.push(rel);
    }
  }
  if (found !== expected.size)
    throw new Error(
      `${expected.size - found} entries of their manifest are missing`,
    );
}

// Bytes in order, with the exact reads a record stream needs. Each read
// costs what it returns: the chunks are kept as they came, with an offset
// into the first one, and are never joined beyond one read.
class Reader {
  private chunks: Buffer[] = [];
  // Bytes of chunks[0] already read.
  private head = 0;
  private buffered = 0;
  private readonly iterator: AsyncIterator<Uint8Array>;
  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }
  private async fill(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) return false;
    const chunk = Buffer.from(next.value);
    if (chunk.length === 0) return true;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }
  // The next n bytes; n <= buffered.
  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let rest = n;
    while (rest > 0) {
      const chunk = this.chunks[0];
      const k = Math.min(chunk.length - this.head, rest);
      parts.push(chunk.subarray(this.head, this.head + k));
      this.head += k;
      rest -= k;
      if (this.head === chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.buffered -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }
  async exact(n: number): Promise<Buffer> {
    while (this.buffered < n)
      if (!(await this.fill()))
        throw new Error("the member's runner's stream ended early");
    return this.take(n);
  }
  // One line without its "\n", or null at the end of the stream.
  async line(max: number): Promise<string | null> {
    // Bytes already searched for "\n".
    let searched = 0;
    for (;;) {
      let offset = 0;
      for (let c = 0; c < this.chunks.length; c++) {
        const chunk = this.chunks[c];
        const from = c === 0 ? this.head : 0;
        const size = chunk.length - from;
        if (offset + size > searched) {
          const at = chunk.indexOf(0x0a, from + Math.max(0, searched - offset));
          if (at >= 0) {
            const line = this.take(offset + at - from).toString("utf8");
            this.take(1);
            return line;
          }
        }
        offset += size;
      }
      searched = this.buffered;
      if (this.buffered > max)
        throw new Error("a line of their listing is too long");
      if (!(await this.fill())) {
        if (this.buffered > 0) throw new Error("their listing ended in a line");
        return null;
      }
    }
  }
  async some(max: number): Promise<Buffer> {
    if (this.buffered === 0 && !(await this.fill()))
      throw new Error("the member's runner's stream ended early");
    return this.take(Math.min(max, this.chunks[0].length - this.head));
  }
  // The stream has nothing after what was read.
  async atEnd(): Promise<boolean> {
    return this.buffered === 0 && !(await this.fill());
  }
  // Ends the stream, so the member's runner's stream closes now and not at
  // its timeout.
  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

const DIGITS = /^\d{1,25}$/;

function normalisedRel(rel: unknown): rel is string {
  return (
    typeof rel === "string" &&
    rel !== "" &&
    rel.length <= PATH_MAX &&
    !rel.includes("\0") &&
    !isAbsolute(rel) &&
    normalize(rel) === rel &&
    !rel.endsWith("/") &&
    !rel.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// One listing line, checked; throws on anything they could not have meant.
function checkEntry(value: unknown): SpaceEntry {
  const e = value as SpaceEntry;
  if (
    typeof e !== "object" ||
    e === null ||
    !normalisedRel(e.p) ||
    !["d", "f", "l", "x"].includes(e.k) ||
    !safeCount(e.mode) ||
    !safeCount(e.size) ||
    typeof e.mtimeNs !== "string" ||
    !DIGITS.test(e.mtimeNs) ||
    typeof e.ctimeNs !== "string" ||
    !DIGITS.test(e.ctimeNs) ||
    typeof e.ino !== "string" ||
    !DIGITS.test(e.ino) ||
    (e.k === "l" &&
      (typeof e.target !== "string" || e.target.length > PATH_MAX)) ||
    (e.k === "x" && !["socket", "fifo", "device"].includes(e.what ?? ""))
  )
    throw new Error("their listing has a line that is not an entry");
  return e;
}

class LeftOutList {
  readonly counts: Record<string, number> = {};
  readonly names: string[] = [];
  add(kind: string, rel: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    if (this.names.length < LEFT_OUT_NAMES) this.names.push(rel);
  }
  value(): LeftOut | undefined {
    return Object.keys(this.counts).length > 0
      ? { counts: this.counts, names: this.names }
      : undefined;
  }
}

interface Listing {
  entries: SpaceEntry[];
  leftOut: LeftOutList;
}

async function readListing(body: AsyncIterable<Uint8Array>): Promise<Listing> {
  const reader = new Reader(body);
  try {
    return await readListingFrom(reader);
  } finally {
    await reader.close();
  }
}

async function readListingFrom(reader: Reader): Promise<Listing> {
  const pace = pacer();
  const entries: SpaceEntry[] = [];
  const leftOut = new LeftOutList();
  const folders = new Set<string>([""]);
  const seen = new Set<string>();
  // Folders the exclusions left out, here: what is under them goes too.
  const dropped = new Set<string>();
  let bytes = 0;
  for (;;) {
    await pace();
    const line = await reader.line(LINE_MAX);
    if (line === null) throw new Error("their listing has no end");
    bytes += line.length + 1;
    if (bytes > LIST_MAX_BYTES)
      throw new Error(`their listing is over ${LIST_MAX_BYTES} bytes`);
    const value = JSON.parse(line) as unknown;
    if ((value as { end?: unknown })?.end === true) break;
    const entry = checkEntry(value);
    if (seen.has(entry.p))
      throw new Error(`their listing names ${entry.p} twice`);
    seen.add(entry.p);
    const slash = entry.p.lastIndexOf("/");
    const parent = slash < 0 ? "" : entry.p.slice(0, slash);
    if (dropped.has(parent) || memberSpaceExcluded(entry.p)) {
      if (entry.k === "d") dropped.add(entry.p);
      continue;
    }
    if (!folders.has(parent))
      throw new Error(`their listing names ${entry.p} before its folder`);
    if (entries.length >= LIST_MAX_ENTRIES)
      throw new Error(`their listing is over ${LIST_MAX_ENTRIES} entries`);
    if (entry.k === "x") {
      leftOut.add(entry.what!, entry.p);
      continue;
    }
    if (entry.k === "f" && entry.size > MOVE_FILE_MAX) {
      leftOut.add("too-big", entry.p);
      continue;
    }
    if (entry.k === "d") folders.add(entry.p);
    entries.push(entry);
  }
  if (!(await reader.atEnd()))
    throw new Error("their listing goes on after its end");
  return { entries, leftOut };
}

function writeAll(fd: number, chunk: Buffer): void {
  let at = 0;
  while (at < chunk.length) at += writeSync(fd, chunk, at);
}

const nsToSeconds = (ns: string) => Number(BigInt(ns) / 1000n) / 1e6;

// Their tree of the previous copy, file by file: the line there, when that
// file is still what the line says.
async function previousFiles(
  previous: PreviousMemberTree | null,
  manifest: MemberManifestLine[] | null,
): Promise<Map<string, MemberManifestLine>> {
  const files = new Map<string, MemberManifestLine>();
  if (!previous || !manifest) return files;
  const pace = pacer();
  for (const line of manifest) {
    if (line.k === "f") files.set(line.p, line);
    await pace();
  }
  return files;
}

function intact(path: string, line: MemberManifestLine): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return (
    st !== undefined &&
    st.isFile() &&
    st.size === line.s &&
    line.m !== undefined &&
    Math.abs(st.mtimeMs - nsToSeconds(line.m) * 1000) < 1
  );
}

async function copyFresh(
  source: MemberBackupSource,
  host: AgentHost & Required<Pick<AgentHost, "runEntryOut">>,
  dir: string,
  ctx: MemberCopyContext,
): Promise<MemberCopyResult> {
  const now = ctx.now ?? (() => Date.now());
  const link = ctx.link ?? linkSync;
  const deadline = now() + MEMBER_TOTAL_MS;
  const left = () => {
    const ms = deadline - now();
    if (ms <= 0)
      throw new Error(`their backup took over ${MEMBER_TOTAL_MS / 60000} min`);
    return ms;
  };
  const agentRoot = host.agentRoot();
  const listing = await readListing(
    host.runEntryOut("backup-list", { agentRoot }, left(), MEMBER_STALL_MS),
  );
  const prevManifest = ctx.previous
    ? await readMemberManifest(ctx.previous.dir).catch(() => null)
    : null;
  const before = await previousFiles(ctx.previous, prevManifest);
  const prevSpace = ctx.previous ? join(ctx.previous.dir, MEMBER_SPACE) : "";

  const pace = pacer();
  const toCopy: (SpaceEntry & { i: number })[] = [];
  let copyBytes = 0;
  let folders = 1;
  for (const entry of listing.entries) {
    await pace();
    if (entry.k === "d") folders++;
    if (entry.k !== "f") continue;
    const was = before.get(entry.p);
    const same =
      was !== undefined &&
      was.s === entry.size &&
      was.m === entry.mtimeNs &&
      was.c === entry.ctimeNs &&
      intact(join(prevSpace, entry.p), was);
    if (!same) {
      toCopy.push({ ...entry, i: toCopy.length });
      copyBytes += entry.size;
    }
  }
  if (!ctx.fits(copyBytes, folders, listing.entries.length))
    throw new Error("not enough free space for their agent space");

  const space = join(dir, MEMBER_SPACE);
  mkdirSync(space, { mode: 0o700 });
  const manifest: MemberManifestLine[] = [];
  const copying = new Map(toCopy.map((entry) => [entry.p, entry]));
  let files = 0;
  let bytes = 0;
  let links = 0;
  for (const entry of listing.entries) {
    await pace();
    if (entry.k === "d") {
      mkdirSync(join(space, entry.p), { mode: 0o700 });
      manifest.push({ p: entry.p, k: "d", o: entry.mode });
    } else if (entry.k === "l") {
      links++;
      manifest.push({ p: entry.p, k: "l", t: entry.target, o: entry.mode });
    } else if (!copying.has(entry.p)) {
      link(join(prevSpace, entry.p), join(space, entry.p));
      manifest.push({
        p: entry.p,
        k: "f",
        s: entry.size,
        m: entry.mtimeNs,
        c: entry.ctimeNs,
        o: entry.mode,
      });
      files++;
      bytes += entry.size;
    }
  }

  let newBytes = 0;
  if (toCopy.length > 0) {
    const input: SpaceFilesInput = {
      agentRoot,
      files: toCopy.map((entry) => ({
        i: entry.i,
        p: entry.p,
        ino: entry.ino,
        size: entry.size,
        mtimeNs: entry.mtimeNs,
        ctimeNs: entry.ctimeNs,
      })),
    };
    const reader = new Reader(
      host.runEntryOut("backup-files", input, left(), MEMBER_STALL_MS),
    );
    try {
      const arrived = new Set<number>();
      let sinceCheck = 0;
      for (;;) {
        await pace();
        const length = (await reader.exact(4)).readUInt32BE(0);
        if (length === 0) break;
        if (length > HEADER_MAX) throw new Error("a record header is too long");
        const header = JSON.parse(
          (await reader.exact(length)).toString("utf8"),
        ) as SpaceFileHeader;
        const entry = toCopy[header?.i];
        if (!Number.isSafeInteger(header?.i) || !entry || arrived.has(header.i))
          throw new Error("a record names no file that was asked for");
        arrived.add(header.i);
        if (header.left !== undefined) {
          if (
            !["gone", "swapped", "shrunk", "not-a-file"].includes(header.left)
          )
            throw new Error("a record with a bad reason");
          if (header.size !== 0)
            throw new Error("a left-out record with bytes");
          listing.leftOut.add(header.left, entry.p);
          continue;
        }
        if (header.size !== entry.size)
          throw new Error(
            `a record of ${entry.p} has another size than listed`,
          );
        const path = join(space, entry.p);
        const fd = openSync(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          let rest = entry.size;
          while (rest > 0) {
            await pace();
            const chunk = await reader.some(Math.min(rest, 1024 * 1024));
            writeAll(fd, chunk);
            rest -= chunk.length;
            sinceCheck += chunk.length;
            if (sinceCheck >= 64 * 1024 * 1024) {
              ctx.checkSpace(sinceCheck);
              sinceCheck = 0;
            }
          }
        } finally {
          closeSync(fd);
        }
        utimesSync(
          path,
          nsToSeconds(entry.mtimeNs),
          nsToSeconds(entry.mtimeNs),
        );
        manifest.push({
          p: entry.p,
          k: "f",
          s: entry.size,
          ...(header.changed ? {} : { m: entry.mtimeNs, c: entry.ctimeNs }),
          o: entry.mode,
        });
        files++;
        bytes += entry.size;
        newBytes += entry.size;
      }
      if (!(await reader.atEnd()))
        throw new Error("their files go on after their end");
      if (arrived.size !== toCopy.length)
        throw new Error(
          "the member's runner did not answer for every file asked for",
        );
    } finally {
      await reader.close();
    }
  }
  await verifyMemberTree(space, manifest);
  await writeMemberManifest(dir, manifest);
  writeMarker(dir, {
    userId: source.userId,
    osUser: source.osUser,
    state: "copied",
    at: ctx.startedAt,
    copiedAt: ctx.startedAt,
    ...(listing.leftOut.value() ? { leftOut: listing.leftOut.value() } : {}),
    ...(links > 0 ? { links } : {}),
  });
  const leftOut = listing.leftOut.value();
  if (leftOut)
    (ctx.log ?? console.log)(
      `[backup] ${source.userId}: files left out of their agent space copy: ${JSON.stringify(leftOut.counts)}`,
    );
  return { userId: source.userId, state: "copied", files, bytes, newBytes };
}

// Their tree of the newest copy that has one, hard-linked into this copy.
async function carry(
  source: MemberBackupSource,
  dir: string,
  ctx: MemberCopyContext,
  reason: string,
): Promise<MemberCopyResult> {
  const previous = ctx.previous;
  const skipped = (why: string): MemberCopyResult => {
    writeMarker(dir, {
      userId: source.userId,
      osUser: source.osUser,
      state: "skipped",
      at: ctx.startedAt,
      reason: why,
    });
    return {
      userId: source.userId,
      state: "skipped",
      reason: why,
      files: 0,
      bytes: 0,
      newBytes: 0,
    };
  };
  if (!previous) return skipped(reason);
  const link = ctx.link ?? linkSync;
  const space = join(dir, MEMBER_SPACE);
  try {
    const manifest = await readMemberManifest(previous.dir);
    const from = join(previous.dir, MEMBER_SPACE);
    mkdirSync(space, { mode: 0o700 });
    let files = 0;
    let bytes = 0;
    const pace = pacer();
    for (const line of manifest) {
      await pace();
      if (!normalisedRel(line.p))
        throw new Error("their manifest has a bad path");
      if (line.k === "d") mkdirSync(join(space, line.p), { mode: 0o700 });
      else if (line.k === "f") {
        link(join(from, line.p), join(space, line.p));
        files++;
        bytes += line.s ?? 0;
      }
    }
    await verifyMemberTree(space, manifest);
    copyFileSync(
      join(previous.dir, MEMBER_MANIFEST),
      join(dir, MEMBER_MANIFEST),
    );
    chmodSync(join(dir, MEMBER_MANIFEST), 0o600);
    const was = previous.marker;
    writeMarker(dir, {
      userId: source.userId,
      osUser: source.osUser,
      state: "carried",
      at: ctx.startedAt,
      copiedAt: was.copiedAt ?? was.at,
      // Always the copy where their tree was made, through any number of
      // carries.
      carriedFrom:
        was.state === "copied"
          ? previous.copyName
          : (was.carriedFrom ?? previous.copyName),
      reason,
      ...(was.leftOut ? { leftOut: was.leftOut } : {}),
      ...(was.links ? { links: was.links } : {}),
    });
    return {
      userId: source.userId,
      state: "carried",
      reason,
      files,
      bytes,
      newBytes: 0,
    };
  } catch (err) {
    rmSync(space, { recursive: true, force: true });
    rmSync(join(dir, MEMBER_MANIFEST), { force: true });
    return skipped(
      `${reason}; the copy from ${previous.copyName} could not be linked in: ${errMessage(err)}`,
    );
  }
}

// Their part of the copy. Never throws for anything of hers: the office's copy
// goes on whatever happens here.
export async function copyMemberSpace(
  source: MemberBackupSource,
  ctx: MemberCopyContext,
): Promise<MemberCopyResult> {
  const now = ctx.now ?? (() => Date.now());
  const log = ctx.log ?? ((line: string) => console.log(line));
  const started = now();
  // The id names a folder of the copy.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(source.userId)) {
    log(`[backup] a member id that cannot name a folder was left out`);
    return {
      userId: source.userId,
      state: "skipped",
      reason: "the member id cannot name a folder",
      files: 0,
      bytes: 0,
      newBytes: 0,
    };
  }
  const members = join(ctx.partial, MEMBERS_DIR);
  const dir = join(members, source.userId);
  try {
    mkdirSync(members, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    // Not removed: a folder that was there is not this run's of them.
    const reason = `their folder in the copy could not be made: ${errMessage(err)}`;
    log(`[backup] ${source.userId}: agent space not copied (${reason})`);
    return {
      userId: source.userId,
      state: "skipped",
      reason,
      files: 0,
      bytes: 0,
      newBytes: 0,
    };
  }
  let result: MemberCopyResult;
  let reason: string;
  const host = source.host;
  if (!host?.runEntryOut) {
    reason = source.notReady ?? "the member's runner is not connected";
  } else {
    try {
      result = await copyFresh(
        source,
        host as AgentHost & Required<Pick<AgentHost, "runEntryOut">>,
        dir,
        ctx,
      );
      log(
        `[backup] ${source.userId}: copied their agent space in ${((now() - started) / 1000).toFixed(1)} s (${result.newBytes} new bytes)`,
      );
      return result;
    } catch (err) {
      reason = errMessage(err);
      rmSync(join(dir, MEMBER_SPACE), { recursive: true, force: true });
      rmSync(join(dir, MEMBER_MANIFEST), { force: true });
    }
  }
  try {
    result = await carry(source, dir, ctx, reason);
  } catch (err) {
    // carry catches its own errors; this is the marker write failing.
    rmSync(dir, { recursive: true, force: true });
    result = {
      userId: source.userId,
      state: "skipped",
      reason: `${reason}; ${errMessage(err)}`,
      files: 0,
      bytes: 0,
      newBytes: 0,
    };
  }
  const kept =
    result.state === "carried"
      ? `the backup keeps the copy from ${ctx.previous?.copyName}`
      : "the backup has no copy of it";
  log(
    `[backup] ${source.userId}: agent space not copied (${reason}); ${kept}, in ${((now() - started) / 1000).toFixed(1)} s`,
  );
  return result;
}

// The newest copy before this run that has a tree of `userId`, among the
// published copy folders, newest first.
export function findPreviousMemberTree(
  copies: { name: string; path: string }[],
  userId: string,
): PreviousMemberTree | null {
  for (const copy of copies) {
    const dir = join(copy.path, MEMBERS_DIR, userId);
    if (!existsSync(dir)) continue;
    const marker = readMemberMarker(dir);
    if (!marker || marker.userId !== userId) continue;
    if (marker.state === "copied" || marker.state === "carried")
      return { copyName: copy.name, dir, marker };
  }
  return null;
}
