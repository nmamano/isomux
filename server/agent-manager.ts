import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  forkSession,
  getSessionMessages,
  type SDKMessage,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentInfo, AgentOutfit, AgentState, Attachment, EffortLevel, LogEntry, ModelFamily, OfficeSettings, RoomWire, SkillInfo } from "../shared/types.ts";
import { MODEL_FAMILIES, FAMILY_TO_MODEL, EFFORT_LEVELS, DEFAULT_EFFORT, familyDisplayLabel, effortDisplayLabel, generateRoomId } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import {
  appendLog,
  loadLog,
  loadLogWithAncestors,
  loadSessionsMap,
  loadAgents,
  saveAgents,
  listAgentSessions,
  writeManifest,
  persistSessionTopic,
  persistSessionFork,
  accumulateSessionUsage,
  appendSessionUsageSnapshot,
  rollSessionUsageOnResume,
  loadOfficeConfig,
  saveOfficeConfig,
  readEnvFile,
  saveFile,
  loadAgentHistory,
  saveAgentHistory,
  type PersistedAgent,
  type Room,
  type OfficeConfig,
  type AgentHistory,
} from "./persistence.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import { autocompleteCommands } from "./commands.ts";
import { join } from "path";
import { homedir } from "os";
import { rmSync } from "fs";
import {
  CLAUDE_NATIVE_BIN,
  resolveCwd,
  validateCwd,
  claudeSessionFileExists,
  claudeProjectDir,
  moveClaudeSessionFiles,
  diagnoseProcessExit,
} from "./cwd-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  discoverUserSkills,
  discoverProjectSkills,
  discoverPluginSkills,
  discoverBundledSkills,
  deduplicateSkills,
} from "./skills.ts";
import { buildUserMessage } from "./user-message.ts";
import { findUsageAtFork } from "./usage-report.ts";
import {
  openTerminal as openTerminalImpl,
  getTerminalBuffer as getTerminalBufferImpl,
  terminalInput as terminalInputImpl,
  terminalResize as terminalResizeImpl,
  closeTerminal as closeTerminalImpl,
  killSidecar,
  type TerminalDeps,
} from "./terminal.ts";
import { createCommandHandling } from "./command-handlers.ts";
import {
  SessionSwappedError,
  type ManagedAgent,
  type AgentEvent,
  type EventHandler,
  type InternalRoom,
} from "./internal-types.ts";

const LOGIN_INSTRUCTIONS = `To authenticate:
1. Open the built-in terminal
2. Run \`claude\`
3. Type \`/login\`
4. Follow the auth flow

Once complete, it takes effect immediately for all Isomux agents.`;

const AUTH_ERROR_PATTERNS = /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|403|401/i;
function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.test(text);
}

const agents = new Map<string, ManagedAgent>();
const logCache = new Map<string, LogEntry[]>(); // agentId → entries
let eventHandler: EventHandler = () => {};
let officeConfig: OfficeConfig = loadOfficeConfig();
let rooms: InternalRoom[] = [{ id: generateRoomId(), name: "Room 1", prompt: null, envFile: null }];

function roomsWire(): RoomWire[] {
  return rooms.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, envFile: r.envFile }));
}

function findRoomIndex(roomId: string): number {
  return rooms.findIndex((r) => r.id === roomId);
}

export function getRooms(): RoomWire[] {
  return roomsWire();
}

export function getOfficeSettings(): OfficeSettings {
  return { prompt: officeConfig.prompt, envFile: officeConfig.envFile };
}

// Update office settings. Caller is responsible for validating envFile (see validateEnvPath).
export function setOfficeSettings(prompt: string | null, envFile: string | null) {
  const normalizedPrompt = prompt && prompt.trim() ? prompt.trim() : null;
  officeConfig = { prompt: normalizedPrompt, envFile: envFile || null };
  saveOfficeConfig(officeConfig);
  // System prompt is rebuilt at every createSession from current office/room/agent
  // config, so the new office prompt automatically lands on the next conversation.
  eventHandler({ type: "office_settings_updated", prompt: officeConfig.prompt, envFile: officeConfig.envFile });
}

export function setRoomSettings(roomId: string, prompt: string | null, envFile: string | null): boolean {
  const idx = findRoomIndex(roomId);
  if (idx < 0) return false;
  const room = rooms[idx];
  room.prompt = prompt && prompt.trim() ? prompt.trim() : null;
  room.envFile = envFile || null;
  persistAll();
  // System prompt is rebuilt at every createSession — next conversation picks up
  // the new room prompt automatically.
  eventHandler({ type: "room_settings_updated", roomId, prompt: room.prompt, envFile: room.envFile });
  return true;
}

// Validate an env file path. Returns key count on success, throws on failure.
export function validateEnvPath(path: string): number {
  const parsed = readEnvFile(path);
  return Object.keys(parsed).length;
}

export function onEvent(handler: EventHandler) {
  eventHandler = handler;
}

// Get cached logs for an agent (used when browser connects after restore)
export function getAgentLogs(agentId: string): LogEntry[] {
  return logCache.get(agentId) ?? [];
}

export function getAgentCommands(agentId: string): { commands: { name: string; description?: string }[]; skills: SkillInfo[] } {
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

export { validateCwd };

export async function editAgent(
  agentId: string,
  changes: { name?: string; cwd?: string; outfit?: AgentInfo["outfit"]; customInstructions?: string; modelFamily?: ModelFamily; effort?: EffortLevel; permissionMode?: AgentInfo["permissionMode"] },
) {
  const managed = agents.get(agentId);
  if (!managed) return;

  const updated: Partial<AgentInfo> = {};

  if (changes.name && changes.name !== managed.info.name) {
    // Reject duplicate names
    const nameLower = changes.name.trim().toLowerCase();
    const duplicate = [...agents.values()].some((a) => a.info.id !== agentId && a.info.name.toLowerCase() === nameLower);
    if (!duplicate) {
      managed.info.name = changes.name;
      updated.name = changes.name;
    }
  }
  if (changes.cwd && changes.cwd !== managed.info.cwd) {
    const oldCwd = managed.info.cwd;
    managed.info.cwd = resolveCwd(changes.cwd);
    updated.cwd = managed.info.cwd;
    moveClaudeSessionFiles(agentId, oldCwd, managed.info.cwd);
  }
  if (changes.outfit) {
    managed.info.outfit = changes.outfit;
    updated.outfit = changes.outfit;
  }
  if (changes.customInstructions !== undefined && changes.customInstructions !== managed.info.customInstructions) {
    managed.info.customInstructions = changes.customInstructions || null;
    updated.customInstructions = managed.info.customInstructions;
  }
  if (changes.modelFamily && changes.modelFamily !== managed.info.modelFamily) {
    managed.info.modelFamily = changes.modelFamily;
    updated.modelFamily = changes.modelFamily;
  }
  if (changes.effort && changes.effort !== managed.info.effort) {
    managed.info.effort = changes.effort;
    updated.effort = changes.effort;
  }
  if (changes.permissionMode && changes.permissionMode !== managed.info.permissionMode) {
    managed.info.permissionMode = changes.permissionMode;
    updated.permissionMode = changes.permissionMode;
  }

  if (Object.keys(updated).length === 0) return;

  // System prompt + cwd are passed into every createSession, so name/cwd/
  // customInstructions changes automatically apply to the next conversation.

  // Recreate session if model, effort, or permission mode changed so it takes effect immediately
  if (updated.modelFamily || updated.effort || updated.permissionMode) {
    const sessionId = managed.sessionId;
    const newSession = sessionId ? createSession(managed, sessionId) : createSession(managed);
    await replaceSession(agentId, managed, newSession);
  }

  persistAll();
  eventHandler({ type: "agent_updated", agentId, changes: updated });
}

export function swapDesks(deskA: number, deskB: number, roomId: string) {
  if (deskA === deskB || deskA < 0 || deskA > 7 || deskB < 0 || deskB > 7) return;
  const roomIdx = findRoomIndex(roomId);
  if (roomIdx < 0) return;
  const allManaged = [...agents.values()];
  const agentA = allManaged.find((m) => m.info.desk === deskA && m.info.room === roomIdx);
  const agentB = allManaged.find((m) => m.info.desk === deskB && m.info.room === roomIdx);
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

export function createRoom(name?: string): string {
  const existingIds = rooms.map((r) => r.id);
  const id = generateRoomId(existingIds);
  const displayName = (name || `Room ${rooms.length + 1}`).trim().slice(0, 40);
  const room: InternalRoom = { id, name: displayName, prompt: null, envFile: null };
  rooms.push(room);
  persistAll();
  eventHandler({ type: "room_created", room: { id: room.id, name: room.name, prompt: room.prompt, envFile: room.envFile } });
  return id;
}

export function closeRoom(roomId: string): boolean {
  const roomIdx = findRoomIndex(roomId);
  if (roomIdx <= 0) return false; // Room 1 is permanent, and unknown ids reject
  // Check room is empty
  const roomAgents = [...agents.values()].filter((a) => a.info.room === roomIdx);
  if (roomAgents.length > 0) return false;

  rooms.splice(roomIdx, 1);
  // Renumber agents in higher rooms
  for (const managed of agents.values()) {
    if (managed.info.room > roomIdx) {
      managed.info.room--;
      eventHandler({ type: "agent_updated", agentId: managed.info.id, changes: { room: managed.info.room } });
    }
  }
  persistAll();
  eventHandler({ type: "room_closed", roomId });
  return true;
}

export function renameRoom(roomId: string, name: string): boolean {
  const roomIdx = findRoomIndex(roomId);
  if (roomIdx < 0) return false;
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return false;
  rooms[roomIdx].name = trimmed;
  // Room name appears in the system prompt header; it's rebuilt at every
  // createSession, so agents in this room pick up the new name on their next
  // conversation automatically.
  persistAll();
  eventHandler({ type: "room_renamed", roomId, name: trimmed });
  return true;
}

export function reorderRooms(order: string[]): boolean {
  // Must be a permutation of the existing room ids
  if (order.length !== rooms.length) return false;
  const currentIds = new Set(rooms.map((r) => r.id));
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || !currentIds.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  // No-op check
  if (order.every((id, i) => id === rooms[i].id)) return false;

  // Build reverseMap: oldIdx → newIdx, keyed by current position.
  const oldIndexById = new Map(rooms.map((r, i) => [r.id, i] as const));
  const reverseMap = new Array<number>(rooms.length);
  for (let newIdx = 0; newIdx < order.length; newIdx++) {
    reverseMap[oldIndexById.get(order[newIdx])!] = newIdx;
  }

  // Reorder rooms
  const byId = new Map(rooms.map((r) => [r.id, r] as const));
  rooms = order.map((id) => byId.get(id)!);

  // Remap every agent's room index (no individual agent_updated — clients
  // remap atomically from the rooms_reordered message)
  for (const managed of agents.values()) {
    managed.info.room = reverseMap[managed.info.room];
  }

  persistAll();
  eventHandler({ type: "rooms_reordered", order });
  return true;
}

export function moveAgent(agentId: string, targetRoomId: string): boolean {
  const managed = agents.get(agentId);
  if (!managed) return false;
  const targetIdx = findRoomIndex(targetRoomId);
  if (targetIdx < 0) return false;
  if (managed.info.room === targetIdx) return false;

  // Find first available desk in target room
  const targetAgents = [...agents.values()].filter((a) => a.info.room === targetIdx);
  if (targetAgents.length >= 8) return false;
  const taken = new Set(targetAgents.map((a) => a.info.desk));
  let newDesk = -1;
  for (let i = 0; i < 8; i++) {
    if (!taken.has(i)) { newDesk = i; break; }
  }
  if (newDesk === -1) return false;

  managed.info.room = targetIdx;
  managed.info.desk = newDesk;
  // New room's prompt context is picked up on the agent's next conversation
  // since the system prompt is rebuilt at every createSession.
  eventHandler({ type: "agent_updated", agentId, changes: { room: targetIdx, desk: newDesk } });
  persistAll();
  return true;
}

export function getAllAgents(): AgentInfo[] {
  return [...agents.values()].map((a) => a.info);
}

function updateManifest() {
  writeManifest([...agents.values()].map((a) => ({
    id: a.info.id,
    name: a.info.name,
    desk: a.info.desk,
    room: a.info.room,
    roomName: rooms[a.info.room]?.name ?? `Room ${a.info.room + 1}`,
    topic: a.info.topic,
    cwd: a.info.cwd,
    modelFamily: a.info.modelFamily,
    model: FAMILY_TO_MODEL[a.info.modelFamily],
  })));
}

function persistAll() {
  const persistedRooms: Room[] = rooms.map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    envFile: r.envFile,
    agents: [] as PersistedAgent[],
  }));
  for (const a of agents.values()) {
    const room = a.info.room;
    if (room >= 0 && room < persistedRooms.length) {
      persistedRooms[room].agents.push({
        id: a.info.id,
        name: a.info.name,
        desk: a.info.desk,
        cwd: a.info.cwd,
        outfit: a.info.outfit,
        permissionMode: a.info.permissionMode,
        modelFamily: a.info.modelFamily,
        effort: a.info.effort,
        lastSessionId: a.sessionId,
        topic: a.info.topic,
        customInstructions: a.info.customInstructions,
      });
    }
  }
  saveAgents(persistedRooms);
  updateManifest();
  updateAgentHistory();
}

// Track each live agent's current name + room so /usage can attribute killed
// agents (and agents whose rooms were later deleted) to the right bucket.
// Entries are never removed; they just stop getting refreshed once the agent
// is killed, which is exactly the behavior we want.
function updateAgentHistory() {
  const history: AgentHistory = loadAgentHistory();
  for (const a of agents.values()) {
    const room = rooms[a.info.room];
    if (!room) continue;
    history[a.info.id] = { name: a.info.name, lastRoomId: room.id, lastRoomName: room.name };
  }
  saveAgentHistory(history);
}

// Restore agents from disk on startup. Creates sessions and loads log history.
export async function restoreAgents() {
  // Clean up the pre-0.2.116 per-agent launcher scripts. Isomux now passes the
  // native Claude binary directly, so these are orphaned.
  try { rmSync(join(homedir(), ".isomux", "launchers"), { recursive: true, force: true }); } catch {}

  const loaded = loadAgents();
  rooms = loaded.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, envFile: r.envFile }));

  for (let roomIdx = 0; roomIdx < loaded.length; roomIdx++) {
    for (const p of loaded[roomIdx].agents) {
      const info: AgentInfo = {
        id: p.id,
        name: p.name,
        desk: p.desk,
        room: roomIdx,
        cwd: p.cwd,
        outfit: p.outfit,
        permissionMode: p.permissionMode,
        modelFamily: p.modelFamily ?? "opus",
        effort: p.effort ?? DEFAULT_EFFORT,
        state: p.lastSessionId ? "waiting_for_response" : "idle",
        topic: p.topic ?? null,
        topicStale: false,
        customInstructions: p.customInstructions ?? null,
      };
      const managed: ManagedAgent = {
        info,
        session: null,
        sessionId: p.lastSessionId,
        consumerPromise: null,
        pendingTurn: null,
        aborting: false,
        slashCommands: autocompleteCommands(),
        skills: deduplicateSkills([...discoverUserSkills(), ...discoverProjectSkills(p.cwd), ...discoverPluginSkills(), ...discoverBundledSkills()]),
        sdkReportedCommands: [],
        thinkingStartedAt: 0,
        toolCallTimestamps: new Map(),
        topicGenerating: false,
        topicMessageCount: 0,
        pendingResume: false,
        pendingResumeSessions: [],
        pendingModelPick: false,
        pendingEffortPick: false,
        pendingPermission: null,
        ptySidecar: null,
        ptyBuffer: "",
        lastWrittenEntryId: null,
      };
      agents.set(p.id, managed);

      // Load log history into cache (browsers connect later, so we cache it).
      // Uses loadLogWithAncestors to include parent entries for forked sessions.
      if (p.lastSessionId) {
        const history = loadLogWithAncestors(p.id, p.lastSessionId);
        if (history.length > 0) {
          logCache.set(p.id, [...history]);
        }
      }

      // Auto-resume session
      try {
        const session = p.lastSessionId ? createSession(managed, p.lastSessionId) : createSession(managed);
        installSession(p.id, managed, session);
      } catch (err: any) {
        console.error(`Failed to restore session for ${p.name}:`, err.message);
        managed.info.state = "error";
        // Surface to the UI so the user sees why the agent can't respond.
        const entry: LogEntry = {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          agentId: p.id,
          timestamp: Date.now(),
          kind: "error",
          content: `Failed to restore on startup: ${err.message}`,
        };
        const cached = logCache.get(p.id) ?? [];
        cached.push(entry);
        logCache.set(p.id, cached);
      }
    }
  }
  // Round-trip migrations back to disk in case the load step filled in new
  // fields (room ids, prompt/envFile defaults) that weren't present before.
  // Must run AFTER agents are populated or persistAll writes empty rooms.
  persistAll();
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

function addLogEntry(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>, attachments?: Attachment[]) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
  // Cache locally
  const cached = logCache.get(agentId) ?? [];
  cached.push(entry);
  logCache.set(agentId, cached);

  emit({ type: "log_entry", entry });

  const managed = agents.get(agentId);
  if (managed?.sessionId) {
    appendLog(agentId, managed.sessionId, entry);
    // Track the last entry actually written to this session's JSONL so that
    // /usage's per-turn snapshots have a stable anchor inside the log.
    managed.lastWrittenEntryId = entry.id;
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
function emitEphemeralLog(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>, extra?: Partial<Pick<LogEntry, "diff">>) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
    ...(extra ?? {}),
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
      model: FAMILY_TO_MODEL.sonnet,
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
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
          // Load prior log history if this session was seen before (walks fork ancestry)
          if (!managed.sessionId && sessionId) {
            const history = loadLogWithAncestors(agentId, sessionId);
            if (history.length > 0) {
              for (const entry of history) {
                emit({ type: "log_entry", entry });
              }
            }
          }
          // If we already had a session and got a new init, this is a /clear
          if (hadPreviousSession && sessionId !== managed.sessionId) {
            logCache.set(agentId, []);
            emit({ type: "clear_logs", agentId });
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
        // Filter out MCP internal command names (mcp__...) — they clutter autocomplete
        const filteredSdkCommands = sdkCommands.filter((c) => !c.startsWith("mcp__"));
        // Store SDK-reported commands for pass-through resolution (step 4)
        if (managed) {
          managed.sdkReportedCommands = filteredSdkCommands;
        }
        // Autocomplete: config entries with autocomplete:true + all discovered skills
        // SDK-reported commands are NOT added to autocomplete (per design)
        // Skills are listed in priority order; deduplicate by name (highest priority wins)
        const discoveredSkills = managed
          ? [...discoverUserSkills(), ...discoverProjectSkills(managed.info.cwd), ...discoverPluginSkills(), ...discoverBundledSkills()]
          : [];
        const uniqueSkills = deduplicateSkills(discoveredSkills);
        const configCommands = autocompleteCommands();
        if (managed) {
          managed.slashCommands = configCommands;
          managed.skills = uniqueSkills;
        }
        emit({
          type: "slash_commands",
          agentId,
          commands: configCommands,
          skills: uniqueSkills,
        });
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
          // Extract image blocks from tool result content
          let resultAttachments: Attachment[] | undefined;
          if (Array.isArray(block.content)) {
            const atts: Attachment[] = [];
            for (const c of block.content as any[]) {
              if (c.type === "image" && c.source?.type === "base64") {
                const decoded = Buffer.from(c.source.data, "base64");
                const att = saveFile(agentId, decoded, c.source.media_type, `image.${c.source.media_type.split("/")[1] ?? "png"}`);
                if (att) atts.push(att);
              }
            }
            if (atts.length > 0) resultAttachments = atts;
          }
          const managed = agents.get(agentId);
          const callStart = managed?.toolCallTimestamps.get(block.tool_use_id);
          const duration_ms = callStart ? Date.now() - callStart : undefined;
          if (managed && callStart) {
            managed.toolCallTimestamps.delete(block.tool_use_id);
          }
          addLogEntry(agentId, "tool_result", resultText.slice(0, 10000), {
            toolUseId: block.tool_use_id,
            ...(duration_ms != null ? { duration_ms } : {}),
          }, resultAttachments);
        }
      }
      break;
    }
    case "result": {
      // SDK reports tokens per-turn and cost cumulative-per-process on every
      // `result`. We accumulate tokens and overwrite cost into sessions.json
      // (`usage`) and append the resulting cumulative as a snapshot anchored
      // to the most recently written log entry. The snapshots let /usage's
      // fork accounting subtract the parent's cumulative-at-the-fork-point
      // exactly, instead of double-counting the resumed prefix.
      // Only trust usage from success results. Error-subtype results may omit
      // `usage` entirely, and `?? 0` would overwrite the accurate cumulative
      // with zeros.
      const managed = agents.get(agentId);
      const usageField = (msg as any).usage;
      if (managed?.sessionId && usageField) {
        const cost = (msg as any).total_cost_usd ?? 0;
        const cumulative = accumulateSessionUsage(agentId, managed.sessionId, {
          inputTokens: usageField.input_tokens ?? 0,
          outputTokens: usageField.output_tokens ?? 0,
          cacheReadInputTokens: usageField.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: usageField.cache_creation_input_tokens ?? 0,
        }, cost);
        if (managed.lastWrittenEntryId) {
          appendSessionUsageSnapshot(agentId, managed.sessionId, managed.lastWrittenEntryId, cumulative);
        }
      }
      const subtype = (msg as any).subtype;
      if (subtype !== "success") {
        const errors = (msg as any).errors;
        const errorText = `Agent stopped: ${subtype}. ${errors?.join(", ") || ""}`;
        addLogEntry(agentId, "error", errorText);
        if (isAuthError(errorText)) {
          emitEphemeralLog(agentId, "system", LOGIN_INSTRUCTIONS);
        }
        updateState(agentId, "error");
      }
      break;
    }
  }
}

// Create the per-turn deferred that sendMessage / executeSkill await. The
// persistent consumer resolves it when its inner `stream()` iterator ends —
// which, per the V2 SDK contract, happens exactly at the turn's `result`
// message. If the SDK ever emits an empty stream between turns, this
// deferred would resolve prematurely; the invariant is load-bearing.
function createTurnDeferred(managed: ManagedAgent): Promise<void> {
  // Any stale pending turn (shouldn't normally happen; agents are
  // state-gated to one turn at a time) gets rejected so awaiting callers
  // don't leak forever.
  const stale = managed.pendingTurn;
  if (stale) {
    managed.pendingTurn = null;
    try { stale.reject(new Error("Superseded by a new turn.")); } catch {}
  }
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  managed.pendingTurn = { resolve, reject };
  return promise;
}

// Persistent consumer. Runs for the session's lifetime, iterating `stream()`
// in a loop so events that arrive between turns (notably `task_notification`
// from backgrounded Bash) get processed promptly instead of being held until
// the next user turn. See docs/held-back-messages-investigation.md.
//
// Bound to a specific session instance: loop exits when `managed.session` is
// swapped out (abort / resume / fork / etc.) — `session.close()` unblocks the
// parked `stream()` generator.
async function runConsumer(agentId: string, managed: ManagedAgent, boundSession: ReturnType<typeof unstable_v2_createSession>) {
  while (agents.has(agentId) && managed.session === boundSession) {
    try {
      for await (const msg of boundSession.stream()) {
        processMessage(agentId, msg);
      }
      // Inner generator ended: either the turn's `result` arrived, or the
      // session was closed from underneath us. Resolve any pending turn; the
      // outer loop re-calls stream() which blocks until the next event.
      const turn = managed.pendingTurn;
      if (turn && managed.session === boundSession) {
        managed.pendingTurn = null;
        turn.resolve();
      }
    } catch (err: any) {
      if (managed.aborting || managed.session !== boundSession) {
        // Expected: abort() or a session swap closed us. The swap path
        // already nulled + rejected pendingTurn with SessionSwappedError.
        return;
      }

      const turn = managed.pendingTurn;
      managed.pendingTurn = null;
      if (turn) turn.reject(err);

      console.error(`Agent ${agentId} stream error:`, err.message);
      const errorText = `Stream error: ${err.message}`;
      addLogEntry(agentId, "error", errorText);
      // The SDK's "process exited with code 1" is opaque; diagnose common causes.
      const hints = diagnoseProcessExit(managed.info.cwd, managed.sessionId);
      if (hints) emitEphemeralLog(agentId, "system", hints);
      if (isAuthError(errorText)) {
        emitEphemeralLog(agentId, "system", LOGIN_INSTRUCTIONS);
      }
      updateState(agentId, "error");
      return;
    }
  }
}

// Install a freshly-created session on managed and spawn its consumer. Caller
// is responsible for having closed/awaited any previous session first.
function installSession(agentId: string, managed: ManagedAgent, session: ReturnType<typeof unstable_v2_createSession>) {
  managed.session = session;
  managed.consumerPromise = runConsumer(agentId, managed, session);
}

// Swap the agent's session: close the current one, await its consumer to
// drain, install the new session + consumer. Rejects any in-flight turn so
// callers awaiting sendMessage's deferred don't hang.
async function replaceSession(agentId: string, managed: ManagedAgent, newSession: ReturnType<typeof unstable_v2_createSession>) {
  const oldConsumer = managed.consumerPromise;
  const turn = managed.pendingTurn;
  managed.pendingTurn = null;
  if (turn) {
    try { turn.reject(new SessionSwappedError()); } catch {}
  }
  try { managed.session?.close(); } catch {}
  managed.session = null;
  if (oldConsumer) {
    try { await oldConsumer; } catch {}
  }
  installSession(agentId, managed, newSession);
}

// Merge process.env with office and room env files.
// Room overrides office; office overrides process.env. Spawn-time failure mode:
// if a configured env file is missing or fails to parse, throw — the caller is
// responsible for surfacing the error to the agent log.
function buildSessionEnv(managed: ManagedAgent): { [key: string]: string | undefined } | undefined {
  const room = rooms[managed.info.room];
  const roomEnvFile = room?.envFile ?? null;
  const officeEnvFile = officeConfig.envFile;
  if (!roomEnvFile && !officeEnvFile) return undefined;

  // Intentional: inherit parent process.env so agents see HOME/PATH/etc. Office
  // and room files override individual keys but cannot unset inherited ones.
  const merged: { [key: string]: string | undefined } = { ...process.env };
  if (officeEnvFile) {
    const officeEnv = readEnvFile(officeEnvFile);
    Object.assign(merged, officeEnv);
  }
  if (roomEnvFile) {
    const roomEnv = readEnvFile(roomEnvFile);
    Object.assign(merged, roomEnv);
  }
  return merged;
}

function requestPermission(managed: ManagedAgent, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
  const agentId = managed.info.id;
  return new Promise<PermissionResult>((resolve) => {
    const title = opts.title ?? `Claude wants to use ${toolName}`;
    const lines: string[] = [`**${title}**`];
    if (opts.description) lines.push(opts.description);
    if (opts.decisionReason) lines.push(`\n_${opts.decisionReason}_`);
    lines.push("");
    lines.push("Reply:");
    lines.push("  1. Allow — and don't ask again for similar calls this session");
    lines.push("  2. Allow — just this time");
    lines.push("  3. Deny");
    lines.push("");
    lines.push("Or type any other message to deny with that as the reason.");
    emitEphemeralLog(agentId, "system", lines.join("\n"));

    // If a prior pending permission was never resolved, deny it now so we don't leak.
    if (managed.pendingPermission) {
      try { managed.pendingPermission.resolve({ behavior: "deny", message: "Superseded by newer request." }); } catch {}
    }
    managed.pendingPermission = {
      toolUseID: opts.toolUseID,
      input,
      suggestions: opts.suggestions,
      resolve,
    };
    updateState(agentId, "waiting_for_response");

    opts.signal.addEventListener("abort", () => {
      if (managed.pendingPermission?.toolUseID === opts.toolUseID) {
        managed.pendingPermission = null;
        resolve({ behavior: "deny", message: "Request aborted." });
      }
    }, { once: true });
  });
}

function createSession(managed: ManagedAgent, resumeSessionId?: string) {
  // Drop any pending permission prompt from a prior (now-closed) session so the
  // next user message isn't swallowed by a dead request.
  if (managed.pendingPermission) {
    try { managed.pendingPermission.resolve({ behavior: "deny", message: "Session restarted." }); } catch {}
    managed.pendingPermission = null;
  }
  // Preflight checks so failures surface as readable errors instead of the SDK's
  // opaque "Claude Code process exited with code 1".
  try {
    validateCwd(managed.info.cwd);
  } catch (err: any) {
    throw new Error(`cwd is invalid: ${err.message}. Click the agent name in the log view header to fix it.`);
  }
  if (resumeSessionId && !claudeSessionFileExists(managed.info.cwd, resumeSessionId)) {
    throw new Error(
      `Cannot resume session ${resumeSessionId.slice(0, 8)}…: its file is missing from ${claudeProjectDir(managed.info.cwd)}. ` +
      `Most commonly this happens after the agent's cwd was moved or renamed — the Claude CLI stores sessions under a path derived from cwd. ` +
      `Use /resume to pick a different session, or move the session .jsonl into the new project dir.`
    );
  }
  const room = rooms[managed.info.room]!;
  const systemPrompt = buildSystemPrompt(
    managed.info.name,
    room.name,
    officeConfig.prompt,
    room.prompt,
    managed.info.customInstructions,
  );
  // V2 SDKSessionOptions still doesn't expose systemPrompt / extraArgs, so we
  // inject --append-system-prompt and --effort via executableArgs. When
  // pathToClaudeCodeExecutable is a native binary, executableArgs are prepended
  // to the CLI args verbatim (verified against SDK 0.2.116 sdk.mjs).
  const opts: any = {
    model: FAMILY_TO_MODEL[managed.info.modelFamily],
    permissionMode: managed.info.permissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    executableArgs: ["--append-system-prompt", systemPrompt, "--effort", managed.info.effort],
    cwd: managed.info.cwd,
    hooks: createSafetyHooks(),
    canUseTool: ((toolName, input, options) => requestPermission(managed, toolName, input, options)) as CanUseTool,
  };
  const env = buildSessionEnv(managed);
  if (env) opts.env = env;
  if (resumeSessionId) {
    opts.resume = resumeSessionId;
    // The SDK reports cost cumulative-per-process, so a resumed session's
    // counter starts from zero. Roll the current-run usage into the
    // prior-runs accumulator so lifetime cost survives the reset.
    rollSessionUsageOnResume(managed.info.id, resumeSessionId);
  }
  return resumeSessionId
    ? unstable_v2_resumeSession(resumeSessionId, opts)
    : unstable_v2_createSession(opts);
}

export async function spawn(
  name: string,
  cwd: string,
  permissionMode: AgentInfo["permissionMode"],
  desk?: number,
  customInstructions?: string,
  roomId?: string,
  outfit?: AgentOutfit,
  modelFamily?: ModelFamily,
  effort?: EffortLevel,
): Promise<AgentInfo | null> {
  // Reject duplicate names across all rooms
  const nameLower = name.trim().toLowerCase();
  for (const a of agents.values()) {
    if (a.info.name.toLowerCase() === nameLower) return null;
  }
  let targetRoom = 0;
  if (roomId) {
    const idx = findRoomIndex(roomId);
    if (idx >= 0) targetRoom = idx;
  }
  const roomAgents = [...agents.values()].filter((a) => a.info.room === targetRoom);
  const taken = new Set(roomAgents.map((a) => a.info.desk));
  if (desk !== undefined && !taken.has(desk)) {
    // Use the requested desk
  } else {
    // Find first free desk in the target room
    desk = -1;
    for (let i = 0; i < 8; i++) {
      if (!taken.has(i)) { desk = i; break; }
    }
  }
  if (desk === -1) return null;

  const resolvedCwd = resolveCwd(cwd);
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const info: AgentInfo = {
    id,
    name,
    desk,
    room: targetRoom,
    cwd: resolvedCwd,
    outfit: outfit ?? generateOutfit(),
    permissionMode,
    modelFamily: modelFamily ?? "opus",
    effort: effort ?? DEFAULT_EFFORT,
    state: "idle",
    topic: null,
    topicStale: false,
    customInstructions: customInstructions || null,
  };

  const managed: ManagedAgent = {
    info,
    session: null,
    sessionId: null,
    consumerPromise: null,
    pendingTurn: null,
    aborting: false,
    slashCommands: autocompleteCommands(),
    skills: deduplicateSkills([...discoverUserSkills(), ...discoverProjectSkills(resolvedCwd), ...discoverPluginSkills(), ...discoverBundledSkills()]),
    sdkReportedCommands: [],
    thinkingStartedAt: 0,
    toolCallTimestamps: new Map(),
    topicGenerating: false,
    topicMessageCount: 0,
    pendingResume: false,
    pendingResumeSessions: [],
    pendingModelPick: false,
    pendingEffortPick: false,
    pendingPermission: null,
    ptySidecar: null,
    ptyBuffer: "",
    lastWrittenEntryId: null,
  };
  agents.set(id, managed);
  emit({ type: "agent_added", agent: info });
  // Send commands immediately so autocomplete works before SDK init
  emit({
    type: "slash_commands",
    agentId: id,
    commands: managed.slashCommands,
    skills: managed.skills,
  });
  persistAll();

  // Create V2 session
  try {
    installSession(id, managed, createSession(managed));
    addLogEntry(id, "system", `Agent "${name}" ready. Working in ${resolvedCwd}. Permission mode: ${permissionMode}.`);
    // First stream() will deliver system/init + response to the first send().
  } catch (err: any) {
    console.error(`Failed to create session for ${name}:`, err.message);
    addLogEntry(id, "error", `Failed to start: ${err.message}`);
    updateState(id, "error");
  }

  return info;
}

// Wire up command handling — handlers depend on agent-manager's local helpers
// (emit, addLogEntry, replaceSession, …), so we instantiate via a deps object.
// The factory call also runs a startup assertion that every supported command
// in commands.ts has a matching handler.
const { handleSlashCommand } = createCommandHandling({
  agents,
  getRooms: () => rooms,
  getOfficeConfig: () => officeConfig,
  logCache,
  emit,
  addLogEntry,
  emitEphemeralLog,
  updateState,
  createSession,
  replaceSession,
  persistAll,
  persistCurrentSessionTopic,
  createTurnDeferred,
});

export async function sendMessage(agentId: string, text: string, username?: string, attachments?: Attachment[]) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (!managed.session) {
    // Try to create a fresh session so the user's next message doesn't silently vanish.
    try {
      installSession(agentId, managed, createSession(managed));
      managed.sessionId = null;
      addLogEntry(agentId, "system", "Started a fresh session (previous one could not be restored).");
      updateState(agentId, "waiting_for_response");
      // Fall through so the message is actually sent on the new session.
    } catch (err: any) {
      addLogEntry(agentId, "user_message", text, username ? { username } : undefined, attachments);
      addLogEntry(agentId, "error", `Cannot start session: ${err.message}`);
      updateState(agentId, "error");
      return;
    }
  }

  // Handle pending permission prompt: interpret reply as allow/deny.
  // Runs before slash-command interception by design — any typed slash command
  // while a prompt is pending is consumed as a deny reason, matching the
  // "anything else denies" contract shown to the user.
  if (managed.pendingPermission) {
    const pending = managed.pendingPermission;
    managed.pendingPermission = null;
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", text, userMeta);
    const trimmed = text.trim();
    if (trimmed === "1") {
      // Scope suggested rules to this session only so they don't leak across sessions.
      const sessionScoped = pending.suggestions?.map((s) => ({ ...s, destination: "session" as const }));
      emitEphemeralLog(agentId, "system", "Permission granted (rule added for this session).");
      pending.resolve({ behavior: "allow", updatedInput: pending.input, updatedPermissions: sessionScoped });
    } else if (trimmed === "2") {
      emitEphemeralLog(agentId, "system", "Permission granted (once).");
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
    } else if (trimmed === "3") {
      emitEphemeralLog(agentId, "system", "Permission denied.");
      pending.resolve({ behavior: "deny", message: "User denied." });
    } else {
      emitEphemeralLog(agentId, "system", "Permission denied with reason forwarded to agent.");
      pending.resolve({ behavior: "deny", message: text });
    }
    return;
  }

  // Handle /resume two-step: if pendingResume, check if input is a number pick
  if (managed.pendingResume) {
    managed.pendingResume = false;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= managed.pendingResumeSessions.length) {
      const userMeta = username ? { username } : undefined;
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = managed.pendingResumeSessions[num - 1];
      managed.pendingResumeSessions = [];
      // Persist current session topic before switching
      persistCurrentSessionTopic(agentId, managed);
      // Perform the resume
      try {
        const newSession = createSession(managed, picked.sessionId);
        await replaceSession(agentId, managed, newSession);
        managed.sessionId = picked.sessionId;
        managed.topicGenerating = false;
        managed.topicMessageCount = 0;
        // Clear and replay resumed session's logs (walks fork ancestry)
        const history = loadLogWithAncestors(agentId, picked.sessionId);
        logCache.set(agentId, []);
        emit({ type: "clear_logs", agentId });
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

  // Handle /model two-step: if pendingModelPick, check if input is a number pick
  if (managed.pendingModelPick) {
    managed.pendingModelPick = false;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= MODEL_FAMILIES.length) {
      const userMeta = username ? { username } : undefined;
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = MODEL_FAMILIES[num - 1];
      const label = familyDisplayLabel(picked.family);
      if (picked.family === managed.info.modelFamily) {
        emitEphemeralLog(agentId, "system", `Already using ${label}.`);
      } else {
        managed.info.modelFamily = picked.family;
        const sessionId = managed.sessionId;
        const newSession = sessionId ? createSession(managed, sessionId) : createSession(managed);
        await replaceSession(agentId, managed, newSession);
        emit({ type: "agent_updated", agentId, changes: { modelFamily: picked.family } });
        persistAll();
        addLogEntry(agentId, "system", `Model switched to ${label}. The agent's context may still say they are a different model — the correct model is shown in the top bar.`);
      }
      return;
    } else {
      emitEphemeralLog(agentId, "system", "Model selection cancelled.");
    }
  }

  // Handle /effort two-step: if pendingEffortPick, check if input is a number pick
  if (managed.pendingEffortPick) {
    managed.pendingEffortPick = false;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= EFFORT_LEVELS.length) {
      const userMeta = username ? { username } : undefined;
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = EFFORT_LEVELS[num - 1];
      const label = effortDisplayLabel(picked.level);
      if (picked.level === managed.info.effort) {
        emitEphemeralLog(agentId, "system", `Already using ${label}.`);
      } else {
        managed.info.effort = picked.level;
        const sessionId = managed.sessionId;
        const newSession = sessionId ? createSession(managed, sessionId) : createSession(managed);
        await replaceSession(agentId, managed, newSession);
        emit({ type: "agent_updated", agentId, changes: { effort: picked.level } });
        persistAll();
        addLogEntry(agentId, "system", `Thinking effort switched to ${label}.`);
      }
      return;
    } else {
      emitEphemeralLog(agentId, "system", "Effort selection cancelled.");
    }
  }

  // Intercept slash commands that are handled locally, not by the LLM
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const handled = await handleSlashCommand(agentId, managed, cmd, args, text, username);
    if (handled) return;
  }

  addLogEntry(agentId, "user_message", text, username ? { username } : undefined, attachments);
  updateState(agentId, "thinking");

  // Auto-generate topic on first user message in a conversation
  if (managed.info.topic === null && !managed.topicGenerating) {
    generateTopic(agentId); // fire-and-forget
  }

  const prefixedText = username ? `[${username}] ${text}` : text;
  try {
    const turn = createTurnDeferred(managed);
    if (attachments && attachments.length > 0) {
      const message = buildUserMessage(agentId, prefixedText, attachments);
      await managed.session!.send(message);
    } else {
      await managed.session!.send(prefixedText);
    }
    await turn;
  } catch (err: any) {
    if (err instanceof SessionSwappedError) return;
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

export async function abort(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  // If no turn is in flight, the SDK stream may have died (e.g. subprocess
  // exited) while the UI still shows "thinking". Reset state so Stop is
  // never a no-op.
  if (!managed.pendingTurn) {
    if (managed.info.state === "thinking" || managed.info.state === "tool_executing") {
      updateState(agentId, "waiting_for_response");
      addLogEntry(agentId, "system", "Agent interrupted (stream was already dead — state reset).");
    }
    return;
  }
  managed.aborting = true;
  const sessionId = managed.sessionId;

  try {
    const newSession = sessionId ? createSession(managed, sessionId) : createSession(managed);
    await replaceSession(agentId, managed, newSession);
    updateState(agentId, "waiting_for_response");
    addLogEntry(agentId, "system", "Agent interrupted.");
  } catch (err: any) {
    addLogEntry(agentId, "error", `Failed to resume after interrupt: ${err.message}`);
    updateState(agentId, "error");
  } finally {
    managed.aborting = false;
  }
}

export async function kill(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (managed.pendingPermission) {
    try { managed.pendingPermission.resolve({ behavior: "deny", message: "Agent killed." }); } catch {}
    managed.pendingPermission = null;
  }
  const turn = managed.pendingTurn;
  managed.pendingTurn = null;
  if (turn) { try { turn.reject(new Error("Agent killed.")); } catch {} }
  const oldConsumer = managed.consumerPromise;
  try { managed.session?.close(); } catch {}
  managed.session = null;
  // Remove from the map so the consumer's outer `agents.has(agentId)` guard exits.
  agents.delete(agentId);
  logCache.delete(agentId);
  if (oldConsumer) { try { await oldConsumer; } catch {} }
  killSidecar(managed);
  emit({ type: "agent_removed", agentId });
  persistAll();
}

export async function newConversation(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.pendingResume = false;
  managed.pendingResumeSessions = [];
  managed.pendingModelPick = false;
  managed.pendingEffortPick = false;
  persistCurrentSessionTopic(agentId, managed);

  try {
    const newSession = createSession(managed);
    await replaceSession(agentId, managed, newSession);
    managed.sessionId = null;
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
  managed.pendingModelPick = false;
  managed.pendingEffortPick = false;
  persistCurrentSessionTopic(agentId, managed);

  try {
    const newSession = createSession(managed, sessionId);
    await replaceSession(agentId, managed, newSession);
    managed.sessionId = sessionId;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;

    // Clear and replay resumed session's logs (walks fork ancestry for branched sessions)
    const history = loadLogWithAncestors(agentId, sessionId);
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId });
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

export async function editMessage(agentId: string, logEntryId: string, newText: string, username?: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (!managed.sessionId) {
    addLogEntry(agentId, "error", "Cannot edit: no active session.");
    return;
  }
  if (managed.info.state !== "waiting_for_response") {
    addLogEntry(agentId, "error", "Cannot edit while agent is busy.");
    return;
  }

  const oldSessionId = managed.sessionId;
  persistCurrentSessionTopic(agentId, managed);
  const oldLogCache = [...(logCache.get(agentId) ?? [])];
  const oldTopic = managed.info.topic;
  const oldTopicStale = managed.info.topicStale;

  try {
    // --- Phase 1: Fallible SDK operations (no UI/cache mutations yet) ---

    // 1. Find the target LogEntry in the current log cache
    const targetEntry = oldLogCache.find(e => e.id === logEntryId);
    if (!targetEntry || targetEntry.kind !== "user_message") {
      addLogEntry(agentId, "error", "Cannot edit: message not found.");
      return;
    }

    // 2. Get SDK session messages and match by content + occurrence index.
    //    For skill-expanded slash commands the log entry's `content` is the
    //    raw command (e.g. "/grill") but the SDK received the expanded prompt;
    //    `metadata.sdkText` captures that expanded form for matching.
    const sdkMessages = await getSessionMessages(oldSessionId);
    const targetUsername = targetEntry.metadata?.username as string | undefined;
    const targetSdkText = (targetEntry.metadata?.sdkText as string | undefined) ?? targetEntry.content;
    const prefixedContent = targetUsername ? `[${targetUsername}] ${targetSdkText}` : targetSdkText;

    // Count which occurrence of this exact content this is among user_message log entries
    const userLogEntries = oldLogCache.filter(e => e.kind === "user_message");
    let occurrenceIndex = 0;
    for (const e of userLogEntries) {
      const u = e.metadata?.username as string | undefined;
      const sdkText = (e.metadata?.sdkText as string | undefined) ?? e.content;
      const prefixed = u ? `[${u}] ${sdkText}` : sdkText;
      if (prefixed === prefixedContent) {
        if (e.id === logEntryId) break;
        occurrenceIndex++;
      }
    }

    // Find the matching SDK user message, and track the message just before it.
    // forkSession's upToMessageId is inclusive, so we fork at the predecessor to
    // exclude the original message — the edited text replaces it.
    let matchCount = 0;
    let targetIdx = -1;
    for (let i = 0; i < sdkMessages.length; i++) {
      const m = sdkMessages[i];
      if (m.type !== "user") continue;
      // SDK message format: { role: "user", content: [{ type: "text", text: "..." }, ...] }
      const msg = m.message as any;
      const contentBlocks = Array.isArray(msg?.content) ? msg.content
        : Array.isArray(msg) ? msg
        : typeof msg === "string" ? [{ type: "text", text: msg }]
        : [];
      const msgContent = contentBlocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (msgContent === prefixedContent) {
        if (matchCount === occurrenceIndex) {
          targetIdx = i;
          break;
        }
        matchCount++;
      }
    }

    if (targetIdx === -1) {
      addLogEntry(agentId, "error", "Cannot edit: could not locate message in SDK session.");
      return;
    }

    // 3. Fork the session. upToMessageId is inclusive, so we fork at the message
    //    just BEFORE the target to exclude the original text. For the first message,
    //    there's no predecessor — start a fresh session instead (equivalent to new
    //    conversation with different text, but preserving the original as branched).
    let newSessionId: string;
    let isFirstMessage = false;
    if (targetIdx === 0) {
      isFirstMessage = true;
      // No fork needed — we'll create a fresh session below (step 5)
      newSessionId = ""; // placeholder, set after createSession
    } else {
      const predecessorUuid = sdkMessages[targetIdx - 1].uuid;
      const forkResult = await forkSession(oldSessionId, { upToMessageId: predecessorUuid });
      newSessionId = forkResult.sessionId;
    }

    // 4. Persist fork metadata (skip for first-message edits — those are fresh sessions
    //    and will get their sessionId from the system/init event, like newConversation).
    if (!isFirstMessage) {
      // If the edited entry lives in an ancestor's JSONL (not the current session's own),
      // point forkedFrom at that ancestor directly. This collapses the chain so
      // loadLogWithAncestors cuts at the right level.
      let forkFromSessionId = oldSessionId;
      const ownEntries = loadLog(agentId, oldSessionId);
      if (!ownEntries.some(e => e.id === logEntryId)) {
        const sessMap = loadSessionsMap(agentId);
        let walk: string | undefined = sessMap[oldSessionId]?.forkedFrom;
        const visited = new Set<string>([oldSessionId]);
        while (walk && !visited.has(walk)) {
          visited.add(walk);
          const ancestorEntries = loadLog(agentId, walk);
          if (ancestorEntries.some(e => e.id === logEntryId)) {
            forkFromSessionId = walk;
            break;
          }
          walk = sessMap[walk]?.forkedFrom;
        }
      }
      // Find the parent's cumulative usage at the exact fork point (not the
      // parent's *current* cumulative, which may include later turns the user
      // continued in the original branch). Walk parent's log to find the fork
      // entry's position, then look up the latest snapshot whose anchor entry
      // sits before that position.
      const parentBase = findUsageAtFork(agentId, forkFromSessionId, logEntryId);
      persistSessionFork(agentId, newSessionId, forkFromSessionId, logEntryId, oldTopic, parentBase);
    }

    // 5. Create new session from fork (or fresh session for first-message edit), then close old
    const newSession = isFirstMessage ? createSession(managed) : createSession(managed, newSessionId);
    await replaceSession(agentId, managed, newSession);
    // For first-message edits, sessionId will be set by the system/init event (like newConversation).
    // For forks, set it now.
    managed.sessionId = isFirstMessage ? null : newSessionId;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;

    // --- Phase 2: UI/cache mutations (point of no return) ---

    // 6. Build parent entries (everything before the edited message)
    const parentEntries: LogEntry[] = [];
    for (const entry of oldLogCache) {
      if (entry.id === logEntryId) break;
      parentEntries.push(entry);
    }

    // 7. Clear UI and replay parent entries (not persisted — ancestors are loaded
    //    via loadLogWithAncestors on resume, avoiding log duplication on disk)
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId });
    if (parentEntries.length > 0) {
      logCache.set(agentId, [...parentEntries]);
      for (const entry of parentEntries) {
        emit({ type: "log_entry", entry });
      }
    }

    // 8. Add system log entry at branch point
    addLogEntry(agentId, "system", `Branched from: ${oldTopic || oldSessionId.slice(0, 8) + "..."}`);

    // 9. Inherit topic (marked stale so it regenerates after first exchange)
    managed.info.topic = oldTopic;
    managed.info.topicStale = true;
    emit({ type: "agent_updated", agentId, changes: { topic: oldTopic, topicStale: true } });

    // 10. Send the edited message
    updateState(agentId, "thinking");
    addLogEntry(agentId, "user_message", newText, username ? { username } : undefined);

    const prefixedNew = username ? `[${username}] ${newText}` : newText;
    const turn = createTurnDeferred(managed);
    await managed.session!.send(prefixedNew);
    await turn;

    persistAll();
  } catch (err: any) {
    // User aborted (or another explicit session swap) after the fork was
    // installed — the fork and its partial turn are a legitimate result,
    // not a failure. Skip the rollback.
    if (err instanceof SessionSwappedError) {
      persistAll();
      return;
    }
    console.error(`Agent ${agentId} edit/fork error:`, err.message);

    if (managed.sessionId !== oldSessionId) {
      // We switched to the fork — roll back to old session and restore UI
      try {
        const rollbackSession = createSession(managed, oldSessionId);
        await replaceSession(agentId, managed, rollbackSession);
        managed.sessionId = oldSessionId;
      } catch {
        // Can't restore session — leave in error state
      }

      // Restore the old log cache and UI
      logCache.set(agentId, oldLogCache);
      emit({ type: "clear_logs", agentId });
      for (const entry of oldLogCache) {
        emit({ type: "log_entry", entry });
      }

      // Restore topic
      managed.info.topic = oldTopic;
      managed.info.topicStale = oldTopicStale;
      emit({ type: "agent_updated", agentId, changes: { topic: oldTopic, topicStale: oldTopicStale } });
    }

    addLogEntry(agentId, "error", `Failed to branch conversation: ${err.message}`);
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

// --- Terminal PTY management — implementation in terminal.ts ---

const terminalDeps: TerminalDeps = {
  getAgent: (agentId) => agents.get(agentId),
  emit: (event) => emit(event),
};

export function openTerminal(agentId: string): boolean {
  return openTerminalImpl(agentId, terminalDeps);
}

export function getTerminalBuffer(agentId: string): string | null {
  return getTerminalBufferImpl(agentId, terminalDeps);
}

export function terminalInput(agentId: string, data: string) {
  terminalInputImpl(agentId, data, terminalDeps);
}

export function terminalResize(agentId: string, cols: number, rows: number) {
  terminalResizeImpl(agentId, cols, rows, terminalDeps);
}

export function closeTerminal(agentId: string) {
  closeTerminalImpl(agentId, terminalDeps);
}
