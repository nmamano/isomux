// The parts of a listed item's settings (task 1f79f2e3): a member, a room
// and an agent each list their parts in the Settings list column, and the
// pane shows one part. Pure and DOM-free, so the part lists and the
// field-to-part tables are unit-tested here.
//
// One table per editor maps each form field to the part that shows it. The
// part's unsaved-edits dot and the part a refused save opens both read that
// table, so the two cannot drift.
//
// Parts that act on their own: the member's OS user part and Sign-in part
// (the OS user link, the pending sign-in link, the API tokens) write at once
// through their own requests, not through the item's Save. No form field
// maps to them, so they never show the dot; the footer stays under them and
// saves the other parts. Every other part, the room's Your view included,
// goes through the item's one Save.

import type { AgentSettingsSection } from "./components/EditAgentDialog.tsx";
import type { AgentFormSnapshot } from "./components/EditAgentDialog.tsx";

export type MemberPart =
  | "general"
  | "access"
  | "rooms"
  | "instructions"
  | "osUser"
  | "signIn"
  | "chat";

// The member form's fields, as the save writes them.
export type MemberField =
  | "name"
  | "avatar"
  | "role"
  | "pack"
  | "allowedRooms"
  | "roomView"
  | "pins"
  | "prompt"
  | "memory"
  | "showToolCalls"
  | "showAgentMessages";

export const MEMBER_FIELD_PART: Record<MemberField, MemberPart> = {
  name: "general",
  avatar: "general",
  role: "access",
  pack: "access",
  allowedRooms: "rooms",
  roomView: "rooms",
  pins: "rooms",
  prompt: "instructions",
  memory: "instructions",
  showToolCalls: "chat",
  showAgentMessages: "chat",
};

// The parts a viewer gets for a member, in order. A part with nothing for
// the viewer is not listed. `targetIsOwner` is the drafted role: an owner who
// drafts the member as an owner loses the OS user part until the draft goes.
export function memberParts(v: {
  viewerIsOwner: boolean;
  isMe: boolean;
  creating: boolean;
  targetIsOwner: boolean;
}): MemberPart[] {
  const { viewerIsOwner, isMe, creating, targetIsOwner } = v;
  const parts: MemberPart[] = ["general"];
  if (viewerIsOwner) parts.push("access");
  // The rooms table (a member's access, or your own view) or another
  // member's Pinned list.
  const rooms = viewerIsOwner ? !targetIsOwner || isMe || !creating : isMe;
  if (rooms) parts.push("rooms");
  parts.push("instructions");
  if (viewerIsOwner && !creating && !targetIsOwner) parts.push("osUser");
  if (viewerIsOwner && !isMe && !creating) parts.push("signIn");
  if (viewerIsOwner && !isMe) parts.push("chat");
  return parts;
}

export type RoomPart = "general" | "instructions" | "view";

export type RoomField = "name" | "cwd" | "look" | "view" | "prompt" | "memory";

export const ROOM_FIELD_PART: Record<RoomField, RoomPart> = {
  name: "general",
  cwd: "general",
  look: "general",
  prompt: "instructions",
  memory: "instructions",
  view: "view",
};

// The parts of a room: a viewer without a view row (no full record yet) has
// no Your view. The lobby's General has no name and no look.
export function roomParts(v: { hasView: boolean }): RoomPart[] {
  const parts: RoomPart[] = ["general", "instructions"];
  if (v.hasView) parts.push("view");
  return parts;
}

// The agent form's fields: the snapshot's keys and the agent's memory.
export type AgentField = keyof AgentFormSnapshot | "memory";

export const AGENT_FIELD_PART: Record<AgentField, AgentSettingsSection> = {
  name: "general",
  outfit: "general",
  cwd: "general",
  targetEngine: "engine",
  modelFamily: "engine",
  effort: "engine",
  permissionMode: "engine",
  codexSandbox: "engine",
  autoHandoff: "engine",
  autoHandoffTokens: "engine",
  customInstructions: "instructions",
  memory: "instructions",
  manager: "access",
  access: "access",
  privileged: "access",
};

// The parts that hold at least one of `fields`.
export function dirtyParts<F extends string, P extends string>(
  table: Record<F, P>,
  fields: Iterable<F>,
): Set<P> {
  const parts = new Set<P>();
  for (const field of fields) parts.add(table[field]);
  return parts;
}

// The part that shows: `part` when the viewer has it, else the default (the
// first part, or `fallback`) on a desktop. Absent on a phone, and null
// anywhere, is the part list.
export function resolvePart<P extends string>(
  part: P | null | undefined,
  ids: readonly P[],
  isMobile: boolean,
  fallback?: P,
): P | null {
  if (part === null) return null;
  if (part === undefined && isMobile) return null;
  if (part !== undefined && ids.includes(part)) return part;
  return fallback !== undefined && ids.includes(fallback)
    ? fallback
    : (ids[0] ?? null);
}
