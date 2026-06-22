// Phase 3b slice 3 — owner-access migration decision (PURE).
//
// Moves owners from the OLD materialized-grants model (allowedRooms snapshots
// every room id; owner access == coverage) to RULE-BASED access (owners reach
// every room by rule; allowedRooms is a member-only GRANT store). This module
// is the pure decision: given the current users and the live room ids, it
// returns the per-owner mutation to apply. It has NO module globals and NO I/O
// so the full case matrix is unit-testable without booting a server.
// migrateOwnersToRuleBasedAccess() in index.ts is the thin boot wrapper that
// feeds it listUsers() + getRooms() and applies the result via updateUserById.

import type { UserRecord } from "../shared/types.ts";

// The mutation to persist for one owner. allowedRooms is ALWAYS [] (grants are
// a member-only store under the rule); hidden is the seeded VIEW preference.
export interface OwnerAccessMigration {
  id: string;
  hidden: string[];
  allowedRooms: [];
}

// Plan the rule-based-access migration for every owner that still carries
// materialized grants. IDEMPOTENT: the marker for "needs migration" is "owner
// with non-empty allowedRooms"; a migrated owner has [], so it is skipped and
// produces no plan entry. Members are never touched.
//
// For each owner with non-empty allowedRooms, in order:
//   1. EFFECTIVE-COVERAGE GUARD: if the grants cover NO live room (empty after
//      the load guard, or all-stale ids pointing at deleted rooms) seed
//      hidden = ∅ — the owner sees every room by rule, never a blank office.
//      Otherwise seed hidden = liveRooms \ grants, so a self-hiding owner's
//      CURRENT view survives the flip (the rooms they could not reach before
//      stay hidden as a VIEW preference, not a security restriction).
//   2. Union the seeded hidden with the owner's pre-existing `hidden`, then
//      INTERSECT with the live rooms — stale hidden ids are inert in the
//      projection (they never match a live room) and must not accumulate on
//      disk across migrations. Dedupe, stable order (existing-hidden first,
//      then seeded in live-room order).
//   3. Clear grants to [] (hidden is computed FIRST, from the OLD grants).
export function planOwnerAccessMigration(
  users: readonly UserRecord[],
  liveRoomIds: readonly string[],
): OwnerAccessMigration[] {
  const liveSet = new Set(liveRoomIds);
  const out: OwnerAccessMigration[] = [];
  for (const u of users) {
    // Skip members and already-migrated owners (the idempotency marker).
    if (u.role !== "owner" || u.allowedRooms.length === 0) continue;
    const grantSet = new Set(u.allowedRooms);
    const coversAnyLive = u.allowedRooms.some((id) => liveSet.has(id));
    const seededHidden = coversAnyLive
      ? liveRoomIds.filter((id) => !grantSet.has(id))
      : [];
    // union(existing hidden, seeded) ∩ live, deduped, stable order.
    const hidden: string[] = [];
    const seen = new Set<string>();
    for (const id of [...u.hidden, ...seededHidden]) {
      if (!liveSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      hidden.push(id);
    }
    out.push({ id: u.id, hidden, allowedRooms: [] });
  }
  return out;
}
