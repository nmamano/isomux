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
  MemoryFactType,
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
    // one is preserved in the resume history). Cross-engine model/effort/
    // permission don't carry, so the server resets them to the new engine's
    // defaults and ignores any model/effort/permission sent in the same edit.
    | "agentType"
  >
>;

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
  // accepted. The UI (USER branch) omits it.
  clientMessageId?: string;
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

export interface EditorSaveReq {
  path: string;
  content: string;
  expectedMtime: number;
  force?: boolean;
}

export interface RoomCreateReq {
  name?: string;
}

export interface RoomRenameReq {
  name: string;
}

export interface RoomSettingsReq {
  prompt: string | null;
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
  // Raw office memory markdown (slice 3g). OMITTED = leave office.md untouched
  // (the client only sends it once the raw load has succeeded, so an unrelated
  // prompt/env save can't wipe memory). A string (incl "") rewrites office.md:
  // existing mem:ID lines keep id+provenance, id-less lines are stamped, removed
  // lines drop. Only applied after the prompt/env/name validation passes.
  memory?: string | null;
}

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

// isomux-memory: append a durable fact. scope/scopeId select the TARGET file;
// author + date + id are server-assigned (never from the body).
export interface MemoryCreateReq {
  scope: MemoryScope;
  scopeId?: string | null;
  factType: MemoryFactType;
  text: string;
}

// isomux-memory: edit a fact by id (append-only supersede). The target file is
// EXPLICIT — scope + scopeId (no omitted defaults, unlike create). DELETE takes
// the same target via query params and no body.
export interface MemoryUpdateReq {
  scope: MemoryScope;
  scopeId?: string | null;
  text: string;
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
