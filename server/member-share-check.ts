// The member share check (internal-docs/member-os-user-design.md, section
// 1.1): the server runs code from the share as the member and writes there as
// the office user, so nobody but root and the office user may change it, and
// a second member may not read it.
//
// Member write is decided from the mode bits only: with an extended POSIX
// ACL, the group bits of st_mode are the mask, which caps every named user
// and group entry, so no group or other write in the mode rules out every
// ACL grant too.

import { lstatSync, readdirSync, readlinkSync } from "fs";
import { dirname, join } from "path";

export const RUNTIME_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface ShareEntry {
  type: "file" | "dir" | "symlink" | "other";
  uid: number;
  gid: number;
  // st_mode & 0o7777.
  mode: number;
  // A symlink's target, as written.
  linkTarget?: string;
}

export interface ShareProbe {
  // Null when the path does not exist.
  lstat(path: string): ShareEntry | null;
  readdir(path: string): string[];
}

export const realShareProbe: ShareProbe = {
  lstat(path) {
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const type = st.isFile()
      ? "file"
      : st.isDirectory()
        ? "dir"
        : st.isSymbolicLink()
          ? "symlink"
          : "other";
    return {
      type,
      uid: st.uid,
      gid: st.gid,
      mode: st.mode & 0o7777,
      linkTarget: type === "symlink" ? readlinkSync(path) : undefined,
    };
  },
  readdir: (path) => readdirSync(path),
};

export type ShareVerdict =
  { ok: true } | { ok: false; path: string; reason: string };

export interface ShareCheckInput {
  // /var/lib/isomux-share/<osuser>
  share: string;
  officeUid: number;
  // The member user's primary group: the share's group.
  memberGid: number;
  probe?: ShareProbe;
  // What to walk below the share root. "all" (the default): every entry.
  // "root": only the parent and the share itself, what the server does not
  // make, so a broken runtime does not stop the install that repairs it.
  // { runtime: hash }: the root, runtime/ and runtime/<hash>, the check of
  // an install that is already there.
  scope?: "all" | "root" | { runtime: string };
}

const GROUP_OR_OTHER_WRITE = 0o022;
const SET_ID = 0o6000;

export function checkMemberShare(input: ShareCheckInput): ShareVerdict {
  const probe = input.probe ?? realShareProbe;
  const refuse = (path: string, reason: string): ShareVerdict => ({
    ok: false,
    path,
    reason,
  });

  // The parent: only root may rename or replace a share.
  const parent = dirname(input.share);
  const parentEntry = probe.lstat(parent);
  if (!parentEntry) return refuse(parent, "missing");
  if (parentEntry.type !== "dir") return refuse(parent, "not a folder");
  if (parentEntry.uid !== 0) return refuse(parent, "not owned by root");
  if (parentEntry.mode & GROUP_OR_OTHER_WRITE)
    return refuse(parent, "writable by group or others");

  // The share: the member's group, nothing for others. Its runtime files are
  // 0755/0644, so this folder is what keeps another member out.
  const root = probe.lstat(input.share);
  if (!root) return refuse(input.share, "missing");
  if (root.type !== "dir") return refuse(input.share, "not a folder");
  if (root.gid !== input.memberGid)
    return refuse(input.share, "its group is not the member's group");
  if (root.mode & 0o007) return refuse(input.share, "others have access to it");

  const runtime = join(input.share, "runtime");
  const current = join(runtime, "current");
  const scope = input.scope ?? "all";
  const walk = (
    path: string,
    entry: ShareEntry,
    depth: "entry" | "tree" = "tree",
  ): ShareVerdict => {
    if (entry.uid !== input.officeUid && entry.uid !== 0)
      return refuse(path, "not owned by the office user or root");
    if (entry.type === "symlink") {
      if (path !== current) return refuse(path, "a link");
      const target = entry.linkTarget ?? "";
      if (!RUNTIME_HASH_PATTERN.test(target))
        return refuse(path, "the link does not name a runtime folder");
      if (probe.lstat(join(runtime, target))?.type !== "dir")
        return refuse(path, "the link names a missing runtime folder");
      return { ok: true };
    }
    if (entry.mode & GROUP_OR_OTHER_WRITE)
      return refuse(path, "writable by group or others");
    if (entry.type === "file") {
      if (entry.mode & SET_ID) return refuse(path, "a setuid or setgid file");
      return { ok: true };
    }
    if (entry.type !== "dir") return refuse(path, "not a file or folder");
    if (depth === "entry") return { ok: true };
    for (const name of probe.readdir(path).sort()) {
      const child = join(path, name);
      const childEntry = probe.lstat(child);
      if (!childEntry) continue;
      const verdict = walk(child, childEntry);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  };
  if (scope === "all") return walk(input.share, root);
  const rootVerdict = walk(input.share, root, "entry");
  if (!rootVerdict.ok || scope === "root") return rootVerdict;
  for (const [path, depth] of [
    [runtime, "entry"],
    [join(runtime, scope.runtime), "tree"],
  ] as const) {
    const entry = probe.lstat(path);
    if (!entry) return refuse(path, "missing");
    const verdict = walk(path, entry, depth);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
