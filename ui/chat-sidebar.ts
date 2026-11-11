// The desktop sidebar (task c61316be): the rooms and agents beside the office
// view, an agent's chat and the pages, Codex-style. This module holds its decisions,
// so they can be tested without a DOM; ui/components/ChatSidebar.tsx draws it.

import type { AgentInfo, RoomWire } from "../shared/types.ts";
import { DESK_COUNT, isBackSeat } from "../shared/desks.ts";

export type ChatSidebarChoice = "open" | "closed";

/**
 * The top-bar buttons the open sidebar repeats (NavAction ids), hidden while
 * it is open: the office bar's pages and Settings, and the chat bar's Tasks
 * and Inbox.
 */
export const OFFICE_BAR_TWINS: ReadonlySet<string> = new Set([
  "tasks",
  "cronjobs",
  "apps",
  "skills",
  "integrations",
  "inbox",
  "settings",
]);
export const CHAT_BAR_TWINS: ReadonlySet<string> = new Set(["tasks", "inbox"]);

/**
 * Which sidebar sections are open, kept per device (ui/device-settings.ts):
 * the rooms, the back rooms (by room id), Tucked rooms and the Lobby.
 * `anchor` is the last anchor key the sidebar acted on, so a reload to the
 * same agent or room does not open again what the member closed.
 */
export type ChatSidebarSections = {
  rooms: string[];
  back: string[];
  more: boolean;
  lobby: boolean;
  anchor: string | null;
};

export const CHAT_SIDEBAR_SECTIONS_DEFAULT: ChatSidebarSections = {
  rooms: [],
  back: [],
  more: false,
  lobby: true,
  anchor: null,
};

/**
 * The sections after the anchor (the open agent's room, else the room in
 * view) settles: a new anchor opens its room (and back room, and Tucked
 * rooms). Returns `s` itself when nothing changes.
 */
export function sidebarSectionsForAnchor(
  s: ChatSidebarSections,
  anchor: { key: string; room: string | null; back: boolean; tucked: boolean },
  ready: boolean,
): ChatSidebarSections {
  // Before the saved view is back, the anchor is not the one the member left.
  if (!ready || anchor.key === s.anchor) return s;
  const { room } = anchor;
  if (room === null) return { ...s, anchor: anchor.key };
  return {
    rooms: s.rooms.includes(room) ? s.rooms : [...s.rooms, room],
    back: anchor.back && !s.back.includes(room) ? [...s.back, room] : s.back,
    more: s.more || anchor.tucked,
    lobby: s.lobby,
    anchor: anchor.key,
  };
}

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
