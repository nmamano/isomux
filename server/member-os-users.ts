// The record of which members run their agents as their own OS user
// (internal-docs/member-os-user-design.md). STATE_ROOT/member-os-users.json,
// { <userId>: { name, uid } }, owned by this module and never by users.json:
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
  | { kind: "isolated"; osUser: MemberOsUser }
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
  const path = memberOsUsersPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    cache =
      code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "broken", reason: `cannot read ${path}: ${code}` };
    return cache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  cache =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { kind: "ok", entries: parsed as Record<string, unknown> }
      : { kind: "broken", reason: `${path} is not a JSON object` };
  if (cache.kind === "broken")
    console.error(
      `[member-os-users] ${cache.reason}; isolated members stay stopped`,
    );
  return cache;
}

// The state of `userId`. Null or undefined: "none" (an agent with no manager).
export function memberOsUserState(
  userId: string | null | undefined,
): MemberOsUserState {
  if (!userId) return { kind: "none" };
  const loaded = load();
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
  return { kind: "isolated", osUser: { name: entry.name, uid: entry.uid } };
}

// True when the member's agents must not run as the office user: an entry, a
// malformed entry, or a broken file.
export function hasMemberOsUser(userId: string | null | undefined): boolean {
  return memberOsUserState(userId).kind !== "none";
}

// The user ids with an entry (valid or not).
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

// Writes the entry (the admin.sock enable flow of slice 1b calls it).
export function recordMemberOsUser(userId: string, osUser: MemberOsUser): void {
  if (!userId) throw new Error("a member OS user needs a user id");
  if (!validOsUser(osUser))
    throw new Error("an OS user needs a lowercase name and a uid above 0");
  const entries = writableEntries();
  entries[userId] = { name: osUser.name, uid: osUser.uid };
  writeEntries(entries);
}

// Removes the entry (disable, slice 1b).
export function forgetMemberOsUser(userId: string): void {
  const entries = writableEntries();
  if (!Object.hasOwn(entries, userId)) return;
  delete entries[userId];
  writeEntries(entries);
}

// Tests: forget the cached file, so the next read loads it from disk.
export function reloadMemberOsUsers(): void {
  cache = null;
}
