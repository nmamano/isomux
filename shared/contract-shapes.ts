// Named request and wire-projection shapes.
//
// The contract-first aliases referenced by the typed route table
// (server/routes/table.ts) and the event registry (server/events/registry.ts).
// See internal-docs/generic-runtime-refactor.md → "Named request and wire
// shapes". LEAF over shared/types.ts: type aliases only, zero runtime, no
// validation (schemas are type-level; runtime validation lands with
// handler migration). Indexed-access types keep every alias in
// lockstep with the canonical shapes - a field rename in shared/types.ts
// propagates here at compile time.

import type { RoomPet } from "./pets.ts";
import type { RoomSkin } from "./room-skins.ts";
import type { RoomDecor, RoomDecorPatch } from "./room-decor.ts";
import type { SecretForm } from "./secret-hosts.ts";
import type { VoiceInput, VoiceName, VoiceOutput } from "./voice.ts";
import type {
  UserRecord,
  AgentInfo,
  AgentBackendType,
  TaskItem,
  Cronjob,
  Attachment,
  LogEntry,
  MemoryScope,
  MemoryItem,
  OfficeSettings,
  PendingPromptKind,
  MembersChatMessage,
  WebhookDelivery,
  WebhookRule,
  WebhookScheme,
  WebhookTarget,
  PagerDeliveryFailure,
  AskMemberWire,
} from "./types.ts";
import type { SupportedLanguageCode } from "./languages.ts";

// UserPublicWire's canonical home is shared/types.ts (next to UserRecord +
// ServerMessage, which references it). Re-exported here so the route-table /
// event-registry import sites keep importing every wire shape from one module.
export type { UserPublicWire } from "./types.ts";

// The caller's own full record (env/access/prompt/view prefs); delivered ONLY
// to that user. Same shape as UserAdminWire, kept as a distinct name so the
// audience contract is explicit at every use site.
export type UserSelfWire = UserRecord;

// Any user's full record; delivered ONLY to owners managing them.
export type UserAdminWire = UserRecord;

// The office.getAccess response.
export interface AccessSettings {
  hosted: boolean;
  externalAccess: boolean;
  publicOrigin: string | null;
  boundLoopback: boolean;
}

// Indexed-access into the canonical types wherever a field mirrors AgentInfo /
// TaskItem / Cronjob, so the request alias and the entity stay in lockstep.

export interface SpawnReq {
  profileKey?: string;
  name: string;
  cwd: string;
  roomId: string;
  // A front desk (0-7). null or omitted puts the agent in the room's back
  // room; a taken front desk falls through to the first free one, then the
  // back room.
  desk?: number | null;
  permissionMode?: AgentInfo["permissionMode"];
  instructions?: string;
  // Old name of `instructions`, kept for one release. Not both.
  customInstructions?: string;
  outfit?: AgentInfo["outfit"];
  modelFamily?: string;
  // Optional concrete model. Without modelFamily, the server derives the
  // family. If both are present, they must describe the same selection.
  model?: string;
  effort?: AgentInfo["effort"];
  agentType?: AgentInfo["agentType"];
  codexSandbox?: AgentInfo["codexSandbox"];
}

// Read-only form preview. Identity comes from the existing agent or the caller.
export interface AgentSystemPromptPreviewReq {
  agentId?: string;
  roomId: string;
  name: string;
  agentType: AgentInfo["agentType"];
  instructions: string;
  privileged: boolean;
  memory?: string;
  // The form's mode, for the schedule line. Absent: the agent's, else the
  // new-agent default.
  permissionMode?: AgentInfo["permissionMode"];
  codexSandbox?: AgentInfo["codexSandbox"];
}

export type EditAgentReq = Partial<
  Pick<
    AgentInfo,
    | "name"
    | "cwd"
    | "outfit"
    | "customInstructions"
    | "modelFamily"
    | "effort"
    | "permissionMode"
    | "codexSandbox"
    | "autoHandoff"
    | "autoHandoffTokens"
    | "limitResume"
    // Changing the engine starts a fresh conversation on the new engine (the old
    // one is preserved in the resume history). Model/effort/permission sent in
    // the same edit are validated against the NEW engine and applied; omitted
    // ones reset to the new engine's defaults (cross-engine values don't
    // carry). A modelFamily that cannot belong to the target engine is
    // rejected with 422 invalid_model_family rather than silently coerced.
    | "agentType"
  >
> & {
  // Optional concrete model; see SpawnReq.model.
  model?: string;
  // REQUIRED iff customInstructions is present in the body:
  // echo back AgentInfo.customInstructionsVersion as read off full_state /
  // agent_updated (UI) or GET /api/agents/:id/instructions
  // (agents.readInstructions, the agent-facing read). Missing
  // then -> 400 invalid_version; stale -> 409 version_conflict with the
  // current version. Scalar-only edits omit it and stay friction-free.
  customInstructionsVersion?: string;
  // The new names of customInstructions and customInstructionsVersion. The
  // old names stay for one release; a body carries one name of each, not both.
  instructions?: string | null;
  instructionsVersion?: string;
};

export interface ReviveReq {
  roomId: string;
  // A free front desk. null or omitted takes the first free back room seat.
  desk?: number | null;
}

// Body for agents.setPrivileged (PUT /api/agents/:id/privileged). Deliberately
// its OWN request type, NOT a member of the EditAgentReq Pick - privilege is an
// owner-administrative mutation gated to scope==="user" (mirrors users.setAccess
// vs users.update), so it must never ride the agent:manage edit path where a
// privileged agent could reach it.
export interface SetPrivilegedReq {
  privileged: boolean;
}

// Body for agents.setManager (PUT /api/agents/:id/manager). Its own route for
// the reason SetPrivilegedReq is: an office owner only, by cookie session.
export interface SetManagerReq {
  userId: string;
}

export interface MoveAgentReq {
  targetRoomId: string;
  // A free front desk, null for a back room seat, or omitted to keep the
  // agent's area (front: first free desk, then the back room).
  desk?: number | null;
}

export interface SwapDesksReq {
  deskA: number;
  deskB: number;
}

export interface SendMessageReq {
  text: string;
  appContext?: { name: string; registration: number };
  device?: string;
  attachments?: Attachment[];
  // Optional legacy input. Sender authority is ALWAYS the token; rejected if
  // present and ≠ token.agentId, ignored otherwise (see guards.senderMustEqualTokenAgent).
  senderAgentId?: string;
  // Optional retry-dedup key. AGENT (inter-agent) branch: folds into the
  // manager's queue dedupe, the same field the retired POST /agents/:id/message
  // accepted; when deliverAt is present it doubles as the scheduled-message
  // idempotency key (persisted, so it survives restarts). USER branch: the
  // composer's attempt id - a repeat from the same member is acknowledged
  // without sending again (in memory, per agent, bounded; lost on restart).
  // At most 128 characters on the USER branch (422 otherwise). On the USER
  // branch a 200 means the server has taken durable responsibility for the
  // message; every refusal is an HTTP error with its code.
  clientMessageId?: string;
  // AGENT branch only: schedule the message for future delivery instead of
  // sending now. Strict RFC3339 with a REQUIRED Z or numeric offset (offset-less
  // local timestamps are rejected as ambiguous); must be in the future, at most
  // 30 days ahead. Present on a USER-scope call → 400 (never silently sent now).
  // The ack becomes { scheduledId, deliverAt } instead of { messageId }.
  deliverAt?: string;
  // USER branch only (Ctrl/Cmd+Enter in the composer): if the message lands in
  // a busy agent's queue, immediately trigger the same abort+flush that POST
  // /api/agents/:id/send-now performs. Everywhere else the flag is inert - an
  // idle agent gets a plain send, and slash commands / multi-step flows take
  // their existing paths. Present on an AGENT-scope call → 400 (agents pass
  // `steer` below instead).
  sendNow?: boolean;
  // AGENT branch only: interrupt the receiver's in-flight turn
  // so this message lands now instead of after it. Enqueue and interrupt happen
  // in one request, decided against the same state read - the two-call
  // enqueue-then-send-now sequence could have the receiver go idle in between,
  // and report a plain delivery for what the sender meant as a steer. Degrades
  // to a plain queue (never an error) when the receiver is mid multi-step flow
  // or over the per-receiver steer rate limit; the ack says which happened.
  // Present on a USER-scope call → 400 (users have sendNow); combined with
  // deliverAt → 400 (a scheduled steer is not in this slice).
  steer?: boolean;
}

export interface EditMessageReq {
  newText: string;
  device?: string;
}

export interface ResumeReq {
  sessionId: string;
}

// A new conversation may target a specific engine. Omitted => keep the agent's
// current engine. When it differs, the agent switches engine and the fresh
// conversation starts with that engine's default model/effort/permission.
export interface NewConversationReq {
  agentType?: AgentBackendType;
}

// Hand off to a fresh copy of the SAME agent: reset the session (like
// newConversation) then deliver `text` into the fresh session, marked as a
// self-handoff so the clean copy resumes on the brief without replying to
// itself.
export interface HandoffReq {
  text: string;
}

// GET /api/agents/:id/terminal. open is false when the agent has no terminal
// running; truncated is true when older output left the in-memory buffer.
export interface TerminalReadRes {
  open: boolean;
  output: string;
  truncated: boolean;
}

export interface TopicReq {
  topic: string;
}

export interface AffordanceReadFileReq {
  path: string;
}

export interface AffordanceEditFileReq {
  path: string;
}

export interface AffordanceDiffReq {
  dir?: string;
  commit?: string;
}

export interface AffordanceTerminalCmdReq {
  command: string;
}

export interface AffordancePreviewUrlReq {
  /** http(s) URL to screenshot. */
  url: string;
  /** Integers, 320..2560 each. Default 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Best-effort render budget in ms (0..10000), mapped to Chrome's
   * --virtual-time-budget (fast-forwards page timers, not a wall-clock sleep).
   */
  wait?: number;
}

/**
 * GET /api/agents/:id/context - an agent's own context-window fullness.
 * The reading is the latest backend sample and may lag the caller's in-flight
 * turn (an agent asking about itself is always mid-turn); treat it as "as of
 * roughly the last turn boundary". `percentage` is a raw float 0..100.
 * Unavailable reasons: "no_session" = blank/fresh conversation with nothing to
 * measure; "not_yet_measured" = a conversation exists but no sample has landed
 * yet (e.g. Codex before its first turn, or right after a server restart).
 */
export type AgentContextUsageResp =
  | {
      available: true;
      model: string;
      totalTokens: number;
      maxTokens: number;
      percentage: number;
      sampledAtMs: number;
    }
  | { available: false; reason: "no_session" | "not_yet_measured" };

/** GET /api/agents/:id/subscription - the agent's account allowance. */
export type AgentSubscriptionUsageResp =
  | {
      available: true;
      plan: string | null;
      windows: Array<{
        label: string;
        usedPercent: number;
        resetsAtMs: number | null;
      }>;
      primaryIndex: number;
      sampledAtMs: number;
      observedAtMs: number;
      ageMs: number;
      freshness: "fresh";
    }
  | {
      available: true;
      plan: string | null;
      windows: Array<{
        label: string;
        usedPercent: number;
        resetsAtMs: number | null;
      }>;
      primaryIndex: number;
      sampledAtMs: number;
      observedAtMs: number;
      ageMs: number;
      freshness: "cached";
      staleReason: "no_session" | "refresh_failed";
    }
  | {
      available: false;
      reason: "no_session" | "not_yet_measured" | "provider_unavailable";
    };

/**
 * POST /api/agents/:id/browser - use the manager's paired Chrome browser.
 * Chrome controls one offered tab plus its site-created popup chain.
 * `close` detaches and leaves pages/music running; viewport is ignored.
 * A lost command
 * can have an unknown outcome and is never replayed. preview-url stays server-side.
 * See internal-docs/browser-extension.md and server/browser-actions.ts.
 */
export interface AffordanceBrowserReq {
  action:
    | "goto"
    | "snapshot"
    | "text"
    | "click"
    | "fill"
    | "select"
    | "check"
    | "upload"
    | "press"
    | "screenshot"
    | "close";
  /** `goto`: the http(s) URL to open. */
  url?: string;
  /** `click`, `fill`, `select`, `check`, and optionally `press`: a Playwright selector. */
  selector?: string;
  /** `upload`: one absolute office-server file path, up to 4 MiB. */
  path?: string;
  /** `fill`: the value to type into the field. */
  text?: string;
  /** `press`: the key name, e.g. "Enter". */
  key?: string;
  /** `select`: the option value; exactly one of value and label. */
  value?: string;
  /** `select`: the option label; exactly one of value and label. */
  label?: string;
  /** `check`: the wanted state; default true. */
  checked?: boolean;
  /** `click`, `press`, `select`, `check`: accept the first dialog the action opens. */
  dialog?: "accept";
  /** `screenshot`: capture the whole page instead of the viewport. */
  fullPage?: boolean;
  /** Accepted for old callers; Chrome keeps its desktop viewport. */
  viewport?: { width: number; height: number };
}

/**
 * Every action answers with the page's url and title after it ran, so an agent
 * that clicked into a navigation knows where it landed. `snapshot` adds the
 * ARIA tree, `text` adds the rendered body text, `close` sets `closed`.
 * A `screenshot` puts its image in the agent's chat and returns no bytes here.
 * Screenshot dimensions use CSS pixels.
 */
export interface AffordanceBrowserResp {
  ok: true;
  url: string;
  title: string;
  snapshot?: string;
  text?: string;
  uploaded?: { name: string; mimeType: string; size: number };
  closed?: boolean;
  /** `select`: the selected option values. */
  selected?: string[];
  /** `check`: the control's checked state after the action. */
  checked?: boolean;
  /** The input completed, but a navigation it started had not loaded. */
  loading?: boolean;
  /** JavaScript dialogs that the action opened, and their answers. A failure carries them as `error.dialogs`. */
  dialogs?: { type: string; message: string; accepted: boolean }[];
}

/**
 * GET /api/agents/:id/logs - conversation-log search and retrieval. One route,
 * three modes chosen by the query (see server/log-search.ts): `?q=` searches,
 * `?session=` retrieves, neither lists the agent's sessions.
 *
 * The three response shapes are distinguishable without a discriminator field:
 * the index carries `sessions`, a search carries `results`, a retrieval carries
 * `entries`.
 */

/** Entry kinds, indexed off LogEntry so the two can never drift. */
export type LogEntryKind = LogEntry["kind"];

/**
 * The named kind presets. `conversation` is the default in every mode, which is
 * what keeps thinking traces opt-in: reaching them takes an explicit
 * `kind=thinking` or `tier=full`.
 */
export type LogTier = "prompts" | "conversation" | "full";

/** One session in the index mode's listing. */
export interface LogSessionIndexEntry {
  sessionId: string;
  topic: string | null;
  lastModified: number;
  /** The session's summary paragraph. Absent when it has none. */
  summary?: string;
  /** This session was forked off another one. */
  forked?: true;
  /** Another session was forked off this one. */
  branched?: true;
}

/** Live turn state disclosed by transcript reads. Epoch values are ms. */
export interface LogInFlightTurn {
  startedAt: number;
  activeTool: { name: string; startedAt: number } | null;
}

/** Live turn state disclosed by GET /agents. Tool names stay log-scoped. */
export interface ManifestInFlightTurn {
  startedAt: number;
  activeTool: { startedAt: number } | null;
}

export interface LogSessionIndexResp {
  agentId: string;
  sessions: LogSessionIndexEntry[];
  /** `limit=` left out older sessions; page on with `before=<lastModified>`
   * of the last session listed. */
  truncated: boolean;
  /**
   * Which two-step prompt the agent is parked on RIGHT NOW, or null.
   *
   * LIVE AGENT STATE, NOT SESSION HISTORY. It describes the
   * agent at the moment of THIS request and says nothing about the session
   * being read: a transcript fetched for an old session still reports the
   * agent's current prompt, and re-reading the same session later can return a
   * different value. Present because a permission prompt is written as an
   * ephemeral log entry and never reaches the transcript, so a reader sees a
   * turn that simply stops and concludes the backend died. Carries the KIND
   * only - never the prompt text, the tool name, or the command.
   */
  pendingPrompt: PendingPromptKind | null;
  /**
   * The agent's turn RIGHT NOW, not history for any listed session. Tool names
   * are safe here because this response has the same authorization as reading
   * the transcript that already contains them.
   */
  inFlightTurn: LogInFlightTurn | null;
}

/**
 * One search hit. `sessionId` + `entryId` are the context handle: feed them
 * back as `?session=<sessionId>&around=<entryId>` to read the neighbouring
 * entries. `snippet` is cut from the DECODED content, never the raw JSONL line.
 */
export interface LogSearchHit {
  sessionId: string;
  topic: string | null;
  timestamp: number;
  kind: LogEntryKind;
  entryId: string;
  snippet: string;
}

/**
 * A session whose summary paragraph or topic matches the query. Separate from
 * the entry hits: a paragraph is not a log entry and has no entry id or kind.
 * `snippet` is cut from the paragraph, or is the topic for a topic-only hit.
 */
export interface LogSummaryHit {
  sessionId: string;
  topic: string | null;
  lastModified: number;
  snippet: string;
}

export interface LogSearchResp {
  agentId: string;
  query: string;
  regex: boolean;
  /**
   * The kinds actually applied - the canonical resolved selection. `null` means
   * no filter at all (every kind).
   */
  kinds: LogEntryKind[] | null;
  /**
   * The preset `kinds` came from, or `null` when an explicit `kind=` replaced
   * it. Never report a preset name for a selection the caller overrode: an
   * arbitrary kind set has no tier, and labelling it with one would make the
   * response contradict itself.
   */
  tier: LogTier | null;
  /**
   * The TRUE match count when the scan ran to completion, and `null` when it
   * did NOT (`timedOut: true`), because at that point no true total is
   * knowable. A partial count is reported separately rather than being passed
   * off as a total - the dangerous confusion is a caller reading a partial 0 as
   * "there are no matches".
   */
  totalMatches: number | null;
  /** How many matches were found before the scan stopped. Only when timedOut. */
  matchesFoundBeforeTimeout?: number;
  /** Results were omitted by `limit`, among the hits that WERE found. */
  truncated: boolean;
  /**
   * The scan ran out of its wall-clock budget and stopped early. A separate
   * signal from `truncated` on purpose - "I stopped looking" and "there was
   * more than you asked for" are different facts.
   */
  timedOut: boolean;
  results: LogSearchHit[];
  /** Sessions whose summary or topic matches, newest first, at most `limit`. */
  summaryHits: LogSummaryHit[];
}

/**
 * One retrieved entry. Content is capped per entry so `tier=full` on a session
 * with large tool results cannot detonate the caller's context; when it is cut,
 * `contentTruncated` is set and `contentLength` reports the true size.
 */
export interface LogRetrievedEntry {
  entryId: string;
  timestamp: number;
  kind: LogEntryKind;
  content: string;
  contentTruncated?: true;
  contentLength?: number;
}

export interface LogRetrieveResp {
  agentId: string;
  sessionId: string;
  topic: string | null;
  /** The session's summary paragraph. Absent when it has none. */
  summary?: string;
  /** The kinds actually applied; `null` means every kind. See LogSearchResp. */
  kinds: LogEntryKind[] | null;
  /** The preset they came from, or `null` when `kind=` overrode it. */
  tier: LogTier | null;
  totalEntries: number;
  truncated: boolean;
  entries: LogRetrievedEntry[];
  /** Present only in `around` mode: the anchor entry, its window, and whether
   * the anchor was found in this session's timeline at all. */
  around?: string;
  window?: number;
  found?: boolean;
  /**
   * Which two-step prompt the agent is parked on RIGHT NOW, or null.
   *
   * LIVE AGENT STATE, NOT SESSION HISTORY. It describes the
   * agent at the moment of THIS request and says nothing about the session
   * being read: a transcript fetched for an old session still reports the
   * agent's current prompt, and re-reading the same session later can return a
   * different value. Present because a permission prompt is written as an
   * ephemeral log entry and never reaches the transcript, so a reader sees a
   * turn that simply stops and concludes the backend died. Carries the KIND
   * only - never the prompt text, the tool name, or the command.
   */
  pendingPrompt: PendingPromptKind | null;
  /** Live state for the agent RIGHT NOW; it may describe another session. */
  inFlightTurn: LogInFlightTurn | null;
}

export type LogsResp = LogSessionIndexResp | LogSearchResp | LogRetrieveResp;

export interface EditorSaveReq {
  path: string;
  content: string;
  expectedMtime: number;
  /**
   * Server-issued revision from the open/save this buffer is based on. When
   * present the save guard compares revisions (catches rollbacks and
   * same-millisecond replaces the mtime comparison misses); omitted by older
   * clients, which get the legacy mtime guard.
   */
  expectedRev?: number;
  force?: boolean;
}

export interface RoomCreateReq {
  name?: string;
  // The look the new room is drawn in. Absent creates it in the office look,
  // which is what every room drew before skins existed.
  skin?: RoomSkin | null;
}

export interface RoomRenameReq {
  // All five fields are optional and independent: the picker sends only `pet`,
  // the settings pane sends whichever of the others changed. A body carrying
  // none of them is malformed.
  name?: string;
  // null clears the room's pet back to the default. Absent leaves it alone.
  pet?: RoomPet | null;
  // null clears the room's skin back to the office look. Absent leaves it
  // alone. The lobby draws its own scene and takes no skin. Changing it keeps
  // the decor choices; a preset reset sends `decor: null` with it.
  skin?: RoomSkin | null;
  // Merged into the room's choices: a value sets that slot, null clears it back
  // to the preset, an absent key leaves it. `decor: null` clears every choice.
  decor?: RoomDecorPatch | null;
  // Turns the back room on or off. Off is refused (409 back_room_in_use)
  // while agents sit there. The lobby has no back room.
  backRoom?: boolean;
}

// Room-prompt write. `version` is the token from a preceding rooms.getSettings
// read - a mismatch means the prompt changed under you (409 version_conflict),
// mirroring the memory read-before-replace contract.
export interface RoomSettingsReq {
  prompt: string | null;
  version: string;
}

// rooms.getSettings response: the prompt + its optimistic-concurrency version
// (sha of the prompt bytes; a never-set/cleared prompt hashes "").
export interface RoomSettingsRes {
  prompt: string | null;
  version: string;
  // The room's look, for reading before a PATCH. `version` does not cover it.
  skin: RoomSkin | null;
  pet: RoomPet | null;
  decor: RoomDecor | null;
  backRoom: boolean;
}

export interface ViewOrderReq {
  order: string[];
}

// view.setShown: the FULL list of accessible rooms the caller wants displayed;
// hidden becomes accessible minus this (clamped server-side). Removed as
// callerless, restored alongside the
// hide-rooms UI on the Users page.
export interface ShownRoomsReq {
  shown: string[];
}

// view.listRooms (GET /api/me/rooms). Minimal reference to a
// room the CALLER can access, hidden ones included (the projected full_state
// rooms exclude hidden, and members don't get the owner-only all_rooms_list,
// so this read is what makes re-SHOW possible). id+name only - everything
// else about a room rides the projection once the room is shown.
export interface AccessibleRoomWire {
  id: string;
  name: string;
}

export interface MeRoomsRes {
  rooms: AccessibleRoomWire[];
}

export interface NotifRoomsReq {
  notifRooms: string[];
}

// view.setPushRooms: the FULL list of rooms whose turn ends push to the
// caller's devices.
export interface PushRoomsReq {
  pushRooms: string[];
}

// view.setTucked: the FULL list of rooms the caller tucks into the tab bar's
// overflow chip.
export interface TuckedRoomsReq {
  tucked: string[];
}

// prefs.update (PATCH /api/me/preferences). SELF-only personal
// preferences, deliberately NOT on the selfOrOwner users.update route: the
// split keeps an owner out of a member's personal settings. A Partial
// so a caller can clear or set the value; `language: null` is meaningful.
export type PreferencesReq = Partial<{
  language: SupportedLanguageCode | null;
  voiceInput: VoiceInput;
  voiceOutput: VoiceOutput;
  voiceName: VoiceName;
}>;

// The writable preference keys, as VALUES, so the handler can reject an unknown
// key (a typo like `langauge` would otherwise be a successful no-op) without a
// second hand-maintained list drifting from the type above.
export const PREFERENCE_KEYS = [
  "language",
  "voiceInput",
  "voiceOutput",
  "voiceName",
] as const;

export interface ApiTokenWire {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface ApiTokenCreateReq {
  name: string;
  expiresInDays: 30 | 365 | null;
}

export interface ApiTokenCreateRes {
  token: string;
  apiToken: ApiTokenWire;
}

export interface ApiTokenListRes {
  apiTokens: ApiTokenWire[];
}

export interface ApiTokenInboxMessage {
  direction: "from_agent";
  sequence: number;
  id: string;
  sentAt: number;
  text: string;
  senderAgentId: string;
  senderAgentName: string;
  senderRoomName: string;
}

export interface ApiTokenSentMessage {
  direction: "to_agent";
  sequence: number;
  id: string;
  sentAt: number;
  text: string;
  targetAgentId: string;
  targetAgentName: string;
  targetRoomName: string;
}

export type ApiTokenLogEntry = ApiTokenInboxMessage | ApiTokenSentMessage;

export interface ApiTokenInboxSendReq {
  text: string;
}

// Asks (internal-docs/asks-design.md). `text` is the prompt on
// create and edit and the answer on reply, so each route also takes the
// text/plain form.
export interface AskCreateReq {
  text: string;
  // A member's username. Absent means the agent's manager.
  member?: string;
  // One of OFFICE_LINK_PATHS (shared/office-links.ts).
  link?: string;
  // 2 to 4 answers the member can tap (ASK_OPTIONS_MIN..MAX in server/asks.ts).
  options?: string[];
  // The option the agent recommends, by its text; one of `options`.
  recommended?: string;
  // Chat affordances, at most ASK_AFFORDANCES_MAX in total: single-line
  // commands, and paths resolved against the agent's cwd.
  commands?: string[];
  editFiles?: string[];
  readFiles?: string[];
}
export interface AskEditReq {
  text: string;
  // Absent keeps the ask's link; "" removes it.
  link?: string;
  // Absent keeps the ask's options; [] removes them.
  options?: string[];
  // Goes with options: sent options without it clear the mark. With kept
  // options, one of them; "" removes the mark.
  recommended?: string;
  // For each: absent keeps the ask's list; [] removes it.
  commands?: string[];
  editFiles?: string[];
  readFiles?: string[];
}
export interface AskReplyReq {
  text: string;
  // The member's device label, as on a chat message (user sessions only).
  device?: string;
}
export interface AskDismissReq {
  // What the member typed, sent as the dismissal's reason. Blank or absent:
  // the agent reads "Dismissed".
  text?: string;
  device?: string;
}
// What an agent reads back: the member wire plus the target's username.
// member is null for an office secret request, which is for every owner.
export type AskAgentWire = AskMemberWire & { member: string | null };

export interface ApiTokenInboxSendRes {
  messageId: string;
  lastDrainedAt: number | null;
}

export interface ApiTokenInboxDrainReq {
  after?: number;
}

export interface ApiTokenInboxDrainRes {
  firstSequence: number;
  latestSequence: number;
  entries: ApiTokenLogEntry[];
  previouslyDrainedAt: number | null;
  drainedAt: number;
}

export interface MemberPromptRes {
  memberPrompt: string | null;
  memberPromptVersion: string;
}

export type UserUpdateReq = Partial<{
  role: UserRecord["role"];
  name: string;
  memberPrompt: string | null;
  memberPromptVersion: string;
  avatarColor: string;
  avatarVariant: UserRecord["avatarVariant"];
}>;

export interface SetAccessReq {
  allowedRooms: string[];
}

// invites.mint (POST /api/invites) - an owner-issued sign-in link for an
// EXISTING member. Members are created first (users.create); an invite never
// creates one. Target is the stable userId; the server derives name/role from
// the record and fixes TTL/replacement policy - no other knobs on the wire.
export interface InviteMintReq {
  userId: string;
}

// invites.mintRecovery (POST /api/invites/recovery) - the permanent alias of
// invites.mint. deploy/install.sh and the control plane call it on offices of
// every version.
export type RecoveryMintReq = InviteMintReq;

// users.create (POST /api/users) - an owner creates a member before any
// sign-in link exists. The record starts with pendingSignIn. Language is a
// self-only preference, picked by the member at their first sign-in.
export interface UserCreateReq {
  name: string;
  role: UserRecord["role"];
  instructions?: string | null;
  // Old name of `instructions`, kept for one release. Not both.
  memberPrompt?: string | null;
  avatarColor?: string;
  avatarVariant?: UserRecord["avatarVariant"];
  // Member room grants; refused for an owner (owners reach every room by
  // rule). Unknown room ids are refused.
  allowedRooms?: string[];
}

export interface AccessSettingsReq {
  externalAccess: boolean;
  publicOrigin: string;
}

export interface OfficeSettingsReq {
  // Optional like `name`: omitted preserves the stored office prompt, explicit
  // null clears it.
  prompt?: string | null;
  // Optional: omitted preserves the current office name (a stale client tab),
  // explicit null/empty clears it, a string sets it. The handler keys on the
  // undefined-vs-null distinction, so null must be representable in the contract.
  name?: string | null;
  // Token from a preceding office.getSettings read. The PUT replaces the whole
  // settings blob (prompt/name), so ONE version guards the whole
  // clobber surface - a mismatch is a 409 version_conflict, mirroring memory
  // REPLACE.
  version: string;
  // The member usage cap switch. Omitted preserves it (a stale client tab).
  memberUsageCap?: boolean;
  // The member share of the weekly limit, in percent: a multiple of 10 from
  // 10 to 100. Omitted preserves it.
  memberUsageShare?: number;
  // The "Record terminals" switch. Omitted preserves it.
  recordTerminals?: boolean;
}

// `notes`: the usage note of each variable that has one (integrations A4).
export type UserEnvRes = {
  mode: "managed";
  values: Record<string, string>;
  notes?: Record<string, string>;
};

// Owner-only member connections. These explicit projections exclude variable
// values, provider account labels, directory facts, and probe errors.
export type MemberProviderStatus = {
  provider: "claude" | "codex";
  status: "connected" | "not_connected" | "unknown";
};
export type UserEnvNamesRes = {
  names: string[];
  // A name with no note has no key.
  notes: Record<string, string>;
  providers: MemberProviderStatus[];
};

// GET /api/office/env/names: the office variables' names and notes, for
// members too. Never a value.
export type OfficeEnvNamesRes = {
  variables: { name: string; note: string | null }[];
};

// The integrations list (GET /api/me/connections): every connection the
// caller's agents can use, names only. A variable never carries its value.
// Office variables reach every member, names and notes only (Nil, ruling 2,
// 2026-10-13). claudeConnectors has one entry per Claude sign-in with a
// claude.ai login: seenAt null means no Claude turn on that sign-in since the
// server started, names [] with a seenAt means it really has none.
export type ConnectionScope = "office" | "personal";
export type ConnectionsListRes = {
  // `note` on variables, MCP servers and secrets: the member's usage note for
  // agents (A4). Absent from servers before A4.
  variables: { scope: ConnectionScope; name: string; note?: string | null }[];
  signIns: {
    scope: ConnectionScope;
    engine: "claude" | "codex";
    account: string | null;
  }[];
  claudeConnectors: {
    scope: ConnectionScope;
    seenAt: number | null;
    names: string[];
    // Each name's status from the last after-turn status read; a name with
    // no entry has not been read yet. Absent from servers before A3. `tools`
    // is the tool count the read saw, absent when it reported none.
    statuses?: { name: string; status: McpServerStatus; tools?: number }[];
  }[];
  // Remote MCP servers Isomux gives every engine. The host only: the path of
  // some hosted servers carries the token. `secret` is the credential's name,
  // null for an office server when the caller is not an owner. `overridden`:
  // the caller's own server with the same name replaces this office one.
  mcpServers: {
    scope: ConnectionScope;
    name: string;
    host: string;
    credential: boolean;
    secret: string | null;
    problem: McpServerProblem | null;
    overridden: boolean;
    note?: string | null;
    // Signs in through the MCP authorization flow (integrations A2b).
    oauth?: boolean;
  }[];
  // MCP servers set in Claude itself, as the caller's Claude sessions last
  // reported them: user settings, or a project's .mcp.json in `folder`.
  // `signIn`: for a user or local server, the caller's sign-in whose Claude
  // config directory holds it; null for a project server (it belongs to the
  // folder) and for a directory neither sign-in uses now. Absent from older
  // servers.
  engineMcpServers: {
    engine: "claude";
    name: string;
    source: "user" | "project" | "local";
    folder: string | null;
    signIn?: ConnectionScope | null;
    // Null until an after-turn status read; absent from servers before A3.
    status?: McpServerStatus | null;
    tools?: number;
  }[];
  // Secrets, names and hosts only, office ones for every member. `test` names
  // the identity check a Test runs, null when there is none or when the
  // caller may not run it (an office secret, for a member). Absent from
  // servers before A3.
  secrets?: {
    scope: ConnectionScope;
    name: string;
    hosts: string[];
    test: SecretTestKind | null;
    note?: string | null;
  }[];
};

// GET /api/agent-connections (A4): the connections the calling agent gets,
// with their usage notes. Never a value, a URL path or a secret name.
// `engineName` is the MCP server's name in the agent's tools.
export type AgentConnectionKind = "variable" | "secret" | "mcp-server";
export interface AgentConnectionWire {
  kind: AgentConnectionKind;
  scope: ConnectionScope;
  name: string;
  engineName?: string;
  hosts: string[];
  note: string | null;
}
export interface AgentConnectionsRes {
  connections: AgentConnectionWire[];
}

// An MCP server's status as Claude reports it (the SDK's closed set).
export const MCP_SERVER_STATUSES = [
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

// One of the set above, or null for any other value.
export function knownMcpStatus(value: unknown): McpServerStatus | null {
  return (MCP_SERVER_STATUSES as readonly unknown[]).includes(value)
    ? (value as McpServerStatus)
    : null;
}

// Connection tests (integrations A3). A result names hosts only: never a
// credential, a URL path or a query, and no text the service wrote except the
// account or server name, which the server checks first.
export const SECRET_TEST_KINDS = ["github", "stripe", "fly"] as const;
export type SecretTestKind = (typeof SECRET_TEST_KINDS)[number];
export type ConnectionTestReason =
  // 401: the service does not accept the credential.
  | "refused"
  // 401 from an MCP server registered with no credential.
  | "no_credential"
  // 403: the service knows the credential, but it cannot read the account.
  | "forbidden"
  // Another status that is not 2xx (in `status`).
  | "status"
  // 3xx: the test does not follow redirects.
  | "redirect"
  | "timeout"
  // No connection: DNS, TCP or TLS.
  | "unreachable"
  // An answer the test cannot read.
  | "unexpected"
  // The MCP server asks for an OAuth sign-in.
  | "needs_oauth"
  // Nothing to test: no identity check for the secret's hosts, or the MCP
  // server's secret is missing or does not list its host.
  | "not_testable";
export type ConnectionTestResult =
  | { ok: true; kind: "secret"; host: string; account: string | null }
  | {
      ok: true;
      kind: "mcp";
      host: string;
      server: string | null;
      tools: number;
    }
  | {
      ok: false;
      host: string | null;
      reason: ConnectionTestReason;
      status?: number;
    };
export interface ConnectionTestRes {
  result: ConnectionTestResult;
}

// Why a registered server is left out of agent sessions.
// An OAuth server with no access token: "sign_in" before the first sign-in,
// "sign_in_again" when its authorization server refused the refresh.
export type McpServerProblem =
  | "secret_missing"
  | "secret_host"
  | "sign_in"
  | "sign_in_again";

// `notes` absent keeps the notes of the names that remain.
export interface UserEnvReplaceReq {
  values: Record<string, string>;
  notes?: Record<string, string>;
}
// PUT /api/users/:username/env/:name. `note` absent keeps the saved note;
// null or "" clears it.
export interface UserEnvSetReq {
  value: string;
  note?: string | null;
}

// Secrets (internal-docs/secrets-design.md, section 1). Only Show
// (SecretValueRes) carries a value.
export interface SecretWire {
  name: string;
  hosts: string[];
  form: SecretForm;
  createdAt: number;
  valueSetAt: number;
  updatedAt: number;
  note: string | null;
  // The live apps that read the raw value from their environment (task
  // c7007f8b). A grant whose app was deleted is not listed.
  apps: string[];
}
export interface SecretListRes {
  secrets: SecretWire[];
}
export interface SecretCreateReq {
  name: string;
  value: string;
  hosts: string[];
  form: SecretForm;
  note?: string | null;
  // App names. Only a human caller may send them.
  apps?: string[];
}
export interface SecretRotateReq {
  value: string;
}
export interface SecretUpdateReq {
  hosts?: string[];
  form?: SecretForm;
  note?: string | null;
  // The whole new list. Only a human caller may add an app.
  apps?: string[];
}
export interface SecretRes {
  secret: SecretWire;
}
// Show (GET .../secrets/:name/value): the one response with a value. Only the
// secret's own member, or an owner for an office secret.
export interface SecretValueRes {
  value: string;
}
// GET /api/office/secrets: an owner gets SecretWire rows, a member this
// summary only (Nil, 2026-10-13).
export interface OfficeSecretSummaryWire {
  name: string;
  hosts: string[];
  note: string | null;
}
export interface OfficeSecretListRes {
  secrets: SecretWire[] | OfficeSecretSummaryWire[];
}

// Secret requests (secrets loop, B4). The agent proposes; the member saves
// the value with the hosts and form as edited on the card.
export interface SecretRequestReq {
  name: string;
  hosts: string[];
  form?: SecretForm;
  reason: string;
  scope?: "personal" | "office";
}
export interface SecretRequestRes {
  requestId: string;
}
export interface SecretRequestSaveReq {
  value: string;
  hosts?: string[];
  form?: SecretForm;
}
export interface SecretRequestAnswerRes {
  name: string;
}

// Remote MCP servers (integrations loop, A2). `secret` names a secret in the
// same scope; the editor's own list is the only response with the whole URL.
export interface McpServerWire {
  name: string;
  url: string;
  secret: string | null;
  createdAt: number;
  updatedAt: number;
  note: string | null;
  // The MCP authorization flow (integrations A2b): null for a server with a
  // static credential or none. `clientId` is the pasted or registered client.
  oauth: { clientId: string | null; signedIn: boolean } | null;
}
// A pasted client; absent fields mean dynamic client registration.
export interface McpServerOAuthReq {
  clientId?: string;
  clientSecret?: string;
}
export interface McpServerListRes {
  servers: McpServerWire[];
}
// GET /api/office/mcp-servers: an owner gets McpServerWire rows, a member
// this summary only: the host, never the URL path (it can carry a token) or
// the credential's secret name.
export interface OfficeMcpServerSummaryWire {
  name: string;
  host: string;
  note: string | null;
}
export interface OfficeMcpServerListRes {
  servers:
    | McpServerWire[]
    | OfficeMcpServerSummaryWire[]
    | AgentMcpServerWire[];
}
// A server as an agent reads it from the MCP server routes (Lead, 2026-10-14):
// the host in place of the URL, whose path or query can carry a token. An
// agent never receives a URL path; it can still set a whole URL.
export type AgentMcpServerWire = Omit<McpServerWire, "url"> & { host: string };
export interface AgentMcpServerListRes {
  servers: AgentMcpServerWire[];
}
export interface AgentMcpServerRes {
  server: AgentMcpServerWire;
}
export interface McpServerCreateReq {
  name: string;
  url: string;
  secret: string | null;
  note?: string | null;
  oauth?: McpServerOAuthReq | null;
}
export interface McpServerUpdateReq {
  url?: string;
  secret?: string | null;
  note?: string | null;
  oauth?: McpServerOAuthReq | null;
}
export interface McpServerRes {
  server: McpServerWire;
}
export interface McpServerSignInRes {
  authorizationUrl: string;
}

// A member's pager settings (server/pager-settings.ts). The webhook URL is a
// credential: responses carry only its masked form.
export interface PagerSettingsRes {
  webhookUrlMasked: string | null;
  discordUserId: string | null;
  // Minutes between repeats of an open page; null = never.
  repeatMinutes: number | null;
}

// PATCH body: an absent key keeps the saved value, null clears it.
export interface PagerSettingsReq {
  webhookUrl?: string | null;
  discordUserId?: string | null;
  repeatMinutes?: number | null;
}

export type PagerTestRes =
  | { delivered: true }
  | { delivered: false; failure: PagerDeliveryFailure };

// Web Push (server/web-push-*.ts). A device where the member turned on
// notifications; the endpoint never leaves the server.
export type PushDeviceFailure = "gone" | "rejected" | "unreachable";

export interface PushDevice {
  id: string;
  label: string;
  createdAt: number;
  lastFailure?: PushDeviceFailure;
}

export interface PushDevicesRes {
  // The VAPID public key (base64url) the browser subscribes with.
  publicKey: string;
  devices: PushDevice[];
}

export interface PushDeviceReq {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
}

export type PushTestRes =
  | { delivered: true }
  | { delivered: false; failure: PushDeviceFailure };

// One line of the member usage cap status: the office sign-in's weekly
// reading for one provider. A provider with no office sign-in has no line.
export type OfficeUsageStatusWire =
  | {
      provider: "claude" | "codex";
      state: "weekly";
      usedPercent: number;
      // Today's line: members stop once usedPercent reaches it.
      linePercent: number;
    }
  | { provider: "claude" | "codex"; state: "no_limit" | "failed" };

// office.getSettings response: the editable settings plus their
// optimistic-concurrency version.
export type OfficeSettingsRes = Pick<OfficeSettings, "prompt" | "name"> & {
  // Optional only while a new UI bundle can talk to the old server before the
  // server-side half of an update restarts.
  version: string;
  // Optional for the same reason as `version`.
  memberUsageCap?: boolean;
  memberUsageShare?: number;
  memberUsageStatus?: OfficeUsageStatusWire[];
  recordTerminals?: boolean;
};

export interface ValidateCwdReq {
  cwd: string;
}

export interface ValidateEnvReq {
  scope: "office" | "user";
  username?: string;
}

export interface TaskCreateReq {
  title: string;
  description?: string;
  priority?: TaskItem["priority"];
  assignee?: string;
  // Room to file the task under. Absent === scope default (an AGENT caller's own
  // room, a USER caller global); an explicit empty string === office-global; a
  // non-empty id scopes it to that room (subject to the caller's room access).
  roomId?: string;
}

// `version` is mandatory: the TaskItem.version the caller read. A stale one is
// a 409 version_conflict carrying the current task.
export type TaskUpdateReq = { version: string } & Partial<{
  title: string;
  description: string;
  // Absent === leave the priority unchanged; an explicit null clears it back to
  // no-priority. Any other value must be a real level (P0-P4).
  priority: TaskItem["priority"] | null;
  status: TaskItem["status"];
  // Absent === leave the assignee unchanged; null clears it.
  assignee: string | null;
  // Re-room the task (mirrors TaskCreateReq.roomId). Absent === leave the room
  // unchanged; an explicit empty string === clear to office-global; a non-empty
  // id moves it to that room, subject to the caller's room access.
  roomId: string;
}>;

// isomux-memory: APPEND a durable fact (the safe default). scope/scopeId select
// the TARGET file; author + date are server-stamped (never from the body) -
// except on an agent's note to its OWN agent scope, where the stored line
// carries no author at all.
export interface MemoryCreateReq {
  scope: MemoryScope;
  scopeId?: string | null;
  text: string;
}

// isomux-memory: REPLACE the whole file (edit/retract). `version` is the token
// from the preceding READ - a mismatch means the file changed under you (409).
export interface MemoryReplaceReq {
  scope: MemoryScope;
  scopeId?: string | null;
  text: string;
  version: string;
}

// READ response: the verbatim file text + its optimistic-concurrency version,
// and the scope it resolved: scopeId (null for office) and its name: the room
// or member name its auto-load label shows, or the agent's name (null for office).
export interface MemoryReadRes {
  text: string;
  version: string;
  size: number;
  cap: number;
  scopeId: string | null;
  name: string | null;
}

// APPEND response: the new line + the post-write version.
export interface MemoryAppendRes {
  item: MemoryItem;
  version: string;
  size: number;
  cap: number;
}

// REPLACE response: the post-write version (or, on 409, the current version in
// the error detail).
export interface MemoryWriteRes {
  version: string;
}

// Members chat (humans-only stream on the Lobby tab). A page is newest-first
// from the server's point of view and delivered oldest-first; `before` is the
// id of the oldest message the client already holds. readPointer and unread
// describe the CALLER's own position, so one read hydrates the panel and the
// badge together.
export interface MembersChatPageRes {
  pinned: MembersChatMessage[];
  messages: MembersChatMessage[];
  hasMore: boolean;
  readPointer: string | null;
  unread: number;
}

export interface MembersChatPostReq {
  text: string;
  // The server snapshots this existing message; clients cannot supply the quote.
  replyTo?: string;
  // Files already uploaded through membersChat.upload; the server refuses a
  // filename it does not hold.
  attachments?: Attachment[];
  // The browser's device label, a snapshot for the author line. Ignored for an
  // API token (the token's name is the device) and for an agent.
  device?: string;
}

export interface MembersChatPinReq {
  active: boolean;
}

export interface MembersChatThumbsUpReq {
  active: boolean;
}

export interface MembersChatEditReq {
  text: string;
}

export interface MembersChatReadReq {
  lastReadId: string;
}

export interface MembersChatReadRes {
  readPointer: string | null;
  unread: number;
}

export interface TaskClaimReq {
  assignee?: string;
}

// skills.usageCounts response: the CALLING user's per-skill use counters
// (skill name -> count; skills never used are absent). Drives the Sk-menu
// sort order.
export interface SkillUsageCountsRes {
  counts: Record<string, number>;
}

// The skills page (opIds skills.catalog / readFile / saveFile / create). One
// list per engine: the skills an agent of that engine can run, in the order
// that engine resolves a name.
export type SkillEngine = "claude" | "codex" | "opencode";
// isomux: built into isomux (read-only). user: a skills or commands folder in
// the server user's home. project: a skills or commands folder in an agent's
// working folder. plugin: an installed Claude Code plugin (read-only, the
// plugin manager owns the files).
export type SkillSource = "isomux" | "user" | "project" | "plugin";
export interface SkillCatalogEntry {
  // The name a member types after the slash.
  name: string;
  // For a built-in alias, the folder name it also answers to.
  aliasFor?: string;
  description?: string;
  source: SkillSource;
  // A SKILL.md folder, or a single-file command.
  kind: "skill" | "command";
  // Absolute path of the SKILL.md or command file.
  path: string;
  // The folder that was scanned to find it.
  dir: string;
  // A project skill: the agent working folder it comes from.
  project?: string;
  plugin?: string;
  editable: boolean;
  // Set when another skill with the same name comes first wherever this one
  // could run, so this one never runs: the path of the one that does.
  shadowedBy?: string;
  // The caller's own slash-command uses of this name.
  uses: number;
}
export interface SkillCatalogRes {
  engines: { engine: SkillEngine; skills: SkillCatalogEntry[] }[];
  // The folder a new skill goes into.
  newSkillDir: string;
  // The server user's home folder, so a page can show paths as ~/...
  home: string;
}
export interface SkillFileRes {
  path: string;
  content: string;
  // Server-issued revision; send it back as expectedRev on save or delete.
  rev: number;
  mtime: number;
  editable: boolean;
}
export interface SkillSaveReq {
  path: string;
  content: string;
  expectedRev: number;
}
export interface SkillDeleteReq {
  path: string;
  expectedRev: number;
}
export interface SkillSaveRes {
  path: string;
  rev: number;
  mtime: number;
}
export interface SkillCreateReq {
  name: string;
  description: string;
  instructions?: string;
}

export interface CronCreateReq {
  name: string;
  schedule: Cronjob["schedule"];
  prompt: string;
  cwd: string;
  agentType?: Cronjob["agentType"];
  modelFamily: Cronjob["modelFamily"];
  effort: Cronjob["effort"];
  permissionMode: Cronjob["permissionMode"];
  codexSandbox?: Cronjob["codexSandbox"];
  // Task semantics: omitted = an agent caller's own room, else no room;
  // "" = no room; any other value must be a room the caller can access.
  roomId?: string;
}

export type CronUpdateReq = Partial<{
  name: string;
  schedule: Cronjob["schedule"];
  prompt: string;
  cwd: string;
  agentType: Cronjob["agentType"];
  modelFamily: Cronjob["modelFamily"];
  effort: Cronjob["effort"];
  permissionMode: Cronjob["permissionMode"];
  codexSandbox: Cronjob["codexSandbox"];
  enabled: boolean;
  // Omitted keeps the room; "" clears it; any other value must be a room the
  // caller can access.
  roomId: string;
}>;

export interface CronRunMessageReq {
  text: string;
  device?: string;
  // Member composer attempt id: a resend with the same id is not sent twice.
  clientMessageId?: string;
}

// Cronjobs-prompt write body (cron.setPrompt). Inline `{ value }` in the spec.
export interface CronPromptReq {
  value: string | null;
}

// Every instruction layer (office, room, agent, member, schedules) reads and
// writes its text at GET/PUT .../instructions with these shapes. `version` is
// the token from a preceding read: a mismatch is 409 version_conflict with
// the current version. null or "" clears the text.
export interface InstructionsRes {
  instructions: string | null;
  version: string;
}

export interface InstructionsReq {
  instructions: string | null;
  version: string;
}

// The wire contract for the app registry (internal-docs/agent-apps-design.md).
// Defined here rather than in server/app-registry.ts so the route table, the
// registry, and the handler cannot drift.

// AppState + AppWire's canonical home is shared/types.ts (next to AppRecord and
// ServerMessage, which carries AppWire on app_upserted). Re-exported here so
// every route-table / handler / registry import site keeps taking its wire
// shapes from one module, exactly as UserPublicWire does above.
export type { AppListWire, AppState, AppViewerWire, AppWire } from "./types.ts";

// GET /api/apps/:name/logs. Newest last, exactly as journald renders them - the
// caller is a human reading a tail or an agent debugging its own app, and
// re-structuring log lines into fields would only lose what journald already
// formatted.
export interface AppLogsRes {
  name: string;
  lines: string[];
}

// POST /api/apps. The port is NOT here and never will be: allocating it is the
// point of the registry. cwd may use `~/`; the response carries it resolved.
export interface AppRegisterReq {
  name: string;
  command: string;
  cwd: string;
  description?: string;
}

// POST /api/app/message - the app-SELF surface. There is no app field: the token
// says which app is speaking. targetAgentId names any agent the app's live
// owner agent could message; without it the message goes to the configured
// target.
export interface AppMessageReq {
  text: string;
  targetAgentId?: string;
}

// PATCH /api/apps/:name. Any subset of the mutable fields; an absent key
// is a field left alone. `name` and `port` are deliberately NOT here: they are
// the app's address, so a typo in either is fixed by deleting and registering
// again rather than quietly rewritten under whoever already bookmarked it.
//
// The verb exists for the opposite case. A mistyped COMMAND used to be curable
// only by deleting the app, which costs it its data directory and its port - a
// steep price for a missing `run`.
//
// `description` is three-way on purpose: absent leaves it alone, a string sets
// it, and `null` removes it. An empty string is NOT the same as absence - it
// persists as a present, empty value and reads back that way - so without null
// there would be no way to undo a description at all.
export interface AppUpdateReq {
  command?: string;
  cwd?: string;
  description?: string | null;
  messageTargetAgentId?: string;
  createdByAgentId?: string;
}

// The `error.code` values the app routes answer with, as a closed union so the
// registry (which raises them) and the handler (which maps them to statuses)
// cannot drift.
export type AppErrorCode =
  | "invalid_name"
  | "reserved_name"
  | "invalid_command"
  | "invalid_cwd"
  | "invalid_description"
  | "name_taken"
  // The requested name is an ORIGIN some other app already held. Not
  // `name_taken`: no live app has the name, and no app ever will - the label
  // ledger keeps a retired origin spoken for forever, so the address cannot be
  // handed to unrelated code. Permanent, which is why it is not `name_taken`'s
  // "come back after a delete".
  | "origin_retired"
  | "app_limit_reached"
  | "no_port_available"
  // The three server-side failures. Where one of these is the error CODE, the
  // request genuinely failed - none of them is ever dressed up as a success.
  | "registry_corrupt"
  | "persist_failed"
  // The machine refused: systemd could not install, load or control the app's
  // unit. Distinct from the registry failures because the registry is fine -
  // the record exists and the name is spoken for - and the caller's next move
  // is different.
  //
  // One deliberate asymmetry: this code is NOT used when registration commits
  // and the supervisor then fails. That answers 201, because the app really was
  // created, and the same diagnosis rides on the success body as `startError`.
  // The code is for the control routes and delete, where nothing was created
  // and a failure is simply a failure.
  | "supervisor_failed"
  // This host cannot run apps at all (no systemd: macOS). HTTP 501, and every
  // route that would change or run an app answers it before any side effect.
  | "apps_not_supported";

// The wire contract for webhooks (internal-docs/webhooks-design.md section 7).
export type { WebhookWire } from "./types.ts";

// POST /api/webhooks. `target` may be left out by an agent caller: the hook
// then messages that agent. The server generates the secret; there is no field
// for it.
export interface WebhookCreateReq {
  name: string;
  scheme: WebhookScheme;
  signatureHeader?: string | null;
  eventHeader?: string | null;
  deliveryHeader?: string | null;
  rules?: WebhookRule[];
  target?: WebhookTarget;
  enabled?: boolean;
}

// PATCH /api/webhooks/:id. Any subset; the server merges it into the stored
// record and validates the whole result. The scheme is fixed at create: a
// PATCH that names it gets 422.
export interface WebhookUpdateReq {
  name?: string;
  signatureHeader?: string | null;
  eventHeader?: string | null;
  deliveryHeader?: string | null;
  rules?: WebhookRule[];
  target?: WebhookTarget;
  enabled?: boolean;
}

// GET /api/webhooks/:id/deliveries, newest first.
export interface WebhookDeliveriesRes {
  deliveries: WebhookDelivery[];
}

// POST /api/webhooks/:id/dry-run. `event` is the raw event header value;
// `payload` is the JSON object the sender would post.
export interface WebhookDryRunReq {
  event: string;
  payload: unknown;
}

// What a delivery with this event and payload would do. No dispatch, no row.
export type WebhookDryRunRes =
  | { outcome: "ping" | "no_match" }
  | {
      outcome: "match";
      ruleIndex: number;
      args: Record<string, string>;
      block: string;
    };

// The two secret routes. Only a human session reaches them.
export interface WebhookSecretRes {
  secret: string;
}

export type WebhookErrorCode =
  | "invalid_request"
  | "invalid_name"
  | "invalid_scheme"
  | "invalid_headers"
  | "invalid_rules"
  | "invalid_target"
  | "invalid_note"
  // A match path, match value or arg template over the 1000-character bound.
  | "rule_field_too_long"
  // A PATCH that names `scheme`, even with the stored value.
  | "scheme_immutable"
  | "name_taken"
  | "webhook_limit_reached"
  | "secret_missing"
  | "registry_corrupt"
  | "persist_failed";

// The wire contract for the disk-usage breakdown and the manual pruner. Defined
// here rather than in the server modules so the route table and the
// implementation cannot drift: server/storage-usage.ts and
// server/storage-prune.ts import these as their own domain types.

// Stable kebab-case ids - a response key, not an index.
export type StorageCategoryId =
  | "transcripts"
  | "token-logs"
  | "terminal-recordings"
  | "attachments"
  | "session-metadata"
  | "codex-home"
  | "provider-homes"
  | "cronjobs"
  | "memory"
  | "webhooks"
  | "other-state"
  | "backups"
  | "update-snapshots";

export interface StorageCategoryWire {
  id: StorageCategoryId;
  // Where the category lives. null when the location is not configured on this
  // box (e.g. update snapshots off an updater-managed box) AND for every caller
  // who is not the office owner - a member gets sizes, not filesystem layout.
  path: string | null;
  // False when the location does not exist or could not be read. Distinguishes
  // "no backups have run yet" from "the backup dir holds zero bytes", which
  // `bytes: 0` alone cannot.
  available: boolean;
  bytes: number;
  files: number;
}

export interface AgentStorageWire {
  agentId: string;
  transcriptBytes: number;
  attachmentBytes: number;
  sessions: number;
  lastActivityAt: number | null;
}

export interface StorageUsageWire {
  // null for every caller who is not the office owner (see StorageCategoryWire
  // .path - non-owners get sizes only, no filesystem layout).
  stateRoot: string | null;
  measuredAt: number;
  // The in-root categories sum to exactly this; backups and update-snapshots
  // live outside the state root and are extra.
  stateRootBytes: number;
  categories: StorageCategoryWire[];
  // Owner-only; empty for members and agents (it enumerates log dirs for
  // agents in rooms the caller may not see).
  agents: AgentStorageWire[];
}

export interface UsageBucketWire {
  totalIn: number;
  cacheRead: number;
  cacheCreation: number;
  totalOut: number;
  costUSD: number;
}

export interface AgentUsageWire {
  id: string;
  name: string;
  roomId: string;
  roomName: string;
  session: UsageBucketWire;
  lifetime: UsageBucketWire;
}

export interface RoomUsageWire {
  id: string;
  name: string;
  deleted: boolean;
  session: UsageBucketWire;
  lifetime: UsageBucketWire;
}

export interface CronjobUsageWire {
  id: string;
  name: string;
  deleted: boolean;
  lifetime: UsageBucketWire;
}

export interface UsageReportWire {
  scoped: boolean;
  agents: AgentUsageWire[];
  rooms: RoomUsageWire[];
  // Cron jobs have no room projection, so this field exists only for owners.
  cronjobs?: CronjobUsageWire[];
  total: {
    session: UsageBucketWire;
    lifetime: UsageBucketWire;
  };
}

export type PruneTarget =
  | "transcripts"
  | "attachments"
  | "token-logs"
  | "terminal-recordings";

export interface PrunePolicy {
  olderThanDays: number;
  keepPerAgent: number;
}

export interface PruneCandidateWire {
  // RELATIVE to the target root (logs/ or token-logs/), always ("<agentId>/<session>.jsonl",
  // "<agentId>/files/<name>", "<tokenId>.jsonl", "<tokenId>.jsonl.corrupt-<ms>").
  // Never absolute: the apply pass joins it onto the
  // server's target root and rejects anything that escapes, so a candidate
  // cannot name a path outside the fence in the first place.
  path: string;
  bytes: number;
  agentId: string;
  sessionId?: string;
  ageDays: number;
  mtimeMs: number;
}

export type PruneSkipReason =
  | "too-recent"
  | "keep-newest"
  | "active-session"
  | "fork-ancestor"
  // Attachments only: still referenced by a surviving transcript, or still
  // owed to an undelivered queued message. Deleting it would leave a broken
  // file chip in a conversation you can still read, or destroy an attachment
  // before it is ever delivered.
  | "referenced"
  // Attachments only, FAIL-CLOSED: the durable message queue could not be read,
  // so whether these files are still owed is UNKNOWN. Unknown is not empty -
  // everything is spared and an apply is refused.
  | "queue-state-unknown"
  // Terminal recordings only: the terminal session is still recording.
  | "live-recording";

export interface PruneSkipWire {
  reason: PruneSkipReason;
  count: number;
  bytes: number;
}

export interface PrunePlanWire {
  target: PruneTarget;
  policy: PrunePolicy;
  candidates: PruneCandidateWire[];
  bytes: number;
  skipped: PruneSkipWire[];
}

export interface PruneResultWire {
  deleted: number;
  bytes: number;
  refused: { path: string; reason: string }[];
  // Set when the apply was ABANDONED before deleting anything (a candidate
  // escaped the logs root, or the target directory could not be re-read). A
  // malformed plan aborts the whole run rather than deleting the well-formed
  // part of it.
  aborted?: string;
}

export interface StoragePruneReq {
  target: PruneTarget;
  olderThanDays: number;
  keepPerAgent?: number;
  // Absent or false = dry run. The plan comes back either way.
  apply?: boolean;
}

export interface StoragePruneRes {
  plan: PrunePlanWire;
  // null on a dry run - never an empty result, which would read like a prune
  // that found nothing to do.
  applied: PruneResultWire | null;
}

// GET /api/backup/status. The NORMALIZED wire shape - a projection of the
// server's internal BackupStatus, not that type (lastBackupAt→lastRunAt,
// lastBackupOk→ok with null→false, lastBackupError→error, backupDir→destDir;
// `running` is deliberately omitted). Moved here from the handler alongside the
// storage shapes when the storage panel became its first UI consumer: ui/
// imports nothing from server/, and the route table declared this shape inline,
// which is the drift this file exists to stop.
export interface BackupStatusWire {
  lastRunAt: number | null;
  ok: boolean;
  error: string | null;
  retention: number;
  intervalHours: number;
  destDir: string;
  // ISOMUX_BACKUP_DIR sets the folder; the settings cannot change it.
  destDirFromEnv: boolean;
}

// PUT /api/backup/settings. An omitted field keeps its value; dir null resets
// the folder to the default.
export interface BackupSettingsReq {
  intervalHours?: number;
  retention?: number;
  dir?: string | null;
}

export interface BackupSettingsRes extends BackupStatusWire {
  // Set when the save moved the folder: the earlier backups stay here.
  oldBackupsDir: string | null;
}

// POST /api/storage/compress. Gzips old session transcripts in logs/; nothing
// is lost, so there is no keep-newest or fork-ancestor rule. Dry run unless
// apply is true.
export interface StorageCompressReq {
  olderThanDays: number;
  apply?: boolean;
}

export interface CompressCandidateWire {
  // RELATIVE to logs/: "<agentId>/<sessionId>.jsonl".
  path: string;
  bytes: number;
  agentId: string;
  sessionId: string;
  mtimeMs: number;
}

export type CompressSkipReason = "too-recent" | "active-session";

export interface CompressPlanWire {
  olderThanDays: number;
  candidates: CompressCandidateWire[];
  bytes: number;
  skipped: { reason: CompressSkipReason; count: number; bytes: number }[];
}

export interface CompressResultWire {
  compressed: number;
  bytesBefore: number;
  bytesAfter: number;
  refused: { path: string; reason: string }[];
  aborted?: string;
}

export interface StorageCompressRes {
  plan: CompressPlanWire;
  // null on a dry run.
  applied: CompressResultWire | null;
}

// Office app wrapper readiness. A null chat hides all target metadata.
export interface AppWidgetStatus {
  registration: number;
  appUrl: string;
  sessionExpiresAt: number | null;
  chat: { agentId: string; agentName: string; sessionId: string | null } | null;
}

// GET /api/terminal-recordings (task 749cb7fd), newest first.
export interface TerminalRecordingSummaryWire {
  id: string;
  agentId: string;
  // Unix milliseconds.
  startedAt: number;
  startedBy: { kind: string; id: string; name: string };
  bytes: number;
  // Unix milliseconds of the "end" event; absent while live or after a crash.
  endedAt?: number;
  capped?: true;
}

export interface TerminalRecordingsListRes {
  items: TerminalRecordingSummaryWire[];
}
