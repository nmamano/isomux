// The one Access control of the member panel (task 2c57281c): four levels on
// a line (Read only < Work with agents < Full access < Owner) and Custom off
// the line. Read only and Work with agents light by value; Full access only
// with no pack, Owner only with the owner role. A pack at every area write +
// Web is not Full access: a pack holder has no terminal and no Standard agents.

import {
  MEMBER_PACK_PRESETS,
  samePack,
  type MemberPack,
} from "../shared/pack-fit.ts";
import {
  API_TOKEN_AREAS,
  type ApiTokenAccess,
  type ApiTokenArea,
} from "../shared/api-token-limits.ts";
import type { AgentAccess } from "../shared/agent-access.ts";

export const MEMBER_LEVELS = [
  "readOnly",
  "workWithAgents",
  "full",
  "owner",
] as const;
export type MemberLevel = (typeof MEMBER_LEVELS)[number];

// The draft of the control: the role and the pack (null is no pack).
export interface MemberAccessDraft {
  owner: boolean;
  pack: MemberPack | null;
}

// One edit of the shown values: an area level or the agent ceiling.
export type MemberAccessEdit =
  | { area: ApiTokenArea; level: ApiTokenAccess | "none" }
  | { agentCeiling: AgentAccess };

// What Full access and Owner show: every area at write, agents up to Web.
export const FULL_ACCESS_VALUES: MemberPack = {
  areas: Object.fromEntries(API_TOKEN_AREAS.map((area) => [area, "write"])),
  agentCeiling: "web",
};

// The values the control shows for a draft.
export function shownValues(draft: MemberAccessDraft): MemberPack {
  return draft.owner || !draft.pack ? FULL_ACCESS_VALUES : draft.pack;
}

// The lit level of a draft, or custom when none is.
export function memberLevelOf(
  draft: MemberAccessDraft,
): MemberLevel | "custom" {
  if (draft.owner) return "owner";
  if (!draft.pack) return "full";
  if (samePack(draft.pack, MEMBER_PACK_PRESETS.readOnly)) return "readOnly";
  if (samePack(draft.pack, MEMBER_PACK_PRESETS.workWithAgents))
    return "workWithAgents";
  return "custom";
}

// An edit of the shown values: a member's pack, seeded from what is shown.
export function editValues(
  draft: MemberAccessDraft,
  edit: MemberAccessEdit,
): MemberAccessDraft {
  const base = shownValues(draft);
  if ("agentCeiling" in edit)
    return {
      owner: false,
      pack: { areas: { ...base.areas }, agentCeiling: edit.agentCeiling },
    };
  const areas = { ...base.areas };
  if (edit.level === "none") delete areas[edit.area];
  else areas[edit.area] = edit.level;
  return { owner: false, pack: { areas, agentCeiling: base.agentCeiling } };
}

// The draft a step sets. Owner and Full access carry no pack.
export function presetValues(level: MemberLevel): MemberAccessDraft {
  if (level === "owner") return { owner: true, pack: null };
  if (level === "full") return { owner: false, pack: null };
  const preset = MEMBER_PACK_PRESETS[level];
  return {
    owner: false,
    pack: { areas: { ...preset.areas }, agentCeiling: preset.agentCeiling },
  };
}
