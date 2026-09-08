// Pure lobby assignment rules. Coordinates belong to the scene; the server
// reserves stable spot ids, one per connection. A null spot is overflow.
export interface LobbyAssignment {
  connectionId: string;
  lobbySpotId: string | null;
}

// Entry selects a free seat without moving existing ghosts.
export function assignLobbySpot(
  presences: readonly LobbyAssignment[],
  spotIds: readonly string[],
  connectionId: string,
  random: () => number,
): LobbyAssignment {
  const occupied = new Set(presences.map((p) => p.lobbySpotId));
  const free = spotIds.filter((id) => !occupied.has(id));
  return {
    connectionId,
    lobbySpotId:
      free.length > 0 ? free[Math.floor(random() * free.length)] : null,
  };
}

export function pickLobbySpot(
  presences: readonly LobbyAssignment[],
  spotIds: readonly string[],
  connectionId: string,
  spotId: string,
): LobbyAssignment[] {
  if (
    !spotIds.includes(spotId) ||
    presences.some((p) => p.lobbySpotId === spotId)
  )
    return [...presences];
  return presences.map((p) =>
    p.connectionId === connectionId ? { ...p, lobbySpotId: spotId } : p,
  );
}
