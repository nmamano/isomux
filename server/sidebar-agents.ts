// The desktop sidebar's Pinned and Recent agent lists (task 5dac6b9b): two
// private fields of the member's record (UserRecord.pinnedAgents and
// recentAgents). This module holds their rules, so they can be tested
// without the office.

/** How many recent agents the record keeps: enough to fill the sidebar's
 *  five Recent rows after it skips the pinned agents. A sanity bound. */
export const RECENT_AGENTS_KEPT = 30;

/** The most agents view.setPinned accepts; a longer list is refused (422). */
export const PINNED_AGENTS_MAX = 200;

/**
 * The pinned list to store: deduped (the first place wins), without the ids
 * of agents that do not exist.
 */
export function pinnedAgentsToStore(
  pinned: readonly string[],
  liveIds: ReadonlySet<string>,
): string[] {
  return [...new Set(pinned)].filter((id) => liveIds.has(id));
}

/**
 * The recent list after the member sends a message to `agentId`: that id
 * first, then the others in their order, without the ids of agents that do
 * not exist, at most RECENT_AGENTS_KEPT. Null when the list does not change,
 * so the caller writes and emits nothing.
 */
export function nextRecentAgents(
  prev: readonly string[],
  agentId: string,
  liveIds: ReadonlySet<string>,
): string[] | null {
  const next = [
    agentId,
    ...prev.filter((id) => id !== agentId && liveIds.has(id)),
  ].slice(0, RECENT_AGENTS_KEPT);
  const same =
    next.length === prev.length && next.every((id, i) => id === prev[i]);
  return same ? null : next;
}
