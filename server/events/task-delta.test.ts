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
import type { TaskItem } from "../../shared/types.ts";

function task(id: string, roomId?: string): TaskItem {
  return {
    id,
    title: `task ${id}`,
    status: "open",
    createdBy: "Boss",
    createdAt: 1,
    ...(roomId ? { roomId } : {}),
  };
}

const inA = new Set(["room-a"]); // recipient can access room A only
const none: ReadonlySet<string> = new Set();

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

describe("delta vs whole-board payload size", () => {
  it("a delta is orders of magnitude smaller than the board it replaced", () => {
    // Shaped like the live office when this was diagnosed: 535 tasks, most of
    // them long-description `done` rows the default view doesn't even show.
    const board: TaskItem[] = Array.from({ length: 535 }, (_, i) => ({
      ...task(`t${i}`),
      status: i < 370 ? ("done" as const) : ("open" as const),
      description: "x".repeat(900),
    }));
    const wholeBoard = JSON.stringify({ type: "tasks", tasks: board }).length;
    const delta = JSON.stringify(
      taskDeltaFor({ kind: "created", task: board[0] }, none),
    ).length;
    // The old push re-sent the board on EVERY mutation; measured at 635KB on the
    // real office. Two orders of magnitude is a deliberately loose floor - the
    // real ratio here is ~500x - so the test pins the property, not the fixture.
    expect(wholeBoard / delta).toBeGreaterThan(100);
  });
});
