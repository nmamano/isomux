// Per-recipient app delta - the rule that turns ONE app mutation into the ONE
// wire message a given socket should receive. Sibling of task-delta.ts, and the
// same shape for the same reason: the resource is scoped, so a single mutation
// means different things to different sockets.
//
// Where a task is scoped by ROOM ACCESS, an app is scoped by OWNERSHIP: it
// belongs to a user, and office owners see every app (the rule apps.list
// already filters by). So the audience of one mutation is at most "that user's
// sockets plus the owners' sockets", never the office.
//
// The no-oracle posture carries over: a recipient who could never see the app
// hears NOTHING - not an empty frame, not a bare name. That matches the REST
// surface, where an app you do not own 404s rather than admitting it exists,
// and it is why the delete input carries the owner id (after the record is
// removed there is nothing left to decide visibility from).
//
// LEAF: pure, no imports beyond types, so the whole truth table is unit-testable
// without standing up a server.

import type { AppWire } from "../../shared/types.ts";

// The wire messages this rule produces. Structurally the `app_upserted` /
// `app_deleted` members of ServerMessage; kept as a local type so this module
// stays a leaf (the contract test pins the two shapes together).
export type AppDelta =
  | { type: "app_upserted"; app: AppWire }
  | { type: "app_deleted"; name: string };

// One mutation, described independently of who is about to hear about it. The
// delete arm carries the owner because the record is already gone by then.
export type AppChange =
  | { kind: "upserted"; app: AppWire }
  | { kind: "deleted"; name: string; userId: string | null };

// Who is being told. Mirrors the two facts the handler's own filter uses: the
// session's user, and whether that user is an office owner.
export interface AppViewer {
  userId: string | null;
  isOfficeOwner: boolean;
}

// An app is visible to an office owner always, and otherwise only to the user
// who owns it. An OWNERLESS app (userId null) is therefore visible to owners
// alone - it belongs to nobody, so no member can match it, and `null === null`
// must never make it everyone's. Same predicate as the apps.list filter.
function visibleTo(ownerUserId: string | null, viewer: AppViewer): boolean {
  if (viewer.isOfficeOwner) return true;
  return ownerUserId !== null && ownerUserId === viewer.userId;
}

/**
 * The single message this recipient should receive for this change, or null
 * when they should receive nothing at all.
 *
 *   upserted, visible     → app_upserted. Upsert, not created/updated: the
 *                           client replaces-or-appends by name, so the same
 *                           message serves a registration and a field change.
 *   deleted, visible      → app_deleted.
 *   not visible           → null. Says nothing, leaks nothing.
 *
 * Ownership never changes (there is no verb for it), so unlike a task there is
 * no "was visible, is not now" transition to cover: an app a recipient can see
 * after a change is one they could see before it.
 */
export function appDeltaFor(
  change: AppChange,
  viewer: AppViewer,
): AppDelta | null {
  if (change.kind === "upserted") {
    return visibleTo(change.app.userId, viewer)
      ? { type: "app_upserted", app: change.app }
      : null;
  }
  return visibleTo(change.userId, viewer)
    ? { type: "app_deleted", name: change.name }
    : null;
}
