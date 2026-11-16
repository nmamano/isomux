// Folders outside the office user's home (task 78733adf, slice 5b; design:
// internal-docs/office-move-design.md "Folders outside the home"). The old
// office picks the folders its records name; the new office checks where
// each one lands, and keeps a record of the folders where it staged a copy.

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  MoveInFolderBlock,
  MoveInFolderCheck,
  MoveOutsideFolder,
  MoveOutsideFolders,
  MoveOutsideLeft,
  MoveOutsideLeftReason,
} from "../shared/office-move.ts";
import { MOVE_IN_DIR } from "./office-move.ts";
import { createMoveFolderScope, type MoveScope } from "./office-move-scope.ts";
import { removeMoveTree } from "./office-move-stage.ts";

export type {
  MoveInFolderBlock,
  MoveInFolderCheck,
  MoveOutsideFolder,
  MoveOutsideFolders,
  MoveOutsideLeft,
  MoveOutsideLeftReason,
} from "../shared/office-move.ts";

// ---- the old office ----

const realFs: MoveOutsideFs = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

/** Whether `child` is `parent` or inside it (both resolved, absolute). */
export function moveOutsideInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(p);
}

const overlaps = (a: string, b: string) =>
  moveOutsideInside(a, b) || moveOutsideInside(b, a);

// ---- the new office ----

const realFolderFs: MoveInFolderFs = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  },
  readdir: (path) => readdirSync(path),
  writable(path) {
    try {
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** "/", then each part of an absolute, resolved path, top down. */
function partsOf(path: string): string[] {
  const parts = ["/"];
  let cur = "";
  for (const name of path.split("/").filter(Boolean)) {
    cur = `${cur}/${name}`;
    parts.push(cur);
  }
  return parts;
}

const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(4, "0");

/** A path as one shell word. */
const shellWord = (p: string) =>
  /^[A-Za-z0-9_./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;

// ---- the new office's record (C5) ----

const recordFile = (home: string) =>
  join(home, MOVE_IN_DIR, MOVE_IN_OUTSIDE_FILE);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const depth = (p: string) => p.split("/").length;

/** What collectMoveOutsideFolders reads of the disk. Production: lstat and
 *  realpath of node:fs; null when the path is gone or does not read. */
export interface MoveOutsideFs {
  lstat(
    path: string,
  ): { isDirectory(): boolean; uid: number; mode: number } | null;
  realpath(path: string): string | null;
}

/** The temp folders whose content the box clears (C2): a folder at or below
 *  one of them is left with the reason `temp`. */
export const MOVE_TEMP_ROOTS = ["/tmp", "/var/tmp", "/dev/shm", "/run"];

/** Old office: the folders outside the home that move, and the ones left
 *  with a reason. `paths` are the folders the office's records name (agent,
 *  session, room, app, app data and schedule folders), in any order, with
 *  repeats. The rules, in this order: resolve each path (a path that is not
 *  absolute is dropped); drop a path inside the home, a missing path and a
 *  path that is not a folder; give the left reasons (`temp`, `link`,
 *  `office`, `owner`); then fold: a candidate inside a folder that moves is
 *  neither listed nor moved alone, and a left one is listed only when no
 *  ancestor moves. Both lists are sorted by path. */
export function collectMoveOutsideFolders(input: {
  paths: string[];
  home: string;
  stateRoot: string;
  codeDir: string | null;
  backupDir: string | null;
  uid: number;
  fs?: MoveOutsideFs;
}): MoveOutsideFolders {
  const fs = input.fs ?? realFs;
  const home = resolve(input.home);
  const office = [home, input.stateRoot, input.codeDir, input.backupDir]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .map((p) => resolve(p));
  const seen = new Set<string>();
  const move: MoveOutsideFolder[] = [];
  const left: MoveOutsideLeft[] = [];
  for (const raw of input.paths) {
    if (typeof raw !== "string" || !isAbsolute(raw)) continue;
    const path = resolve(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    if (moveOutsideInside(path, home)) continue;
    // Realpath first: a link to a folder is left as `link`, not dropped.
    const real = fs.realpath(path);
    if (real === null) continue;
    const st = fs.lstat(real);
    if (!st || !st.isDirectory()) continue;
    let reason: MoveOutsideLeftReason | null = null;
    if (MOVE_TEMP_ROOTS.some((t) => moveOutsideInside(path, t)))
      reason = "temp";
    else if (real !== path) reason = "link";
    else if (office.some((o) => overlaps(path, o))) reason = "office";
    else if (st.uid !== input.uid) reason = "owner";
    if (reason) left.push({ path, reason });
    else move.push({ path, mode: st.mode & 0o7777 });
  }
  // The fold (C3): inside a moved folder, nothing is listed.
  const moved = move.map((m) => m.path);
  const under = (p: string) =>
    moved.some((m) => m !== p && moveOutsideInside(p, m));
  const byPath = <T extends { path: string }>(a: T, b: T) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return {
    move: move.filter((m) => !under(m.path)).sort(byPath),
    left: left.filter((l) => !under(l.path)).sort(byPath),
  };
}

/** The scope of a walk or a batch inside an outside folder: everything but
 *  sockets, fifos and devices, and a top-level `.isomux-move-in` (the new
 *  office's stage). The SQLite side-file rule is the walk's and the batch's,
 *  as for the home. */
export function createMoveOutsideScope(folder: string): MoveScope {
  return createMoveFolderScope(folder, [MOVE_IN_DIR]);
}

/** What checkMoveInFolder reads of the disk. Production: lstat, readdir and
 *  access(W_OK) of node:fs; lstat is null when the path is absent. */
export interface MoveInFolderFs {
  lstat(path: string): {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    gid: number;
    mode: number;
  } | null;
  readdir(path: string): string[];
  writable(path: string): boolean;
}

/** New office: whether the folder `path` of the old office can land here.
 *  Reads only. Every existing part of the path from "/" down is checked: a
 *  link (`link`), not a folder (`not_dir`), owned by a user other than root
 *  and the office user (`owner`), or writable by others, or by a group
 *  other than gid 0 and the office user's group, without the sticky bit
 *  (`unsafe_parent`). The folder itself, when it exists, must be the office
 *  user's (`owner`, with a chown command), hold nothing but
 *  `.isomux-move-in` (`not_empty`), and be readable (`no_write`, no
 *  command). When it is absent, its deepest existing ancestor must be
 *  writable by the office user (`no_write`, with an
 *  install -d command); `create` lists the parts to make, top down. A path
 *  inside the home or holding it is `in_home`. */
export function checkMoveInFolder(
  path: string,
  opts: {
    home: string;
    uid: number;
    gid: number;
    user: string;
    group: string;
    mode: number;
    fs?: MoveInFolderFs;
  },
): MoveInFolderCheck {
  const fs = opts.fs ?? realFolderFs;
  const target = resolve(path);
  const home = resolve(opts.home);
  const block = (
    reason: MoveInFolderBlock,
    at: string,
    command?: string,
  ): MoveInFolderCheck => ({
    path: target,
    ok: false,
    reason,
    at,
    ...(command ? { command } : {}),
  });
  if (overlaps(target, home)) return block("in_home", target);
  const parts = partsOf(target);
  let deepest = "/";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const st = fs.lstat(part);
    if (!st) {
      if (!fs.writable(deepest))
        return block(
          "no_write",
          deepest,
          `sudo install -d -o ${opts.user} -g ${opts.group} -m ${octal(opts.mode)} ${shellWord(target)}`,
        );
      return { path: target, ok: true, create: parts.slice(i) };
    }
    const self = part === target;
    if (st.isSymbolicLink()) return block("link", part);
    if (!st.isDirectory()) return block("not_dir", part);
    if (self ? st.uid !== opts.uid : st.uid !== 0 && st.uid !== opts.uid)
      return block(
        "owner",
        part,
        self
          ? `sudo chown ${opts.user}:${opts.group} ${shellWord(target)}`
          : undefined,
      );
    const sticky = (st.mode & 0o1000) !== 0;
    const othersWrite = (st.mode & 0o002) !== 0;
    const groupWrite =
      (st.mode & 0o020) !== 0 && st.gid !== 0 && st.gid !== opts.gid;
    if (!sticky && (othersWrite || groupWrite))
      return block("unsafe_parent", part);
    deepest = part;
  }
  let names: string[];
  try {
    names = fs.readdir(target).filter((n) => n !== MOVE_IN_DIR);
  } catch {
    // A folder this office cannot read: it cannot stage in it either.
    return block("no_write", target);
  }
  if (names.length > 0) return block("not_empty", target);
  return { path: target, ok: true, create: [] };
}

/** `<home>/.isomux-move-in/outside.json` (0600): every folder where this
 *  box made a `.isomux-move-in`, and every folder this box made (C5). */
export interface MoveInOutsideRecord {
  staged: string[];
  created: string[];
}

export const MOVE_IN_OUTSIDE_FILE = "outside.json";

/** The record, or an empty one when it is absent or does not parse. */
export function readMoveInOutside(home: string): MoveInOutsideRecord {
  try {
    const v = JSON.parse(readFileSync(recordFile(home), "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const r = v as Record<string, unknown>;
      return { staged: strings(r.staged), created: strings(r.created) };
    }
  } catch {
    // Absent or broken: nothing recorded.
  }
  return { staged: [], created: [] };
}

/** Writes the record (tmp + rename, 0600). */
export function writeMoveInOutside(
  home: string,
  record: MoveInOutsideRecord,
): void {
  const file = recordFile(home);
  mkdirSync(join(home, MOVE_IN_DIR), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Removes the `.isomux-move-in` of every recorded folder not in `keep`,
 *  then removes, deepest first and only when empty, each created folder
 *  that is not in `keep` and holds no folder of `keep`; and writes the
 *  record without them. A pass calls it with its manifest's folders, a
 *  cancel and DELETE with none. */
export function dropMoveInOutside(home: string, keep: string[]): void {
  const rec = readMoveInOutside(home);
  if (rec.staged.length === 0 && rec.created.length === 0) return;
  const kept = new Set(keep);
  for (const folder of rec.staged)
    if (!kept.has(folder)) removeMoveTree(join(folder, MOVE_IN_DIR));
  const created: string[] = [];
  const order = [...new Set(rec.created)].sort((a, b) => depth(b) - depth(a));
  for (const folder of order) {
    if (kept.has(folder) || keep.some((k) => moveOutsideInside(k, folder))) {
      created.push(folder);
      continue;
    }
    try {
      rmdirSync(folder);
    } catch (err) {
      // Gone already: dropped from the record. Not empty: it stays recorded,
      // so a later cancel tries again.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        created.push(folder);
    }
  }
  writeMoveInOutside(home, {
    staged: rec.staged.filter((f) => kept.has(f)),
    created: created.reverse(),
  });
}

/** The end of the swap: removes the `.isomux-move-in` of every recorded
 *  folder and the record, and never a folder (a folder that moved empty
 *  stays). */
export function clearMoveInOutside(home: string): void {
  for (const folder of readMoveInOutside(home).staged)
    removeMoveTree(join(folder, MOVE_IN_DIR));
  rmSync(recordFile(home), { force: true });
}
