// The order phone swipes walk through the tab bar: the Lobby, then the rooms
// in tab order, wrapping at both ends. Nil: a swipe never skips the lobby.

export type CycleTarget = { kind: "lobby" } | { kind: "room"; roomId: string };

export function swipeTarget(
  rooms: readonly { id: string }[],
  currentRoomId: string | null,
  lobbyOpen: boolean,
  direction: "next" | "prev",
): CycleTarget | null {
  if (rooms.length === 0) return null;
  const last = rooms[rooms.length - 1];
  const first = rooms[0];
  if (lobbyOpen) {
    return { kind: "room", roomId: direction === "next" ? first.id : last.id };
  }
  const idx = rooms.findIndex((r) => r.id === currentRoomId);
  const neighbour =
    direction === "next"
      ? rooms[idx + 1]
      : idx > 0
        ? rooms[idx - 1]
        : undefined;
  return neighbour ? { kind: "room", roomId: neighbour.id } : { kind: "lobby" };
}

const NO_ROOMS: string[] = [];

// The member's tucked rooms, from their own user record.
export function selfTuckedRooms(
  users: Iterable<{ id: string; tucked?: string[] }>,
  selfId: string | null,
): readonly string[] {
  for (const u of users) {
    if (u.id === selfId) return u.tucked ?? NO_ROOMS;
  }
  return NO_ROOMS;
}

// The room tabs in the tab bar, in order: the rooms that are not tucked, then
// the open room when it is tucked, so the member always sees which room is
// open. Swipes walk this list too.
export function tabBarRooms<T extends { id: string }>(
  rooms: readonly T[],
  tucked: readonly string[],
  currentRoomId: string | null,
  lobbyOpen: boolean,
): T[] {
  const tuckedSet = new Set(tucked);
  const tabs = rooms.filter((r) => !tuckedSet.has(r.id));
  const open = lobbyOpen
    ? undefined
    : rooms.find((r) => r.id === currentRoomId && tuckedSet.has(r.id));
  return open ? [...tabs, open] : tabs;
}
