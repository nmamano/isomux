import { describe, expect, it } from "bun:test";
import { cronjobDeltaFor } from "./cronjob-delta.ts";
import type { CronjobViewer } from "../cronjob-visibility.ts";
import type { Cronjob } from "../../shared/types.ts";

const ROOM = "a1a1a1a1";
const OTHER = "b2b2b2b2";

const JOB: Cronjob = {
  id: "c0ffee00",
  name: "Nightly",
  schedule: { type: "interval", minutes: 60 },
  prompt: "secret instructions",
  cwd: "/private",
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
  lastFireAt: null,
  nextFireAt: 3,
};

const member = (rooms: string[]): CronjobViewer => ({
  userId: "u-member",
  isOfficeOwner: false,
  canRead: true,
  canManage: true,
  hasRoomAccess: (id) => rooms.includes(id),
});

const maker: CronjobViewer = { ...member([]), userId: "u-maker" };

const at = (roomId: string | null) => ({
  makerUserId: "u-maker",
  liveRoomId: roomId,
});

describe("cronjobDeltaFor", () => {
  it("a create reaches a room member as a viewer projection and the maker as the whole record", () => {
    const change = { kind: "added" as const, cronjob: JOB, facts: at(ROOM) };
    const toMember = cronjobDeltaFor(change, member([ROOM]), null);
    expect(toMember?.type).toBe("cronjob_added");
    expect(JSON.stringify(toMember)).not.toContain(JOB.prompt);
    expect(cronjobDeltaFor(change, maker, null)).toEqual({
      type: "cronjob_added",
      cronjob: { ...JOB, detail: true, canManage: true },
    });
  });

  it("a recipient who never could see the job hears nothing", () => {
    expect(
      cronjobDeltaFor(
        { kind: "added", cronjob: JOB, facts: at(ROOM) },
        member([OTHER]),
        null,
      ),
    ).toBeNull();
    expect(
      cronjobDeltaFor(
        { kind: "deleted", id: JOB.id, before: at(ROOM) },
        member([OTHER]),
        null,
      ),
    ).toBeNull();
  });

  it("a move out of the recipient's rooms is a delete, a move in is an upsert", () => {
    const out = cronjobDeltaFor(
      {
        kind: "updated",
        cronjob: { ...JOB, roomId: OTHER },
        facts: at(OTHER),
        before: at(ROOM),
      },
      member([ROOM]),
      null,
    );
    expect(out).toEqual({ type: "cronjob_deleted", id: JOB.id });
    const into = cronjobDeltaFor(
      {
        kind: "updated",
        cronjob: JOB,
        facts: at(ROOM),
        before: at(OTHER),
      },
      member([ROOM]),
      null,
    );
    expect(into?.type).toBe("cronjob_updated");
  });

  it("a delete reaches whoever could see the job before it went", () => {
    expect(
      cronjobDeltaFor(
        { kind: "deleted", id: JOB.id, before: at(ROOM) },
        member([ROOM]),
        null,
      ),
    ).toEqual({ type: "cronjob_deleted", id: JOB.id });
    expect(
      cronjobDeltaFor(
        { kind: "deleted", id: JOB.id, before: at(null) },
        maker,
        null,
      ),
    ).toEqual({ type: "cronjob_deleted", id: JOB.id });
  });
});
