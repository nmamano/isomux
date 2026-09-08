// Pure lobby assignment rules. Coordinates belong to the scene; the server
// reserves stable spot ids, one per connection. A null spot is overflow.
export interface LobbyAssignment {
  connectionId: string;
  lobbySpotId: string | null;
  lobbyMoveAt: number;
}

export function lobbyDwell(now: number, random: () => number): number {
  return now + 15_000 + Math.floor(random() * 10_000);
}

// Entry does not move existing ghosts. Leave enough free seats for all older
// waiting connections; the next tick promotes them in insertion order.
export function assignLobbySpot(
  presences: readonly LobbyAssignment[],
  spotIds: readonly string[],
  connectionId: string,
  now: number,
  random: () => number,
): LobbyAssignment {
  const occupied = new Set(presences.map((p) => p.lobbySpotId));
  const free = spotIds.filter((id) => !occupied.has(id));
  const waiting = presences.filter((p) => p.lobbySpotId === null).length;
  return {
    connectionId,
    lobbySpotId:
      free.length > waiting ? free[Math.floor(random() * free.length)] : null,
    lobbyMoveAt: lobbyDwell(now, random),
  };
}

export function planLobbyMoves(
  presences: readonly LobbyAssignment[],
  spotIds: readonly string[],
  now: number,
  random: () => number,
): LobbyAssignment[] {
  const occupied = new Set(
    presences.flatMap((p) => (p.lobbySpotId ? [p.lobbySpotId] : [])),
  );
  // Promote waiting connections in map insertion order (earliest still waiting
  // first), before seated ghosts can claim a free spot.
  const result = new Map<string, LobbyAssignment>();
  for (const p of [
    ...presences.filter((p) => p.lobbySpotId === null),
    ...presences.filter((p) => p.lobbySpotId !== null),
  ]) {
    if (p.lobbySpotId !== null && p.lobbyMoveAt > now) {
      result.set(p.connectionId, p);
      continue;
    }
    const free = spotIds.filter((id) => !occupied.has(id));
    const spot = free.length
      ? free[Math.floor(random() * free.length)]
      : p.lobbySpotId;
    if (spot !== p.lobbySpotId) {
      if (p.lobbySpotId) occupied.delete(p.lobbySpotId);
      if (spot) occupied.add(spot);
    }
    result.set(p.connectionId, {
      ...p,
      lobbySpotId: spot,
      lobbyMoveAt: lobbyDwell(now, random),
    });
  }
  return presences.map((p) => result.get(p.connectionId)!);
}

export function pickLobbySpot(
  presences: readonly LobbyAssignment[],
  spotIds: readonly string[],
  connectionId: string,
  spotId: string,
  now: number,
  random: () => number,
): LobbyAssignment[] {
  if (
    !spotIds.includes(spotId) ||
    presences.some((p) => p.lobbySpotId === spotId)
  )
    return [...presences];
  return presences.map((p) =>
    p.connectionId === connectionId
      ? { ...p, lobbySpotId: spotId, lobbyMoveAt: lobbyDwell(now, random) }
      : p,
  );
}
