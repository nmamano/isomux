import { describe, expect, it } from "bun:test";
import {
  cronjobDetailFor,
  cronjobManageFor,
  cronjobViewerForIdentity,
  cronjobVisibleTo,
  projectCronjob,
  type CronjobViewer,
  type CronjobVisibilityFacts,
} from "./cronjob-visibility.ts";
import {
  AGENT_CAPABILITIES,
  API_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  USER_CAPABILITIES,
  type Capability,
  type Identity,
} from "./identity/index.ts";
import type { Cronjob } from "../shared/types.ts";

const ROOM = "a1a1a1a1";
const OTHER_ROOM = "b2b2b2b2";

function viewer(over: Partial<CronjobViewer> = {}): CronjobViewer {
  return {
    userId: "u-viewer",
    isOfficeOwner: false,
    canRead: true,
    canManage: true,
    hasRoomAccess: () => false,
    ...over,
  };
}

const inRoom = (roomId: string) => (id: string) => id === roomId;

const facts = (
  over: Partial<CronjobVisibilityFacts> = {},
): CronjobVisibilityFacts => ({
  makerUserId: "u-maker",
  liveRoomId: ROOM,
  ...over,
});

const JOB: Cronjob = {
  id: "c0ffee00",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  prompt: "secret instructions",
  cwd: "/home/maker/private",
  agentType: "claude",
  modelFamily: "opus",
  effort: "high",
  permissionMode: "bypassPermissions",
  enabled: true,
  createdBy: "Maker",
  userId: "u-maker",
  username: "Maker",
  roomId: ROOM,
  createdAt: 1,
  lastFireAt: 2,
  nextFireAt: 3,
};

describe("cronjob visibility: SEE", () => {
  it("the maker sees their job with no room, a closed room, or a room they cannot access", () => {
    const maker = viewer({ userId: "u-maker" });
    expect(cronjobVisibleTo(facts({ liveRoomId: null }), maker)).toBe(true);
    expect(cronjobVisibleTo(facts({ liveRoomId: OTHER_ROOM }), maker)).toBe(
      true,
    );
  });

  it("an office owner sees every job, roomless ones included", () => {
    expect(
      cronjobVisibleTo(
        facts({ liveRoomId: null, makerUserId: "u-other" }),
        viewer({ isOfficeOwner: true }),
      ),
    ).toBe(true);
  });

  it("a member sees a job only while it sits in a live room they can access", () => {
    const member = viewer({ hasRoomAccess: inRoom(ROOM) });
    expect(cronjobVisibleTo(facts(), member)).toBe(true);
    expect(cronjobVisibleTo(facts({ liveRoomId: OTHER_ROOM }), member)).toBe(
      false,
    );
    // No room, or a closed room (the caller passes liveRoomId null for it).
    expect(cronjobVisibleTo(facts({ liveRoomId: null }), member)).toBe(false);
  });

  it("a null maker never matches a viewer, not even one with a null userId", () => {
    const unowned = facts({ makerUserId: null, liveRoomId: null });
    expect(cronjobVisibleTo(unowned, viewer({ userId: null }))).toBe(false);
    expect(cronjobDetailFor(unowned, viewer({ userId: null }))).toBe(false);
  });

  it("a viewer that does not read cronjobs sees nothing, even in the job's room and as its maker", () => {
    const nonReader = viewer({
      userId: "u-maker",
      canRead: false,
      hasRoomAccess: inRoom(ROOM),
    });
    expect(cronjobVisibleTo(facts(), nonReader)).toBe(false);
    expect(cronjobDetailFor(facts(), nonReader)).toBe(false);
  });
});

describe("cronjob visibility: DETAIL and MANAGE", () => {
  it("room access never grants detail", () => {
    expect(
      cronjobDetailFor(facts(), viewer({ hasRoomAccess: inRoom(ROOM) })),
    ).toBe(false);
  });

  it("the maker and office owners get detail", () => {
    expect(cronjobDetailFor(facts(), viewer({ userId: "u-maker" }))).toBe(true);
    expect(cronjobDetailFor(facts(), viewer({ isOfficeOwner: true }))).toBe(
      true,
    );
  });

  it("read authority alone never reports manage authority", () => {
    const reader = viewer({ userId: "u-maker", canManage: false });
    expect(cronjobDetailFor(facts(), reader)).toBe(true);
    expect(cronjobManageFor(facts(), reader)).toBe(false);
    expect(projectCronjob(JOB, facts(), reader, null)).toMatchObject({
      detail: true,
      canManage: false,
    });
  });
});

describe("cronjob visibility: projection", () => {
  it("a room member gets the schedule and last-run outcome, never the prompt, cwd or engine settings", () => {
    const member = viewer({ hasRoomAccess: inRoom(ROOM) });
    const projected = projectCronjob(JOB, facts(), member, {
      status: "failed",
      endedAt: 10,
    });
    expect(projected).toEqual({
      detail: false,
      canManage: false,
      id: JOB.id,
      name: JOB.name,
      schedule: JOB.schedule,
      enabled: JOB.enabled,
      agentType: JOB.agentType,
      roomId: ROOM,
      createdBy: JOB.createdBy,
      userId: JOB.userId,
      username: JOB.username,
      createdAt: JOB.createdAt,
      lastFireAt: JOB.lastFireAt,
      nextFireAt: JOB.nextFireAt,
      lastRun: { status: "failed", endedAt: 10 },
    });
    const text = JSON.stringify(projected);
    expect(text).not.toContain(JOB.prompt);
    expect(text).not.toContain(JOB.cwd);
  });

  it("the maker gets the whole record with manage authority", () => {
    expect(
      projectCronjob(JOB, facts(), viewer({ userId: "u-maker" }), null),
    ).toEqual({ ...JOB, detail: true, canManage: true });
  });

  it("a viewer who may not see the job gets nothing", () => {
    expect(projectCronjob(JOB, facts(), viewer(), null)).toBeNull();
  });
});

describe("cronjob visibility: identities", () => {
  const identity = (
    scope: Identity["scope"],
    capabilities: readonly Capability[],
    role: Identity["role"] = "member",
  ): Identity => ({ scope, userId: "u-maker", role, capabilities });

  it("a user, a privileged agent and an API token of the maker get detail", () => {
    for (const id of [
      identity("user", USER_CAPABILITIES),
      identity("agent", PRIVILEGED_AGENT_CAPABILITIES),
      identity("api", API_CAPABILITIES),
    ]) {
      const v = cronjobViewerForIdentity(id, () => false);
      expect(cronjobDetailFor(facts(), v)).toBe(true);
      expect(cronjobManageFor(facts(), v)).toBe(true);
    }
  });

  it("a narrow agent and a cron run of the maker get nothing", () => {
    for (const id of [
      identity("agent", AGENT_CAPABILITIES),
      identity("cron-run", RUN_CAPABILITIES),
    ]) {
      const v = cronjobViewerForIdentity(id, () => true);
      expect(cronjobVisibleTo(facts(), v)).toBe(false);
    }
  });

  it("an agent or API token whose user is an office owner is not an office owner for cronjobs", () => {
    for (const id of [
      identity("agent", PRIVILEGED_AGENT_CAPABILITIES, "owner"),
      identity("api", API_CAPABILITIES, "owner"),
    ]) {
      const v = cronjobViewerForIdentity(
        { ...id, userId: "u-other" },
        () => false,
      );
      expect(v.isOfficeOwner).toBe(false);
      expect(cronjobDetailFor(facts(), v)).toBe(false);
    }
  });

  it("a user-scope owner is an office owner", () => {
    const v = cronjobViewerForIdentity(
      { ...identity("user", USER_CAPABILITIES, "owner"), userId: "u-other" },
      () => false,
    );
    expect(cronjobDetailFor(facts(), v)).toBe(true);
  });

  it("an API token that only reads cronjobs gets detail without manage authority", () => {
    const v = cronjobViewerForIdentity(
      identity("api", ["cron:read"]),
      () => false,
    );
    expect(cronjobDetailFor(facts(), v)).toBe(true);
    expect(cronjobManageFor(facts(), v)).toBe(false);
  });
});
