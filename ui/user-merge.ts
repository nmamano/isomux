// Client-side user-record merge core. PURE + React-free so it can
// be unit-tested in isolation - the UI equivalent of the server's pure clamp /
// migration cores (clampViewFields, planOwnerAccessMigration).
//
// The wire splits one logical "user" across three event classes by audience:
//   - users_list / user_updated            -> UserPublicWire (public, everyone)
//   - users_admin_list / user_admin_updated -> full UserRecord (owners only)
//   - user_self_updated                    -> the subject's OWN full record
// The store merges them into one map. This module owns the precedence rule
// (full data wins over public, order-independently) so it lives in one tested
// place instead of being scattered across reducer cases.

import type { UserPublicWire, UserRecord } from "../shared/types.ts";

// The client's merged view of a user. Public columns are ALWAYS present (every
// user appears on the public roster); the sensitive columns are present ONLY
// for records the client legitimately received in full - its OWN record (via
// user_self_updated) and, for an owner, every record (via users_admin_*). A
// member holds public-only views of other users. Typed so any sensitive read
// is compiler-forced to narrow through isFullUserView first.
export type UserView = UserPublicWire & Partial<UserRecord>;

// Fullness guard by SHAPE, never by role: an owner's view of another user is
// full because of the admin channel, and a member's view of themselves is full
// because of the self channel - role is not proof of shape. Checks the
// sensitive fields a full record always carries.
export function isFullUserView(u: UserView): u is UserRecord {
  return (
    Array.isArray(u.allowedRooms) &&
    Array.isArray(u.notifRooms) &&
    Array.isArray(u.hidden) &&
    Array.isArray(u.order) &&
    "envFile" in u &&
    "memberPrompt" in u &&
    "language" in u
  );
}

// Merge one incoming wire into a NEW map (pure - `prev` is untouched). A full
// (self/admin) record overwrites every column; a public wire overwrites only
// the public columns, preserving any sensitive fields already held. On rename
// (prevName differs) the base is the OLD record, so sensitive fields survive
// the key migration, and the stale key is removed.
export function upsertUserView(
  prev: Map<string, UserView>,
  incoming: UserPublicWire | UserRecord,
  prevName?: string,
): Map<string, UserView> {
  const next = new Map(prev);
  const key = incoming.name.toLowerCase();
  const prevKey = prevName?.toLowerCase();
  const renamed = prevKey !== undefined && prevKey !== key;
  const base = (renamed ? next.get(prevKey) : undefined) ?? next.get(key);
  if (renamed) next.delete(prevKey);
  const merged: UserView = { ...base, ...incoming };
  next.set(key, merged);
  return next;
}

// Rebuild the map from an AUTHORITATIVE bulk roster for its audience: users
// absent from the list are dropped (membership authority); survivors keep any
// sensitive fields already held ({...prev, ...wire}), so a public users_list
// arriving after a full self/admin record never erases sensitive data.
export function rebuildUserViews(
  prev: Map<string, UserView>,
  list: (UserPublicWire | UserRecord)[],
): Map<string, UserView> {
  const next = new Map<string, UserView>();
  for (const wire of list) {
    const key = wire.name.toLowerCase();
    const merged: UserView = { ...prev.get(key), ...wire };
    next.set(key, merged);
  }
  return next;
}
