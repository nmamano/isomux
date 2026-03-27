// Agent states derived from SDK stream events
export type AgentState =
  | "idle"
  | "starting"
  | "thinking"
  | "tool_executing"
  | "waiting_permission"
  | "error"
  | "stopped";

// Deterministic outfit from name hash
export interface AgentOutfit {
  hat: "none" | "cap" | "beanie";
  color: string; // shirt color hex
  hair: string; // hair color hex
  accessory: "glasses" | "headphones" | null;
}

// What the browser knows about an agent
export interface AgentInfo {
  id: string;
  name: string;
  desk: number; // 0-7
  cwd: string;
  outfit: AgentOutfit;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  state: AgentState;
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

// Server → Browser messages
export type ServerMessage =
  | { type: "full_state"; agents: AgentInfo[] }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry };

// Browser → Server commands
export type ClientCommand =
  | { type: "spawn"; name: string; cwd: string; permissionMode: AgentInfo["permissionMode"] }
  | { type: "kill"; agentId: string }
  | { type: "send_message"; agentId: string; text: string }
  | { type: "new_conversation"; agentId: string }
  | { type: "resume"; agentId: string; sessionId: string };
