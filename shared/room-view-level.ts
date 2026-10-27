// One member's view of one room, as one ordered level. Each level includes
// everything below it: a tucked room is in the view, a room with
// notifications is shown, and push comes with notifications. A tucked room
// has no notifications. The member record keeps the four room-id lists; the
// level is a read of them.
export type RoomViewLevel = "hidden" | "tucked" | "shown" | "notify" | "push";

export const ROOM_VIEW_LEVELS: readonly RoomViewLevel[] = [
  "hidden",
  "tucked",
  "shown",
  "notify",
  "push",
];

// The four lists as the member record holds them. A record from a server
// older than tucked or pushRooms has neither.
export interface RoomViewListsIn {
  hidden: readonly string[];
  tucked?: readonly string[];
  notifRooms: readonly string[];
  pushRooms?: readonly string[];
}

export interface RoomViewLists {
  hidden: string[];
  tucked: string[];
  notifRooms: string[];
  pushRooms: string[];
}

export function roomViewLevel(
  lists: RoomViewListsIn,
  roomId: string,
): RoomViewLevel {
  if (lists.hidden.includes(roomId)) return "hidden";
  if ((lists.tucked ?? []).includes(roomId)) return "tucked";
  if ((lists.pushRooms ?? []).includes(roomId)) return "push";
  if (lists.notifRooms.includes(roomId)) return "notify";
  return "shown";
}

// The list with roomId in it or out of it. An entry already in place stays
// there; a new one goes last.
function withEntry(
  list: readonly string[],
  roomId: string,
  on: boolean,
): string[] {
  if (on) return list.includes(roomId) ? [...list] : [...list, roomId];
  return list.filter((id) => id !== roomId);
}

// The four lists with only roomId changed, to exactly that level. Hidden
// leaves the tucked flag as it is: the server keeps it for a hidden room.
export function withRoomViewLevel(
  lists: RoomViewListsIn,
  roomId: string,
  level: RoomViewLevel,
): RoomViewLists {
  const rank = ROOM_VIEW_LEVELS.indexOf(level);
  const tucked = lists.tucked ?? [];
  return {
    hidden: withEntry(lists.hidden, roomId, level === "hidden"),
    tucked:
      level === "hidden"
        ? [...tucked]
        : withEntry(tucked, roomId, level === "tucked"),
    notifRooms: withEntry(
      lists.notifRooms,
      roomId,
      rank >= ROOM_VIEW_LEVELS.indexOf("notify"),
    ),
    pushRooms: withEntry(lists.pushRooms ?? [], roomId, level === "push"),
  };
}

// The stored-data invariant: notifications and push only for rooms that are
// neither hidden nor tucked, and every push room also notifies. A push room
// without notifications gains them, so the member keeps the push.
export function normalizeRoomViewLists(lists: RoomViewListsIn): RoomViewLists {
  const off = new Set([...lists.hidden, ...(lists.tucked ?? [])]);
  const pushRooms = (lists.pushRooms ?? []).filter((id) => !off.has(id));
  const notifRooms = lists.notifRooms.filter((id) => !off.has(id));
  for (const id of pushRooms) {
    if (!notifRooms.includes(id)) notifRooms.push(id);
  }
  return {
    hidden: [...lists.hidden],
    tucked: [...(lists.tucked ?? [])],
    notifRooms,
    pushRooms,
  };
}
