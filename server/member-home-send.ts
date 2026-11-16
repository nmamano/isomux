// The member's side of an office move (task 78733adf, slice 5c-1; design:
// internal-docs/office-move-design.md "Members with their own OS user"):
// the runner's entries home-list and home-files run this as the member, so
// the old office can carry her home, which it cannot read itself. The
// office side is server/office-move-members.ts, which trusts nothing here
// but the bytes. The runner bundle carries this file: it imports nothing
// with the office's state.
//
// home-list: an lstat walk of her home, as her, that never enters a link
// and leaves out what memberHomeScope leaves out. One JSON line per entry
// (HomeListLine), in the walk order of the office's manifest
// (compareMoveWalkOrder), then {"end":true}. A path the walk cannot read is
// a line {"u": path}.
//
// home-files: the asked files, each opened O_NOFOLLOW and checked by fstat
// against the lstat. Frames: u32 BE length, then that many bytes; a zero
// length ends the stream. Per item: a header frame (HomeFileHeader), then
// exactly `size` bytes in data frames, then a trailer frame
// (HomeFileTrailer); or one error frame (HomeFileError).

import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { MEMBER_SPACE_OWN_LOCATIONS } from "./member-space-exclusions.ts";

/** The kind of an entry, from lstat (a link is never followed). */
export type HomeEntryKind = "file" | "dir" | "symlink" | "other";

/** What the move does with a path of her home (relative, "/" separated). */
export type MemberHomeVerdict =
  | { in: true }
  /** Left out and not counted: caches, specials, what the office writes
   *  again in her agent space. */
  | { in: false; why: "out" }
  /** Bound to the old box: left out and counted (her SSH login keys). */
  | { in: false; why: "bound"; unit: string };

/** The nonce of one call: a file name in her home (C7). */
export const MEMBER_HOME_NONCE = /^[0-9a-f]{32}$/;

/** The longest line of home-list the office reads (C3). */
export const MEMBER_HOME_LINE_MAX = 64 * 1024;

/** The caches and build caches of a home, rooted at it. The office user's
 *  home leaves them out too (office-move-scope.ts). */
export const MOVE_HOME_CACHES: readonly string[] = [
  ".cache",
  ".bun",
  ".npm/_cacache",
  "go/pkg/mod",
  ".cargo/registry",
];

/** Her agent space in her home (agent-host.ts MEMBER_AGENT_DIR). */
const AGENT_DIR = ".isomux-agent";

/** Where home-files makes her SQLite snapshots, in her agent space. */
const MOVE_OUT_DIR = `${AGENT_DIR}/.move-out`;

const OUT_PREFIXES = [
  ...MOVE_HOME_CACHES,
  // What the office writes again in her agent space (Q2).
  ...MEMBER_SPACE_OWN_LOCATIONS.map((location) => `${AGENT_DIR}/${location}`),
];

const SSH_LOGIN_KEYS = /^\.ssh\/authorized_keys2?$/;

export interface HomeListInput {
  /** Her home, as the office read it from passwd. The runner walks it only
   *  when realpath(home) === home. */
  home: string;
  nonce: string;
}

/** One entry of the listing, as the office's manifest line: path, type
 *  (f file, d folder, l link, x a socket, fifo or device: counted as
 *  skipped), size, mtime ms, mode, link target, q: 1 for SQLite. */
export interface HomeListLine {
  p: string;
  t: "f" | "d" | "l" | "x";
  s: number;
  m: number;
  mode: number;
  l?: string;
  q?: 1;
}

export interface HomeFilesInput {
  home: string;
  nonce: string;
  /** True in the state `move`: a SQLite file goes as a VACUUM INTO
   *  snapshot. False (the live pass): a SQLite file gets an error frame. */
  snapshot: boolean;
  items: { i: number; p: string; offset?: number; length?: number }[];
}

export interface HomeFileHeader {
  i: number;
  p: string;
  mode: number;
  mtime: number;
  /** The bytes that follow in data frames. */
  size: number;
  q?: 1;
  offset?: number;
}

export interface HomeFileTrailer {
  i: number;
  end: true;
  /** The file's size or mtime moved while it was read. */
  changed?: true;
}

export interface HomeFileError {
  i: number;
  error: string;
}

/** Whether a path of her home moves. */
export function memberHomeScope(
  relPath: string,
  kind: HomeEntryKind,
): MemberHomeVerdict {
  if (kind === "other") return { in: false, why: "out" };
  for (const prefix of OUT_PREFIXES)
    if (relPath === prefix || relPath.startsWith(`${prefix}/`))
      return { in: false, why: "out" };
  if (SSH_LOGIN_KEYS.test(relPath))
    return { in: false, why: "bound", unit: "ssh-authorized-keys" };
  return { in: true };
}

/** A relative path with "/" separators, no empty, "." or ".." part. */
export function memberHomeRelPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    return false;
  if (path.startsWith("/")) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

// ---- shared checks ----

function checkStart(input: { home: unknown; nonce: unknown }): string {
  if (typeof input.nonce !== "string" || !MEMBER_HOME_NONCE.test(input.nonce))
    throw new Error("the nonce is not 32 hex characters");
  const home = input.home;
  if (typeof home !== "string" || !isAbsolute(home))
    throw new Error("the home is not an absolute path");
  // C5: the home must be its own realpath (no link on its way).
  if (realpathSync(home) !== home)
    throw new Error(`${home} is reached through a link`);
  if (!lstatSync(home).isDirectory())
    throw new Error(`${home} is not a folder`);
  return home;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const SQLITE_MIN_BYTES = 512;
const SQLITE_SIDE_SUFFIXES = ["-wal", "-shm", "-journal"];
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function startsWithSqliteMagic(fd: number): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  return (
    readSync(fd, head, 0, head.length, 0) === head.length &&
    head.equals(SQLITE_MAGIC)
  );
}

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

function sqliteBase(name: string): string | null {
  for (const suffix of SQLITE_SIDE_SUFFIXES)
    if (name.endsWith(suffix) && name.length > suffix.length)
      return name.slice(0, -suffix.length);
  return null;
}

function kindOf(st: Stats): HomeEntryKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

// ---- home-list ----

/** home-list, as the member. */
export async function listHome(
  input: HomeListInput,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const home = checkStart(input);
  let pending = "";
  const emit = async (line: unknown, force = false) => {
    if (line !== null) pending += `${JSON.stringify(line)}\n`;
    if (pending.length > 0 && (force || pending.length > 256 * 1024)) {
      const out = pending;
      pending = "";
      await write(Buffer.from(out));
    }
  };
  // Depth first, in name order: the office's walk (walkMoveManifest).
  const stack = [""];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir ? join(home, dir) : home);
    } catch {
      if (dir) await emit({ u: dir });
      else throw new Error(`${home} cannot be read`);
      continue;
    }
    names.sort();
    const listed: { name: string; rel: string; st: Stats }[] = [];
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name;
      try {
        listed.push({ name, rel, st: lstatSync(join(home, rel)) });
      } catch {
        await emit({ u: rel });
      }
    }
    const sqlite = new Set<string>();
    for (const e of listed)
      if (
        e.st.isFile() &&
        e.st.size >= SQLITE_MIN_BYTES &&
        memberHomeScope(e.rel, "file").in &&
        isSqliteFile(join(home, e.rel))
      )
        sqlite.add(e.name);
    const subdirs: string[] = [];
    for (const e of listed) {
      const kind = kindOf(e.st);
      // The path alone can be out of the move (a cache, her login keys).
      if (!memberHomeScope(e.rel, "file").in) continue;
      const base = sqliteBase(e.name);
      if (base !== null && sqlite.has(base)) continue;
      const line: HomeListLine = {
        p: e.rel,
        t:
          kind === "dir"
            ? "d"
            : kind === "symlink"
              ? "l"
              : kind === "file"
                ? "f"
                : "x",
        s: e.st.size,
        m: e.st.mtimeMs,
        mode: e.st.mode & 0o7777,
      };
      if (kind === "symlink") {
        try {
          line.l = readlinkSync(join(home, e.rel));
        } catch {
          await emit({ u: e.rel });
          continue;
        }
      }
      if (sqlite.has(e.name)) line.q = 1;
      if (kind === "dir") subdirs.push(e.rel);
      await emit(line);
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  await emit({ end: true }, true);
}

// ---- home-files ----

const DATA_FRAME_BYTES = 1024 * 1024;

function frame(payload: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([head, payload]);
}

const jsonFrame = (value: unknown) => frame(Buffer.from(JSON.stringify(value)));

class ItemRefused extends Error {}

/** Her .move-out as a real folder in her agent space, or null when it is
 *  not one (then no snapshot is made there). */
function moveOutDir(home: string, make: boolean): string | null {
  const agent = join(home, AGENT_DIR);
  const out = join(home, MOVE_OUT_DIR);
  try {
    if (make) {
      mkdirSync(agent, { recursive: false, mode: 0o700 });
    }
  } catch {
    // It is there.
  }
  try {
    if (make) mkdirSync(out, { mode: 0o700 });
  } catch {
    // It is there.
  }
  try {
    if (!lstatSync(agent).isDirectory() || !lstatSync(out).isDirectory())
      return null;
    if (realpathSync(out) !== out) return null;
    return out;
  } catch {
    return null;
  }
}

/** C7: the snapshots that a crashed call left. */
function removeLeftSnapshots(home: string): void {
  const out = moveOutDir(home, false);
  if (!out) return;
  for (const name of readdirSync(out))
    if (name.startsWith("move-"))
      try {
        if (lstatSync(join(out, name)).isFile()) rmSync(join(out, name));
      } catch {
        // Gone already.
      }
}

/** The bytes of the open file `fd` from `from`: `size` of them, as data
 *  frames, then the trailer. The header promised the size, so a file that
 *  shrank ends the call: the office fails it and the items after it. */
async function* content(
  fd: number,
  i: number,
  from: number,
  size: number,
): AsyncGenerator<Buffer> {
  const before = fstatSync(fd);
  let sent = 0;
  while (sent < size) {
    const want = Math.min(DATA_FRAME_BYTES, size - sent);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, from + sent + got);
      if (n === 0) throw new Error("the file shrank while it was read");
      got += n;
    }
    sent += want;
    yield frame(buf);
  }
  const after = fstatSync(fd);
  const changed =
    after.size !== before.size || after.mtimeMs !== before.mtimeMs;
  yield jsonFrame({ i, end: true, ...(changed ? { changed: true } : {}) });
}

async function* oneFile(
  home: string,
  nonce: string,
  snapshot: boolean,
  item: HomeFilesInput["items"][number],
): AsyncGenerator<Buffer> {
  const { i, p } = item;
  if (!memberHomeRelPath(p) || !memberHomeScope(p, "file").in)
    throw new ItemRefused("the path is not part of the move");
  const ranged = item.offset !== undefined || item.length !== undefined;
  const offset = item.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ItemRefused("the range's offset is not a whole number");
  if (
    item.length !== undefined &&
    (!Number.isSafeInteger(item.length) || item.length < 1)
  )
    throw new ItemRefused("the range's length is not a whole number");
  const slash = p.lastIndexOf("/");
  if (slash > 0) {
    const parent = join(home, p.slice(0, slash));
    let real: string | null;
    try {
      real = realpathSync(parent);
    } catch {
      real = null;
    }
    if (real !== parent)
      throw new ItemRefused("a folder on the path is a link or is gone");
  }
  const abs = join(home, p);
  const st = lstatSync(abs);
  if (!st.isFile()) throw new ItemRefused("the path is not a regular file");
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const base = sqliteBase(name);
  if (
    base !== null &&
    isSqliteFile(join(home, slash >= 0 ? p.slice(0, slash + 1) : "", base))
  )
    throw new ItemRefused("a SQLite side file moves inside its database");
  let fd: number | null = openSync(abs, OPEN_FLAGS);
  let snap: string | null = null;
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino)
      throw new ItemRefused("the file changed between the check and the open");
    const header = { i, p, mode: fst.mode & 0o7777, mtime: fst.mtimeMs };
    if (fst.size >= SQLITE_MIN_BYTES && startsWithSqliteMagic(fd)) {
      if (ranged) throw new ItemRefused("a SQLite file moves whole");
      if (!snapshot)
        throw new ItemRefused(
          "a SQLite file moves only after the lock, as a snapshot",
        );
      closeSync(fd);
      fd = null;
      const out = moveOutDir(home, true);
      if (!out) throw new ItemRefused("the snapshot folder is not a folder");
      snap = join(out, `move-${nonce}-${i}.db`);
      rmSync(snap, { force: true });
      const db = new Database(abs, { readonly: true });
      try {
        db.exec("PRAGMA busy_timeout=5000;");
        db.query("VACUUM INTO ?").run(snap);
      } finally {
        db.close();
      }
      fd = openSync(snap, OPEN_FLAGS);
      const size = fstatSync(fd).size;
      yield jsonFrame({ ...header, size, q: 1 });
      yield* content(fd, i, 0, size);
      return;
    }
    const left = Math.max(0, fst.size - offset);
    const size = item.length !== undefined ? Math.min(item.length, left) : left;
    yield jsonFrame({ ...header, size, ...(ranged ? { offset } : {}) });
    yield* content(fd, i, offset, size);
  } finally {
    if (fd !== null) closeSync(fd);
    if (snap) rmSync(snap, { force: true });
  }
}

/** home-files, as the member. */
export async function sendHomeFiles(
  input: HomeFilesInput,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const home = checkStart(input);
  removeLeftSnapshots(home);
  for (const item of Array.isArray(input.items) ? input.items : []) {
    const i = typeof item?.i === "number" ? item.i : -1;
    let started = false;
    try {
      for await (const out of oneFile(
        home,
        input.nonce,
        input.snapshot === true,
        item,
      )) {
        started = true;
        await write(out);
      }
    } catch (err) {
      // An item that failed before its header gets an error frame; one
      // that failed after it cannot be told apart from its bytes, so the
      // stream ends and the office fails the rest.
      if (started) throw err;
      await write(
        jsonFrame({
          i,
          error:
            err instanceof ItemRefused
              ? err.message
              : `it cannot be read: ${(err as Error).message}`,
        }),
      );
    }
  }
  await write(Buffer.alloc(4));
}
