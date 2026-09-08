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
  const neighbour = direction === "next" ? rooms[idx + 1] : idx > 0 ? rooms[idx - 1] : undefined;
  return neighbour ? { kind: "room", roomId: neighbour.id } : { kind: "lobby" };
}
