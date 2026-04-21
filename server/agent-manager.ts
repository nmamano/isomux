import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  forkSession,
  getSessionMessages,
  type SDKMessage,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { AgentInfo, AgentOutfit, AgentState, Attachment, ClaudeModel, LogEntry, ModelFamily, OfficeSettings, RoomWire, SkillInfo, SkillOrigin } from "../shared/types.ts";
import { MODEL_FAMILIES, FAMILY_TO_MODEL, familyDisplayLabel, generateRoomId } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import { appendLog, loadLog, loadLogWithAncestors, loadSessionsMap, loadAgents, saveAgents, listAgentSessions, listAllAgentIdsOnDisk, writeManifest, persistSessionTopic, persistSessionFork, accumulateSessionUsage, appendSessionUsageSnapshot, rollSessionUsageOnResume, loadOfficeConfig, saveOfficeConfig, readEnvFile, saveFile, getFilePath, loadAgentHistory, saveAgentHistory, type PersistedAgent, type PersistedUsage, type Room, type OfficeConfig, type AgentHistory } from "./persistence.ts";
import { createSafetyHooks } from "./safety-hooks.ts";
import { commands, autocompleteCommands, unsupportedMessage, type CommandConfig } from "./commands.ts";
import { resolve, join } from "path";
import { homedir } from "os";
import { mkdirSync, readdirSync, existsSync, readFileSync, rmSync, renameSync, statSync } from "fs";
import { execSync } from "child_process";

// Skills bundled with isomux itself (available to all users regardless of their config)
const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "skills");

// Path to the Claude CLI native binary that ships with the Agent SDK.
// The SDK's auto-resolver tries the musl variant first on Linux, which fails
// on glibc systems (ENOENT on /lib/ld-musl-*.so.1 when execve runs the binary).
// We resolve explicitly and pass it as pathToClaudeCodeExecutable so every
// libc gets the right binary.
const CLAUDE_NATIVE_BIN = resolveClaudeNativeBinary();

function resolveClaudeNativeBinary(): string {
  const anthropicDir = join(import.meta.dir, "..", "node_modules", "@anthropic-ai");
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  if (process.platform === "linux") {
    const muslArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const isMusl = existsSync(`/lib/ld-musl-${muslArch}.so.1`);
    const variants = isMusl
      ? [`linux-${process.arch}-musl`, `linux-${process.arch}`]
      : [`linux-${process.arch}`, `linux-${process.arch}-musl`];
    for (const v of variants) {
      const p = join(anthropicDir, `claude-agent-sdk-${v}`, binName);
      if (existsSync(p)) return p;
    }
  }
  return join(anthropicDir, `claude-agent-sdk-${process.platform}-${process.arch}`, binName);
}

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

// Extract description from SKILL.md / command .md YAML frontmatter
function extractSkillDescription(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    return descMatch ? descMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// Scan disk for user-defined skills and commands that the SDK doesn't report
function discoverUserSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  // Global user skills: ~/.claude/skills/<name>/SKILL.md
  const globalSkillsDir = join(homedir(), ".claude", "skills");
  if (existsSync(globalSkillsDir)) {
    try {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const description = extractSkillDescription(join(globalSkillsDir, entry.name, "SKILL.md"));
          skills.push({ name: entry.name, origin: "user", description });
        }
      }
    } catch {}
  }
  // Global user commands: ~/.claude/commands/<name>.md
  const globalCmdsDir = join(homedir(), ".claude", "commands");
  if (existsSync(globalCmdsDir)) {
    try {
      for (const entry of readdirSync(globalCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const description = extractSkillDescription(join(globalCmdsDir, entry.name));
          skills.push({ name: entry.name.replace(/\.md$/, ""), origin: "user", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Scan skills bundled with isomux
function discoverBundledSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const description = extractSkillDescription(join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md"));
          skills.push({ name: entry.name, origin: "isomux", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Also scan project-level skills for a given cwd
function discoverProjectSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  // Project commands: <cwd>/.claude/commands/<name>.md
  const projCmdsDir = join(cwd, ".claude", "commands");
  if (existsSync(projCmdsDir)) {
    try {
      for (const entry of readdirSync(projCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const description = extractSkillDescription(join(projCmdsDir, entry.name));
          skills.push({ name: entry.name.replace(/\.md$/, ""), origin: "project", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Scan skills from installed Claude Code plugins (~/.claude/plugins/)
function discoverPluginSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return skills;

  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return skills;
  }

  if (!manifest.plugins || typeof manifest.plugins !== "object") return skills;

  for (const [key, entries] of Object.entries(manifest.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const pluginName = key.split("@")[0];
    const installPath = (entries as any[])[0].installPath;
    if (!installPath || !existsSync(installPath)) continue;

    // skills/<name>/SKILL.md (check user-invocable frontmatter)
    const skillsDir = join(installPath, "skills");
    if (existsSync(skillsDir)) {
      try {
        for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const skillMd = join(skillsDir, d.name, "SKILL.md");
          if (!existsSync(skillMd)) continue;
          try {
            const content = readFileSync(skillMd, "utf-8");
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch && /user-invocable:\s*false/i.test(fmMatch[1])) continue;
          } catch {}
          const description = extractSkillDescription(skillMd);
          skills.push({ name: `${pluginName}:${d.name}`, origin: "plugin", description });
        }
      } catch {}
    }

    // commands/<name>.md (legacy format, always user-invocable)
    const cmdsDir = join(installPath, "commands");
    if (existsSync(cmdsDir)) {
      try {
        for (const f of readdirSync(cmdsDir, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith(".md")) {
            const description = extractSkillDescription(join(cmdsDir, f.name));
            skills.push({ name: `${pluginName}:${f.name.replace(/\.md$/, "")}`, origin: "plugin", description });
          }
        }
      } catch {}
    }
  }
  return skills;
}

// Deduplicate skills by name, keeping the first (highest-priority) occurrence
function deduplicateSkills(skills: SkillInfo[]): SkillInfo[] {
  const seen = new Set<string>();
  const result: SkillInfo[] = [];
  for (const s of skills) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      result.push(s);
    }
  }
  return result;
}

// Concatenate baseline boilerplate, office prompt, room prompt, and agent custom
// instructions into the exact string that gets injected as --append-system-prompt.
// Pure function so it can be reused by /isomux-system-prompt for inspection.
export function buildSystemPrompt(
  agentName: string,
  roomName: string,
  officePrompt?: string | null,
  roomPrompt?: string | null,
  customInstructions?: string | null,
): string {
  let systemPrompt = `You are ${agentName}, an agent in room ${roomName} of the Isomux office.
Your goal is to help the office bosses, who talk to you in this chat.
Messages are prefixed with the boss's name in brackets.

How to discover other office agents and their conversation logs: read ~/.isomux/agents-summary.json.

How to use the task board (localhost:4000/tasks): only touch it when the boss asks. When you do:
  curl -s localhost:4000/tasks                                          # list open tasks
  curl -s localhost:4000/tasks?status=all                               # include done
  curl -s -X POST localhost:4000/tasks -H 'Content-Type: application/json' \\
    -d '{"title":"...","createdBy":"${agentName}"}'                     # create
  curl -s -X POST localhost:4000/tasks/ID/claim -H 'Content-Type: application/json' \\
    -d '{"assignee":"${agentName}"}'                                    # claim
  curl -s -X POST localhost:4000/tasks/ID/done -d '{}'                  # mark done
Optional fields on create/update: description, priority (P0-P3), assignee.

How to show an image to the boss: read the image file with the Read tool — it renders inline in the conversation.

How to answer questions about Isomux itself: the source lives at https://github.com/nmamano/isomux. Read the README and the relevant code under server/, ui/, shared/, docs/ before answering.`;
  if (officePrompt) systemPrompt += `\n\n## Office Instructions\n\n${officePrompt}`;
  if (roomPrompt) systemPrompt += `\n\n## Instructions For Your Room: ${roomName}\n\n${roomPrompt}`;
  if (customInstructions) systemPrompt += `\n\n## Personal Instructions For You: ${agentName}\n\n${customInstructions}`;
  return systemPrompt;
}

// Internal agent state
interface ManagedAgent {
  info: AgentInfo;
  session: ReturnType<typeof unstable_v2_createSession> | null;
  sessionId: string | null;
  // Persistent consumer loop iterating `session.stream()` for the session's
  // lifetime. See docs/held-back-messages-investigation.md — without this,
  // task_notifications buffered between turns get flushed one turn late.
  consumerPromise: Promise<void> | null;
  // Per-turn deferred. sendMessage/executeSkill await this; the consumer
  // resolves it when the turn's `stream()` iterator ends at `result`.
  pendingTurn: { resolve: () => void; reject: (err: unknown) => void } | null;
  aborting: boolean;
  slashCommands: { name: string; description?: string }[];
  skills: SkillInfo[];
  sdkReportedCommands: string[]; // commands reported by SDK in system:init
  // Timing: track when phases start for duration_ms computation
  thinkingStartedAt: number;
  toolCallTimestamps: Map<string, number>; // toolUseId → start timestamp
  // Topic generation
  topicGenerating: boolean;
  topicMessageCount: number; // text entry count when topic was last generated
  // /resume two-step state
  pendingResume: boolean;
  pendingResumeSessions: { sessionId: string; lastModified: number; topic: string | null }[];
  // /model two-step state
  pendingModelPick: boolean;
  // Auto-mode permission prompt two-step state
  pendingPermission: {
    toolUseID: string;
    input: Record<string, unknown>;
    suggestions?: PermissionUpdate[];
    resolve: (r: PermissionResult) => void;
  } | null;
  // Terminal PTY sidecar (spawned on demand via Node.js)
  ptySidecar: import("bun").Subprocess | null;
  ptyBuffer: string; // buffered output for reconnecting browsers
  // /usage tracking. The SDK's `result` reports session-cumulative totals,
  // which are written to sessions.json on every turn (`usage` field) along
  // with a per-turn snapshot (`usageSnapshots`). /usage reads those entries
  // and aggregates per agent. Forked sessions subtract the parent's
  // cumulative-at-the-fork-point so shared turns aren't double-counted.
  lastWrittenEntryId: string | null;
}

type AgentEvent =
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null; envFile: string | null }
  | { type: "office_settings_updated"; prompt: string | null; envFile: string | null }
  | { type: "rooms_reordered"; order: string[] };

type EventHandler = (event: AgentEvent) => void;

// Internal room state: an ordered list of rooms, each with a stable id and its
// own settings. Agent membership is tracked on the agents map (agent.info.room
// is the index into this array — kept in sync for rendering).
interface InternalRoom {
  id: string;
  name: string;
  prompt: string | null;
  envFile: string | null;
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

export async function editAgent(agentId: string, changes: { name?: string; cwd?: string; outfit?: AgentInfo["outfit"]; customInstructions?: string; modelFamily?: ModelFamily; permissionMode?: AgentInfo["permissionMode"] }) {
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
  if (changes.permissionMode && changes.permissionMode !== managed.info.permissionMode) {
    managed.info.permissionMode = changes.permissionMode;
    updated.permissionMode = changes.permissionMode;
  }

  if (Object.keys(updated).length === 0) return;

  // System prompt + cwd are passed into every createSession, so name/cwd/
  // customInstructions changes automatically apply to the next conversation.

  // Recreate session if model or permission mode changed so it takes effect immediately
  if (updated.modelFamily || updated.permissionMode) {
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

// Thrown at an in-flight turn's deferred when its session is swapped out
// from under it (abort / resume / model switch / etc.). Callers of
// sendMessage / executeSkill / editMessage filter this out so a user-
// initiated interrupt doesn't surface as a scary log entry.
class SessionSwappedError extends Error {
  constructor(message = "Session replaced.") {
    super(message);
    this.name = "SessionSwappedError";
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
      const hints = diagnoseProcessExit(managed);
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

// Resolve ~ in paths
function resolveCwd(cwd: string): string {
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  if (cwd === "~") return homedir();
  return resolve(cwd);
}

// Directory where Claude CLI stores per-project session JSONLs.
// Sanitization observed: any non-alphanumeric, non-hyphen char becomes "-".
// Ex: /home/nil/nilmamano.com -> -home-nil-nilmamano-com
function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
}

function claudeSessionFileExists(cwd: string, sessionId: string): boolean {
  return existsSync(join(claudeProjectDir(cwd), `${sessionId}.jsonl`));
}

// Move an agent's Claude CLI session files from one cwd's project dir to another.
// The Claude CLI derives its session storage path from cwd, so changing an agent's cwd
// without moving these files orphans every session on the next respawn (e.g. server restart).
function moveClaudeSessionFiles(agentId: string, oldCwd: string, newCwd: string) {
  const oldDir = claudeProjectDir(oldCwd);
  const newDir = claudeProjectDir(newCwd);
  if (oldDir === newDir || !existsSync(oldDir)) return;
  const sessions = listAgentSessions(agentId);
  if (sessions.length === 0) return;
  mkdirSync(newDir, { recursive: true });
  for (const { sessionId } of sessions) {
    const oldJsonl = join(oldDir, `${sessionId}.jsonl`);
    const newJsonl = join(newDir, `${sessionId}.jsonl`);
    if (existsSync(oldJsonl) && !existsSync(newJsonl)) {
      try { renameSync(oldJsonl, newJsonl); } catch (err) {
        console.error(`[cwd-change] Failed to move ${oldJsonl} -> ${newJsonl}:`, err);
      }
    }
    // Claude CLI also writes a sibling <sessionId>/ dir (tool-results cache, etc.)
    const oldSib = join(oldDir, sessionId);
    const newSib = join(newDir, sessionId);
    if (existsSync(oldSib) && !existsSync(newSib)) {
      try { renameSync(oldSib, newSib); } catch (err) {
        console.error(`[cwd-change] Failed to move ${oldSib} -> ${newSib}:`, err);
      }
    }
  }
}

// Produce a human-readable hint for why the Claude CLI subprocess may have died,
// to go alongside the SDK's generic "process exited with code 1". Returns null if
// no specific cause is identifiable.
function diagnoseProcessExit(managed: ManagedAgent): string | null {
  const cwd = managed.info.cwd;
  try {
    validateCwd(cwd);
  } catch {
    return `Likely cause: cwd \`${cwd}\` no longer exists. Click the agent name in the log view header to point it at a valid directory.`;
  }
  if (managed.sessionId && !claudeSessionFileExists(cwd, managed.sessionId)) {
    return (
      `Likely cause: session \`${managed.sessionId.slice(0, 8)}…\` was not found in \`${claudeProjectDir(cwd)}\`. ` +
      `This usually happens after cwd was moved/renamed — the Claude CLI locates session files by a path derived from cwd. ` +
      `Use /resume to pick another session, or move the session .jsonl into the new project dir.`
    );
  }
  return null;
}

// Resolve and verify a cwd. Throws if the directory does not exist or is not a directory.
export function validateCwd(cwd: string): string {
  const resolved = resolveCwd(cwd);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new Error(`Directory does not exist: ${resolved}`);
    throw new Error(`Cannot access ${resolved}: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return resolved;
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
  // inject --append-system-prompt via executableArgs. When
  // pathToClaudeCodeExecutable is a native binary, executableArgs are prepended
  // to the CLI args verbatim (verified against SDK 0.2.116 sdk.mjs).
  const opts: any = {
    model: FAMILY_TO_MODEL[managed.info.modelFamily],
    permissionMode: managed.info.permissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    executableArgs: ["--append-system-prompt", systemPrompt],
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

export async function spawn(name: string, cwd: string, permissionMode: AgentInfo["permissionMode"], desk?: number, customInstructions?: string, roomId?: string, outfit?: AgentOutfit, modelFamily?: ModelFamily): Promise<AgentInfo | null> {
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
  } as any);
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

// Extensions that should be sent as text content blocks
const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "cfg",
  "sh", "bash", "py", "js", "ts", "go", "rs", "c", "h", "cpp", "java", "rb",
  "html", "css", "sql", "env", "conf",
]);

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function buildUserMessage(agentId: string, text: string, attachments: Attachment[]): SDKUserMessage {
  const content: ContentBlockParam[] = [];

  // Text block first (if non-empty)
  if (text) {
    content.push({ type: "text", text });
  }

  // Attachment blocks
  for (const att of attachments) {
    const filePath = getFilePath(agentId, att.filename);
    if (!filePath) continue;

    if (IMAGE_MEDIA_TYPES.has(att.mediaType)) {
      const data = readFileSync(filePath).toString("base64");
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data,
        },
      });
    } else if (att.mediaType === "application/pdf") {
      // Claude API limits: 100 pages, ~32MB base64. Check file size as a proxy.
      const stats = statSync(filePath);
      if (stats.size > 10 * 1024 * 1024) {
        // Too large to send inline — give the agent the file path instead
        content.push({
          type: "text",
          text: `Attached PDF "${att.originalName}" (${(stats.size / 1024 / 1024).toFixed(1)}MB) is too large to display inline. The file is saved at: ${filePath}`,
        });
      } else {
        const data = readFileSync(filePath).toString("base64");
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data,
          },
        });
      }
    } else {
      const ext = att.originalName.includes(".") ? att.originalName.split(".").pop()!.toLowerCase() : "";
      if (TEXT_FILE_EXTENSIONS.has(ext)) {
        const fileContent = readFileSync(filePath, "utf-8");
        content.push({
          type: "text",
          text: `--- File: ${att.originalName} ---\n${fileContent}\n---`,
        });
      } else {
        content.push({
          type: "text",
          text: `Attached file ${att.originalName} (unable to see content) [Reminder: do not pretend that you can see it or infer its content]`,
        });
      }
    }
  }

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

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

// ---------------------------------------------------------------------------
// Command handler registry — each supported command maps to a handler function.
// The handler key in commands.ts must match a key here.
// ---------------------------------------------------------------------------

type HandlerFn = (agentId: string, managed: ManagedAgent, args: string[], rawText: string, username?: string) => Promise<boolean>;

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatTokenCount(n: number): string {
  if (n === 0) return "—";
  // 999_500 rounds to "1000k" under naive thresholds; promote to M.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString();
}

function renderUsageReport(): string {
  const lines: string[] = [];

  lines.push(
    `_Subscription plan limits aren't shown here — open the embedded terminal (desktop only), run \`claude\`, then \`/usage\`._`,
  );
  lines.push("");

  // Office-wide table: per-agent session and lifetime usage. "In" is all
  // input tiers summed (raw + cache read + cache creation); the inline "%
  // hit" is cache hit rate over cacheable input. Markdown only supports a
  // single header row, so session/lifetime groupings are encoded as
  // parenthesised suffixes on each column.
  lines.push(`## Agent usage`);
  lines.push("");
  lines.push(`| Agent | Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  const rows = [...agents.values()].map((a) => {
    const usage = readAgentUsage(a.info.id, a.sessionId);
    const roomName = rooms[a.info.room]?.name ?? "?";
    return { id: a.info.id, name: a.info.name, room: roomName, sess: usage.session, life: usage.lifetime };
  });
  rows.sort((a, b) => b.life.costUSD - a.life.costUSD);
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${r.room} | ${formatInCell(r.sess)} | ${formatTokenCount(r.sess.totalOut)} | ${formatUsd(r.sess.costUSD)} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
    );
  }

  // Per-room totals + grand total. Each agent (live or killed) contributes to
  // the room it was last in — resolved via agent-history.json, which persists
  // each live agent's room on every persistAll. Rooms that have since been
  // deleted still appear, labeled "(deleted)", so prior spend isn't lost.
  // Buckets are keyed by stable roomId; current-room names override historical
  // names so renames are reflected immediately.
  const liveAgentIds = new Set([...agents.values()].map((a) => a.info.id));
  const history = loadAgentHistory();
  type RoomBucket = { id: string; name: string; deleted: boolean; sess: UsageBucket; life: UsageBucket };
  const roomBuckets = new Map<string, RoomBucket>();
  const getBucket = (id: string, name: string, deleted: boolean): RoomBucket => {
    let b = roomBuckets.get(id);
    if (!b) {
      b = { id, name, deleted, sess: emptyBucket(), life: emptyBucket() };
      roomBuckets.set(id, b);
    }
    return b;
  };
  // Seed with all current rooms so they show even when empty.
  for (const r of rooms) getBucket(r.id, r.name, false);

  for (const a of agents.values()) {
    const room = rooms[a.info.room];
    if (!room) continue;
    const usage = readAgentUsage(a.info.id, a.sessionId);
    const b = getBucket(room.id, room.name, false);
    addBucket(b.sess, usage.session);
    addBucket(b.life, usage.lifetime);
  }
  for (const id of listAllAgentIdsOnDisk()) {
    if (liveAgentIds.has(id)) continue;
    const h = history[id];
    // Killed agents without a history entry predate this feature; drop into a
    // synthetic bucket so their spend is still counted toward the grand total.
    const roomId = h?.lastRoomId ?? "__unknown__";
    const currentRoom = rooms.find((r) => r.id === roomId);
    const name = currentRoom?.name ?? h?.lastRoomName ?? "(unknown room)";
    const deleted = !currentRoom;
    const usage = readAgentUsage(id, null);
    const b = getBucket(roomId, name, deleted);
    addBucket(b.life, usage.lifetime);
  }

  const total = { sess: emptyBucket(), life: emptyBucket() };
  for (const b of roomBuckets.values()) {
    addBucket(total.sess, b.sess);
    addBucket(total.life, b.life);
  }

  const sortedBuckets = [...roomBuckets.values()].sort((a, b) => b.life.costUSD - a.life.costUSD);

  lines.push("");
  lines.push(`## Per-room usage`);
  lines.push("");
  lines.push(`_Agents contribute to the room they were last in (killed agents included)._`);
  lines.push("");
  lines.push(`| Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of sortedBuckets) {
    const label = r.deleted ? `${r.name} _(deleted)_` : r.name;
    lines.push(
      `| ${label} | ${formatInCell(r.sess)} | ${formatTokenCount(r.sess.totalOut)} | ${formatUsd(r.sess.costUSD)} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
    );
  }
  lines.push(
    `| **Total** | ${formatInCell(total.sess)} | ${formatTokenCount(total.sess.totalOut)} | ${formatUsd(total.sess.costUSD)} | ${formatInCell(total.life)} | ${formatTokenCount(total.life.totalOut)} | ${formatUsd(total.life.costUSD)} |`,
  );

  return lines.join("\n");
}

function addBucket(dst: UsageBucket, src: UsageBucket) {
  dst.totalIn += src.totalIn;
  dst.cacheRead += src.cacheRead;
  dst.cacheCreation += src.cacheCreation;
  dst.totalOut += src.totalOut;
  dst.costUSD += src.costUSD;
}

// `cacheRead` is discounted cache hits; `cacheCreation` is the 1.25x write
// tier. Raw `input_tokens` (uncached) is usually ~10 — just the new user
// message — so "cached as a % of totalIn" is always ~100% and meaningless.
// The useful signal is hit-rate over *cacheable* input: cacheRead / (cacheRead
// + cacheCreation), which drops when the cache expires and gets rewritten.
interface UsageBucket { totalIn: number; cacheRead: number; cacheCreation: number; totalOut: number; costUSD: number; }

function emptyBucket(): UsageBucket {
  return { totalIn: 0, cacheRead: 0, cacheCreation: 0, totalOut: 0, costUSD: 0 };
}

// Read an agent's per-session usage off disk and aggregate into:
//   - session: usage for `currentSessionId` (the agent's active conversation)
//   - lifetime: sum of (entry.usage - entry.forkBaseUsage) across all entries
// `forkBaseUsage` is captured at fork creation by walking the parent's log to
// find the cumulative usage at the exact fork point, so each fork contributes
// only its own new work — no double-counting of the shared parent prefix.
function readAgentUsage(agentId: string, currentSessionId: string | null): { session: UsageBucket; lifetime: UsageBucket } {
  const map = loadSessionsMap(agentId);
  const lifetime = emptyBucket();
  for (const entry of Object.values(map)) {
    if (!entry.usage && !entry.priorRunsUsage) continue;
    const u = entry.usage;
    const p = entry.priorRunsUsage;
    const base = entry.forkBaseUsage;
    // Session total = current-run + all prior completed runs (if any).
    const inputTokens = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0);
    const outputTokens = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
    const cacheReadInputTokens = (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    const cacheCreationInputTokens = (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    const costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
    lifetime.totalIn += inputTokens + cacheReadInputTokens + cacheCreationInputTokens
      - ((base?.inputTokens ?? 0) + (base?.cacheReadInputTokens ?? 0) + (base?.cacheCreationInputTokens ?? 0));
    lifetime.cacheRead += cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0);
    lifetime.cacheCreation += cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0);
    lifetime.totalOut += outputTokens - (base?.outputTokens ?? 0);
    lifetime.costUSD += costUSD - (base?.costUSD ?? 0);
  }
  const session = emptyBucket();
  const sessEntry = currentSessionId ? map[currentSessionId] : undefined;
  if (sessEntry && (sessEntry.usage || sessEntry.priorRunsUsage)) {
    const u = sessEntry.usage;
    const p = sessEntry.priorRunsUsage;
    session.totalIn = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0)
      + (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0)
      + (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    session.cacheRead = (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    session.cacheCreation = (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    session.totalOut = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
    session.costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
  }
  return { session, lifetime };
}

// Locate a parent's cumulative usage at a fork point. Walks the parent's log
// to find `forkMessageId`'s position, then returns the latest snapshot whose
// anchor entry sits before that position. When the parent has no snapshots
// (e.g. it predates snapshot tracking), fall back to the parent's current
// cumulative `usage` — best-effort, slightly over-subtracts if the parent
// continued past the fork, but bounded and avoids a full prefix double-count
// in lifetime totals.
function findUsageAtFork(agentId: string, parentSessionId: string, forkMessageId: string): PersistedUsage | undefined {
  const entries = loadLog(agentId, parentSessionId);
  const positions = new Map<string, number>();
  entries.forEach((e, i) => positions.set(e.id, i));
  const forkPos = positions.get(forkMessageId);
  if (forkPos === undefined) return undefined;
  const parentMeta = loadSessionsMap(agentId)[parentSessionId];
  const snapshots = parentMeta?.usageSnapshots ?? [];
  let best: PersistedUsage | undefined;
  let bestPos = -1;
  for (const snap of snapshots) {
    const p = positions.get(snap.entryId);
    if (p === undefined) continue;
    if (p < forkPos && p > bestPos) {
      bestPos = p;
      best = snap.usage;
    }
  }
  // Fallback when no snapshot sits before the fork point: use the parent's
  // current cumulative (priorRunsUsage + usage). After a resume with no new
  // results yet, `usage` may be undefined while priorRunsUsage holds the real
  // value — sum both so forks off just-resumed parents still get a base.
  if (best) return best;
  const u = parentMeta?.usage;
  const p = parentMeta?.priorRunsUsage;
  if (!u && !p) return undefined;
  return {
    inputTokens: (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0),
    outputTokens: (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0),
    cacheReadInputTokens: (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0),
    costUSD: (u?.costUSD ?? 0) + (p?.costUSD ?? 0),
  };
}

// Hide the (N% hit) suffix above 80% since typical usage hovers 92-100% and the
// clutter drowns out the signal. Showing only low hit rates turns absence into
// the default and presence into a cache-thrash canary.
const CACHE_HIT_WARN_THRESHOLD = 80;

function formatInCell(b: UsageBucket): string {
  if (b.totalIn === 0) return "—";
  const cacheable = b.cacheRead + b.cacheCreation;
  if (cacheable === 0) return formatTokenCount(b.totalIn);
  const pct = Math.round((b.cacheRead / cacheable) * 100);
  if (pct >= CACHE_HIT_WARN_THRESHOLD) return formatTokenCount(b.totalIn);
  return `${formatTokenCount(b.totalIn)} (${pct}% hit)`;
}

function formatUsd(n: number): string {
  if (n === 0) return "—";
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

const commandHandlers: Record<string, HandlerFn> = {
  async clear(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    managed.pendingResume = false;
    managed.pendingResumeSessions = [];
    managed.pendingModelPick = false;
    persistCurrentSessionTopic(agentId, managed);
    await replaceSession(agentId, managed, createSession(managed));
    managed.sessionId = null;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;
    managed.info.topic = null;
    managed.info.topicStale = false;
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId } as any);
    emit({ type: "agent_updated", agentId, changes: { topic: null, topicStale: false } });
    emitEphemeralLog(agentId, "system", "Conversation cleared.");
    updateState(agentId, "idle");
    persistAll();
    return true;
  },

  async context(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    if (!managed.session) {
      emitEphemeralLog(agentId, "system", "No active session.");
      return true;
    }
    try {
      const query = (managed.session as any).query;
      if (!query?.getContextUsage) {
        emitEphemeralLog(agentId, "system", "Context usage not available for this session.");
        return true;
      }
      const ctx = await query.getContextUsage();
      const lines: string[] = [];

      const pct = Math.round(ctx.percentage);
      const barLen = 30;
      const filled = Math.round(barLen * ctx.percentage / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
      lines.push(`**${ctx.model}** \u2014 ${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens (${pct}%)`);
      lines.push(`\`${bar}\``);

      if (ctx.categories?.length > 0) {
        lines.push("");
        for (const cat of ctx.categories) {
          if (cat.tokens > 0) {
            const catPct = ((cat.tokens / ctx.maxTokens) * 100).toFixed(1);
            lines.push(`  ${cat.name}: ${cat.tokens.toLocaleString()} tokens (${catPct}%)`);
          }
        }
      }

      if (ctx.memoryFiles?.length > 0) {
        lines.push("\n**Memory files:**");
        for (const f of ctx.memoryFiles) {
          lines.push(`  ${f.path} (${f.tokens.toLocaleString()} tokens)`);
        }
      }

      if (ctx.systemPromptSections?.length > 0) {
        lines.push("\n**System prompt:**");
        for (const s of ctx.systemPromptSections) {
          lines.push(`  ${s.name}: ${s.tokens.toLocaleString()} tokens`);
        }
      }

      if (ctx.isAutoCompactEnabled && ctx.autoCompactThreshold) {
        const compactPct = Math.round((ctx.autoCompactThreshold / ctx.maxTokens) * 100);
        lines.push(`\nAuto-compact at ${compactPct}% (${ctx.autoCompactThreshold.toLocaleString()} tokens)`);
      }

      emitEphemeralLog(agentId, "system", lines.join("\n"));
    } catch (err: any) {
      emitEphemeralLog(agentId, "system", `Failed to get context usage: ${err.message}`);
    }
    return true;
  },

  async help(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    addLogEntry(agentId, "user_message", rawText, userMeta);

    const lines: string[] = [];

    // Agent metadata
    const topicLine = managed.info.topic ? `  Topic: ${managed.info.topic}` : "";
    lines.push(`**${managed.info.name}** — Room ${managed.info.room + 1}, Desk ${managed.info.desk + 1}`);
    lines.push(`  cwd: \`${managed.info.cwd}\``);
    if (topicLine) lines.push(topicLine);
    lines.push("");

    // Isomux description
    lines.push("Isomux is a multi-agent office manager for Claude Code. Learn more at https://isomux.com");
    lines.push("");

    // Commands
    const cmdList = managed.slashCommands.map((c) => c.description ? `  \`/${c.name}\`  — ${c.description}` : `  \`/${c.name}\``).join("\n");
    lines.push(`**Commands:**\n${cmdList}`);

    // Skills grouped by origin
    const originLabel: Record<SkillOrigin, string> = {
      user: "User skills",
      project: "Project skills",
      plugin: "Plugin skills",
      isomux: "Isomux skills",
      claude: "Claude skills",
    };
    const originOrder: SkillOrigin[] = ["isomux", "user", "project", "plugin", "claude"];
    const grouped = new Map<SkillOrigin, SkillInfo[]>();
    for (const s of managed.skills) {
      if (!grouped.has(s.origin)) grouped.set(s.origin, []);
      grouped.get(s.origin)!.push(s);
    }
    for (const origin of originOrder) {
      const skills = grouped.get(origin);
      if (!skills || skills.length === 0) continue;
      const skillLines = skills.map((s) => {
        const desc = s.description ? ` — ${s.description}` : "";
        return `  \`/${s.name}\`${desc}`;
      }).join("\n");
      lines.push(`\n**${originLabel[origin]}:**\n${skillLines}`);
    }

    // Tips
    lines.push("\n**Tips:**");
    lines.push("  \u2022 Isomux also works on your phone. The easiest way is to connect it to the same tailscale network as the machine running it (it's free).");
    lines.push("  \u2022 The built-in side-panel terminal is useful for one-off situations where you need to run something manually, like auth flows.");
    lines.push("  \u2022 Isomux comes with safety pre-tool-call hooks to prevent destructive commands, like `rm -rf /`.");
    lines.push("  \u2022 Isomux agents can check what other agents are up to in real time. Just ask naturally.");
    lines.push("  \u2022 Use voice-to-text for faster prompting. The shortcut is ctrl+space.");
    lines.push("  \u2022 Use `/isomux-all-hands` to check what every agent is up to.");
    lines.push("  \u2022 Use `/report-isomux-bug` if you find any issues.");
    lines.push("  \u2022 Use `/isomux-grill-me` to make your feature designs more robust.");

    addLogEntry(agentId, "system", lines.join("\n"));
    updateState(agentId, "waiting_for_response");
    return true;
  },

  async resume(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
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
      const rawLabel = s.topic || s.sessionId.slice(0, 8) + "...";
      const label = s.forked ? `↳ ${rawLabel}` : rawLabel;
      const suffix = s.branched ? "  (branched)" : "";
      if (s.sessionId === managed.sessionId) {
        lines.push(`  \u25cf ${label}  ${dateStr}  (current)`);
      } else {
        lines.push(`  ${num}. ${label}  ${dateStr}${suffix}`);
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
  },

  async model(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    const currentLabel = familyDisplayLabel(managed.info.modelFamily);
    const lines: string[] = [`Switch model (current: **${currentLabel}**):\n`];
    for (let i = 0; i < MODEL_FAMILIES.length; i++) {
      const m = MODEL_FAMILIES[i];
      const marker = m.family === managed.info.modelFamily ? " (current)" : "";
      lines.push(`  ${i + 1}. ${familyDisplayLabel(m.family)}${marker}`);
    }
    lines.push("\nReply with a number to switch, or anything else to cancel.");
    emitEphemeralLog(agentId, "system", lines.join("\n"));
    managed.pendingModelPick = true;
    updateState(agentId, "waiting_for_response");
    return true;
  },

  async isomuxAllHands(agentId, _managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    addLogEntry(agentId, "user_message", rawText, userMeta);

    // Gather all agents grouped by room
    const allAgents = [...agents.values()];
    const roomMap = new Map<number, ManagedAgent[]>();
    for (const a of allAgents) {
      const room = a.info.room;
      if (!roomMap.has(room)) roomMap.set(room, []);
      roomMap.get(room)!.push(a);
    }

    const lines: string[] = [];
    const sortedRooms = [...roomMap.keys()].sort((a, b) => a - b);

    for (const room of sortedRooms) {
      const roomAgents = roomMap.get(room)!.sort((a, b) => a.info.desk - b.info.desk);
      lines.push(`**=== Room ${room + 1} ===**`);
      lines.push("");

      for (const a of roomAgents) {
        const selfTag = a.info.id === agentId ? "  **(me)**" : "";
        const modelLabel = familyDisplayLabel(a.info.modelFamily);
        lines.push(`**${a.info.name}** (desk ${a.info.desk + 1})${selfTag} — ${modelLabel} — \`${a.info.cwd}\``);

        const sessions = listAgentSessions(a.info.id);
        if (sessions.length === 0) {
          lines.push("  (no conversations)");
        } else {
          let num = 1;
          for (const s of sessions) {
            const label = s.topic || s.sessionId.slice(0, 8) + "...";
            const ago = formatRelativeTime(s.lastModified);
            lines.push(`  ${num}. ${label}  (${ago})`);
            num++;
          }
        }
        lines.push("");
      }
    }

    lines.push("Ask your agent if you'd like to know more about any agent or conversation.");

    addLogEntry(agentId, "system", lines.join("\n"));
    updateState(agentId, "waiting_for_response");
    return true;
  },

  async isomuxSystemPrompt(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    const room = rooms[managed.info.room]!;
    const prompt = buildSystemPrompt(
      managed.info.name,
      room.name,
      officeConfig.prompt,
      room.prompt,
      managed.info.customInstructions,
    );
    // Pick a fence longer than any backtick run inside the prompt so the block
    // renders verbatim regardless of what office/room/agent prompts contain.
    const longestRun = (prompt.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    const header = "**Full system prompt** *(reflects current settings; takes effect on next conversation)*";
    emitEphemeralLog(agentId, "system", `${header}\n\n${fence}plaintext\n${prompt}\n${fence}`);
    updateState(agentId, "waiting_for_response");
    return true;
  },

  async isomuxDiff(agentId, managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    const cwd = managed.info.cwd;

    const runGit = (args: string, maxBuffer = 10 * 1024 * 1024) =>
      execSync(`git ${args}`, { cwd, timeout: 10000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] }).toString();

    try {
      runGit("rev-parse --is-inside-work-tree", 1024);
    } catch {
      emitEphemeralLog(agentId, "system", `\`${cwd}\` is not a git repository.`);
      updateState(agentId, "waiting_for_response");
      return true;
    }

    let stat = "";
    let diff = "";
    let untracked: string[] = [];
    try {
      // Prefer HEAD (includes staged+unstaged). Fall back to workdir-only if HEAD is missing (fresh repo).
      try {
        stat = runGit("diff HEAD --stat").trim();
        diff = runGit("diff HEAD", 50 * 1024 * 1024);
      } catch {
        stat = runGit("diff --stat").trim();
        diff = runGit("diff", 50 * 1024 * 1024);
      }
      const untrackedOut = runGit("ls-files --others --exclude-standard").trim();
      if (untrackedOut) untracked = untrackedOut.split("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEphemeralLog(agentId, "system", `Failed to run git diff in \`${cwd}\`:\n\n\`\`\`\n${msg}\n\`\`\``);
      updateState(agentId, "waiting_for_response");
      return true;
    }

    const parts: string[] = [];
    parts.push(`**Uncommitted changes in** \`${cwd}\``);
    parts.push("");

    if (!stat && untracked.length === 0) {
      parts.push("*Working tree clean — no uncommitted changes.*");
    } else {
      if (stat) {
        parts.push("```");
        parts.push(stat);
        parts.push("```");
      }
      if (diff.trim()) {
        const MAX = 500_000;
        let body = diff;
        let truncated = false;
        if (body.length > MAX) {
          body = body.slice(0, MAX);
          truncated = true;
        }
        const longestRun = (body.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
        const fence = "`".repeat(Math.max(3, longestRun + 1));
        parts.push("");
        parts.push(`${fence}diff`);
        parts.push(body);
        parts.push(fence);
        if (truncated) parts.push(`\n*Diff truncated at ${MAX.toLocaleString()} bytes — run \`git diff HEAD\` for the full patch.*`);
      }
      if (untracked.length > 0) {
        parts.push("");
        parts.push(`**Untracked files (${untracked.length}):**`);
        for (const f of untracked) parts.push(`- \`${f}\``);
      }
    }

    emitEphemeralLog(agentId, "system", parts.join("\n"));
    updateState(agentId, "waiting_for_response");
    return true;
  },

  async usage(agentId, _managed, _args, rawText, username) {
    const userMeta = username ? { username } : undefined;
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    emitEphemeralLog(agentId, "system", renderUsageReport());
    updateState(agentId, "waiting_for_response");
    return true;
  },
};

// Startup assertion: every supported command with a handler key must have a matching handler
for (const [name, cfg] of Object.entries(commands)) {
  if (cfg.supported && cfg.handler && !commandHandlers[cfg.handler]) {
    throw new Error(`Command /${name} is marked supported with handler "${cfg.handler}" but no handler exists`);
  }
}

// ---------------------------------------------------------------------------
// Slash command resolution — 5-step priority order (see docs/slash-command-design.md)
// ---------------------------------------------------------------------------

async function handleSlashCommand(agentId: string, managed: ManagedAgent, cmd: string, args: string[], rawText: string, username?: string): Promise<boolean> {
  const userMeta = username ? { username } : undefined;
  const cfg: CommandConfig | undefined = commands[cmd];

  // Step 1: Config lookup (non-overridable)
  if (cfg && !cfg.overridable) {
    if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
      return commandHandlers[cfg.handler](agentId, managed, args, rawText, username);
    }
    // Unsupported non-overridable command — show message
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
    return true;
  }

  // Step 2: Skill override check (for overridable config entries OR unknown commands)
  const skillPrompt = resolveSkillPrompt(cmd, managed.info.cwd);
  if (skillPrompt) {
    return executeSkill(agentId, managed, skillPrompt, args, rawText, username);
  }

  // Step 3: Config lookup (overridable, no skill found)
  if (cfg && cfg.overridable) {
    if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
      return commandHandlers[cfg.handler](agentId, managed, args, rawText, username);
    }
    // Unsupported overridable command with no skill override
    emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
    return true;
  }

  // Step 4: SDK-reported commands — pass through to the agent via session.send()
  if (managed.sdkReportedCommands.includes(cmd)) {
    return false; // let sendMessage() pass it through
  }

  // Step 5: Unknown command
  emitEphemeralLog(agentId, "user_message", rawText, userMeta);
  emitEphemeralLog(agentId, "system", `Unknown command \`/${cmd}\`. Type \`/help\` to see available commands.`);
  return true;
}

// Execute a resolved skill prompt by sending it to the agent
async function executeSkill(agentId: string, managed: ManagedAgent, skillPrompt: string, args: string[], rawText: string, username?: string): Promise<boolean> {
  const userMeta = username ? { username } : undefined;
  const userArgs = args.join(" ");
  const fullPrompt = userArgs
    ? `${skillPrompt}\n\nUser context: ${userArgs}`
    : skillPrompt;
  addLogEntry(agentId, "user_message", rawText, userMeta);
  updateState(agentId, "thinking");
  const prefixedSkillPrompt = username ? `[${username}] ${fullPrompt}` : fullPrompt;
  try {
    const turn = createTurnDeferred(managed);
    await managed.session!.send(prefixedSkillPrompt);
    await turn;
  } catch (err: any) {
    if (err instanceof SessionSwappedError) return true;
    addLogEntry(agentId, "error", `Skill error: ${err.message}`);
    updateState(agentId, "error");
  }
  return true;
}

// Read a skill file, stripping YAML frontmatter
function readSkillFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
    return stripped.trim();
  } catch {
    return null;
  }
}

// Resolve a plugin-namespaced skill (e.g., "codex:rescue") to its prompt text
function resolvePluginSkillPrompt(pluginName: string, skillName: string): string | null {
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch { return null; }

  const pluginKey = Object.keys(manifest.plugins ?? {}).find(k => k.split("@")[0] === pluginName);
  if (!pluginKey) return null;
  const entries = manifest.plugins[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const installPath = entries[0].installPath;
  if (!installPath) return null;

  return readSkillFile(join(installPath, "skills", skillName, "SKILL.md"))
    ?? readSkillFile(join(installPath, "commands", `${skillName}.md`));
}

// Resolve a skill name to its prompt text, checking skill dirs in priority order:
// 1. User skills (~/.claude/) — highest skill tier
// 2. Project skills (<cwd>/.claude/)
// 3. Plugin skills (~/.claude/plugins/) — namespaced with "plugin:skill"
// 4. Isomux bundled skills (isomux/skills/)
function resolveSkillPrompt(name: string, cwd: string): string | null {
  // Handle plugin-namespaced skills: "pluginName:skillName"
  if (name.includes(":")) {
    const [pluginName, skillName] = name.split(":", 2);
    return resolvePluginSkillPrompt(pluginName, skillName);
  }

  const candidates = [
    join(homedir(), ".claude", "skills", name, "SKILL.md"),
    join(homedir(), ".claude", "commands", `${name}.md`),
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "commands", `${name}.md`),
    join(BUNDLED_SKILLS_DIR, name, "SKILL.md"),
  ];
  for (const path of candidates) {
    const prompt = readSkillFile(path);
    if (prompt !== null) return prompt;
  }
  return null;
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
  try { sidecarSend(managed, { type: "kill" }); managed.ptySidecar?.kill(); } catch {}
  emit({ type: "agent_removed", agentId });
  persistAll();
}

export async function newConversation(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.pendingResume = false;
  managed.pendingResumeSessions = [];
  managed.pendingModelPick = false;
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

    // 2. Get SDK session messages and match by content + occurrence index
    const sdkMessages = await getSessionMessages(oldSessionId);
    const targetUsername = targetEntry.metadata?.username as string | undefined;
    const prefixedContent = targetUsername ? `[${targetUsername}] ${targetEntry.content}` : targetEntry.content;

    // Count which occurrence of this exact content this is among user_message log entries
    const userLogEntries = oldLogCache.filter(e => e.kind === "user_message");
    let occurrenceIndex = 0;
    for (const e of userLogEntries) {
      const u = e.metadata?.username as string | undefined;
      const prefixed = u ? `[${u}] ${e.content}` : e.content;
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
    emit({ type: "clear_logs", agentId } as any);
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
      emit({ type: "clear_logs", agentId } as any);
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
