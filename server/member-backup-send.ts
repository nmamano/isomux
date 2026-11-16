// The member's side of the backup of their agent space
// (internal-docs/member-os-user-design.md, slice 3c): the runner's entries
// backup-list and backup-files run this as the member. The office side is
// server/member-backup.ts, which trusts nothing here but the bytes. The
// runner bundle carries this file.
//
// backup-list: an lstat walk of their agent space that never leaves its file
// system, never enters a link and never lists or enters what
// memberSpaceExcluded leaves out. One JSON line per entry, then {"end":true}.
//
// backup-files: the asked files, each opened O_NOFOLLOW and checked by
// fstat against the inode and size they listed. Records: u32 BE length, a
// JSON header, then exactly `size` bytes; a zero length ends the stream.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { memberSpaceExcluded } from "./member-space-exclusions.ts";

// One entry of the listing. k: d (folder), f (file), l (link), x (left
// out: a socket, a FIFO or a device, `what` says which).
export interface SpaceEntry {
  p: string;
  k: "d" | "f" | "l" | "x";
  mode: number;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
  target?: string;
  what?: "socket" | "fifo" | "device";
}

export interface SpaceFilesInput {
  agentRoot: string;
  // As listed: inode, size and times (ns, as strings).
  files: {
    i: number;
    p: string;
    ino: string;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  }[];
}

// The header of one record. `size` is the bytes that follow; `changed`: the
// file differs from the listing (it grew, or its times moved), so the
// office keeps no times for it. `left`: the file is not sent, and why.
export interface SpaceFileHeader {
  i: number;
  size: number;
  changed?: boolean;
  left?: "gone" | "swapped" | "shrunk" | "not-a-file";
}

type Write = (chunk: Uint8Array) => void | Promise<void>;

function root(input: { agentRoot?: unknown }): string {
  const value = input?.agentRoot;
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value
  )
    throw new Error("the backup needs the agent space as an absolute path");
  return value;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
}

function entryOf(rel: string, st: BigIntStats): SpaceEntry {
  return {
    p: rel,
    k: st.isDirectory()
      ? "d"
      : st.isFile()
        ? "f"
        : st.isSymbolicLink()
          ? "l"
          : "x",
    mode: Number(st.mode & 0o7777n),
    size: Number(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    ino: String(st.ino),
  };
}

export async function listSpace(
  input: { agentRoot: string },
  write: Write,
): Promise<void> {
  const top = root(input);
  const topStats = lstatOrNull(top);
  if (topStats?.isDirectory()) {
    const dev = topStats.dev;
    const stack = [""];
    while (stack.length > 0) {
      const dirRel = stack.pop()!;
      let names: string[];
      try {
        names = readdirSync(join(top, dirRel));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const rel = dirRel ? `${dirRel}/${name}` : name;
        if (memberSpaceExcluded(rel)) continue;
        const st = lstatOrNull(join(top, rel));
        if (!st) continue;
        const entry = entryOf(rel, st);
        if (entry.k === "d") {
          // Another file system is not their space's: left out whole.
          if (st.dev !== dev) continue;
          stack.push(rel);
        } else if (entry.k === "l") {
          try {
            entry.target = readlinkSync(join(top, rel));
          } catch {
            continue;
          }
        } else if (entry.k === "x") {
          entry.what = st.isSocket()
            ? "socket"
            : st.isFIFO()
              ? "fifo"
              : "device";
        }
        await write(Buffer.from(`${JSON.stringify(entry)}\n`));
      }
    }
  }
  await write(Buffer.from(`${JSON.stringify({ end: true })}\n`));
}

function header(value: SpaceFileHeader): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([length, json]);
}

export async function sendSpaceFiles(
  input: SpaceFilesInput,
  write: Write,
): Promise<void> {
  const top = root(input);
  const buffer = Buffer.alloc(1024 * 1024);
  for (const file of input.files ?? []) {
    const rel = file.p;
    if (
      typeof rel !== "string" ||
      rel === "" ||
      isAbsolute(rel) ||
      normalize(rel) !== rel ||
      rel.split("/").some((part) => part === ".." || part === ".") ||
      memberSpaceExcluded(rel)
    )
      throw new Error("the backup asked for a path outside the agent space");
    let fd: number;
    try {
      fd = openSync(
        join(top, rel),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      await write(header({ i: file.i, size: 0, left: "gone" }));
      continue;
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) {
        await write(header({ i: file.i, size: 0, left: "not-a-file" }));
        continue;
      }
      if (String(st.ino) !== file.ino) {
        await write(header({ i: file.i, size: 0, left: "swapped" }));
        continue;
      }
      if (Number(st.size) < file.size) {
        await write(header({ i: file.i, size: 0, left: "shrunk" }));
        continue;
      }
      // Never more than the size listed: the office counted only that.
      const changed =
        Number(st.size) !== file.size ||
        String(st.mtimeNs) !== file.mtimeNs ||
        String(st.ctimeNs) !== file.ctimeNs;
      await write(
        header({ i: file.i, size: file.size, ...(changed ? { changed } : {}) }),
      );
      let left = file.size;
      while (left > 0) {
        const n = readSync(fd, buffer, 0, Math.min(left, buffer.length), null);
        if (n === 0) throw new Error(`${rel} became shorter while it was read`);
        await write(Buffer.from(buffer.subarray(0, n)));
        left -= n;
      }
    } finally {
      closeSync(fd);
    }
  }
  await write(Buffer.alloc(4));
}
