// Action steps (task e3d1bc63): the human-only actions a member runs from an
// ask card. Apart from shared/types.ts, which re-exports them.

import type {
  BackupSettingsReq,
  OfficeSettingsReq,
  PreferencesReq,
  PruneTarget,
} from "./contract-shapes.ts";
import type { AgentAccess } from "./agent-access.ts";
import type { ApiTokenLimits } from "./api-token-limits.ts";
import type { MemberPack } from "./pack-fit.ts";
import type { AskStep } from "./types.ts";
import type { WhatsAppRouteTrigger } from "./whatsapp.ts";
import type {
  DiscordReplyMode,
  DiscordRouteScope,
  DiscordRouteTrigger,
} from "./discord.ts";

// An action step (task e3d1bc63): a human-only action the member runs from
// the ask card with the Apply button. It has no link; the ask closes itself
// when the state reaches the value, by the card or by hand.
export type ActionStepRequest =
  // An agent's stop on the access slider. A step an older version stored
  // may still carry a pack, which nothing reads.
  | { kind: "agent-access"; agentId: string; access: AgentAccess }
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
  | { kind: "backup-settings"; set: BackupSettingsSet }
  // A sign-in link for a member (part 4). The card shows the link; the
  // server never stores it.
  | { kind: "sign-in-link"; userId: string }
  // A member signed out on every device.
  | { kind: "member-sessions"; userId: string }
  // One sign-in session of a member ended, by its prefix.
  | { kind: "session-revoke"; userId: string; sessionPrefix: string }
  // Every pending sign-in link of a member taken back.
  | { kind: "sign-in-links-revoke"; userId: string }
  // A personal API token for the member the ask is for, as
  // POST /api/me/api-tokens takes it. The card shows the token.
  | {
      kind: "api-token";
      name: string;
      expiresInDays: 30 | 365 | null;
      limits?: ApiTokenLimits;
    }
  // One API token revoked. The server stores the token's owner, so the card
  // can name them.
  | { kind: "api-token-revoke"; tokenId: string; userId: string }
  // The office's outside access and its address.
  | { kind: "office-access"; externalAccess: boolean; publicOrigin: string }
  // Part 5. A member removed: they go to Removed members for 30 days.
  | { kind: "member-remove"; userId: string }
  // A removed member back; `agents` moves back what passed to the heir.
  | { kind: "member-restore"; userId: string; agents: boolean }
  // A removed member deleted for good.
  | { kind: "member-purge"; userId: string }
  // The office updated to the latest release the update checker knew at the
  // create.
  | { kind: "office-update"; tag: string }
  // Old files deleted for good, as POST /api/storage/prune applies them.
  | {
      kind: "storage-prune";
      target: PruneTarget;
      olderThanDays: number;
      keepPerAgent?: number;
    }
  // Old transcripts gzipped, as POST /api/storage/compress applies it.
  | { kind: "storage-compress"; olderThanDays: number }
  // One WhatsApp chat of the member routed to an agent (task 0b53ff37). The
  // agent names the chat by a part of its name; the member picks the chat on
  // the card, and Apply sends it as {chat} (WhatsAppRouteStepRun). The
  // settings are the whole row: an omitted one is the default (drafts,
  // mention, no prefix, own messages off).
  | {
      kind: "whatsapp-route";
      chatName: string;
      agentId: string;
      trigger?: WhatsAppRouteTrigger;
      sendDirect?: boolean;
      prefix?: string;
      ownMessages?: boolean;
    }
  // One Discord place of the member's bots routed to an agent (task
  // 386ec4d6). The agent names the place by a part of its name (a channel, a
  // category or a server), and `scope` narrows the match; the member picks
  // the place on the card, and Apply sends it (DiscordRouteStepRun). The
  // settings are the whole route: an omitted one is the default (mention,
  // replies wait for Send, no prefix, bot posts and react off).
  | {
      kind: "discord-route";
      placeName: string;
      agentId: string;
      scope?: DiscordRouteScope;
      trigger?: DiscordRouteTrigger;
      replyMode?: DiscordReplyMode;
      prefix?: string;
      includeBots?: boolean;
      react?: boolean;
    };

// The body of POST /api/asks/:askId/action for a whatsapp-route step: the
// chat the member picked. Other kinds take no body.
export interface WhatsAppRouteStepRun {
  chat: string;
}

// The body of POST /api/asks/:askId/action for a discord-route step: the
// place the member picked.
export interface DiscordRouteStepRun {
  botId: string;
  guildId: string;
  scope: DiscordRouteScope;
  targetId: string;
}

export type MemberViewList = "shown" | "tucked" | "notif" | "push";

// What a settings step sets: the route's body, less the office settings
// version, which the run reads, and less the recording word list, which an
// ask may not set (ASK_PREFERENCE_KEYS).
export type MemberPreferencesSet = Omit<PreferencesReq, "recordingWords">;
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
  "sign-in-link",
  "member-sessions",
  "session-revoke",
  "sign-in-links-revoke",
  "api-token",
  "api-token-revoke",
  "office-access",
  "member-remove",
  "member-restore",
  "member-purge",
  "office-update",
  "storage-prune",
  "storage-compress",
  "whatsapp-route",
  "discord-route",
]);

// Whether a step is one the member runs from the card.
export function isActionStep(step: AskStep): step is ActionStepRequest {
  return ACTION_STEP_KINDS.has(step.kind);
}
