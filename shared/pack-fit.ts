// The messaging rule of permission packs (task 134b8f77): a sender with a
// pack writes only to agents whose access fits inside that pack.

import {
  stopHasFolder,
  stopHasPack,
  stopIncludes,
  type AgentAccess,
} from "./agent-access.ts";
import {
  API_TOKEN_PRESETS,
  parseApiTokenLimits,
  writesEqualFullAccess,
  type ApiTokenArea,
  type ApiTokenAreaLevels,
  type ApiTokenLimits,
} from "./api-token-limits.ts";

// A member's permission pack (UserRecord.pack): the areas their identities
// reach and the highest stop their agents may sit at.
export interface MemberPack {
  areas: ApiTokenAreaLevels;
  agentCeiling: AgentAccess;
}

// The stops a member's agents may be capped at: those with a pack, and chat.
export const MEMBER_CEILING_STOPS = [
  "chat",
  "office",
  "folder",
  "web",
] as const satisfies readonly AgentAccess[];
const MEMBER_CEILINGS: ReadonlySet<string> = new Set(MEMBER_CEILING_STOPS);

// A member pack from a request or users.json, or null when it does not parse.
export function parseMemberPack(value: unknown): MemberPack | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const { areas, agentCeiling, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof agentCeiling !== "string" || !MEMBER_CEILINGS.has(agentCeiling))
    return null;
  const limits = parseApiTokenLimits({ areas });
  if (!limits?.areas) return null;
  return { areas: limits.areas, agentCeiling: agentCeiling as AgentAccess };
}

// Whether two packs give the same areas and ceiling, whatever the key order.
export function samePack(
  a: MemberPack | null | undefined,
  b: MemberPack | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  const keys = new Set([...Object.keys(a.areas), ...Object.keys(b.areas)]);
  return (
    a.agentCeiling === b.agentCeiling &&
    [...keys].every(
      (k) =>
        a.areas[k as keyof MemberPack["areas"]] ===
        b.areas[k as keyof MemberPack["areas"]],
    )
  );
}

// The sender side: its areas, its rooms (absent = every room it can access)
// and the highest stop it may reach (an agent's own stop, a token's office).
export interface PackSender {
  // An agent at folder or web has a folder of its own, and the folder rules
  // let no other agent's folder overlap it: every other agent at folder or
  // web reads files it cannot.
  agent: boolean;
  areas: ApiTokenAreaLevels;
  rooms?: readonly string[];
  ceiling: AgentAccess;
}

// The agent written to: its stop, its token limits (the fixed office grant at
// office, folder and web, shared/agent-access.ts grantAt) and its room, and
// the rooms its manager reaches (an agent acts only in rooms its manager can
// access).
export interface FitTarget {
  access: AgentAccess;
  pack?: ApiTokenLimits;
  roomId: string;
  // Absent: every room (an owner, or no manager).
  managerRooms?: readonly string[];
}

// The rooms a manager's agents reach: a member's room grants; undefined
// (every room) for an owner or no manager.
export function managerRoomsOf(
  user: { role: string; allowedRooms: readonly string[] } | null | undefined,
): readonly string[] | undefined {
  return user?.role === "member" ? user.allowedRooms : undefined;
}

// Whether the rule applies to a sender with these areas. A pack with write in
// a full-access area reaches everything already, so it counts as no pack.
export function packCountsForRule(areas: ApiTokenAreaLevels): boolean {
  return !Object.entries(areas).some(
    ([area, level]) =>
      level === "write" && writesEqualFullAccess(area as ApiTokenArea),
  );
}

const LEVEL_RANK = { read: 1, write: 2 } as const;

// Whether `target` fits inside `sender`. An agent at chat has no tools and
// fits every sender.
export function fitsInside(sender: PackSender, target: FitTarget): boolean {
  if (target.access === "chat") return true;
  if (!stopHasPack(target.access) || !target.pack?.areas) return false;
  if (!stopIncludes(sender.ceiling, target.access)) return false;
  if (sender.agent && stopHasFolder(target.access)) return false;
  for (const [area, level] of Object.entries(target.pack.areas)) {
    const own = sender.areas[area as ApiTokenArea];
    if (!own || LEVEL_RANK[own] < LEVEL_RANK[level]) return false;
  }
  // The target reaches every room its manager reaches: a room-limited sender
  // must have them all.
  if (sender.rooms) {
    const rooms = sender.rooms;
    if (!rooms.includes(target.roomId)) return false;
    if (!target.managerRooms?.every((room) => rooms.includes(room)))
      return false;
  }
  return true;
}

// The close code of an office socket whose member's permission pack changed:
// the page reloads, and the fresh connect gets the pack's snapshot.
export const ACCESS_CHANGED_CLOSE_CODE = 4003;

// The member pack presets of the member panel. Both give asks write, which a
// pack holder uses only to answer and dismiss their own asks.
export const MEMBER_PACK_PRESETS: {
  readOnly: MemberPack;
  workWithAgents: MemberPack;
} = {
  readOnly: {
    areas: { ...API_TOKEN_PRESETS.readOnly.areas, asks: "write" },
    agentCeiling: "chat",
  },
  workWithAgents: {
    areas: {
      ...API_TOKEN_PRESETS.readOnly.areas,
      asks: "write",
      agents: "write",
      agentManagement: "write",
      tasks: "write",
    },
    agentCeiling: "office",
  },
};
