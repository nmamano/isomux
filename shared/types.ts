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
  hairStyle: "short" | "long" | "ponytail" | "bun" | "pigtails" | "curly";
  skin: string; // skin color hex
  beard: "none" | "stubble" | "full" | "goatee";
  accessory: "glasses" | "headphones" | "bow_tie" | "earrings" | null;
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
  state: AgentState;
  topic: string | null;
  topicStale: boolean;
  customInstructions: string | null;
}

// Log entry in the conversation view
export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: number;
  kind: "text" | "thinking" | "tool_call" | "tool_result" | "error" | "system" | "user_message";
  content: string;
  metadata?: Record<string, unknown>;
}

// Todo item
export interface TodoItem {
  id: string;
  text: string;
  createdBy: string;
  createdAt: number;
}

// Session info for resume feature
export interface SessionInfo {
  sessionId: string;
  lastModified: number;
  topic: string | null;
}

// Skill metadata for autocomplete and /help
export type SkillOrigin = "user" | "project" | "plugin" | "isomux" | "claude";
export interface SkillInfo {
  name: string;
  origin: SkillOrigin;
}

// Server → Browser messages
export type ServerMessage =
  | { type: "full_state"; agents: AgentInfo[]; recentCwds: string[]; roomCount: number }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "sessions_list"; agentId: string; sessions: SessionInfo[]; currentSessionId: string | null }
  | { type: "slash_commands"; agentId: string; commands: string[]; skills: SkillInfo[] }
  | { type: "clear_logs"; agentId: string }
  | { type: "terminal_output"; agentId: string; data: string }
  | { type: "terminal_exit"; agentId: string; exitCode: number }
  | { type: "office_prompt"; text: string }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "room_created"; roomCount: number }
  | { type: "room_closed"; room: number; roomCount: number };

// Browser → Server commands
export type ClientCommand =
  | { type: "spawn"; name: string; cwd: string; permissionMode: AgentInfo["permissionMode"]; desk: number; room?: number; customInstructions?: string; outfit?: AgentOutfit }
  | { type: "kill"; agentId: string }
  | { type: "abort"; agentId: string }
  | { type: "send_message"; agentId: string; text: string; username?: string }
  | { type: "new_conversation"; agentId: string }
  | { type: "resume"; agentId: string; sessionId: string }
  | { type: "list_sessions"; agentId: string }
  | { type: "edit_agent"; agentId: string; name?: string; cwd?: string; outfit?: AgentOutfit; customInstructions?: string }
  | { type: "swap_desks"; deskA: number; deskB: number; room: number }
  | { type: "set_topic"; agentId: string; topic: string }
  | { type: "reset_topic"; agentId: string }
  | { type: "terminal_open"; agentId: string }
  | { type: "terminal_input"; agentId: string; data: string }
  | { type: "terminal_resize"; agentId: string; cols: number; rows: number }
  | { type: "terminal_close"; agentId: string }
  | { type: "set_office_prompt"; text: string }
  | { type: "add_todo"; text: string; username: string }
  | { type: "delete_todo"; id: string }
  | { type: "create_room" }
  | { type: "close_room"; room: number }
  | { type: "move_agent"; agentId: string; targetRoom: number };
