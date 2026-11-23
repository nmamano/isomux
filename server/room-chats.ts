// The room chats (task 5b055cf3): one group chat per room. Each is a members
// chat store (server/members-chat.ts). The lobby's chat is the old members
// chat at <STATE_ROOT>/members-chat, so its history, pins and read pointers
// stay where they were. Every other room keeps its chat at
// <STATE_ROOT>/room-chats/<roomId>, made at the first write. A closed room's
// files stay on disk; the routes refuse a closed room, and a new room never
// takes the id of a chat folder (server/office-persistence.ts createRoom).

import { join } from "path";
import {
  createMembersChatStore,
  type MembersChatStore,
} from "./members-chat.ts";

export interface RoomChats {
  // The store of a room's chat. The caller checks that the room is live.
  forRoom(roomId: string): MembersChatStore;
}

export function createRoomChats(opts: {
  // <STATE_ROOT>/room-chats
  dir: string;
  lobbyStore: MembersChatStore;
  isLobby(roomId: string): boolean;
  // Passed to each room's store (createMembersChatStore).
  joinedAt?: (userId: string) => number | null;
}): RoomChats {
  const stores = new Map<string, MembersChatStore>();
  return {
    forRoom(roomId) {
      if (opts.isLobby(roomId)) return opts.lobbyStore;
      let store = stores.get(roomId);
      if (!store) {
        store = createMembersChatStore(join(opts.dir, roomId), {
          joinedAt: opts.joinedAt,
        });
        stores.set(roomId, store);
      }
      return store;
    },
  };
}

// The rooms a member reaches now and did not reach before: at a grant, an
// owner promotion or a pack that gains the membersChat area, their read
// pointer in each of these moves to the newest post, so an old room does not
// open with every post unread.
export function newlyReachedRooms(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  return [...after].filter((roomId) => !before.has(roomId));
}

// Moves userId's read pointer to the newest post of each room's chat.
export function markRoomChatsRead(
  roomChats: RoomChats,
  userId: string,
  roomIds: readonly string[],
): void {
  for (const roomId of roomIds) {
    const store = roomChats.forRoom(roomId);
    const newest = store.newestId();
    if (newest) store.setReadPointer(userId, newest);
  }
}
