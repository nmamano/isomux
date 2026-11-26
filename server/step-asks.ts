// Step asks (task c71cb60f): an agent asks the member to do a step on the
// Integrations page that is not a typed value (a provider sign-in, an MCP
// OAuth sign-in, a browser pairing, a room's GitHub link). The ask is a
// plain ask with a `step` and a link the server sets (for older clients: the
// card draws the step's control), so the member can still reply, dismiss or
// file it. It closes itself when the step is done.
//
// An action step (task e3d1bc63) is a human-only action the member runs from
// the card: it has a route (routeOf) and no link. The create refuses one the
// member could not run (the route's own authorization, verdict only), and
// the run (asks.runAction) dispatches that route as the member. The route is
// built from the state when it runs: a member's rooms and name now.
//
// One predicate per kind (isStepDone) reads the current state. The create
// refuses a step that is done (409 step_done), and every hook that may have
// done one calls reconcile, which closes each open step ask whose predicate
// holds. A hook says only that something changed.

import {
  packNotAccepted,
  parseAgentAccessGrant,
  sameAccessGrant,
  type AgentAccessGrant,
} from "../shared/agent-access.ts";
import {
  LOBBY_ROOM_ID,
  isActionStep,
  type ActionStepRequest,
  type AskEntry,
  type AskStep,
  type InstructionsLineStep,
  type InstructionsLineStepRun,
  type InstructionsScope,
  type MemberOsUserStep,
  type MemberViewList,
  type ProviderAccountProvider,
  type ProviderAccountScope,
  type StepAskRequest,
} from "../shared/types.ts";
import {
  ASK_PREFERENCE_KEYS,
  OS_USER_NAME_PATTERN,
  type OfficeSettingsRes,
} from "../shared/contract-shapes.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import {
  GHOST_VARIANTS,
  isGhostVariant,
  isHexColor,
  normalizeHexColor,
  type GhostVariant,
} from "../shared/avatar.ts";
import {
  parseMemberPack,
  samePack,
  type MemberPack,
} from "../shared/pack-fit.ts";
import type { SupportedLanguageCode } from "../shared/languages.ts";
import {
  DEFAULT_VOICE_NAME,
  type VoiceInput,
  type VoiceName,
  type VoiceOutput,
} from "../shared/voice.ts";
import { ASK_RULE_LINE_MAX, type AskStore } from "./asks.ts";
import { isRunnableCommand } from "../shared/runnable-command.ts";
import { backupSettingsShapeError } from "./backup.ts";
import { hostedAccessRule } from "./install-kind.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import {
  OFFICE_NAME_MAX,
  OFFICE_SETTINGS_SWITCHES,
  officeSettingsFieldError,
} from "./routes/handlers/office-settings.ts";
import { parsePreferenceChange } from "./routes/handlers/preferences.ts";
import { parseApiTokenCreate } from "./routes/handlers/api-tokens.ts";
import type { SecretScope } from "./secret-store.ts";
import {
  MIN_OLDER_THAN_DAYS,
  parsePruneRequest,
} from "./routes/handlers/storage.ts";
import { compareCalver } from "./update-checker.ts";
import type { StorageApplied } from "./office-storage-routes.ts";
import {
  WHATSAPP_PREFIX_MAX,
  WHATSAPP_ROUTE_NAME_MAX,
  normaliseWhatsAppPhone,
  normaliseWhatsAppPrefix,
  normaliseWhatsAppRouteName,
  whatsappChatMatches,
  whatsappPhoneChat,
  type WhatsAppChatSeen,
  type WhatsAppRoute,
  type WhatsAppRouteDead,
} from "../shared/whatsapp.ts";
import { replySettings } from "./whatsapp/routes.ts";
import { discordRouteSettings } from "./discord/routes.ts";
import { logRetentionSettingsShapeError } from "./storage-retention.ts";
import {
  discordPlacesMatching,
  normaliseDiscordPrefix,
  normaliseDiscordRouteName,
  type DiscordGuildSeen,
  type DiscordPlace,
  type DiscordReplyMode,
  type DiscordRoute,
  type DiscordRouteDead,
  type DiscordRouteTrigger,
} from "../shared/discord.ts";
import type { UpdateStatusWire } from "../shared/types.ts";
import type {
  MemberOsUserWire,
  PruneTarget,
} from "../shared/contract-shapes.ts";

export interface StepAskDeps {
  asks: AskStore;
  isOfficeOwner: (userId: string) => boolean;
  // The current state each predicate reads.
  providerConnected: (
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ) => Promise<boolean>;
  // An MCP server of the scope: whether it signs in with OAuth, and whether
  // it holds a sign-in. Null when the scope has no server of this name.
  mcpServer: (
    scope: SecretScope,
    name: string,
  ) => { oauth: boolean; signedIn: boolean } | null;
  browserPaired: (userId: string) => boolean;
  roomLinked: (roomId: string) => boolean;
  // The step is done: a system line in the agent's chat, and the same line
  // to the agent as an office notice from the member the ask is for.
  settled: (
    agentId: string,
    askId: string,
    line: LogMessage,
    memberUserId: string,
  ) => void;
  // The reads of the steps the member runs from the card (task e3d1bc63).
  // Absent in leaf tests: every such step is then refused at create.
  runs?: StepRunDeps;
}

// The office route a step's action runs, as the card's Apply sends it.
export interface StepRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export interface StepRunDeps {
  // The agent's name and grant now, or null when it is gone.
  agent(agentId: string): { name: string; grant: AgentAccessGrant } | null;
  // Whether the asking agent reaches the target agent's room.
  agentReaches(askingAgentId: string, targetAgentId: string): boolean;
  // The member's name, role and rooms now, or null when they are gone.
  member(userId: string): {
    name: string;
    role: "owner" | "member";
    allowedRooms: readonly string[];
    avatarColor: string;
    avatarVariant: GhostVariant;
  } | null;
  // The member's pack, preferences and room lists now, or null when they
  // are gone (task e3d1bc63, part 3).
  memberSettings(userId: string): MemberSettings | null;
  // The office settings now, with the version a write must carry.
  officeSettings(): OfficeSettingsRes;
  // The stored backup settings (dir null: the default folder).
  backupSettings(): {
    intervalHours: number;
    retention: number;
    dir: string | null;
  };
  // Whether ISOMUX_BACKUP_DIR sets the backup folder.
  backupDirFromEnv(): boolean;
  // The ages of the daily automatic log cleanup now (deleteAfterDays null:
  // off).
  logRetention(): { compressAfterDays: number; deleteAfterDays: number | null };
  // The room's name, or null when there is no such room.
  roomName(roomId: string): string | null;
  // The instructions of an agent, a room or a member now (task 33891b5b),
  // with the version a write must carry; null when the target is gone.
  instructions(
    scope: InstructionsScope,
    targetId: string,
  ): { text: string | null; version: string } | null;
  // The id of the member with this username, or null.
  memberIdByName(username: string): string | null;
  // Whether the room is open now: the lobby or a live room.
  roomOpen(roomId: string): boolean;
  // Whether the asking agent reaches the room, as its token does.
  agentReachesRoom(askingAgentId: string, roomId: string): boolean;
  // Whether this member is the only office owner.
  lastOwner(userId: string): boolean;
  // The refusal agents.setAccess gives past its guards (the folder rule, the
  // engine), or null.
  accessRefusal(
    agentId: string,
    grant: AgentAccessGrant,
  ): { code: string; message: string } | null;
  // Part 4: the member's live sessions and pending sign-in links, each with
  // its prefix (the path a revoke takes) and when it was made, and whether
  // the session is the one of `sessionIdHash`.
  memberSessions(
    userId: string,
    callerSessionIdHash?: string,
  ): { prefix: string; createdAt: number; current: boolean }[];
  // The links are the ones an office owner sees: unused, live or expired but
  // still extendable (task 8852553c), with the expiry and whether an owner
  // can extend the link.
  memberInvites(userId: string): {
    prefix: string;
    createdAt: number;
    expiresAt: number;
    extendable: boolean;
  }[];
  // The member's live API tokens.
  memberApiTokens(
    userId: string,
  ): { id: string; name: string; createdAt: number }[];
  // A live API token's owner, or null.
  apiToken(tokenId: string): { userId: string } | null;
  // The rooms the member may limit a token to, as the mint reads them.
  tokenLimitableRoomIds(userId: string): ReadonlySet<string>;
  // The saved access settings, and whether Hosted Isomux manages them.
  officeAccess(): {
    hosted: boolean;
    externalAccess: boolean;
    publicOrigin: string | null;
  };
  // Whether ending every live session of this member leaves the office with
  // no live owner session.
  signOutStrandsOffice(userId: string): boolean;
  // Whether ending the member's one live session with this prefix leaves the
  // office with no live owner session.
  sessionRevokeStrandsOffice(userId: string, sessionPrefix: string): boolean;
  // Part 5: a removed member's name, or null when no removed member has this
  // id; and the id of the removed member with this username (a removed
  // member's name stays reserved, so there is at most one).
  removedMember(userId: string): { name: string } | null;
  removedMemberIdByName(username: string): string | null;
  // The update checker's status now.
  updateStatus(): UpdateStatusWire;
  // How many files a prune or compress would take now (a dry plan).
  pruneCandidates(
    target: PruneTarget,
    olderThanDays: number,
    keepPerAgent: number,
  ): number;
  compressCandidates(olderThanDays: number): number;
  // The last prune applied to the target and the last compress, or null.
  lastPrune(target: PruneTarget): StorageApplied | null;
  lastCompress(): StorageApplied | null;
  // The member's WhatsApp (task 0b53ff37): whether they linked it, the chats
  // their bridge saw since it started (groups come at each connect), their
  // rows as stored (a read that never writes), and why an agent cannot be a
  // row's agent for them.
  whatsapp: {
    linked(userId: string): boolean;
    chatsSeen(userId: string): WhatsAppChatSeen[];
    rows(userId: string): WhatsAppRoute[];
    agentProblem(userId: string, agentId: string): WhatsAppRouteDead | null;
  };
  // The member's Discord (task 386ec4d6): their stored bots, the servers a
  // bot is in now (null when it has not connected yet), their routes as
  // stored (a read that never writes), and why an agent cannot be a route's
  // agent for them.
  discord: {
    bots(userId: string): { id: string; name: string }[];
    guilds(userId: string, botId: string): DiscordGuildSeen[] | null;
    routes(userId: string): DiscordRoute[];
    agentProblem(userId: string, agentId: string): DiscordRouteDead | null;
  };
  // Task 4088f164. The member's OS user as the owner's Members page reads it
  // (memberOsUserView, without the candidates), or null when the member is
  // gone.
  memberOsUser(userId: string): MemberOsUserWire | null;
  // How the office can run the member's root command itself (the GET's run
  // field): null where it cannot.
  osUserRunMode(): Promise<MemberOsUserWire["run"]>;
  // The existing OS users an owner can give a member, and the names a new
  // user cannot take. Each null when it could not be read in full: the
  // create then accepts the name, and the root command checks it at run.
  osUserNames(): Promise<{ existing: string[] | null; taken: string[] | null }>;
  // Whether the member passes the route's own authorization, as from the
  // page: the refusal, or null. Runs nothing.
  authorizeAs(
    memberUserId: string,
    route: StepRoute,
  ): { status: 403 | 404 | 422; code: string; message: string } | null;
}

// `accessible` is every room the member reaches, hidden ones included.
export interface MemberSettings {
  pack: MemberPack | null;
  language: SupportedLanguageCode | null;
  voiceInput?: VoiceInput;
  voiceOutput?: VoiceOutput;
  voiceName?: VoiceName;
  showToolCalls?: true;
  showAgentMessages?: true;
  accessible: readonly string[];
  hidden: readonly string[];
  tucked: readonly string[];
  notifRooms: readonly string[];
  pushRooms: readonly string[];
}

// A step refused at create or at run.
export interface StepFailure {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422;
  code: string;
  message: string;
}

// A step with a link opens an Integrations tab; a step with a route has none:
// the member runs it from the card.
export type StepCheck =
  { ok: true; step: AskStep; link?: string } | StepFailure;

// The routes an action step runs now, in order, or why it cannot run (its
// target is gone). The run stops at the first refusal; the routes are read
// from the state when it runs, so a retry does the rest.
export type StepRun = { ok: true; routes: StepRoute[] } | StepFailure;

const STEP_LINKS: Record<StepAskRequest["kind"], string> = {
  "provider-sign-in": "/integrations/providers",
  "mcp-sign-in": "/integrations/mcp",
  "browser-pairing": "/integrations/browser",
  "github-link": "/integrations/github",
};

// The Integrations tab a step's link opens (one of OFFICE_LINK_PATHS), or
// undefined for a step the member runs from the card.
export function stepLink(step: AskStep): string | undefined {
  return Object.hasOwn(STEP_LINKS, step.kind)
    ? STEP_LINKS[step.kind as StepAskRequest["kind"]]
    : undefined;
}

// The fields an agent may send, per kind. The server fills ownerUserId,
// roomId, and the userId of a member step from its username.
const STEP_KEYS: Record<AskStep["kind"], readonly string[]> = {
  "provider-sign-in": ["kind", "provider", "scope"],
  "mcp-sign-in": ["kind", "name", "scope"],
  "browser-pairing": ["kind"],
  "github-link": ["kind"],
  "agent-access": ["kind", "agentId", "access", "pack"],
  "member-room": ["kind", "username", "roomId", "grant"],
  "member-role": ["kind", "username", "role"],
  "member-pack": ["kind", "username", "pack"],
  "member-preferences": ["kind", "set"],
  "member-view": ["kind", "list", "roomId", "on"],
  "office-settings": ["kind", "set"],
  "backup-settings": ["kind", "set"],
  "sign-in-link": ["kind", "username"],
  "member-sessions": ["kind", "username"],
  "sign-in-links-revoke": ["kind", "username"],
  "sign-in-link-extend": ["kind", "username"],
  "member-avatar": ["kind", "username", "avatarColor", "avatarVariant"],
  "session-revoke": ["kind", "username", "sessionPrefix"],
  "api-token": ["kind", "name", "expiresInDays", "limits"],
  "api-token-revoke": ["kind", "tokenId"],
  "office-access": ["kind", "externalAccess", "publicOrigin"],
  "member-remove": ["kind", "username"],
  "member-restore": ["kind", "username", "agents"],
  "member-purge": ["kind", "username"],
  "office-update": ["kind"],
  "storage-prune": ["kind", "target", "olderThanDays", "keepPerAgent"],
  "storage-compress": ["kind", "olderThanDays"],
  "discord-route": [
    "kind",
    "placeName",
    "agentId",
    "scope",
    "trigger",
    "replyMode",
    "prefix",
    "includeBots",
    "react",
  ],
  "whatsapp-route": [
    "kind",
    "chatName",
    "phone",
    "agentId",
    "trigger",
    "sendDirect",
    "prefix",
    "ownMessages",
  ],
  "messaging-route": ["kind", "routeId", "set"],
  "storage-retention": ["kind", "set"],
  // The server fills targetId (task 33891b5b).
  "instructions-line": ["kind", "scope", "line"],
  "member-os-user": ["kind", "username", "on", "osUser", "existing"],
};

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;

// The longest a create waits for the clock to pass a stored stamp.
const MAX_CLOCK_WAIT_MS = 5;

const invalid = (message: string): StepFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

const notAllowed = (message: string): StepFailure => ({
  ok: false,
  status: 403,
  code: "member_not_allowed",
  message,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// An instructions-line step's text (task 33891b5b), as the scope's
// instructions hold it, and the text with the line added at its end, on its
// own line. A line is in the text when one of its lines, trimmed, is it.
function holdsLine(text: string | null, line: string): boolean {
  const want = line.trim();
  return (text ?? "").split("\n").some((l) => l.trim() === want);
}
function withLine(text: string | null, line: string): string {
  const now = text ?? "";
  if (now === "") return line;
  return now.endsWith("\n") ? `${now}${line}` : `${now}\n${line}`;
}
// Why a line cannot be an instructions line, or null: it goes verbatim into
// a system prompt, so one line that shows all it holds.
function lineRefusal(line: unknown): string | null {
  if (typeof line !== "string" || line.trim() === "")
    return "step.line is the line to add";
  if (line.includes("\n")) return "step.line is one line";
  if (line.length > ASK_RULE_LINE_MAX)
    return `step.line is at most ${ASK_RULE_LINE_MAX} characters`;
  if (!isRunnableCommand(line))
    return "step.line has characters that do not show";
  return null;
}
const INSTRUCTIONS_SCOPES: readonly InstructionsScope[] = [
  "agent",
  "room",
  "member",
];

const isKnownKind = (kind: unknown): kind is AskStep["kind"] =>
  typeof kind === "string" && Object.hasOwn(STEP_KEYS, kind);

type StepEntry = AskEntry & { step: AskStep };

// The secrets scope of an MCP sign-in step.
function mcpScope(
  step: Extract<AskStep, { kind: "mcp-sign-in" }>,
): SecretScope | null {
  if (step.scope === "office") return { kind: "office" };
  return step.ownerUserId ? { kind: "user", userId: step.ownerUserId } : null;
}

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: AskStep, target: string): LogMessage {
  switch (step.kind) {
    case "member-os-user":
      return step.on
        ? msg("systemEntries.stepAsk.memberOsUserOn", { member: target })
        : msg("systemEntries.stepAsk.memberOsUserOff", { member: target });
    case "sign-in-link-extend":
      return msg("systemEntries.stepAsk.signInLinkExtended", {
        member: target,
      });
    case "member-avatar":
      return msg("systemEntries.stepAsk.memberAvatarSet", { member: target });
    case "provider-sign-in":
      return step.scope === "office"
        ? msg("systemEntries.stepAsk.providerSignedInOffice", {
            provider: PROVIDER_LABELS[step.provider],
          })
        : msg("systemEntries.stepAsk.providerSignedIn", {
            provider: PROVIDER_LABELS[step.provider],
          });
    case "mcp-sign-in":
      return msg("systemEntries.stepAsk.mcpSignedIn", { name: step.name });
    case "browser-pairing":
      return msg("systemEntries.stepAsk.browserPaired");
    case "github-link":
      return msg("systemEntries.stepAsk.githubLinked");
    case "agent-access":
      return msg("systemEntries.stepAsk.agentAccessSet", { agent: target });
    case "member-room":
      return msg("systemEntries.stepAsk.memberRoomSet", { member: target });
    case "member-role":
      return msg("systemEntries.stepAsk.memberRoleSet", { member: target });
    case "member-pack":
      return msg("systemEntries.stepAsk.memberPackSet", { member: target });
    case "member-preferences":
      return msg("systemEntries.stepAsk.preferencesSet");
    case "member-view":
      return msg("systemEntries.stepAsk.roomViewSet", { room: target });
    case "office-settings":
      return msg("systemEntries.stepAsk.officeSettingsSet");
    case "backup-settings":
      return msg("systemEntries.stepAsk.backupSettingsSet");
    case "sign-in-link":
      return msg("systemEntries.stepAsk.signInLinkMade", { member: target });
    case "member-sessions":
      return msg("systemEntries.stepAsk.memberSignedOut", { member: target });
    case "sign-in-links-revoke":
      return msg("systemEntries.stepAsk.signInLinksRevoked", {
        member: target,
      });
    case "api-token":
      return msg("systemEntries.stepAsk.apiTokenMade", { name: step.name });
    case "api-token-revoke":
      return msg("systemEntries.stepAsk.apiTokenRevoked");
    case "session-revoke":
      return msg("systemEntries.stepAsk.sessionRevoked", { member: target });
    case "office-access":
      return msg("systemEntries.stepAsk.officeAccessSet");
    case "member-remove":
      return msg("systemEntries.stepAsk.memberRemoved", { member: target });
    case "member-restore":
      return msg("systemEntries.stepAsk.memberRestored", { member: target });
    // Neutral: the 30 days running out deletes them too. The name is gone
    // with the member.
    case "member-purge":
      return msg("systemEntries.stepAsk.memberPurged");
    case "office-update":
      return msg("systemEntries.stepAsk.officeUpdated", { release: step.tag });
    case "storage-prune":
      return msg("systemEntries.stepAsk.storagePruned");
    case "storage-compress":
      return msg("systemEntries.stepAsk.storageCompressed");
    // The name the agent gave, never the place's: the agent learns no
    // Discord name it did not give.
    case "discord-route":
      return msg("systemEntries.stepAsk.discordRouted", {
        place: step.placeName,
        agent: target,
      });
    // The name the agent gave, never the picked chat's: the agent learns no
    // chat name it did not give.
    case "whatsapp-route":
      return msg("systemEntries.stepAsk.whatsappRouted", {
        chat: step.chatName,
        agent: target,
      });
    // The id the agent gave, never the route's name: the agent learns no
    // name it did not give.
    case "messaging-route":
      return msg("systemEntries.stepAsk.messagingRouteSet", {
        route: step.routeId,
      });
    case "storage-retention":
      return msg("systemEntries.stepAsk.storageRetentionSet");
    case "instructions-line":
      return msg("systemEntries.stepAsk.instructionsLineAdded");
  }
}

type WhatsAppRouteStep = Extract<AskStep, { kind: "whatsapp-route" }>;

// Whether a row's chat matches the step: by the row's name, by the name the
// bridge saw for its chat, or by the step's number.
function rowMatches(
  row: WhatsAppRoute,
  step: WhatsAppRouteStep,
  seen: readonly WhatsAppChatSeen[],
): boolean {
  return (
    whatsappChatMatches(row, step) ||
    seen.some((c) => c.chat === row.chat && whatsappChatMatches(c, step))
  );
}

// The row settings a whatsapp-route step sets, every one explicit: an omitted
// one is the default (drafts, own messages off, no prefix, mention). A
// trigger only for a group.
function stepRowSettings(
  step: WhatsAppRouteStep,
  group: boolean,
): {
  sendDirect: boolean;
  ownMessages: boolean;
  prefix: string;
  trigger?: "mention" | "all";
} {
  return {
    sendDirect: step.sendDirect === true,
    ownMessages: step.ownMessages === true,
    prefix: step.prefix ?? "",
    ...(group ? { trigger: step.trigger ?? "mention" } : {}),
  };
}

// Whether a row is what the step asks for: its agent and all its settings.
function rowIsStep(row: WhatsAppRoute, step: WhatsAppRouteStep): boolean {
  const want = stepRowSettings(step, row.group);
  return (
    row.agentId === step.agentId &&
    (row.sendDirect === true) === want.sendDirect &&
    (row.ownMessages === true) === want.ownMessages &&
    (row.prefix ?? "") === want.prefix &&
    (!row.group || (row.trigger ?? "mention") === want.trigger)
  );
}

// The name a new row takes: the chat's name as the bridge saw it, cut to the
// row name's length, else the name the agent gave.
function newRowName(
  chat: string,
  seenName: string | undefined,
  chatName: string,
): string {
  // A contact with no saved name is seen as its bare number: the agent's
  // name for it says more.
  if (seenName === undefined || chat === whatsappPhoneChat(seenName))
    return chatName;
  return cutRouteName(seenName) ?? chatName;
}

type DiscordRouteStep = Extract<AskStep, { kind: "discord-route" }>;

// The route settings a discord-route step sets, every one explicit: an
// omitted one is the default (mention, replies wait for Send, no prefix, bot
// posts and react off).
function stepRouteSettings(step: DiscordRouteStep): {
  trigger: DiscordRouteTrigger;
  replyMode: DiscordReplyMode;
  prefix: string;
  includeBots: boolean;
  react: boolean;
} {
  return {
    trigger: step.trigger ?? "mention",
    replyMode: step.replyMode ?? "ask",
    prefix: step.prefix ?? "",
    includeBots: step.includeBots === true,
    react: step.react === true,
  };
}

// Whether a route is what the step asks for: its agent and all its settings.
function routeIsStep(route: DiscordRoute, step: DiscordRouteStep): boolean {
  const want = stepRouteSettings(step);
  return (
    route.agentId === step.agentId &&
    route.trigger === want.trigger &&
    route.replyMode === want.replyMode &&
    (route.prefix ?? "") === want.prefix &&
    (route.includeBots === true) === want.includeBots &&
    (route.react === true) === want.react
  );
}

// Whether a route listens at the place: the same bot, scope and target.
const samePlace = (
  place: { botId: string; scope: string; targetId: string },
  route: { botId: string; scope: string; targetId: string },
) =>
  place.botId === route.botId &&
  place.scope === route.scope &&
  place.targetId === route.targetId;

// The places of the member's bots that match the step, over the servers each
// bot is in now (a bot that has not connected has none).
function discordPlaces(
  dc: StepRunDeps["discord"],
  step: DiscordRouteStep,
  memberUserId: string,
): DiscordPlace[] {
  return discordPlacesMatching(
    step.placeName,
    step.scope,
    dc.bots(memberUserId).map((bot) => ({
      botId: bot.id,
      guilds: dc.guilds(memberUserId, bot.id) ?? [],
    })),
  );
}

// The name a new row or route takes: the place's own name cut to the name's
// length, else the name the agent gave.
function cutRouteName(name: string): string | null {
  const cut = [...name.trim()].slice(0, WHATSAPP_ROUTE_NAME_MAX).join("");
  return normaliseWhatsAppRouteName(cut);
}

// Whether an applied prune or compress covers the step: applied since the ask
// opened, at the step's age line or a newer one, keeping as many per agent or
// fewer.
function covers(
  applied: StorageApplied | null,
  since: number,
  olderThanDays: number,
  keepPerAgent: number,
): boolean {
  return (
    !!applied &&
    applied.at >= since &&
    applied.olderThanDays <= olderThanDays &&
    applied.keepPerAgent <= keepPerAgent
  );
}

// The keys a settings step may set.
const OFFICE_SET_KEYS: readonly string[] = [
  "name",
  "memberUsageShare",
  ...OFFICE_SETTINGS_SWITCHES,
];
const BACKUP_SET_KEYS: readonly string[] = [
  "intervalHours",
  "retention",
  "dir",
];
// The keys a messaging-route step may set: the keys of the app's PATCH.
const ROUTE_SET_KEYS: Record<"discord" | "whatsapp", readonly string[]> = {
  discord: [
    "name",
    "agentId",
    "trigger",
    "replyMode",
    "prefix",
    "includeBots",
    "react",
  ],
  whatsapp: [
    "name",
    "agentId",
    "trigger",
    "sendDirect",
    "prefix",
    "ownMessages",
  ],
};
const RETENTION_SET_KEYS: readonly string[] = [
  "compressAfterDays",
  "deleteAfterDays",
];
const VIEW_LISTS: readonly string[] = ["shown", "tucked", "notif", "push"];

type MessagingRouteStep = Extract<AskStep, { kind: "messaging-route" }>;

// One route of a member, of either app.
type FoundRoute =
  | { app: "discord"; route: DiscordRoute }
  | { app: "whatsapp"; route: WhatsAppRoute };

// The member's route with this id, in the app given, else in either: the
// ids differ by prefix (d_ for Discord, r_ for WhatsApp), so at most one
// matches. Null when the member has none.
function findRoute(
  runs: StepRunDeps,
  memberUserId: string,
  routeId: string,
  app?: "discord" | "whatsapp",
): FoundRoute | null {
  if (app !== "whatsapp") {
    const route = runs.discord
      .routes(memberUserId)
      .find((r) => r.id === routeId);
    if (route) return { app: "discord", route };
  }
  if (app !== "discord") {
    const route = runs.whatsapp
      .rows(memberUserId)
      .find((r) => r.id === routeId);
    if (route) return { app: "whatsapp", route };
  }
  return null;
}

// The route's settings as a step compares them: a key the route does not
// store has its default (off, no prefix, mention on a group).
function routeValues(found: FoundRoute): Record<string, unknown> {
  const common = {
    name: found.route.name,
    agentId: found.route.agentId,
    prefix: found.route.prefix ?? "",
  };
  return found.app === "discord"
    ? {
        ...common,
        trigger: found.route.trigger,
        replyMode: found.route.replyMode,
        includeBots: found.route.includeBots === true,
        react: found.route.react === true,
      }
    : {
        ...common,
        trigger: found.route.group
          ? (found.route.trigger ?? "mention")
          : undefined,
        sendDirect: found.route.sendDirect === true,
        ownMessages: found.route.ownMessages === true,
      };
}

// The preferences as they apply: a record with no voice value has the
// default, and no language is null.
function effectivePreferences(m: MemberSettings): Record<string, unknown> {
  return {
    language: m.language ?? null,
    voiceInput: m.voiceInput ?? "browser",
    voiceOutput: m.voiceOutput ?? "browser",
    voiceName: m.voiceName ?? DEFAULT_VOICE_NAME,
    showToolCalls: m.showToolCalls === true,
    showAgentMessages: m.showAgentMessages === true,
  };
}

// Whether the room is on the member's list now. A hidden room is not shown.
function onList(
  m: MemberSettings,
  list: MemberViewList,
  roomId: string,
): boolean {
  switch (list) {
    case "shown":
      return m.accessible.includes(roomId) && !m.hidden.includes(roomId);
    case "tucked":
      return m.tucked.includes(roomId);
    case "notif":
      return m.notifRooms.includes(roomId);
    case "push":
      return m.pushRooms.includes(roomId);
  }
}

// Each key of `set` has its value in `now`.
const allSet = (set: object, now: Record<string, unknown>): boolean =>
  Object.entries(set).every(([key, value]) => now[key] === value);

export function createStepAsks(deps: StepAskDeps) {
  // Whether the step is done now, for the member the ask is for. `since` is
  // when the ask opened, null at the create: nothing is made since an ask
  // that is not open, and every live session or link is from before it. A
  // kind from a later release is never done here.
  async function isDone(
    step: AskStep,
    memberUserId: string,
    since: number | null,
  ): Promise<boolean> {
    if (!isKnownKind(step.kind)) return false;
    switch (step.kind) {
      // On (as the named user, when the step names one), or off. Not ready,
      // moving and broken are never done.
      case "member-os-user": {
        const now = deps.runs?.memberOsUser(step.userId);
        if (!now) return false;
        if (!step.on) return now.state === "off";
        return (
          now.state === "on" &&
          (step.osUser === undefined || now.osUser?.name === step.osUser)
        );
      }
      // The link's expiry passed the one stored at the create, by the card or
      // by hand. A link used, replaced or taken back is not extended: the ask
      // stays open, and Apply answers the route's refusal.
      case "sign-in-link-extend":
        return !!deps.runs
          ?.memberInvites(step.userId)
          .some(
            (i) =>
              i.prefix === step.tokenPrefix && i.expiresAt > step.expiresAt,
          );
      // Each field the step names has its value.
      case "member-avatar": {
        const member = deps.runs?.member(step.userId);
        return (
          !!member &&
          (step.avatarColor === undefined ||
            member.avatarColor === step.avatarColor) &&
          (step.avatarVariant === undefined ||
            member.avatarVariant === step.avatarVariant)
        );
      }
      case "provider-sign-in":
        return deps.providerConnected(memberUserId, step.provider, step.scope);
      case "mcp-sign-in": {
        const scope = mcpScope(step);
        return !!scope && !!deps.mcpServer(scope, step.name)?.signedIn;
      }
      case "browser-pairing":
        return deps.browserPaired(memberUserId);
      case "github-link":
        return deps.roomLinked(step.roomId);
      case "agent-access": {
        const agent = deps.runs?.agent(step.agentId);
        return !!agent && sameAccessGrant(agent.grant, step);
      }
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return false;
        // An owner reaches every room by rule.
        if (step.grant && member.role === "owner") return true;
        return member.allowedRooms.includes(step.roomId) === step.grant;
      }
      case "member-role":
        return deps.runs?.member(step.userId)?.role === step.role;
      case "member-pack": {
        const member = deps.runs?.memberSettings(step.userId);
        return !!member && samePack(member.pack, step.pack);
      }
      case "member-preferences": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && allSet(step.set, effectivePreferences(member));
      }
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && onList(member, step.list, step.roomId) === step.on;
      }
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        return !!now && allSet(step.set, now);
      }
      case "backup-settings": {
        const now = deps.runs?.backupSettings();
        return !!now && allSet(step.set, now);
      }
      // A link or token made since the ask opened, by the card or by hand.
      case "sign-in-link":
        return (
          since !== null &&
          !!deps.runs
            ?.memberInvites(step.userId)
            .some((i) => i.createdAt >= since)
        );
      case "api-token":
        return (
          since !== null &&
          !!deps.runs
            ?.memberApiTokens(memberUserId)
            .some((t) => t.name === step.name && t.createdAt >= since)
        );
      // None of the sessions or links live when the ask opened is left.
      case "member-sessions": {
        const runs = deps.runs;
        return (
          !!runs &&
          !runs
            .memberSessions(step.userId)
            .some((v) => since === null || v.createdAt < since)
        );
      }
      case "sign-in-links-revoke": {
        const runs = deps.runs;
        return (
          !!runs &&
          !runs
            .memberInvites(step.userId)
            .some((i) => since === null || i.createdAt < since)
        );
      }
      case "api-token-revoke":
        return !!deps.runs && deps.runs.apiToken(step.tokenId) === null;
      // That one session of the member is gone, by the card, by hand or by a
      // sign-out on every device.
      case "session-revoke":
        return (
          !!deps.runs &&
          !deps.runs
            .memberSessions(step.userId)
            .some((v) => v.prefix === step.sessionPrefix)
        );
      case "office-access": {
        const now = deps.runs?.officeAccess();
        return (
          !!now &&
          now.externalAccess === step.externalAccess &&
          (now.publicOrigin ?? "") === step.publicOrigin
        );
      }
      case "member-remove":
        return !!deps.runs && deps.runs.member(step.userId) === null;
      case "member-restore":
        return !!deps.runs?.member(step.userId);
      // Neither removed nor live: a restore since the create is not done.
      case "member-purge":
        return (
          !!deps.runs &&
          deps.runs.removedMember(step.userId) === null &&
          deps.runs.member(step.userId) === null
        );
      // The release asked for or a later one runs.
      case "office-update": {
        const running = deps.runs?.updateStatus().current.release;
        return !!running && compareCalver(running, step.tag) >= 0;
      }
      // At the create: nothing to take. Then: an apply that covers the step
      // (the office's stamp, not a plan, so reconcile walks no disk).
      case "storage-prune": {
        const runs = deps.runs;
        if (!runs) return false;
        const keep = step.keepPerAgent ?? 0;
        return since === null
          ? runs.pruneCandidates(step.target, step.olderThanDays, keep) === 0
          : covers(
              runs.lastPrune(step.target),
              since,
              step.olderThanDays,
              keep,
            );
      }
      case "storage-compress": {
        const runs = deps.runs;
        if (!runs) return false;
        return since === null
          ? runs.compressCandidates(step.olderThanDays) === 0
          : covers(runs.lastCompress(), since, step.olderThanDays, 0);
      }
      // A live route of a matching place to the agent, with the step's
      // settings. Reads only: reconcile runs this from the routes' own
      // change hook.
      case "discord-route": {
        const dc = deps.runs?.discord;
        if (!dc) return false;
        const places = discordPlaces(dc, step, memberUserId);
        return dc
          .routes(memberUserId)
          .some(
            (route) =>
              !route.dead &&
              routeIsStep(route, step) &&
              places.some((p) => samePlace(p, route)) &&
              dc.agentProblem(memberUserId, route.agentId) === null,
          );
      }
      // A live row of a matching chat to the agent, with the step's
      // settings. Reads only: reconcile runs this from the rows' own change
      // hook.
      case "whatsapp-route": {
        const wa = deps.runs?.whatsapp;
        if (!wa) return false;
        const seen = wa.chatsSeen(memberUserId);
        return wa
          .rows(memberUserId)
          .some(
            (row) =>
              !row.dead &&
              rowIsStep(row, step) &&
              rowMatches(row, step, seen) &&
              wa.agentProblem(memberUserId, row.agentId) === null,
          );
      }
      // The route live (its agent fit, and not marked dead: only a PATCH
      // makes a dead route live again), and each key of `set` at its value.
      case "messaging-route": {
        const runs = deps.runs;
        if (!runs) return false;
        const found = findRoute(runs, memberUserId, step.routeId, step.app);
        if (!found || found.route.dead) return false;
        const problem =
          found.app === "discord"
            ? runs.discord.agentProblem(memberUserId, found.route.agentId)
            : runs.whatsapp.agentProblem(memberUserId, found.route.agentId);
        return problem === null && allSet(step.set, routeValues(found));
      }
      case "storage-retention": {
        const now = deps.runs?.logRetention();
        return !!now && allSet(step.set, now);
      }
      case "instructions-line":
        return holdsLine(
          deps.runs?.instructions(step.scope, step.targetId)?.text ?? null,
          step.line,
        );
    }
  }

  const unknownMember = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_member",
    message: "no member with this username",
  });
  const unknownSession = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_session",
    message: "no live session of this member with this prefix",
  });
  // No route of the member with this id: the same answer for another
  // member's.
  const unknownRoute = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_route",
    message: "this member has no route with this id",
  });
  const unknownRoom = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_room",
    message: "no room with this id that you can reach",
  });

  const ownerHasAllRooms = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "owner_has_all_rooms",
    message: "an office owner reaches every room",
  });
  // A token that is gone and one the member may not revoke answer alike.
  const unknownToken = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_token",
    message: "no live API token with this id that this member can revoke",
  });
  const ownerHasNoPack = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "owner_has_no_pack",
    message: "an office owner cannot have a permission pack",
  });

  // Why a member-view step cannot run on the member's lists now, or null.
  // The view core drops notifications and pushes for a hidden or tucked room
  // without an error, so the step is refused before it runs.
  function viewRefusal(
    m: MemberSettings,
    step: Extract<AskStep, { kind: "member-view" }>,
  ): StepFailure | null {
    if (!m.accessible.includes(step.roomId)) return unknownRoom();
    if (!step.on || (step.list !== "notif" && step.list !== "push"))
      return null;
    if (m.hidden.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_hidden",
        message: "the member hides this room: show it first",
      };
    if (m.tucked.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_tucked",
        message: "the member tucked this room away: untuck it first",
      };
    return null;
  }

  // The member's list with the room on or off.
  function viewList(
    m: MemberSettings,
    list: MemberViewList,
    roomId: string,
    on: boolean,
  ): string[] {
    const now =
      list === "shown"
        ? m.accessible.filter((id) => !m.hidden.includes(id))
        : list === "tucked"
          ? m.tucked
          : list === "notif"
            ? m.notifRooms
            : m.pushRooms;
    const rest = now.filter((id) => id !== roomId);
    return on ? [...rest, roomId] : rest;
  }

  // The run of a whatsapp-route step on the picked chat: a chat that matches
  // the step's name or number, seen by the bridge or already a row, or the
  // chat of the step's number. A chat with a row
  // moves to the agent with the step's settings (the row keeps its name); a
  // chat with none gets a row.
  function whatsappRouteRun(
    step: WhatsAppRouteStep,
    memberUserId: string,
    pick: unknown,
  ): StepRun {
    const wa = deps.runs?.whatsapp;
    if (!wa) return invalid("this office runs no action steps");
    const chat =
      isObject(pick) && typeof pick.chat === "string" ? pick.chat : null;
    if (!chat) return invalid("send {chat}: the chat the member picked");
    const seen = wa.chatsSeen(memberUserId);
    const seenChat = seen.find((c) => c.chat === chat);
    const row = wa.rows(memberUserId).find((r) => r.chat === chat);
    // The step's number routes even when no chat for it was seen.
    const matches =
      (!!seenChat && whatsappChatMatches(seenChat, step)) ||
      (!!row && rowMatches(row, step, seen)) ||
      (step.phone !== undefined && chat === whatsappPhoneChat(step.phone));
    if (!matches)
      return {
        ok: false,
        status: 409,
        code: "chat_not_matching",
        message: "this chat does not match the name the ask gives",
      };
    const settings = stepRowSettings(step, chat.endsWith("@g.us"));
    return {
      ok: true,
      routes: [
        row
          ? {
              method: "PATCH",
              path: `/api/whatsapp/routes/${encodeURIComponent(row.id)}`,
              body: { agentId: step.agentId, ...settings },
            }
          : {
              method: "POST",
              path: "/api/whatsapp/routes",
              body: {
                chat,
                name: newRowName(chat, seenChat?.name, step.chatName),
                agentId: step.agentId,
                ...settings,
              },
            },
      ],
    };
  }

  // The run of a discord-route step on the picked place: one of the places
  // of the member's bots that match the step now. A place with a route moves
  // to the agent with the step's settings (the route keeps its name); a
  // place with none gets a route, named by the place.
  function discordRouteRun(
    step: DiscordRouteStep,
    memberUserId: string,
    pick: unknown,
  ): StepRun {
    const dc = deps.runs?.discord;
    if (!dc) return invalid("this office runs no action steps");
    const scopes: readonly unknown[] = ["channel", "category", "server"];
    if (
      !isObject(pick) ||
      typeof pick.botId !== "string" ||
      typeof pick.guildId !== "string" ||
      typeof pick.targetId !== "string" ||
      !scopes.includes(pick.scope)
    )
      return invalid(
        "send {botId, guildId, scope, targetId}: the place the member picked",
      );
    const picked = {
      botId: pick.botId,
      guildId: pick.guildId,
      scope: pick.scope as string,
      targetId: pick.targetId,
    };
    const place = discordPlaces(dc, step, memberUserId).find(
      (p) => samePlace(p, picked) && p.guildId === picked.guildId,
    );
    if (!place)
      return {
        ok: false,
        status: 409,
        code: "place_not_matching",
        message: "this place does not match the name the ask gives",
      };
    const route = dc.routes(memberUserId).find((r) => samePlace(place, r));
    const settings = stepRouteSettings(step);
    return {
      ok: true,
      routes: [
        route
          ? {
              method: "PATCH",
              path: `/api/discord/routes/${encodeURIComponent(route.id)}`,
              body: { agentId: step.agentId, ...settings },
            }
          : {
              method: "POST",
              path: "/api/discord/routes",
              body: {
                botId: place.botId,
                guildId: place.guildId,
                scope: place.scope,
                targetId: place.targetId,
                name: cutRouteName(place.name) ?? step.placeName,
                agentId: step.agentId,
                ...settings,
              },
            },
      ],
    };
  }

  // The route an action step runs now, or null for a step with a link. A
  // member step reads the member when it runs: their name for the path, their
  // rooms for the new room list. A removal on a room closed since the create
  // never gets here in practice: the close takes the room from the member and
  // reconcile closes the ask as done.
  // A step on the member's own record (their preferences, their room lists)
  // runs on the record of `memberUserId`, the member the ask is for.
  // A sign-out ends the session of `callerSessionIdHash` (the member's own)
  // last.
  // A whatsapp-route step runs on the chat the member picked: `pick` is the
  // body of the Apply, {chat}.
  // The one PUT that adds an instructions line, with the version read now:
  // a write between this read and the PUT is the route's own 409.
  function instructionsRoute(step: InstructionsLineStep): StepRun {
    const runs = deps.runs;
    const now = runs?.instructions(step.scope, step.targetId);
    const name =
      step.scope === "member" ? runs?.member(step.targetId)?.name : undefined;
    const path =
      step.scope === "agent"
        ? `/api/agents/${encodeURIComponent(step.targetId)}/instructions`
        : step.scope === "room"
          ? `/api/rooms/${encodeURIComponent(step.targetId)}/instructions`
          : name
            ? `/api/users/${encodeURIComponent(name)}/instructions`
            : null;
    if (!runs || !now || !path)
      return {
        ok: false,
        status: 422,
        code: "unknown_target",
        message: "these instructions are gone",
      };
    return {
      ok: true,
      routes: [
        {
          method: "PUT",
          path,
          body: {
            instructions: withLine(now.text, step.line),
            version: now.version,
          },
        },
      ],
    };
  }

  // The Members page's Run of a member-os-user step, under the member's
  // name now, or null when they are gone. The target comes from the step;
  // the card gives only the password, sent only when it is a string.
  function osUserRoute(
    step: MemberOsUserStep,
    pick: unknown,
  ): StepRoute | null {
    const name = deps.runs?.member(step.userId)?.name;
    if (name === undefined) return null;
    const password =
      isObject(pick) && typeof pick.password === "string"
        ? pick.password
        : undefined;
    return {
      method: "POST",
      path: `/api/users/${encodeURIComponent(name)}/os-user/run`,
      body: {
        action: step.on ? "enable" : "disable",
        ...(step.osUser === undefined ? {} : { osUser: step.osUser }),
        ...(step.existing ? { existing: true } : {}),
        ...(password === undefined ? {} : { password }),
      },
    };
  }

  // Why a member-os-user step cannot run on the member's OS user now, or
  // null: what the root command refuses since the state changed, and a run
  // or a move that goes on (the Run route knows only its own runs).
  function osUserRunRefusal(
    step: MemberOsUserStep,
    checkBusy = true,
  ): StepFailure | null {
    const now = deps.runs?.memberOsUser(step.userId);
    if (!now) return null;
    if (step.osUser !== undefined && now.state !== "off")
      return {
        ok: false,
        status: 409,
        code: "os_user_on",
        message:
          "the member has an OS user: leave out osUser to finish or run the enable again, or turn the OS user off first",
      };
    if (!step.on && now.movedIn)
      return {
        ok: false,
        status: 409,
        code: "moved_in",
        message:
          "the member came with an office move, and turning their OS user off deletes the files it moved: the office owner runs the disable command from GET /api/users/:username/os-user (commands.disable) by hand",
      };
    if (
      checkBusy &&
      (now.attempt?.status === "running" || now.state === "moving")
    )
      return {
        ok: false,
        status: 409,
        code: "run_in_progress",
        message:
          "the member's root command runs, or their files move: try again when it ends",
      };
    return null;
  }

  // The create's checks of a member-os-user step after the done check: the
  // office can run the command, the state lets it run, and the name the step
  // gives is one the box has (existing) or one it does not (new), where the
  // box's names were read in full.
  async function osUserCreateRefusal(
    step: MemberOsUserStep,
  ): Promise<StepFailure | null> {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    const name = runs.member(step.userId)?.name ?? ":username";
    if ((await runs.osUserRunMode()) === null)
      return {
        ok: false,
        status: 409,
        code: "run_unavailable",
        message: `this office cannot run the member's root command itself: give the office owner the command in commands of GET /api/users/${encodeURIComponent(name)}/os-user to run as root`,
      };
    const refused = osUserRunRefusal(step, false);
    if (refused) return refused;
    if (step.osUser === undefined) return null;
    const names = await runs.osUserNames();
    if (step.existing) {
      if (names.existing && !names.existing.includes(step.osUser))
        return {
          ok: false,
          status: 422,
          code: "unknown_os_user",
          message: `no existing OS user of this name that a member can get: candidates of GET /api/users/${encodeURIComponent(name)}/os-user lists them`,
        };
    } else if (names.taken?.includes(step.osUser))
      return {
        ok: false,
        status: 422,
        code: "os_user_taken",
        message:
          "an OS user or group of this name exists: name another new user, or send existing: true for an existing user from candidates",
      };
    return null;
  }

  function routeOf(
    step: AskStep,
    memberUserId: string,
    callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null {
    switch (step.kind) {
      case "member-os-user": {
        const route = osUserRoute(step, pick);
        if (!route) return unknownMember();
        const refused = osUserRunRefusal(step);
        return refused ?? { ok: true, routes: [route] };
      }
      case "agent-access":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/agents/${encodeURIComponent(step.agentId)}/access`,
              // A step an older version stored with a pack sends the stop
              // alone: the stop decides the token limits.
              body: { access: step.access },
            },
          ],
        };
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        // A member made an owner since the create reaches every room: a
        // removal would write a list that changes nothing they reach.
        if (member.role === "owner") return ownerHasAllRooms();
        if (step.grant && !deps.runs!.roomOpen(step.roomId))
          return unknownRoom();
        const rooms = member.allowedRooms.filter((id) => id !== step.roomId);
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/users/${encodeURIComponent(member.name)}/access`,
              body: {
                allowedRooms: step.grant ? [...rooms, step.roomId] : rooms,
              },
            },
          ],
        };
      }
      case "member-role": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/users/${encodeURIComponent(member.name)}`,
              body: { role: step.role },
            },
          ],
        };
      }
      case "member-pack": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        if (member.role === "owner") return ownerHasNoPack();
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/users/${encodeURIComponent(member.name)}/access`,
              // The rooms now, so a room given since the create stays; null
              // clears the pack (an absent one would keep it).
              body: { allowedRooms: [...member.allowedRooms], pack: step.pack },
            },
          ],
        };
      }
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        if (!now) return invalid("this office runs no action steps");
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/office/settings",
              // The version now: an omitted setting keeps its value.
              body: { version: now.version, ...step.set },
            },
          ],
        };
      }
      case "backup-settings":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/backup/settings",
              body: step.set,
            },
          ],
        };
      case "member-preferences":
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: "/api/me/preferences",
              body: step.set,
            },
          ],
        };
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        const rooms = viewList(member, step.list, step.roomId, step.on);
        const [path, field] = {
          shown: ["shown", "shown"],
          tucked: ["tucked", "tucked"],
          notif: ["notif-rooms", "notifRooms"],
          push: ["push-rooms", "pushRooms"],
        }[step.list];
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: `/api/me/view/${path}`,
              body: { [field]: rooms },
            },
          ],
        };
      }
      case "sign-in-link-extend":
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: `/api/invites/${encodeURIComponent(step.tokenPrefix)}/extend`,
            },
          ],
        };
      // Only the fields asked: a field changed by hand since stays.
      case "member-avatar": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/users/${encodeURIComponent(member.name)}`,
              body: {
                ...(step.avatarColor !== undefined
                  ? { avatarColor: step.avatarColor }
                  : {}),
                ...(step.avatarVariant !== undefined
                  ? { avatarVariant: step.avatarVariant }
                  : {}),
              },
            },
          ],
        };
      }
      case "sign-in-link": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            step.userId === memberUserId
              ? { method: "POST", path: "/api/invites/self" }
              : {
                  method: "POST",
                  path: "/api/invites",
                  body: { userId: step.userId },
                },
          ],
        };
      }
      // Every session or link live now, so one made after the ask opened
      // goes too; the member's own session last.
      case "member-sessions": {
        if (!deps.runs?.member(step.userId)) return unknownMember();
        const live = deps.runs.memberSessions(step.userId, callerSessionIdHash);
        const ordered = [
          ...live.filter((v) => !v.current),
          ...live.filter((v) => v.current),
        ];
        return {
          ok: true,
          routes: ordered.map((v) => ({
            method: "DELETE",
            path: `/api/sessions/${encodeURIComponent(v.prefix)}`,
          })),
        };
      }
      case "session-revoke":
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/sessions/${encodeURIComponent(step.sessionPrefix)}`,
            },
          ],
        };
      case "sign-in-links-revoke": {
        if (!deps.runs?.member(step.userId)) return unknownMember();
        return {
          ok: true,
          routes: deps.runs.memberInvites(step.userId).map((i) => ({
            method: "DELETE",
            path: `/api/invites/${encodeURIComponent(i.prefix)}`,
          })),
        };
      }
      case "api-token":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/me/api-tokens",
              body: {
                name: step.name,
                expiresInDays: step.expiresInDays,
                ...(step.limits ? { limits: step.limits } : {}),
              },
            },
          ],
        };
      case "api-token-revoke": {
        const token = deps.runs?.apiToken(step.tokenId);
        if (!token) return unknownToken();
        const id = encodeURIComponent(step.tokenId);
        if (token.userId === memberUserId)
          return {
            ok: true,
            routes: [{ method: "DELETE", path: `/api/me/api-tokens/${id}` }],
          };
        const owner = deps.runs!.member(token.userId);
        if (!owner) return unknownToken();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/users/${encodeURIComponent(owner.name)}/api-tokens/${id}`,
            },
          ],
        };
      }
      case "office-access":
        return {
          ok: true,
          routes: [
            {
              method: "PUT",
              path: "/api/office/access",
              body: {
                externalAccess: step.externalAccess,
                publicOrigin: step.publicOrigin,
              },
            },
          ],
        };
      // The name now: a rename since the create does not lose the member.
      case "member-remove": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          routes: [
            {
              method: "DELETE",
              path: `/api/users/${encodeURIComponent(member.name)}`,
            },
          ],
        };
      }
      // A member restored or deleted since the create is not in Removed
      // members: the run is refused and deletes nothing.
      case "member-restore":
      case "member-purge": {
        if (!deps.runs?.removedMember(step.userId)) return unknownMember();
        const path = `/api/removed-members/${encodeURIComponent(step.userId)}`;
        return {
          ok: true,
          routes: [
            step.kind === "member-restore"
              ? {
                  method: "POST",
                  path: `${path}/restore`,
                  body: { agents: step.agents },
                }
              : { method: "DELETE", path },
          ],
        };
      }
      case "office-update":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/office/update",
              body: { tag: step.tag },
            },
          ],
        };
      case "storage-prune":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/storage/prune",
              body: {
                target: step.target,
                olderThanDays: step.olderThanDays,
                ...(step.keepPerAgent === undefined
                  ? {}
                  : { keepPerAgent: step.keepPerAgent }),
                apply: true,
              },
            },
          ],
        };
      case "storage-compress":
        return {
          ok: true,
          routes: [
            {
              method: "POST",
              path: "/api/storage/compress",
              body: { olderThanDays: step.olderThanDays, apply: true },
            },
          ],
        };
      case "discord-route":
        return discordRouteRun(step, memberUserId, pick);
      case "whatsapp-route":
        return whatsappRouteRun(step, memberUserId, pick);
      // One PATCH of the route: the keys `set` leaves out keep their values.
      // A route deleted since the create answers 404 on the card.
      case "messaging-route":
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/${step.app}/routes/${encodeURIComponent(step.routeId)}`,
              body: step.set,
            },
          ],
        };
      case "storage-retention":
        return {
          ok: true,
          routes: [
            { method: "PUT", path: "/api/storage/retention", body: step.set },
          ],
        };
      // The scope and the line the card showed (InstructionsLineStepRun): an
      // agent's edit since then refuses the Apply, so only the line the
      // member saw is written.
      case "instructions-line": {
        const run = (
          isObject(pick) ? pick : {}
        ) as Partial<InstructionsLineStepRun>;
        if (run.scope !== step.scope || run.line !== step.line)
          return {
            ok: false,
            status: 409,
            code: "step_changed",
            message: "The agent changed this rule. Read it again.",
          };
        return instructionsRoute(step);
      }
      default:
        return null;
    }
  }

  // A messaging-route step as the agent sent it, with the route's app, and
  // `set` checked by the app's own route checks and kept as the PATCH
  // stores it (name and prefix normalised). An id the member has no route
  // for, another member's included, is refused with one answer that names
  // nothing of the route.
  function completeMessagingRoute(
    body: Record<string, unknown>,
    memberUserId: string,
  ): { ok: true; step: AskStep } | StepFailure {
    const { routeId, set } = body;
    if (typeof routeId !== "string" || routeId === "")
      return invalid("step.routeId is the id of one of the member's routes");
    if (!isObject(set) || Object.keys(set).length === 0)
      return invalid("step.set is an object of the settings to change");
    if (!deps.runs) return invalid("this office runs no action steps");
    const found = findRoute(deps.runs, memberUserId, routeId);
    if (!found) return unknownRoute();
    const keys = ROUTE_SET_KEYS[found.app];
    if (!Object.keys(set).every((key) => keys.includes(key)))
      return invalid(`step.set takes only ${keys.join(", ")} for this route`);
    const out: Record<string, unknown> = { ...set };
    if (
      set.agentId !== undefined &&
      (typeof set.agentId !== "string" || set.agentId === "")
    )
      return invalid("step.set.agentId is an agent id");
    if (set.name !== undefined) {
      const name =
        typeof set.name !== "string"
          ? null
          : found.app === "discord"
            ? normaliseDiscordRouteName(set.name)
            : normaliseWhatsAppRouteName(set.name);
      if (name === null)
        return invalid(
          `step.set.name is 1 to ${WHATSAPP_ROUTE_NAME_MAX} characters on one line`,
        );
      out.name = name;
    }
    if (found.app === "whatsapp" && set.trigger !== undefined) {
      if (set.trigger !== "mention" && set.trigger !== "all")
        return invalid("step.set.trigger is mention or all");
      // As the row's PATCH says.
      if (!found.route.group)
        return invalid("step.set.trigger is for a group chat only");
    }
    const settings =
      found.app === "discord" ? discordRouteSettings(set) : replySettings(set);
    if (!settings.ok) return invalid(`step.set: ${settings.error}`);
    if (typeof set.prefix === "string")
      out.prefix =
        (found.app === "discord"
          ? normaliseDiscordPrefix(set.prefix)
          : normaliseWhatsAppPrefix(set.prefix)) ?? "";
    return {
      ok: true,
      step: {
        kind: "messaging-route",
        app: found.app,
        routeId,
        set: out,
      } as MessagingRouteStep,
    };
  }

  // The step as the agent sent it, completed, or why it is refused.
  function complete(input: {
    step: unknown;
    agentId?: string;
    roomId: string;
    managerUserId: string | null;
    memberUserId: string;
  }): { ok: true; step: AskStep } | StepFailure {
    const { step: body, memberUserId, managerUserId } = input;
    if (!isObject(body)) return invalid("step must be an object");
    if (!isKnownKind(body.kind))
      return invalid(
        `step.kind is one of ${Object.keys(STEP_KEYS).join(", ")}`,
      );
    const kind = body.kind;
    const allowed = STEP_KEYS[kind];
    if (!Object.keys(body).every((key) => allowed.includes(key)))
      return invalid(`a ${kind} step takes only ${allowed.join(", ")}`);
    const scope = body.scope ?? "personal";
    // A discord-route step's scope is its place's kind, checked in its case.
    if (
      kind !== "browser-pairing" &&
      kind !== "github-link" &&
      kind !== "discord-route" &&
      kind !== "instructions-line"
    )
      if (scope !== "personal" && scope !== "office")
        return invalid("step.scope is personal or office");
    const owner = deps.isOfficeOwner(memberUserId);
    switch (kind) {
      case "member-os-user": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (typeof body.on !== "boolean")
          return invalid(
            "step.on is true (turn the OS user on) or false (turn it off)",
          );
        const { osUser, existing } = body;
        if (!body.on && (osUser !== undefined || existing !== undefined))
          return invalid("step.osUser and step.existing are for on: true");
        if (
          osUser !== undefined &&
          (typeof osUser !== "string" || !OS_USER_NAME_PATTERN.test(osUser))
        )
          return invalid(
            "step.osUser is an OS user name: lowercase letters, digits, _ and -, at most 32",
          );
        if (existing !== undefined && typeof existing !== "boolean")
          return invalid("step.existing is true or false");
        if (existing !== undefined && osUser === undefined)
          return invalid("step.existing needs step.osUser");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step: {
            kind,
            userId,
            on: body.on,
            ...(typeof osUser === "string" ? { osUser } : {}),
            ...(existing === true ? { existing: true } : {}),
          },
        };
      }
      // The member's one link an owner can extend, stored with its expiry
      // now. Only an office owner applies it: that refusal comes before any
      // answer about the member's links.
      case "sign-in-link-extend": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        if (!owner)
          return notAllowed("only an office owner can extend a sign-in link");
        const link = deps.runs.memberInvites(userId).find((i) => i.extendable);
        if (!link)
          return {
            ok: false,
            status: 409,
            code: "no_extendable_link",
            message:
              "this member has no sign-in link to extend; a sign-in-link step makes a new one",
          };
        return {
          ok: true,
          step: {
            kind,
            userId,
            tokenPrefix: link.prefix,
            expiresAt: link.expiresAt,
          },
        };
      }
      // A colour as the record stores it, a shape it takes, or both.
      case "member-avatar": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        const { avatarColor, avatarVariant } = body;
        if (avatarColor === undefined && avatarVariant === undefined)
          return invalid(
            "a member-avatar step sets avatarColor, avatarVariant or both",
          );
        if (avatarColor !== undefined && !isHexColor(avatarColor))
          return invalid("step.avatarColor is a colour as #rrggbb");
        if (avatarVariant !== undefined && !isGhostVariant(avatarVariant))
          return invalid(
            `step.avatarVariant is one of ${GHOST_VARIANTS.join(", ")}`,
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step: {
            kind,
            userId,
            ...(avatarColor !== undefined
              ? { avatarColor: normalizeHexColor(avatarColor) }
              : {}),
            ...(avatarVariant !== undefined ? { avatarVariant } : {}),
          },
        };
      }
      case "provider-sign-in": {
        const provider = body.provider;
        if (provider !== "claude" && provider !== "codex")
          return invalid("step.provider is claude or codex");
        if (scope === "personal") {
          // The agent runs on its manager's own sign-in.
          if (memberUserId !== managerUserId)
            return invalid(
              "a personal sign-in is the manager's own: ask your manager",
            );
        } else if (!owner)
          return notAllowed("only an office owner can sign in the office");
        return {
          ok: true,
          step: { kind, provider, scope: scope as "personal" | "office" },
        };
      }
      case "mcp-sign-in": {
        if (typeof body.name !== "string" || body.name === "")
          return invalid("step.name is an MCP server name");
        if (scope === "office") {
          if (!owner)
            return notAllowed(
              "only an office owner can sign in to an office MCP server",
            );
          return {
            ok: true,
            step: { kind, name: body.name, scope: "office" },
          };
        }
        if (!managerUserId)
          return {
            ok: false,
            status: 409,
            code: "no_manager",
            message:
              "this agent has no manager, so it has no personal MCP servers",
          };
        if (memberUserId !== managerUserId && !owner)
          return notAllowed(
            "only the manager or an office owner can sign in to the manager's MCP server",
          );
        return {
          ok: true,
          step: {
            kind,
            name: body.name,
            scope: "personal",
            ownerUserId: managerUserId,
          },
        };
      }
      case "browser-pairing":
        // The agent uses its manager's paired Chrome.
        if (memberUserId !== managerUserId)
          return invalid("the browser is the manager's: ask your manager");
        return { ok: true, step: { kind } };
      case "github-link":
        if (!owner)
          return notAllowed("only an office owner can link a room to GitHub");
        return { ok: true, step: { kind, roomId: input.roomId } };
      case "agent-access": {
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        // A pack is refused, not dropped: the stop alone sets the token
        // limits, so a narrow pack would give a wider grant.
        if ("pack" in body) return invalid(packNotAccepted("step.pack"));
        const grant = parseAgentAccessGrant({ access: body.access });
        if (!grant)
          return invalid(
            "step.access is a stop (chat, office, folder, web, standard, privileged)",
          );
        return {
          ok: true,
          step: { kind, agentId: body.agentId, access: grant.access },
        };
      }
      case "member-pack": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        // The stored pack is the parsed one, so the done predicate compares
        // like with like.
        const pack = body.pack === null ? null : parseMemberPack(body.pack);
        if (!("pack" in body) || (pack === null && body.pack !== null))
          return invalid(
            "step.pack is {areas, agentCeiling}: known areas at read or write, and a ceiling of chat, office, folder or web; or null for no pack",
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return { ok: true, step: { kind, userId, pack } };
      }
      case "member-preferences":
      case "member-view": {
        // The member's own record: their agent acts for them already, and
        // another member's preferences and lists are private.
        if (!managerUserId || memberUserId !== managerUserId)
          return invalid(
            "a member's preferences and room lists are their own: ask your manager",
          );
        if (kind === "member-preferences") {
          if (!isObject(body.set))
            return invalid("step.set is an object of preferences");
          const parsed = parsePreferenceChange(body.set, ASK_PREFERENCE_KEYS);
          if (!parsed.ok) return invalid(`step.set: ${parsed.message}`);
          // ASK_PREFERENCE_KEYS refuses the word list and the dismiss list,
          // so this drops nothing.
          const {
            recordingWords: _refused,
            inboxDismissed: _refusedToo,
            ...set
          } = parsed.change;
          return { ok: true, step: { kind, set } };
        }
        if (typeof body.list !== "string" || !VIEW_LISTS.includes(body.list))
          return invalid(`step.list is one of ${VIEW_LISTS.join(", ")}`);
        if (typeof body.roomId !== "string" || body.roomId === "")
          return invalid("step.roomId is one room id");
        if (typeof body.on !== "boolean")
          return invalid("step.on is true (on the list) or false (off it)");
        return {
          ok: true,
          step: {
            kind,
            list: body.list as MemberViewList,
            roomId: body.roomId,
            on: body.on,
          },
        };
      }
      case "office-settings":
      case "backup-settings": {
        const keys =
          kind === "office-settings" ? OFFICE_SET_KEYS : BACKUP_SET_KEYS;
        const set = body.set;
        if (!isObject(set) || Object.keys(set).length === 0)
          return invalid(
            `step.set is an object of one or more of ${keys.join(", ")}`,
          );
        const unknown = Object.keys(set).filter((key) => !keys.includes(key));
        if (unknown.length > 0)
          return invalid(`step.set takes only ${keys.join(", ")}`);
        if (kind === "backup-settings") {
          const bad = backupSettingsShapeError(set);
          if (bad) return invalid(`step.set: ${bad}`);
          return { ok: true, step: { kind, set } };
        }
        if ("name" in set && set.name !== null && typeof set.name !== "string")
          return invalid("step.set: name is a string, or null for none");
        const bad = officeSettingsFieldError(set);
        if (bad) return invalid(`step.set: ${bad}`);
        if (!deps.runs) return invalid("this office runs no action steps");
        // The name as the save stores it: trimmed, and none when empty.
        if (typeof set.name === "string") {
          const name = set.name.trim();
          if (name.length > OFFICE_NAME_MAX)
            return invalid(
              `step.set: the office name is ${OFFICE_NAME_MAX} characters or fewer`,
            );
          return {
            ok: true,
            step: { kind, set: { ...set, name: name || null } },
          };
        }
        return { ok: true, step: { kind, set } };
      }
      case "sign-in-link":
      case "member-sessions":
      case "sign-in-links-revoke": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return { ok: true, step: { kind, userId } };
      }
      // The token as POST /api/me/api-tokens takes it, for the member the ask
      // is for: through the route's own parser.
      case "api-token": {
        if (!deps.runs) return invalid("this office runs no action steps");
        const runs = deps.runs;
        const parsed = parseApiTokenCreate(body, () =>
          runs.tokenLimitableRoomIds(memberUserId),
        );
        if (!parsed.ok) return invalid(`step: ${parsed.message}`);
        return { ok: true, step: { kind, ...parsed.req } };
      }
      // A live session of that member: a prefix of another member's session,
      // or of one that is gone, answers as one that never was.
      case "session-revoke": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (typeof body.sessionPrefix !== "string" || body.sessionPrefix === "")
          return invalid("step.sessionPrefix is a session's prefix");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        const prefix = body.sessionPrefix;
        if (!deps.runs.memberSessions(userId).some((v) => v.prefix === prefix))
          return unknownSession();
        return { ok: true, step: { kind, userId, sessionPrefix: prefix } };
      }
      // The token's owner is stored with it. A token that is gone answers as
      // one the member may not revoke (actionRefusal).
      case "api-token-revoke": {
        if (typeof body.tokenId !== "string" || body.tokenId === "")
          return invalid("step.tokenId is an API token id");
        if (!deps.runs) return invalid("this office runs no action steps");
        const token = deps.runs.apiToken(body.tokenId);
        if (!token) return unknownToken();
        return {
          ok: true,
          step: { kind, tokenId: body.tokenId, userId: token.userId },
        };
      }
      // The address as the save stores it: trimmed and normalised, "" for
      // none.
      case "office-access": {
        if (typeof body.externalAccess !== "boolean")
          return invalid("step.externalAccess is true or false");
        if (typeof body.publicOrigin !== "string")
          return invalid('step.publicOrigin is an address, or "" for none');
        const raw = body.publicOrigin.trim();
        const origin = raw ? normalizePublicOrigin(raw) : null;
        if (raw && !origin)
          return invalid(
            "step.publicOrigin is https://<host> or http://localhost (no path, query, or fragment)",
          );
        if (body.externalAccess && !origin)
          return invalid("outside access needs step.publicOrigin");
        return {
          ok: true,
          step: {
            kind,
            externalAccess: body.externalAccess,
            publicOrigin: origin ?? "",
          },
        };
      }
      case "member-remove":
      case "member-restore":
      case "member-purge": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (
          kind === "member-restore" &&
          body.agents !== undefined &&
          typeof body.agents !== "boolean"
        )
          return invalid(
            "step.agents is true (their agents, schedules and webhooks come back) or false",
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        // A removal is of a live member; a restore or a delete for good, of
        // a removed one.
        const userId =
          kind === "member-remove"
            ? deps.runs.memberIdByName(body.username)
            : deps.runs.removedMemberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step:
            kind === "member-restore"
              ? { kind, userId, agents: (body.agents as boolean) ?? true }
              : { kind, userId },
        };
      }
      // The latest release the checker knows, on a box whose updater the
      // page runs (release mode, applied by the host).
      case "office-update": {
        if (!deps.runs) return invalid("this office runs no action steps");
        const status = deps.runs.updateStatus();
        if (status.mode !== "release" || status.apply.kind !== "host")
          return {
            ok: false,
            status: 409,
            code: "not_managed",
            message:
              "this office has no updater to run: it updates as its host deploys it",
          };
        if (!status.latest)
          return {
            ok: false,
            status: 409,
            code: "no_release",
            message: "the update checker knows no release yet",
          };
        return { ok: true, step: { kind, tag: status.latest.tag } };
      }
      // As the route parses an apply.
      case "storage-prune": {
        const { kind: _, ...rest } = body;
        const parsed = parsePruneRequest(rest, true);
        if (!parsed.ok) return invalid(`step: ${parsed.message}`);
        const { target, olderThanDays, keepPerAgent } = parsed.req;
        return {
          ok: true,
          step: {
            kind,
            target,
            olderThanDays,
            ...(keepPerAgent === undefined ? {} : { keepPerAgent }),
          },
        };
      }
      // The settings as the route stores them: false and a blank prefix
      // are the default, so they are left out.
      case "discord-route": {
        const placeName =
          typeof body.placeName === "string"
            ? normaliseDiscordRouteName(body.placeName)
            : null;
        if (placeName === null)
          return invalid(
            "step.placeName is a part of the place's name: 1 to 60 characters on one line",
          );
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        const scope = body.scope;
        if (
          scope !== undefined &&
          scope !== "channel" &&
          scope !== "category" &&
          scope !== "server"
        )
          return invalid("step.scope is channel, category or server");
        const trigger = body.trigger;
        if (trigger !== undefined && trigger !== "mention" && trigger !== "all")
          return invalid("step.trigger is mention or all");
        const replyMode = body.replyMode;
        if (
          replyMode !== undefined &&
          replyMode !== "bot" &&
          replyMode !== "read" &&
          replyMode !== "ask"
        )
          return invalid("step.replyMode is bot, read or ask");
        const flags: { includeBots?: true; react?: true } = {};
        for (const key of ["includeBots", "react"] as const) {
          const v = body[key];
          if (v === undefined) continue;
          if (typeof v !== "boolean")
            return invalid(`step.${key} is true or false`);
          if (v) flags[key] = true;
        }
        let prefix: string | undefined;
        if (body.prefix !== undefined) {
          const p =
            typeof body.prefix === "string"
              ? normaliseDiscordPrefix(body.prefix)
              : null;
          if (p === null)
            return invalid(
              `step.prefix is at most ${WHATSAPP_PREFIX_MAX} characters on one line`,
            );
          if (p) prefix = p;
        }
        return {
          ok: true,
          step: {
            kind,
            placeName,
            agentId: body.agentId,
            ...(scope === undefined ? {} : { scope }),
            ...(trigger === undefined ? {} : { trigger }),
            ...(replyMode === undefined ? {} : { replyMode }),
            ...(prefix === undefined ? {} : { prefix }),
            ...flags,
          },
        };
      }
      // The settings as the row stores them: false and a blank prefix are
      // the default, so they are left out.
      case "whatsapp-route": {
        const chatName =
          typeof body.chatName === "string"
            ? normaliseWhatsAppRouteName(body.chatName)
            : null;
        if (chatName === null)
          return invalid(
            "step.chatName is a part of the chat's name: 1 to 60 characters on one line",
          );
        const phone =
          body.phone === undefined
            ? undefined
            : typeof body.phone === "string"
              ? normaliseWhatsAppPhone(body.phone)
              : null;
        if (phone === null)
          return invalid(
            "step.phone is the contact's full number with the country code",
          );
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        const trigger = body.trigger;
        if (trigger !== undefined && trigger !== "mention" && trigger !== "all")
          return invalid("step.trigger is mention or all");
        const settings = replySettings(body);
        if (!settings.ok) return invalid(`step.${settings.error}`);
        return {
          ok: true,
          step: {
            kind,
            chatName,
            ...(phone === undefined ? {} : { phone }),
            agentId: body.agentId,
            ...(trigger === undefined ? {} : { trigger }),
            ...settings.set,
          },
        };
      }
      case "storage-compress": {
        const days = body.olderThanDays;
        if (
          typeof days !== "number" ||
          !Number.isInteger(days) ||
          days < MIN_OLDER_THAN_DAYS
        )
          return invalid(
            `step.olderThanDays is an integer of at least ${MIN_OLDER_THAN_DAYS}`,
          );
        return { ok: true, step: { kind, olderThanDays: days } };
      }
      case "messaging-route":
        return completeMessagingRoute(body, memberUserId);
      case "storage-retention": {
        const set = body.set;
        if (!isObject(set) || Object.keys(set).length === 0)
          return invalid(
            `step.set is an object of one or more of ${RETENTION_SET_KEYS.join(", ")}`,
          );
        if (!Object.keys(set).every((key) => RETENTION_SET_KEYS.includes(key)))
          return invalid(
            `step.set takes only ${RETENTION_SET_KEYS.join(", ")}`,
          );
        const bad = logRetentionSettingsShapeError(set);
        if (bad) return invalid(`step.set: ${bad}`);
        return { ok: true, step: { kind, set } };
      }
      // The target is the asking agent's own: itself, its room or its
      // manager, fixed here (task 33891b5b).
      case "instructions-line": {
        const scope = body.scope as InstructionsScope;
        if (!INSTRUCTIONS_SCOPES.includes(scope))
          return invalid(
            `step.scope is one of ${INSTRUCTIONS_SCOPES.join(", ")}`,
          );
        const bad = lineRefusal(body.line);
        if (bad) return invalid(bad);
        const targetId =
          scope === "agent"
            ? input.agentId
            : scope === "room"
              ? input.roomId
              : managerUserId;
        if (!targetId)
          return invalid(
            scope === "member"
              ? "this agent has no manager"
              : "a step the member runs needs the asking agent",
          );
        return {
          ok: true,
          step: { kind, scope, line: body.line as string, targetId },
        };
      }
      case "member-room":
      case "member-role": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (kind === "member-room") {
          if (typeof body.roomId !== "string" || body.roomId === "")
            return invalid("step.roomId is one room id");
          if (typeof body.grant !== "boolean")
            return invalid(
              "step.grant is true (give the room) or false (take it)",
            );
        } else if (body.role !== "owner" && body.role !== "member")
          return invalid("step.role is owner or member");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step:
            kind === "member-room"
              ? {
                  kind,
                  userId,
                  roomId: body.roomId as string,
                  grant: body.grant as boolean,
                }
              : { kind, userId, role: body.role as "owner" | "member" },
        };
      }
    }
  }

  // Closes one ask whose step is done: the first close settles it, and an
  // ask that went meanwhile (an answer, the agent's delete, another
  // reconcile) is not settled again.
  function close(entry: StepEntry): void {
    let removed: AskEntry | null;
    try {
      removed = deps.asks.remove(entry.id, { outcome: "done" });
    } catch {
      console.error(`[step-asks] ask ${entry.id} could not be closed`);
      return;
    }
    if (!removed || !removed.memberUserId) return;
    deps.settled(
      entry.agentId,
      entry.id,
      doneLine(entry.step, targetName(entry.step)),
      removed.memberUserId,
    );
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: AskStep): string {
    switch (step.kind) {
      case "agent-access":
      case "whatsapp-route":
      case "discord-route":
        return deps.runs?.agent(step.agentId)?.name ?? step.agentId;
      case "member-room":
      case "member-role":
      case "member-pack":
      case "sign-in-link":
      case "member-sessions":
      case "session-revoke":
      case "sign-in-links-revoke":
      case "member-os-user":
      case "sign-in-link-extend":
      case "member-avatar":
        return deps.runs?.member(step.userId)?.name ?? step.userId;
      case "member-view":
        return deps.runs?.roomName(step.roomId) ?? step.roomId;
      // Removed now, or back.
      case "member-remove":
      case "member-restore":
        return (
          deps.runs?.member(step.userId)?.name ??
          deps.runs?.removedMember(step.userId)?.name ??
          step.userId
        );
      default:
        return "";
    }
  }

  // Why the member could not run an action step, or null. A target the
  // asking agent cannot reach answers as a missing one, before any other
  // check, so the answer tells the agent nothing about it. A member is not
  // hidden: every agent reads the member list.
  function actionRefusal(
    step: ActionStepRequest,
    askingAgentId: string | undefined,
    memberUserId: string,
  ): StepFailure | null {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    switch (step.kind) {
      // The rest is osUserCreateRefusal's, after the done check.
      case "member-os-user": {
        const route = osUserRoute(step, undefined);
        if (!route) return unknownMember();
        return runs.authorizeAs(memberUserId, route)
          ? notAllowed(
              "only an office owner can turn a member's OS user on or off",
            )
          : null;
      }
      case "sign-in-link-extend":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can extend a sign-in link")
          : null;
      // An owner for anyone, a member for themself.
      case "member-avatar":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              "only an office owner can change another member's avatar",
            )
          : null;
      case "agent-access": {
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return {
            ok: false,
            status: 422,
            code: "unknown_agent",
            message: "no agent with this id in a room you can reach",
          };
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("this member cannot change that agent's access");
        const refusal = runs.accessRefusal(step.agentId, step);
        return refusal
          ? {
              ok: false,
              status: 422,
              code: refusal.code,
              message: refusal.message,
            }
          : null;
      }
      case "member-room": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        if (step.roomId === LOBBY_ROOM_ID)
          return {
            ok: false,
            status: 422,
            code: "lobby_open_to_all",
            message: "every member reaches the lobby",
          };
        if (runs.member(step.userId)?.role === "owner")
          return ownerHasAllRooms();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's room access")
          : null;
      }
      case "member-role": {
        // The page lets a member edit their own record, and its handler
        // refuses the role: only an owner changes one.
        if (
          !deps.isOfficeOwner(memberUserId) ||
          runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
        )
          return notAllowed("only an office owner can change a member's role");
        return step.role === "member" && runs.lastOwner(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "last_owner",
              message: "the office must have at least one office owner",
            }
          : null;
      }
      case "member-pack": {
        if (runs.member(step.userId)?.role === "owner") return ownerHasNoPack();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's permission pack")
          : null;
      }
      case "member-preferences":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their preferences")
          : null;
      case "member-view": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        const member = runs.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their room lists")
          : null;
      }
      case "office-settings":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can change the office settings")
          : null;
      case "backup-settings": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed(
            "only an office owner can change the backup settings",
          );
        const dir = step.set.dir;
        return dir !== undefined &&
          dir !== runs.backupSettings().dir &&
          runs.backupDirFromEnv()
          ? {
              ok: false,
              status: 409,
              code: "backup_dir_from_env",
              message: "ISOMUX_BACKUP_DIR sets the backup folder",
            }
          : null;
      }
      case "sign-in-link":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can make another member's link")
          : null;
      // An owner for anyone, a member for themself: the routes' own
      // preconditions, which authorization alone does not run.
      case "member-sessions":
      case "sign-in-links-revoke": {
        const path =
          step.kind === "member-sessions"
            ? "/api/sessions/-"
            : "/api/invites/-";
        if (
          (step.userId !== memberUserId && !deps.isOfficeOwner(memberUserId)) ||
          runs.authorizeAs(memberUserId, { method: "DELETE", path })
        )
          return notAllowed(
            step.kind === "member-sessions"
              ? "only an office owner can sign out another member"
              : "only an office owner can take back another member's links",
          );
        return step.kind === "member-sessions" &&
          runs.signOutStrandsOffice(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message:
                "these are the office's last owner sessions: another office owner must be signed in",
            }
          : null;
      }
      case "api-token":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot make an API token")
          : null;
      // As a sign-out: an owner for anyone, a member for themself, and never
      // the office's last owner session.
      case "session-revoke":
        if (
          (step.userId !== memberUserId && !deps.isOfficeOwner(memberUserId)) ||
          runs.authorizeAs(memberUserId, {
            method: "DELETE",
            path: "/api/sessions/-",
          })
        )
          return notAllowed("only an office owner can sign out another member");
        return runs.sessionRevokeStrandsOffice(step.userId, step.sessionPrefix)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message: "this is the office's last owner session",
            }
          : null;
      // A token the member may not revoke answers as a missing one.
      case "api-token-revoke": {
        const token = runs.apiToken(step.tokenId);
        if (
          !token ||
          (token.userId !== memberUserId && !deps.isOfficeOwner(memberUserId))
        )
          return unknownToken();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? unknownToken()
          : null;
      }
      // Hosted Isomux keeps the address, as the save does.
      case "office-access": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("only an office owner can change outside access");
        const rule = hostedAccessRule(
          runs.officeAccess(),
          step.externalAccess,
          step.publicOrigin || null,
        );
        return rule === "managed"
          ? {
              ok: false,
              status: 403,
              code: "hosted_access_managed",
              message:
                "Hosted Isomux manages this office's address; it cannot be changed.",
            }
          : null;
      }
      // The route lets a member remove themself and an owner anyone but
      // themself; the office keeps an owner record and an owner session.
      case "member-remove": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("only an office owner can remove another member");
        if (step.userId === memberUserId && deps.isOfficeOwner(memberUserId))
          return {
            ok: false,
            status: 403,
            code: "owner_self_delete",
            message:
              "An owner can't delete their own user record. Sign out from this session or transfer ownership first.",
          };
        return runs.lastOwner(step.userId) ||
          runs.signOutStrandsOffice(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "would_strand_office",
              message: "the office must keep an office owner who is signed in",
            }
          : null;
      }
      case "member-restore":
      case "member-purge":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              step.kind === "member-restore"
                ? "only an office owner can restore a member"
                : "only an office owner can delete a removed member",
            )
          : null;
      case "office-update":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can update the office")
          : null;
      case "storage-prune":
      case "storage-compress":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can clean up storage")
          : null;
      // The place is picked on the card, so the create judges the member
      // on the add route, and the agent by the routes' own rule.
      case "discord-route": {
        const unknownAgent: StepFailure = {
          ok: false,
          status: 422,
          code: "unknown_agent",
          message: "no agent with this id in a room you can reach",
        };
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return unknownAgent;
        if (
          runs.authorizeAs(memberUserId, {
            method: "POST",
            path: "/api/discord/routes",
          })
        )
          return notAllowed("this member cannot route Discord places");
        if (runs.discord.bots(memberUserId).length === 0)
          return {
            ok: false,
            status: 409,
            code: "discord_not_connected",
            message:
              "this member has not connected a Discord bot: they connect one in Integrations, Messaging",
          };
        switch (runs.discord.agentProblem(memberUserId, step.agentId)) {
          case "agent_gone":
            return unknownAgent;
          case "agent_not_yours":
            return notAllowed(
              "this member can route a place only to an agent they manage; an office owner can route to any agent",
            );
          case "agent_chat_only":
            return {
              ok: false,
              status: 422,
              code: "agent_chat_only",
              message: "an agent at Chat stop cannot reply",
            };
          default:
            return null;
        }
      }
      // The chat is picked on the card, so the create judges the member on
      // the add route, and the agent by the rows' own rule.
      case "whatsapp-route": {
        const unknownAgent: StepFailure = {
          ok: false,
          status: 422,
          code: "unknown_agent",
          message: "no agent with this id in a room you can reach",
        };
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return unknownAgent;
        if (
          runs.authorizeAs(memberUserId, {
            method: "POST",
            path: "/api/whatsapp/routes",
          })
        )
          return notAllowed("this member cannot route WhatsApp chats");
        if (!runs.whatsapp.linked(memberUserId))
          return {
            ok: false,
            status: 409,
            code: "whatsapp_not_linked",
            message:
              "this member has not linked WhatsApp: they link it in Integrations, Messaging",
          };
        switch (runs.whatsapp.agentProblem(memberUserId, step.agentId)) {
          case "agent_gone":
            return unknownAgent;
          case "agent_not_yours":
            return notAllowed(
              "this member can route a chat only to an agent they manage; an office owner can route to any agent",
            );
          case "agent_chat_only":
            return {
              ok: false,
              status: 422,
              code: "agent_chat_only",
              message: "an agent at Chat stop cannot reply",
            };
          default:
            return null;
        }
      }
      case "messaging-route":
        return messagingRouteRefusal(step, askingAgentId, memberUserId);
      case "storage-retention":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed(
              "only an office owner can change the automatic cleanup settings",
            )
          : null;
      case "instructions-line": {
        const route = instructionsRoute(step);
        if (!route.ok) return route;
        return runs.authorizeAs(memberUserId, route.routes[0])
          ? notAllowed("this member cannot change these instructions")
          : null;
      }
    }
  }

  // Why the member could not apply a messaging-route step, or null: the
  // route's PATCH as the member, then the agent the route has after the
  // change (set.agentId, else the route's own) by the routes' own rule, so
  // Apply does not fail on it.
  function messagingRouteRefusal(
    step: MessagingRouteStep,
    askingAgentId: string | undefined,
    memberUserId: string,
  ): StepFailure | null {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    const unknownAgent: StepFailure = {
      ok: false,
      status: 422,
      code: "unknown_agent",
      message: "no agent with this id in a room you can reach",
    };
    const found = findRoute(runs, memberUserId, step.routeId, step.app);
    if (!found) return unknownRoute();
    if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
      return notAllowed("this member cannot change this route");
    const agentId = step.set.agentId ?? found.route.agentId;
    if (
      step.set.agentId !== undefined &&
      (!askingAgentId ||
        !runs.agent(agentId) ||
        !runs.agentReaches(askingAgentId, agentId))
    )
      return unknownAgent;
    const problem =
      found.app === "discord"
        ? runs.discord.agentProblem(memberUserId, agentId)
        : runs.whatsapp.agentProblem(memberUserId, agentId);
    switch (problem) {
      case "agent_gone":
        return unknownAgent;
      case "agent_not_yours":
        return notAllowed(
          "this member can route only to an agent they manage; an office owner can route to any agent",
        );
      case "agent_chat_only":
        return {
          ok: false,
          status: 422,
          code: "agent_chat_only",
          message: "an agent at Chat stop cannot reply",
        };
      default:
        return null;
    }
  }

  // When each link, session or token a step's predicate reads by the ask's
  // age was made; none for the other kinds.
  function stateTimes(step: AskStep, memberUserId: string): number[] {
    const runs = deps.runs;
    if (!runs) return [];
    switch (step.kind) {
      case "sign-in-link":
      case "sign-in-links-revoke":
        return runs.memberInvites(step.userId).map((i) => i.createdAt);
      case "member-sessions":
        return runs.memberSessions(step.userId).map((v) => v.createdAt);
      case "api-token":
        return runs.memberApiTokens(memberUserId).map((t) => t.createdAt);
      // An apply from before the ask does not share its millisecond.
      case "storage-prune":
        return [runs.lastPrune(step.target)?.at ?? 0];
      case "storage-compress":
        return [runs.lastCompress()?.at ?? 0];
      default:
        return [];
    }
  }

  // The first route of an action step whose target the create found: the
  // one the member's authorization is judged on.
  function runRoute(step: ActionStepRequest, memberUserId: string): StepRoute {
    const run = routeOf(step, memberUserId);
    if (!run?.ok || run.routes.length === 0)
      throw new Error(`step ${step.kind}: no route`);
    return run.routes[0];
  }

  return {
    // The `step` of an ask create, checked and completed. `memberUserId` is
    // the member the ask is for (the one named, else the manager);
    // `memberNamed` whether the agent named one. Naming the manager is the
    // same as naming no one, so only memberUserId is read.
    async check(input: {
      step: unknown;
      // The asking agent; a step the member runs needs it.
      agentId?: string;
      roomId: string;
      managerUserId: string | null;
      memberUserId: string;
      memberNamed: boolean;
    }): Promise<StepCheck> {
      const completed = complete(input);
      if (!completed.ok) return completed;
      const { step } = completed;
      if (step.kind === "mcp-sign-in") {
        const scope = mcpScope(step);
        const server = scope ? deps.mcpServer(scope, step.name) : null;
        if (!server)
          return {
            ok: false,
            status: 422,
            code: "unknown_mcp_server",
            message: "no MCP server of this name in that scope",
          };
        if (!server.oauth)
          return {
            ok: false,
            status: 409,
            code: "not_oauth",
            message: "this MCP server does not sign in with OAuth",
          };
      }
      if (isActionStep(step)) {
        const refused = actionRefusal(step, input.agentId, input.memberUserId);
        if (refused) return refused;
      }
      if (await isDone(step, input.memberUserId, null))
        return {
          ok: false,
          status: 409,
          code: "step_done",
          message: "this step is done",
        };
      if (step.kind === "member-os-user") {
        const refused = await osUserCreateRefusal(step);
        if (refused) return refused;
      }
      // The ask's age splits the links, sessions and tokens into those from
      // before it and those made since, by the millisecond: so none from
      // before shares the ask's, the create waits past the newest. A stamp
      // more than a few ms ahead comes from a clock set back: no wait.
      const newest = Math.max(0, ...stateTimes(step, input.memberUserId));
      if (newest - Date.now() < MAX_CLOCK_WAIT_MS)
        while (Date.now() <= newest)
          await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, step, link: stepLink(step) };
    },

    // The route the member runs for a step now, or why it cannot run; null
    // for a step with a link.
    routeOf,

    // Whether the step of an open ask is done now.
    isStepDone(entry: StepEntry): Promise<boolean> {
      return entry.memberUserId
        ? isDone(entry.step, entry.memberUserId, entry.createdAt)
        : Promise.resolve(false);
    },

    // Closes every open step ask whose step is done. Never throws: a
    // predicate that fails leaves its ask open.
    async reconcile(): Promise<void> {
      let open: StepEntry[];
      try {
        open = deps.asks
          .listAll()
          .filter((e): e is StepEntry => e.step !== undefined);
      } catch {
        return;
      }
      await Promise.all(
        open.map(async (entry) => {
          try {
            if (!entry.memberUserId) return;
            if (await isDone(entry.step, entry.memberUserId, entry.createdAt))
              close(entry);
          } catch {
            console.error(
              `[step-asks] ask ${entry.id}: the step could not be read`,
            );
          }
        }),
      );
    },
  };
}

export type StepAsks = ReturnType<typeof createStepAsks>;
