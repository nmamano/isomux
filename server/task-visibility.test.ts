// Who sees a board task (task 6abfcc18). The REST gate, the board projection
// and the per-task delta all ask taskVisibleTo, so its whole truth table lives
// here; the integration side is in routes-tasks-rest.test.ts.
//
// The row worth staring at: an office owner's flag reaches CLOSED rooms only.
// A live room outside the viewer's access stays hidden even when the flag is
// set, so a later change to who counts as an owner cannot widen this rule to
// live rooms.

import { describe, it, expect } from "bun:test";
import { taskVisibleTo, type TaskViewer } from "./task-visibility.ts";

const liveRoomIds = new Set(["room-a", "room-b"]);
function viewer(accessible: string[], seesClosedRooms: boolean): TaskViewer {
  return {
    accessibleRoomIds: new Set(accessible),
    liveRoomIds,
    seesClosedRooms,
  };
}

describe("taskVisibleTo", () => {
  const cases: Array<[string, string | undefined, TaskViewer, boolean]> = [
    [
      "an office-global task, to a viewer with no rooms",
      undefined,
      viewer([], false),
      true,
    ],
    ["a task in an accessible room", "room-a", viewer(["room-a"], false), true],
    [
      "a task in a live room outside access",
      "room-b",
      viewer(["room-a"], false),
      false,
    ],
    [
      "a task in a live room outside access, to a viewer who sees closed rooms",
      "room-b",
      viewer(["room-a"], true),
      false,
    ],
    [
      "a closed room's task, to a viewer who sees closed rooms",
      "room-gone",
      viewer([], true),
      true,
    ],
    [
      "a closed room's task, to a viewer who does not",
      "room-gone",
      viewer(["room-a"], false),
      false,
    ],
  ];
  for (const [name, roomId, v, expected] of cases) {
    it(`${expected ? "shows" : "hides"} ${name}`, () => {
      expect(taskVisibleTo(roomId, v)).toBe(expected);
    });
  }
});
