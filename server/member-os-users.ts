// The record of which members run their agents as their own OS user
// (internal-docs/member-os-user-design.md). STATE_ROOT/member-os-users.json,
// { <userId>: { name, uid, moving? } }, owned by this module and never by users.json:
// an entry survives a removed member and a users.json that fails to parse, so
// no failure there moves an isolated member's agents to the office user.
//
// Fail closed: a file that exists but does not parse puts every user id on
// the not-ready host ("broken"), and so does a malformed entry for its user.
// No file: no member is isolated, and nothing changes.

import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";

export const MEMBER_OS_USERS_FILE = "member-os-users.json";

export interface MemberOsUser {
  // The OS user name: /^[a-z_][a-z0-9_-]{0,31}$/.
  name: string;
  // Its uid: a safe integer above 0.
  uid: number;
}

export type MemberOsUserState =
  // The member's agents run as the office user.
  | { kind: "none" }
  // unfinished: an enable's go-on began moving their files and has not
  // finished (the office stopped during it). Their agents stay not ready
  // until enable runs again.
  | { kind: "isolated"; osUser: MemberOsUser; unfinished?: true }
  // A malformed entry, or a file that does not parse: the not-ready host.
  | { kind: "broken"; reason: string };

export function memberOsUsersPath(): string {
  return join(STATE_ROOT, MEMBER_OS_USERS_FILE);
}

export const OS_USER_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const NAME = OS_USER_NAME_PATTERN;

function validOsUser(value: unknown): value is MemberOsUser {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const { name, uid } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    typeof uid === "number" &&
    Number.isSafeInteger(uid) &&
    uid > 0
  );
}

// The file as read: null when there is none, "broken" when it does not
// parse to an object, else the raw entries.
type Loaded =
  | { kind: "absent" }
  | { kind: "broken"; reason: string }
  | { kind: "ok"; entries: Record<string, unknown> };

let cache: Loaded | null = null;

function load(): Loaded {
  if (cache) return cache;
  cache = readRecord(memberOsUsersPath());
  if (cache.kind === "broken")
    console.error(
      `[member-os-users] ${cache.reason}; isolated members stay stopped`,
    );
  return cache;
}

// The file at `path` as read, with no cache.
function readRecord(path: string): Loaded {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "broken", reason: `cannot read ${path}: ${code}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const loaded: Loaded =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { kind: "ok", entries: parsed as Record<string, unknown> }
      : { kind: "broken", reason: `${path} is not a JSON object` };
  return loaded;
}

function stateIn(
  loaded: Loaded,
  userId: string | null | undefined,
): MemberOsUserState {
  if (!userId) return { kind: "none" };
  if (loaded.kind === "absent") return { kind: "none" };
  if (loaded.kind === "broken")
    return { kind: "broken", reason: loaded.reason };
  if (!Object.hasOwn(loaded.entries, userId)) return { kind: "none" };
  const entry = loaded.entries[userId];
  if (!validOsUser(entry))
    return {
      kind: "broken",
      reason: `the OS user entry of ${userId} is malformed`,
    };
  return {
    kind: "isolated",
    osUser: { name: entry.name, uid: entry.uid },
    ...((entry as { moving?: unknown }).moving === true
      ? { unfinished: true as const }
      : {}),
  };
}

// The state of `userId`. Null or undefined: "none" (an agent with no manager).
export function memberOsUserState(
  userId: string | null | undefined,
): MemberOsUserState {
  return stateIn(load(), userId);
}

// memberOsUserState over the record of another state root, read once now
// (the host rescue command, scripts/rescue.ts).
export function memberOsUserStateAt(
  stateRoot: string,
): (userId: string | null | undefined) => MemberOsUserState {
  const loaded = readRecord(join(stateRoot, MEMBER_OS_USERS_FILE));
  return (userId) => stateIn(loaded, userId);
}

// True when the member's agents must not run as the office user: an entry, a
// malformed entry, or a broken file.
export function hasMemberOsUser(userId: string | null | undefined): boolean {
  return memberOsUserState(userId).kind !== "none";
}

// The host an agent of `userId` runs on, as a name: "office" for the office
// user, `member:<id>` for a member with an OS user (also not ready or
// malformed: the agent never falls back to the office user). While the file
// is broken every member with an id is `member:<id>`, so every manager change
// between two members is refused until the file is repaired.
export function agentHostIdentity(userId: string | null | undefined): string {
  return hasMemberOsUser(userId) ? `member:${userId}` : "office";
}

// True when agents of `a` and of `b` run as the same OS user. An agent never
// gets a manager on another host: the move is task abdb452b.
export function sameAgentHost(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return agentHostIdentity(a) === agentHostIdentity(b);
}

// The last guard in the writers of an agent's manager: each caller checks
// sameAgentHost first and refuses, so this throws only on a path that skips
// that check.
export function assertSameAgentHost(
  from: string | null | undefined,
  to: string | null | undefined,
): void {
  if (!sameAgentHost(from, to))
    throw new Error(
      `an agent of ${agentHostIdentity(from)} cannot get a manager on ${agentHostIdentity(to)}`,
    );
}

// The user ids with an entry (valid or not).
// True when any member may have an OS user: an entry, or a broken file
// (which makes every member's agents not ready, hasMemberOsUser).
export function anyMemberOsUser(): boolean {
  const loaded = load();
  if (loaded.kind === "absent") return false;
  return loaded.kind === "broken" || Object.keys(loaded.entries).length > 0;
}

export function memberOsUserIds(): string[] {
  const loaded = load();
  return loaded.kind === "ok" ? Object.keys(loaded.entries) : [];
}

function writeEntries(entries: Record<string, unknown>): void {
  const path = memberOsUsersPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
  cache = { kind: "ok", entries };
}

// A file that does not parse is never rewritten: a rewrite would drop the
// other members' entries.
function writableEntries(): Record<string, unknown> {
  const loaded = load();
  if (loaded.kind === "broken")
    throw new Error(`${loaded.reason}; fix or remove it first`);
  return loaded.kind === "ok" ? { ...loaded.entries } : {};
}

// Writes the entry (the admin.sock enable flow of slice 1b calls it). The
// uid's tie (memberOsUidTies) is written first, so a crash between the two
// leaves a tie without an entry, never the reverse. `moving`: go-on starts
// to move the member's files (MemberOsUserState unfinished).
export function recordMemberOsUser(
  userId: string,
  osUser: MemberOsUser,
  opts: { moving?: boolean } = {},
): void {
  if (!userId) throw new Error("a member OS user needs a user id");
  if (!validOsUser(osUser))
    throw new Error("an OS user needs a lowercase name and a uid above 0");
  const entries = writableEntries();
  writeTie(osUser.uid, userId);
  entries[userId] = {
    name: osUser.name,
    uid: osUser.uid,
    ...(opts.moving ? { moving: true } : {}),
  };
  writeEntries(entries);
}

// Removes the entry (disable, slice 1b).
export function forgetMemberOsUser(userId: string): void {
  const entries = writableEntries();
  if (!Object.hasOwn(entries, userId)) return;
  delete entries[userId];
  writeEntries(entries);
}

// The tie of each member OS user's uid to its member, for the secret proxy
// (internal-docs/member-os-user-design.md, slice 2d-ii):
// STATE_ROOT/member-os-uid-ties.json, { "<uid>": "<userId>" }. A tie
// outlives its entry: disable removes the entry while processes of the uid
// may still run with the proxy password in their env, and the tie keeps them
// to their member's secrets. A record of the same uid for another member
// replaces it.
export const MEMBER_OS_UID_TIES_FILE = "member-os-uid-ties.json";

export interface MemberUidTie {
  uid: number;
  userId: string;
}

function tiesPath(): string {
  return join(STATE_ROOT, MEMBER_OS_UID_TIES_FILE);
}

function readTies(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(tiesPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${tiesPath()} is not a JSON object`);
  const ties: Record<string, string> = {};
  for (const [uid, userId] of Object.entries(parsed))
    if (/^[1-9]\d*$/.test(uid) && typeof userId === "string" && userId)
      ties[uid] = userId;
  return ties;
}

// A file that cannot be read is not rewritten: the write throws, and so
// does the enable that called it.
function writeTie(uid: number, userId: string): void {
  const ties = readTies();
  if (ties[String(uid)] === userId) return;
  ties[String(uid)] = userId;
  const path = tiesPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ties, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

// Every uid tie: the tie file, and each valid entry of the record (an entry
// wins for its uid). A tie file that cannot be read is logged, and the
// record's entries still count.
export function memberOsUidTies(): MemberUidTie[] {
  const byUid = new Map<number, string>();
  try {
    for (const [uid, userId] of Object.entries(readTies()))
      byUid.set(Number(uid), userId);
  } catch (error) {
    console.error(
      `[member-os-users] the uid ties: ${(error as Error).message}`,
    );
  }
  const loaded = load();
  if (loaded.kind === "ok")
    for (const [userId, entry] of Object.entries(loaded.entries))
      if (validOsUser(entry)) byUid.set(entry.uid, userId);
  return [...byUid]
    .sort(([a], [b]) => a - b)
    .map(([uid, userId]) => ({ uid, userId }));
}

// Tests: forget the cached file, so the next read loads it from disk.
export function reloadMemberOsUsers(): void {
  cache = null;
}

// The members with their own OS user, for an office move's preflight and
// lock (task 78733adf, slice 3), read from `stateRoot` now, with no cache.
// Every entry counts, valid or not. A member's name comes from `nameOf`, or
// is the id when it gives null; the names are sorted. No file: no names.
// A file that cannot be read or parsed: broken.
export function memberOsUsersForMove(
  stateRoot: string,
  nameOf: (userId: string) => string | null,
): { names: string[] } | { broken: true } {
  const loaded = readRecord(join(stateRoot, MEMBER_OS_USERS_FILE));
  if (loaded.kind === "absent") return { names: [] };
  if (loaded.kind === "broken") return { broken: true };
  return {
    names: Object.keys(loaded.entries)
      .map((id) => nameOf(id) ?? id)
      .sort(),
  };
}

// The members with their own OS user as an office move's check reads them
// (task 78733adf, slice 5c-1), from `stateRoot` now, with no cache. A
// malformed entry has no OS user (the check blocks it); `moving` is an
// enable that did not finish; `movedIn` a member who came with a move and
// waits for the enable command on this machine (slice 5c-2).
export function memberOsUserRecordsForMove(
  stateRoot: string,
  nameOf: (userId: string) => string | null,
):
  | { broken: true }
  | {
      members: {
        userId: string;
        name: string | null;
        osUser: MemberOsUser | null;
        unfinished: boolean;
        movedIn: boolean;
      }[];
    } {
  const loaded = readRecord(join(stateRoot, MEMBER_OS_USERS_FILE));
  if (loaded.kind === "absent") return { members: [] };
  if (loaded.kind === "broken") return { broken: true };
  return {
    members: Object.entries(loaded.entries).map(([userId, entry]) => {
      const raw = (entry ?? {}) as { moving?: unknown; movedIn?: unknown };
      return {
        userId,
        name: nameOf(userId),
        osUser: validOsUser(entry)
          ? { name: entry.name, uid: entry.uid }
          : null,
        unfinished: raw.moving === true,
        movedIn: raw.movedIn !== undefined && raw.movedIn !== false,
      };
    }),
  };
}
