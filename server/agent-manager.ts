import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo, AgentState, LogEntry } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import { appendLog, loadLog, loadAgents, saveAgents, listAgentSessions, type PersistedAgent } from "./persistence.ts";
import { resolve, join } from "path";
import { homedir } from "os";
import { writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "fs";

// Directory for per-agent launcher scripts
const LAUNCHERS_DIR = join(homedir(), ".isomux", "launchers");
mkdirSync(LAUNCHERS_DIR, { recursive: true });

const CLI_PATH = join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");

// Built-in CLI commands that the SDK doesn't report in slash_commands
const BUILTIN_COMMANDS = ["clear", "compact", "cost", "context", "help", "init", "login", "logout", "memory", "review", "status", "fast"];

// Scan disk for user-defined skills and commands that the SDK doesn't report
function discoverUserSkills(): string[] {
  const skills: string[] = [];
  // Global user skills: ~/.claude/skills/skills/<name>/SKILL.md
  const globalSkillsDir = join(homedir(), ".claude", "skills");
  if (existsSync(globalSkillsDir)) {
    try {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push(entry.name);
      }
    } catch {}
  }
  // Global user commands: ~/.claude/commands/<name>.md
  const globalCmdsDir = join(homedir(), ".claude", "commands");
  if (existsSync(globalCmdsDir)) {
    try {
      for (const entry of readdirSync(globalCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          skills.push(entry.name.replace(/\.md$/, ""));
        }
      }
    } catch {}
  }
  return skills;
}

// Also scan project-level skills for a given cwd
function discoverProjectSkills(cwd: string): string[] {
  const skills: string[] = [];
  // Project commands: <cwd>/.claude/commands/<name>.md
  const projCmdsDir = join(cwd, ".claude", "commands");
  if (existsSync(projCmdsDir)) {
    try {
      for (const entry of readdirSync(projCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          skills.push(entry.name.replace(/\.md$/, ""));
        }
      }
    } catch {}
  }
  return skills;
}

// Create a launcher script that sets cwd and injects system prompt before running the CLI
function createLauncher(agentId: string, cwd: string, agentName: string): string {
  const launcherPath = join(LAUNCHERS_DIR, `${agentId}.mjs`);
  const systemPrompt = `Your name is ${agentName}. When asked who you are, introduce yourself as ${agentName}. You are one of several agents in an isometric office managed by Isomux.`;
  writeFileSync(
    launcherPath,
    `process.chdir(${JSON.stringify(cwd)});\n` +
    `process.argv.push("--append-system-prompt", ${JSON.stringify(systemPrompt)});\n` +
    `await import(${JSON.stringify(CLI_PATH)});\n`
  );
  return launcherPath;
}

// Internal agent state
interface ManagedAgent {
  info: AgentInfo;
  session: ReturnType<typeof unstable_v2_createSession> | null;
  sessionId: string | null;
  streaming: boolean;
  aborting: boolean;
  launcherPath: string;
  slashCommands: string[];
  skills: string[];
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

export function getAgentCommands(agentId: string): { commands: string[]; skills: string[] } {
  const managed = agents.get(agentId);
  return {
    commands: managed?.slashCommands ?? [],
    skills: managed?.skills ?? [],
  };
}

export function listSessions(agentId: string) {
  return listAgentSessions(agentId);
}

export function editAgent(agentId: string, changes: { name?: string; cwd?: string; outfit?: AgentInfo["outfit"] }) {
  const managed = agents.get(agentId);
  if (!managed) return;

  const updated: Partial<AgentInfo> = {};

  if (changes.name && changes.name !== managed.info.name) {
    managed.info.name = changes.name;
    updated.name = changes.name;
  }
  if (changes.cwd && changes.cwd !== managed.info.cwd) {
    managed.info.cwd = resolveCwd(changes.cwd);
    updated.cwd = managed.info.cwd;
  }
  if (changes.outfit) {
    managed.info.outfit = changes.outfit;
    updated.outfit = changes.outfit;
  }

  if (Object.keys(updated).length === 0) return;

  // Regenerate launcher if name or cwd changed (takes effect on next conversation)
  if (updated.name || updated.cwd) {
    managed.launcherPath = createLauncher(agentId, managed.info.cwd, managed.info.name);
  }

  persistAll();
  eventHandler({ type: "agent_updated", agentId, changes: updated });
}

export function swapDesks(deskA: number, deskB: number) {
  if (deskA === deskB || deskA < 0 || deskA > 7 || deskB < 0 || deskB > 7) return;
  const allManaged = [...agents.values()];
  const agentA = allManaged.find((m) => m.info.desk === deskA);
  const agentB = allManaged.find((m) => m.info.desk === deskB);
  if (!agentA && !agentB) return;

  if (agentA) {
    agentA.info.desk = deskB;
    eventHandler({ type: "agent_updated", agentId: agentA.info.id, changes: { desk: deskB } });
  }
  if (agentB) {
    agentB.info.desk = deskA;
    eventHandler({ type: "agent_updated", agentId: agentB.info.id, changes: { desk: deskA } });
  }
  persistAll();
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
    const launcherPath = createLauncher(p.id, p.cwd, p.name);
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
      aborting: false,
      launcherPath,
      slashCommands: [...BUILTIN_COMMANDS],
      skills: [...discoverUserSkills(), ...discoverProjectSkills(p.cwd)],
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
          const hadPreviousSession = !!managed.sessionId;
          // Load prior log history if this session was seen before
          if (!managed.sessionId && sessionId) {
            const history = loadLog(agentId, sessionId);
            if (history.length > 0) {
              for (const entry of history) {
                emit({ type: "log_entry", entry });
              }
            }
          }
          // If we already had a session and got a new init, this is a /clear
          if (hadPreviousSession && sessionId !== managed.sessionId) {
            logCache.set(agentId, []);
            emit({ type: "clear_logs", agentId } as any);
            addLogEntry(agentId, "system", "Conversation cleared.");
          }
          managed.sessionId = sessionId;
          persistAll();
        }
        // Capture available slash commands and skills from init
        const sdkCommands: string[] = (msg as any).slash_commands ?? [];
        const sdkSkills: string[] = (msg as any).skills ?? [];
        // Filter out MCP internal command names (mcp__...) — they clutter autocomplete
        const filteredSdkCommands = sdkCommands.filter((c) => !c.startsWith("mcp__"));
        // Merge built-in, SDK-reported, and user-defined skills
        const userSkills = managed ? [...discoverUserSkills(), ...discoverProjectSkills(managed.info.cwd)] : [];
        const allSkills = [...new Set([...sdkSkills, ...userSkills])];
        const allCommands = [...new Set([...BUILTIN_COMMANDS, ...filteredSdkCommands])];
        if (managed) {
          managed.slashCommands = allCommands;
          managed.skills = allSkills;
        }
        emit({
          type: "slash_commands",
          agentId,
          commands: allCommands,
          skills: allSkills,
        } as any);
      } else if (subtype === "local_command_output") {
        const content = (msg as any).content;
        if (content) {
          addLogEntry(agentId, "system", content);
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

// Consume the stream from an SDK session (one turn at a time)
async function consumeStream(agentId: string, managed: ManagedAgent) {
  if (!managed.session) return;
  managed.streaming = true;
  try {
    for await (const msg of managed.session.stream()) {
      if (!agents.has(agentId) || managed.aborting) break;
      processMessage(agentId, msg);
    }
  } catch (err: any) {
    if (!managed.aborting) {
      console.error(`Agent ${agentId} stream error:`, err.message);
      addLogEntry(agentId, "error", `Stream error: ${err.message}`);
      updateState(agentId, "error");
    }
  } finally {
    managed.streaming = false;
    managed.aborting = false;
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

export async function spawn(name: string, cwd: string, permissionMode: AgentInfo["permissionMode"], desk?: number): Promise<AgentInfo | null> {
  const taken = new Set([...agents.values()].map((a) => a.info.desk));
  if (desk !== undefined && !taken.has(desk)) {
    // Use the requested desk
  } else {
    // Find first free desk
    desk = -1;
    for (let i = 0; i < 8; i++) {
      if (!taken.has(i)) { desk = i; break; }
    }
  }
  if (desk === -1) return null;

  const resolvedCwd = resolveCwd(cwd);
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const launcherPath = createLauncher(id, resolvedCwd, name);

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
    aborting: false,
    launcherPath,
    slashCommands: [...BUILTIN_COMMANDS],
    skills: [...discoverUserSkills(), ...discoverProjectSkills(resolvedCwd)],
  };
  agents.set(id, managed);
  emit({ type: "agent_added", agent: info });
  // Send commands immediately so autocomplete works before SDK init
  emit({
    type: "slash_commands",
    agentId: id,
    commands: managed.slashCommands,
    skills: managed.skills,
  } as any);
  persistAll();

  // Create V2 session
  try {
    managed.session = createSession(managed);
    addLogEntry(id, "system", `Agent "${name}" ready. Working in ${resolvedCwd}. Permission mode: ${permissionMode}.`);
    // Init message (session ID, slash commands) will be consumed on first sendMessage
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

  // Intercept slash commands that are handled locally, not by the LLM
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const handled = await handleSlashCommand(agentId, managed, cmd, args, text);
    if (handled) return;
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

async function handleSlashCommand(agentId: string, managed: ManagedAgent, cmd: string, args: string[], rawText: string): Promise<boolean> {
  switch (cmd) {
    case "clear": {
      addLogEntry(agentId, "user_message", rawText);
      try { managed.session?.close(); } catch {}
      managed.session = createSession(managed);
      managed.sessionId = null;
      managed.streaming = false;
      logCache.set(agentId, []);
      emit({ type: "clear_logs", agentId } as any);
      addLogEntry(agentId, "system", "Conversation cleared.");
      updateState(agentId, "idle");
      persistAll();
      return true;
    }
    case "compact": {
      // Compact is handled by sending it to the agent as a regular message
      // The SDK/CLI handles it internally
      return false;
    }
    case "cost": {
      addLogEntry(agentId, "user_message", rawText);
      addLogEntry(agentId, "system", "Cost tracking is not yet available in Isomux.");
      updateState(agentId, "idle");
      return true;
    }
    case "help": {
      addLogEntry(agentId, "user_message", rawText);
      const commands = managed.slashCommands.map((c) => `  /${c}`).join("\n");
      const skills = managed.skills.length > 0
        ? "\n\nSkills:\n" + managed.skills.map((s) => `  /${s}`).join("\n")
        : "";
      addLogEntry(agentId, "system", `Available commands:\n${commands}${skills}`);
      updateState(agentId, "idle");
      return true;
    }
    default: {
      // Check if it's a user-defined skill
      const skillPrompt = resolveSkillPrompt(cmd, managed.info.cwd);
      if (skillPrompt) {
        const userArgs = args.join(" ");
        const fullPrompt = userArgs
          ? `${skillPrompt}\n\nUser context: ${userArgs}`
          : skillPrompt;
        addLogEntry(agentId, "user_message", rawText);
        updateState(agentId, "thinking");
        try {
          await managed.session!.send(fullPrompt);
          await consumeStream(agentId, managed);
        } catch (err: any) {
          addLogEntry(agentId, "error", `Skill error: ${err.message}`);
          updateState(agentId, "error");
        }
        return true;
      }
      // Not a built-in or skill — pass through to the agent as-is
      return false;
    }
  }
}

// Resolve a skill name to its prompt text, checking user and project skill dirs
function resolveSkillPrompt(name: string, cwd: string): string | null {
  const candidates = [
    join(homedir(), ".claude", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(homedir(), ".claude", "commands", `${name}.md`),
    join(cwd, ".claude", "commands", `${name}.md`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        // Strip YAML frontmatter
        const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
        return stripped.trim();
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function abort(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (!managed.streaming) return; // nothing to abort
  managed.aborting = true;
  const sessionId = managed.sessionId;
  try { managed.session?.close(); } catch {}
  managed.streaming = false;

  try {
    if (sessionId) {
      managed.session = createSession(managed, sessionId);
      managed.sessionId = sessionId;
    } else {
      managed.session = createSession(managed);
    }
    updateState(agentId, "idle");
    addLogEntry(agentId, "system", "Agent interrupted.");
  } catch (err: any) {
    addLogEntry(agentId, "error", `Failed to resume after interrupt: ${err.message}`);
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
