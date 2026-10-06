// The trusted checks of split mode (internal-docs/os-user-split-design.md,
// section 2.4). The server makes them itself, from ownership, mode bits and
// POSIX ACLs, before it trusts the split. Nothing here asks the agent runner:
// an agent can impersonate the runner, so the runner's word proves nothing.
//
// Each failure names its check. The ids are stable; the rig asserts on them.

import { lstatSync, readdirSync, readlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, sep } from "path";
import {
  ACL_GROUP,
  ACL_GROUP_OBJ,
  ACL_MASK,
  ACL_OTHER,
  ACL_USER,
  readAcl,
  type AclEntry,
} from "./acl.ts";

export type CheckId =
  | "agent-user"
  | "agent-not-root"
  | "agent-not-server"
  | "server-group-private"
  | "missing"
  | "acl-unreadable"
  | "private-owner"
  | "private-agent-write"
  | "state-root-closed"
  | "share-owner"
  | "share-group"
  | "share-setgid"
  | "share-agent-write"
  | "share-entry-type";

export interface CheckFailure {
  check: CheckId;
  path?: string;
  detail: string;
}

export interface FileFacts {
  uid: number;
  gid: number;
  mode: number;
  kind: "file" | "dir" | "symlink" | "socket" | "other";
}

// The file system as the checks see it. Tests inject a table.
export interface FsProbe {
  lstat(path: string): FileFacts;
  readlink(path: string): string;
  readdir(path: string): string[];
  acl(path: string, kind: "access" | "default"): AclEntry[] | null;
}

export interface AgentIdentity {
  uid: number;
  gid: number;
  groups: number[];
}

export interface TrustedCheckInput {
  serverUid: number;
  serverGid: number;
  agent: AgentIdentity;
  stateRoot: string;
  shareRoot: string;
  codeRoot: string;
  // How deep the code walk goes below codeRoot. The server uses 2 at start;
  // the full check uses Infinity.
  codeDepth: number;
  fs?: FsProbe;
}

const S_ISGID = 0o2000;
const WRITE = 2;
// The one socket the share may hold, relative to SHARE_ROOT.
const SHARE_SOCKET = join("authority", "authority.sock");
// The kernel's limit on links followed in one resolution (ELOOP).
const MAX_LINKS = 40;

export const realFs: FsProbe = {
  lstat(path) {
    const st = lstatSync(path);
    const kind = st.isSymbolicLink()
      ? "symlink"
      : st.isDirectory()
        ? "dir"
        : st.isFile()
          ? "file"
          : st.isSocket()
            ? "socket"
            : "other";
    return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, kind };
  },
  readlink: (path) => readlinkSync(path),
  readdir: (path) => readdirSync(path),
  acl: readAcl,
};

// The permission bits (r=4, w=2, x=1) the agent has on an entry, by the POSIX.1e
// access check: owner, then a named-user entry, then the union of every
// matching group entry, then other. The mask limits named users and groups.
export function agentAccess(
  facts: Pick<FileFacts, "uid" | "gid" | "mode">,
  acl: AclEntry[] | null,
  agent: AgentIdentity,
): number {
  const groups = new Set([agent.gid, ...agent.groups]);
  if (facts.uid === agent.uid) return (facts.mode >> 6) & 7;
  if (!acl || acl.length === 0) {
    if (groups.has(facts.gid)) return (facts.mode >> 3) & 7;
    return facts.mode & 7;
  }
  const mask = acl.find((entry) => entry.tag === ACL_MASK)?.perm ?? 7;
  const named = acl.find(
    (entry) => entry.tag === ACL_USER && entry.id === agent.uid,
  );
  if (named) return named.perm & mask;
  let matched = false;
  let bits = 0;
  for (const entry of acl) {
    if (
      (entry.tag === ACL_GROUP_OBJ && groups.has(facts.gid)) ||
      (entry.tag === ACL_GROUP && groups.has(entry.id))
    ) {
      matched = true;
      bits |= entry.perm;
    }
  }
  if (matched) return bits & mask;
  return acl.find((entry) => entry.tag === ACL_OTHER)?.perm ?? 0;
}

export function runTrustedChecks(input: TrustedCheckInput): CheckFailure[] {
  const fs = input.fs ?? realFs;
  const { agent, serverUid } = input;
  const failures: CheckFailure[] = [];
  const fail = (check: CheckId, detail: string, path?: string) =>
    failures.push({ check, path, detail });

  if (agent.uid === 0) fail("agent-not-root", "the agent user is root");
  if (agent.uid === serverUid)
    fail("agent-not-server", "the agent user is the server user");
  if (agent.gid === input.serverGid || agent.groups.includes(input.serverGid))
    fail(
      "server-group-private",
      "the agent user is in the server user's primary group",
    );
  if (failures.length > 0) return failures;

  const facts = (path: string): FileFacts | null => {
    try {
      return fs.lstat(path);
    } catch (error) {
      fail("missing", (error as Error).message, path);
      return null;
    }
  };
  const acl = (path: string, kind: "access" | "default") => {
    try {
      return { ok: true as const, entries: fs.acl(path, kind) };
    } catch (error) {
      fail("acl-unreadable", (error as Error).message, path);
      return { ok: false as const, entries: null };
    }
  };
  // Write the agent gets on the entry, or on a new entry a directory's
  // default ACL would create (as the entry's owner and group).
  const agentWrites = (path: string, entry: FileFacts): boolean => {
    const access = acl(path, "access");
    if (!access.ok) return true;
    if (agentAccess(entry, access.entries, agent) & WRITE) return true;
    if (entry.kind !== "dir") return false;
    const defaults = acl(path, "default");
    if (!defaults.ok) return true;
    return (
      defaults.entries !== null &&
      (agentAccess(entry, defaults.entries, agent) & WRITE) !== 0
    );
  };

  // Private: owned by root or the server user, no agent write. A path is
  // resolved the way the kernel resolves it: every directory on the way and
  // every link it follows is a private entry, and so is everything on the way
  // to each link's target.
  const checked = new Set<string>();
  const checkEntry = (path: string, entry: FileFacts): void => {
    if (checked.has(path)) return;
    checked.add(path);
    if (entry.uid !== 0 && entry.uid !== serverUid)
      fail("private-owner", `owned by uid ${entry.uid}`, path);
    // A link's own mode bits mean nothing: its directory decides who can
    // replace it.
    if (entry.kind !== "symlink" && agentWrites(path, entry))
      fail("private-agent-write", "the agent user can write it", path);
  };
  const resolved = new Map<string, string | null>();
  // The real path, or null when it cannot be resolved (the failure is named).
  // Components are taken one at a time from a queue; a link's target goes to
  // the front of the queue as raw components. Thus `..` always applies to the
  // real directory reached so far, after the link before it is resolved,
  // as in the kernel.
  const resolvePrivate = (path: string): string | null => {
    const known = resolved.get(path);
    if (known !== undefined) return known;
    const done = (real: string | null) => {
      resolved.set(path, real);
      return real;
    };
    const root = facts(sep);
    if (!root) return done(null);
    checkEntry(sep, root);
    let at: string = sep;
    let links = 0;
    const pending = path.split(sep).filter(Boolean);
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === ".") continue;
      if (part === "..") {
        at = dirname(at);
        continue;
      }
      const next = join(at, part);
      const entry = facts(next);
      if (!entry) return done(null);
      checkEntry(next, entry);
      if (entry.kind !== "symlink") {
        at = next;
        continue;
      }
      if (++links > MAX_LINKS) {
        fail("missing", "too many levels of symbolic links", next);
        return done(null);
      }
      let target: string;
      try {
        target = fs.readlink(next);
      } catch (error) {
        fail("missing", (error as Error).message, next);
        return done(null);
      }
      if (isAbsolute(target)) at = sep;
      pending.unshift(...target.split(sep).filter(Boolean));
    }
    return done(at);
  };
  // A private tree: the path, and below it down to `remaining` levels. A
  // linked directory is walked at its target. `visited` holds the most
  // levels each real directory was walked with, which also stops cycles.
  const walkPrivate = (
    path: string,
    remaining: number,
    visited: Map<string, number>,
  ): void => {
    const real = resolvePrivate(path);
    if (real === null || remaining <= 0) return;
    if ((visited.get(real) ?? -1) >= remaining) return;
    const entry = facts(real);
    if (!entry || entry.kind !== "dir") return;
    visited.set(real, remaining);
    let names: string[];
    try {
      names = fs.readdir(real);
    } catch (error) {
      fail("missing", (error as Error).message, real);
      return;
    }
    for (const name of names)
      walkPrivate(join(real, name), remaining - 1, visited);
  };

  // State root: private, and closed to the agent user entirely.
  const stateReal = resolvePrivate(input.stateRoot);
  const stateFacts = stateReal ? facts(stateReal) : null;
  if (stateReal && stateFacts) {
    const access = acl(stateReal, "access");
    if (access.ok && agentAccess(stateFacts, access.entries, agent) !== 0)
      fail(
        "state-root-closed",
        "the agent user can read, write or search it",
        stateReal,
      );
  }

  // Code: its ancestors and the tree down to codeDepth.
  walkPrivate(input.codeRoot, input.codeDepth, new Map());

  // Share: its ancestors are private; everything in it belongs to the server
  // user and the agent group, with no agent write.
  resolvePrivate(dirname(input.shareRoot));
  const shareLinks = new Map<string, number>();
  const walkShare = (path: string): void => {
    const entry = facts(path);
    if (!entry) return;
    const rel = relative(input.shareRoot, path);
    if (entry.uid !== serverUid)
      fail("share-owner", `owned by uid ${entry.uid}`, path);
    if (entry.gid !== agent.gid)
      fail("share-group", `group ${entry.gid}, not the agent group`, path);
    if (entry.kind === "socket" && rel === SHARE_SOCKET) {
      if (entry.mode & 0o007)
        fail("share-agent-write", "other users can reach the socket", path);
      return;
    }
    // A link is judged as a private path: everything on the way to its
    // target, and the target's tree.
    if (entry.kind === "symlink") {
      walkPrivate(path, Infinity, shareLinks);
      return;
    }
    if (entry.kind !== "dir" && entry.kind !== "file") {
      fail("share-entry-type", `a ${entry.kind} is not allowed here`, path);
      return;
    }
    if (agentWrites(path, entry))
      fail("share-agent-write", "the agent user can write it", path);
    if (entry.kind !== "dir") return;
    if (!(entry.mode & S_ISGID))
      fail("share-setgid", "the directory has no setgid bit", path);
    let names: string[];
    try {
      names = fs.readdir(path);
    } catch (error) {
      fail("missing", (error as Error).message, path);
      return;
    }
    for (const name of names) walkShare(join(path, name));
  };
  walkShare(input.shareRoot);

  return failures;
}
