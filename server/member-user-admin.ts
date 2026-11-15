// The admin.sock verbs of the root command isomux-member-user
// (internal-docs/member-os-user-design.md, sections 2.2 and 2.3):
//   POST /admin/member-user/info     {member}
//   POST /admin/member-user/prepare  {member, osUser, uid}
//   POST /admin/member-user/go-on    {member, osUser, uid}
//   POST /admin/member-user/disable  {member}
// Only a peer with uid 0 reaches them (server/admin-socket.ts). Until the
// product slice ships, each answers 409 not_ready unless the office started
// with ISOMUX_MEMBER_USERS_RIG=1 (the test rig).

import type { AgentHost } from "./agent-host.ts";
import {
  clearMemberMoving,
  connectMemberHost,
  forgetMemberCodeVerdicts,
  forgetMemberHost,
  markMemberMoving,
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
import { readAgentIdentity } from "./split/start.ts";
import { getUserById, getUserByName } from "./users.ts";

type UserRecord = NonNullable<ReturnType<typeof getUserById>>;

// Read once, at boot.
const RIG_ENABLED = process.env.ISOMUX_MEMBER_USERS_RIG === "1";

export const MEMBER_USER_PATH_PREFIX = "/admin/member-user/";

export interface MemberUserAdminDeps {
  enabled: boolean;
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
  enabled: RIG_ENABLED,
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

export async function handleMemberUserAdmin(
  pathname: string,
  body: unknown,
): Promise<Response> {
  const verb = pathname.slice(MEMBER_USER_PATH_PREFIX.length);
  if (!["info", "prepare", "go-on", "disable"].includes(verb))
    return json(404, { ok: false, error: "not found" });
  if (!deps.enabled)
    return refusal(
      409,
      "not_ready",
      "this office does not support member OS users yet",
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
    forgetMemberOsUser(user.id);
    forgetMemberHost(user.id);
    return json(200, { ok: true });
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
    return await goOn(user.id, osUser, state.kind === "none");
  } finally {
    goingOn.delete(user.id);
  }
}

// The members whose go-on runs.
const goingOn = new Set<string>();

// go-on (design 2.2): hold the member's agents, plan the move from the
// office's paths, record and mark moving, connect, move the files through
// the runner, write the pins, then release. A failure before the pins
// undoes the runner's side and, when this call made the record, removes it;
// the office copy stays.
async function goOn(
  userId: string,
  osUser: { name: string; uid: number },
  // A re-run for the OS user the member already runs as keeps the record
  // when it fails: only a record this call made is undone.
  made: boolean,
): Promise<Response> {
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
  let plan: MemberMovePlan;
  try {
    plan = deps.planMove(userId, deps.memberAgents(userId));
  } catch (error) {
    deps.releaseMember(userId);
    return json(200, {
      ok: false,
      ready: false,
      reason: `cannot plan the file move: ${(error as Error).message}`,
    });
  }
  markMemberMoving(userId);
  recordMemberOsUser(userId, { name: osUser.name, uid: osUser.uid });
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
    if (made) {
      forgetMemberOsUser(userId);
      forgetMemberHost(userId);
    }
    clearMemberMoving(userId);
    deps.releaseMember(userId);
    return json(200, { ok: false, ready: false, reason });
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
  clearMemberMoving(userId);
  deps.releaseMember(userId);
  staged?.deleteOfficeCopies();
  return json(200, { ok: true, ready: true });
}
