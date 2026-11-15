// The admin.sock verbs of the root command isomux-member-user
// (internal-docs/member-os-user-design.md, sections 2.2 and 2.3):
//   POST /admin/member-user/info     {member}
//   POST /admin/member-user/prepare  {member, osUser, uid}
//   POST /admin/member-user/go-on    {member, osUser, uid}
//   POST /admin/member-user/disable  {member}
// Only a peer with uid 0 reaches them (server/admin-socket.ts). Until the
// product slice ships, each answers 409 not_ready unless the office started
// with ISOMUX_MEMBER_USERS_RIG=1 (the test rig).

import {
  connectMemberHost,
  forgetMemberCodeVerdicts,
  forgetMemberHost,
  memberHostRefusal,
} from "./member-hosts.ts";
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
  // A re-run for the OS user the member already runs as keeps the record
  // when the connect fails: only a record this call made is undone.
  const made = state.kind === "none";
  recordMemberOsUser(user.id, { name: osUser.name, uid: osUser.uid });
  forgetMemberCodeVerdicts(osUser.uid);
  const end = Date.now() + deps.connectWaitMs;
  for (;;) {
    if (await deps.connect(user.id))
      return json(200, { ok: true, ready: true });
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, deps.connectPollMs));
  }
  const reason = memberHostRefusal(user.id) ?? "the runner did not connect";
  if (made) {
    forgetMemberOsUser(user.id);
    forgetMemberHost(user.id);
  }
  return json(200, { ok: false, ready: false, reason });
}
