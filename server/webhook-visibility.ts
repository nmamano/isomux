// Who may see a webhook. One rule for the REST reads (list, get, deliveries,
// dry-run) and the WebSocket deltas, after server/cronjob-visibility.ts.
//
//   SEE    - the hook, its rules and its delivery log: the hook owner, a
//            viewer with office-wide reach, or a member of the hook's room
//            while that room is live. The hook's room is its target's room:
//            the target agent's room, or the target cronjob's room.
//
// Managing a hook (edit, delete, the secret) is not decided here: those routes
// keep webhookOwnerOrOfficeOwner (server/identity/guards.ts), and the secret
// routes also keep userScope.
//
// LEAF over types: the full truth table is unit-testable without a server.

import { identityHasCapability, type Identity } from "./identity/index.ts";

export interface WebhookVisibilityFacts {
  ownerUserId: string;
  // The target's room when it is a live ordinary room, else null. A hook whose
  // target is gone, has no room, or whose room was closed is owner + office
  // owners only.
  liveRoomId: string | null;
}

export interface WebhookViewer {
  userId: string | null;
  // Participates as a webhook reader: a USER, an API token, or an agent
  // holding webhook:read. An app or a cron run never does.
  participates: boolean;
  // An office owner, or an agent or API token whose user is one: the reach
  // webhookOwnerOrOfficeOwner grants.
  officeWide: boolean;
  hasRoomAccess(roomId: string): boolean;
}

export function webhookVisibleTo(
  facts: WebhookVisibilityFacts,
  viewer: WebhookViewer,
): boolean {
  if (!viewer.participates) return false;
  if (viewer.officeWide) return true;
  if (viewer.userId !== null && viewer.userId === facts.ownerUserId) {
    return true;
  }
  return facts.liveRoomId !== null && viewer.hasRoomAccess(facts.liveRoomId);
}

// The viewer an authenticated identity resolves to. `isOfficeOwnerUserId`
// reads the live user record, so a demoted owner's agents lose the reach.
export function webhookViewerForIdentity(
  identity: Identity,
  isOfficeOwnerUserId: (userId: string) => boolean,
  hasRoomAccess: (roomId: string) => boolean,
): WebhookViewer {
  const participates =
    identity.scope === "user" ||
    identity.scope === "api" ||
    (identity.scope === "agent" &&
      identityHasCapability(identity, "webhook:read"));
  return {
    userId: identity.userId,
    participates,
    officeWide:
      participates &&
      identity.userId !== null &&
      isOfficeOwnerUserId(identity.userId),
    hasRoomAccess,
  };
}
