// Who sees a board task. A task is visible when it is office-global (no
// roomId), when its room is in the caller's accessible set, or when its room
// is closed and the caller's room access is an office owner's. Closing a room
// leaves its tasks untouched; office owners can then re-file, close or delete
// them, as they can for a closed room's cronjobs, webhooks and pages. Members
// never see a closed room's tasks.
//
// LEAF: pure, so the REST gate, the board projection and the per-task delta
// share one rule.

export interface TaskViewer {
  // The rooms the caller can ACCESS (access, not view: a hidden room counts).
  accessibleRoomIds: ReadonlySet<string>;
  // Every live room, lobby included. A roomId outside this set names a closed
  // room.
  liveRoomIds: ReadonlySet<string>;
  // True when the caller's room access is an office owner's.
  seesClosedRooms: boolean;
}

export function taskVisibleTo(
  roomId: string | undefined,
  viewer: TaskViewer,
): boolean {
  if (!roomId || viewer.accessibleRoomIds.has(roomId)) return true;
  return viewer.seesClosedRooms && !viewer.liveRoomIds.has(roomId);
}
