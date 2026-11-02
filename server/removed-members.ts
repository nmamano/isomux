// Removed members (task 321e7b8e). Removing a member takes their record out of
// users.json and keeps it here for REMOVED_MEMBER_RETENTION_MS, so an owner can
// restore them, as a killed agent can be revived. A record here is not a user:
// nothing that reads users.json sees it, so a removed member reaches nothing.
//
// STATE_ROOT/removed-members.json is the index: { [userId]: RemovedMember }.
// STATE_ROOT/removed-members/<userId>/ (0700) holds what is kept beside the
// record: the variables file and its notes (whole), the secrets without their
// values, and the MCP servers with each sign-in reset. Secret values and
// sign-in tokens are deleted at the removal (Nil, 2026-11-02).
//
// The live record wins. A removal writes the archive (files, then the index
// entry) before it deletes anything live, and a restore copies the files back
// and adds the live record before it drops the archive. At boot,
// reconcileRemovedMembers drops an entry whose id is live (an unfinished
// removal, or a finished restore) and a directory that has no entry.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join } from "path";

import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { managedUserEnvNotesPath, managedUserEnvPath } from "./user-env.ts";
import { lowercaseKey } from "../shared/identity.ts";
import type { UserRecord } from "../shared/types.ts";
import type { RemovedMemberWire } from "../shared/contract-shapes.ts";
import type { SecretShape } from "./secret-store.ts";
import type { StoredMcpServer } from "./mcp-server-store.ts";

export const REMOVED_MEMBER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RemovedMember {
  user: UserRecord;
  removedAt: number;
  // The display name of who removed them.
  removedBy: string;
  // The owner who got their agents, schedules and webhooks; null when none did.
  heirId: string | null;
  heirName: string | null;
  // What passed to the heir at the removal. A restore moves back only what the
  // heir still owns.
  passed: {
    agentIds: string[];
    killedAgentIds: string[];
    cronjobIds: string[];
    webhookIds: string[];
  };
}

// The connections kept without their credentials.
export interface ArchivedConnections {
  secrets: SecretShape[];
  mcpServers: StoredMcpServer[];
}

const INDEX_FILE = join(STATE_ROOT, "removed-members.json");
const ARCHIVE_DIR = join(STATE_ROOT, "removed-members");
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;
const CONNECTIONS_FILE = "connections.json";
const ENV_FILE = "user.env";
const NOTES_FILE = "user.notes.json";

function dirOf(userId: string): string {
  if (!SAFE_USER_ID.test(userId)) throw new Error("invalid user id");
  return join(ARCHIVE_DIR, userId);
}

// Read on each call: the index is small and rarely read, and no cache can go
// stale between test boots.
function readIndex(): Record<string, RemovedMember> {
  if (!existsSync(INDEX_FILE)) return {};
  const parsed: unknown = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("removed-members.json could not be read");
  return parsed as Record<string, RemovedMember>;
}

function writeIndex(index: Record<string, RemovedMember>): void {
  atomicWriteFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 0o600);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function copyIfPresent(from: string, to: string): void {
  if (existsSync(from)) {
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  } else rmSync(to, { force: true });
}

// Step one of a removal: the archive directory (connections, then a copy of
// the variables file and its notes), then the index entry. Overwrites an
// earlier draft for the same id, so a retried removal finishes the job.
export function archiveRemovedMember(
  member: RemovedMember,
  connections: ArchivedConnections,
): void {
  const id = member.user.id;
  const dir = dirOf(id);
  ensureDir(ARCHIVE_DIR);
  ensureDir(dir);
  atomicWriteFileSync(
    join(dir, CONNECTIONS_FILE),
    JSON.stringify(connections, null, 2),
    0o600,
  );
  copyIfPresent(managedUserEnvPath(id), join(dir, ENV_FILE));
  copyIfPresent(managedUserEnvNotesPath(id), join(dir, NOTES_FILE));
  const index = readIndex();
  index[id] = member;
  writeIndex(index);
}

// Newest removal first.
export function listRemovedMembers(): RemovedMember[] {
  return Object.values(readIndex()).sort(
    (a, b) => b.removedAt - a.removedAt || a.user.id.localeCompare(b.user.id),
  );
}

export function getRemovedMember(userId: string): RemovedMember | null {
  return Object.hasOwn(readIndex(), userId) ? readIndex()[userId] : null;
}

// True when a removed member has this name (case-insensitive). Their name stays
// reserved until a restore or a delete.
export function isRemovedMemberName(name: string): boolean {
  const key = lowercaseKey(name);
  return listRemovedMembers().some((m) => lowercaseKey(m.user.name) === key);
}

export function readArchivedConnections(userId: string): ArchivedConnections {
  const path = join(dirOf(userId), CONNECTIONS_FILE);
  if (!existsSync(path)) return { secrets: [], mcpServers: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ArchivedConnections;
}

// Restore: copies the variables file and its notes back to their live place.
// The archive stays until dropRemovedMember.
export function restoreArchivedFiles(userId: string): void {
  const dir = dirOf(userId);
  const env = join(dir, ENV_FILE);
  if (!existsSync(env)) return;
  const live = managedUserEnvPath(userId);
  ensureDir(join(live, ".."));
  copyIfPresent(env, live);
  copyIfPresent(join(dir, NOTES_FILE), managedUserEnvNotesPath(userId));
}

// The index entry, then the directory. False when there was no entry.
export function dropRemovedMember(userId: string): boolean {
  const index = readIndex();
  const had = Object.hasOwn(index, userId);
  if (had) {
    delete index[userId];
    writeIndex(index);
  }
  rmSync(dirOf(userId), { recursive: true, force: true });
  return had;
}

// Drops each member removed REMOVED_MEMBER_RETENTION_MS or longer before
// `now`. Returns their ids.
export function purgeExpiredRemovedMembers(now: number): string[] {
  const expired = listRemovedMembers()
    .filter((m) => now - m.removedAt >= REMOVED_MEMBER_RETENTION_MS)
    .map((m) => m.user.id);
  for (const id of expired) dropRemovedMember(id);
  return expired;
}

// Boot: drops each entry whose id is live and each directory with no entry.
export function reconcileRemovedMembers(liveUserIds: Iterable<string>): void {
  const live = new Set(liveUserIds);
  const index = readIndex();
  for (const id of Object.keys(index)) if (live.has(id)) dropRemovedMember(id);
  if (!existsSync(ARCHIVE_DIR)) return;
  const kept = readIndex();
  for (const name of readdirSync(ARCHIVE_DIR))
    if (!Object.hasOwn(kept, name))
      rmSync(join(ARCHIVE_DIR, name), { recursive: true, force: true });
}

export function removedMemberWire(member: RemovedMember): RemovedMemberWire {
  return {
    user: member.user,
    removedAt: member.removedAt,
    expiresAt: member.removedAt + REMOVED_MEMBER_RETENTION_MS,
    removedBy: member.removedBy,
    heirName: member.heirName,
    passed: {
      agents:
        member.passed.agentIds.length + member.passed.killedAgentIds.length,
      schedules: member.passed.cronjobIds.length,
      webhooks: member.passed.webhookIds.length,
    },
  };
}
