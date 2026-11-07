// The rooms /isomux-all-hands lists (task a37baee5). Its answer is a
// persistent entry in the target agent's chat, which every reader of the
// target room sees, so a room is listed only when the sender and every one of
// those readers may open it. The target room is always listed.

import type { UserRecord } from "../shared/types.ts";

export interface AllHandsRoomsInput {
  // The room of the agent the command was sent to.
  targetRoomId: string;
  // Every live room.
  roomIds: readonly string[];
  // The sender's user; undefined when the sender has none.
  sender: UserRecord | undefined;
  // The rooms of the sender's limits (a token limited to rooms); undefined =
  // no rooms limit.
  senderRooms: readonly string[] | undefined;
  // Every user of the office.
  users: readonly UserRecord[];
  canAccess: (user: UserRecord, roomId: string) => boolean;
  isLobby: (roomId: string) => boolean;
}

export function allHandsRoomIds(input: AllHandsRoomsInput): Set<string> {
  const { targetRoomId, sender, senderRooms, canAccess, isLobby } = input;
  const listed = new Set([targetRoomId]);
  if (!sender) return listed;
  const readers = input.users.filter((u) => canAccess(u, targetRoomId));
  for (const roomId of input.roomIds) {
    // A token limited to rooms reaches only those, never the lobby.
    if (senderRooms && (isLobby(roomId) || !senderRooms.includes(roomId)))
      continue;
    if (!canAccess(sender, roomId)) continue;
    if (readers.every((u) => canAccess(u, roomId))) listed.add(roomId);
  }
  return listed;
}
