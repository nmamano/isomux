// Named request and wire-projection shapes - Phase 2.3.
//
// The contract-first aliases referenced by the typed route table
// (server/routes/table.ts) and the event registry (server/events/registry.ts).
// See internal-docs/generic-runtime-refactor.md → "Named request and wire
// shapes". LEAF over shared/types.ts: type aliases only, zero runtime, no
// validation (schemas are type-level in 2.3; runtime validation lands with
// handler migration in Phase 3). Indexed-access types keep every alias in
// lockstep with the canonical shapes - a field rename in shared/types.ts
// propagates here at compile time.

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
  SlideRecord,
} from "./types.ts";
import type { SupportedLanguageCode } from "./languages.ts";

// --- Wire projections (response / event shapes) -----------------------------

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
  externalAccess: boolean;
  publicOrigin: string | null;
  envOriginSet: boolean;
  envOrigin: string | null;
  boundLoopback: boolean;
}

// --- Request bodies ---------------------------------------------------------
// Indexed-access into the canonical types wherever a field mirrors AgentInfo /
// TaskItem / Cronjob, so the request alias and the entity stay in lockstep.

export interface SpawnReq {
  name: string;
  cwd: string;
  roomId: string;
  desk: number;
  permissionMode?: AgentInfo["permissionMode"];
  customInstructions?: string;
  outfit?: AgentInfo["outfit"];
  modelFamily?: string;
  effort?: AgentInfo["effort"];
  agentType?: AgentInfo["agentType"];
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
    // Changing the engine starts a fresh conversation on the new engine (the old
    // one is preserved in the resume history). Model/effort/permission sent in
    // the same edit are validated against the NEW engine and applied; omitted
    // ones reset to the new engine's defaults (cross-engine values don't
    // carry). A modelFamily that cannot belong to the target engine is
    // rejected with 422 invalid_model_family rather than silently coerced.
    | "agentType"
  >
> & {
  // REQUIRED iff customInstructions is present in the body (task 44a2c98d):
  // echo back AgentInfo.customInstructionsVersion as read off full_state /
  // agent_updated (UI) or GET /api/agents/:id/instructions
  // (agents.readInstructions, task 68891fa1 - the agent-facing read). Missing
  // then -> 400 invalid_version; stale -> 409 version_conflict with the
  // current version. Scalar-only edits omit it and stay friction-free.
  customInstructionsVersion?: string;
};

export interface ReviveReq {
  roomId: string;
  desk: number;
}

// Body for agents.setPrivileged (PUT /api/agents/:id/privileged). Deliberately
// its OWN request type, NOT a member of the EditAgentReq Pick - privilege is an
// owner-administrative mutation gated to scope==="user" (mirrors users.setAccess
// vs users.update), so it must never ride the agent:manage edit path where a
// privileged agent could reach it.
export interface SetPrivilegedReq {
  privileged: boolean;
}

export interface MoveAgentReq {
  targetRoomId: string;
}

export interface SwapDesksReq {
  deskA: number;
  deskB: number;
}

export interface SendMessageReq {
  text: string;
  device?: string;
  attachments?: Attachment[];
  // Optional legacy input. Sender authority is ALWAYS the token; rejected if
  // present and ≠ token.agentId, ignored otherwise (see guards.senderMustEqualTokenAgent).
  senderAgentId?: string;
  // Optional retry-dedup key for the AGENT (inter-agent) branch - folds into the
  // manager's queue dedupe, the same field the retired POST /agents/:id/message
  // accepted. The UI (USER branch) omits it. When deliverAt is present it doubles
  // as the scheduled-message idempotency key (persisted, so it survives restarts).
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
  // their existing paths. Present on an AGENT-scope call → 400 (agents call
  // the explicit /send-now endpoint instead).
  sendNow?: boolean;
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
// itself (task 8883e45d).
export interface HandoffReq {
  text: string;
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
  /** This session was forked off another one. */
  forked?: true;
  /** Another session was forked off this one. */
  branched?: true;
}

export interface LogSessionIndexResp {
  agentId: string;
  sessions: LogSessionIndexEntry[];
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
}

export type LogsResp = LogSessionIndexResp | LogSearchResp | LogRetrieveResp;

/**
 * GET /api/agents/:id/slides - the current conversation's slide map for the
 * initial deck render. `sessionId` is the conversation's root session id (null
 * when the agent has no live session); `slides` is keyed by turn entry id.
 */
export interface SlideDeckRes {
  sessionId: string | null;
  slides: Record<string, SlideRecord>;
}

/**
 * POST /api/agents/:id/slides/:entryId - "ensure slide". Returns a cached slide
 * immediately, else starts generation and returns pending. `force` regenerates
 * even when cached; `feedback` is a one-shot instruction for that regeneration.
 */
export interface EnsureSlideReq {
  force?: boolean;
  feedback?: string;
}

export type EnsureSlideRes =
  | { status: "ready"; slide: SlideRecord }
  | { status: "pending" }
  | { status: "unavailable" };

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
}

export interface RoomRenameReq {
  name: string;
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
}

export interface ViewOrderReq {
  order: string[];
}

// view.setShown: the FULL list of accessible rooms the caller wants displayed;
// hidden becomes accessible minus this (clamped server-side). Removed as
// callerless in the Phase 4 close-out, restored by task 9301d0f4 alongside the
// hide-rooms UI on the Users page.
export interface ShownRoomsReq {
  shown: string[];
}

// view.listRooms (GET /api/me/rooms) - task 9301d0f4. Minimal reference to a
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

// prefs.update (PATCH /api/me/preferences) - task 49d4e2f6. SELF-only personal
// preferences, deliberately NOT on the selfOrOwner users.update route: the
// Option A split keeps an owner out of a member's personal settings. A Partial
// so a caller can set one field without restating the other; `language: null`
// is a meaningful value (clears the pick), so absent and null differ here.
export type PreferencesReq = Partial<{
  language: SupportedLanguageCode | null;
  slideMode: boolean;
}>;

// The writable preference keys, as VALUES, so the handler can reject an unknown
// key (a typo like `langauge` would otherwise be a successful no-op) without a
// second hand-maintained list drifting from the type above.
export const PREFERENCE_KEYS = ["language", "slideMode"] as const;

export type UserUpdateReq = Partial<{
  name: string;
  envFile: string | null;
  memberPrompt: string | null;
  avatarColor: string;
  avatarVariant: UserRecord["avatarVariant"];
}>;

export interface SetAccessReq {
  allowedRooms: string[];
}

// Owner-minted invites create NEW users only (task eb3354e6 revision): an
// existing username is rejected server-side (409). Device links for existing
// accounts ride POST /api/invites/self - or, when the user is locked out of
// every device, the owner recovery op below.
export interface InviteMintReq {
  username: string;
  role: UserRecord["role"];
  // Optional room grants to attach to the invite (member invites for NEW
  // users only - owners reach every room by rule, and an existing user's
  // access is managed on their record). On accept, the created member
  // record's allowedRooms seeds from this list so the invitee doesn't land
  // in an empty office.
  allowedRooms?: string[];
}

// invites.mintRecovery (POST /api/invites/recovery) - owner-only recovery for
// an EXISTING user (task eb3354e6 final revision): device links are normally
// self-service, but a user signed out of every device can't mint one. Target
// is the stable userId; the server derives name/role from the record and
// fixes TTL/replacement policy - no other knobs on the wire.
export interface RecoveryMintReq {
  userId: string;
}

export interface AccessSettingsReq {
  externalAccess: boolean;
  publicOrigin: string;
}

export interface OfficeSettingsReq {
  prompt: string | null;
  envFile: string | null;
  // Optional: omitted preserves the current office name (a stale client tab),
  // explicit null/empty clears it, a string sets it. The handler keys on the
  // undefined-vs-null distinction, so null must be representable in the contract.
  name?: string | null;
  // Token from a preceding office.getSettings read. The PUT replaces the whole
  // settings blob (prompt/envFile/name), so ONE version guards the whole clobber
  // surface - a mismatch is a 409 version_conflict, mirroring memory REPLACE.
  version: string;
}

// office.getSettings response: the full settings + their optimistic-concurrency
// version (sha over the canonical [prompt, envFile, name] serialization).
export type OfficeSettingsRes = OfficeSettings & { version: string };

export interface ValidateCwdReq {
  cwd: string;
}

export interface ValidateEnvReq {
  scope: "office" | "user";
  username?: string;
  // When present, validate THIS path instead of the subject's STORED envFile -
  // lets the settings UI check a typed-but-unsaved path on blur. Only valid
  // with scope:"user" (rejected otherwise), and must be non-blank when
  // provided (a blank path must not silently fall back to the stored env).
  // Authorization is unchanged (validateEnvBodySelfSubject on scope/username):
  // the subject user could save the same path via users.update and then
  // validate it stored, so an explicit path exposes no information the caller
  // couldn't already reach - it only makes the probe non-mutating.
  path?: string;
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

export type TaskUpdateReq = Partial<{
  title: string;
  description: string;
  // Absent === leave the priority unchanged; an explicit null clears it back to
  // no-priority. Any other value must be a real level (P0-P3).
  priority: TaskItem["priority"] | null;
  status: TaskItem["status"];
  assignee: string;
  // Re-room the task (mirrors TaskCreateReq.roomId). Absent === leave the room
  // unchanged; an explicit empty string === clear to office-global; a non-empty
  // id moves it to that room, subject to the caller's room access.
  roomId: string;
}>;

// isomux-memory: APPEND a durable fact (the safe default). scope/scopeId select
// the TARGET file; author + date are server-stamped (never from the body).
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

// READ response: the verbatim file text + its optimistic-concurrency version.
export interface MemoryReadRes {
  text: string;
  version: string;
}

// APPEND response: the new line + the post-write version.
export interface MemoryAppendRes {
  item: MemoryItem;
  version: string;
}

// REPLACE response: the post-write version (or, on 409, the current version in
// the error detail).
export interface MemoryWriteRes {
  version: string;
}

export interface TaskClaimReq {
  assignee?: string;
}

// skills.usageCounts response: the CALLING user's per-skill use counters
// (skill name -> count; skills never used are absent). Drives the Sk-menu
// sort order (task f1769b1a).
export interface SkillUsageCountsRes {
  counts: Record<string, number>;
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
}

export type CronUpdateReq = Partial<{
  name: string;
  schedule: Cronjob["schedule"];
  prompt: string;
  cwd: string;
  modelFamily: Cronjob["modelFamily"];
  effort: Cronjob["effort"];
  permissionMode: Cronjob["permissionMode"];
  codexSandbox: Cronjob["codexSandbox"];
  enabled: boolean;
}>;

export interface CronRunMessageReq {
  text: string;
  device?: string;
}

// Cronjobs-prompt write body (cron.setPrompt). Inline `{ value }` in the spec.
export interface CronPromptReq {
  value: string | null;
}

// --- Storage retention (task 2366ccb0) --------------------------------------
// The wire contract for the disk-usage breakdown and the manual pruner. Defined
// here rather than in the server modules so the route table and the
// implementation cannot drift: server/storage-usage.ts and
// server/storage-prune.ts import these as their own domain types.

// Stable kebab-case ids - a response key, not an index.
export type StorageCategoryId =
  | "transcripts"
  | "attachments"
  | "session-metadata"
  | "codex-home"
  | "cronjobs"
  | "memory"
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

export type PruneTarget = "transcripts" | "attachments";

export interface PrunePolicy {
  olderThanDays: number;
  keepPerAgent: number;
}

export interface PruneCandidateWire {
  // RELATIVE to the logs dir, always ("<agentId>/<session>.jsonl",
  // "<agentId>/files/<name>"). Never absolute: the apply pass joins it onto the
  // server's own logs root and rejects anything that escapes, so a candidate
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
  | "queue-state-unknown";

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
  destDir: string;
}
