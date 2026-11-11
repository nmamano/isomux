// The desktop chat sidebar (task c61316be): the rooms and agents beside an
// agent's chat and the pages, Codex-style. This module holds its decisions,
// so they can be tested without a DOM; ui/components/ChatSidebar.tsx draws it.

import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type RoomWire,
} from "../shared/types.ts";
import { DESK_COUNT, isBackSeat } from "../shared/desks.ts";

export type ChatSidebarChoice = "open" | "closed";

/** Below this window width the sidebar starts collapsed. */
export const CHAT_SIDEBAR_MIN_OPEN_WIDTH = 1100;

/**
 * Whether the sidebar is open on load: the member's choice on this device,
 * else open only on a wide window.
 */
export function sidebarStartsOpen(
  stored: ChatSidebarChoice | null,
  width: number,
): boolean {
  if (stored !== null) return stored === "open";
  return width >= CHAT_SIDEBAR_MIN_OPEN_WIDTH;
}

/**
 * The room sections, in the member's order. A tucked room goes under "Tucked
 * rooms", except the open agent's room, which always shows.
 */
export function sidebarRooms(
  list: { rooms: readonly RoomWire[]; tucked: readonly string[] },
  openAgentRoomId: string | null,
): { shown: RoomWire[]; more: RoomWire[] } {
  const tucked = new Set(list.tucked);
  const shown: RoomWire[] = [];
  const more: RoomWire[] = [];
  for (const room of list.rooms) {
    if (!tucked.has(room.id) || room.id === openAgentRoomId) shown.push(room);
    else more.push(room);
  }
  return { shown, more };
}

/**
 * A room's agents: the front desks in desk order (the Tab cycle's order), and
 * the back room with the agents that wait or failed first.
 */
export function roomAgents(
  agents: readonly AgentInfo[],
  roomId: string,
): { front: AgentInfo[]; back: AgentInfo[] } {
  const inRoom = agents.filter((a) => a.roomId === roomId);
  const front = inRoom
    .filter((a) => !isBackSeat(a.desk))
    .sort((a, b) => a.desk - b.desk);
  const back = inRoom
    .filter((a) => isBackSeat(a.desk))
    .sort((a, b) => backRank(a) - backRank(b) || a.desk - b.desk);
  return { front, back };
}

// The back room lists the agents that need the member first.
function backRank(agent: AgentInfo): number {
  return agent.state === "waiting_for_response" || agent.state === "error"
    ? 0
    : 1;
}

/** The first free front desk of the room, or null for the back room. */
export function newAgentSeat(
  agents: readonly AgentInfo[],
  roomId: string,
): number | null {
  const taken = new Set(
    agents.filter((a) => a.roomId === roomId).map((a) => a.desk),
  );
  for (let desk = 0; desk < DESK_COUNT; desk++) {
    if (!taken.has(desk)) return desk;
  }
  return null;
}

/**
 * The room a new agent goes to: the open agent's room, or for a Lobby agent
 * or no agent, the last room the member stood in.
 */
export function spawnRoomFor(
  openAgent: AgentInfo | null,
  currentRoomId: string | null,
): string | null {
  if (openAgent && openAgent.roomId !== LOBBY_ROOM_ID) return openAgent.roomId;
  return currentRoomId;
}
