import { describe, expect, it } from "bun:test";
import type { AppListWire } from "../../shared/types.ts";
import { appDeltaFor, type AppViewer } from "./app-delta.ts";

const ownerApp = {
  name: "hello",
  port: 21000,
  userId: "owner",
  username: "Owner",
  hostLabel: "hello",
  hostGen: 1,
  command: "bun run start",
  cwd: "/secret/app",
  dataDir: "/secret/data",
  createdBy: "Builder",
  createdByAgentId: "agent-1",
  createdAt: 1,
  state: "running",
  restartCount: 0,
  canManage: true,
} satisfies AppListWire;

const viewerApp = {
  name: "hello",
  port: 21000,
  userId: "owner",
  username: "Owner",
  createdByAgentId: "agent-1",
  createdAt: 1,
  state: "running",
  restartCount: 0,
  canManage: false,
} satisfies AppListWire;

const viewer = (userId: string, rooms: string[] = []): AppViewer => ({
  userId,
  isOfficeOwner: false,
  hasRoomAccess: (roomId) => rooms.includes(roomId),
});

const facts = (roomId: string, live = true) => ({
  ownerUserId: "owner",
  createdByAgentId: "agent-1",
  creatorLive: live,
  creatorRoomId: roomId,
});

describe("appDeltaFor", () => {
  it("projects a launch-only row for a room viewer", () => {
    expect(
      appDeltaFor(
        {
          kind: "upserted",
          ownerApp,
          viewerApp,
          visibility: facts("room-a"),
        },
        viewer("member", ["room-a"]),
      ),
    ).toEqual({ type: "app_upserted", app: viewerApp });
  });

  it("sends delete on lost access and upsert on gained access", () => {
    const change = {
      kind: "audience_changed" as const,
      name: "hello",
      ownerApp,
      viewerApp,
      before: facts("room-a"),
      after: facts("room-b"),
    };
    expect(appDeltaFor(change, viewer("old", ["room-a"]))).toEqual({
      type: "app_deleted",
      name: "hello",
    });
    expect(appDeltaFor(change, viewer("new", ["room-b"]))).toEqual({
      type: "app_upserted",
      app: viewerApp,
    });
    expect(appDeltaFor(change, viewer("neither"))).toBeNull();
  });

  it("keeps owners visible when the creator dies", () => {
    expect(
      appDeltaFor(
        {
          kind: "audience_changed",
          name: "hello",
          ownerApp,
          viewerApp,
          before: facts("room-a"),
          after: facts("room-a", false),
        },
        viewer("owner"),
      ),
    ).toBeNull();
  });
});
