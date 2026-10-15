// Whether a member's notification rooms cover a room. The browser's sound
// at a turn end (ui/store.tsx) and the pager's device pushes
// (server/web-push-delivery.ts) both use it.

import { LOBBY_ROOM_ID } from "./types.ts";

// The receptionist's lobby is nobody's notification room, and it notifies
// everyone it concerns.
export function shouldNotifyRoom(
  roomId: string | null,
  notifRooms: readonly string[],
): boolean {
  if (roomId == null) return false;
  return roomId === LOBBY_ROOM_ID || notifRooms.includes(roomId);
}
