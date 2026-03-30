import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo, AgentState, LogEntry } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import { appendLog, loadLog, loadAgents, saveAgents, listAgentSessions, writeManifest, persistSessionTopic, loadOfficePrompt, saveOfficePrompt, type PersistedAgent } from "./persistence.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import { resolve, join } from "path";
import { homedir } from "os";
import { writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync, rmSync } from "fs";

// Directory for per-agent launcher scripts
const LAUNCHERS_DIR = join(homedir(), ".isomux", "launchers");

// Skills bundled with isomux itself (available to all users regardless of their config)
const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "skills");
mkdirSync(LAUNCHERS_DIR, { recursive: true });

const CLI_PATH = join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");

// Built-in CLI commands that the SDK doesn't report in slash_commands
const BUILTIN_COMMANDS = ["clear", "compact", "cost", "context", "help", "init", "login", "logout", "memory", "resume", "review", "status", "fast"];

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

// Scan skills bundled with isomux
function discoverBundledSkills(): string[] {
  const skills: string[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push(entry.name);
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
function createLauncher(agentId: string, cwd: string, agentName: string, officePrompt?: string, customInstructions?: string | null): string {
  const launcherPath = join(LAUNCHERS_DIR, `${agentId}.mjs`);
  let systemPrompt = `You are ${agentName}, one of the agents in the Isomux office. Your goal is to help the office bosses, who talk to you in this chat. Messages are prefixed with the sender's name in brackets.\n\nTo discover other office agents and their conversation logs, read ~/.isomux/agents-summary.json.`;
  if (officePrompt) {
    systemPrompt += `\n\n${officePrompt}`;
  }
  if (customInstructions) {
    systemPrompt += `\n\n${customInstructions}`;
  }
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
  // Timing: track when phases start for duration_ms computation
  thinkingStartedAt: number;
  toolCallTimestamps: Map<string, number>; // toolUseId → start timestamp
  // Topic generation
  topicGenerating: boolean;
  topicMessageCount: number; // text entry count when topic was last generated
  // /resume two-step state
  pendingResume: boolean;
  pendingResumeSessions: { sessionId: string; lastModified: number; topic: string | null }[];
  // Terminal PTY sidecar (spawned on demand via Node.js)
  ptySidecar: import("bun").Subprocess | null;
  ptyBuffer: string; // buffered output for reconnecting browsers
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
let officePrompt: string = loadOfficePrompt();

export function getOfficePrompt(): string {
  return officePrompt;
}

export function setOfficePrompt(text: string) {
  officePrompt = text.trim();
  saveOfficePrompt(officePrompt);
}

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

export function getCurrentSessionId(agentId: string): string | null {
  return agents.get(agentId)?.sessionId ?? null;
}

export function editAgent(agentId: string, changes: { name?: string; cwd?: string; outfit?: AgentInfo["outfit"]; customInstructions?: string }) {
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
  if (changes.customInstructions !== undefined && changes.customInstructions !== managed.info.customInstructions) {
    managed.info.customInstructions = changes.customInstructions || null;
    updated.customInstructions = managed.info.customInstructions;
  }

  if (Object.keys(updated).length === 0) return;

  // Regenerate launcher if name, cwd, or customInstructions changed (takes effect on next conversation)
  if (updated.name !== undefined || updated.cwd !== undefined || updated.customInstructions !== undefined) {
    managed.launcherPath = createLauncher(agentId, managed.info.cwd, managed.info.name, officePrompt, managed.info.customInstructions);
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

function updateManifest() {
  writeManifest([...agents.values()].map((a) => ({
    id: a.info.id,
    name: a.info.name,
    desk: a.info.desk,
    topic: a.info.topic,
    cwd: a.info.cwd,
  })));
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
    topic: a.info.topic,
    customInstructions: a.info.customInstructions,
  }));
  saveAgents(persisted);
  updateManifest();
}

// Restore agents from disk on startup. Creates sessions and loads log history.
export async function restoreAgents() {
  // Wipe stale launchers from previous runs — they're fully regenerated below
  rmSync(LAUNCHERS_DIR, { recursive: true, force: true });
  mkdirSync(LAUNCHERS_DIR, { recursive: true });

  const persisted = loadAgents();
  for (const p of persisted) {
    const launcherPath = createLauncher(p.id, p.cwd, p.name, officePrompt, p.customInstructions);
    const info: AgentInfo = {
      id: p.id,
      name: p.name,
      desk: p.desk,
      cwd: p.cwd,
      outfit: p.outfit,
      permissionMode: p.permissionMode,
      state: p.lastSessionId ? "waiting_for_response" : "idle",
      topic: p.topic ?? null,
      topicStale: false,
      customInstructions: p.customInstructions ?? null,
    };
    const managed: ManagedAgent = {
      info,
      session: null,
      sessionId: p.lastSessionId,
      streaming: false,
      aborting: false,
      launcherPath,
      slashCommands: [...BUILTIN_COMMANDS],
      skills: [...discoverBundledSkills(), ...discoverUserSkills(), ...discoverProjectSkills(p.cwd)],
      thinkingStartedAt: 0,
      toolCallTimestamps: new Map(),
      topicGenerating: false,
      topicMessageCount: 0,
      pendingResume: false,
      pendingResumeSessions: [],
      ptySidecar: null,
      ptyBuffer: "",
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
  if (state === "thinking" && managed.info.state !== "thinking") {
    managed.thinkingStartedAt = Date.now();
  }
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

  // Track topicStale: new text entries after topic was generated
  if ((kind === "text" || kind === "user_message") && managed && managed.info.topic !== null && managed.info.topic !== "...") {
    const textCount = (logCache.get(agentId) ?? []).filter(e => e.kind === "user_message" || e.kind === "text").length;
    if (textCount > managed.topicMessageCount) {
      managed.info.topicStale = true;
      emit({ type: "agent_updated", agentId, changes: { topicStale: true } });
    }
  }
}

// Emit a log entry to the UI only (not persisted to disk) — for ephemeral messages like /resume.
// Note: entries are still added to logCache for UI display. If sessionId is null when this is
// called, the backfill logic in processMessage (system/init) would write them to disk. In practice
// this doesn't happen because /resume requires existing sessions (sessionId already set).
function emitEphemeralLog(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
  };
  const cached = logCache.get(agentId) ?? [];
  cached.push(entry);
  logCache.set(agentId, cached);
  emit({ type: "log_entry", entry });
}

// Generate a short topic description for an agent's conversation
async function generateTopic(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed || managed.topicGenerating) return;

  managed.topicGenerating = true;
  managed.info.topic = "...";
  managed.info.topicStale = false;
  emit({ type: "agent_updated", agentId, changes: { topic: "...", topicStale: false } });

  // Build context: first user message + last 5 text entries
  const logs = logCache.get(agentId) ?? [];
  const textEntries = logs.filter(e => e.kind === "user_message" || e.kind === "text");
  const firstUserMsg = textEntries.find(e => e.kind === "user_message");
  if (!firstUserMsg) {
    managed.topicGenerating = false;
    managed.info.topic = null;
    emit({ type: "agent_updated", agentId, changes: { topic: null } });
    return;
  }

  const lastFive = textEntries.slice(-5);
  let context: string;
  if (textEntries.length <= 1) {
    context = `User message: ${firstUserMsg.content}`;
  } else {
    // Deduplicate if first message is already in lastFive
    const recent = lastFive.filter(e => e.id !== firstUserMsg.id);
    context = `First message: ${firstUserMsg.content}\n\nRecent conversation:\n` +
      recent.map(e => `${e.kind === "user_message" ? "User" : "Assistant"}: ${e.content.slice(0, 200)}`).join("\n");
  }

  const prompt = `${context}\n\nRespond with ONLY a short topic description for this conversation, max 8 words. No quotes, no punctuation at the end.`;

  try {
    const result = await unstable_v2_prompt(prompt, {
      model: "claude-sonnet-4-20250514",
      permissionMode: "plan",
    });
    if (result.subtype === "success" && agents.has(agentId)) {
      const topic = result.result.trim().slice(0, 80);
      managed.info.topic = topic;
      managed.info.topicStale = false;
      managed.topicMessageCount = textEntries.length;
      emit({ type: "agent_updated", agentId, changes: { topic, topicStale: false } });
      persistAll();
      // Persist topic to sessions.json for resume list
      if (managed.sessionId) {
        persistSessionTopic(agentId, managed.sessionId, topic);
      }
    }
  } catch (err: any) {
    console.error(`Topic generation failed for ${agentId}:`, err.message);
    // Silently fail — clear the "..." placeholder
    if (agents.has(agentId)) {
      managed.info.topic = null;
      emit({ type: "agent_updated", agentId, changes: { topic: null } });
    }
  } finally {
    managed.topicGenerating = false;
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
      return "waiting_for_response";
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
          // Backfill: write any cached log entries that were created before sessionId was known
          if (!hadPreviousSession) {
            const cached = logCache.get(agentId) ?? [];
            for (const entry of cached) {
              appendLog(agentId, sessionId, entry);
            }
          }
          persistAll();
        }
        // Capture available slash commands and skills from init
        const sdkCommands: string[] = (msg as any).slash_commands ?? [];
        const sdkSkills: string[] = (msg as any).skills ?? [];
        // Filter out MCP internal command names (mcp__...) — they clutter autocomplete
        const filteredSdkCommands = sdkCommands.filter((c) => !c.startsWith("mcp__"));
        // Merge built-in, SDK-reported, and user-defined skills
        const userSkills = managed ? [...discoverBundledSkills(), ...discoverUserSkills(), ...discoverProjectSkills(managed.info.cwd)] : [];
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
          const managed = agents.get(agentId);
          if (managed) {
            managed.toolCallTimestamps.set(block.id, Date.now());
          }
          addLogEntry(agentId, "tool_call", block.name, {
            toolId: block.id,
            input: block.input,
          });
        } else if (block.type === "thinking" && block.thinking) {
          const managed = agents.get(agentId);
          const duration_ms = managed?.thinkingStartedAt
            ? Date.now() - managed.thinkingStartedAt
            : undefined;
          addLogEntry(agentId, "thinking", block.thinking, duration_ms != null ? { duration_ms } : undefined);
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
          const managed = agents.get(agentId);
          const callStart = managed?.toolCallTimestamps.get(block.tool_use_id);
          const duration_ms = callStart ? Date.now() - callStart : undefined;
          if (managed && callStart) {
            managed.toolCallTimestamps.delete(block.tool_use_id);
          }
          addLogEntry(agentId, "tool_result", resultText.slice(0, 2000), {
            toolUseId: block.tool_use_id,
            ...(duration_ms != null ? { duration_ms } : {}),
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
    hooks: createSafetyHooks(),
  };
  if (resumeSessionId) {
    opts.resume = resumeSessionId;
  }
  return resumeSessionId
    ? unstable_v2_resumeSession(resumeSessionId, opts)
    : unstable_v2_createSession(opts);
}

export async function spawn(name: string, cwd: string, permissionMode: AgentInfo["permissionMode"], desk?: number, customInstructions?: string): Promise<AgentInfo | null> {
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
  const launcherPath = createLauncher(id, resolvedCwd, name, officePrompt, customInstructions);

  const info: AgentInfo = {
    id,
    name,
    desk,
    cwd: resolvedCwd,
    outfit: generateOutfit(name),
    permissionMode,
    state: "idle",
    topic: null,
    topicStale: false,
    customInstructions: customInstructions || null,
  };

  const managed: ManagedAgent = {
    info,
    session: null,
    sessionId: null,
    streaming: false,
    aborting: false,
    launcherPath,
    slashCommands: [...BUILTIN_COMMANDS],
    skills: [...discoverBundledSkills(), ...discoverUserSkills(), ...discoverProjectSkills(resolvedCwd)],
    thinkingStartedAt: 0,
    toolCallTimestamps: new Map(),
    topicGenerating: false,
    topicMessageCount: 0,
    pendingResume: false,
    pendingResumeSessions: [],
    ptySidecar: null,
    ptyBuffer: "",
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

export async function sendMessage(agentId: string, text: string, username?: string) {
  const managed = agents.get(agentId);
  if (!managed?.session) return;

  // Handle /resume two-step: if pendingResume, check if input is a number pick
  if (managed.pendingResume) {
    managed.pendingResume = false;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= managed.pendingResumeSessions.length) {
      const picked = managed.pendingResumeSessions[num - 1];
      managed.pendingResumeSessions = [];
      // Persist current session topic before switching
      persistCurrentSessionTopic(agentId, managed);
      // Perform the resume
      try { managed.session?.close(); } catch {}
      try {
        managed.session = createSession(managed, picked.sessionId);
        managed.sessionId = picked.sessionId;
        managed.streaming = false;
        managed.topicGenerating = false;
        managed.topicMessageCount = 0;
        // Clear and replay resumed session's logs
        const history = loadLog(agentId, picked.sessionId);
        logCache.set(agentId, []);
        emit({ type: "clear_logs", agentId } as any);
        if (history.length > 0) {
          logCache.set(agentId, [...history]);
          for (const entry of history) {
            emit({ type: "log_entry", entry });
          }
        }
        // Restore topic
        managed.info.topic = picked.topic;
        managed.info.topicStale = false;
        emit({ type: "agent_updated", agentId, changes: { topic: picked.topic, topicStale: false } });
        emitEphemeralLog(agentId, "system", `Resumed session: ${picked.topic || picked.sessionId.slice(0, 8) + "..."}`);
        updateState(agentId, "waiting_for_response");
        persistAll();
        if (!picked.topic) {
          generateTopic(agentId);
        }
      } catch (err: any) {
        emitEphemeralLog(agentId, "error", `Failed to resume: ${err.message}`);
        updateState(agentId, "error");
      }
      return;
    } else {
      // Not a valid number — cancel pendingResume, process as normal
      managed.pendingResumeSessions = [];
      emitEphemeralLog(agentId, "system", "Resume cancelled.");
    }
  }

  // Intercept slash commands that are handled locally, not by the LLM
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const handled = await handleSlashCommand(agentId, managed, cmd, args, text, username);
    if (handled) return;
  }

  addLogEntry(agentId, "user_message", text, username ? { username } : undefined);
  updateState(agentId, "thinking");

  // Auto-generate topic on first user message in a conversation
  if (managed.info.topic === null && !managed.topicGenerating) {
    generateTopic(agentId); // fire-and-forget
  }

  const prefixedText = username ? `[${username}] ${text}` : text;
  try {
    await managed.session.send(prefixedText);
    await consumeStream(agentId, managed);
  } catch (err: any) {
    console.error(`Agent ${agentId} send error:`, err.message);
    addLogEntry(agentId, "error", `Error: ${err.message}`);
    updateState(agentId, "error");
  }
}

function persistCurrentSessionTopic(agentId: string, managed: ManagedAgent) {
  if (managed.sessionId && managed.info.topic && managed.info.topic !== "...") {
    persistSessionTopic(agentId, managed.sessionId, managed.info.topic);
  }
}

async function handleSlashCommand(agentId: string, managed: ManagedAgent, cmd: string, args: string[], rawText: string, username?: string): Promise<boolean> {
  const userMeta = username ? { username } : undefined;
  switch (cmd) {
    case "clear": {
      addLogEntry(agentId, "user_message", rawText, userMeta);
      managed.pendingResume = false;
      managed.pendingResumeSessions = [];
      persistCurrentSessionTopic(agentId, managed);
      try { managed.session?.close(); } catch {}
      managed.session = createSession(managed);
      managed.sessionId = null;
      managed.streaming = false;
      managed.topicGenerating = false;
      managed.topicMessageCount = 0;
      managed.info.topic = null;
      managed.info.topicStale = false;
      logCache.set(agentId, []);
      emit({ type: "clear_logs", agentId } as any);
      emit({ type: "agent_updated", agentId, changes: { topic: null, topicStale: false } });
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
      addLogEntry(agentId, "user_message", rawText, userMeta);
      addLogEntry(agentId, "system", "Cost tracking is not yet available in Isomux.");
      updateState(agentId, "waiting_for_response");
      return true;
    }
    case "help": {
      addLogEntry(agentId, "user_message", rawText, userMeta);
      const commands = managed.slashCommands.map((c) => `  /${c}`).join("\n");
      const skills = managed.skills.length > 0
        ? "\n\nSkills:\n" + managed.skills.map((s) => `  /${s}`).join("\n")
        : "";
      addLogEntry(agentId, "system", `Available commands:\n${commands}${skills}`);
      updateState(agentId, "waiting_for_response");
      return true;
    }
    case "resume": {
      emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const sessions = listAgentSessions(agentId);
      if (sessions.length === 0) {
        emitEphemeralLog(agentId, "system", "No previous sessions found.");
        updateState(agentId, "waiting_for_response");
        return true;
      }
      const lines: string[] = ["Resume a past conversation:\n"];
      let num = 1;
      const pickable: typeof sessions = [];
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.lastModified);
        const dateStr = date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const label = s.topic || s.sessionId.slice(0, 8) + "...";
        if (s.sessionId === managed.sessionId) {
          lines.push(`  ● ${label}  ${dateStr}  (current)`);
        } else {
          lines.push(`  ${num}. ${label}  ${dateStr}`);
          pickable.push(s);
          num++;
        }
      }
      if (pickable.length === 0) {
        emitEphemeralLog(agentId, "system", "No other sessions to resume.");
        updateState(agentId, "waiting_for_response");
        return true;
      }
      lines.push("\nReply with a number to resume, or anything else to cancel.");
      emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingResume = true;
      managed.pendingResumeSessions = pickable;
      updateState(agentId, "waiting_for_response");
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
        addLogEntry(agentId, "user_message", rawText, userMeta);
        updateState(agentId, "thinking");
        const prefixedSkillPrompt = username ? `[${username}] ${fullPrompt}` : fullPrompt;
        try {
          await managed.session!.send(prefixedSkillPrompt);
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
    // Project and user skills take priority over bundled
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "commands", `${name}.md`),
    join(homedir(), ".claude", "skills", name, "SKILL.md"),
    join(homedir(), ".claude", "commands", `${name}.md`),
    join(BUNDLED_SKILLS_DIR, name, "SKILL.md"),
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
    updateState(agentId, "waiting_for_response");
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
  try { sidecarSend(managed, { type: "kill" }); managed.ptySidecar?.kill(); } catch {}
  agents.delete(agentId);
  logCache.delete(agentId);
  emit({ type: "agent_removed", agentId });
  persistAll();
}

export async function newConversation(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.pendingResume = false;
  managed.pendingResumeSessions = [];
  persistCurrentSessionTopic(agentId, managed);
  try { managed.session?.close(); } catch {}

  try {
    managed.session = createSession(managed);
    managed.sessionId = null;
    managed.streaming = false;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;
    managed.info.topic = null;
    managed.info.topicStale = false;
    emit({ type: "agent_updated", agentId, changes: { topic: null, topicStale: false } });
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
  managed.pendingResume = false;
  managed.pendingResumeSessions = [];
  persistCurrentSessionTopic(agentId, managed);
  try { managed.session?.close(); } catch {}

  try {
    managed.session = createSession(managed, sessionId);
    managed.sessionId = sessionId;
    managed.streaming = false;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;

    // Clear and replay resumed session's logs
    const history = loadLog(agentId, sessionId);
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId } as any);
    if (history.length > 0) {
      logCache.set(agentId, [...history]);
      for (const entry of history) {
        emit({ type: "log_entry", entry });
      }
    }

    // Restore topic from sessions.json
    const sessions = listAgentSessions(agentId);
    const sessionEntry = sessions.find(s => s.sessionId === sessionId);
    managed.info.topic = sessionEntry?.topic ?? null;
    managed.info.topicStale = false;
    emit({ type: "agent_updated", agentId, changes: { topic: managed.info.topic, topicStale: false } });

    updateState(agentId, "waiting_for_response");
    addLogEntry(agentId, "system", `Resumed session: ${managed.info.topic || sessionId.slice(0, 8) + "..."}`);
    persistAll();

    // If no topic, regenerate from session logs
    if (!managed.info.topic) {
      generateTopic(agentId);
    }
  } catch (err: any) {
    addLogEntry(agentId, "error", `Failed to resume: ${err.message}`);
    updateState(agentId, "error");
  }
}

export function setTopic(agentId: string, topic: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.info.topic = topic.slice(0, 80);
  managed.info.topicStale = false;
  const textCount = (logCache.get(agentId) ?? []).filter(e => e.kind === "user_message" || e.kind === "text").length;
  managed.topicMessageCount = textCount;
  emit({ type: "agent_updated", agentId, changes: { topic: managed.info.topic, topicStale: false } });
  // Persist to sessions.json so resume list shows the manual topic
  if (managed.sessionId) {
    persistSessionTopic(agentId, managed.sessionId, managed.info.topic);
  }
  updateManifest();
}

export function resetTopic(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  generateTopic(agentId); // fire-and-forget
}

// --- Terminal PTY management (via Node.js sidecar) ---

const PTY_SIDECAR_PATH = join(import.meta.dir, "pty-sidecar.cjs");
const MAX_PTY_BUFFER = 100_000;

function sidecarSend(managed: ManagedAgent, msg: Record<string, unknown>) {
  const stdin = managed.ptySidecar?.stdin;
  if (stdin && typeof stdin !== "number") stdin.write(JSON.stringify(msg) + "\n");
}

export function openTerminal(agentId: string): boolean {
  const managed = agents.get(agentId);
  if (!managed) return false;

  // Already running — just replay buffered output
  if (managed.ptySidecar) return true;

  const shell = process.env.SHELL || "/bin/bash";
  const home = homedir();
  const ptyEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TERM: "xterm-256color",
    SHELL: shell,
    HOME: home,
    USER: process.env.USER || require("os").userInfo().username,
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };

  const sidecar = Bun.spawn(["node", PTY_SIDECAR_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  managed.ptySidecar = sidecar;
  managed.ptyBuffer = "";

  // Read stdout as text lines using Bun's native ReadableStream
  (async () => {
    const reader = sidecar.stdout.getReader();
    const decoder = new TextDecoder();
    let partial = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop()!; // keep incomplete last line
        for (const line of lines) {
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "output") {
            managed.ptyBuffer += msg.data;
            if (managed.ptyBuffer.length > MAX_PTY_BUFFER) {
              managed.ptyBuffer = managed.ptyBuffer.slice(-MAX_PTY_BUFFER);
            }
            emit({ type: "terminal_output", agentId, data: msg.data } as any);
          } else if (msg.type === "exit") {
            console.log(`[terminal] PTY exited for ${agentId}: code=${msg.exitCode}, signal=${msg.signal}`);
            managed.ptySidecar = null;
            emit({ type: "terminal_exit", agentId, exitCode: msg.exitCode } as any);
          }
        }
      }
    } catch {}
  })();

  sidecar.exited.then(() => {
    if (managed.ptySidecar === sidecar) {
      managed.ptySidecar = null;
    }
  });

  // Tell sidecar to spawn the PTY
  sidecarSend(managed, {
    type: "spawn",
    shell,
    cols: 80,
    rows: 24,
    cwd: managed.info.cwd,
    env: ptyEnv,
  });

  console.log(`[terminal] Spawned sidecar for ${agentId}: shell=${shell}, cwd=${managed.info.cwd}, pid=${sidecar.pid}`);
  return true;
}

export function getTerminalBuffer(agentId: string): string | null {
  const managed = agents.get(agentId);
  if (!managed?.ptySidecar) return null;
  return managed.ptyBuffer;
}

export function terminalInput(agentId: string, data: string) {
  const managed = agents.get(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "input", data });
}

export function terminalResize(agentId: string, cols: number, rows: number) {
  const managed = agents.get(agentId);
  if (managed?.ptySidecar) sidecarSend(managed, { type: "resize", cols, rows });
}

export function closeTerminal(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed?.ptySidecar) return;
  sidecarSend(managed, { type: "kill" });
  managed.ptySidecar = null;
  managed.ptyBuffer = "";
}
