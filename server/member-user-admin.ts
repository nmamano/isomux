// The admin.sock verbs of the root command isomux-member-user
// (internal-docs/member-os-user-design.md, sections 2.2 and 2.3):
//   POST /admin/member-user/info     {member}
//   POST /admin/member-user/prepare  {member, osUser, uid}
//   POST /admin/member-user/go-on    {member, osUser, uid, adopted?, rootCapable?}
//   POST /admin/member-user/disable  {member, keepFiles?, deleteMovedHome?}
// Only a peer with uid 0 reaches them (server/admin-socket.ts). Where the
// root command cannot run (memberUserSupport), each answers 409
// not_supported with the reason.

import { lstatSync } from "node:fs";
import type { AgentHost } from "./agent-host.ts";
import {
  clearMemberMoving,
  connectMemberHost,
  forgetMemberCodeVerdicts,
  forgetMemberHost,
  markMemberMoving,
  memberHostConnected,
  memberHostRefusal,
  memberMoveHost,
  setMemberConnectedHook,
} from "./member-hosts.ts";
import {
  applyMemberMovePins,
  memberMovePlanIsEmpty,
  planMemberMove,
  stageMemberMove,
  warnUnfinishedMemberMove,
  type MemberMoveAgent,
  type MemberMovePlan,
  type StagedMove,
} from "./member-move.ts";
import {
  planMemberMoveOut,
  transferMemberFilesOut,
  type MemberMoveOutPlan,
  type MoveOutResult,
} from "./member-move-out.ts";
import {
  forgetMemberOsUser,
  memberOsUserIds,
  memberOsUserState,
  OS_USER_NAME_PATTERN,
  recordMemberOsUser,
  type MemberOsUserOrigin,
} from "./member-os-users.ts";
import {
  installMemberRuntime,
  memberSharePath,
  runtimeSource,
} from "./member-runtime.ts";
import { checkMemberShare } from "./member-share-check.ts";
import { appsArrive, appsLeave, type LeftApp } from "./member-app-move.ts";
import { placeMemberHome } from "./member-home-place.ts";
import { STATE_ROOT } from "./config.ts";
import { restoreMemberUnits } from "./office-move-members.ts";
import { movedHomeDir, removeMovedHome } from "./office-move-members-in.ts";
import { memberUnitRunner, passwdEntry } from "./office-move-member-wiring.ts";
import { readAgentIdentity } from "./split/start.ts";
import { getUserById, getUserByName } from "./users.ts";
import type { MemberUserUnsupported } from "../shared/contract-shapes.ts";
import {
  clearMemberUserAttempt,
  MEMBER_USER_COMMAND_PATH,
  freeOsUserName,
  memberOsUserName,
  memberUserSupport,
  noteMemberUserAttempt,
  readTakenOsUserNames,
  type MemberUserSupport,
} from "./member-os-user-view.ts";

type UserRecord = NonNullable<ReturnType<typeof getUserById>>;

export const MEMBER_USER_PATH_PREFIX = "/admin/member-user/";

export interface MemberUserAdminDeps {
  // Where the root command can run; read once, at boot.
  support: MemberUserSupport;
  officeUid: number;
  lookupUser: (name: string) => { uid: number; gid: number; groups: number[] };
  // Install the runtime in the share and check the whole share; the hash.
  prepare: (share: string, memberGid: number) => Promise<string>;
  connect: (userId: string) => Promise<boolean>;
  // How long go-on tries to connect (the unit may not listen yet).
  connectWaitMs: number;
  connectPollMs: number;
  // The names a new member user cannot take (readTakenOsUserNames); the
  // info verb's userName is the first free name.
  takenOsUserNames: () => Promise<string[] | null>;
  // The file move (server/member-move.ts). holdMember resolves once every
  // process of the member's agents has ended; their messages queue until
  // releaseMember.
  holdMember: (userId: string) => Promise<void>;
  releaseMember: (userId: string) => void;
  memberAgents: (userId: string) => MemberMoveAgent[];
  planMove: (userId: string, agents: MemberMoveAgent[]) => MemberMovePlan;
  stageMove: (plan: MemberMovePlan, host: AgentHost) => Promise<StagedMove>;
  applyPins: (pins: StagedMove["pins"]) => void;
  moveHost: (userId: string) => AgentHost | undefined;
  // The move back on disable (server/member-move-out.ts).
  planMoveOut: (
    userId: string,
    agents: MemberMoveAgent[],
    host: AgentHost,
  ) => MemberMoveOutPlan;
  transferOut: (
    plan: MemberMoveOutPlan,
    host: AgentHost,
  ) => Promise<MoveOutResult>;
  // The member's apps (server/member-app-move.ts): torn down on the host
  // that runs them before the files move, installed on the new one after.
  appsLeave: (userId: string) => Promise<LeftApp[]>;
  appsArrive: (userId: string, left: readonly LeftApp[]) => void;
  // Slice 5c-2 (task 78733adf): a member who came with an office move. Her
  // go-on places her moved home through her new runner as a job (E6, D1-D9).
  movedIn: MovedInDeps;
}

// The steps of a movedIn member's go-on job (internal-docs/office-move-design.md
// "Members with their own OS user (slice 5c)").
export interface MovedInDeps {
  // <state>/move-members/<userId>/home when it is a folder, else null.
  stageDir: (userId: string) => string | null;
  // passwd's home of an OS user name here, or null.
  passwdHome: (name: string) => string | null;
  // tree-in, then tree-place (member-home-place.ts placeMemberHome).
  place: (input: {
    userId: string;
    stageDir: string;
    home: string;
    host: AgentHost;
    onProgress: (placed: number, total: number) => void;
  }) => Promise<void>;
  // Removes <state>/move-members/<userId> (office-move-members-in.ts).
  removeStage: (userId: string) => void;
  // systemctl --user daemon-reload, then her units of
  // move-member-units.json through her runner; the units that could not
  // come back, as warnings.
  restoreUnits: (userId: string) => Promise<string[]>;
}

// What a go-on of a movedIn member answers while her job runs, and once
// after it ended (D2). `kept`: the job recorded her new uid, so the root
// command keeps the user (D1).
export type MovedInOutcome =
  | { running: true; placed: number; total: number }
  | { ready: true; warnings: string[] }
  | { failed: string; kept: boolean };

// The place jobs that run, and the outcome of each one that ended and has
// not been answered yet (in memory: a restart forgets both, and the root
// command's next go-on starts a new job).
const placeJobs = new Map<string, { placed: number; total: number }>();
const placeOutcomes = new Map<string, MovedInOutcome>();

// Whether the place job of a movedIn member runs now: only then may her
// host connect (D5).
export function memberPlaceRunning(userId: string): boolean {
  return placeJobs.has(userId);
}

// What the agent manager gives the move (setMemberMoveWiring, at startup).
export interface MemberMoveWiring {
  holdMember: (userId: string) => Promise<void>;
  releaseMember: (userId: string) => void;
  memberAgents: (userId: string) => MemberMoveAgent[];
}
let wiring: MemberMoveWiring | null = null;

// Startup: the agent manager's side of the move, and the check at each
// connect for a move that did not finish. Null removes both (tests).
export function setMemberMoveWiring(next: MemberMoveWiring | null): void {
  wiring = next;
  setMemberConnectedHook(
    next
      ? (userId) => warnUnfinishedMemberMove(userId, next.memberAgents(userId))
      : null,
  );
}

const DEFAULT_DEPS: MemberUserAdminDeps = {
  support: memberUserSupport(),
  officeUid: process.getuid?.() ?? -1,
  lookupUser: readAgentIdentity,
  prepare: async (share, memberGid) => {
    const src = await runtimeSource();
    await installMemberRuntime(share, src, { memberGid });
    const verdict = checkMemberShare({
      share,
      officeUid: process.getuid!(),
      memberGid,
    });
    if (!verdict.ok)
      throw new Error(`the member share at ${verdict.path}: ${verdict.reason}`);
    return src.hash;
  },
  connect: connectMemberHost,
  connectWaitMs: 30_000,
  connectPollMs: 500,
  takenOsUserNames: readTakenOsUserNames,
  holdMember: (userId) => wiring?.holdMember(userId) ?? Promise.resolve(),
  releaseMember: (userId) => wiring?.releaseMember(userId),
  memberAgents: (userId) => wiring?.memberAgents(userId) ?? [],
  planMove: planMemberMove,
  stageMove: stageMemberMove,
  applyPins: applyMemberMovePins,
  moveHost: memberMoveHost,
  planMoveOut: planMemberMoveOut,
  transferOut: transferMemberFilesOut,
  appsLeave,
  appsArrive,
  movedIn: {
    stageDir: (userId) => {
      try {
        const dir = movedHomeDir(STATE_ROOT, userId);
        return lstatSync(dir).isDirectory() ? dir : null;
      } catch {
        return null;
      }
    },
    passwdHome: (name) => passwdEntry(name)?.home ?? null,
    place: async (input) => {
      await placeMemberHome(input);
    },
    removeStage: (userId) => removeMovedHome(STATE_ROOT, userId),
    restoreUnits: async (userId) => restoreMovedUnits(userId),
  },
};

// Her units that the old office stopped at the lock (move-member-units.json),
// through her new runner, after systemd reads her placed unit files.
function restoreMovedUnits(userId: string): string[] {
  const state = memberOsUserState(userId);
  if (state.kind !== "isolated") return [];
  const pw = passwdEntry(state.osUser.name);
  if (!pw) return [`cannot read the home of ${state.osUser.name}`];
  const run = memberUnitRunner({
    osUser: state.osUser.name,
    uid: state.osUser.uid,
    home: pw.home,
  });
  const warnings: string[] = [];
  const reload = run(["systemctl", "--user", "daemon-reload"]);
  if (reload.code !== 0)
    warnings.push(
      `systemctl daemon-reload: ${reload.stderr.trim() || `exit ${reload.code}`}`,
    );
  const result = restoreMemberUnits(STATE_ROOT, userId, run);
  for (const f of result?.failed ?? []) warnings.push(`${f.name}: ${f.reason}`);
  return warnings;
}
let deps = DEFAULT_DEPS;

// Tests: replace some dependencies; null restores the defaults.
export function setMemberUserAdminDeps(
  over: Partial<MemberUserAdminDeps> | null,
): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function refusal(status: number, error: string, message: string): Response {
  return json(status, { ok: false, error, message });
}

// The member by id or by name.
function findMember(value: unknown): UserRecord | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return getUserById(value) ?? getUserByName(value.trim());
}

// The OS user named in the request, checked against the user database: the
// uid and gid come from there, never from the request.
function osUserOf(
  body: Record<string, unknown>,
):
  | { ok: true; name: string; uid: number; gid: number; groups: number[] }
  | { ok: false; response: Response } {
  const name = body.osUser;
  if (typeof name !== "string" || !OS_USER_NAME_PATTERN.test(name))
    return {
      ok: false,
      response: refusal(400, "bad_os_user", "osUser is not a user name"),
    };
  let identity: { uid: number; gid: number; groups: number[] };
  try {
    identity = deps.lookupUser(name);
  } catch {
    return {
      ok: false,
      response: refusal(404, "no_os_user", `no OS user named ${name}`),
    };
  }
  if (body.uid !== identity.uid)
    return {
      ok: false,
      response: refusal(
        409,
        "uid_mismatch",
        `${name} is uid ${identity.uid}, not ${String(body.uid)}`,
      ),
    };
  if (identity.uid === 0 || identity.uid === deps.officeUid)
    return {
      ok: false,
      response: refusal(
        409,
        "privileged_os_user",
        `${name} is root or the office's own user`,
      ),
    };
  return { ok: true, name, ...identity };
}

// Task e15a82e7: go-on's `adopted` and `rootCapable`, written to the record
// on every call (a rerun clears what it does not send). rootCapable without
// adopted is refused: a user the command made never becomes root.
export function goOnOrigin(
  body: Record<string, unknown>,
):
  { ok: true; origin: MemberOsUserOrigin } | { ok: false; response: Response } {
  const { adopted, rootCapable } = body;
  for (const [field, value] of [
    ["adopted", adopted],
    ["rootCapable", rootCapable],
  ] as const)
    if (value !== undefined && value !== true)
      return {
        ok: false,
        response: refusal(400, "bad_origin", `${field} is true or absent`),
      };
  if (rootCapable && !adopted)
    return {
      ok: false,
      response: refusal(400, "bad_origin", "rootCapable needs adopted"),
    };
  return {
    ok: true,
    origin: {
      ...(adopted ? { adopted: true as const } : {}),
      ...(rootCapable ? { rootCapable: true as const } : {}),
    },
  };
}

function ownerRefusal(user: UserRecord): Response | null {
  return user.role === "owner"
    ? refusal(
        409,
        "member_owner",
        `${user.name} is an owner; an owner cannot have their own OS user`,
      )
    : null;
}

// Where the root command can run (the owner's page shows why it cannot).
export function memberUsersSupport(): MemberUserSupport {
  return deps.support;
}

// The names a new member user cannot take; the page and the info verb read
// the same ones, so the page and the command's default agree.
export function takenOsUserNames(): Promise<string[] | null> {
  return deps.takenOsUserNames();
}

async function defaultOsUserName(name: string): Promise<string> {
  const taken = await takenOsUserNames();
  return freeOsUserName(memberOsUserName(name), taken ? new Set(taken) : null);
}

// The verbs, with the owner's page told what the command does
// (member-os-user-view.ts): prepare and go-on are an enable, disable is a
// disable; info changes nothing. A member removed during a call is looked up
// by id only, so the record names no one else.
export async function handleMemberUserAdmin(
  pathname: string,
  body: unknown,
): Promise<Response> {
  const verb = pathname.slice(MEMBER_USER_PATH_PREFIX.length);
  const action =
    verb === "disable"
      ? "disable"
      : verb === "prepare" || verb === "go-on"
        ? "enable"
        : null;
  const user =
    action && deps.support.ok && typeof body === "object" && body !== null
      ? findMember((body as Record<string, unknown>).member)
      : undefined;
  if (!user || !action) return handleVerb(pathname, body);
  if (verb !== "prepare") noteMemberUserAttempt(user.id, action, "running");
  let response: Response;
  try {
    response = await handleVerb(pathname, body);
  } catch (error) {
    noteMemberUserAttempt(user.id, action, "failed", (error as Error).message);
    throw error;
  }
  try {
    // A refusal says `message`; go-on's and disable's failures say `reason`
    // (with ready: false), as the root command reads them.
    const answer = (await response.clone().json()) as {
      ok?: boolean;
      message?: string;
      reason?: string;
    };
    if (!answer.ok)
      noteMemberUserAttempt(
        user.id,
        action,
        "failed",
        answer.message ?? answer.reason,
      );
    else if (verb === "prepare")
      noteMemberUserAttempt(user.id, action, "prepared");
    else clearMemberUserAttempt(user.id);
  } catch {
    noteMemberUserAttempt(user.id, action, "failed");
  }
  return response;
}

// What the root command prints (it runs as root on the office's machine).
const UNSUPPORTED_MESSAGE: Record<MemberUserUnsupported, string> = {
  not_linux: "member OS users need Linux",
  kubernetes:
    "member OS users are not supported on Kubernetes: the pod never runs as root",
  render: "member OS users are not supported on Render",
  no_system_install:
    "member OS users need an office installed with the system installer (deploy/install.sh)",
  no_command: `${MEMBER_USER_COMMAND_PATH} is missing; update the office to install it`,
};

async function handleVerb(pathname: string, body: unknown): Promise<Response> {
  const verb = pathname.slice(MEMBER_USER_PATH_PREFIX.length);
  if (!["info", "prepare", "go-on", "disable"].includes(verb))
    return json(404, { ok: false, error: "not found" });
  if (!deps.support.ok)
    return refusal(
      409,
      "not_supported",
      UNSUPPORTED_MESSAGE[deps.support.reason],
    );
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refusal(400, "bad_request", "the body must be a JSON object");
  const request = body as Record<string, unknown>;
  const user = findMember(request.member);
  if (!user) return refusal(404, "no_member", "no such member");

  if (verb === "info") {
    const state = memberOsUserState(user.id);
    return json(200, {
      ok: true,
      userId: user.id,
      name: user.name,
      role: user.role,
      // The new user's name for enable with no --user: the name the
      // owner's page shows (memberOsUserView newUserName). Only while the
      // member runs as no user: the command reads it only then.
      ...(state.kind === "isolated"
        ? {}
        : { userName: await defaultOsUserName(user.name) }),
      osUser: state.kind === "isolated" ? state.osUser : null,
      state: state.kind,
      ...(state.kind === "isolated" && state.movedIn
        ? { movedIn: true, oldHome: state.movedIn.home }
        : {}),
    });
  }

  if (verb === "disable") {
    if (goingOn.has(user.id) || placeJobs.has(user.id))
      return refusal(
        409,
        "move_in_progress",
        `the files of ${user.name} are moving; wait for that call to answer`,
      );
    const state = memberOsUserState(user.id);
    if (state.kind === "none")
      return refusal(
        409,
        "not_isolated",
        `${user.name} has no OS user of their own`,
      );
    // Slice 5c-2 (D9): a member who came with a move has no runner here;
    // her moved home goes with the record, and only on deleteMovedHome.
    if (state.kind === "isolated" && state.movedIn) {
      if (request.deleteMovedHome !== true)
        return refusal(
          409,
          "moved_in",
          `${user.name} came with an office move and has no runner here; run enable, or disable with --delete-moved-home to delete their moved home`,
        );
      forgetMemberHost(user.id);
      forgetMemberOsUser(user.id);
      placeOutcomes.delete(user.id);
      deps.movedIn.removeStage(user.id);
      return json(200, { ok: true, kept: true, movedHomeRemoved: true });
    }
    if (request.deleteMovedHome === true)
      return refusal(
        409,
        "not_moved_in",
        `${user.name} did not come with an office move; run disable without --delete-moved-home`,
      );
    // keepFiles: the owner gives up the member's files in their home (their
    // runner cannot run). A broken record has no runner to move them.
    if (request.keepFiles === true || state.kind === "broken") {
      forgetMemberHost(user.id);
      forgetMemberOsUser(user.id);
      return json(200, { ok: true, kept: true });
    }
    if (!memberHostConnected(user.id))
      return refusal(
        409,
        "not_connected",
        `the runner of ${user.name} is not connected; start it, or disable with --keep-files`,
      );
    goingOn.add(user.id);
    try {
      return await disableMove(user.id);
    } finally {
      goingOn.delete(user.id);
    }
  }

  const owner = ownerRefusal(user);
  if (owner) return owner;
  const osUser = osUserOf(request);
  if (!osUser.ok) return osUser.response;

  if (verb === "prepare") {
    try {
      const hash = await deps.prepare(memberSharePath(osUser.name), osUser.gid);
      return json(200, { ok: true, hash });
    } catch (error) {
      return refusal(500, "prepare_failed", (error as Error).message);
    }
  }

  // Task e15a82e7: checked before anything is written or connected.
  const origin = goOnOrigin(request);
  if (!origin.ok) return origin.response;

  // Slice 5c-2 (D2): the place job of a moved-in member runs, or ended and
  // its outcome waits for this go-on.
  const job = placeJobs.get(user.id);
  if (job)
    return json(200, {
      ok: true,
      ready: false,
      running: true,
      placed: job.placed,
      total: job.total,
    });
  const outcome = placeOutcomes.get(user.id);
  if (outcome) {
    placeOutcomes.delete(user.id);
    if ("ready" in outcome)
      return json(200, { ok: true, ready: true, warnings: outcome.warnings });
    if ("failed" in outcome)
      return json(200, {
        ok: false,
        ready: false,
        reason: outcome.failed,
        ...(outcome.kept ? { kept: true } : {}),
      });
  }

  // go-on: record, connect (the runner may not listen yet), or undo.
  const state = memberOsUserState(user.id);
  if (state.kind === "broken")
    return refusal(409, "broken_record", state.reason);
  if (state.kind === "isolated" && state.osUser.name !== osUser.name)
    return refusal(
      409,
      "already_isolated",
      `${user.name} already runs as ${state.osUser.name}`,
    );
  // Two members on one OS user would share a home, a runner and sign-ins.
  const taken = memberOsUserIds().find((id) => {
    if (id === user.id) return false;
    const other = memberOsUserState(id);
    // A moved-in record names the old box's uid and a user enable has not
    // made here yet.
    return (
      other.kind === "isolated" &&
      !other.movedIn &&
      (other.osUser.name === osUser.name || other.osUser.uid === osUser.uid)
    );
  });
  if (taken)
    return refusal(
      409,
      "os_user_taken",
      `another member already runs as ${osUser.name}`,
    );
  // One go-on per member at a time: a second one (an admin who thinks the
  // first hung) would hold again and clear the first one's staging.
  if (goingOn.has(user.id))
    return refusal(
      409,
      "move_in_progress",
      `the files of ${user.name} are moving; wait for that go-on to answer`,
    );
  if (state.kind === "isolated" && state.movedIn)
    return startPlace(user.id, osUser, state.movedIn.home);
  goingOn.add(user.id);
  try {
    return await goOn(
      user.id,
      osUser,
      state.kind === "none",
      state.kind === "isolated" && !!state.unfinished,
      origin.origin,
      state.kind === "isolated"
        ? {
            ...(state.adopted ? { adopted: true as const } : {}),
            ...(state.rootCapable ? { rootCapable: true as const } : {}),
          }
        : {},
    );
  } finally {
    goingOn.delete(user.id);
  }
}

// The members whose go-on, disable or agent host move runs.
const goingOn = new Set<string>();

// Whether a go-on, a disable or an agent host move runs for the member (an office move waits).
export function memberUserCallRunning(userId: string): boolean {
  return goingOn.has(userId);
}

// A host move of an agent (agent-host-move.ts) claims each member it
// touches that has an OS user, so no go-on, disable or other agent move
// of that member runs meanwhile (they share the runner's staging). False,
// and nothing claimed, when one of them is busy.
export function claimMemberMoves(userIds: string[]): boolean {
  if (userIds.some((id) => goingOn.has(id))) return false;
  for (const id of userIds) goingOn.add(id);
  return true;
}

export function releaseMemberMoves(userIds: string[]): void {
  for (const id of userIds) goingOn.delete(id);
}

// disable (design 2.3): hold the member's agents, tear their apps down on
// their host, mark moving, read their files back through their runner and
// write them into the office, write the pins, remove the member's copies,
// forget the record, install the apps on the office's host and release. A failure before the pins undoes the office's side and keeps the
// record and the member's copy.
async function disableMove(userId: string): Promise<Response> {
  try {
    await deps.holdMember(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return json(200, {
      ok: false,
      ready: false,
      reason: `cannot stop the member's agents: ${(error as Error).message}`,
    });
  }
  let left: LeftApp[];
  try {
    left = await deps.appsLeave(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return json(200, {
      ok: false,
      ready: false,
      reason: (error as Error).message,
    });
  }
  const fail = (reason: string): Response => {
    clearMemberMoving(userId);
    // Back on the member's host.
    deps.appsArrive(userId, left);
    deps.releaseMember(userId);
    return json(200, { ok: false, ready: false, reason });
  };
  markMemberMoving(userId);
  const host = deps.moveHost(userId);
  if (!host) return fail("the member's runner is not connected");
  let moved: MoveOutResult;
  try {
    const plan = deps.planMoveOut(userId, deps.memberAgents(userId), host);
    moved = await deps.transferOut(plan, host);
  } catch (error) {
    return fail(
      `cannot move the member's files back: ${(error as Error).message}`,
    );
  }
  try {
    deps.applyPins(moved.pins);
  } catch (error) {
    moved.undo();
    return fail(
      `cannot record where the moved conversations are: ${(error as Error).message}`,
    );
  }
  await moved.removeMemberCopy();
  forgetMemberHost(userId);
  forgetMemberOsUser(userId);
  clearMemberMoving(userId);
  // On the office's host now.
  deps.appsArrive(userId, left);
  deps.releaseMember(userId);
  moved.done();
  return json(200, { ok: true });
}

// A go-on that did not take the OS user. `kept`: the office still holds
// the member's record (a rerun, or an undo that could not remove it), so the
// root command must keep the user and its home, and the same enable runs
// again; without it, the office removed what this call recorded.
function notTaken(userId: string, reason: string): Response {
  return json(200, {
    ok: false,
    ready: false,
    reason,
    ...(memberOsUserState(userId).kind !== "none" ? { kept: true } : {}),
  });
}

// A refusal of a moved-in member's go-on before her new uid is recorded:
// no `kept`, so the root command undoes the user it made (D1).
function movedInRefusal(reason: string): Response {
  return json(200, { ok: false, ready: false, reason });
}

// go-on of a member who came with an office move (slice 5c-2, E6): checks
// her home here and her moved home, then starts the place job and answers
// running. The root command asks again until the outcome comes (D2).
function startPlace(
  userId: string,
  osUser: { name: string; uid: number },
  oldHome: string,
): Response {
  const home = deps.movedIn.passwdHome(osUser.name);
  if (home === null)
    return movedInRefusal(`${osUser.name} has no home in passwd here`);
  if (home !== oldHome)
    return movedInRefusal(
      `the home of ${osUser.name} is ${home} here and was ${oldHome} on the old machine`,
    );
  const stageDir = deps.movedIn.stageDir(userId);
  if (stageDir === null)
    return movedInRefusal(
      "their home did not come with the move; disable with --delete-moved-home gives it up",
    );
  const job = { placed: 0, total: 0 };
  placeJobs.set(userId, job);
  // D6: the job is a running call.
  goingOn.add(userId);
  void runPlace(userId, osUser, { oldHome, home, stageDir }, job)
    .then(
      (outcome) => placeOutcomes.set(userId, outcome),
      (error: unknown) =>
        placeOutcomes.set(userId, {
          failed: (error as Error).message,
          kept: memberOsUserState(userId).kind !== "none",
        }),
    )
    .finally(() => {
      placeJobs.delete(userId);
      goingOn.delete(userId);
    });
  return json(200, {
    ok: true,
    ready: false,
    running: true,
    placed: 0,
    total: 0,
  });
}

// The place job (D6): hold, appsLeave, record the new uid (moving,
// movedIn), connect, tree-in and tree-place, record without movedIn, the
// stage delete, her units, the office's files of her agents, appsArrive,
// release.
async function runPlace(
  userId: string,
  osUser: { name: string; uid: number },
  where: { oldHome: string; home: string; stageDir: string },
  job: { placed: number; total: number },
): Promise<MovedInOutcome> {
  try {
    await deps.holdMember(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return {
      failed: `cannot stop the member's agents: ${(error as Error).message}`,
      kept: false,
    };
  }
  let left: LeftApp[];
  try {
    left = await deps.appsLeave(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return { failed: (error as Error).message, kept: false };
  }
  markMemberMoving(userId);
  // Every exit from here on brings her apps back, releases her agents and
  // clears the moving mark (which opens her connect gate, D5), also when a
  // step throws. Returns what could not be done.
  const end = (): string[] => {
    const left2: string[] = [];
    clearMemberMoving(userId);
    try {
      deps.appsArrive(userId, left);
    } catch (error) {
      left2.push(`cannot start their apps: ${(error as Error).message}`);
    }
    try {
      deps.releaseMember(userId);
    } catch (error) {
      left2.push(`cannot release their agents: ${(error as Error).message}`);
    }
    return left2;
  };
  const fail = (reason: string): MovedInOutcome => {
    // The record keeps movedIn with the new uid: the same enable resumes.
    try {
      forgetMemberHost(userId);
    } catch (error) {
      console.error(
        `[member-move] ${userId}: cannot forget the host: ${(error as Error).message}`,
      );
    }
    for (const line of end()) console.error(`[member-move] ${userId}: ${line}`);
    return { failed: reason, kept: true };
  };
  try {
    recordMemberOsUser(userId, osUser, {
      moving: true,
      movedIn: { home: where.oldHome },
    });
  } catch (error) {
    for (const line of end()) console.error(`[member-move] ${userId}: ${line}`);
    return {
      failed: `cannot record the OS user: ${(error as Error).message}`,
      kept: false,
    };
  }
  let placed = false;
  try {
    forgetMemberCodeVerdicts(osUser.uid);
    const until = Date.now() + deps.connectWaitMs;
    let connected = false;
    for (;;) {
      if (await deps.connect(userId)) {
        connected = true;
        break;
      }
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, deps.connectPollMs));
    }
    if (!connected)
      return fail(memberHostRefusal(userId) ?? "the runner did not connect");
    const host = deps.moveHost(userId);
    if (!host) return fail("the member's runner is not connected");
    try {
      await deps.movedIn.place({
        userId,
        stageDir: where.stageDir,
        home: where.home,
        host,
        onProgress: (n, total) => {
          job.placed = n;
          job.total = total;
        },
      });
    } catch (error) {
      return fail(`cannot place their moved home: ${(error as Error).message}`);
    }
    // Her home is in place: the record says so before the stage goes (a
    // crash between the two leaves a stage that the boot sweep removes).
    try {
      recordMemberOsUser(userId, osUser);
    } catch (error) {
      return fail(
        `their home is placed, but the record still says it moves (${(error as Error).message}); run enable again`,
      );
    }
    placed = true;
    const warnings: string[] = [];
    try {
      deps.movedIn.removeStage(userId);
    } catch (error) {
      warnings.push(
        `cannot delete the moved copy of their home: ${(error as Error).message}`,
      );
    }
    try {
      warnings.push(...(await deps.movedIn.restoreUnits(userId)));
    } catch (error) {
      warnings.push(`cannot restore their units: ${(error as Error).message}`);
    }
    // Files of her agents in the office's folders (none, as a rule: her
    // agents ran as her on the old machine).
    try {
      const plan = deps.planMove(userId, deps.memberAgents(userId));
      if (!memberMovePlanIsEmpty(plan)) {
        const staged = await deps.stageMove(plan, host);
        deps.applyPins(staged.pins);
        await staged.done();
        staged.deleteOfficeCopies();
      }
    } catch (error) {
      warnings.push(
        `cannot move the office's files of their agents: ${(error as Error).message}`,
      );
    }
    warnings.push(...end());
    return { ready: true, warnings };
  } catch (error) {
    // Her home is placed and her record says so: what is left are warnings.
    if (placed) {
      const lines = [
        `the job ended early: ${(error as Error).message}`,
        ...end(),
      ];
      return { ready: true, warnings: lines };
    }
    return fail((error as Error).message);
  }
}

// go-on (design 2.2): hold the member's agents, plan the move from the
// office's paths, tear their apps down, record and mark moving, connect,
// move the files through the runner, write the pins, install the apps on
// the member's host, then release. A failure before the pins undoes the
// runner's side and, when this call made the record, removes it; the
// office copy stays, and the apps go back up where they were.
async function goOn(
  userId: string,
  osUser: { name: string; uid: number },
  // A re-run for the OS user the member already runs as keeps the record
  // when it fails: only a record this call made is undone.
  made: boolean,
  // The record said a move did not finish: a re-run that fails keeps it so.
  unfinished: boolean,
  // Task e15a82e7: what this call writes to the record, and what a re-run
  // that fails writes back.
  origin: MemberOsUserOrigin,
  oldOrigin: MemberOsUserOrigin,
): Promise<Response> {
  try {
    await deps.holdMember(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return notTaken(
      userId,
      `cannot stop the member's agents: ${(error as Error).message}`,
    );
  }
  let plan: MemberMovePlan;
  try {
    plan = deps.planMove(userId, deps.memberAgents(userId));
  } catch (error) {
    deps.releaseMember(userId);
    return notTaken(
      userId,
      `cannot plan the file move: ${(error as Error).message}`,
    );
  }
  let left: LeftApp[];
  try {
    left = await deps.appsLeave(userId);
  } catch (error) {
    deps.releaseMember(userId);
    return notTaken(userId, (error as Error).message);
  }
  markMemberMoving(userId);
  // The record says the files move until they have: an office that stops
  // before then keeps the member not ready until enable runs again.
  recordMemberOsUser(
    userId,
    { name: osUser.name, uid: osUser.uid },
    { moving: true, ...origin },
  );
  forgetMemberCodeVerdicts(osUser.uid);
  let staged: StagedMove | null = null;
  const fail = async (reason: string): Promise<Response> => {
    if (staged)
      await staged
        .undo()
        .catch((error: unknown) =>
          console.error(
            `[member-move] ${userId}: the undo failed: ${(error as Error).message}`,
          ),
        );
    try {
      if (made) {
        forgetMemberHost(userId);
        forgetMemberOsUser(userId);
      } else
        recordMemberOsUser(
          userId,
          { name: osUser.name, uid: osUser.uid },
          { moving: unfinished, ...oldOrigin },
        );
    } catch (error) {
      console.error(
        `[member-move] ${userId}: cannot write the record back: ${(error as Error).message}`,
      );
    }
    clearMemberMoving(userId);
    // Back on the host they left.
    deps.appsArrive(userId, left);
    deps.releaseMember(userId);
    return notTaken(userId, reason);
  };
  const end = Date.now() + deps.connectWaitMs;
  let connected = false;
  for (;;) {
    if (await deps.connect(userId)) {
      connected = true;
      break;
    }
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, deps.connectPollMs));
  }
  if (!connected)
    return fail(memberHostRefusal(userId) ?? "the runner did not connect");
  if (!memberMovePlanIsEmpty(plan)) {
    const host = deps.moveHost(userId);
    if (!host) return fail("the member's runner is not connected");
    try {
      staged = await deps.stageMove(plan, host);
    } catch (error) {
      return fail(
        `cannot move the member's files: ${(error as Error).message}`,
      );
    }
    try {
      deps.applyPins(staged.pins);
    } catch (error) {
      return fail(
        `cannot record where the moved conversations are: ${(error as Error).message}`,
      );
    }
    await staged
      .done()
      .catch((error: unknown) =>
        console.error(
          `[member-move] ${userId}: cannot remove the staging folder: ${(error as Error).message}`,
        ),
      );
  }
  // The files are in place. A record that keeps the mark keeps the member
  // not ready; enable again places nothing twice (files-place takes a file
  // with the same bytes as placed).
  let marked = false;
  try {
    recordMemberOsUser(userId, { name: osUser.name, uid: osUser.uid }, origin);
  } catch (error) {
    marked = true;
    console.error(
      `[member-move] ${userId}: cannot clear the moving mark: ${(error as Error).message}`,
    );
  }
  clearMemberMoving(userId);
  // On the member's own host now; their data has moved.
  deps.appsArrive(userId, left);
  deps.releaseMember(userId);
  if (marked)
    return notTaken(
      userId,
      "the files moved, but the record still says they move; run enable again",
    );
  staged?.deleteOfficeCopies();
  return json(200, { ok: true, ready: true });
}
