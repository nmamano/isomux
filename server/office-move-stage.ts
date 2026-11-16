// The stage of an office move on the new office (task 78733adf, slice 2b;
// design: internal-docs/office-move-design.md "The new office"). The pull
// writes the old office's home into `<home>/.isomux-move-in/stage/`, never
// following a link:
//
// - pass 1 (`prepare`, one manifest entry at a time): directories made 0700,
//   every regular file made empty (O_CREAT|O_EXCL|O_NOFOLLOW, 0600), links
//   only listed;
// - batches (`writeBatch`): each record stream must match its request (order,
//   type, SQLite flag, offset, length); content is written by position into
//   the file pass 1 made (O_WRONLY|O_NOFOLLOW, fstat dev/ino checked), so a
//   retry rewrites its own bytes and deletes nothing; each item's `end`
//   goes in the ledger;
// - `finish`: files' mode and mtime by fd, then the links, then the
//   directories deepest first;
// - `check`: from the ledger (one end per requested item, with the
//   requested length; SQLite by its trailer), then lstat of the stage.
//
// Pure fs, no network: the pull job (office-move-in.ts) drives it.

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errMessage } from "../shared/errors.ts";
import { MOVE_IN_DIR } from "./office-move.ts";
import type {
  MoveBatchItem,
  MoveManifestEntry,
  MoveRecordEvent,
} from "./office-move-pull.ts";

export { MOVE_IN_DIR };
/** The stage, under MOVE_IN_DIR. */
export const MOVE_IN_STAGE = "stage";

/** A manifest or a record stream the stage refuses. A batch that throws it
 *  fails as a whole (the pull runs it again); a manifest that throws it
 *  fails the pull. */
export class MoveStageError extends Error {
  constructor(
    readonly code:
      | "unsafe_path"
      | "duplicate_path"
      | "parent_not_dir"
      | "not_prepared"
      | "stream_mismatch"
      | "write_failed",
    message: string,
  ) {
    super(message);
    this.name = "MoveStageError";
  }
}

/** Whether a manifest or record path is safe to join to the stage:
 *  relative, "/" separators, no empty, "." or ".." segment, no NUL. */
export function isSafeMovePath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/** One item of a batch as the pull planned it: the request item and the
 *  manifest entry it comes from (a regular file). */
export interface MoveStageItem extends MoveBatchItem {
  entry: MoveManifestEntry;
}

export interface MoveStageBatch {
  /** The batch number (the AAD's). A retry keeps it. */
  n: number;
  items: MoveStageItem[];
}

/** One item's outcome in a batch. */
export type MoveStageItemResult =
  | { path: string; offset: number; bytes: number; changed?: true }
  | { path: string; offset: number; error: string };

export interface MoveStageCheck {
  /** Every manifest entry is in the stage and every requested item has its
   *  end with the requested length. */
  complete: boolean;
  files: number;
  bytes: number;
  /** Items with no end, a short end or an error record; directories and
   *  links not in the stage. */
  missing: { path: string; reason: string }[];
  /** Files whose size or mtime moved while the old office read them. */
  changed: string[];
}

export interface MoveStage {
  /** The stage folder. */
  readonly root: string;
  /** Pass 1, in manifest order. Throws MoveStageError on an unsafe or
   *  duplicate path, or a parent the manifest lists as a link or a file. */
  prepare(entry: MoveManifestEntry): void;
  /** Writes one batch's records. Throws MoveStageError when the stream does
   *  not match the request; then the batch's ledger rows are dropped. A
   *  retry with the same `n` replaces them. */
  writeBatch(
    batch: MoveStageBatch,
    events: AsyncIterable<MoveRecordEvent>,
  ): Promise<MoveStageItemResult[]>;
  /** Modes and mtimes (by fd for files), then the links, then the
   *  directories deepest first. The manifest is read again. */
  finish(entries: AsyncIterable<MoveManifestEntry>): Promise<void>;
  /** The final check, from the ledger, then lstat. */
  check(entries: AsyncIterable<MoveManifestEntry>): Promise<MoveStageCheck>;
}

/** What one requested item gave: its end, or why it failed. */
type Outcome =
  | { bytes: number; want: number | null; changed?: true }
  | {
      error: string;
    };

/** A regular file pass 1 made, and the ledger of its items. */
interface FileRow {
  ino: number;
  /** The whole file's outcome (no range). */
  whole?: Outcome;
  /** Per range offset. */
  ranges?: Map<number, Outcome>;
}

type Node = "d" | "l" | FileRow;

// O_NONBLOCK: a fifo another process puts in the stage must not block the
// office's event loop at the open (the fstat checks come after it).
const WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;
const READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const DIR_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_DIRECTORY |
  fsConstants.O_NONBLOCK;

/** The mode bits a staged entry keeps: no setuid or setgid. */
const keptMode = (mode: number) => mode & 0o1777;

const parentOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

const mismatch = (message: string) =>
  new MoveStageError("stream_mismatch", message);

/** A stage at `root` (made 0700; it must not exist yet). */
export function createMoveStage(root: string): MoveStage {
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  // Not recursive: an existing stage throws EEXIST.
  mkdirSync(root, { mode: 0o700 });
  const realRoot = realpathSync(root);
  const rootDev = lstatSync(realRoot).dev;
  const nodes = new Map<string, Node>();

  // Whether a folder of the stage is still the real folder pass 1 made (no
  // link put on the way). Cached for the last parent: entries come in
  // folder order.
  let lastParent: { rel: string; ok: boolean } | null = null;
  const parentIsReal = (rel: string): boolean => {
    if (rel === "") return true;
    if (lastParent?.rel === rel) return lastParent.ok;
    const expected = join(realRoot, rel);
    let ok: boolean;
    try {
      ok = realpathSync(expected) === expected;
    } catch {
      ok = false;
    }
    lastParent = { rel, ok };
    return ok;
  };

  const abs = (rel: string) => join(realRoot, rel);

  // Opens a file pass 1 made, never through a link; null with the reason
  // otherwise.
  const openMade = (
    rel: string,
    row: FileRow,
    flags: number,
  ): { fd: number } | { error: string } => {
    if (!parentIsReal(parentOf(rel)))
      return {
        error: "A folder on the path in the stage is a link or is gone.",
      };
    let fd: number;
    try {
      fd = openSync(abs(rel), flags);
    } catch (err) {
      return { error: `The stage file does not open: ${errMessage(err)}` };
    }
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== rootDev || st.ino !== row.ino) {
      closeSync(fd);
      return { error: "The stage file is not the one the move made." };
    }
    return { fd };
  };

  const fileRow = (path: string): FileRow | null => {
    const n = nodes.get(path);
    return n && typeof n === "object" ? n : null;
  };

  const clearOutcome = (item: MoveStageItem) => {
    const row = fileRow(item.path);
    if (!row) return;
    if (item.length === undefined) delete row.whole;
    else row.ranges?.delete(item.offset ?? 0);
  };

  const setOutcome = (item: MoveStageItem, outcome: Outcome) => {
    const row = fileRow(item.path);
    if (!row) return;
    if (item.length === undefined) row.whole = outcome;
    else (row.ranges ??= new Map()).set(item.offset ?? 0, outcome);
  };

  return {
    root,

    prepare(entry) {
      const p = entry.p;
      if (!isSafeMovePath(p))
        throw new MoveStageError(
          "unsafe_path",
          `An unsafe path: ${JSON.stringify(p)}`,
        );
      if (nodes.has(p))
        throw new MoveStageError("duplicate_path", `A path twice: ${p}`);
      const parent = parentOf(p);
      if (parent !== "" && nodes.get(parent) !== "d")
        throw new MoveStageError(
          "parent_not_dir",
          `The folder of ${p} is not a folder of the manifest.`,
        );
      if (!parentIsReal(parent))
        throw new MoveStageError(
          "write_failed",
          `A folder on the path of ${p} is a link or is gone.`,
        );
      try {
        if (entry.t === "d") {
          mkdirSync(abs(p), { mode: 0o700 });
          nodes.set(p, "d");
        } else if (entry.t === "l") {
          if (typeof entry.l !== "string")
            throw new MoveStageError(
              "unsafe_path",
              `A link with no target: ${p}`,
            );
          // Made in finish, after every file and folder.
          nodes.set(p, "l");
        } else if (entry.t === "f") {
          const fd = openSync(abs(p), CREATE_FLAGS, 0o600);
          try {
            nodes.set(p, { ino: fstatSync(fd).ino });
          } finally {
            closeSync(fd);
          }
        } else {
          throw new MoveStageError(
            "unsafe_path",
            `An unknown entry type: ${p}`,
          );
        }
      } catch (err) {
        if (err instanceof MoveStageError) throw err;
        throw new MoveStageError(
          "write_failed",
          `The stage could not make ${p}: ${errMessage(err)}`,
        );
      }
    },

    async writeBatch(batch, events) {
      const items = batch.items;
      // A link can be put in the stage between two batches: check again.
      lastParent = null;
      for (const item of items) clearOutcome(item);
      const results: MoveStageItemResult[] = [];
      const done: { item: MoveStageItem; outcome: Outcome }[] = [];
      let next = 0;
      let cur: {
        item: MoveStageItem;
        fd: number | null;
        error: string | null;
        written: number;
        limit: number;
      } | null = null;
      const closeCur = () => {
        if (cur?.fd != null) closeSync(cur.fd);
        if (cur) cur.fd = null;
      };
      const finishItem = (item: MoveStageItem, outcome: Outcome) => {
        done.push({ item, outcome });
        results.push(
          "error" in outcome
            ? {
                path: item.path,
                offset: item.offset ?? 0,
                error: outcome.error,
              }
            : {
                path: item.path,
                offset: item.offset ?? 0,
                bytes: outcome.bytes,
                ...(outcome.changed ? { changed: true as const } : {}),
              },
        );
        next++;
      };
      try {
        for await (const ev of events) {
          switch (ev.type) {
            case "entry": {
              if (cur) throw mismatch("An entry starts inside another.");
              const item = items[next];
              if (!item || ev.path !== item.path)
                throw mismatch(
                  `An entry the batch did not ask for next: ${ev.path}`,
                );
              if (ev.t !== "f")
                throw mismatch(`Not a regular file: ${ev.path}`);
              if ((ev.q === 1) !== (item.entry.q === 1))
                throw mismatch(`The SQLite flag differs: ${ev.path}`);
              if ((ev.offset ?? 0) !== (item.offset ?? 0))
                throw mismatch(`Another offset than asked: ${ev.path}`);
              const limit =
                item.length !== undefined
                  ? item.length
                  : item.entry.q === 1
                    ? Number.POSITIVE_INFINITY
                    : item.entry.s;
              const row = fileRow(item.path);
              const opened = row
                ? openMade(item.path, row, WRITE_FLAGS)
                : { error: "The file is not in the manifest's first pass." };
              cur = {
                item,
                fd: "fd" in opened ? opened.fd : null,
                error: "error" in opened ? opened.error : null,
                written: 0,
                limit,
              };
              break;
            }
            case "data": {
              if (!cur) throw mismatch("Content outside an entry.");
              const len = ev.bytes.byteLength;
              if (cur.written + len > cur.limit)
                throw mismatch(`More content than asked: ${cur.item.path}`);
              if (cur.fd !== null) {
                const at = (cur.item.offset ?? 0) + cur.written;
                let off = 0;
                try {
                  while (off < len)
                    off += writeSync(
                      cur.fd,
                      ev.bytes,
                      off,
                      len - off,
                      at + off,
                    );
                } catch (err) {
                  cur.error = `The stage file could not be written: ${errMessage(err)}`;
                  closeCur();
                }
              }
              cur.written += len;
              break;
            }
            case "end": {
              if (!cur) throw mismatch("A trailer outside an entry.");
              if (ev.bytes !== cur.written)
                throw mismatch(
                  `A trailer that does not match: ${cur.item.path}`,
                );
              if (cur.fd !== null && cur.item.length === undefined) {
                try {
                  // A retry that got fewer bytes leaves no tail.
                  ftruncateSync(cur.fd, cur.written);
                } catch (err) {
                  cur.error = `The stage file could not be cut: ${errMessage(err)}`;
                }
              }
              closeCur();
              const want =
                cur.item.length !== undefined
                  ? cur.item.length
                  : cur.item.entry.q === 1
                    ? null
                    : cur.item.entry.s;
              finishItem(
                cur.item,
                cur.error !== null
                  ? { error: cur.error }
                  : {
                      bytes: ev.bytes,
                      want,
                      ...(ev.changed ? { changed: true as const } : {}),
                    },
              );
              cur = null;
              break;
            }
            case "error": {
              if (cur) {
                if (ev.path !== cur.item.path)
                  throw mismatch(`An error for another path: ${ev.path}`);
                closeCur();
                finishItem(cur.item, { error: ev.error });
                cur = null;
                break;
              }
              const item = items[next];
              if (!item || ev.path !== item.path)
                throw mismatch(
                  `An error the batch did not ask for next: ${ev.path}`,
                );
              finishItem(item, { error: ev.error });
              break;
            }
          }
        }
        if (cur || next !== items.length)
          throw mismatch("The batch ends before every item it asked for.");
      } catch (err) {
        closeCur();
        for (const item of items) clearOutcome(item);
        throw err;
      }
      for (const { item, outcome } of done) setOutcome(item, outcome);
      return results;
    },

    async finish(entries) {
      lastParent = null;
      const dirs: { path: string; mode: number; m: number; depth: number }[] =
        [];
      const links: MoveManifestEntry[] = [];
      for await (const e of entries) {
        if (e.t === "d") {
          dirs.push({
            path: e.p,
            mode: e.mode,
            m: e.m,
            depth: e.p.split("/").length,
          });
          continue;
        }
        if (e.t === "l") {
          links.push(e);
          continue;
        }
        const row = fileRow(e.p);
        if (!row) continue;
        const opened = openMade(e.p, row, READ_FLAGS);
        if ("error" in opened) continue;
        try {
          fchmodSync(opened.fd, keptMode(e.mode));
          futimesSync(opened.fd, e.m / 1000, e.m / 1000);
        } catch (err) {
          console.error(`[move-in] mode of ${e.p}:`, errMessage(err));
        } finally {
          closeSync(opened.fd);
        }
      }
      for (const e of links) {
        if (nodes.get(e.p) !== "l" || typeof e.l !== "string") continue;
        if (!parentIsReal(parentOf(e.p))) continue;
        try {
          symlinkSync(e.l, abs(e.p));
          lutimesSync(abs(e.p), e.m / 1000, e.m / 1000);
        } catch (err) {
          console.error(`[move-in] link ${e.p}:`, errMessage(err));
        }
      }
      // Deepest first: a read-only folder gets its mode after its content.
      dirs.sort((a, b) => b.depth - a.depth);
      for (const d of dirs) {
        if (nodes.get(d.path) !== "d") continue;
        if (!parentIsReal(parentOf(d.path))) continue;
        let fd: number;
        try {
          fd = openSync(abs(d.path), DIR_FLAGS);
        } catch (err) {
          console.error(`[move-in] folder ${d.path}:`, errMessage(err));
          continue;
        }
        try {
          if (fstatSync(fd).dev !== rootDev) continue;
          fchmodSync(fd, keptMode(d.mode));
          futimesSync(fd, d.m / 1000, d.m / 1000);
        } catch (err) {
          console.error(`[move-in] folder ${d.path}:`, errMessage(err));
        } finally {
          closeSync(fd);
        }
      }
    },

    async check(entries) {
      lastParent = null;
      const result: MoveStageCheck = {
        complete: false,
        files: 0,
        bytes: 0,
        missing: [],
        changed: [],
      };
      const miss = (path: string, reason: string) =>
        result.missing.push({ path, reason });
      const onDisk = (rel: string) => {
        try {
          return lstatSync(abs(rel));
        } catch {
          return null;
        }
      };
      for await (const e of entries) {
        const real = parentIsReal(parentOf(e.p));
        const st = real ? onDisk(e.p) : null;
        if (e.t === "d") {
          if (!st?.isDirectory()) miss(e.p, "The folder is not in the stage.");
          continue;
        }
        if (e.t === "l") {
          let target: string | null = null;
          if (st?.isSymbolicLink())
            try {
              target = readlinkSync(abs(e.p));
            } catch {
              target = null;
            }
          if (target !== e.l) miss(e.p, "The link is not in the stage.");
          continue;
        }
        const row = fileRow(e.p);
        if (!row) {
          miss(e.p, "The file was not made in the stage.");
          continue;
        }
        let size: number | null = null;
        let reason: string | null = null;
        let changed = false;
        if (row.ranges && row.ranges.size > 0) {
          let pos = 0;
          for (const off of [...row.ranges.keys()].sort((a, b) => a - b)) {
            const o = row.ranges.get(off)!;
            if ("error" in o) {
              reason = o.error;
              break;
            }
            if (off !== pos || o.bytes !== o.want) {
              reason = "A part of the file did not come whole.";
              break;
            }
            pos += o.bytes;
            if (o.changed) changed = true;
          }
          if (reason === null && pos !== e.s)
            reason = "A part of the file did not come.";
          size = pos;
        } else if (row.whole) {
          const o = row.whole;
          if ("error" in o) reason = o.error;
          else if (o.want !== null && o.bytes !== o.want)
            reason = "The file came with another size than the manifest's.";
          else {
            size = o.bytes;
            if (o.changed) changed = true;
          }
        } else {
          reason = "The file did not come.";
        }
        if (reason === null && (!st?.isFile() || st.size !== size))
          reason = "The file in the stage is not the one the move wrote.";
        if (reason !== null) {
          miss(e.p, reason);
          continue;
        }
        if (changed) result.changed.push(e.p);
        result.files++;
        result.bytes += size ?? 0;
      }
      result.complete = result.missing.length === 0;
      return result;
    },
  };
}
