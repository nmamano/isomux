import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo, AgentState, LogEntry } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import { appendLog, loadLog, loadAgents, saveAgents, type PersistedAgent } from "./persistence.ts";
import { resolve, join } from "path";
import { homedir } from "os";
import { writeFileSync, mkdirSync } from "fs";

// Directory for per-agent launcher scripts
const LAUNCHERS_DIR = join(homedir(), ".isomux", "launchers");
mkdirSync(LAUNCHERS_DIR, { recursive: true });

const CLI_PATH = join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");

// Create a launcher script that sets cwd before running the CLI
function createLauncher(agentId: string, cwd: string): string {
  const launcherPath = join(LAUNCHERS_DIR, `${agentId}.mjs`);
  writeFileSync(
    launcherPath,
    `process.chdir(${JSON.stringify(cwd)});\nawait import(${JSON.stringify(CLI_PATH)});\n`
  );
  return launcherPath;
}

// Internal agent state
interface ManagedAgent {
  info: AgentInfo;
  session: ReturnType<typeof unstable_v2_createSession> | null;
  sessionId: string | null;
  streaming: boolean;
  launcherPath: string;
}

type AgentEvent =
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry };

type EventHandler = (event: AgentEvent) => void;

const agents = new Map<string, ManagedAgent>();
const logCache = new Map<string, LogEntry[]>(); // agentId → entries
let eventHandler: EventHandler = () => {};

export function onEvent(handler: EventHandler) {
  eventHandler = handler;
}

// Get cached logs for an agent (used when browser connects after restore)
export function getAgentLogs(agentId: string): LogEntry[] {
  return logCache.get(agentId) ?? [];
}

export function getAllAgents(): AgentInfo[] {
  return [...agents.values()].map((a) => a.info);
}

function persistAll() {
  const persisted: PersistedAgent[] = [...agents.values()].map((a) => ({
    id: a.info.id,
    name: a.info.name,
    desk: a.info.desk,
    cwd: a.info.cwd,
    outfit: a.info.outfit,
    permissionMode: a.info.permissionMode,
    lastSessionId: a.sessionId,
  }));
  saveAgents(persisted);
}

// Restore agents from disk on startup. Creates sessions and loads log history.
export async function restoreAgents() {
  const persisted = loadAgents();
  for (const p of persisted) {
    const launcherPath = createLauncher(p.id, p.cwd);
    const info: AgentInfo = {
      id: p.id,
      name: p.name,
      desk: p.desk,
      cwd: p.cwd,
      outfit: p.outfit,
      permissionMode: p.permissionMode,
      state: "idle",
    };
    const managed: ManagedAgent = {
      info,
      session: null,
      sessionId: p.lastSessionId,
      streaming: false,
      launcherPath,
    };
    agents.set(p.id, managed);

    // Load log history into cache (browsers connect later, so we cache it)
    if (p.lastSessionId) {
      const history = loadLog(p.id, p.lastSessionId);
      if (history.length > 0) {
        logCache.set(p.id, [...history]);
      }
    }

    // Auto-resume session
    try {
      if (p.lastSessionId) {
        managed.session = createSession(managed, p.lastSessionId);
      } else {
        managed.session = createSession(managed);
      }
    } catch (err: any) {
      console.error(`Failed to restore session for ${p.name}:`, err.message);
      managed.info.state = "error";
    }
  }
  return [...agents.values()].map((a) => a.info);
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agents.get(agentId)?.info;
}

function emit(event: AgentEvent) {
  eventHandler(event);
}

function updateState(agentId: string, state: AgentState) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.info = { ...managed.info, state };
  emit({ type: "agent_updated", agentId, changes: { state } });
}

function addLogEntry(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
  };
  // Cache locally
  const cached = logCache.get(agentId) ?? [];
  cached.push(entry);
  logCache.set(agentId, cached);

  emit({ type: "log_entry", entry });

  const managed = agents.get(agentId);
  if (managed?.sessionId) {
    appendLog(agentId, managed.sessionId, entry);
  }
}

// Derive agent state from SDK message
function deriveState(msg: SDKMessage): AgentState | null {
  switch (msg.type) {
    case "assistant": {
      const content = (msg as any).message?.content;
      if (Array.isArray(content) && content.some((b: any) => b.type === "tool_use")) {
        return "tool_executing";
      }
      return "thinking";
    }
    case "tool_progress":
      return "tool_executing";
    case "result":
      return "idle";
    default:
      return null;
  }
}

// Process SDK messages into log entries
function processMessage(agentId: string, msg: SDKMessage) {
  const newState = deriveState(msg);
  if (newState) {
    updateState(agentId, newState);
  }

  switch (msg.type) {
    case "system": {
      const subtype = (msg as any).subtype;
      if (subtype === "init") {
        const sessionId = (msg as any).session_id;
        const managed = agents.get(agentId);
        if (managed && sessionId) {
          // Load prior log history if this session was seen before
          if (!managed.sessionId && sessionId) {
            const history = loadLog(agentId, sessionId);
            if (history.length > 0) {
              for (const entry of history) {
                emit({ type: "log_entry", entry });
              }
            }
          }
          managed.sessionId = sessionId;
          persistAll();
        }
      }
      break;
    }
    case "assistant": {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          addLogEntry(agentId, "text", block.text);
        } else if (block.type === "tool_use") {
          addLogEntry(agentId, "tool_call", block.name, {
            toolId: block.id,
            input: block.input,
          });
        } else if (block.type === "thinking" && block.thinking) {
          addLogEntry(agentId, "thinking", block.thinking);
        }
      }
      break;
    }
    case "user": {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : JSON.stringify(block.content);
          addLogEntry(agentId, "tool_result", resultText.slice(0, 2000), {
            toolUseId: block.tool_use_id,
          });
        }
      }
      break;
    }
    case "result": {
      const subtype = (msg as any).subtype;
      if (subtype !== "success") {
        const errors = (msg as any).errors;
        addLogEntry(agentId, "error", `Agent stopped: ${subtype}. ${errors?.join(", ") || ""}`);
        updateState(agentId, "error");
      }
      break;
    }
  }
}

// Consume the stream from an SDK session
async function consumeStream(agentId: string, managed: ManagedAgent) {
  if (!managed.session || managed.streaming) return;
  managed.streaming = true;
  try {
    for await (const msg of managed.session.stream()) {
      if (!agents.has(agentId)) break;
      processMessage(agentId, msg);
    }
  } catch (err: any) {
    console.error(`Agent ${agentId} stream error:`, err.message);
    addLogEntry(agentId, "error", `Stream error: ${err.message}`);
    updateState(agentId, "error");
  } finally {
    managed.streaming = false;
  }
}

// Resolve ~ in paths
function resolveCwd(cwd: string): string {
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  if (cwd === "~") return homedir();
  return resolve(cwd);
}

function sdkPermissionMode(mode: AgentInfo["permissionMode"]) {
  return mode;
}

function createSession(managed: ManagedAgent, resumeSessionId?: string) {
  const opts: any = {
    model: "claude-opus-4-6",
    permissionMode: sdkPermissionMode(managed.info.permissionMode),
    pathToClaudeCodeExecutable: managed.launcherPath,
  };
  if (resumeSessionId) {
    opts.resume = resumeSessionId;
  }
  return resumeSessionId
    ? unstable_v2_resumeSession(resumeSessionId, opts)
    : unstable_v2_createSession(opts);
}

export async function spawn(name: string, cwd: string, permissionMode: AgentInfo["permissionMode"]): Promise<AgentInfo | null> {
  const taken = new Set([...agents.values()].map((a) => a.info.desk));
  let desk = -1;
  for (let i = 0; i < 8; i++) {
    if (!taken.has(i)) { desk = i; break; }
  }
  if (desk === -1) return null;

  const resolvedCwd = resolveCwd(cwd);
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const launcherPath = createLauncher(id, resolvedCwd);

  const info: AgentInfo = {
    id,
    name,
    desk,
    cwd: resolvedCwd,
    outfit: generateOutfit(name),
    permissionMode,
    state: "idle",
  };

  const managed: ManagedAgent = {
    info,
    session: null,
    sessionId: null,
    streaming: false,
    launcherPath,
  };
  agents.set(id, managed);
  emit({ type: "agent_added", agent: info });
  persistAll();

  // Create V2 session
  try {
    managed.session = createSession(managed);
    addLogEntry(id, "system", `Agent "${name}" ready. Working in ${resolvedCwd}. Permission mode: ${permissionMode}.`);
  } catch (err: any) {
    console.error(`Failed to create session for ${name}:`, err.message);
    addLogEntry(id, "error", `Failed to start: ${err.message}`);
    updateState(id, "error");
  }

  return info;
}

export async function sendMessage(agentId: string, text: string) {
  const managed = agents.get(agentId);
  if (!managed?.session) return;
  if (managed.streaming) {
    addLogEntry(agentId, "error", "Agent is busy. Wait for the current task to finish.");
    return;
  }

  addLogEntry(agentId, "user_message", text);
  updateState(agentId, "thinking");

  try {
    await managed.session.send(text);
    await consumeStream(agentId, managed);
  } catch (err: any) {
    console.error(`Agent ${agentId} send error:`, err.message);
    addLogEntry(agentId, "error", `Error: ${err.message}`);
    updateState(agentId, "error");
  }
}

export async function kill(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  try { managed.session?.close(); } catch {}
  agents.delete(agentId);
  logCache.delete(agentId);
  emit({ type: "agent_removed", agentId });
  persistAll();
}

export async function newConversation(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  try { managed.session?.close(); } catch {}

  try {
    managed.session = createSession(managed);
    managed.sessionId = null;
    managed.streaming = false;
    updateState(agentId, "idle");
    addLogEntry(agentId, "system", "New conversation started.");
    persistAll();
  } catch (err: any) {
    addLogEntry(agentId, "error", `Failed to start new conversation: ${err.message}`);
    updateState(agentId, "error");
  }
}

export async function resume(agentId: string, sessionId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  try { managed.session?.close(); } catch {}

  try {
    managed.session = createSession(managed, sessionId);
    managed.sessionId = sessionId;
    managed.streaming = false;
    updateState(agentId, "idle");
    addLogEntry(agentId, "system", `Resumed session ${sessionId.slice(0, 8)}...`);
    persistAll();
  } catch (err: any) {
    addLogEntry(agentId, "error", `Failed to resume: ${err.message}`);
    updateState(agentId, "error");
  }
}
