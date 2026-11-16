// The new office's side of the members with their own OS user in an office
// move (task 78733adf, slice 5c-2; design: internal-docs/office-move-design.md
// "Members with their own OS user (slice 5c)"). The old office's runner of
// each member sends her home; this office keeps it as office data in
// <state>/move-members/<userId>/home until root runs the enable command
// here, which places it through her new runner (member-home-place.ts).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MoveInMemberHere,
  MoveInPreflight,
} from "../shared/office-move.ts";
import type { MemberUserSupport } from "./member-os-user-view.ts";
import { MOVE_MEMBERS_DIR } from "./office-move.ts";
import { removeMoveTree } from "./office-move-stage.ts";

/** Where the enable command makes the homes of member users in a
 *  container (deploy/isomux-member-user.sh CONTAINER_HOMES). */
export const CONTAINER_MEMBER_HOMES = "/var/data/members/home";

/** The file that names useradd's home base (HOME=). */
export const USERADD_DEFAULTS_FILE = "/etc/default/useradd";

/** One member of the old office, as its preflight lists her. */
export interface MemberToMove {
  userId: string;
  name: string;
  osUser: string;
  /** Her home on the old machine. */
  home: string;
}

/** Why her home cannot land here (E1, D3):
 *  - unsupported: this machine cannot make member users;
 *  - other_home: the enable command makes her home at another path here;
 *  - name_taken: an OS user with her name exists here;
 *  - home_exists: her home's path exists here before the user does. */
export type MemberHereBlock = NonNullable<MoveInMemberHere["block"]>;

export type MemberHere = MoveInMemberHere;

export interface MembersHereDeps {
  support: MemberUserSupport;
  /** passwd's entry of an OS user name here, or null. */
  passwd(name: string): { uid: number; home: string } | null;
  /** Whether something (any kind, a link too) is at the path: lstat. */
  exists(path: string): boolean;
  /** useradd's home base here (useraddHomeBase). */
  homeBase(): string;
}

/** A user id that can name a folder: no separator, not "." or "..". */
export const MOVED_MEMBER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** useradd's home base: HOME= of `text` (the defaults file), else /home. */
export function useraddHomeBase(text: string | null): string {
  let base = "/home";
  for (const line of (text ?? "").split("\n")) {
    const m = /^HOME=(.*)$/.exec(line.trim());
    if (m && m[1].trim().startsWith("/")) base = m[1].trim();
  }
  return base.length > 1 ? base.replace(/\/+$/, "") : base;
}

/** The home base of this box (useradd's defaults file). */
export function readUseraddHomeBase(): string {
  let text: string | null = null;
  try {
    text = readFileSync(USERADD_DEFAULTS_FILE, "utf8");
  } catch {
    // No file: useradd's built-in default.
  }
  return useraddHomeBase(text);
}

/** The home the enable command makes for `osUser` on this machine, or null
 *  when it cannot make member users. */
export function predictedMemberHome(
  osUser: string,
  support: MemberUserSupport,
  homeBase: string,
): string | null {
  if (!support.ok) return null;
  if (support.shape === "container" || support.shape === "docker")
    return `${CONTAINER_MEMBER_HOMES}/${osUser}`;
  return join(homeBase, osUser);
}

/** E1: each member's block here, in the given order. */
export function memberHomesHere(
  members: MemberToMove[],
  deps: MembersHereDeps,
): MemberHere[] {
  return members.map((m) => {
    const base = {
      userId: m.userId,
      name: m.name,
      osUser: m.osUser,
      oldHome: m.home,
    };
    if (!deps.support.ok)
      return {
        ...base,
        home: null,
        block: "unsupported" as const,
        detail: deps.support.reason,
      };
    const home = predictedMemberHome(m.osUser, deps.support, deps.homeBase());
    if (home !== m.home)
      return {
        ...base,
        home,
        block: "other_home" as const,
        detail: `the enable command makes ${home} here, and the old home is ${m.home}`,
      };
    if (deps.passwd(m.osUser))
      return {
        ...base,
        home,
        block: "name_taken" as const,
        detail: `the OS user ${m.osUser} exists here`,
      };
    if (home !== null && deps.exists(home))
      return {
        ...base,
        home,
        block: "home_exists" as const,
        detail: `${home} exists here`,
      };
    return { ...base, home, block: null };
  });
}

/** Where her moved home waits: <stateRoot>/move-members/<userId>/home. */
export function movedHomeDir(stateRoot: string, userId: string): string {
  if (!MOVED_MEMBER_ID.test(userId))
    throw new Error(`${JSON.stringify(userId)} is not a member id`);
  return join(stateRoot, MOVE_MEMBERS_DIR, userId, "home");
}

/** Removes <stateRoot>/move-members/<userId> with what it holds. The stage
 *  keeps her modes (a 0555 folder too): each folder gets u+rwx first, by
 *  fd, never through a link (D4). */
export function removeMovedHome(stateRoot: string, userId: string): void {
  removeMoveTree(dirname(movedHomeDir(stateRoot, userId)));
}

/** Boot: removes each <stateRoot>/move-members/<userId> whose member is not
 *  movedIn (a crash between the record's write and the delete). Returns the
 *  userIds removed. */
export function sweepMovedHomes(
  stateRoot: string,
  isMovedIn: (userId: string) => boolean,
): string[] {
  const dir = join(stateRoot, MOVE_MEMBERS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (MOVED_MEMBER_ID.test(name) && isMovedIn(name)) continue;
    removeMoveTree(join(dir, name));
    removed.push(name);
  }
  return removed;
}

// ---- the move-in (office-move-in.ts) ----

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Slice 5c-2: the old office's members with their own OS user that its
 *  preflight lists as ready to move (an older release lists none). */
export function preflightMembers(
  pf: MoveInPreflight | undefined,
): MemberToMove[] {
  const m = pf?.memberOsUsers;
  if (!isObject(m) || !Array.isArray(m.members)) return [];
  return m.members
    .filter(
      (v): v is MemberToMove =>
        isObject(v) &&
        typeof v.userId === "string" &&
        MOVED_MEMBER_ID.test(v.userId) &&
        typeof v.name === "string" &&
        typeof v.osUser === "string" &&
        typeof v.home === "string",
    )
    .map((v) => ({
      userId: v.userId,
      name: v.name,
      osUser: v.osUser,
      home: v.home,
    }));
}

/** Slice 5c-2: the members of a ready manifest answer, in its order. */
export interface MemberListed {
  userId: string;
  osUser: string;
  home: string;
  totalBytes?: number;
  unreadable?: unknown;
}

export function membersOfSummary(summary: JsonObject): MemberListed[] {
  return Array.isArray(summary.members)
    ? summary.members.filter(
        (m): m is MemberListed =>
          isObject(m) &&
          typeof m.userId === "string" &&
          typeof m.osUser === "string" &&
          typeof m.home === "string",
      )
    : [];
}

export function membersBlockedMessage(blocked: MemberHere[]): string {
  return `The homes of these members cannot land on this machine: ${blocked
    .map((m) => `${m.name} (${m.detail ?? m.block})`)
    .join("; ")}. Fix it, then try again.`;
}
