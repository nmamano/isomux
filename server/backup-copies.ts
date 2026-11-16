// The layout of a folder copy in the backup folder (task 1426371a), kept
// apart from server/backup.ts so the storage pane can read it without loading
// the backup scheduler.
//
//   <backup folder>/isomux-YYYY-MM-DD[-N]/   mode 0700
//     <state root name>/                     the copy of the state root
//     members/<userId>/                      an isolated member's agent space
//                                            (server/member-backup.ts)
//     manifest.jsonl.gz                      one line per entry of the copy
//     backup.json                            the marker, written last
//
// These four are the whole top level. A reader of a copy treats nothing but
// <state root name>/ as office state: members/ and any other entry are not.
//
// Files that did not change since the previous copy are hard links to that
// copy's files, so the copies share disk space. The marker records how many
// bytes this copy added (newBytes) and which copy it linked from.

import { lstatSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export const COPY_PATTERN = /^isomux-(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;
export const COPY_MARKER = "backup.json";
export const COPY_MANIFEST = "manifest.jsonl.gz";

export interface CopyMarker {
  kind: "folder";
  // Tells this copy from a later one that has the same name.
  id: string;
  startedAt: number;
  finishedAt: number;
  // The state root of the office that wrote it.
  office: string;
  // The entries of the copy that are not folders (its state root and each
  // member's space), and their sizes.
  files: number;
  bytes: number;
  // The sizes of the entries this copy wrote: copied files and symlinks.
  newBytes: number;
  // The copy whose files it links to, or null when it links to none.
  linkedFrom: { name: string; id: string } | null;
  // The isolated members whose space this run did not copy (carried from an
  // earlier copy, or skipped: members/<userId>/member.json says which).
  membersSkipped?: string[];
}

function isCopyMarker(value: unknown): value is CopyMarker {
  const m = value as CopyMarker;
  return (
    typeof m === "object" &&
    m !== null &&
    m.kind === "folder" &&
    typeof m.id === "string" &&
    typeof m.startedAt === "number" &&
    typeof m.finishedAt === "number" &&
    typeof m.office === "string" &&
    typeof m.files === "number" &&
    typeof m.bytes === "number" &&
    typeof m.newBytes === "number" &&
    (m.linkedFrom === null ||
      (typeof m.linkedFrom === "object" &&
        typeof m.linkedFrom.name === "string" &&
        typeof m.linkedFrom.id === "string")) &&
    (m.membersSkipped === undefined ||
      (Array.isArray(m.membersSkipped) &&
        m.membersSkipped.every((id) => typeof id === "string")))
  );
}

/** The marker of a published folder copy, or null when `name` is not one. */
export function readCopyMarker(dir: string, name: string): CopyMarker | null {
  if (!COPY_PATTERN.test(name)) return null;
  try {
    const marker: unknown = JSON.parse(
      readFileSync(join(dir, name, COPY_MARKER), "utf8"),
    );
    return isCopyMarker(marker) ? marker : null;
  } catch {
    return null;
  }
}

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

function measureTree(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        bytes += sizeOf(full);
        files++;
      }
    }
  }
  return { bytes, files };
}

// The disk space the backup folder takes, each byte counted once: a folder
// copy counts only the bytes it added (newBytes) while the copy it links from
// is still present, the oldest copy counts whole; everything else in the
// folder is measured file by file. The copies are not walked: there are as
// many entries in each as in the state root. A copy deleted by hand from the
// middle of the chain makes the next one count whole: too many, never too few.
export function backupFolderUsage(dir: string): {
  bytes: number;
  files: number;
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { bytes: 0, files: 0 };
  }
  const markers = new Map<string, CopyMarker>();
  for (const name of names) {
    const marker = readCopyMarker(dir, name);
    if (marker) markers.set(name, marker);
  }
  let bytes = 0;
  let files = 0;
  for (const name of names) {
    const path = join(dir, name);
    const marker = markers.get(name);
    if (!marker) {
      const usage = lstatSync(path, { throwIfNoEntry: false })?.isDirectory()
        ? measureTree(path)
        : { bytes: sizeOf(path), files: 1 };
      bytes += usage.bytes;
      files += usage.files;
      continue;
    }
    const source = marker.linkedFrom;
    const linked =
      source !== null && markers.get(source.name)?.id === source.id;
    bytes +=
      (linked ? marker.newBytes : marker.bytes) +
      sizeOf(join(path, COPY_MANIFEST)) +
      sizeOf(join(path, COPY_MARKER));
    files += marker.files + 2;
  }
  return { bytes, files };
}
