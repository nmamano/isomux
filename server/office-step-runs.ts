// The office side of action asks (task e3d1bc63): the reads server/step-asks.ts
// checks and builds an action step with, and the in-process run of an office
// route as a caller, shared by a member's Apply and the /mcp tool calls.

import { accessGrantOf, belowStandard } from "../shared/agent-access.ts";
import type { AgentAccess } from "../shared/agent-access.ts";
import { LOBBY_ROOM_ID, type AgentInfo } from "../shared/types.ts";
import type { SpawnAccessRefusal } from "./agent-manager.ts";
import { buildPublicOrigin } from "./auth.ts";
import type { GuardDeps } from "./identity/guards.ts";
import { identityFromSession, type Identity } from "./identity/index.ts";
import { withMemberPack } from "./identity/member-pack.ts";
import { agentManager } from "./office-managers.ts";
import {
  authorizeRoute,
  executeRoute,
  type ExecutorDeps,
} from "./routes/executor.ts";
import { matchRoute } from "./routes/match.ts";
import { API_ROUTES } from "./routes/table.ts";
import type { StepRunDeps } from "./step-asks.ts";
import { getUser, getUserById, wouldDeleteLeaveNoOwner } from "./users.ts";

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
  accessChangeRefusal: (
    agent: AgentInfo,
    access: AgentAccess,
  ) => SpawnAccessRefusal | null;
}): StepRunDeps {
  // The asking agent's reach, as its token has it: its manager's rooms,
  // narrowed to its pack's rooms below Standard.
  function agentReachesRoom(askingAgentId: string, roomId: string): boolean {
    const asker = agentManager.getAgent(askingAgentId);
    if (!asker?.userId) return false;
    const { access, pack } = accessGrantOf(asker);
    const rooms = belowStandard(access) ? pack?.rooms : undefined;
    return deps.guardDeps().hasRoomAccess(
      {
        scope: "agent",
        userId: asker.userId,
        agentId: asker.id,
        role: "member",
        capabilities: [],
        ...(rooms ? { apiTokenLimits: { rooms } } : {}),
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
