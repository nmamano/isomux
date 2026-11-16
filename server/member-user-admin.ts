// The admin.sock verbs of the root command isomux-member-user
// (internal-docs/member-os-user-design.md, sections 2.2 and 2.3):
//   POST /admin/member-user/info     {member}
//   POST /admin/member-user/prepare  {member, osUser, uid}
//   POST /admin/member-user/go-on    {member, osUser, uid}
//   POST /admin/member-user/disable  {member, keepFiles?}
// Only a peer with uid 0 reaches them (server/admin-socket.ts). Where the
// root command cannot run (memberUserSupport), each answers 409
// not_supported with the reason.

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
} from "./member-os-users.ts";
import {
  installMemberRuntime,
  memberSharePath,
  runtimeSource,
} from "./member-runtime.ts";
import { checkMemberShare } from "./member-share-check.ts";
import { appsArrive, appsLeave, type LeftApp } from "./member-app-move.ts";
import { readAgentIdentity } from "./split/start.ts";
import { getUserById, getUserByName } from "./users.ts";
import type { MemberUserUnsupported } from "../shared/contract-shapes.ts";
import {
  clearMemberUserAttempt,
  MEMBER_USER_COMMAND_PATH,
  memberUserSupport,
  noteMemberUserAttempt,
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
};
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

// The default OS user name's suffix: the name in lowercase letters, digits
// and dashes, so that isomux-<slug> fits the 32 characters of a user name.
export function memberSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 25)
    .replace(/-+$/, "");
  return slug || "member";
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
      slug: memberSlug(user.name),
      osUser: state.kind === "isolated" ? state.osUser : null,
      state: state.kind,
    });
  }

  if (verb === "disable") {
    if (goingOn.has(user.id))
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
    return (
      other.kind === "isolated" &&
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
  goingOn.add(user.id);
  try {
    return await goOn(
      user.id,
      osUser,
      state.kind === "none",
      state.kind === "isolated" && !!state.unfinished,
    );
  } finally {
    goingOn.delete(user.id);
  }
}

// The members whose go-on or disable runs.
const goingOn = new Set<string>();

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
    { moving: true },
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
          { moving: unfinished },
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
    recordMemberOsUser(userId, { name: osUser.name, uid: osUser.uid });
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
