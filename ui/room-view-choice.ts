import type { UserRecord } from "../shared/types.ts";

// One member's view choices for one room, as the room's settings pane edits
// them. The member's record holds them as room-id lists; Settings > Rooms
// edits the same lists for every room at once.
export interface RoomViewChoice {
  shown: boolean;
  tucked: boolean;
  notif: boolean;
}

export function roomViewChoice(
  record: UserRecord,
  roomId: string,
): RoomViewChoice {
  const shown = !record.hidden.includes(roomId);
  return {
    shown,
    tucked: (record.tucked ?? []).includes(roomId),
    // Notifications need a displayed room, as the server's clamp holds.
    notif: shown && record.notifRooms.includes(roomId),
  };
}

export function sameRoomViewChoice(
  a: RoomViewChoice | null,
  b: RoomViewChoice | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.shown === b.shown && a.tucked === b.tucked && a.notif === b.notif;
}

// A record change that lands while the pane is open moves only the controls
// the member has not touched (where the form still equals the old baseline).
export function followRecord(
  form: RoomViewChoice | null,
  oldBase: RoomViewChoice | null,
  live: RoomViewChoice | null,
): RoomViewChoice | null {
  if (form === null || oldBase === null || live === null) return live;
  return {
    shown: form.shown === oldBase.shown ? live.shown : form.shown,
    tucked: form.tucked === oldBase.tucked ? live.tucked : form.tucked,
    notif: form.notif === oldBase.notif ? live.notif : form.notif,
  };
}

// The list with roomId in it or out of it, every other id kept in place.
export function withRoom(
  list: readonly string[],
  roomId: string,
  on: boolean,
): string[] {
  const rest = list.filter((id) => id !== roomId);
  return on ? [...rest, roomId] : rest;
}
