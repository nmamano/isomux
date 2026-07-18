// Named request and wire-projection shapes — Phase 2.3.
//
// The contract-first aliases referenced by the typed route table
// (server/routes/table.ts) and the event registry (server/events/registry.ts).
// See internal-docs/generic-runtime-refactor.md → "Named request and wire
// shapes". LEAF over shared/types.ts: type aliases only, zero runtime, no
// validation (schemas are type-level in 2.3; runtime validation lands with
// handler migration in Phase 3). Indexed-access types keep every alias in
// lockstep with the canonical shapes — a field rename in shared/types.ts
// propagates here at compile time.

import type {
  UserRecord,
  AgentInfo,
  AgentBackendType,
  TaskItem,
  Cronjob,
  Attachment,
  MemoryScope,
  MemoryItem,
  OfficeSettings,
} from "./types.ts";

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
  // agent_updated. Missing then -> 400 invalid_version; stale -> 409
  // version_conflict with the current version. Scalar-only edits omit it and
  // stay friction-free.
  customInstructionsVersion?: string;
};

export interface ReviveReq {
  roomId: string;
  desk: number;
}

// Body for agents.setPrivileged (PUT /api/agents/:id/privileged). Deliberately
// its OWN request type, NOT a member of the EditAgentReq Pick — privilege is an
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
  // Optional retry-dedup key for the AGENT (inter-agent) branch — folds into the
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
  // /api/agents/:id/send-now performs. Everywhere else the flag is inert — an
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
  /** http(s) URL of a local/private dev server to screenshot. */
  url: string;
  /** Integers, 320..2560 each. Default 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Best-effort render budget in ms (0..10000), mapped to Chrome's
   * --virtual-time-budget (fast-forwards page timers, not a wall-clock sleep).
   */
  wait?: number;
}

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
// read — a mismatch means the prompt changed under you (409 version_conflict),
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

export interface NotifRoomsReq {
  notifRooms: string[];
}

export interface DefaultRoomReq {
  // A room id sets the default; null clears it ("whichever is first"). Group 7
  // (3d.9b) folded the clear-to-null path here from the retired update_user
  // bridge so a self-user can clear their default once update_user is gone.
  defaultRoomId: string | null;
}

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

export interface InviteMintReq {
  username: string;
  role: UserRecord["role"];
  allowExisting?: boolean;
  // Optional room grants to attach to the invite (member invites for NEW
  // users only — owners reach every room by rule, and an existing user's
  // access is managed on their record). On accept, the created member
  // record's allowedRooms seeds from this list so the invitee doesn't land
  // in an empty office.
  allowedRooms?: string[];
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
  // surface — a mismatch is a 409 version_conflict, mirroring memory REPLACE.
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
}

export interface TaskCreateReq {
  title: string;
  description?: string;
  priority?: TaskItem["priority"];
  assignee?: string;
}

export type TaskUpdateReq = Partial<{
  title: string;
  description: string;
  priority: TaskItem["priority"];
  status: TaskItem["status"];
  assignee: string;
}>;

// isomux-memory: APPEND a durable fact (the safe default). scope/scopeId select
// the TARGET file; author + date are server-stamped (never from the body).
export interface MemoryCreateReq {
  scope: MemoryScope;
  scopeId?: string | null;
  text: string;
}

// isomux-memory: REPLACE the whole file (edit/retract). `version` is the token
// from the preceding READ — a mismatch means the file changed under you (409).
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
