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
  TaskItem,
  Cronjob,
  Attachment,
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
  >
>;

export interface ReviveReq {
  roomId: string;
  desk: number;
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

export interface ShownRoomsReq {
  shown: string[];
}

export interface NotifRoomsReq {
  notifRooms: string[];
}

export interface DefaultRoomReq {
  defaultRoomId: string;
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
