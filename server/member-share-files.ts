// The files a member's agents get in the member's share
// (internal-docs/member-os-user-design.md, slice 2d-ii): uploads and
// screenshots, copied from LOGS_DIR/<agentId>/files/ to
// <share>/files/<agentId>/<name>, because the member cannot read LOGS_DIR.
// The office writes them. The folders get the share's setgid bit and group
// from the share itself (mkdir in a setgid folder), so the files (0640) have
// the member's group and the member can read them.

import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

// The agent ids that may name a folder: no path separator and no dot, so a
// join stays inside files/.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const FOLDER_MODE = 0o750;
const SET_GID = 0o2000;
const FILE_MODE = 0o640;

export function memberShareFilesDir(share: string, agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error(`bad agent id: ${agentId}`);
  return join(share, "files", agentId);
}

// The share of the member whose agent `agentId` is, or null for an office
// agent. Set at boot (isomux-office.ts).
let shareOfAgent: (agentId: string) => string | null = () => null;

export function setAgentShareResolver(
  resolver: ((agentId: string) => string | null) | null,
): void {
  shareOfAgent = resolver ?? (() => null);
}

export function agentShare(agentId: string): string | null {
  return shareOfAgent(agentId);
}

// A folder below the share `share` that the member's group may read: a real
// folder, 0750, with the setgid bit and the share's group. The office is not
// in that group, so it cannot set the bit (Linux clears it at the office's
// chmod): only mkdir in the setgid share gives it. The office's umask may be
// 077 (the container's), and a chmod for the group's read would clear the
// bit, so a missing folder is made by `mkdir` in a child with umask 027; the
// server's own umask is process-wide and stays as it is. A folder without
// the bit is the office's own, so it is removed and made again; a second
// miss throws.
export function ensureMemberShareFolder(share: string, path: string): void {
  const gid = lstatSync(share).gid;
  for (let attempt = 0; ; attempt++) {
    if (!lstatOrNull(path)) makeFolder(path);
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error(`${path} is not a folder`);
    if (
      st.mode & SET_GID &&
      st.gid === gid &&
      (st.mode & 0o777) === FOLDER_MODE
    )
      return;
    if (attempt > 0)
      throw new Error(
        `${path} did not get the share's group and mode 2750 (is the share setgid?)`,
      );
    rmSync(path, { recursive: true, force: true });
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// mkdir with mode 0777 & ~027 = 0750; an existing path is not an error.
function makeFolder(path: string): void {
  const result = spawnSync(
    "/bin/sh",
    ["-c", 'umask 027 && exec mkdir -- "$1"', "sh", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && lstatOrNull(path) === null)
    throw new Error(
      `cannot make ${path}: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
}

// Copies `source` to <share>/files/<agentId>/<name> and returns that path.
// The name is the one in LOGS_DIR, so no new name can collide. A regular
// file there is replaced; anything else throws, and so does every failure.
export function copyToMemberShare(
  share: string,
  agentId: string,
  name: string,
  source: string,
): string {
  if (name !== basename(name) || name === "." || name === "..")
    throw new Error(`bad file name: ${name}`);
  const dir = memberShareFilesDir(share, agentId);
  ensureMemberShareFolder(share, join(share, "files"));
  ensureMemberShareFolder(share, dir);
  const target = join(dir, name);
  let existing;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile())
    throw new Error(`${target} is not a file`);
  if (existing) unlinkSync(target);
  const fd = openSync(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, readFileSync(source));
  } finally {
    closeSync(fd);
  }
  return target;
}

// Removes the copies of one agent, or of every agent of the share (disable,
// a removed member's purge). A missing folder is not an error.
export function removeMemberShareFiles(share: string, agentId?: string): void {
  rmSync(
    agentId === undefined
      ? join(share, "files")
      : memberShareFilesDir(share, agentId),
    { recursive: true, force: true },
  );
}

// The manager of `agentId`, live or killed, or null when unknown. Set at
// boot (isomux-office.ts).
let managerOfAgent: (agentId: string) => string | null = () => null;

export function setAgentManagerResolver(
  resolver: ((agentId: string) => string | null) | null,
): void {
  managerOfAgent = resolver ?? (() => null);
}

// Removes the copies of the agents that `userId` manages, and keeps those of
// other agents (task 12c796b2: other members on the same OS user share the
// share). A folder whose agent is unknown stays.
export function removeMemberShareFilesOf(share: string, userId: string): void {
  let names: string[];
  try {
    names = readdirSync(join(share, "files"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const agentId of names)
    if (AGENT_ID.test(agentId) && managerOfAgent(agentId) === userId)
      removeMemberShareFiles(share, agentId);
}

// Every member share (each member with an OS user). Set at boot.
let memberShares: () => string[] = () => [];

export function setMemberShareLister(lister: (() => string[]) | null): void {
  memberShares = lister ?? (() => []);
}

// An upload that the storage prune deleted from LOGS_DIR: its copy goes
// too. The agent may be killed (no longer in the live map, its files kept
// for a revive), so every member share is tried. A missing copy is not an
// error.
export function removeMemberShareFile(agentId: string, name: string): void {
  if (name !== basename(name) || name === "." || name === "..") return;
  for (const share of memberShares())
    rmSync(join(memberShareFilesDir(share, agentId), name), { force: true });
}
