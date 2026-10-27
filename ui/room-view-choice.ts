import type { RoomViewLevel } from "../shared/room-view-level.ts";

// A record change that lands while the room's settings pane is open moves
// the level only when the member has not picked one (the form still equals
// the old baseline).
export function followRecord(
  form: RoomViewLevel | null,
  oldBase: RoomViewLevel | null,
  live: RoomViewLevel | null,
): RoomViewLevel | null {
  if (form === null || oldBase === null || live === null) return live;
  return form === oldBase ? live : form;
}
