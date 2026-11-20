// The record of which members run their agents as their own OS user
// (internal-docs/member-os-user-design.md). STATE_ROOT/member-os-users.json,
// { <userId>: { name, uid, moving?, movedIn?, adopted?, rootCapable? } },
// owned by this module and never by users.json:
// an entry survives a removed member and a users.json that fails to parse, so
// no failure there moves an isolated member's agents to the office user.
//
// Fail closed: a file that exists but does not parse puts every user id on
// the not-ready host ("broken"), and so does a malformed entry for its user.
// No file: no member is isolated, and nothing changes.

import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { OS_USER_NAME_PATTERN } from "../shared/contract-shapes.ts";

export const MEMBER_OS_USERS_FILE = "member-os-users.json";

export interface MemberOsUser {
  // The OS user name: /^[a-z_][a-z0-9_-]{0,31}$/.
  name: string;
  // Its uid: a safe integer above 0.
  uid: number;
}

// Task e15a82e7: how the root command got the OS user. adopted: a person's
// existing account (enable --existing-user), never made or deleted by the
// command. rootCapable: an adopted user that can become root; the connect
// then skips the privileged-group check, and the page says the member is not
// separated from the office. rootCapable never stands without adopted.
export interface MemberOsUserOrigin {
  adopted?: true;
  rootCapable?: true;
}

export type MemberOsUserState =
  // The member's agents run as the office user.
  | { kind: "none" }
  // unfinished: an enable's go-on began moving their files and has not
  // finished (the office stopped during it). Their agents stay not ready
  // until enable runs again.
  // movedIn (task 78733adf, slice 5c-2): she came with an office move and
  // her home waits in <state>/move-members/<userId>/home until the enable
  // command places it; `home` is her home on the old machine.
  | ({
      kind: "isolated";
      osUser: MemberOsUser;
      unfinished?: true;
      movedIn?: { home: string };
    } & MemberOsUserOrigin)
  // A malformed entry, or a file that does not parse: the not-ready host.
  | { kind: "broken"; reason: string };

export function memberOsUsersPath(): string {
  return join(STATE_ROOT, MEMBER_OS_USERS_FILE);
}

export { OS_USER_NAME_PATTERN };
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
    ...movedInOf(entry),
    ...originOf(entry),
  };
}

// Task e15a82e7: `adopted` and `rootCapable` of an entry. rootCapable never
// stands without adopted, whatever the file holds.
function originOf(entry: unknown): MemberOsUserOrigin {
  const { adopted, rootCapable } = entry as {
    adopted?: unknown;
    rootCapable?: unknown;
  };
  if (adopted !== true) return {};
  return rootCapable === true
    ? { adopted: true, rootCapable: true }
    : { adopted: true };
}

// Slice 5c-2: `movedIn: {home}` of an entry, when it is one.
function movedInOf(entry: unknown): { movedIn?: { home: string } } {
  const v = (entry as { movedIn?: unknown }).movedIn;
  if (typeof v !== "object" || v === null) return {};
  const home = (v as { home?: unknown }).home;
  return { movedIn: { home: typeof home === "string" ? home : "" } };
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

// True when agents of `a` and of `b` run as the same OS user. A manager
// change between hosts moves the agent (agent-host-move.ts).
export function sameAgentHost(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return agentHostIdentity(a) === agentHostIdentity(b);
}

// The last guard in the writers of an agent's manager: each caller checks
// sameAgentHost first and refuses or moves the agent, so this throws only on
// a path that skips that check (a host move's one write is let through).
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
  // Slice 5c-2: kept until her moved home is placed.
  opts: {
    moving?: boolean;
    movedIn?: { home: string };
  } & MemberOsUserOrigin = {},
): void {
  if (!userId) throw new Error("a member OS user needs a user id");
  if (!validOsUser(osUser))
    throw new Error("an OS user needs a lowercase name and a uid above 0");
  const entries = writableEntries();
  writeTie(osUser.uid, userId, entries);
  entries[userId] = {
    name: osUser.name,
    uid: osUser.uid,
    ...(opts.moving ? { moving: true } : {}),
    ...(opts.movedIn ? { movedIn: { home: opts.movedIn.home } } : {}),
    ...(opts.adopted ? { adopted: true } : {}),
    ...(opts.adopted && opts.rootCapable ? { rootCapable: true } : {}),
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
// STATE_ROOT/member-os-uid-ties.json, { "<uid>": "<userId>" | ["<userId>", ...] }
// (task 12c796b2: several members may run as one OS user; a file of the
// single-id form still reads). A tie outlives its entry: disable removes the
// entry while processes of the uid may still run with the proxy password in
// their env, and the tie keeps them to their members' secrets. A record of
// the uid writes its tie again from the entries that name the uid now plus
// the new member, so a uid that comes back for another member drops the
// members who left it.
export const MEMBER_OS_UID_TIES_FILE = "member-os-uid-ties.json";

export interface MemberUidTie {
  uid: number;
  userId: string;
}

function tiesPath(): string {
  return join(STATE_ROOT, MEMBER_OS_UID_TIES_FILE);
}

function readTies(): Record<string, string[]> {
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
  const ties: Record<string, string[]> = {};
  for (const [uid, value] of Object.entries(parsed)) {
    if (!/^[1-9]\d*$/.test(uid)) continue;
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    if (ids.length > 0) ties[uid] = [...new Set(ids)];
  }
  return ties;
}

// The members whose valid entry (not moved in) names `uid`.
function entryMembersOf(
  entries: Record<string, unknown>,
  uid: number,
): string[] {
  return Object.entries(entries)
    .filter(
      ([, entry]) =>
        validOsUser(entry) && entry.uid === uid && !movedInOf(entry).movedIn,
    )
    .map(([userId]) => userId);
}

// A file that cannot be read is not rewritten: the write throws, and so
// does the enable that called it.
function writeTie(
  uid: number,
  userId: string,
  entries: Record<string, unknown>,
): void {
  const ties = readTies();
  const next = [...new Set([...entryMembersOf(entries, uid), userId])].sort();
  const before = ties[String(uid)] ?? [];
  if (before.length === next.length && before.every((id, i) => id === next[i]))
    return;
  ties[String(uid)] = next;
  const path = tiesPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ties, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

// Every uid tie, one row per (uid, member): the tie file, and the valid
// entries of the record (the entries that name a uid win for it). A tie file
// that cannot be read is logged, and the record's entries still count.
export function memberOsUidTies(): MemberUidTie[] {
  const byUid = new Map<number, string[]>();
  try {
    for (const [uid, userIds] of Object.entries(readTies()))
      byUid.set(Number(uid), userIds);
  } catch (error) {
    console.error(
      `[member-os-users] the uid ties: ${(error as Error).message}`,
    );
  }
  const loaded = load();
  if (loaded.kind === "ok") {
    const fromEntries = new Map<number, string[]>();
    for (const [userId, entry] of Object.entries(loaded.entries))
      // Slice 5c-2: a moved-in entry's uid is the old box's; on this box it
      // can be anyone's, so it ties nothing.
      if (validOsUser(entry) && !movedInOf(entry).movedIn)
        fromEntries.set(entry.uid, [
          ...(fromEntries.get(entry.uid) ?? []),
          userId,
        ]);
    for (const [uid, userIds] of fromEntries) byUid.set(uid, userIds);
  }
  return [...byUid]
    .sort(([a], [b]) => a - b)
    .flatMap(([uid, userIds]) =>
      [...userIds].sort().map((userId) => ({ uid, userId })),
    );
}

// The other members whose record names the OS user `name` (task 12c796b2:
// several members may run as one OS user), valid entries only, moved-in
// ones excluded (their name is the old box's). Sorted by id.
export function membersOnOsUser(name: string, except?: string): string[] {
  const loaded = load();
  if (loaded.kind !== "ok") return [];
  return Object.entries(loaded.entries)
    .filter(
      ([userId, entry]) =>
        userId !== except &&
        validOsUser(entry) &&
        entry.name === name &&
        !movedInOf(entry).movedIn,
    )
    .map(([userId]) => userId)
    .sort();
}

// True when `a` and `b` are two complete records (isolated, not unfinished,
// not moved in) that name one OS user, by name and uid.
export function sameMemberOsUser(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const sa = memberOsUserState(a);
  const sb = memberOsUserState(b);
  return (
    sa.kind === "isolated" &&
    sb.kind === "isolated" &&
    !sa.unfinished &&
    !sb.unfinished &&
    !sa.movedIn &&
    !sb.movedIn &&
    sa.osUser.name === sb.osUser.name &&
    sa.osUser.uid === sb.osUser.uid
  );
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
// waits for the enable command on this machine (slice 5c-2); `adopted` a
// member who runs as a person's existing OS user (task e15a82e7).
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
        adopted: boolean;
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
        adopted: originOf(entry ?? {}).adopted === true,
      };
    }),
  };
}
