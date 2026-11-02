// Production GuardDeps adapter. Wires the guard catalog's injected office-state
// seam (GuardDeps, server/identity/guards.ts) to TODAY's live predicates. See
// internal-docs/generic-runtime-refactor.md →
// Guard catalog + "Rule-based access".
//
// Does NOT import server/isomux-office.ts (no cycle, no boot side-effects): the live
// readers are INJECTED by the isomux-office.ts seam, which already holds them in scope.
// This keeps the adapter a small, unit-testable translation layer - the bit
// worth testing (agentId → GLOBAL room id resolution, unknown-agent → null,
// username/cronjob lookups) is exercised with tiny fakes, and an integration T1
// proves it agrees with the live rule-based ACL.
//
import { withinTokenRooms, type Identity } from "./index.ts";
import type { CeilingManager, GuardDeps } from "./guards.ts";
import {
  agentAccessOf,
  stopHasPack,
  type AgentAccess,
} from "../../shared/agent-access.ts";
import type { ApiTokenLimits } from "../../shared/api-token-limits.ts";
import { managerRoomsOf, type FitTarget } from "../../shared/pack-fit.ts";

// The minimal live readers the adapter needs, as structural shapes so the
// production managers' richer return types (AgentInfo / RoomWire / UserRecord /
// Cronjob) satisfy them and tests can pass trivial fakes.
export interface GuardDepsLiveReaders {
  // The live RULE-BASED access predicate for a user, keyed by userId:
  // sessionHasFullRoomAccess(session) || roomAllowedForSession(session, roomId)
  // (both now route through canAccess: owners by rule, members by grants), with
  // session reduced to { userId }. The isomux-office.ts seam supplies this closure.
  hasRoomAccessForUser(userId: string, roomId: string): boolean;
  // The live agent roster. Guards read each agent's authoritative
  // roomId - the dense AgentInfo.room index has been removed from the wire.
  // `userId` is the agent's MANAGER (its spawning user) - used by the
  // agents.setPrivileged manager-match gate. The live AgentInfo carries it.
  // `spawnedByAgentId` gates agents.kill for an ordinary agent.
  // `access`, `privileged` and `pack` give the pack rule its target.
  getAllAgents(): readonly {
    id: string;
    roomId: string;
    userId: string | null;
    spawnedByAgentId?: string;
    access?: AgentAccess;
    privileged?: boolean;
    pack?: ApiTokenLimits;
  }[];
  // The live global rooms list (dense, creation order); index → roomId.
  getRooms(): readonly { id: string }[];
  // The spawning userId recorded for a KILLED agent (history entry on disk, no
  // live-roster entry), or null for a live/unknown/user-less one.
  // agentManager.killedAgentManagerUserId, which owns the live-map exclusion -
  // it holds the authoritative map, so asking it avoids re-deriving "killed"
  // from a second snapshot here.
  killedAgentManagerUserId(agentId: string): string | null;
  // The room recorded for a KILLED agent, or null for a live/unknown one.
  // agentManager.killedAgentLastRoomId.
  killedAgentLastRoomId(agentId: string): string | null;
  // A cronjob run stream's visibility to an identity: its job's, read live.
  // The seam owns the stream -> run -> job lookup and the cronjob visibility
  // rule; any id that is not a known run's stream is false.
  cronRunVisibleTo(identity: Identity, streamId: string): boolean;
  // Username → user record (or null). users.getUserByName.
  getUserByName(username: string): { id: string } | null;
  // User id -> live role. The app-control guard asks about the agent or API
  // token's user through this seam rather than trusting identity.role.
  getUserById(userId: string): { role: "owner" | "member" } | null;
  // User id -> the live record the agent ceiling reads (users.getUserById).
  userRecordById?(userId: string): CeilingManager | null;
  // The live cronjob list; id → creator userId. cronjobManager.listCronjobs.
  listCronjobs(): readonly {
    id: string;
    userId?: string | null;
    createdByAgentId?: string;
  }[];
  // The registered apps; name → owner userId. appRegistry.list. A corrupt
  // registry THROWS here rather than reading as an empty list - see the
  // adapter below for why the guard lets that through.
  listApps(): readonly { name: string; userId?: string | null }[];
  // The registered webhooks; id -> owner userId and maker agent.
  // webhookRegistry.list. A corrupt registry throws here, like listApps.
  listWebhooks(): readonly {
    id: string;
    userId: string;
    createdByAgentId?: string;
  }[];
  resourceRoomId?(
    kind: "app" | "webhook" | "cronjob",
    id: string,
  ): string | null;
  apiTokenHeardFrom(tokenId: string, agentId: string): boolean;
  // A killed agent's last stop and pack (agentManager.killedAgentGrant).
  killedAgentGrant?(agentId: string): Omit<FitTarget, "roomId"> | null;
  // agentManager.agentHeardFrom.
  agentHeardFrom?(receiverId: string, writerId: string): boolean;
  // agentManager.memberHeardFrom.
  memberHeardFrom?(userId: string, agentId: string): boolean;
}

export function buildProductionGuardDeps(
  live: GuardDepsLiveReaders,
): GuardDeps {
  return {
    hasRoomAccess(identity: Identity, roomId: string): boolean {
      // A null userId (an identity with no owning user) has access to nothing.
      if (!identity.userId) return false;
      // A room-limited API token reaches a room only while its member does too.
      if (!withinTokenRooms(identity, roomId)) return false;
      return live.hasRoomAccessForUser(identity.userId, roomId);
    },

    resourceRoomId(kind, id) {
      return live.resourceRoomId?.(kind, id) ?? null;
    },

    apiTokenHeardFrom(tokenId, agentId) {
      return live.apiTokenHeardFrom(tokenId, agentId);
    },

    agentFitTarget(agentId) {
      const agent = live.getAllAgents().find((a) => a.id === agentId);
      if (!agent) return null;
      const access = agentAccessOf(agent);
      const managerRooms = managerRoomsOf(
        agent.userId ? live.userRecordById?.(agent.userId) : null,
      );
      return {
        access,
        ...(stopHasPack(access) && agent.pack ? { pack: agent.pack } : {}),
        roomId: agent.roomId,
        ...(managerRooms ? { managerRooms } : {}),
      };
    },

    killedAgentGrant(agentId) {
      return live.killedAgentGrant?.(agentId) ?? null;
    },

    agentManagerOf(agentId) {
      const userId = live
        .getAllAgents()
        .find((agent) => agent.id === agentId)?.userId;
      return userId ? (live.userRecordById?.(userId) ?? null) : null;
    },

    userById(userId) {
      return live.userRecordById?.(userId) ?? null;
    },

    agentHeardFrom(receiverId, writerId) {
      return live.agentHeardFrom?.(receiverId, writerId) ?? false;
    },

    memberHeardFrom(userId, agentId) {
      return live.memberHeardFrom?.(userId, agentId) ?? false;
    },

    roomIdForAgent(agentId: string): string | null {
      const agent = live.getAllAgents().find((a) => a.id === agentId);
      if (!agent) return null; // unknown agent collapses with inaccessible
      // The agent's authoritative roomId IS the global room id - no
      // index hop. Validate it still names a live room so a dangling roomId
      // collapses to inaccessible (preserving the out-of-range → null
      // contract). Guards reason over global ids; the per-recipient room
      // projection is a wire concern, never an authz one.
      // The canonical room list includes the lobby.
      return live.getRooms().some((r) => r.id === agent.roomId)
        ? agent.roomId
        : null;
    },

    userIdForUsername(username: string): string | null {
      return live.getUserByName(username)?.id ?? null;
    },

    isOfficeOwnerUserId(userId: string): boolean {
      return live.getUserById(userId)?.role === "owner";
    },

    cronjobCreatorUserId(cronjobId: string): string | null {
      const job = live.listCronjobs().find((j) => j.id === cronjobId);
      return job?.userId ?? null;
    },

    cronjobCreatorAgentId(cronjobId: string): string | null {
      const job = live.listCronjobs().find((j) => j.id === cronjobId);
      return job?.createdByAgentId ?? null;
    },

    agentSpawnerAgentId(agentId: string): string | null {
      return (
        live.getAllAgents().find((a) => a.id === agentId)?.spawnedByAgentId ??
        null
      );
    },

    appOwnerUserId(name: string): string | null {
      // Deliberately NOT wrapped in a try/catch. A corrupt app registry must
      // not degrade into "no app has an owner", which would answer 403 for
      // every app including the caller's own; the throw propagates to the
      // executor, which logs it and answers 500 - a loud failure, which is the
      // registry's whole posture (see server/app-registry.ts).
      const app = live.listApps().find((a) => a.name === name);
      // Unknown app collapses with unowned into the same null (non-leak deny).
      return app?.userId ?? null;
    },

    webhookOwnerUserId(id: string): string | null {
      // Not caught, as appOwnerUserId: a corrupt registry answers 500.
      return live.listWebhooks().find((w) => w.id === id)?.userId ?? null;
    },

    webhookCreatorAgentId(id: string): string | null {
      return (
        live.listWebhooks().find((w) => w.id === id)?.createdByAgentId ?? null
      );
    },

    agentManagerUserId(agentId: string): string | null {
      const agent = live.getAllAgents().find((a) => a.id === agentId);
      // Unknown agent collapses with unowned into the same null (non-leak deny).
      return agent?.userId ?? null;
    },

    killedAgentManagerUserId(agentId: string): string | null {
      return live.killedAgentManagerUserId(agentId);
    },

    killedAgentLastRoomId(agentId: string): string | null {
      return live.killedAgentLastRoomId(agentId);
    },

    roomExists(roomId: string): boolean {
      return live.getRooms().some((r) => r.id === roomId);
    },

    cronRunVisibleTo(identity: Identity, streamId: string): boolean {
      return live.cronRunVisibleTo(identity, streamId);
    },
  };
}
