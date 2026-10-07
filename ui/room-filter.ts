import type { WebhookTarget } from "../shared/types.ts";

// The room filter on the Apps, Automations and Pager pages. "all" lets everything
// through, "none" keeps the records with no room, and any other value is a
// room id. Room ids are 8-hex, so the two words cannot collide with one.
export type RoomFilter = string;
export const ROOM_FILTER_ALL = "all";
export const ROOM_FILTER_NONE = "none";

export function roomFilterMatches(
  filter: RoomFilter,
  roomId: string | null,
): boolean {
  if (filter === ROOM_FILTER_ALL) return true;
  if (filter === ROOM_FILTER_NONE) return roomId === null;
  return roomId === filter;
}

// The filter a page opens with: the room the office shows, or "all" from the
// lobby or with no known room. Pages take it at mount and do not store a
// change, so each open starts from the room it is opened from.
export function openingRoomFilter(
  currentRoomId: string | null,
  lobbyOpen: boolean,
  rooms: readonly { id: string }[],
): RoomFilter {
  return !lobbyOpen &&
    currentRoomId !== null &&
    rooms.some((room) => room.id === currentRoomId)
    ? currentRoomId
    : ROOM_FILTER_ALL;
}

// A filter that names a room this viewer no longer has falls back to "all",
// so a closed or revoked room never leaves the page empty.
export function effectiveRoomFilter(
  filter: RoomFilter,
  rooms: readonly { id: string }[],
): RoomFilter {
  if (filter === ROOM_FILTER_ALL || filter === ROOM_FILTER_NONE) return filter;
  return rooms.some((room) => room.id === filter) ? filter : ROOM_FILTER_ALL;
}

// The room of a record whose room is stored (a cronjob): it counts only while
// it names a room this viewer has.
export function knownRoomId(
  roomId: string | undefined,
  rooms: readonly { id: string }[],
): string | null {
  return roomId !== undefined && rooms.some((room) => room.id === roomId)
    ? roomId
    : null;
}

// The room of an app: its creator agent's live room (the server's visibility
// rule), or null when that agent is gone or not visible here.
export function appRoomId(
  app: { createdByAgentId?: string },
  agents: readonly { id: string; roomId: string }[],
  rooms: readonly { id: string }[],
): string | null {
  if (app.createdByAgentId === undefined) return null;
  const creator = agents.find((agent) => agent.id === app.createdByAgentId);
  return creator ? knownRoomId(creator.roomId, rooms) : null;
}

// The room of a webhook: its target's room (the server's visibility rule),
// read from the agents and schedules this viewer already has. A target this
// viewer cannot see reads as no room.
export function webhookRoomId(
  target: WebhookTarget,
  agents: readonly { id: string; roomId: string }[],
  cronjobs: readonly { id: string; roomId?: string }[],
  rooms: readonly { id: string }[],
): string | null {
  if (target.kind === "agent") {
    const agent = agents.find((candidate) => candidate.id === target.agentId);
    return agent ? knownRoomId(agent.roomId, rooms) : null;
  }
  const job = cronjobs.find((candidate) => candidate.id === target.cronjobId);
  return job ? knownRoomId(job.roomId, rooms) : null;
}

// The rooms a filter can name: the viewer's rooms, plus every room for an
// office owner (allRooms holds the rooms an owner has hidden from their view).
export function roomFilterOptions<T extends { id: string }>(
  rooms: readonly T[],
  allRooms: readonly T[],
): T[] {
  const out = [...rooms];
  for (const room of allRooms) {
    if (!out.some((known) => known.id === room.id)) out.push(room);
  }
  return out;
}
