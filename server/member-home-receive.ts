// The member's side of the place of a moved home (task 78733adf, slice
// 5c-2; design: internal-docs/office-move-design.md "Members with their own
// OS user (slice 5c)"): the runner's entries tree-in and tree-place run
// this as the member, on the new machine, inside the enable command's
// go-on. The office side is server/member-home-place.ts. The runner bundle
// carries this file.
//
// tree-in: the office streams her moved home as u32-length frames: per
// entry a header (TreeEntryHeader), then for a file exactly `size` bytes in
// data frames; a zero-length frame ends. The runner writes it into
// <home>/.isomux-agent/.move-in/tree-<nonce>/ (O_EXCL, O_NOFOLLOW, plain
// relative paths, each parent made by this call, setuid and setgid
// dropped), after a free-space check on her home's file system, and first
// removes tree-* folders a crashed call left. Paths under her
// MEMBER_SPACE_OWN_LOCATIONS or under .isomux-agent/.move-in are refused.
// Folders are written u+rwx; their modes and mtimes come at tree-place.
//
// tree-place: each top-level entry of the tree goes into her home: absent
// there, it is renamed in; a folder on both sides takes the same rule one
// level down; else the entry there goes to tree-<nonce>-replaced/ and the
// moved one goes in. Then the folder modes and mtimes, deepest first, and
// both folders go.

import {
  closeSync,
  constants,
  fchmodSync,
  futimesSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { memberHomeRelPath, memberHomeScope } from "./member-home-send.ts";
import { spaceNeeded } from "./member-move-receive.ts";

/** The nonce of one place: 32 hex characters. */
export const TREE_NONCE = /^[0-9a-f]{32}$/;

/** Her agent space in her home, and the staging folder in it. */
const MOVE_IN = ".isomux-agent/.move-in";
/** A header frame is a small JSON object. */
const HEADER_MAX = 64 * 1024;
/** One data frame at most (the office sends 1 MiB frames). */
const DATA_FRAME_MAX = 16 * 1024 * 1024;

const FILE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const DIR_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A mode without setuid and setgid. */
const plainMode = (mode: number) => mode & 0o1777;

export interface TreeInInput {
  nonce: string;
  /** Her home here, as passwd gives it. */
  home: string;
  /** The bytes the office sends (for the free-space check). */
  total: number;
}

export interface TreeEntryHeader {
  /** Relative to her home, "/" separated. */
  p: string;
  t: "f" | "d" | "l";
  mode: number;
  /** ms */
  mtime: number;
  /** A file's bytes that follow; 0 for a folder or a link. */
  size: number;
  /** A link's target. */
  l?: string;
}

export interface TreePlaceInput {
  nonce: string;
  home: string;
}

/** A folder of the tree: its mode and mtime come at tree-place (D4). */
interface TreeDir {
  p: string;
  mode: number;
  mtime: number;
}

/** The home and its staging folder, checked: the home is its own realpath,
 *  and the agent space and the staging folder are real folders. */
function staging(input: { nonce: unknown; home: unknown }, make: boolean) {
  if (typeof input.nonce !== "string" || !TREE_NONCE.test(input.nonce))
    throw new Error("the nonce is not 32 hex characters");
  const home = input.home;
  if (typeof home !== "string" || !isAbsolute(home))
    throw new Error("the home is not an absolute path");
  if (realpathSync(home) !== home)
    throw new Error(`${home} is reached through a link`);
  const moveIn = join(home, MOVE_IN);
  if (make) mkdirSync(moveIn, { recursive: true, mode: 0o700 });
  if (realpathSync(moveIn) !== moveIn)
    throw new Error(`${moveIn} is reached through a link`);
  const tree = join(moveIn, `tree-${input.nonce}`);
  return {
    home,
    moveIn,
    tree,
    dirsFile: `${tree}.dirs.json`,
    replaced: `${tree}-replaced`,
  };
}

/** Removes a folder that can hold read-only folders: each folder gets
 *  u+rwx first, by fd, never through a link. */
function removeTree(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    let fd: number;
    try {
      fd = openSync(p, DIR_FLAGS);
    } catch {
      continue; // Not a folder: rm takes it.
    }
    try {
      fchmodSync(fd, 0o700);
    } catch {
      // rm reports what it cannot remove.
    } finally {
      closeSync(fd);
    }
    try {
      for (const n of readdirSync(p)) stack.push(join(p, n));
    } catch {
      // rm reports it.
    }
  }
  rmSync(root, { recursive: true, force: true });
}

/** The frames of `body`: u32 BE length, then that many bytes. Null after a
 *  zero-length frame; throws when the stream ends first. */
function frames(body: AsyncIterable<Uint8Array>) {
  const it = body[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  const fill = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) throw new Error("the stream ended before its end frame");
      buf =
        buf.length === 0 ? Buffer.from(r.value) : Buffer.concat([buf, r.value]);
    }
  };
  return async (max: number): Promise<Buffer | null> => {
    await fill(4);
    const len = buf.readUInt32BE(0);
    if (len === 0) {
      buf = buf.subarray(4);
      return null;
    }
    if (len > max) throw new Error("a frame is too long");
    await fill(4 + len);
    const out = Buffer.from(buf.subarray(4, 4 + len));
    buf = buf.subarray(4 + len);
    return out;
  };
}

function parseHeader(bytes: Buffer): TreeEntryHeader {
  let v: unknown;
  try {
    v = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("a header is not JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error("a header is not a JSON object");
  const { p, t, mode, mtime, size, l } = v as Record<string, unknown>;
  if (!memberHomeRelPath(p)) throw new Error("a path is not a plain path");
  const kind =
    t === "f" ? "file" : t === "d" ? "dir" : t === "l" ? "symlink" : null;
  if (kind === null) throw new Error(`${p} has an unknown kind`);
  // The runner's own locations and the staging folder never come in.
  if (!memberHomeScope(p, kind).in)
    throw new Error(`${p} is not part of the move`);
  if (
    !Number.isSafeInteger(mode) ||
    (mode as number) < 0 ||
    (mode as number) > 0o7777
  )
    throw new Error(`${p} has a bad mode`);
  if (typeof mtime !== "number" || !Number.isFinite(mtime))
    throw new Error(`${p} has a bad mtime`);
  if (
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (t !== "f" && size !== 0)
  )
    throw new Error(`${p} has a bad size`);
  if (
    t === "l"
      ? typeof l !== "string" || l === "" || l.includes("\0")
      : l !== undefined
  )
    throw new Error(`${p} has a bad link target`);
  return {
    p,
    t: t as TreeEntryHeader["t"],
    mode: mode as number,
    mtime,
    size: size as number,
    ...(t === "l" ? { l: l as string } : {}),
  };
}

/** tree-in, as the member. */
export async function receiveTree(
  input: TreeInInput,
  body: AsyncIterable<Uint8Array>,
): Promise<{ files: number; bytes: number }> {
  if (typeof input.nonce !== "string" || !TREE_NONCE.test(input.nonce))
    throw new Error("the nonce is not 32 hex characters");
  if (!Number.isSafeInteger(input.total) || input.total < 0)
    throw new Error("the total is not a whole number");
  const s = staging(input, true);
  // A crashed call's trees go first.
  for (const name of readdirSync(s.moveIn))
    if (name.startsWith("tree-")) removeTree(join(s.moveIn, name));
  const fs = statfsSync(s.home);
  if (fs.bavail * fs.bsize < spaceNeeded(input.total))
    throw new Error(
      `the home's file system has ${fs.bavail * fs.bsize} bytes free, and the move needs ${spaceNeeded(input.total)}`,
    );
  mkdirSync(s.tree, { mode: 0o700 });
  let ok = false;
  try {
    const next = frames(body);
    /** The folders this call made, relative; "" is the tree. */
    const made = new Set<string>([""]);
    const dirs: TreeDir[] = [];
    let files = 0;
    let bytes = 0;
    for (;;) {
      const head = await next(HEADER_MAX);
      if (head === null) break;
      const h = parseHeader(head);
      const slash = h.p.lastIndexOf("/");
      if (!made.has(slash < 0 ? "" : h.p.slice(0, slash)))
        throw new Error(`the folder of ${h.p} did not come before it`);
      const abs = join(s.tree, h.p);
      if (h.t === "d") {
        mkdirSync(abs, { mode: 0o700 });
        made.add(h.p);
        dirs.push({ p: h.p, mode: plainMode(h.mode), mtime: h.mtime });
        continue;
      }
      if (h.t === "l") {
        symlinkSync(h.l!, abs);
        try {
          lutimesSync(abs, h.mtime / 1000, h.mtime / 1000);
        } catch {
          // A link's time is not worth a failure.
        }
        continue;
      }
      const fd = openSync(abs, FILE_FLAGS, 0o600);
      try {
        let left = h.size;
        while (left > 0) {
          const data = await next(DATA_FRAME_MAX);
          if (data === null) throw new Error(`${h.p} ended before its size`);
          if (data.length > left)
            throw new Error(`${h.p} got more bytes than its size`);
          let off = 0;
          while (off < data.length)
            off += writeSync(fd, data, off, data.length - off);
          left -= data.length;
        }
        fchmodSync(fd, plainMode(h.mode));
        futimesSync(fd, h.mtime / 1000, h.mtime / 1000);
      } finally {
        closeSync(fd);
      }
      files++;
      bytes += h.size;
    }
    writeFileSync(s.dirsFile, JSON.stringify(dirs), { mode: 0o600 });
    ok = true;
    return { files, bytes };
  } finally {
    if (!ok) {
      removeTree(s.tree);
      rmSync(s.dirsFile, { force: true });
    }
  }
}

/** Opens a real folder (never a link) and gives it u+rwx; false when the
 *  path is not a real folder. */
function openUp(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, DIR_FLAGS);
  } catch {
    return false;
  }
  try {
    fchmodSync(fd, 0o700);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** tree-place, as the member. */
export function placeTree(input: TreePlaceInput): {
  placed: number;
  replaced: number;
} {
  const s = staging(input, false);
  if (!lstatSync(s.tree).isDirectory())
    throw new Error("the tree is not a folder");
  const dirs = JSON.parse(readFileSync(s.dirsFile, "utf8")) as TreeDir[];
  if (!Array.isArray(dirs)) throw new Error("the tree's folder list is bad");
  removeTree(s.replaced);
  mkdirSync(s.replaced, { mode: 0o700 });
  let placed = 0;
  let replaced = 0;
  const merge = (rel: string) => {
    const from = join(s.tree, rel);
    for (const name of readdirSync(from).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const src = join(s.tree, r);
      const dst = join(s.home, r);
      let there: ReturnType<typeof lstatSync> | null;
      try {
        there = lstatSync(dst);
      } catch {
        there = null;
      }
      if (there === null) {
        renameSync(src, dst);
        placed++;
        continue;
      }
      // A folder on both sides: one level down. A link is never entered.
      if (there.isDirectory() && lstatSync(src).isDirectory()) {
        openUp(dst);
        merge(r);
        continue;
      }
      // The old office's data wins. A folder without u+w cannot move to
      // another parent.
      if (there.isDirectory()) openUp(dst);
      renameSync(dst, join(s.replaced, String(replaced)));
      renameSync(src, dst);
      replaced++;
      placed++;
    }
  };
  merge("");
  // D4: modes and mtimes once every rename is done, deepest first.
  const depth = (p: string) => p.split("/").length;
  for (const d of [...dirs].sort((a, b) => depth(b.p) - depth(a.p))) {
    if (!memberHomeRelPath(d.p)) continue;
    let fd: number;
    try {
      fd = openSync(join(s.home, d.p), DIR_FLAGS);
    } catch {
      continue; // Not a real folder any more.
    }
    try {
      fchmodSync(fd, plainMode(d.mode));
      futimesSync(fd, d.mtime / 1000, d.mtime / 1000);
    } finally {
      closeSync(fd);
    }
  }
  removeTree(s.tree);
  removeTree(s.replaced);
  rmSync(s.dirsFile, { force: true });
  return { placed, replaced };
}
