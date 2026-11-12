// The desktop sidebar (task c61316be): the rooms and agents beside the office
// view, an agent's chat and the pages, Codex-style. This module holds its decisions,
// so they can be tested without a DOM; ui/components/ChatSidebar.tsx draws it.

import type { AgentInfo, RoomWire } from "../shared/types.ts";
import { DESK_COUNT, isBackSeat } from "../shared/desks.ts";
import { pinnedMemberId } from "../shared/sidebar-pins.ts";

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
  // The Pinned and Recent sections (task 5dac6b9b).
  pinned: boolean;
  recent: boolean;
  // The Members section (Members chat and the 1:1 chats). Absent (saved
  // before the section) is open.
  members?: boolean;
  anchor: string | null;
};

export const CHAT_SIDEBAR_SECTIONS_DEFAULT: ChatSidebarSections = {
  rooms: [],
  back: [],
  more: false,
  lobby: true,
  pinned: true,
  recent: true,
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
    pinned: s.pinned,
    recent: s.recent,
    ...(s.members !== undefined ? { members: s.members } : {}),
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

/** The sidebar's width range and default, in px (task 5dac6b9b). */
export const CHAT_SIDEBAR_WIDTH_MIN = 200;
export const CHAT_SIDEBAR_WIDTH_MAX = 440;
export const CHAT_SIDEBAR_WIDTH_DEFAULT = 260;

/** A width within CHAT_SIDEBAR_WIDTH_MIN..MAX, rounded to a whole px; the
 *  default for a value that is not a finite number. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_SIDEBAR_WIDTH_DEFAULT;
  return Math.round(
    Math.min(CHAT_SIDEBAR_WIDTH_MAX, Math.max(CHAT_SIDEBAR_WIDTH_MIN, width)),
  );
}

/**
 * What one agent asks of the member, as the orange badge on its row counts
 * it: its open asks, plus one when it waits on a permission prompt.
 */
export function agentAttention(agent: AgentInfo, askCount: number): number {
  return askCount + (agent.pendingPrompt === "permission" ? 1 : 0);
}

/**
 * The summary on a folded room or back room: how many of its agents work
 * (thinking or running a tool), and the sum of their row badges
 * (agentAttention).
 */
export function roomSummary(
  agents: readonly AgentInfo[],
  askCountByAgent: ReadonlyMap<string, number>,
): { working: number; attention: number } {
  let working = 0;
  let attention = 0;
  for (const a of agents) {
    if (a.state === "thinking" || a.state === "tool_executing") working++;
    attention += agentAttention(a, askCountByAgent.get(a.id) ?? 0);
  }
  return { working, attention };
}

/** A row of the Pinned section: an agent or a member, with its pin key. */
export type PinnedRow<M> =
  | { kind: "agent"; key: string; agent: AgentInfo }
  | { kind: "member"; key: string; member: M };

/**
 * The Pinned section: the pinned agents and members (task b2889127) the
 * client has, in the member's order. A removed member is skipped: the server
 * drops its key on the next write.
 */
export function pinnedRows<M extends { id: string; removed: boolean }>(
  pinnedKeys: readonly string[],
  agents: readonly AgentInfo[],
  members: readonly M[],
): PinnedRow<M>[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const memberById = new Map(members.map((m) => [m.id, m]));
  return pinnedKeys.flatMap((key): PinnedRow<M>[] => {
    const userId = pinnedMemberId(key);
    if (userId === null) {
      const agent = agentById.get(key);
      return agent ? [{ kind: "agent", key, agent }] : [];
    }
    const member = memberById.get(userId);
    return member && !member.removed ? [{ kind: "member", key, member }] : [];
  });
}

/** How many agents the Recent section lists. */
export const RECENT_AGENTS_SHOWN = 5;

/**
 * The Recent section: the first `count` recent agents, newest first, that
 * are not pinned and that the client has.
 */
export function recentAgentsList(
  recentIds: readonly string[],
  pinnedIds: readonly string[],
  agents: readonly AgentInfo[],
  count: number = RECENT_AGENTS_SHOWN,
): AgentInfo[] {
  const pinned = new Set(pinnedIds);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: AgentInfo[] = [];
  for (const id of recentIds) {
    if (out.length >= count) break;
    const agent = byId.get(id);
    if (agent && !pinned.has(id) && !out.includes(agent)) out.push(agent);
  }
  return out;
}

/**
 * The room order after the member drops room `id` before (or after) room
 * `targetId`. Returns `order` unchanged when either id is missing or the two
 * are the same.
 */
export function moveRoom(
  order: readonly string[],
  id: string,
  targetId: string,
  before: boolean,
): string[] {
  if (id === targetId || !order.includes(id) || !order.includes(targetId))
    return [...order];
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(targetId) + (before ? 0 : 1);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The pinned order after the member drops pin key `id` before (or after)
 *  pin key `targetId`; same rules as moveRoom. */
export const movePinned = moveRoom;
