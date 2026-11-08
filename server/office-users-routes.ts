// The users routes: member create, update, access, delete (the member's
// agents, schedules and webhooks pass to the oldest office owner), and the
// removed members (list, restore, purge). Moved out of buildExecutorDeps in
// server/isomux-office.ts, which registers them and keeps their
// userDeleteNotSelfOwner and userDeleteNotLastOwner preconditions.
import type { MemberRestoreRes } from "../shared/contract-shapes.ts";
import type { AgentInfo, UserRecord, WebhookRecord } from "../shared/types.ts";
import type { MemberPack } from "../shared/pack-fit.ts";
import { revokeApiTokensOfUser } from "./api-tokens.ts";
import type { AppVisibilityFacts } from "./app-visibility.ts";
import { noteAuditTarget, notePromptContent } from "./audit-context.ts";
import {
  evictSessionsForUserId,
  ownerRemovalWouldStrandOffice,
  removeOwnerUnlessStranding,
  revokeInvitesForUser,
} from "./auth.ts";
import type { createMcpServerSources } from "./mcp-servers.ts";
import { dropOAuthTokensOfScope } from "./mcp-oauth-tokens.ts";
import { removeMemberSkillFolders } from "./member-skill-folder.ts";
import { versionOf } from "./memory-store.ts";
import type { createAccessPolicy } from "./office-access-policy.ts";
import {
  agentManager,
  cronjobManager,
  extensionService,
  webPushStore,
  whatsappSupervisor,
  discordSupervisor,
} from "./office-managers.ts";
import type { createSessionProjection } from "./office-session-projection.ts";
import type { ProviderAccountManager } from "./provider-account-manager.ts";
import { refreshPresenceForUser } from "./presence.ts";
import { personalProviderHome } from "./provider-homes.ts";
import {
  archiveRemovedMember,
  dropRemovedMember,
  getRemovedMember,
  listRemovedMembers,
  readArchivedConnections,
  removedMemberWire,
  restoreArchivedFiles,
  type ArchivedConnections,
  type RemovedMember,
} from "./removed-members.ts";
import type { HandlerErrorStatus, RouteHandler } from "./routes/executor.ts";
import { usersHandlers } from "./routes/handlers/users.ts";
import { removeManagedUserEnv } from "./user-env.ts";
import {
  createMember,
  memberNameRefusal,
  deleteUser,
  deleteUserById,
  getUser,
  getUserById,
  listUsers,
  pruneStaleRoomRefs,
  restoreUserRecord,
  updateUserById,
  wouldDeleteLeaveNoOwner,
} from "./users.ts";
import { webhookRegistry } from "./webhooks/registry.ts";
import {
  ENTERPRISE_ERROR_CODES,
  type EnterpriseSeats,
} from "./enterprise-seats.ts";
import {
  enterpriseRefusalMessage,
  enterpriseRefusalStatus,
  type EnterpriseRefusalOutcome,
} from "./enterprise-seats-routes.ts";
import { AGENTS_CANNOT_MOVE_DOWN } from "./identity/agent-fit.ts";

// What the users routes read from server/isomux-office.ts.
export interface UsersRoutesDeps
  extends
    Pick<
      ReturnType<typeof createAccessPolicy>,
      | "announceAppAudienceChanges"
      | "announceWebhookAudienceChanges"
      | "attributionFor"
      | "emitUsersList"
      | "snapshotAppVisibility"
      | "snapshotWebhookAudience"
    >,
    Pick<ReturnType<typeof createSessionProjection>, "clampViewFields"> {
  accessibleRoomIdsFor: (
    user: UserRecord,
    allowedRoomsOverride?: readonly string[],
  ) => Set<string>;
  emitInvitesList: () => void;
  emitPrivateUserRecord: (user: UserRecord) => void;
  emitRemovedMembers: () => void;
  emitUserUpdated: (user: UserRecord, prevName?: string) => void;
  // Tell the sockets that see a hook about an edit that keeps its audience.
  announceWebhookUpdate: (record: WebhookRecord) => void;
  mcpSources: ReturnType<typeof createMcpServerSources>;
  providerAccounts: Pick<ProviderAccountManager, "signOutRemovedMember">;
  purgeRemovedMember: (userId: string) => void;
  pushPresenceListToEachWs: () => void;
  secretsChanged: () => Promise<void>;
  transferAgentManager: (
    agentId: string,
    toUserId: string,
    changedBy: string,
  ) => Promise<AgentInfo | null | "unknown_member" | "cannot_move_down">;
  // The member permission pack's agent ceiling (server/member-ceiling.ts):
  // the agents a pack would leave above it with an engine that cannot run at
  // it, and the moves and app stops after a save.
  agentsThatCannotMoveDown: (userId: string, pack: MemberPack) => AgentInfo[];
  afterMemberPackSaved: (userId: string) => void;
  // The Enterprise Contract seats (server/enterprise-seats.ts): every add
  // takes a seat first, a removal releases one.
  enterpriseSeats: () => EnterpriseSeats;
}

// A refused seat as the users routes' error shape.
function enterpriseRefusal(refusal: EnterpriseRefusalOutcome): {
  ok: false;
  status: HandlerErrorStatus;
  code: string;
  error: string;
} {
  return {
    ok: false,
    status: enterpriseRefusalStatus(refusal),
    code: ENTERPRISE_ERROR_CODES[refusal.reason],
    error: enterpriseRefusalMessage(refusal),
  };
}

// The member's connections for the archive: secrets without values and MCP
// servers with each sign-in reset, leaving out the secrets a sign-in wrote.
// A store file that does not parse keeps nothing (the removal deletes it
// either way).
function archivedConnectionsOf(
  userId: string,
  sources: ReturnType<typeof createMcpServerSources>,
): ArchivedConnections {
  let mcpServers: ArchivedConnections["mcpServers"] = [];
  let ownedSecrets: string[] = [];
  try {
    ({ servers: mcpServers, ownedSecrets } =
      sources.servers.exportForArchive(userId));
  } catch (err) {
    console.error(`[users] the MCP servers of ${userId} were not kept:`, err);
  }
  let secrets: ArchivedConnections["secrets"] = [];
  try {
    secrets = sources.secrets.exportShapes(userId, ownedSecrets);
  } catch (err) {
    console.error(`[users] the secret names of ${userId} were not kept:`, err);
  }
  return { secrets, mcpServers };
}

// Lockout reason of users.update (an owner demoted) and users.delete, for the
// invariant "the office must always keep one owner with an active session, so
// an operator can recover from inside the browser".
const OWNER_REMOVAL_LOCKOUT_REASON =
  "No other office owner is signed in, so no owner could sign in again from " +
  "a browser. Have another owner sign in first, then retry.";

// The owner who gets a deleted member's agents: the oldest office owner
// other than the member (Nil, 2026-10-20). Ties go by id.
function heirOwnerFor(deletedUserId: string): UserRecord | undefined {
  return listUsers()
    .filter((u) => u.role === "owner" && u.id !== deletedUserId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}

// A deleted member's webhooks and schedules turn off before their agents pass
// to the heir (task be7708d3). An agent transfer moves the records its agent
// made to the heir, and the delete then awaits the next agent's drain. A hook
// still on in that window would take the secret the member kept, and a
// schedule would fire their prompt, both with the heir's environment and
// secrets. The heir reads each one and turns it back on.
function turnOffMemberRecords(memberId: string, hookIds: string[]): void {
  for (const id of hookIds) turnOffWebhook(id);
  for (const job of cronjobManager.listCronjobs())
    if (job.userId === memberId) turnOffCronjob(job.id);
}

function turnOffWebhook(id: string): void {
  try {
    const hook = webhookRegistry.get(id);
    if (hook?.enabled) webhookRegistry.update(id, { ...hook, enabled: false });
  } catch (err) {
    console.error(`[users] webhook ${id} did not turn off:`, err);
  }
}

function turnOffCronjob(id: string): void {
  try {
    if (cronjobManager.listCronjobs().find((job) => job.id === id)?.enabled)
      cronjobManager.updateCronjob(id, { enabled: false });
  } catch (err) {
    console.error(`[users] schedule ${id} did not turn off:`, err);
  }
}

// After the agent transfers, a deleted member's schedules and webhooks that
// did not move with an agent pass to the heir too (task 438900d2), turned
// off. The member could read the secret of every hook they owned, so each of
// `hookIds` (all the hooks they owned when the delete began, also those that
// already moved with an agent) and each hook still theirs (made during the
// transfers) passes with a secret they never saw. Off before the new secret
// and the new owner: a throw part way must leave the record off.
function passMemberRecordsToHeir(
  memberId: string,
  hookIds: string[],
  heir: UserRecord,
): void {
  const ids = new Set(hookIds);
  for (const hook of webhookRegistry.list())
    if (hook.userId === memberId) ids.add(hook.id);
  for (const id of ids) {
    try {
      const hook = webhookRegistry.get(id);
      if (!hook) continue;
      if (hook.enabled) webhookRegistry.update(id, { ...hook, enabled: false });
      webhookRegistry.rotateSecret(id);
      if (hook.userId === memberId)
        webhookRegistry.setOwner(id, heir.id, heir.name);
    } catch (err) {
      console.error(`[users] webhook ${id} did not pass to the heir:`, err);
    }
  }
  for (const job of cronjobManager.listCronjobs()) {
    if (job.userId !== memberId) continue;
    try {
      if (job.enabled) cronjobManager.updateCronjob(job.id, { enabled: false });
      cronjobManager.setCronjobOwner(job.id, heir.id, heir.name);
    } catch (err) {
      console.error(
        `[users] schedule ${job.id} did not pass to the heir:`,
        err,
      );
    }
  }
}

export function createUsersRoutes(
  deps: UsersRoutesDeps,
): Record<string, RouteHandler> {
  const {
    accessibleRoomIdsFor,
    announceAppAudienceChanges,
    announceWebhookAudienceChanges,
    attributionFor,
    clampViewFields,
    emitInvitesList,
    emitPrivateUserRecord,
    emitRemovedMembers,
    announceWebhookUpdate,
    emitUserUpdated,
    emitUsersList,
    enterpriseSeats,
    mcpSources,
    providerAccounts,
    purgeRemovedMember,
    pushPresenceListToEachWs,
    secretsChanged,
    snapshotAppVisibility,
    snapshotWebhookAudience,
    transferAgentManager,
    agentsThatCannotMoveDown,
    afterMemberPackSaved,
  } = deps;
  // Restore (task 321e7b8e): what passed to the heir at the removal and the
  // heir still owns comes back to the member, as it is now; the rest stays
  // where it is. Schedules and webhooks come back turned off, as they passed.
  async function giveBackFromHeir(
    member: RemovedMember,
    moveBack: boolean,
    changedBy: string,
  ): Promise<Pick<MemberRestoreRes, "movedBack" | "stayed">> {
    const { passed, heirId } = member;
    const userId = member.user.id;
    const movedBack = {
      agentIds: [] as string[],
      cronjobIds: [] as string[],
      webhookIds: [] as string[],
    };
    const stayed = {
      agentIds: [] as string[],
      cronjobIds: [] as string[],
      webhookIds: [] as string[],
    };
    const all = [...passed.agentIds, ...passed.killedAgentIds];
    if (!moveBack || !heirId) {
      stayed.agentIds.push(...all);
      stayed.cronjobIds.push(...passed.cronjobIds);
      stayed.webhookIds.push(...passed.webhookIds);
      return { movedBack, stayed };
    }
    const killed = new Set<string>();
    for (const agentId of all) {
      const live = agentManager.getAgent(agentId);
      if (live?.userId === heirId) {
        const moved = await transferAgentManager(agentId, userId, changedBy);
        (typeof moved === "object" && moved !== null
          ? movedBack
          : stayed
        ).agentIds.push(agentId);
      } else if (
        !live &&
        agentManager.killedAgentManagerUserId(agentId) === heirId
      ) {
        killed.add(agentId);
      } else stayed.agentIds.push(agentId);
    }
    if (killed.size > 0) {
      const back = agentManager.reassignKilledAgents(
        heirId,
        { userId, manager: member.user.name },
        killed,
      );
      movedBack.agentIds.push(...back);
      stayed.agentIds.push(...[...killed].filter((id) => !back.includes(id)));
    }
    // The schedules and webhooks the member owned. Those an agent made came
    // back with it above.
    for (const id of passed.cronjobIds) {
      const job = cronjobManager.listCronjobs().find((j) => j.id === id);
      if (job?.userId === userId) movedBack.cronjobIds.push(id);
      else if (job?.userId === heirId) {
        try {
          cronjobManager.setCronjobOwner(id, userId, member.user.name);
          movedBack.cronjobIds.push(id);
        } catch (err) {
          console.error(`[users] schedule ${id} did not come back:`, err);
          stayed.cronjobIds.push(id);
        }
      } else stayed.cronjobIds.push(id);
    }
    const hookAudienceBefore = snapshotWebhookAudience((hook) =>
      passed.webhookIds.includes(hook.id),
    );
    for (const id of passed.webhookIds) {
      const hook = webhookRegistry.get(id);
      if (hook?.userId === userId) movedBack.webhookIds.push(id);
      else if (hook?.userId === heirId) {
        try {
          webhookRegistry.setOwner(id, userId, member.user.name);
          movedBack.webhookIds.push(id);
        } catch (err) {
          console.error(`[users] webhook ${id} did not come back:`, err);
          stayed.webhookIds.push(id);
        }
      } else stayed.webhookIds.push(id);
    }
    announceWebhookAudienceChanges(hookAudienceBefore);
    return { movedBack, stayed };
  }

  // The update_user split makes users.update responsible for record fields,
  // and for an owner caller a member's pack and allowedRooms with the role in
  // one write (task 2c57281c); users.setAccess = allowedRooms and the pack +
  // a prune-clamp of the target's existing notif/default; view prefs stay
  // self-only via view.*. EMIT-IN-DEP
  // (no user event sink): the seam runs updateUserById/deleteUser + the fanout,
  // mirroring the retired WS arms. Role/self authz is the route guard's
  // (selfOrOwner / officeOwner); the two delete preconditions add owner!=self +
  // not-last-owner.
  return usersHandlers({
    readMemberPrompt: (username) => {
      const user = getUser(username);
      return user ? { memberPrompt: user.memberPrompt } : null;
    },
    create: async ({
      name,
      role,
      memberPrompt,
      avatarColor,
      avatarVariant,
      allowedRooms,
      pack,
    }) => {
      // Room grants: members only (owners reach every room by rule, and
      // materialized owner grants are the demotion bomb), live rooms only -
      // an unknown id is refused, not pruned, so a stale owner UI can't
      // create a member with less access than the owner picked.
      const roomIds = agentManager.getOrdinaryRooms().map((r) => r.id);
      const grants = [...new Set(allowedRooms ?? [])];
      if (grants.length > 0 && role !== "member") {
        return {
          ok: false,
          status: 400,
          code: "invalid_rooms",
          error:
            "Room grants only apply to members (owners can reach every room).",
        };
      }
      const unknown = grants.find((id) => !roomIds.includes(id));
      if (unknown !== undefined) {
        return {
          ok: false,
          status: 400,
          code: "invalid_rooms",
          error: `Unknown room id: ${unknown}`,
        };
      }
      // A name createMember would refuse costs no seat call. The check
      // inside createMember still covers a race.
      const nameRefusal = memberNameRefusal(name);
      if (nameRefusal)
        return {
          ok: false,
          status: nameRefusal.code === "name_taken" ? 409 : 400,
          ...nameRefusal,
        };
      const seat = await enterpriseSeats().takeSeat(() =>
        createMember(name, {
          role,
          memberPrompt,
          avatarColor,
          avatarVariant,
          allowedRooms: grants,
          ...(pack && role === "member" ? { pack } : {}),
          // A new owner is notified for every room by default, like the
          // first owner; a member for the rooms granted here.
          ...(role === "owner" ? { notifRooms: roomIds } : {}),
        }),
      );
      if (!seat.ok) return enterpriseRefusal(seat);
      const r = seat.value;
      if (!r.ok) {
        // The seat call counted a member that was not added.
        enterpriseSeats().release();
        return {
          ok: false,
          status: r.code === "name_taken" ? 409 : 400,
          code: r.code,
          error: r.error,
        };
      }
      if (r.user.memberPrompt !== null) notePromptContent(r.user.memberPrompt);
      // No full_state/presence push: the member has no session yet.
      emitUsersList();
      return { ok: true, user: r.user };
    },
    update: async ({ username, changes, identity }) => {
      const target = getUser(username);
      if (!target) {
        return {
          ok: false,
          status: 404,
          code: "not_found",
          error: `User ${username} not found`,
        };
      }
      // Only a human owner: an agent's userId is its manager's.
      if (
        changes.role !== undefined &&
        (identity.scope !== "user" ||
          getUserById(identity.userId ?? "")?.role !== "owner")
      ) {
        return {
          ok: false,
          status: 403,
          code: "forbidden",
          error: "Only an office owner can change roles.",
        };
      }
      // A member's pack and room grants, in the same write as the role
      // (task 2c57281c): a human owner only, as for the role.
      const accessChange =
        changes.pack !== undefined || changes.allowedRooms !== undefined;
      if (
        accessChange &&
        (identity.scope !== "user" ||
          getUserById(identity.userId ?? "")?.role !== "owner")
      ) {
        return {
          ok: false,
          status: 403,
          code: "forbidden",
          error: "Only an office owner can change a member's access.",
        };
      }
      // Before the session lockout check, so a sole owner gets this answer.
      if (changes.role === "member" && wouldDeleteLeaveNoOwner(target.id)) {
        return {
          ok: false,
          status: 409,
          code: "last_owner",
          error: "The office must have at least one office owner.",
        };
      }
      // The checks, the snapshots and the write, on the record as it is
      // when they run. A demote of an owner runs them in one auth mutex link
      // with the session lockout check, after an await, so they read the
      // record again there.
      const write = () => {
        const pre = getUserById(target.id);
        if (!pre) {
          return {
            ok: false as const,
            status: 404 as const,
            code: "not_found",
            error: `User ${username} not found`,
          };
        }
        if (
          changes.memberPrompt !== undefined &&
          changes.memberPromptVersion !== versionOf(pre.memberPrompt ?? "")
        ) {
          return {
            ok: false as const,
            status: 409 as const,
            code: "version_conflict",
            error:
              "the member's special instructions changed since your read; re-read and retry",
            version: versionOf(pre.memberPrompt ?? ""),
          };
        }
        if (changes.role === "member" && wouldDeleteLeaveNoOwner(pre.id)) {
          return {
            ok: false as const,
            status: 409 as const,
            code: "last_owner",
            error: "The office must have at least one office owner.",
          };
        }
        const role = changes.role ?? pre.role;
        if (changes.pack && role === "owner") {
          return {
            ok: false as const,
            status: 400 as const,
            code: "owner_has_no_pack",
            error: "An office owner cannot have a permission pack.",
          };
        }
        // Owners reach every room by rule: materialized owner grants are the
        // demotion bomb (see create).
        if ((changes.allowedRooms?.length ?? 0) > 0 && role === "owner") {
          return {
            ok: false as const,
            status: 400 as const,
            code: "invalid_rooms",
            error:
              "Room grants only apply to members (owners can reach every room).",
          };
        }
        // Live rooms only, as create: an unknown id is refused, not pruned.
        const liveRooms = agentManager.getOrdinaryRooms().map((r) => r.id);
        const unknownRoom = changes.allowedRooms?.find(
          (id) => !liveRooms.includes(id),
        );
        if (unknownRoom !== undefined) {
          return {
            ok: false as const,
            status: 400 as const,
            code: "invalid_rooms",
            error: `Unknown room id: ${unknownRoom}`,
          };
        }
        // Nothing is written while an agent of the member could not move
        // down to the new ceiling.
        const stuck = changes.pack
          ? agentsThatCannotMoveDown(pre.id, changes.pack)
          : [];
        if (stuck.length > 0) {
          return {
            ok: false as const,
            status: 409 as const,
            code: AGENTS_CANNOT_MOVE_DOWN,
            error: `These agents cannot run at this pack's highest agent level with their engine and model: ${stuck.map((agent) => agent.name).join(", ")}. Change their engine or model, give them another manager, or kill them first.`,
          };
        }
        const roleChanged =
          changes.role !== undefined && changes.role !== pre.role;
        const audienceMayChange = roleChanged || accessChange;
        const appAudienceBefore = audienceMayChange
          ? snapshotAppVisibility(() => true)
          : null;
        const webhookAudienceBefore = audienceMayChange
          ? snapshotWebhookAudience(() => true)
          : null;
        const accessible = accessibleRoomIdsFor(
          { ...pre, role },
          changes.allowedRooms,
        );
        // Record fields, and a member's pack and room grants with the
        // atomic notif/push clamp over the new accessible set. View prefs
        // stay on view.*. Resolve by id so a rename can't strand the write.
        const reclamped = audienceMayChange
          ? clampViewFields(accessible, pre, {})
          : null;
        const result = updateUserById(pre.id, {
          role: changes.role,
          ...(changes.allowedRooms !== undefined
            ? { allowedRooms: changes.allowedRooms }
            : {}),
          ...(changes.pack !== undefined ? { pack: changes.pack } : {}),
          ...(reclamped
            ? {
                notifRooms: reclamped.notifRooms,
                pushRooms: reclamped.pushRooms,
              }
            : {}),
          name: changes.name,
          memberPrompt: changes.memberPrompt,
          avatarColor: changes.avatarColor,
          avatarVariant: changes.avatarVariant,
        });
        if (!result.ok) {
          const taken = /already exists/i.test(result.error);
          return {
            ok: false as const,
            status: taken ? (409 as const) : (400 as const),
            code: taken ? "name_taken" : "invalid_request",
            error: result.error,
          };
        }
        return {
          ok: true as const,
          user: result.user,
          pre,
          roleChanged,
          audienceMayChange,
          accessible,
          appAudienceBefore,
          webhookAudienceBefore,
        };
      };
      const written =
        changes.role === "member" && target.role === "owner"
          ? await removeOwnerUnlessStranding(target.id, write)
          : write();
      if (written === "would_strand_office") {
        return {
          ok: false,
          status: 409,
          code: "would_strand_office",
          error: OWNER_REMOVAL_LOCKOUT_REASON,
        };
      }
      if (!written.ok) return written;
      const {
        user,
        pre,
        roleChanged,
        audienceMayChange,
        accessible,
        appAudienceBefore,
        webhookAudienceBefore,
      } = written;
      // An agent's answer has no user record, so createdResource cannot
      // find the id: every caller's row names the member by id here.
      noteAuditTarget(user.id);
      if (changes.memberPrompt !== undefined)
        notePromptContent(user.memberPrompt);
      // A role change already re-projected the subject's sockets (session,
      // owner room list, rooms, board, cronjobs) through the users.ts access
      // hook inside updateUserById.
      const renamed = username.toLowerCase() !== user.name.toLowerCase();
      // Condition the PUBLIC refresh on an actual public-field delta.
      // users.update can touch PUBLIC fields or PRIVATE-only ones. UserPublicWire
      // is id|name|role|avatarColor|avatarVariant|createdAt, and of those this
      // route mutates only role/name/avatarColor/avatarVariant; prompt is private.
      // A private-only edit changes nothing in the public projection, so a public
      // user_updated/users_list would be a pure timing signal that the record
      // changed - the leak setAccess avoids. Mirror setAccess: owners always get
      // the full record via the owners-only admin event and the subject via its
      // own self event; the all-audience public channels fire ONLY when a public
      // field actually changed. (`pre` is the pre-image: updateUserById writes a
      // new record, it does not mutate the object getUserById returned.)
      const publicChanged =
        roleChanged ||
        user.name !== pre.name ||
        user.avatarColor !== pre.avatarColor ||
        user.avatarVariant !== pre.avatarVariant;
      // The name snapshots on the member's agents, schedules and hooks follow
      // the rename. The rename is written: a failure here must not answer an
      // error.
      if (user.name !== pre.name) {
        try {
          agentManager.renameManager(user.id, user.name);
          for (const job of cronjobManager.listCronjobs())
            if (job.userId === user.id && job.username !== user.name)
              cronjobManager.setCronjobOwner(job.id, user.id, user.name);
          for (const hook of webhookRegistry.syncOwnerNames((id) =>
            id === user.id ? user.name : undefined,
          ))
            announceWebhookUpdate(hook);
        } catch (err) {
          console.error(
            `[users] the rename of ${user.id} did not reach every snapshot:`,
            err,
          );
        }
      }
      if (publicChanged) {
        emitUserUpdated(user, renamed ? username : undefined);
        emitUsersList();
        // Invite rows name a member by the current name: re-send them so the
        // open lists match the new name.
        if (user.name !== pre.name) emitInvitesList();
      } else {
        emitPrivateUserRecord(user);
      }
      const presenceTouched = refreshPresenceForUser(
        user.id,
        {
          name: user.name,
          avatarColor: user.avatarColor,
          avatarVariant: user.avatarVariant,
        },
        audienceMayChange ? accessible : undefined,
      );
      if (audienceMayChange) {
        if (appAudienceBefore) announceAppAudienceChanges(appAudienceBefore);
        if (webhookAudienceBefore) {
          announceWebhookAudienceChanges(webhookAudienceBefore);
        }
      }
      if (presenceTouched || audienceMayChange) pushPresenceListToEachWs();
      // As setAccess: the member's agents move down, their apps stop and
      // their pages reload.
      if (changes.pack !== undefined) afterMemberPackSaved(user.id);
      return { ok: true, user };
    },
    setAccess: async ({ username, allowedRooms, pack }) => {
      const target = getUser(username);
      if (!target) {
        return {
          ok: false,
          status: 404,
          code: "not_found",
          error: `User ${username} not found`,
        };
      }
      if (pack && target.role === "owner") {
        return {
          ok: false,
          status: 400,
          code: "owner_has_no_pack",
          error: "An office owner cannot have a permission pack.",
        };
      }
      // Nothing is written while an agent of the member could not move down
      // to the new ceiling.
      const stuck = pack ? agentsThatCannotMoveDown(target.id, pack) : [];
      if (stuck.length > 0) {
        return {
          ok: false,
          status: 409,
          code: AGENTS_CANNOT_MOVE_DOWN,
          error: `These agents cannot run at this pack's highest agent level with their engine and model: ${stuck.map((agent) => agent.name).join(", ")}. Change their engine or model, give them another manager, or kill them first.`,
        };
      }
      // ATOMIC clamp: compute the new accessible set from the INCOMING
      // allowedRooms and prune the target's existing notifRooms and pushRooms
      // to fit, in ONE
      // updateUserById write. An empty `change` re-clamps the current view
      // fields (clampViewFields reads `current`).
      const accessible = accessibleRoomIdsFor(target, allowedRooms);
      const appAudienceBefore = snapshotAppVisibility(() => true);
      const webhookAudienceBefore = snapshotWebhookAudience(() => true);
      const clamped = clampViewFields(accessible, target, {});
      const changes: {
        allowedRooms: string[];
        notifRooms: string[];
        pushRooms: string[];
        pack?: MemberPack | null;
      } = {
        allowedRooms,
        notifRooms: clamped.notifRooms,
        pushRooms: clamped.pushRooms,
        ...(pack !== undefined ? { pack } : {}),
      };
      const result = updateUserById(target.id, changes);
      if (!result.ok) {
        return {
          ok: false,
          status: 500,
          code: "set_access_failed",
          error: result.error,
        };
      }
      // setAccess is a PRIVATE-only mutation (allowedRooms + the notif/default
      // clamp), so it emits ONLY the scoped channels - NO public user_updated /
      // users_list, which would leak the timing+target of an access change to
      // every user. Owners get the new grants via the owners-only admin event;
      // the target re-projects via full_state and its own self event; presence
      // sanitizes currentRoomId.
      // The re-projection itself (rooms, board, cronjobs) already ran through
      // the users.ts access hook inside updateUserById.
      // The row names the member by id too, so it survives a rename.
      noteAuditTarget(result.user.id);
      emitPrivateUserRecord(result.user);
      const presenceTouched = refreshPresenceForUser(
        result.user.id,
        {
          name: result.user.name,
          avatarColor: result.user.avatarColor,
          avatarVariant: result.user.avatarVariant,
        },
        accessibleRoomIdsFor(result.user),
      );
      if (presenceTouched) pushPresenceListToEachWs();
      announceAppAudienceChanges(appAudienceBefore);
      announceWebhookAudienceChanges(webhookAudienceBefore);
      if (pack !== undefined) afterMemberPackSaved(result.user.id);
      return { ok: true, user: result.user };
    },
    delete: async ({ username, actor }) => {
      const target = getUser(username);
      const appAudienceBefore = target
        ? snapshotAppVisibility(
            (app) =>
              app.userId === target.id ||
              agentManager
                .getAllAgents()
                .some(
                  (agent) =>
                    agent.userId === target.id &&
                    agent.id === app.createdByAgentId,
                ),
          )
        : new Map<string, AppVisibilityFacts>();
      const lastOwnerRecord = {
        ok: false as const,
        status: 409 as const,
        code: "would_strand_office",
        error:
          "This is the last owner record. Promote another user to owner first, then retry.",
      };
      const lastOwnerSession = {
        ok: false as const,
        status: 409 as const,
        code: "would_strand_office",
        error: OWNER_REMOVAL_LOCKOUT_REASON,
      };
      // Both lockout checks before any side effect, so a refused delete
      // moves nothing. They run again with the record removal below: the
      // awaits between can let a sign-out or another delete land.
      // owner!=self is enforced by userDeleteNotSelfOwner upstream.
      if (target && wouldDeleteLeaveNoOwner(target.id)) return lastOwnerRecord;
      if (target && (await ownerRemovalWouldStrandOffice(target.id))) {
        return lastOwnerSession;
      }
      // The member's agents, live and killed, pass to the oldest office
      // owner with the apps, schedules and webhooks they made (Nil,
      // 2026-10-20), and so do the member's own schedules and webhooks.
      // All the schedules and webhooks pass off (Nil, 2026-10-25). After
      // the 409s above, so a refused delete moves nothing; before the
      // record goes, so the sessions' manager stamps still find the
      // member's name. The caller can be the member.
      const passed: RemovedMember["passed"] = {
        agentIds: [],
        killedAgentIds: [],
        cronjobIds: [],
        webhookIds: [],
      };
      const heir = target ? heirOwnerFor(target.id) : undefined;
      if (target && heir) {
        // Taken before the agent transfers move the hooks the agents made.
        const hookIds = webhookRegistry
          .list()
          .filter((hook) => hook.userId === target.id)
          .map((hook) => hook.id);
        passed.webhookIds = hookIds;
        passed.cronjobIds = cronjobManager
          .listCronjobs()
          .filter((job) => job.userId === target.id)
          .map((job) => job.id);
        const hookAudienceBefore = snapshotWebhookAudience((hook) =>
          hookIds.includes(hook.id),
        );
        turnOffMemberRecords(target.id, hookIds);
        for (const agent of agentManager.getAllAgents())
          if (agent.userId === target.id) {
            await transferAgentManager(agent.id, heir.id, actor);
            passed.agentIds.push(agent.id);
          }
        passed.killedAgentIds = agentManager.reassignKilledAgents(target.id, {
          userId: heir.id,
          manager: heir.name,
        });
        passMemberRecordsToHeir(target.id, hookIds, heir);
        announceWebhookAudienceChanges(hookAudienceBefore);
      }
      // The member goes to Removed members for 30 days (task 321e7b8e).
      // The archive is written before anything live goes, so a crash part
      // way leaves the member live, and the boot drops the archive (the
      // live record wins). It keeps the variables whole and the secrets
      // and MCP servers without a value or a sign-in: secret values go
      // with the member (Nil, 2026-11-02).
      if (target) {
        const connections = archivedConnectionsOf(target.id, mcpSources);
        archiveRemovedMember(
          {
            user: target,
            removedAt: Date.now(),
            removedBy: actor,
            heirId: heir?.id ?? null,
            heirName: heir?.name ?? null,
            passed,
          },
          connections,
        );
      }
      // The member's own secrets, variables, MCP servers and provider
      // sign-ins go from the live stores, before the record: a failed delete leaves the member, and
      // a retry finishes the job. Their API tokens go too, so a restore
      // brings none back.
      if (target) {
        mcpSources.secrets.removeMember(target.id);
        mcpSources.servers.removeMember(target.id);
        dropOAuthTokensOfScope({ kind: "user", userId: target.id });
        removeManagedUserEnv(target.id);
        webPushStore.removeMember(target.id);
        // Logs the linked device out and deletes the WhatsApp session.
        await whatsappSupervisor.removeMember(target.id);
        // Stops their Discord bots and deletes the tokens and routes.
        await discordSupervisor.removeMember(target.id);
        removeMemberSkillFolders(target.id);
        // Their own Claude and Codex sign-ins (task 548d607b). Another
        // member's agent can still run a Claude session pinned to that home,
        // with the token in memory: its process is released.
        await providerAccounts.signOutRemovedMember(target.id);
        agentManager.releaseClaudeRoot(
          personalProviderHome(target.id, "claude"),
        );
        await revokeApiTokensOfUser(target.id);
        // A paired browser would connect again after a restore.
        extensionService?.store.revoke(target.id);
      }
      // The lockout checks again, in one auth mutex link with the removal.
      // A refusal here leaves the member with the steps above done, like
      // a failed delete: their follow-ups still run, the removal's do not.
      // The member is live, so they leave Removed members at once.
      let refusal: typeof lastOwnerRecord | null = null;
      if (target) {
        const removed = await removeOwnerUnlessStranding(target.id, () => {
          if (wouldDeleteLeaveNoOwner(target.id)) return lastOwnerRecord;
          deleteUserById(target.id);
          return null;
        });
        refusal =
          removed === "would_strand_office" ? lastOwnerSession : removed;
        if (refusal) dropRemovedMember(target.id);
      } else {
        // Idempotent: deleteUser is a no-op for an unknown username; the
        // users_list broadcast still fires so a watcher sees the target
        // absent.
        deleteUser(username);
      }
      if (!refusal) {
        emitUsersList();
        emitRemovedMembers();
        if (target) enterpriseSeats().release();
      }
      if (target) {
        // The proxy drops the secrets. The member's agents passed to the
        // heir above, so none of them still carries the member's.
        try {
          await secretsChanged();
        } catch {
          console.error("[secrets] the proxy did not take a change");
        }
        agentManager.refreshLimitedClaudeFamilies(target.id);
        if (!refusal) {
          await evictSessionsForUserId(target.id);
          if ((await revokeInvitesForUser(target)) > 0) emitInvitesList();
        }
      }
      announceAppAudienceChanges(appAudienceBefore);
      return refusal ?? { ok: true };
    },
    removedList: () => listRemovedMembers().map(removedMemberWire),
    restore: async ({ id, agents, actor }) => {
      const member = getRemovedMember(id);
      if (!member)
        return {
          ok: false,
          status: 404,
          code: "not_found",
          error: "No removed member has this id.",
        };
      // A removed member's name is reserved, so a clash here is a record
      // edited by hand.
      if (getUserById(id) || getUser(member.user.name))
        return {
          ok: false,
          status: 409,
          code: "name_taken",
          error: `User "${member.user.name}" already exists`,
        };
      // Files first, then the record, then the archive goes: the live
      // record wins at boot, so a crash part way loses nothing. A refused
      // seat moves nothing.
      const seat = await enterpriseSeats().takeSeat(() => {
        const connections = readArchivedConnections(id);
        restoreArchivedFiles(id);
        mcpSources.secrets.importShapes(id, connections.secrets);
        mcpSources.servers.importFromArchive(id, connections.mcpServers);
        return restoreUserRecord(member.user);
      });
      if (!seat.ok) return enterpriseRefusal(seat);
      const restored = seat.value;
      if (!restored.ok) enterpriseSeats().release();
      if (!restored.ok)
        return {
          ok: false,
          status: 409,
          code: "name_taken",
          error: restored.error,
        };
      pruneStaleRoomRefs(
        agentManager.getOrdinaryRooms().map((room) => room.id),
      );
      dropRemovedMember(id);
      const result = await giveBackFromHeir(member, agents, actor);
      emitUsersList();
      emitRemovedMembers();
      try {
        await secretsChanged();
      } catch {
        console.error("[secrets] the proxy did not take a change");
      }
      return {
        ok: true,
        result: { user: getUserById(id) ?? restored.user, ...result },
      };
    },
    purge: async ({ id }) => {
      if (!getRemovedMember(id))
        return {
          ok: false,
          status: 404,
          code: "not_found",
          error: "No removed member has this id.",
        };
      purgeRemovedMember(id);
      emitRemovedMembers();
      return { ok: true };
    },
    attributionFor,
  });
}
