// The member's side of the file moves (internal-docs/member-os-user-design.md,
// sections 2.2 and 2.3): the runner's entries files-in, files-place,
// files-undo and files-done (enable), files-out and files-remove (disable,
// the purge) and claude-cwd-move run this as the member. The office sides
// are server/member-move.ts and server/member-move-out.ts. Imports nothing
// with the owner lookup: the runner bundle carries this file.
//
// files-in writes every file to <agentRoot>/.move-in/<nonce>/<index> and a
// manifest. files-place links each one to its destination, never replacing
// a file, and records what it placed in placed.jsonl. files-undo removes
// only what files-place recorded; files-done removes the staging folder.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import {
  claudeProjectDirIn,
  moveSessionFilesBetween,
  type SessionFilesMove,
} from "./claude-session-files.ts";

const MOVE_IN_DIR = ".move-in";
const NONCE = /^[0-9a-f]{16,64}$/;
// Free space kept above the planned total: max(1 GiB, 5% of it).
const SPACE_MARGIN_BYTES = 1024 * 1024 * 1024;
const SPACE_MARGIN_SHARE = 0.05;

// The free bytes a move of `total` bytes needs on one file system.
export function spaceNeeded(total: number): number {
  return (
    total + Math.max(SPACE_MARGIN_BYTES, Math.ceil(total * SPACE_MARGIN_SHARE))
  );
}

export interface MoveInInput {
  nonce: string;
  agentRoot: string;
  home: string;
  // The bytes the office plans to send.
  total: number;
}

export interface MoveStepInput {
  nonce: string;
  agentRoot: string;
}

export interface MoveRecordHeader {
  dest: string;
  size: number;
  mode: number;
}

interface ManifestEntry {
  index: number;
  dest: string;
  size: number;
  sha256: string;
}

export interface ReceiveDeps {
  // Free bytes on the file system of `path`.
  freeBytes: (path: string) => number;
}

const DEFAULT_RECEIVE_DEPS: ReceiveDeps = {
  freeBytes: (path) => {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};

function absolute(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`${what} must be an absolute path`);
  return value;
}

function stagingDir(input: MoveStepInput): string {
  if (typeof input?.nonce !== "string" || !NONCE.test(input.nonce))
    throw new Error("the move needs a nonce");
  return join(absolute(input.agentRoot, "agentRoot"), MOVE_IN_DIR, input.nonce);
}

// A destination the office may name: absolute, normalised, no "..", under
// the member's home.
export function moveDestRefusal(dest: unknown, home: string): string | null {
  if (typeof dest !== "string" || !isAbsolute(dest))
    return "the destination is not an absolute path";
  if (normalize(dest) !== dest || dest.split("/").includes(".."))
    return "the destination is not normalised";
  if (!dest.startsWith(`${home.replace(/\/+$/, "")}/`))
    return "the destination is outside the member's home";
  return null;
}

// Reads exact byte counts from a stream of chunks.
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private done = false;
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    const chunk = Buffer.from(next.value);
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }

  // Exactly n bytes; throws at the end of the stream.
  async exact(n: number): Promise<Buffer> {
    while (this.buffered < n)
      if (!(await this.fill())) throw new Error("the move stream ended early");
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.buffered = all.length - n;
    return all.subarray(0, n);
  }

  // Up to `max` bytes (at least one); throws at the end of the stream.
  async some(max: number): Promise<Buffer> {
    if (this.buffered === 0 && !(await this.fill()))
      throw new Error("the move stream ended early");
    const head = this.chunks[0];
    if (head.length <= max) {
      this.chunks.shift();
      this.buffered -= head.length;
      return head;
    }
    this.chunks[0] = head.subarray(max);
    this.buffered -= max;
    return head.subarray(0, max);
  }
}

// The largest header a record may have.
const HEADER_MAX = 64 * 1024;

// files-in: the records of `body` (u32 header length, header JSON, size
// bytes; a zero length ends it) into the staging folder.
export async function receiveFiles(
  input: MoveInInput,
  body: AsyncIterable<Uint8Array>,
  deps: ReceiveDeps = DEFAULT_RECEIVE_DEPS,
): Promise<{ files: number; bytes: number }> {
  const staging = stagingDir(input);
  const home = absolute(input.home, "home");
  const total = input.total;
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("the move needs the planned total");
  rmSync(join(input.agentRoot, MOVE_IN_DIR), { recursive: true, force: true });
  const free = deps.freeBytes(input.agentRoot);
  const needed = spaceNeeded(total);
  if (needed > free)
    throw Object.assign(
      new Error(
        `not enough free space for the move: ${needed} bytes needed, ${free} free`,
      ),
      { code: "ENOSPC" },
    );
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const manifest: ManifestEntry[] = [];
  let bytes = 0;
  try {
    const reader = new ByteReader(body);
    for (;;) {
      const length = (await reader.exact(4)).readUInt32BE(0);
      if (length === 0) break;
      if (length > HEADER_MAX) throw new Error("a move header is too long");
      const header = JSON.parse(
        (await reader.exact(length)).toString("utf8"),
      ) as MoveRecordHeader;
      const refusal = moveDestRefusal(header?.dest, home);
      if (refusal) throw new Error(`${String(header?.dest)}: ${refusal}`);
      const size = header.size;
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error(`${header.dest}: a bad size`);
      if (!Number.isInteger(header.mode))
        throw new Error(`${header.dest}: a bad mode`);
      bytes += size;
      if (bytes > total)
        throw new Error("the move sends more bytes than it planned");
      const index = manifest.length;
      const hash = createHash("sha256");
      const fd = openSync(
        join(staging, String(index)),
        "wx",
        (header.mode & 0o700) | 0o600,
      );
      try {
        let left = size;
        while (left > 0) {
          const chunk = await reader.some(Math.min(left, 1024 * 1024));
          hash.update(chunk);
          let off = 0;
          while (off < chunk.length)
            off += writeSync(fd, chunk, off, chunk.length - off);
          left -= chunk.length;
        }
      } finally {
        closeSync(fd);
      }
      manifest.push({
        index,
        dest: header.dest,
        size,
        sha256: hash.digest("hex"),
      });
    }
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { files: manifest.length, bytes };
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// placed.jsonl: one line per file this move placed ({dest, ino}) and per
// folder it made ({dir}), in order.
type PlacedLine = { dest: string; ino: number } | { dir: string };

function readPlaced(staging: string): PlacedLine[] {
  const path = join(staging, "placed.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PlacedLine);
}

// files-place: link each staged file to its destination. Never replaces a
// file: a destination with the same bytes counts as placed but is not ours
// (a rerun after a stopped move); any other one fails the place.
export function placeFiles(input: MoveStepInput): { placed: number } {
  const staging = stagingDir(input);
  const manifest = JSON.parse(
    readFileSync(join(staging, "manifest.json"), "utf8"),
  ) as ManifestEntry[];
  const journal = join(staging, "placed.jsonl");
  const record = (line: PlacedLine) =>
    appendFileSync(journal, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  let placed = 0;
  for (const entry of manifest) {
    const staged = join(staging, String(entry.index));
    const made = mkdirSync(dirname(entry.dest), {
      recursive: true,
      mode: 0o700,
    });
    // The first folder mkdir made; each one below it is new too.
    if (made) {
      let dir = dirname(entry.dest);
      const dirs: string[] = [];
      for (;;) {
        dirs.push(dir);
        if (dir === made) break;
        dir = dirname(dir);
      }
      for (const d of dirs.reverse()) record({ dir: d });
    }
    try {
      linkSync(staged, entry.dest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV")
        throw new Error(
          `${entry.dest} is on another file system than ${input.agentRoot}`,
          { cause: error },
        );
      if (code !== "EEXIST") throw error;
      const there = lstatSync(entry.dest);
      if (
        !there.isFile() ||
        there.size !== entry.size ||
        fileSha256(entry.dest) !== entry.sha256
      )
        throw new Error(`${entry.dest} exists with other content`, {
          cause: error,
        });
      unlinkSync(staged);
      continue;
    }
    record({ dest: entry.dest, ino: lstatSync(entry.dest).ino });
    unlinkSync(staged);
    placed++;
  }
  return { placed };
}

// files-undo: remove what files-place recorded, newest first. A file whose
// inode changed since is kept; a folder is removed only when empty.
export function undoFiles(input: MoveStepInput): { removed: number } {
  const staging = stagingDir(input);
  let removed = 0;
  for (const line of readPlaced(staging).reverse()) {
    try {
      if ("dir" in line) {
        rmdirSync(line.dir);
        continue;
      }
      const there = lstatSync(line.dest);
      if (!there.isFile() || there.ino !== line.ino) {
        console.error(`[member-move] kept ${line.dest}: it changed`);
        continue;
      }
      unlinkSync(line.dest);
      removed++;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY")
        console.error(
          `[member-move] cannot undo ${"dir" in line ? line.dir : line.dest}: ${(error as Error).message}`,
        );
    }
  }
  rmSync(staging, { recursive: true, force: true });
  return { removed };
}

// files-done: the move is kept; its staging folder goes.
export function doneFiles(input: MoveStepInput): { done: true } {
  rmSync(stagingDir(input), { recursive: true, force: true });
  return { done: true };
}

// ---------------------------------------------------------------------------
// Disable: the move back (files-out, files-remove), as the member. The
// office treats this output as untrusted (server/member-move-out.ts): it
// picks every destination itself.

export interface MoveOutInput {
  nonce: string;
  agentRoot: string;
  fileMax: number;
  // Trees sent whole; a single file has rel "".
  trees: { index: number; path: string }[];
  files: { index: number; path: string }[];
  // A rollout found by thread id under `home`; rel is its path under home.
  codex: { index: number; home: string; threadId: string }[];
}

interface OutFile {
  index: number;
  rel: string;
  path: string;
  size: number;
  mode: number;
  dev: number;
  ino: number;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// A regular file with one link on `dev`, within `max`.
function sendable(stats: Stats, dev: number, max: number): boolean {
  return (
    stats.isFile() &&
    stats.nlink === 1 &&
    stats.dev === dev &&
    stats.size <= max
  );
}

// The files of a tree, with an lstat walk that enters only real folders
// on the tree's file system. `folders` gets each folder walked.
function walkOut(
  index: number,
  top: string,
  max: number,
  out: OutFile[],
  folders: string[],
): void {
  const topStats = lstatOrNull(top);
  if (!topStats?.isDirectory()) return;
  const dev = topStats.dev;
  folders.push(top);
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(join(top, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      const childRel = rel ? join(rel, name) : name;
      const path = join(top, childRel);
      const stats = lstatOrNull(path);
      if (!stats) continue;
      if (stats.isDirectory()) {
        if (stats.dev === dev) {
          stack.push(childRel);
          folders.push(path);
        }
        continue;
      }
      if (sendable(stats, dev, max))
        out.push({
          index,
          rel: childRel,
          path,
          size: stats.size,
          mode: stats.mode & 0o777,
          dev,
          ino: stats.ino,
        });
    }
  }
}

function singleOut(
  index: number,
  path: string,
  rel: string,
  max: number,
  out: OutFile[],
): void {
  const stats = lstatOrNull(path);
  const parent = lstatOrNull(dirname(path));
  if (!stats || !parent?.isDirectory()) return;
  if (sendable(stats, parent.dev, max))
    out.push({
      index,
      rel,
      path,
      size: stats.size,
      mode: stats.mode & 0o777,
      dev: parent.dev,
      ino: stats.ino,
    });
}

const THREAD_ID = /^[0-9a-zA-Z-]{8,64}$/;

// sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl under `home`, by an lstat
// walk of those three levels; null when there is none.
function findRolloutOut(home: string, threadId: string): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`;
  const sessions = join(home, "sessions");
  const level = (dir: string, pattern: RegExp): string[] => {
    try {
      return readdirSync(dir)
        .filter((name) => pattern.test(name))
        .map((name) => join(dir, name))
        .filter((path) => lstatOrNull(path)?.isDirectory());
    } catch {
      return [];
    }
  };
  for (const year of level(sessions, /^\d{4}$/))
    for (const month of level(year, /^\d{2}$/))
      for (const day of level(month, /^\d{2}$/)) {
        let names: string[];
        try {
          names = readdirSync(day);
        } catch {
          continue;
        }
        const name = names.find(
          (n) => n.startsWith("rollout-") && n.endsWith(suffix),
        );
        if (name) return join(day, name);
      }
  return null;
}

function moveOutDir(input: { nonce: string; agentRoot: string }): string {
  if (typeof input?.nonce !== "string" || !NONCE.test(input.nonce))
    throw new Error("the move needs a nonce");
  return join(absolute(input.agentRoot, "agentRoot"), ".move-out", input.nonce);
}

// files-out: the requested files as a stream. First one JSON line
// {totals: {<index>: bytes}}, then for each file u32 BE length, header JSON
// {index, rel, size, mode} and the bytes, then a zero length. What was sent
// (path and inode) and the folders walked are kept in
// <agentRoot>/.move-out/<nonce>/sent.jsonl for files-remove.
export async function sendFiles(
  input: MoveOutInput,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const dir = moveOutDir(input);
  rmSync(join(input.agentRoot, ".move-out"), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const max = input.fileMax;
  const files: OutFile[] = [];
  const folders: string[] = [];
  for (const tree of input.trees ?? [])
    walkOut(tree.index, absolute(tree.path, "a tree"), max, files, folders);
  for (const file of input.files ?? [])
    singleOut(file.index, absolute(file.path, "a file"), "", max, files);
  for (const rollout of input.codex ?? []) {
    const home = absolute(rollout.home, "a Codex home");
    const path = findRolloutOut(home, rollout.threadId);
    if (path) singleOut(rollout.index, path, relative(home, path), max, files);
  }
  const totals: Record<number, number> = {};
  for (const file of files)
    totals[file.index] = (totals[file.index] ?? 0) + file.size;
  await write(Buffer.from(`${JSON.stringify({ totals })}\n`));
  const journal = join(dir, "sent.jsonl");
  for (const folder of folders)
    appendFileSync(journal, `${JSON.stringify({ dir: folder })}\n`, {
      mode: 0o600,
    });
  for (const file of files) {
    let fd: number;
    try {
      fd = openSync(
        file.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      continue;
    }
    try {
      const stats = fstatSync(fd);
      if (stats.ino !== file.ino || !sendable(stats, file.dev, max)) continue;
      // The office refuses bytes past the totals sent first.
      if (stats.size > file.size)
        throw new Error(`${file.path} grew while the files were sent`);
      const header = Buffer.from(
        JSON.stringify({
          index: file.index,
          rel: file.rel,
          size: stats.size,
          mode: file.mode,
        }),
      );
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.length, 0);
      await write(Buffer.concat([length, header]));
      let left = stats.size;
      const buffer = Buffer.alloc(1024 * 1024);
      while (left > 0) {
        const n = readSync(fd, buffer, 0, Math.min(left, buffer.length), null);
        if (n === 0)
          throw new Error(`${file.path} became shorter while it was read`);
        await write(Buffer.from(buffer.subarray(0, n)));
        left -= n;
      }
      appendFileSync(
        journal,
        `${JSON.stringify({ path: file.path, ino: file.ino })}\n`,
        { mode: 0o600 },
      );
    } finally {
      closeSync(fd);
    }
  }
  await write(Buffer.alloc(4));
}

// files-remove after a move back: each file sent, when its inode is still
// the one sent, then the folders walked that are now empty, deepest first.
// Answers the files it kept. With `trees` (the purge of a removed member):
// each tree whole, never through a link.
export function removeSent(
  input:
    | { nonce: string; agentRoot: string }
    | { agentRoot: string; trees: string[] },
): { kept: string[] } {
  const agentRoot = absolute(input.agentRoot, "agentRoot");
  if ("trees" in input) {
    for (const tree of input.trees) {
      const path = absolute(tree, "a tree");
      if (!path.startsWith(`${agentRoot}/`) || normalize(path) !== path)
        throw new Error(`${path} is not in the agent space`);
      rmSync(path, { recursive: true, force: true });
    }
    return { kept: [] };
  }
  const dir = moveOutDir(input);
  const kept: string[] = [];
  const folders: string[] = [];
  const journal = join(dir, "sent.jsonl");
  const lines = existsSync(journal)
    ? readFileSync(journal, "utf8").split("\n").filter(Boolean)
    : [];
  for (const line of lines) {
    const entry = JSON.parse(line) as {
      path?: string;
      ino?: number;
      dir?: string;
    };
    if (entry.dir) {
      folders.push(entry.dir);
      continue;
    }
    if (!entry.path) continue;
    const stats = lstatOrNull(entry.path);
    if (!stats) continue;
    if (!stats.isFile() || stats.ino !== entry.ino) {
      kept.push(entry.path);
      continue;
    }
    try {
      unlinkSync(entry.path);
    } catch {
      kept.push(entry.path);
    }
  }
  folders.sort((a, b) => b.split("/").length - a.split("/").length);
  for (const folder of folders) {
    try {
      rmdirSync(folder);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
  return { kept };
}

// claude-cwd-move: a member's session files to the project folder of the
// new cwd, under their Claude config root.
export function moveClaudeCwd(input: {
  sessionId: string;
  oldCwd: string;
  newCwd: string;
  configDir: string;
}): SessionFilesMove {
  if (typeof input?.sessionId !== "string" || !THREAD_ID.test(input.sessionId))
    throw new Error("claude-cwd-move needs a session id");
  const configDir = absolute(input.configDir, "configDir");
  return moveSessionFilesBetween(
    input.sessionId,
    claudeProjectDirIn(configDir, absolute(input.oldCwd, "oldCwd")),
    claudeProjectDirIn(configDir, absolute(input.newCwd, "newCwd")),
  );
}
