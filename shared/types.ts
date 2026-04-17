// Agent states derived from SDK stream events
export type AgentState =
  | "idle"
  | "thinking"
  | "tool_executing"
  | "waiting_for_response"
  | "error"
  | "stopped";

// Deterministic outfit from name hash
export interface AgentOutfit {
  hat: "none" | "cap" | "beanie" | "bow" | "headband";
  color: string; // shirt color hex
  hair: string; // hair color hex
  hairStyle: "short" | "long" | "ponytail" | "bun" | "pigtails" | "curly" | "bald";
  skin: string; // skin color hex
  beard: "none" | "stubble" | "full" | "goatee" | "mustache";
  accessory: "glasses" | "headphones" | "bow_tie" | "tie" | "earrings" | null;
}

// Model families — what users pick ("I want Opus"). Exact versions are an
// implementation detail that the system bumps centrally in FAMILY_TO_MODEL.
export type ModelFamily = "opus" | "sonnet" | "haiku";

export type ClaudeModel = string;

export const FAMILY_TO_MODEL: Record<ModelFamily, ClaudeModel> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export const MODEL_FAMILIES: { family: ModelFamily; label: string }[] = [
  { family: "opus", label: "Opus" },
  { family: "sonnet", label: "Sonnet" },
  { family: "haiku", label: "Haiku" },
];

// Extract "4.7" from "claude-opus-4-7" for display
export function modelVersionLabel(family: ModelFamily): string {
  const exact = FAMILY_TO_MODEL[family];
  const match = exact.match(/-(\d+)-(\d+)/);
  return match ? `${match[1]}.${match[2]}` : exact;
}

// "Opus 4.7"
export function familyDisplayLabel(family: ModelFamily): string {
  const base = MODEL_FAMILIES.find((m) => m.family === family)?.label ?? family;
  return `${base} ${modelVersionLabel(family)}`;
}

// Migrate a legacy exact model ID (e.g. "claude-opus-4-6") to a family.
export function familyFromLegacyModel(model: string | undefined): ModelFamily {
  if (!model) return "opus";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "opus";
}

// What the browser knows about an agent
export interface AgentInfo {
  id: string;
  name: string;
  desk: number; // 0-7
  room: number; // 0-based room index
  cwd: string;
  outfit: AgentOutfit;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  modelFamily: ModelFamily;
  state: AgentState;
  topic: string | null;
  topicStale: boolean;
  customInstructions: string | null;
}

// File attachment metadata
export interface Attachment {
  filename: string;      // on-disk hash name: "a1b2c3.png"
  originalName: string;  // user-facing: "photo.png"
  mediaType: string;     // "image/png", "application/pdf", etc.
  size: number;          // bytes
}

// Log entry in the conversation view
export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: number;
  kind: "text" | "thinking" | "tool_call" | "tool_result" | "error" | "system" | "user_message";
  content: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[]; // file attachments, served via /api/files/<agentId>/<filename>
}

// Task item (replaces todos)
export type TaskStatus = "open" | "in_progress" | "done";
export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export interface TaskItem {
  id: string;           // 8-char hex hash
  title: string;
  description?: string;
  priority?: TaskPriority;
  status: TaskStatus;
  assignee?: string;
  createdBy: string;
  createdAt: number;
}

// Generate a unique 8-char hex ID, avoiding collisions with `existing`.
function generateHexId(existing?: string[]): string {
  const ids = existing ? new Set(existing) : undefined;
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!ids || !ids.has(id)) return id;
  }
}

export function generateTaskId(existing?: string[]): string {
  return generateHexId(existing);
}

const VALID_STATUSES = new Set<TaskStatus>(["open", "in_progress", "done"]);
const VALID_PRIORITIES = new Set<TaskPriority>(["P0", "P1", "P2", "P3"]);

export function isValidStatus(s: unknown): s is TaskStatus {
  return typeof s === "string" && VALID_STATUSES.has(s as TaskStatus);
}

export function isValidPriority(p: unknown): p is TaskPriority {
  return typeof p === "string" && VALID_PRIORITIES.has(p as TaskPriority);
}

// Session info for resume feature
export interface SessionInfo {
  sessionId: string;
  lastModified: number;
  topic: string | null;
  branched?: boolean;      // true if another session was forked from this one
  forked?: boolean;        // true if this session is a fork (was created by editing a message)
}

// Skill metadata for autocomplete and /help
export type SkillOrigin = "user" | "project" | "plugin" | "isomux" | "claude";
export interface SkillInfo {
  name: string;
  origin: SkillOrigin;
  description?: string;
}

// Office-level settings (prompt + optional env file path)
export interface OfficeSettings {
  prompt: string;
  envFile: string | null;
}

// A room with stable ID, display name, and per-room config
export interface RoomWire {
  id: string;               // 8-char hex, stable
  name: string;             // display name
  prompt: string | null;
  envFile: string | null;
}

// Response to update_*_settings (sent only to the requesting client)
export interface SettingsSaveResponse {
  type: "settings_save_response";
  requestId: string;
  ok: boolean;
  keyCount?: number;
  error?: string;
}

// Response to request_settings_validation (sent only to the requesting client)
export interface SettingsValidationResponse {
  type: "settings_validation";
  requestId: string;
  scope: "office" | "room";
  roomId?: string;
  envFile: string | null;
  ok: boolean;
  keyCount?: number;
  error?: string;
}

// Server → Browser messages
export type ServerMessage =
  | { type: "full_state"; agents: AgentInfo[]; recentCwds: string[]; office: OfficeSettings; rooms: RoomWire[] }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "sessions_list"; agentId: string; sessions: SessionInfo[]; currentSessionId: string | null }
  | { type: "slash_commands"; agentId: string; commands: { name: string; description?: string }[]; skills: SkillInfo[] }
  | { type: "clear_logs"; agentId: string }
  | { type: "terminal_output"; agentId: string; data: string }
  | { type: "terminal_exit"; agentId: string; exitCode: number }
  | { type: "office_settings_updated"; prompt: string; envFile: string | null }
  | { type: "tasks"; tasks: TaskItem[] }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null; envFile: string | null }
  | { type: "rooms_reordered"; order: string[] }
  | SettingsSaveResponse
  | SettingsValidationResponse
  | { type: "update_status"; updateAvailable: boolean; current: { sha: string; message: string; date: string }; latest: { sha: string; message: string; date: string } };

// Browser → Server commands
export type ClientCommand =
  | { type: "spawn"; name: string; cwd: string; permissionMode: AgentInfo["permissionMode"]; desk: number; roomId?: string; customInstructions?: string; outfit?: AgentOutfit; modelFamily?: ModelFamily }
  | { type: "kill"; agentId: string }
  | { type: "abort"; agentId: string }
  | { type: "send_message"; agentId: string; text: string; username?: string; attachments?: Attachment[] }
  | { type: "new_conversation"; agentId: string }
  | { type: "resume"; agentId: string; sessionId: string }
  | { type: "list_sessions"; agentId: string }
  | { type: "edit_agent"; agentId: string; name?: string; cwd?: string; outfit?: AgentOutfit; customInstructions?: string; modelFamily?: ModelFamily }
  | { type: "swap_desks"; deskA: number; deskB: number; roomId: string }
  | { type: "set_topic"; agentId: string; topic: string }
  | { type: "reset_topic"; agentId: string }
  | { type: "terminal_open"; agentId: string }
  | { type: "terminal_input"; agentId: string; data: string }
  | { type: "terminal_resize"; agentId: string; cols: number; rows: number }
  | { type: "terminal_close"; agentId: string }
  | { type: "update_office_settings"; requestId: string; prompt: string; envFile: string | null }
  | { type: "update_room_settings"; requestId: string; roomId: string; prompt: string | null; envFile: string | null }
  | { type: "request_settings_validation"; requestId: string; scope: "office" | "room"; roomId?: string }
  | { type: "add_task"; title: string; description?: string; priority?: TaskPriority; assignee?: string; username: string }
  | { type: "update_task"; id: string; changes: Partial<Pick<TaskItem, "title" | "description" | "priority" | "status" | "assignee">> }
  | { type: "delete_task"; id: string }
  | { type: "create_room"; name?: string }
  | { type: "close_room"; roomId: string }
  | { type: "rename_room"; roomId: string; name: string }
  | { type: "move_agent"; agentId: string; targetRoomId: string }
  | { type: "reorder_rooms"; order: string[] }
  | { type: "edit_message"; agentId: string; logEntryId: string; newText: string; username?: string };

// Generate a stable 8-char hex room ID (used at room creation and during migration)
export function generateRoomId(existing?: string[]): string {
  return generateHexId(existing);
}
