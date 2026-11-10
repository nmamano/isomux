// The office side of action asks (task e3d1bc63): the reads server/step-asks.ts
// checks and builds an action step with, and the in-process run of an office
// route as a caller, shared by a member's Apply and the /mcp tool calls.

import { accessGrantOf } from "../shared/agent-access.ts";
import type { AgentAccess } from "../shared/agent-access.ts";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type UserRecord,
} from "../shared/types.ts";
import type { SpawnAccessRefusal } from "./agent-manager.ts";
import {
  buildPublicOrigin,
  listActiveSessionsForUserId,
  listInvitesForUser,
  sessionPrefixOfHash,
  wouldRevokeMemberSessionStrandOffice,
  wouldRemovingOwnerStrandOffice,
} from "./auth.ts";
import { listApiTokens, liveApiTokenOwner } from "./api-tokens.ts";
import type { GuardDeps } from "./identity/guards.ts";
import { identityFromSession, type Identity } from "./identity/index.ts";
import { withMemberPack } from "./identity/member-pack.ts";
import {
  agentManager,
  whatsappRoutes,
  whatsappSupervisor,
} from "./office-managers.ts";
import { STATE_ROOT } from "./config.ts";
import { readLink } from "./whatsapp/store.ts";
import {
  authorizeRoute,
  executeRoute,
  type ExecutorDeps,
} from "./routes/executor.ts";
import { matchRoute } from "./routes/match.ts";
import { API_ROUTES } from "./routes/table.ts";
import type { StepRunDeps } from "./step-asks.ts";
import { loadBackupSettings } from "./backup.ts";
import { getUser, getUserById, wouldDeleteLeaveNoOwner } from "./users.ts";
import { getRemovedMember, listRemovedMembers } from "./removed-members.ts";
import { getUpdateStatus } from "./update-checker.ts";
import type { StorageOps } from "./office-storage-routes.ts";

// Runs one office route in process as `identity`, through the executor, so
// the route's guards, preconditions, events and audit row apply.
export function createInProcessDispatch(executorDeps: () => ExecutorDeps) {
  return async (
    identity: Identity,
    method: string,
    path: string,
    body: unknown,
    opts: Parameters<typeof executeRoute>[4],
  ): Promise<{ status: number; body: unknown }> => {
    const deps = executorDeps();
    const url = new URL(path, buildPublicOrigin().origin);
    const match = matchRoute(API_ROUTES, method, url.pathname);
    if (!match || !deps.handlers.has(match.route.opId))
      return { status: 404, body: { error: { code: "not_found" } } };
    const res = await executeRoute(
      match,
      new Request(url, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
      identity,
      deps,
      opts,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

export function officeStepRuns(deps: {
  guardDeps: () => GuardDeps;
  officeSettings: StepRunDeps["officeSettings"];
  // Every room the member reaches, hidden ones included.
  accessibleRoomIdsFor: (user: UserRecord) => ReadonlySet<string>;
  accessChangeRefusal: (
    agent: AgentInfo,
    access: AgentAccess,
  ) => SpawnAccessRefusal | null;
  officeAccess: StepRunDeps["officeAccess"];
  tokenLimitableRoomIds: StepRunDeps["tokenLimitableRoomIds"];
  storage: StorageOps;
}): StepRunDeps {
  // The asking agent's reach, as its token has it: its manager's rooms.
  function agentReachesRoom(askingAgentId: string, roomId: string): boolean {
    const asker = agentManager.getAgent(askingAgentId);
    if (!asker?.userId) return false;
    return deps.guardDeps().hasRoomAccess(
      {
        scope: "agent",
        userId: asker.userId,
        agentId: asker.id,
        role: "member",
        capabilities: [],
      },
      roomId,
    );
  }

  return {
    agent: (agentId) => {
      const agent = agentManager.getAgent(agentId);
      return agent ? { name: agent.name, grant: accessGrantOf(agent) } : null;
    },
    agentReaches: (askingAgentId, targetAgentId) => {
      const target = agentManager.getAgent(targetAgentId);
      return !!target && agentReachesRoom(askingAgentId, target.roomId);
    },
    member: (userId) => {
      const user = getUserById(userId);
      return user
        ? { name: user.name, role: user.role, allowedRooms: user.allowedRooms }
        : null;
    },
    memberSettings: (userId) => {
      const user = getUserById(userId);
      return user
        ? {
            pack: user.pack ?? null,
            language: user.language ?? null,
            ...(user.voiceInput ? { voiceInput: user.voiceInput } : {}),
            ...(user.voiceOutput ? { voiceOutput: user.voiceOutput } : {}),
            ...(user.voiceName ? { voiceName: user.voiceName } : {}),
            accessible: [...deps.accessibleRoomIdsFor(user)],
            hidden: user.hidden,
            tucked: user.tucked,
            notifRooms: user.notifRooms,
            pushRooms: user.pushRooms,
          }
        : null;
    },
    officeSettings: deps.officeSettings,
    whatsapp: {
      linked: (userId) => readLink(STATE_ROOT, userId) !== null,
      chatsSeen: (userId) => whatsappSupervisor.chatsSeen(userId),
      rows: (userId) => whatsappRoutes.rows(userId),
      agentProblem: (userId, agentId) =>
        whatsappRoutes.agentProblem(userId, agentId),
    },
    backupSettings: loadBackupSettings,
    backupDirFromEnv: () => !!process.env.ISOMUX_BACKUP_DIR,
    roomName: (roomId) =>
      agentManager.getRooms().find((room) => room.id === roomId)?.name ?? null,
    memberIdByName: (username) => getUser(username)?.id ?? null,
    roomOpen: (roomId) =>
      roomId === LOBBY_ROOM_ID ||
      agentManager.getOrdinaryRooms().some((room) => room.id === roomId),
    agentReachesRoom,
    lastOwner: wouldDeleteLeaveNoOwner,
    accessRefusal: (agentId, grant) => {
      const agent = agentManager.getAgent(agentId);
      const refusal = agent
        ? deps.accessChangeRefusal(agent, grant.access)
        : null;
      return refusal
        ? { code: refusal.refused, message: refusal.message }
        : null;
    },
    memberSessions: (userId, callerSessionIdHash) => {
      const current = callerSessionIdHash
        ? sessionPrefixOfHash(callerSessionIdHash)
        : null;
      return listActiveSessionsForUserId(userId).map((v) => ({
        prefix: v.sessionPrefix,
        createdAt: v.createdAt,
        current: v.sessionPrefix === current,
      }));
    },
    memberInvites: (userId) => {
      const user = getUserById(userId);
      return user
        ? listInvitesForUser(user).map((i) => ({
            prefix: i.tokenPrefix,
            createdAt: i.createdAt,
          }))
        : [];
    },
    memberApiTokens: (userId) => {
      const now = Date.now();
      return listApiTokens(userId)
        .filter((t) => t.expiresAt === null || t.expiresAt > now)
        .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }));
    },
    apiToken: (tokenId) => {
      const userId = liveApiTokenOwner(tokenId);
      return userId ? { userId } : null;
    },
    tokenLimitableRoomIds: deps.tokenLimitableRoomIds,
    officeAccess: deps.officeAccess,
    removedMember: (userId) => {
      const removed = getRemovedMember(userId);
      return removed ? { name: removed.user.name } : null;
    },
    removedMemberIdByName: (username) =>
      listRemovedMembers().find((m) => m.user.name === username)?.user.id ??
      null,
    updateStatus: getUpdateStatus,
    pruneCandidates: (target, olderThanDays, keepPerAgent) =>
      deps.storage.planPrune(target, { olderThanDays, keepPerAgent }).candidates
        .length,
    compressCandidates: (olderThanDays) =>
      deps.storage.planCompress(olderThanDays).candidates.length,
    lastPrune: (target) => deps.storage.lastPrune(target),
    lastCompress: () => deps.storage.lastCompress(),
    // A verdict at the create; the revoke checks again inside the auth mutex.
    signOutStrandsOffice: wouldRemovingOwnerStrandOffice,
    sessionRevokeStrandsOffice: wouldRevokeMemberSessionStrandOffice,
    // The member as their session would be, judged on the route. Runs
    // nothing.
    authorizeAs: (memberUserId, route) => {
      const user = getUserById(memberUserId);
      const match = matchRoute(API_ROUTES, route.method, route.path);
      if (!user || !match)
        return { status: 404, code: "not_found", message: "not found" };
      const refused = authorizeRoute(
        match.route,
        withMemberPack(
          identityFromSession({ userId: user.id, role: user.role }),
          getUserById,
        ),
        match.params,
        route.body,
        deps.guardDeps(),
      );
      return refused?.kind === "error"
        ? {
            status: refused.status === 404 ? 404 : 403,
            code: refused.code,
            message: refused.message ?? refused.code,
          }
        : null;
    },
  };
}
