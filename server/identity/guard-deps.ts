// Production GuardDeps adapter — Phase 2.3 (deferred from 2.2). Wires the guard
// catalog's injected office-state seam (GuardDeps, server/identity/guards.ts) to
// TODAY's live predicates. See internal-docs/generic-runtime-refactor.md →
// Guard catalog + "Rule-based access".
//
// Does NOT import server/index.ts (no cycle, no boot side-effects): the live
// readers are INJECTED by the index.ts seam, which already holds them in scope.
// This keeps the adapter a small, unit-testable translation layer — the bit
// worth testing (agentId → GLOBAL room id resolution, unknown-agent → null,
// username/cronjob lookups) is exercised with tiny fakes, and an integration T1
// proves it agrees with the live rule-based ACL.
//
// ADDITIVE: constructed at boot and exposed (dormant) on the ServerHandle. In
// 2.3 nothing consumes it — Phase 3 feeds it to authorize() when routes migrate.
// Phase 3b swapped the access model (materialized → rule-based) by changing
// `hasRoomAccessForUser`'s body, never this adapter's shape.

import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";

// The minimal live readers the adapter needs, as structural shapes so the
// production managers' richer return types (AgentInfo / RoomWire / UserRecord /
// Cronjob) satisfy them and tests can pass trivial fakes.
export interface GuardDepsLiveReaders {
  // The live RULE-BASED access predicate for a user, keyed by userId:
  // sessionHasFullRoomAccess(session) || roomAllowedForSession(session, roomId)
  // (both now route through canAccess: owners by rule, members by grants), with
  // session reduced to { userId }. The index.ts seam supplies this closure.
  hasRoomAccessForUser(userId: string, roomId: string): boolean;
  // The live agent roster. Phase 3c: guards read each agent's authoritative
  // roomId — the dense AgentInfo.room index has been removed from the wire.
  // `userId` is the agent's MANAGER (its spawning user) — used by the
  // agents.setPrivileged manager-match gate. The live AgentInfo carries it.
  getAllAgents(): readonly {
    id: string;
    roomId: string;
    userId: string | null;
  }[];
  // The live global rooms list (dense, creation order); index → roomId.
  getRooms(): readonly { id: string }[];
  // Username → user record (or null). users.getUserByName.
  getUserByName(username: string): { id: string } | null;
  // The live cronjob list; id → creator userId. cronjobManager.listCronjobs.
  listCronjobs(): readonly { id: string; userId?: string | null }[];
}

export function buildProductionGuardDeps(
  live: GuardDepsLiveReaders,
): GuardDeps {
  return {
    hasRoomAccess(identity: Identity, roomId: string): boolean {
      // A null userId (an identity with no owning user) has access to nothing.
      if (!identity.userId) return false;
      return live.hasRoomAccessForUser(identity.userId, roomId);
    },

    roomIdForAgent(agentId: string): string | null {
      const agent = live.getAllAgents().find((a) => a.id === agentId);
      if (!agent) return null; // unknown agent collapses with inaccessible
      // Phase 3c: the agent's authoritative roomId IS the global room id — no
      // index hop. Validate it still names a live room so a dangling roomId
      // collapses to inaccessible (preserving the pre-3c out-of-range → null
      // contract). Guards reason over global ids; the per-recipient room
      // projection is a wire concern, never an authz one.
      return live.getRooms().some((r) => r.id === agent.roomId)
        ? agent.roomId
        : null;
    },

    userIdForUsername(username: string): string | null {
      return live.getUserByName(username)?.id ?? null;
    },

    cronjobCreatorUserId(cronjobId: string): string | null {
      const job = live.listCronjobs().find((j) => j.id === cronjobId);
      return job?.userId ?? null;
    },

    agentManagerUserId(agentId: string): string | null {
      const agent = live.getAllAgents().find((a) => a.id === agentId);
      // Unknown agent collapses with unowned into the same null (non-leak deny).
      return agent?.userId ?? null;
    },
  };
}
