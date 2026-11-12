// The desktop sidebar's Pinned and Recent lists (task 5dac6b9b): two private
// fields of the member's record. UserRecord.pinnedAgents holds pinned agent
// ids and member:<userId> keys (task b2889127, shared/sidebar-pins.ts);
// recentAgents holds agent ids. This module holds their rules, so they can be
// tested without the office.

import { pinnedMemberId } from "../shared/sidebar-pins.ts";

/** How many recent agents the record keeps: enough to fill the sidebar's
 *  five Recent rows after it skips the pinned agents. A sanity bound. */
export const RECENT_AGENTS_KEPT = 30;

/** The most entries view.setPinned accepts; a longer list is refused (422). */
export const PINNED_AGENTS_MAX = 200;

/**
 * The pinned list to store: deduped (the first place wins), keeping the ids
 * of agents that exist and the member:<userId> keys of members that exist,
 * except the caller.
 */
export function pinnedAgentsToStore(
  pinned: readonly string[],
  liveIds: ReadonlySet<string>,
  liveUserIds: ReadonlySet<string>,
  selfId: string,
): string[] {
  return [...new Set(pinned)].filter((key) => {
    const userId = pinnedMemberId(key);
    if (userId === null) return liveIds.has(key);
    return userId !== selfId && liveUserIds.has(userId);
  });
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
