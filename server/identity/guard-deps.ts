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
// proves it agrees with the live materialized-allowedRooms ACL.
//
// ADDITIVE: constructed at boot and exposed (dormant) on the ServerHandle. In
// 2.3 nothing consumes it — Phase 3 feeds it to authorize() when routes migrate.
// Phase 3b swaps the access model (materialized → rule-based) by changing
// `hasRoomAccessForUser`'s body, never this adapter's shape.

import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";

// The minimal live readers the adapter needs, as structural shapes so the
// production managers' richer return types (AgentInfo / RoomWire / UserRecord /
// Cronjob) satisfy them and tests can pass trivial fakes.
export interface GuardDepsLiveReaders {
  // Today's materialized access predicate for a user, keyed by userId:
  // sessionHasFullRoomAccess(session) || roomAllowedForSession(session, roomId),
  // with session reduced to { userId }. The index.ts seam supplies this closure;
  // Phase 3b replaces its body with rule-based access without touching the shape.
  hasRoomAccessForUser(userId: string, roomId: string): boolean;
  // The live agent roster (AgentInfo.room is the GLOBAL room index in 2.3).
  getAllAgents(): readonly { id: string; room: number }[];
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
      // Resolve the GLOBAL room id from the dense index — NOT a per-recipient
      // dense projection (guards reason over global ids; the dense rewrite is a
      // wire concern, never an authz one).
      return live.getRooms()[agent.room]?.id ?? null;
    },

    userIdForUsername(username: string): string | null {
      return live.getUserByName(username)?.id ?? null;
    },

    cronjobCreatorUserId(cronjobId: string): string | null {
      const job = live.listCronjobs().find((j) => j.id === cronjobId);
      return job?.userId ?? null;
    },
  };
}
