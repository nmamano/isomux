// The owner's view of a member's own OS user (Settings > Members,
// internal-docs/member-os-user-design.md 2.1): the state from the records,
// what the root command last did for them, and the command for this office's
// shape. The command holds only the member id, checked against its pattern:
// nothing a member typed (their name) reaches a line an owner runs as root.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname as osHostname, userInfo } from "node:os";
import { promisify } from "node:util";

import type {
  MemberOsUserAttemptWire,
  MemberOsUserMemberWire,
  MemberOsUserWire,
  MemberUserUnsupported,
} from "../shared/contract-shapes.ts";
import type { UserRecord } from "../shared/types.ts";
import { memberHostConnected, memberIsMoving } from "./member-hosts.ts";
import {
  memberOsUserIds,
  memberOsUserState,
  membersOnOsUser,
  OS_USER_NAME_PATTERN,
} from "./member-os-users.ts";
import { getUserById } from "./users.ts";
import { readUpdateConf, type UpdateConfRead } from "./update-conf.ts";

// The root command, as the installer and the image install it
// (deploy/install.sh MEMBER_USER_PATH, deploy/container/Dockerfile).
export const MEMBER_USER_COMMAND_PATH = "/usr/local/sbin/isomux-member-user";
// The container's compose folder (deploy/install.sh CONTAINER_DIR).
const CONTAINER_DIR = "/opt/isomux-container";
const MEMBER_ID = /^[0-9a-f]{8}$/;
// Docker's default hostname: the short container id, which docker exec takes.
const CONTAINER_ID = /^[0-9a-f]{12}$/;
// In the command of a container with another hostname: the owner puts its
// name in its place.
export const CONTAINER_PLACEHOLDER = "CONTAINER";

// Between prepare and go-on the root command makes the user and starts its
// runner: a few seconds. Past this, it stopped.
export const PREPARED_STALE_MS = 10 * 60_000;

// Where the root command runs: the installer's root install (Hosted too),
// the installer's container, or another Docker container. Elsewhere it
// cannot run, and the reason says why.
export type MemberUserSupport =
  | { ok: true; shape: "installer" | "container" }
  | { ok: true; shape: "docker"; container: string | null }
  | { ok: false; reason: MemberUserUnsupported };

export interface MemberUserSupportInput {
  env: { [key: string]: string | undefined };
  exists: (path: string) => boolean;
  platform: string;
  hostname: string;
  conf: UpdateConfRead;
}

export function memberUserSupport(
  input: MemberUserSupportInput = {
    env: process.env,
    exists: existsSync,
    platform: process.platform,
    hostname: osHostname(),
    conf: readUpdateConf(),
  },
): MemberUserSupport {
  const { env, exists, platform, hostname, conf } = input;
  // A read error counts as no file.
  const values = conf.state === "parsed" ? conf.values : null;
  if (platform !== "linux") return { ok: false, reason: "not_linux" };
  // The kubelet sets it in every pod, also with enableServiceLinks: false
  // (kubernetes pkg/kubelet/kubelet_pods.go, getServiceEnvVarMap). The pod
  // runs the image's entrypoint, so it also has the container's supervisor,
  // and it never runs as root (deploy/kubernetes/deployment.yaml).
  if (env.KUBERNETES_SERVICE_HOST) return { ok: false, reason: "kubernetes" };
  if (env.RENDER === "true") return { ok: false, reason: "render" };
  if (env.ISOMUX_APP_SUPERVISOR === "container") {
    if (values?.DEPLOYMENT_KIND === "container")
      return { ok: true, shape: "container" };
    return {
      ok: true,
      shape: "docker",
      container: CONTAINER_ID.test(hostname) ? hostname : null,
    };
  }
  // A from-source run or a user-level install has no system install.
  if (values?.SERVICE_KIND !== "system")
    return { ok: false, reason: "no_system_install" };
  if (!exists(MEMBER_USER_COMMAND_PATH))
    return { ok: false, reason: "no_command" };
  return { ok: true, shape: "installer" };
}

export function memberUserCommands(
  memberId: string,
  support: MemberUserSupport,
): { enable: string; disable: string } | null {
  if (!support.ok || !MEMBER_ID.test(memberId)) return null;
  const line = (verb: "enable" | "disable") => {
    const tail = `${MEMBER_USER_COMMAND_PATH} ${verb} ${memberId}`;
    switch (support.shape) {
      case "container":
        return `cd ${CONTAINER_DIR} && sudo docker compose --env-file office.env exec -u 0 office ${tail}`;
      case "docker":
        return `sudo docker exec -u 0 ${support.container ?? CONTAINER_PLACEHOLDER} ${tail}`;
      case "installer":
        return `sudo ${tail}`;
    }
  };
  return { enable: line("enable"), disable: line("disable") };
}

// Task e15a82e7: the existing OS users an owner can pick for a member.
// Pure: the caller reads passwd (in a child process with a time limit; an
// error or a timeout gives no candidates), /etc/login.defs, the names of the
// root command's .made marks, and the names that members already run as. A
// candidate is a passwd entry with a name that matches the root command's
// pattern, a uid in UID_MIN..UID_MAX (defaults 1000..60000), a login shell
// (not nologin or false) and not the office's user. Task 12c796b2: a user
// that members run as is listed with them (several members may run as one
// OS user), and a user the root command made is listed too (a join, or a
// reopen once its members left). Sorted by name, at most
// MEMBER_USER_CANDIDATES_MAX. The root command applies the same rule.
export const MEMBER_USER_CANDIDATES_MAX = 500;

export interface MemberUserCandidatesInput {
  // getent passwd's output: name:pw:uid:gid:gecos:home:shell lines.
  passwd: string;
  // /etc/login.defs, or "" when it cannot be read.
  loginDefs: string;
  officeOsUser: string | null;
  // The OS users that members run as (member-os-users.json), with them.
  taken: { name: string; members: MemberOsUserMemberWire[] }[];
  // The users with a .made mark of the root command. Listed like any user;
  // kept in the input for the root command's rule.
  made: string[];
}

// UID_MIN and UID_MAX of login.defs, else the defaults (also for a value
// that is not a number). deploy/isomux-member-user.sh login_uid_range reads
// it the same way.
function loginUidRange(loginDefs: string): { min: number; max: number } {
  const value = (key: string, fallback: number) => {
    let found = fallback;
    for (const line of loginDefs.split("\n")) {
      const match = new RegExp(`^\\s*${key}\\s+(\\d{1,10})\\s*$`).exec(line);
      if (match) found = Number(match[1]);
    }
    return found;
  };
  return { min: value("UID_MIN", 1000), max: value("UID_MAX", 60000) };
}

export function memberUserCandidates(
  input: MemberUserCandidatesInput,
): { name: string; uid: number; members?: MemberOsUserMemberWire[] }[] {
  const { min, max } = loginUidRange(input.loginDefs);
  const left = new Set<string>();
  if (input.officeOsUser) left.add(input.officeOsUser);
  const membersOf = new Map(input.taken.map((t) => [t.name, t.members]));
  const found = new Map<string, number>();
  for (const line of input.passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 7) continue;
    const [name, , uidText] = fields;
    const shell = fields[6].split("/").pop() ?? "";
    if (!OS_USER_NAME_PATTERN.test(name) || !/^\d{1,10}$/.test(uidText))
      continue;
    const uid = Number(uidText);
    if (uid === 0 || uid < min || uid > max) continue;
    if (shell === "nologin" || shell === "false") continue;
    if (left.has(name) || found.has(name)) continue;
    found.set(name, uid);
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MEMBER_USER_CANDIDATES_MAX)
    .map(([name, uid]) => {
      const members = membersOf.get(name);
      return members && members.length > 0
        ? { name, uid, members }
        : { name, uid };
    });
}

// Where the root command keeps its marks (deploy/isomux-member-user.sh
// ETC_DIR): <user>.made names a user it made.
const MEMBER_RUNNER_ETC = "/etc/isomux/member-runner";
// The container's marks (deploy/container/member-users.py ROOT/etc).
const CONTAINER_MEMBER_ETC = "/var/data/members/etc";
// getent passwd also lists directory users (LDAP, SSSD), which can be slow.
const PASSWD_READ_MS = 5000;
const PASSWD_READ_MAX_BYTES = 32 * 1024 * 1024;

// The page reads the state every 3 s while it waits: one getent read serves
// the reads of this long. The marks and the records are read each time.
const PASSWD_KEEP_MS = 30_000;
const getentReads = new Map<
  "passwd" | "group",
  { at: number; text: Promise<string | null> }
>();

// getent passwd's or group's output, or null when it fails or times out
// (not kept).
function readGetent(db: "passwd" | "group"): Promise<string | null> {
  const now = Date.now();
  const kept = getentReads.get(db);
  if (kept && now - kept.at < PASSWD_KEEP_MS) return kept.text;
  const read = { at: now, text: Promise.resolve<string | null>(null) };
  read.text = promisify(execFile)("getent", [db], {
    encoding: "utf8",
    timeout: PASSWD_READ_MS,
    maxBuffer: PASSWD_READ_MAX_BYTES,
  }).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      console.error(
        `[member-os-user] cannot list the OS ${db === "passwd" ? "users" : "groups"}: ${(error as Error).message}`,
      );
      if (getentReads.get(db) === read) getentReads.delete(db);
      return null;
    },
  );
  getentReads.set(db, read);
  return read.text;
}

// The users with a .made mark of the root command: in ETC_DIR on the
// installer's install, in the helper's etc folder in the container.
function readMadeNames(): string[] {
  return [MEMBER_RUNNER_ETC, CONTAINER_MEMBER_ETC].flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((file) => file.endsWith(".made"))
        .map((file) => file.slice(0, -".made".length));
    } catch {
      // No marks yet, or not this shape.
      return [];
    }
  });
}

// The names that members run as (member-os-users.json).
function recordedOsUserNames(): string[] {
  return memberOsUserIds().flatMap((id) => {
    const state = memberOsUserState(id);
    return state.kind === "isolated" ? [state.osUser.name] : [];
  });
}

// The candidates of this box, for a member whose OS user is off on the
// installer's install. A passwd that cannot be read in time gives none: the
// owner can still type an existing user's name.
export async function readMemberUserCandidates(): Promise<
  { name: string; uid: number; members?: MemberOsUserMemberWire[] }[]
> {
  const passwd = await readGetent("passwd");
  if (passwd === null) return [];
  let loginDefs = "";
  try {
    loginDefs = readFileSync("/etc/login.defs", "utf8");
  } catch {
    // The defaults.
  }
  const made = readMadeNames();
  const names = new Set(
    memberOsUserIds().flatMap((id) => {
      const state = memberOsUserState(id);
      return state.kind === "isolated" && !state.movedIn
        ? [state.osUser.name]
        : [];
    }),
  );
  const taken = [...names].map((name) => ({
    name,
    members: membersOnUser(name),
  }));
  return memberUserCandidates({
    passwd,
    loginDefs,
    officeOsUser: serverOsUser(),
    taken,
    made,
  });
}

// Task 3b5234dc: the default OS user name of a member: the name in
// lowercase with its marks dropped (Manél: manel), each other run of
// characters as one dash, cut to the 32 characters of a user name. A name
// that starts with a digit gets "member-" before it; nothing left: "member".
const OS_USER_NAME_MAX = 32;
export function memberOsUserName(name: string): string {
  let base = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[0-9]/.test(base)) base = `member-${base}`;
  return base.slice(0, OS_USER_NAME_MAX).replace(/-+$/, "") || "member";
}

// The default name, or, when taken, the first free of <name>2, <name>3, ...
// (the name cut so that both fit 32 characters). taken null (not read): the
// default name, and the root command refuses a user that exists.
export function freeOsUserName(
  name: string,
  taken: ReadonlySet<string> | null,
): string {
  if (!taken || !taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const next = `${name.slice(0, OS_USER_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(next)) return next;
  }
}

// The names a new member user cannot take, from what readTakenOsUserNames
// read: every passwd and group name (useradd --user-group and groupadd fail
// on a group of that name), the names that members run as, without the
// users the root command made that no member runs as (it resumes its own
// user for the same member and refuses it for another).
export function osUserNamesTaken(input: {
  // getent passwd's and getent group's output.
  passwd: string;
  group: string;
  // The OS users that members run as (member-os-users.json).
  recorded: string[];
  // The users with a .made mark of the root command.
  made: string[];
}): string[] {
  const names = new Set<string>();
  for (const text of [input.passwd, input.group])
    for (const line of text.split("\n")) {
      const name = line.split(":")[0];
      if (line.includes(":") && name) names.add(name);
    }
  for (const name of input.made) names.delete(name);
  // A made user that a member runs as stays taken.
  for (const name of input.recorded) names.add(name);
  return [...names].sort();
}

// The names a new member user cannot take (osUserNamesTaken); null when
// passwd or group cannot be read.
export async function readTakenOsUserNames(): Promise<string[] | null> {
  const [passwd, group] = await Promise.all([
    readGetent("passwd"),
    readGetent("group"),
  ]);
  if (passwd === null || group === null) return null;
  return osUserNamesTaken({
    passwd,
    group,
    recorded: recordedOsUserNames(),
    made: readMadeNames(),
  });
}

// What the root command last did for each member, by member id. In memory:
// a restart forgets it, and the page then shows the records only.
interface Attempt {
  action: "enable" | "disable";
  stage: "running" | "prepared" | "failed";
  at: number;
  message?: string;
}
const attempts = new Map<string, Attempt>();

export function noteMemberUserAttempt(
  userId: string,
  action: Attempt["action"],
  stage: Attempt["stage"],
  message?: string,
  now: number = Date.now(),
): void {
  attempts.set(userId, {
    action,
    stage,
    at: now,
    ...(message ? { message } : {}),
  });
}

// The stage of what the root command last did for a member, if anything.
export function memberUserAttemptStage(
  userId: string,
): Attempt["stage"] | undefined {
  return attempts.get(userId)?.stage;
}

export function clearMemberUserAttempt(userId: string): void {
  attempts.delete(userId);
}

// Tests.
export function resetMemberUserAttempts(): void {
  attempts.clear();
}

function attemptWire(
  attempt: Attempt | undefined,
  now: number,
): MemberOsUserAttemptWire | undefined {
  if (!attempt) return undefined;
  const base = { action: attempt.action, at: attempt.at };
  if (attempt.stage === "failed")
    return {
      ...base,
      status: "failed",
      ...(attempt.message ? { message: attempt.message } : {}),
    };
  if (attempt.stage === "prepared" && now - attempt.at > PREPARED_STALE_MS)
    return { ...base, status: "stopped" };
  return { ...base, status: "running" };
}

export function memberOsUserView(
  // The name gives the new user's default name (the route always has it).
  user: Pick<UserRecord, "id" | "role"> & { name?: string },
  opts: {
    support: MemberUserSupport;
    // The existing OS users the owner can pick (memberUserCandidates), as the
    // route read them; null: not read.
    candidates?: MemberOsUserWire["candidates"] | null;
    // How the page can run the command itself (member-os-user-run.ts).
    run?: MemberOsUserWire["run"];
    now?: number;
    // The office's OS user; omitted: the server's own. null: unknown.
    officeOsUser?: string | null;
    // The names a new user cannot take (readTakenOsUserNames); null or
    // omitted: not read.
    osUserNames?: string[] | null;
  },
): MemberOsUserWire {
  const now = opts.now ?? Date.now();
  const { support } = opts;
  const officeOsUser =
    opts.officeOsUser === undefined ? serverOsUser() : opts.officeOsUser;
  const record = memberOsUserState(user.id);
  const attempt = attemptWire(attempts.get(user.id), now);
  // Slice 5c-3: a member who came with an office move is not ready until the
  // enable command places her home, also while its job runs. The office
  // refuses a plain disable of her: hers gives up the moved home.
  const movedIn = record.kind === "isolated" && record.movedIn !== undefined;
  const plain = memberUserCommands(user.id, support);
  const commands =
    plain && movedIn
      ? {
          enable: plain.enable,
          disable: `${plain.disable} --delete-moved-home`,
        }
      : plain;
  const common = {
    support: support.ok
      ? { ok: true as const }
      : { ok: false as const, reason: support.reason },
    commands,
    ...(commands &&
    support.ok &&
    support.shape === "docker" &&
    !support.container
      ? { commandHint: "container_name" as const }
      : {}),
    run: commands ? (opts.run ?? null) : null,
    ...(attempt ? { attempt } : {}),
    ...(officeOsUser ? { officeOsUser } : {}),
    ...(user.role === "owner" ? { owner: true as const } : {}),
  };
  if (record.kind === "none")
    return {
      state: "off",
      ...common,
      // Task e15a82e7: the owner picks the office's user, an existing user
      // or a new one. The list only where Run can take it (the installer's
      // install): the root command refuses --existing-user in a container.
      ...(commands && user.name !== undefined
        ? {
            newUserName: freeOsUserName(
              memberOsUserName(user.name),
              opts.osUserNames ? new Set(opts.osUserNames) : null,
            ),
            ...(support.ok && support.shape === "installer" && opts.candidates
              ? { candidates: opts.candidates }
              : {}),
          }
        : {}),
    };
  if (record.kind === "broken")
    return { state: "broken", reason: record.reason, ...common };
  const osUser = { name: record.osUser.name, uid: record.osUser.uid };
  const sharedWith = movedIn ? [] : membersOnUser(osUser.name, user.id);
  // A move that a restart cut stays not ready until enable runs again.
  const state = movedIn
    ? "not_ready"
    : memberIsMoving(user.id)
      ? "moving"
      : memberHostConnected(user.id) && !record.unfinished
        ? "on"
        : "not_ready";
  return {
    state,
    osUser,
    ...(movedIn ? { movedIn: true as const } : {}),
    ...(record.adopted ? { adopted: true as const } : {}),
    ...(record.adopted && record.rootCapable
      ? { rootCapable: true as const }
      : {}),
    ...(record.unfinished && state === "not_ready"
      ? { unfinished: true as const }
      : {}),
    ...(sharedWith.length > 0 ? { sharedWith } : {}),
    ...common,
  };
}

// The members other than `except` whose record names the OS user `name`,
// with whether each is an owner (task 12c796b2).
function membersOnUser(
  name: string,
  except?: string,
): MemberOsUserMemberWire[] {
  return membersOnOsUser(name, except).map((id) => {
    const member = getUserById(id);
    return { name: member?.name ?? id, owner: member?.role === "owner" };
  });
}

// The OS user this server runs as. userInfo() throws where the uid has no
// passwd entry (a pod with an arbitrary uid); the name is then unknown.
// The throw path has no test: it is this one call.
function serverOsUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}
