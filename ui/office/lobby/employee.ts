// Employee of the Minute for the lobby: office-wide, so the plaque names the
// agent that acted last in ANY room the boss can see. Recovered from git tag
// eotm-plaque (task fbf4bad6), where it was per room and the office walls
// had no space for it.

/** Whoever acted last. `stateChangedAt` is the timestamp store.tsx stamps on
 *  every agent_updated that carries a state. Agents never seen changing state
 *  count as 0, and ties go to the lowest desk in the lowest room index so the
 *  result is a function of the state, not of arrival order. */
export function employeeOfTheMinute<
  T extends { id: string; roomId: string; desk: number },
>(
  agents: readonly T[],
  stateChangedAt: ReadonlyMap<string, number>,
  roomOrder: readonly string[] = [],
): T | null {
  let best: T | null = null;
  let bestAt = -1;
  const rank = (a: T) => {
    const i = roomOrder.indexOf(a.roomId);
    return (i === -1 ? roomOrder.length : i) * 1000 + a.desk;
  };
  for (const a of agents) {
    const at = stateChangedAt.get(a.id) ?? 0;
    if (best === null || at > bestAt || (at === bestAt && rank(a) < rank(best))) {
      best = a;
      bestAt = at;
    }
  }
  return best;
}

/** How long a crown holder has to be out-acted before the crown moves on.
 *  The raw signal restamps several times a second for a streaming agent, so
 *  the argmax alone would swap the face continuously. */
export const CROWN_HOLD_MS = 60_000;

/** Who wears the crown now. Pure: both timestamps come from the caller. A
 *  holder that has left arrives here as null and the leader takes over. */
export function crownHolder(
  held: { id: string; at: number } | null,
  leader: { id: string; at: number } | null,
): string | null {
  if (!leader) return null;
  if (!held || held.id === leader.id) return leader.id;
  return leader.at - held.at >= CROWN_HOLD_MS ? leader.id : held.id;
}
