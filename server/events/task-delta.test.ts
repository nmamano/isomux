// The per-recipient task-delta rule (task b13445e2), exhaustively.
//
// taskDeltaFor is pure, so the whole truth table - three change kinds x the
// recipient's access to the room before and after - is cheap to pin here. The
// integration side (that the server actually sends what this returns, over a
// real socket) lives in routes-tasks-rest.test.ts.
//
// The case worth staring at: an UPDATE that re-files a task from a room you can
// access into one you cannot is a DELETE from your seat. Nothing else tells the
// board to drop the row, so getting this wrong leaves a task visible to someone
// who lost access to it until they reload.

import { describe, it, expect } from "bun:test";
import { taskDeltaFor } from "./task-delta.ts";
import type { TaskViewer } from "../task-visibility.ts";
import type { TaskItem } from "../../shared/types.ts";

function task(id: string, roomId?: string): TaskItem {
  return {
    id,
    title: `task ${id}`,
    status: "open",
    createdBy: "Morgan",
    createdAt: 1,
    ...(roomId ? { roomId } : {}),
    version: "v1",
  };
}

// Live rooms A and B; room-gone was closed. A member with access to room A
// only, a recipient with no room access, and an office owner (every live room,
// and a closed room's tasks).
const liveRoomIds = new Set(["room-a", "room-b"]);
const inA: TaskViewer = {
  accessibleRoomIds: new Set(["room-a"]),
  liveRoomIds,
  seesClosedRooms: false,
};
const none: TaskViewer = {
  accessibleRoomIds: new Set(),
  liveRoomIds,
  seesClosedRooms: false,
};
const owner: TaskViewer = {
  accessibleRoomIds: liveRoomIds,
  liveRoomIds,
  seesClosedRooms: true,
};

describe("taskDeltaFor: created", () => {
  it("upserts a global task to everyone", () => {
    expect(taskDeltaFor({ kind: "created", task: task("t1") }, none)).toEqual({
      type: "task_upserted",
      task: task("t1"),
    });
  });

  it("upserts a room task to a recipient who can access the room", () => {
    const t = task("t1", "room-a");
    expect(taskDeltaFor({ kind: "created", task: t }, inA)).toEqual({
      type: "task_upserted",
      task: t,
    });
  });

  it("says NOTHING to a recipient who cannot access the room", () => {
    // Not even a delete: naming the id would tell them a task exists in a room
    // they have no access to, which is the oracle the REST 404 refuses to be.
    expect(
      taskDeltaFor({ kind: "created", task: task("t1", "room-b") }, inA),
    ).toBe(null);
  });
});

describe("taskDeltaFor: updated", () => {
  it("upserts an in-place edit to a recipient who can see the task", () => {
    const t = task("t1", "room-a");
    expect(
      taskDeltaFor({ kind: "updated", task: t, prevRoomId: "room-a" }, inA),
    ).toEqual({ type: "task_upserted", task: t });
  });

  it("DELETES for a recipient who loses the task to a re-file", () => {
    // room-a → room-b: they could see it, now they can't.
    expect(
      taskDeltaFor(
        { kind: "updated", task: task("t1", "room-b"), prevRoomId: "room-a" },
        inA,
      ),
    ).toEqual({ type: "task_deleted", taskId: "t1" });
  });

  it("DELETES when a global task is filed into a room out of reach", () => {
    // prevRoomId absent = it was office-global, so everyone could see it.
    expect(
      taskDeltaFor({ kind: "updated", task: task("t1", "room-b") }, inA),
    ).toEqual({ type: "task_deleted", taskId: "t1" });
  });

  it("UPSERTS for a recipient who GAINS the task by a re-file", () => {
    // room-b → room-a: the first time this recipient hears of the task, and an
    // upsert is exactly right - their board has no row to update yet.
    const t = task("t1", "room-a");
    expect(
      taskDeltaFor({ kind: "updated", task: t, prevRoomId: "room-b" }, inA),
    ).toEqual({ type: "task_upserted", task: t });
  });

  it("says nothing when the task was and stays out of reach", () => {
    expect(
      taskDeltaFor(
        { kind: "updated", task: task("t1", "room-b"), prevRoomId: "room-b" },
        inA,
      ),
    ).toBe(null);
  });
});

describe("taskDeltaFor: deleted", () => {
  it("deletes for a recipient who could see the task", () => {
    expect(
      taskDeltaFor({ kind: "deleted", task: task("t1", "room-a") }, inA),
    ).toEqual({ type: "task_deleted", taskId: "t1" });
  });

  it("deletes a global task for everyone", () => {
    expect(taskDeltaFor({ kind: "deleted", task: task("t1") }, none)).toEqual({
      type: "task_deleted",
      taskId: "t1",
    });
  });

  it("says nothing to a recipient who never could see it", () => {
    expect(
      taskDeltaFor({ kind: "deleted", task: task("t1", "room-b") }, inA),
    ).toBe(null);
  });
});

// A closed room's tasks stay in the store and reach office owners only
// (task 6abfcc18). An owner's edit or delete of such a task reaches the owner
// and says nothing to a member, even a member who had the room before it
// closed. The re-file out of a closed room is pinned over a real socket in
// routes-tasks-rest.test.ts.
describe("taskDeltaFor: a closed room's task", () => {
  it("an edit in place upserts to an owner and says nothing to a member", () => {
    const t = task("t1", "room-gone");
    const change = {
      kind: "updated",
      task: t,
      prevRoomId: "room-gone",
    } as const;
    expect(taskDeltaFor(change, owner)).toEqual({
      type: "task_upserted",
      task: t,
    });
    expect(taskDeltaFor(change, inA)).toBe(null);
  });

  it("a delete tells the owner and says nothing to a member", () => {
    const change = { kind: "deleted", task: task("t1", "room-gone") } as const;
    expect(taskDeltaFor(change, owner)).toEqual({
      type: "task_deleted",
      taskId: "t1",
    });
    expect(taskDeltaFor(change, inA)).toBe(null);
  });
});
