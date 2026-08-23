// Per-recipient app projection. Visibility can change without an app record
// mutation when its live creator moves, is killed or revived, or when room/user
// state changes. Dependency changes therefore carry both old and new facts.

import type { AppListWire } from "../../shared/types.ts";
import {
  appVisibleTo,
  type AppViewerFacts,
  type AppVisibilityFacts,
} from "../app-visibility.ts";

export type AppDelta =
  | { type: "app_upserted"; app: AppListWire }
  | { type: "app_deleted"; name: string };

export type AppChange =
  | {
      kind: "upserted";
      ownerApp: AppListWire;
      viewerApp: AppListWire | null;
      visibility: AppVisibilityFacts;
    }
  | { kind: "deleted"; name: string; visibility: AppVisibilityFacts }
  | {
      kind: "audience_changed";
      name: string;
      ownerApp: AppListWire;
      viewerApp: AppListWire | null;
      before: AppVisibilityFacts;
      after: AppVisibilityFacts;
    };

export interface AppViewer {
  userId: string | null;
  isOfficeOwner: boolean;
  hasRoomAccess(roomId: string): boolean;
}

function factsFor(
  visibility: AppVisibilityFacts,
  viewer: AppViewer,
): AppViewerFacts {
  return {
    userId: viewer.userId,
    isOfficeOwner: viewer.isOfficeOwner,
    hasCreatorRoomAccess:
      visibility.creatorRoomId !== undefined &&
      viewer.hasRoomAccess(visibility.creatorRoomId),
  };
}

function projectedApp(
  change: Extract<AppChange, { ownerApp: AppListWire }>,
  viewer: AppViewer,
): AppListWire | null {
  return viewer.isOfficeOwner ||
    (viewer.userId !== null && change.ownerApp.userId === viewer.userId)
    ? change.ownerApp
    : change.viewerApp;
}

export function appDeltaFor(
  change: AppChange,
  viewer: AppViewer,
): AppDelta | null {
  if (change.kind === "deleted") {
    return appVisibleTo(change.visibility, factsFor(change.visibility, viewer))
      ? { type: "app_deleted", name: change.name }
      : null;
  }
  if (change.kind === "upserted") {
    if (!appVisibleTo(change.visibility, factsFor(change.visibility, viewer))) {
      return null;
    }
    const app = projectedApp(change, viewer);
    return app === null ? null : { type: "app_upserted", app };
  }
  const wasVisible = appVisibleTo(
    change.before,
    factsFor(change.before, viewer),
  );
  const isVisible = appVisibleTo(change.after, factsFor(change.after, viewer));
  if (wasVisible && !isVisible) {
    return { type: "app_deleted", name: change.name };
  }
  if (!wasVisible && isVisible) {
    const app = projectedApp(change, viewer);
    return app === null ? null : { type: "app_upserted", app };
  }
  return null;
}
