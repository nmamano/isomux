// Whether a member's notification rooms cover a room. The browser's sound
// at a turn end (ui/store.tsx) uses it.

import { LOBBY_ROOM_ID } from "./types.ts";

// The receptionist's lobby notifies nobody: a member cannot turn it off.
export function shouldNotifyRoom(
  roomId: string | null,
  notifRooms: readonly string[],
): boolean {
  if (roomId == null || roomId === LOBBY_ROOM_ID) return false;
  return notifRooms.includes(roomId);
}
