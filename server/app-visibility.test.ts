import { describe, expect, it } from "bun:test";
import type { Identity } from "./identity/index.ts";
import {
  appVisibleTo,
  viewerUserId,
  type AppViewerFacts,
  type AppVisibilityFacts,
} from "./app-visibility.ts";

const viewer = (over: Partial<AppViewerFacts> = {}): AppViewerFacts => ({
  userId: "viewer",
  isOfficeOwner: false,
  hasCreatorRoomAccess: false,
  ...over,
});

const app = (over: Partial<AppVisibilityFacts> = {}): AppVisibilityFacts => ({
  ownerUserId: "owner",
  createdByAgentId: "agent-1",
  creatorLive: true,
  creatorRoomId: "room-1",
  ...over,
});

describe("appVisibleTo", () => {
  it("allows the owner and office owners", () => {
    expect(appVisibleTo(app(), viewer({ userId: "owner" }))).toBe(true);
    expect(appVisibleTo(app(), viewer({ isOfficeOwner: true }))).toBe(true);
  });

  it("allows a room viewer only through a live, resolvable creator", () => {
    const roomViewer = viewer({ hasCreatorRoomAccess: true });
    expect(appVisibleTo(app(), roomViewer)).toBe(true);
    expect(appVisibleTo(app(), viewer())).toBe(false);
    expect(appVisibleTo(app({ creatorLive: false }), roomViewer)).toBe(false);
    expect(appVisibleTo(app({ creatorRoomId: undefined }), roomViewer)).toBe(
      false,
    );
    expect(appVisibleTo(app({ createdByAgentId: undefined }), roomViewer)).toBe(
      false,
    );
  });

  it("never owner-matches null, but an ownerless live creator is room-visible", () => {
    expect(
      appVisibleTo(
        app({ ownerUserId: null, creatorLive: false }),
        viewer({ userId: null }),
      ),
    ).toBe(false);
    expect(
      appVisibleTo(
        app({ ownerUserId: null }),
        viewer({ hasCreatorRoomAccess: true }),
      ),
    ).toBe(true);
  });
});

describe("viewerUserId", () => {
  const identity = (scope: Identity["scope"]): Identity => ({
    scope,
    userId: "truthful-owner",
    role: "member",
    capabilities: [],
  });

  it("resolves only human and agent viewers", () => {
    expect(viewerUserId(identity("user"))).toBe("truthful-owner");
    expect(viewerUserId(identity("agent"))).toBe("truthful-owner");
    expect(viewerUserId(identity("app"))).toBeNull();
    expect(viewerUserId(identity("cron-run"))).toBeNull();
  });
});
