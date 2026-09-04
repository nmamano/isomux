// Per-recipient task delta - the rule that turns ONE board mutation into the
// ONE wire message a given socket should receive.
//
// Why a delta at all: the board push used to re-send every task on every
// mutation. Measured on the live office at 535 tasks that is 635KB per mutation
// per socket, 68% of it `done` rows the default view hides, uncompressed, which
// is what made a create or an edit take seconds to appear. A delta is ~1KB.
//
// Why per-recipient: the board is ROOM-SCOPED, so the same mutation means
// different things to different sockets. A task re-filed out of a room you can
// access is, from your seat, a DELETE - nobody sends you the task's new home.
//
// The no-oracle posture is the reason this is a rule and not "broadcast the id":
// a recipient who could never see the task hears NOTHING, so a task id in a room
// you can't access never reaches you. That matches the REST surface, which 404s
// a task you can't see rather than admitting it exists.
//
// LEAF: pure, no imports beyond types, so the full truth table is unit-testable
// without standing up a server.

import type { TaskItem } from "../../shared/types.ts";
import type { TaskChange } from "../../shared/office-state.ts";

// The wire messages this rule produces. Structurally the `task_upserted` /
// `task_deleted` members of ServerMessage; kept as a local type so this module
// stays a leaf (the contract test pins the two shapes together).
export type TaskDelta =
  | { type: "task_upserted"; task: TaskItem }
  | { type: "task_deleted"; taskId: string };

// A task is visible to a recipient when it is office-global (no roomId) or its
// room is in the recipient's accessible set. Same predicate the list projection
// uses - access, not view, so a hidden room's tasks still count.
function visibleIn(
  roomId: string | undefined,
  accessibleRoomIds: ReadonlySet<string>,
): boolean {
  return !roomId || accessibleRoomIds.has(roomId);
}

/**
 * The single message a recipient with this room access should receive for this
 * change, or null when they should receive nothing at all.
 *
 *   visible now                  → task_upserted. Idempotent by design: a
 *                                  recipient who just gained access learns the
 *                                  task through the same message that tells
 *                                  everyone else a field changed.
 *   was visible, is not now      → task_deleted. Covers both a real delete and
 *                                  a re-file into a room they can't access.
 *   never visible                → null. Says nothing, leaks nothing.
 */
export function taskDeltaFor(
  change: TaskChange,
  accessibleRoomIds: ReadonlySet<string>,
): TaskDelta | null {
  if (
    change.kind !== "deleted" &&
    visibleIn(change.task.roomId, accessibleRoomIds)
  ) {
    return { type: "task_upserted", task: change.task };
  }
  // Where the task sat before this change: its own room for a delete (it had no
  // "after"), the captured prevRoomId for an update. A create had no before, so
  // a recipient who can't see it now simply never hears of it.
  const wasVisible =
    change.kind === "deleted"
      ? visibleIn(change.task.roomId, accessibleRoomIds)
      : change.kind === "updated" &&
        visibleIn(change.prevRoomId, accessibleRoomIds);
  return wasVisible ? { type: "task_deleted", taskId: change.task.id } : null;
}
