// Action steps (task e3d1bc63): the human-only actions a member runs from an
// ask card. Apart from shared/types.ts, which re-exports them.

import type {
  BackupSettingsReq,
  OfficeSettingsReq,
  PreferencesReq,
} from "./contract-shapes.ts";
import type { AgentAccess } from "./agent-access.ts";
import type { ApiTokenLimits } from "./api-token-limits.ts";
import type { MemberPack } from "./pack-fit.ts";
import type { AskStep } from "./types.ts";

// An action step (task e3d1bc63): a human-only action the member runs from
// the ask card with the Apply button. It has no link; the ask closes itself
// when the state reaches the value, by the card or by hand.
export type ActionStepRequest =
  // An agent's stop on the access slider, with its pack at office, folder
  // and web.
  | {
      kind: "agent-access";
      agentId: string;
      access: AgentAccess;
      pack?: ApiTokenLimits;
    }
  // One room of a member's room access, granted or removed. The agent names
  // the member by username; the server stores the id.
  | { kind: "member-room"; userId: string; roomId: string; grant: boolean }
  // A member made an office owner, or an owner made a member.
  | { kind: "member-role"; userId: string; role: "owner" | "member" }
  // A member's permission pack, or none (null).
  | { kind: "member-pack"; userId: string; pack: MemberPack | null }
  // The member's own preferences: each key set to its value.
  | { kind: "member-preferences"; set: MemberPreferencesSet }
  // One room of one of the member's own room lists: shown, tucked into the
  // tab bar's chip, notified, or pushed to their devices.
  | { kind: "member-view"; list: MemberViewList; roomId: string; on: boolean }
  // Office settings: each key set to its value.
  | { kind: "office-settings"; set: OfficeSettingsSet }
  // The backup settings: each key set to its value.
  | { kind: "backup-settings"; set: BackupSettingsSet };

export type MemberViewList = "shown" | "tucked" | "notif" | "push";

// What a settings step sets: the route's body, less the office settings
// version, which the run reads.
export type MemberPreferencesSet = PreferencesReq;
export type OfficeSettingsSet = Omit<OfficeSettingsReq, "version">;
export type BackupSettingsSet = BackupSettingsReq;

const ACTION_STEP_KINDS: ReadonlySet<string> = new Set<
  ActionStepRequest["kind"]
>([
  "agent-access",
  "member-room",
  "member-role",
  "member-pack",
  "member-preferences",
  "member-view",
  "office-settings",
  "backup-settings",
]);

// Whether a step is one the member runs from the card.
export function isActionStep(step: AskStep): step is ActionStepRequest {
  return ACTION_STEP_KINDS.has(step.kind);
}
