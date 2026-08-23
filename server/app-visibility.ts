import type { Identity } from "./identity/index.ts";

export interface AppVisibilityFacts {
  ownerUserId: string | null;
  createdByAgentId?: string;
  creatorLive: boolean;
  creatorRoomId?: string;
}

export interface AppViewerFacts {
  userId: string | null;
  isOfficeOwner: boolean;
  hasCreatorRoomAccess: boolean;
}

export function viewerUserId(identity: Identity): string | null {
  return identity.scope === "user" || identity.scope === "agent"
    ? identity.userId
    : null;
}

export function appVisibleTo(
  app: AppVisibilityFacts,
  viewer: AppViewerFacts,
): boolean {
  if (viewer.isOfficeOwner) return true;
  if (viewer.userId !== null && app.ownerUserId === viewer.userId) return true;
  return (
    viewer.userId !== null &&
    app.createdByAgentId !== undefined &&
    app.creatorLive &&
    app.creatorRoomId !== undefined &&
    viewer.hasCreatorRoomAccess
  );
}
