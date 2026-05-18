import type {
  AgentInfo,
  AgentOutfit,
  AgentState,
  Attachment,
  EffortLevel,
  LogEntry,
  OfficeSettings,
  QueuedMessage,
  RoomWire,
  SkillInfo,
  TaskItem,
} from "../shared/types.ts";
import {
  MODEL_FAMILIES,
  FAMILY_TO_MODEL,
  EFFORT_LEVELS,
  familyDisplayLabel,
  effortDisplayLabel,
  generateRoomId,
  isClaudeFamily,
} from "../shared/types.ts";
import { formatPrefix, formatAgentSenderPrefix } from "../shared/identity.ts";
import { errMessage } from "../shared/errors.ts";
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
  loadTasks,
  saveTasks,
  readEnvFile,
  loadAgentHistory,
  saveAgentHistory,
  saveFile as savePersistedFile,
  type PersistedAgent,
  type Room,
  type AgentHistory,
} from "./persistence.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { autocompleteCommands } from "./commands.ts";
import { join, basename } from "path";
import { homedir } from "os";
import { rmSync, statSync, readFileSync, existsSync } from "fs";
import {
  resolveCwd,
  validateCwd,
  claudeSessionFileExists,
  claudeProjectDir,
  codexRolloutFileExists,
  codexRolloutHasHistory,
  codexSessionsDir,
  moveClaudeSessionFiles,
  diagnoseProcessExit,
} from "./cwd-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { computeIsomuxDiff, resolveDiffCwd } from "./isomux-diff.ts";
import {
  resolveEditorPath,
  openFile as openEditorFileImpl,
  saveFile as saveEditorFileImpl,
  type OpenFileResult,
  type SaveFileResult,
} from "./file-editor.ts";
import {
  discoverUserSkills,
  discoverProjectSkills,
  discoverPluginSkills,
  discoverBundledSkills,
  deduplicateSkills,
} from "./skills.ts";
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
  BackendNotConfiguredError,
  SessionSwappedError,
  inMultiStepFlow,
  type ManagedAgent,
  type AgentEvent,
  type EventHandler,
  type EnqueueResult,
} from "./internal-types.ts";
import { getBackend } from "./backends/index.ts";
import type { BackendSession, NormalizedEvent } from "./backends/types.ts";
import { OfficeState } from "../shared/office-state.ts";
import {
  buildEnvFor,
  buildEnvForUserId,
  setOfficeEnvFileProvider,
} from "./env-loader.ts";
import { getUserByName } from "./users.ts";
// Re-export so existing callers (`AgentManager.buildEnvFor` in server/index.ts)
// keep working without rewiring imports across the file.
export { buildEnvFor, buildEnvForUserId };

// Resolve the stable userId for a persisted agent. New agents carry both
// userId and username at spawn time; legacy records had only username,
// so we look up the user by name on load and bake the id in. If no user
// matches the snapshot (deleted, renamed, etc.), the agent runs unowned
// (env selection returns no per-user env).
function resolveAgentUserId(p: PersistedAgent): string | null {
  if (typeof p.userId === "string" && p.userId) return p.userId;
  if (!p.username) return null;
  const owner = getUserByName(p.username);
  if (!owner) {
    console.log(
      `[migration] agent "${p.name}" (username="${p.username}") has no matching user record; running unowned`,
    );
    return null;
  }
  return owner.id;
}

const LOGIN_INSTRUCTIONS = `To authenticate:
1. Open the built-in terminal
2. Run \`claude\`
3. Type \`/login\`
4. Follow the auth flow

Once complete, it takes effect immediately for all Isomux agents.`;

const AUTH_ERROR_PATTERNS =
  /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|not logged in|run \/login|403|401/i;
function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.test(text);
}

// Per-agent auth-error check + login instructions. Routes through the agent's
// backend so a Codex agent sees Codex's login message, not Claude's. Falls
// back to the orchestrator-local check + Claude instructions for callers that
// don't have an agent context (legacy paths or paths where the agent's
// backend is genuinely uncertain).
function detectAgentAuthError(
  managed: ManagedAgent | undefined,
  text: string,
): boolean {
  if (!managed) return isAuthError(text);
  return getBackend(managed.info.agentType).detectAuthError(text);
}
function agentLoginInstructions(managed: ManagedAgent | undefined): {
  text: string;
  command?: string;
} {
  if (!managed) return { text: LOGIN_INSTRUCTIONS };
  return getBackend(managed.info.agentType).getLoginInstructions();
}

// Emit a system log entry with the login/install text, plus an adjacent
// terminal-command card when the backend supplies a companion shell command.
// Centralizes the dual-emission pattern so the four detectAgentAuthError
// callsites and the BackendNotConfiguredError catch all render the same
// shape: explanatory text first, then a clickable card the user can copy.
function emitLoginInstructions(
  agentId: string,
  instructions: { text: string; command?: string },
): void {
  addLogEntry(agentId, "system", instructions.text);
  if (instructions.command) {
    emitAgentTerminalCommand(agentId, instructions.command);
  }
}

// Build the metadata blob attached to a user_message log entry. Carries
// username + device so display helpers can reconstruct `[Nil (Phone)]`. Old
// log entries written before the device split lack the device key — readers
// fall through to plain `[Nil]`.
export function buildUserMeta(
  username?: string,
  device?: string,
): Record<string, unknown> | undefined {
  if (!username && !device) return undefined;
  const meta: Record<string, unknown> = {};
  if (username) meta.username = username;
  if (device) meta.device = device;
  return meta;
}

const agents = new Map<string, ManagedAgent>();
const logCache = new Map<string, LogEntry[]>(); // agentId → entries
let eventHandler: EventHandler = () => {};
const initialOfficeConfig: OfficeSettings = loadOfficeConfig();
// Read the persisted rooms+agents shape ONCE at module init. The rooms
// are seeded into OfficeState now so AgentManager.getRooms() returns
// the real persisted ids immediately — required because auth.ts's
// snapshot provider runs (e.g. on bootstrap invite acceptance) before
// the async restoreAgents() finishes. restoreAgents reuses the cached
// value for the agent-restoration pass below.
const initialLoadedAgents = loadAgents();
const officeState = new OfficeState({
  rooms:
    initialLoadedAgents.length > 0
      ? initialLoadedAgents.map((r) => ({
          id: r.id,
          name: r.name,
          prompt: r.prompt,
        }))
      : [{ id: generateRoomId(), name: "Room 1", prompt: null }],
  office: {
    prompt: initialOfficeConfig.prompt,
    envFile: initialOfficeConfig.envFile,
    name: initialOfficeConfig.name,
  },
});
let officeStatePersistenceEnabled = false;
// Fields on AgentInfo that aren't included in the persisted shape (see
// persistAll below). agent_updated events that only touch these don't need
// disk writes — relevant because state transitions fire many times per turn.
const EPHEMERAL_AGENT_FIELDS = new Set([
  "state",
  "sessionSwapping",
  "topicStale",
  "turnHadHumanInput",
]);
officeState.onChange((event) => {
  if (event.type === "office_settings_updated") {
    saveOfficeConfig({
      prompt: officeState.office.prompt,
      envFile: officeState.office.envFile,
      name: officeState.office.name,
    });
    return;
  }
  if (event.type === "tasks_changed") {
    saveTasks(officeState.tasks);
    return;
  }
  if (!officeStatePersistenceEnabled) return;
  if (event.type === "agent_updated") {
    const keys = Object.keys(event.changes);
    if (keys.length > 0 && keys.every((k) => EPHEMERAL_AGENT_FIELDS.has(k)))
      return;
  }
  persistAll();
});

export function getRooms(): RoomWire[] {
  return officeState.rooms.map((r) => ({ ...r }));
}

export function getOfficeSettings(): OfficeSettings {
  return {
    prompt: officeState.office.prompt,
    envFile: officeState.office.envFile,
    name: officeState.office.name,
  };
}

export function getTasks(): TaskItem[] {
  return [...officeState.tasks];
}

export function addTask(
  title: string,
  createdBy: string,
  opts?: {
    description?: string;
    priority?: TaskItem["priority"];
    assignee?: string;
    username?: string;
  },
): TaskItem {
  const events = officeState.addTask(title, createdBy, opts);
  for (const event of events) eventHandler(event);
  return officeState.tasks[officeState.tasks.length - 1];
}

export function updateTask(
  id: string,
  changes: Partial<
    Pick<TaskItem, "title" | "description" | "priority" | "status" | "assignee">
  >,
): TaskItem | null {
  const events = officeState.updateTask(id, changes);
  if (events.length === 0) return null;
  for (const event of events) eventHandler(event);
  return officeState.tasks.find((t) => t.id === id) ?? null;
}

export function deleteTask(id: string): boolean {
  const before = officeState.tasks.length;
  const events = officeState.deleteTask(id);
  if (officeState.tasks.length === before) return false;
  for (const event of events) eventHandler(event);
  return true;
}

// Update office settings. Caller is responsible for validating envFile (see validateEnvPath).
export function setOfficeSettings(
  prompt: string | null,
  envFile: string | null,
  name: string | null,
) {
  const events = officeState.setOfficeSettings(prompt, envFile, name);
  // System prompt is rebuilt at every createSession from current office/room/agent
  // config, so the new office prompt automatically lands on the next conversation.
  for (const event of events) eventHandler(event);
}

export function setRoomSettings(
  roomId: string,
  prompt: string | null,
): boolean {
  const events = officeState.setRoomSettings(roomId, prompt);
  if (events.length === 0) return false;
  // System prompt is rebuilt at every createSession — next conversation picks up
  // the new room prompt automatically.
  for (const event of events) eventHandler(event);
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

export function getAgentCommands(agentId: string): {
  commands: { name: string; description?: string }[];
  skills: SkillInfo[];
} {
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

// Server-controlled view of an agent's identity, used by the HTTP message
// endpoint to derive the sender label instead of trusting the request body.
// Prevents an attacker from spoofing identity or injecting prefix-delimiter
// characters into the prompt that follows.
export function getAgentDisplay(
  agentId: string,
): { name: string; roomName: string } | null {
  const managed = agents.get(agentId);
  if (!managed) return null;
  const room = officeState.rooms[managed.info.room];
  if (!room) return null;
  return { name: managed.info.name, roomName: room.name };
}

export { validateCwd };

// Backend-option validators live in agent-validators.ts so cron handlers can
// share them. UI shouldn't send mismatched values, but a stale tab or hand-
// crafted client could; each validator falls back to a safe default when the
// value is outside the backend's allowlist.
import {
  validatePermissionMode,
  validateModelFamily,
  validateCodexSandbox,
  validateEffort,
} from "./agent-validators.ts";

// Apply `fields` to managed.info in-place, run `fn`, and revert on throw.
// Used by paths where a side effect (e.g. session recreate) reads AgentInfo
// and needs the new values, but we want the change reverted if the side
// effect fails. Persist/emit is the caller's responsibility on success.
async function withAgentRollback(
  managed: ManagedAgent,
  fields: Partial<AgentInfo>,
  fn: () => Promise<void>,
) {
  const snapshot = Object.fromEntries(
    Object.keys(fields).map((k) => [
      k,
      (managed.info as Record<string, unknown>)[k],
    ]),
  );
  Object.assign(managed.info, fields);
  try {
    await fn();
  } catch (err) {
    Object.assign(managed.info, snapshot);
    throw err;
  }
}

export async function editAgent(
  agentId: string,
  changes: {
    name?: string;
    cwd?: string;
    outfit?: AgentInfo["outfit"];
    customInstructions?: string;
    modelFamily?: string;
    effort?: EffortLevel;
    permissionMode?: AgentInfo["permissionMode"];
    codexSandbox?: AgentInfo["codexSandbox"];
  },
) {
  const managed = agents.get(agentId);
  if (!managed) return;

  // Backend-specific validation. OfficeState can't reach the backend layer,
  // so we validate here and pass already-canonicalized values to it.
  const validated: Parameters<typeof officeState.editAgent>[1] = {};

  if (changes.name) validated.name = changes.name;
  if (changes.cwd) validated.cwd = resolveCwd(changes.cwd);
  if (changes.outfit) validated.outfit = changes.outfit;
  if (changes.customInstructions !== undefined)
    validated.customInstructions = changes.customInstructions;
  if (changes.permissionMode) {
    validated.permissionMode = validatePermissionMode(
      managed.info.agentType,
      changes.permissionMode,
    );
  }
  if (changes.modelFamily) {
    validated.modelFamily = validateModelFamily(
      managed.info.agentType,
      changes.modelFamily,
    );
  }
  if (changes.codexSandbox && managed.info.agentType === "codex") {
    const valid = validateCodexSandbox(changes.codexSandbox);
    if (valid) validated.codexSandbox = valid;
  }
  if (changes.effort) {
    // Validate against the post-update modelFamily so a paired model+effort
    // change is consistent.
    const targetModelFamily = validated.modelFamily ?? managed.info.modelFamily;
    validated.effort = validateEffort(
      managed.info.agentType,
      targetModelFamily,
      changes.effort,
    );
  }
  // Cross-update sanitization: if modelFamily changed but effort wasn't part
  // of this edit, the existing effort may now be invalid (e.g. "max" survives
  // on an agent whose model just moved from opus to sonnet). Re-validate
  // against the new model and downgrade if needed.
  if (validated.modelFamily && validated.effort === undefined) {
    validated.effort = validateEffort(
      managed.info.agentType,
      validated.modelFamily,
      managed.info.effort,
    );
  }

  // cwd-change side effects must run BEFORE the AgentInfo mutation lands.
  // Both throw out of editAgent on failure, leaving managed.info untouched —
  // the officeState.editAgent call below is what commits the mutation.
  if (validated.cwd && validated.cwd !== managed.info.cwd) {
    if (managed.info.agentType === "claude") {
      // Claude stores sessions under $CLAUDE_CONFIG_DIR/projects/<cwd-hash>/
      // (default ~/.claude/projects/...); moving cwd means the .jsonl files
      // need to follow, otherwise resume can't find them. Pass the agent's
      // current env so the move targets the same config dir the spawn uses.
      // Username can be renamed without affecting env (we look up by
      // userId), so this is robust to in-flight renames.
      moveClaudeSessionFiles(
        agentId,
        managed.info.cwd,
        validated.cwd,
        buildEnvForUserId(managed.info.userId),
      );
    } else {
      // Codex stores per-cwd rollouts in ~/.codex/; the existing thread is
      // not addressable under the new cwd. Drop the sessionId so the next
      // conversation starts a fresh thread (matches the "applies to next
      // conversation" UX users expect from changing cwd).
      managed.sessionId = null;
    }
  }

  // Snapshot of all editable fields, captured BEFORE the mutation lands.
  // Used to roll the full edit back if session recreate fails — matches the
  // prior withAgentRollback contract, where the entire `updated` partial was
  // reverted on throw (not just the recreate-relevant subset).
  const snapshot: Partial<AgentInfo> = {
    name: managed.info.name,
    cwd: managed.info.cwd,
    outfit: managed.info.outfit,
    customInstructions: managed.info.customInstructions,
    permissionMode: managed.info.permissionMode,
    modelFamily: managed.info.modelFamily,
    effort: managed.info.effort,
    codexSandbox: managed.info.codexSandbox,
  };

  // Funnel through OfficeState.editAgent — single source of truth for
  // dedup + delta detection + AgentInfo mutation + event creation.
  // emitEvents inside fires onChange (persistence); the wire broadcast is
  // held until after the session-recreate side effect succeeds.
  const events = officeState.editAgent(agentId, validated);
  if (events.length === 0) return;

  // After editAgent, managed.info has the new values, so createSession reads
  // them correctly. On failure we revert via officeState.updateAgent — that
  // hits onChange (persists the rollback) but not eventHandler, so the wire
  // never sees either direction. Matches the prior withAgentRollback contract.
  const updated = events[0].type === "agent_updated" ? events[0].changes : {};
  if (
    updated.modelFamily ||
    updated.effort ||
    updated.permissionMode ||
    updated.codexSandbox
  ) {
    // Apply auto-resume policy BEFORE the replace transaction. The clear is
    // intentionally outside the try/catch: if the prior Codex thread had no
    // durable rollout, the cleared state is correct regardless of whether
    // the new session install succeeds.
    const sessionId = pickAutoResumeSessionId(managed);
    if (managed.sessionId && !sessionId)
      clearStaleAutoResumeState(agentId, managed);
    try {
      await replaceSession(
        agentId,
        managed,
        sessionId ? createSession(managed, sessionId) : createSession(managed),
      );
    } catch (err) {
      officeState.updateAgent(agentId, snapshot);
      throw err;
    }
  }

  for (const event of events) eventHandler(event);
}

export function swapDesks(deskA: number, deskB: number, roomId: string) {
  const events = officeState.swapDesks(deskA, deskB, roomId);
  for (const event of events) eventHandler(event);
}

export function createRoom(name?: string): string {
  const events = officeState.createRoom(name);
  const created = events.find((e) => e.type === "room_created");
  if (!created) throw new Error("failed to create room");
  for (const event of events) eventHandler(event);
  return created.room.id;
}

export function closeRoom(roomId: string): boolean {
  const events = officeState.closeRoom(roomId);
  if (events.length === 0) return false;
  for (const event of events) eventHandler(event);
  return true;
}

export function renameRoom(roomId: string, name: string): boolean {
  const events = officeState.renameRoom(roomId, name);
  if (events.length === 0) return false;
  // Room name appears in the system prompt header; it's rebuilt at every
  // createSession, so agents in this room pick up the new name on their next
  // conversation automatically.
  for (const event of events) eventHandler(event);
  return true;
}

export function reorderRooms(order: string[]): boolean {
  const events = officeState.reorderRooms(order);
  if (events.length === 0) return false;
  for (const event of events) eventHandler(event);
  return true;
}

export function moveAgent(agentId: string, targetRoomId: string): boolean {
  const events = officeState.moveAgent(agentId, targetRoomId);
  if (events.length === 0) return false;
  for (const event of events) eventHandler(event);
  return true;
}

export function getAllAgents(): AgentInfo[] {
  // info.queue is initialized empty and never mutated; the live queue lives on
  // managed.messageQueue and reaches connected clients via incremental
  // agent_updated events. Splice it in here so full_state (sent on each new WS
  // connect) carries it too. Without this, a device opening the convo after
  // another device already queued messages would render no queue chips.
  return [...agents.values()].map((a) => ({
    ...a.info,
    queue: [...a.messageQueue],
  }));
}

function updateManifest() {
  const rooms = officeState.rooms;
  writeManifest(
    [...agents.values()].map((a) => ({
      id: a.info.id,
      name: a.info.name,
      desk: a.info.desk,
      room: a.info.room,
      roomName: rooms[a.info.room]?.name ?? `Room ${a.info.room + 1}`,
      topic: a.info.topic,
      cwd: a.info.cwd,
      modelFamily: a.info.modelFamily,
      // Concrete model id: for Claude families resolve via FAMILY_TO_MODEL, for
      // Codex agents the value itself IS the codex model id (e.g. "gpt-5.5").
      model: isClaudeFamily(a.info.modelFamily)
        ? FAMILY_TO_MODEL[a.info.modelFamily]
        : a.info.modelFamily,
      username: a.info.username,
    })),
  );
}

function persistAll() {
  const rooms = officeState.rooms;
  const persistedRooms: Room[] = rooms.map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
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
        agentType: a.info.agentType,
        codexSandbox: a.info.codexSandbox,
        lastSessionId: a.sessionId,
        topic: a.info.topic,
        customInstructions: a.info.customInstructions,
        userId: a.info.userId,
        username: a.info.username,
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
  const rooms = officeState.rooms;
  const history: AgentHistory = loadAgentHistory();
  for (const a of agents.values()) {
    const room = rooms[a.info.room];
    if (!room) continue;
    history[a.info.id] = {
      name: a.info.name,
      lastRoomId: room.id,
      lastRoomName: room.name,
    };
  }
  saveAgentHistory(history);
}

// Restore agents from disk on startup. Creates sessions and loads log history.
export async function restoreAgents() {
  // Clean up the pre-0.2.116 per-agent launcher scripts. Isomux now passes the
  // native Claude binary directly, so these are orphaned.
  try {
    rmSync(join(homedir(), ".isomux", "launchers"), {
      recursive: true,
      force: true,
    });
  } catch {}

  // Rooms were seeded at module init from initialLoadedAgents — reuse
  // the cached value rather than re-running loadAgents() here. Reading
  // agents.json twice on boot was harmless but wasteful, and the
  // cached version is what auth.ts's snapshot provider already saw.
  const loaded = initialLoadedAgents;

  for (let roomIdx = 0; roomIdx < loaded.length; roomIdx++) {
    for (const p of loaded[roomIdx].agents) {
      const agentType = p.agentType ?? "claude";
      // Resolve the stable userId once for this agent and reuse for the
      // env-restore check below + the AgentInfo construction further
      // down. Legacy agents with only a `username` snapshot get migrated
      // here; the `persistAll()` at the bottom of restoreAgents bakes
      // the new shape onto disk.
      const userId = resolveAgentUserId(p);
      // Run persisted values through the same validators as spawn/edit so
      // stored data is canonicalized at load time. Notably: codex 0.130
      // deprecated "on-failure" (warns on use) — validatePermissionMode
      // migrates it to "on-request"; the next persistAll save bakes the
      // corrected value back to disk so the deprecation warning stops.
      const modelFamily = validateModelFamily(agentType, p.modelFamily);
      const permissionMode = validatePermissionMode(
        agentType,
        p.permissionMode,
      );
      const effort = validateEffort(agentType, modelFamily, p.effort);
      const codexSandbox =
        agentType === "codex"
          ? validateCodexSandbox(p.codexSandbox)
          : undefined;
      // Apply auto-resume policy up-front: a Codex thread that wasn't durable
      // before the last shutdown is not resumable. Computing this here lets us
      // set the initial AgentInfo.state and managed.sessionId honestly, avoiding
      // a stale "waiting_for_response" placeholder and a misleading on-disk
      // transcript loaded against what will become a fresh thread. A broken
      // env file would fail buildEnvFor — we swallow it so the agent still
      // restores (assuming the prior thread is durable) and the proper error
      // surfaces later via createSession's own buildSessionEnv call.
      let resumeSessionId: string | null = null;
      if (p.lastSessionId) {
        if (agentType === "codex") {
          try {
            const restoreEnv = buildEnvForUserId(userId);
            if (codexRolloutHasHistory(p.lastSessionId, restoreEnv)) {
              resumeSessionId = p.lastSessionId;
            }
          } catch {
            // Env build failed — assume durable so the agent still attempts
            // resume; the real error will surface from createSession below.
            resumeSessionId = p.lastSessionId;
          }
        } else {
          resumeSessionId = p.lastSessionId;
        }
      }
      const info: AgentInfo = {
        id: p.id,
        name: p.name,
        desk: p.desk,
        room: roomIdx,
        cwd: p.cwd,
        outfit: p.outfit,
        permissionMode,
        modelFamily,
        effort,
        state: resumeSessionId ? "waiting_for_response" : "idle",
        topic: p.topic ?? null,
        topicStale: false,
        customInstructions: p.customInstructions ?? null,
        agentType,
        ...(codexSandbox ? { codexSandbox } : {}),
        capabilities: getBackend(agentType).capabilities,
        // Resolved at the top of the per-agent loop. Stable across
        // username rename; env selection from now on goes through
        // buildEnvForUserId(info.userId), so renames don't break
        // ownership.
        userId,
        username: p.username ?? null,
        queue: [],
        sessionSwapping: false,
        turnHadHumanInput: false,
      };
      officeState.addExistingAgent(info);
      const managed: ManagedAgent = {
        info,
        session: null,
        sessionId: resumeSessionId,
        consumerPromise: null,
        pendingTurn: null,
        aborting: false,
        abortPromise: null,
        slashCommands: autocompleteCommands(),
        skills: deduplicateSkills([
          ...discoverUserSkills(),
          ...discoverProjectSkills(p.cwd),
          ...discoverPluginSkills(),
          ...discoverBundledSkills(),
        ]),
        sdkReportedCommands: [],
        thinkingStartedAt: 0,
        toolCallTimestamps: new Map(),
        topicGenerating: false,
        topicMessageCount: 0,
        topicGenToken: 0,
        pendingResume: false,
        pendingResumeSessions: [],
        pendingModelPick: false,
        pendingEffortPick: false,
        pendingPermission: null,
        ptySidecar: null,
        ptyBuffer: "",
        lastWrittenEntryId: null,
        messageQueue: [],
        flushInProgress: false,
        queueDedupe: new Map(),
      };
      agents.set(p.id, managed);

      // Load log history into cache (browsers connect later, so we cache it).
      // Uses loadLogWithAncestors to include parent entries for forked sessions.
      // Skip when the auto-resume policy decided to fresh-start — the old log
      // under a non-durable Codex threadId is at most ephemeral bootstrap
      // noise, and showing it against the upcoming fresh thread would mislead.
      if (resumeSessionId) {
        const history = loadLogWithAncestors(p.id, resumeSessionId);
        if (history.length > 0) {
          logCache.set(p.id, [...history]);
        }
      }

      // If the prior session died owing a response (e.g. server restart while
      // mid-stream), record the gap before auto-resume. Parity with the SDK's
      // lazy synthetic placeholder injected into its own transcript on resume.
      if (resumeSessionId) {
        const tail = (logCache.get(p.id) ?? []).at(-1);
        if (tail?.kind === "user_message") {
          addLogEntry(p.id, "system", "Previous response was interrupted.");
        }
      }

      // Auto-resume session
      try {
        const session = resumeSessionId
          ? createSession(managed, resumeSessionId)
          : createSession(managed);
        installSession(p.id, managed, session);
      } catch (err) {
        console.error(
          `Failed to restore session for ${p.name}:`,
          errMessage(err),
        );
        officeState.updateAgent(p.id, { state: "error" });
        // Surface to the UI so the user sees why the agent can't respond.
        const entry: LogEntry = {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          agentId: p.id,
          timestamp: Date.now(),
          kind: "error",
          content: `Failed to restore on startup: ${errMessage(err)}\nType /clear to start fresh, or /resume to pick another session.`,
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
  officeState.setTasksDirect(loadTasks());
  officeStatePersistenceEnabled = true;
  return [...agents.values()].map((a) => a.info);
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agents.get(agentId)?.info;
}

// Run the same path-resolution as /isomux-edit and emit an `edit-request` log
// entry so the boss can open the file in the editor side panel. Mirrors
// emitAgentDiff. The card shows an [Open in editor] button — the panel never
// auto-opens (matches the rejected "server auto-opens panel" decision).
export function emitAgentEditRequest(
  agentId: string,
  rawPath: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, status: 404, error: "agent not found" };
  const resolved = resolveEditorPath(rawPath, managed.info.cwd);
  if (resolved.kind === "bad_path") {
    return { ok: false, status: 400, error: "missing or empty path" };
  }
  // Don't open here — the user will trigger that. We do a cheap existence
  // check so a typo'd path produces a system message instead of a dead card.
  const probe = openEditorFileImpl(resolved.path);
  if (probe.kind === "not_found") {
    addLogEntry(agentId, "system", `\`${resolved.path}\` does not exist.`);
    return { ok: true };
  }
  if (probe.kind === "not_file") {
    addLogEntry(agentId, "system", `\`${resolved.path}\` is not a file.`);
    return { ok: true };
  }
  if (probe.kind === "binary") {
    addLogEntry(
      agentId,
      "system",
      `\`${resolved.path}\` is a binary file — the editor panel only supports text.`,
    );
    return { ok: true };
  }
  if (probe.kind === "too_large") {
    addLogEntry(
      agentId,
      "system",
      `\`${resolved.path}\` is ${(probe.size / 1024).toFixed(1)} KB — too large for the editor panel (1 MB limit).`,
    );
    return { ok: true };
  }
  if (probe.kind === "io_error") {
    addLogEntry(
      agentId,
      "system",
      `Failed to open \`${resolved.path}\`: ${probe.message}`,
    );
    return { ok: true };
  }
  addLogEntry(agentId, "edit-request", resolved.path, undefined, undefined, {
    file: { cwd: managed.info.cwd, path: resolved.path },
  });
  return { ok: true };
}

// Validate a command string and emit a `terminal-command` log entry so the
// boss sees a [Copy to terminal] card. Mirrors emitAgentEditRequest.
// Single-line only at first; agents that need multiple steps can join with
// `&&` / `;` or set up a one-line wrapper.
const TERMINAL_COMMAND_MAX_LEN = 4096;
export function emitAgentTerminalCommand(
  agentId: string,
  rawCommand: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, status: 404, error: "agent not found" };
  if (typeof rawCommand !== "string")
    return { ok: false, status: 400, error: "command must be a string" };
  const command = rawCommand.replace(/\s+$/u, "");
  if (!command) return { ok: false, status: 400, error: "empty command" };
  if (command.length > TERMINAL_COMMAND_MAX_LEN) {
    return {
      ok: false,
      status: 400,
      error: `command too long (max ${TERMINAL_COMMAND_MAX_LEN} chars)`,
    };
  }
  if (/[\r\n]/u.test(command)) {
    return {
      ok: false,
      status: 400,
      error: "command must be single-line; join steps with && or ;",
    };
  }
  addLogEntry(agentId, "terminal-command", command, undefined, undefined, {
    terminal: { command },
  });
  return { ok: true };
}

// Display cap for POST /agents/:id/read-file. Independent from the editor
// panel's 1 MB text cap (file-editor.ts) — this one bounds binary/image
// display payloads served through /api/files.
const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;

// Resolve a path against the agent's cwd, copy it into the agent's files dir
// (hash-deduped via saveFile), and emit a `file-view` log entry so the UI
// renders the attachment inline. Replaces the older convention of asking
// agents to Read an image so the Claude SDK's tool_result image extraction
// would surface it. Mirrors emitAgentEditRequest's error-surface pattern:
// path/size/io failures become system messages, not HTTP errors.
export function emitAgentReadFile(
  agentId: string,
  rawPath: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, status: 404, error: "agent not found" };
  const resolved = resolveEditorPath(rawPath, managed.info.cwd);
  if (resolved.kind === "bad_path") {
    return { ok: false, status: 400, error: "missing or empty path" };
  }
  const absPath = resolved.path;
  if (!existsSync(absPath)) {
    addLogEntry(agentId, "system", `\`${absPath}\` does not exist.`);
    return { ok: true };
  }
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    addLogEntry(
      agentId,
      "system",
      `Failed to read \`${absPath}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: true };
  }
  if (!st.isFile()) {
    addLogEntry(agentId, "system", `\`${absPath}\` is not a file.`);
    return { ok: true };
  }
  if (st.size > MAX_READ_FILE_BYTES) {
    addLogEntry(
      agentId,
      "system",
      `\`${absPath}\` is ${(st.size / (1024 * 1024)).toFixed(1)} MB — too large to display (${MAX_READ_FILE_BYTES / (1024 * 1024)} MB limit).`,
    );
    return { ok: true };
  }
  let data: Buffer;
  try {
    data = readFileSync(absPath);
  } catch (err) {
    addLogEntry(
      agentId,
      "system",
      `Failed to read \`${absPath}\`: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: true };
  }
  const originalName = basename(absPath);
  const mediaType = mimeTypeForFilename(originalName);
  const att = savePersistedFile(agentId, data, mediaType, originalName);
  if (!att) {
    addLogEntry(
      agentId,
      "system",
      `Failed to save \`${absPath}\` for display.`,
    );
    return { ok: true };
  }
  addLogEntry(agentId, "file-view", originalName, undefined, [att]);
  return { ok: true };
}

// Run the same diff machinery as /isomux-diff and emit the result into the
// agent's chat stream. Used by POST /agents/:id/diff so an agent can show
// the boss a styled diff card without the boss invoking the slash command.
export function emitAgentDiff(
  agentId: string,
  dir?: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, status: 404, error: "agent not found" };
  const resolved = resolveDiffCwd(dir, managed.info.cwd);
  if (resolved.kind === "bad_dir") {
    return {
      ok: false,
      status: 400,
      error: `\`${resolved.attempted}\` is not a directory`,
    };
  }
  const result = computeIsomuxDiff(resolved.cwd);
  switch (result.kind) {
    case "not_repo":
      addLogEntry(
        agentId,
        "system",
        `\`${result.cwd}\` is not a git repository.`,
      );
      break;
    case "git_error":
      addLogEntry(
        agentId,
        "system",
        `Failed to run git diff in \`${result.cwd}\`:\n\n\`\`\`\n${result.message}\n\`\`\``,
      );
      break;
    case "clean":
      addLogEntry(
        agentId,
        "system",
        `Working tree clean in \`${result.cwd}\` — no uncommitted changes.`,
      );
      break;
    case "ok":
      addLogEntry(agentId, "diff", result.summary, undefined, undefined, {
        diff: result.payload,
      });
      break;
  }
  return { ok: true };
}

function emit(event: AgentEvent) {
  eventHandler(event);
}

// Turn-start primitive. Stamps the per-turn "did a human originate this turn"
// flag and then transitions the agent into "thinking", in that order. The UI
// reads turnHadHumanInput at the moment of the working→attention transition
// to decide whether to fire the turn-end notification sound, so the flag must
// land before the state event. Every place that begins a new turn (flushQueue,
// sendMessage echo paths, editMessage, executeSkill) goes through here.
function beginTurn(agentId: string, opts: { humanInput: boolean }) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (managed.info.turnHadHumanInput !== opts.humanInput) {
    for (const event of officeState.updateAgent(agentId, {
      turnHadHumanInput: opts.humanInput,
    }))
      emit(event);
  }
  updateState(agentId, "thinking");
}

function updateState(agentId: string, state: AgentState) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (state === "thinking" && managed.info.state !== "thinking") {
    managed.thinkingStartedAt = Date.now();
  }
  const prev = managed.info.state;
  for (const event of officeState.updateAgent(agentId, { state })) emit(event);

  // Trigger queue flush on transition into an idle state (and only when the
  // queue actually has items waiting). Swapping into the same state is a
  // no-op so we don't re-fire the trigger from intra-state edits.
  if (
    state !== prev &&
    isQueueIdleState(state) &&
    managed.messageQueue.length > 0 &&
    !managed.flushInProgress &&
    !inMultiStepFlow(managed)
  ) {
    flushQueue(agentId).catch((err: unknown) => {
      console.error(
        `flushQueue (state-transition) failed for ${agentId}:`,
        errMessage(err),
      );
    });
  }
}

function addLogEntry(
  agentId: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: Record<string, unknown>,
  attachments?: Attachment[],
  extra?: Partial<Pick<LogEntry, "diff" | "file" | "terminal">>,
) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(extra ?? {}),
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
  if (
    (kind === "text" || kind === "user_message") &&
    managed &&
    managed.info.topic !== null &&
    managed.info.topic !== "..."
  ) {
    const textCount = (logCache.get(agentId) ?? []).filter(
      (e) => e.kind === "user_message" || e.kind === "text",
    ).length;
    if (textCount > managed.topicMessageCount) {
      for (const event of officeState.updateAgent(agentId, {
        topicStale: true,
      }))
        emit(event);
    }
  }
}

// Emit a log entry to the UI only (not persisted to disk) — for ephemeral
// messages like /resume, "Conversation cleared.", permission prompts, etc.
// Entries are tagged ephemeral:true so appendLog and the system_init backfill
// both skip them. They still go into logCache so the UI shows them, but they
// vanish on server restart.
function emitEphemeralLog(
  agentId: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: Record<string, unknown>,
  extra?: Partial<Pick<LogEntry, "diff" | "file">>,
) {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
    ...(extra ?? {}),
    ephemeral: true,
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
  for (const event of officeState.updateAgent(agentId, {
    topic: "...",
    topicStale: false,
  }))
    emit(event);
  // Capture before the await; if /clear, /resume, fork, etc. ran during the
  // LLM call, the token will have changed and we drop the stale result.
  const startToken = managed.topicGenToken;

  // Build context: first user message + last 5 text entries
  const logs = logCache.get(agentId) ?? [];
  const textEntries = logs.filter(
    (e) => e.kind === "user_message" || e.kind === "text",
  );
  const firstUserMsg = textEntries.find((e) => e.kind === "user_message");
  if (!firstUserMsg) {
    managed.topicGenerating = false;
    for (const event of officeState.updateAgent(agentId, { topic: null }))
      emit(event);
    return;
  }

  const lastFive = textEntries.slice(-5);
  let context: string;
  if (textEntries.length <= 1) {
    context = `User message: ${firstUserMsg.content}`;
  } else {
    // Deduplicate if first message is already in lastFive
    const recent = lastFive.filter((e) => e.id !== firstUserMsg.id);
    context =
      `First message: ${firstUserMsg.content}\n\nRecent conversation:\n` +
      recent
        .map(
          (e) =>
            `${e.kind === "user_message" ? "User" : "Assistant"}: ${e.content.slice(0, 200)}`,
        )
        .join("\n");
  }

  // System framing matters: without it, Sonnet occasionally roleplayed as the
  // agent in the conversation and "responded" to the task (e.g. asking for
  // file access) instead of labelling. Wrapping the snippet in a tag and
  // pinning the model to a labeller role suppresses that.
  const topicSystemPrompt = `You are a labelling tool. You receive a snippet of a conversation between a user and an AI assistant and you output a short topic label that summarizes what the conversation is about. You are NOT the assistant in the conversation, you do NOT have access to any files or systems mentioned, and you must NOT attempt to do the task. You only label.`;
  const prompt = `<conversation>\n${context}\n</conversation>\n\nOutput ONLY a topic label, max 8 words. No quotes, no trailing punctuation.`;

  try {
    const backend = getBackend(managed.info.agentType);
    // Topic-gen model is backend-specific: Claude uses sonnet (cheap); Codex
    // uses its default GPT-5 family. Per-backend `oneShotPrompt` honors the
    // modelFamily arg, so we let the backend pick something sensible.
    const topicModel =
      managed.info.agentType === "claude" ? "sonnet" : managed.info.modelFamily;
    const text = await backend.oneShotPrompt(prompt, {
      cwd: managed.info.cwd,
      modelFamily: topicModel,
      systemPrompt: topicSystemPrompt,
    });
    if (agents.has(agentId) && managed.topicGenToken === startToken) {
      const topic = text.trim().slice(0, 80);
      managed.topicMessageCount = textEntries.length;
      // officeState.setTopic mutates topic + topicStale, fires persistAll via onChange,
      // and returns the agent_updated event.
      for (const event of officeState.setTopic(agentId, topic)) emit(event);
      // Persist topic to sessions.json for resume list
      if (managed.sessionId) {
        persistSessionTopic(agentId, managed.sessionId, topic);
      }
    }
  } catch (err) {
    console.error(`Topic generation failed for ${agentId}:`, errMessage(err));
    // Silently fail — clear the "..." placeholder, but only if it's still ours
    if (agents.has(agentId) && managed.topicGenToken === startToken) {
      for (const event of officeState.updateAgent(agentId, { topic: null }))
        emit(event);
    }
  } finally {
    // Only release the generating flag if the conversation hasn't been reset.
    // If it has, the reset already cleared the flag and a fresh generateTopic
    // may have set it true again — leave that one alone.
    if (agents.has(agentId) && managed.topicGenToken === startToken) {
      managed.topicGenerating = false;
    }
  }
}

// Derive agent state from one normalized event.
function deriveStateFromEvent(ev: NormalizedEvent): AgentState | null {
  switch (ev.kind) {
    case "assistant_text":
    case "thinking":
      return "thinking";
    case "tool_call":
      return "tool_executing";
    case "turn_completed":
      // On failure, processNormalizedEvent sets "error" inside the body;
      // returning null here avoids clobbering that with "waiting_for_response".
      return ev.status === "completed" ? "waiting_for_response" : null;
    default:
      return null;
  }
}

// Process one normalized event from a BackendSession stream.
function processNormalizedEvent(agentId: string, ev: NormalizedEvent) {
  const newState = deriveStateFromEvent(ev);
  if (newState) {
    // Don't downgrade tool_executing → thinking within the same turn. The
    // original SDK-shape deriveState looked at the whole assistant message
    // and elevated to tool_executing whenever ANY block was a tool_use; in
    // normalized form events arrive per-block, so we keep the elevation
    // sticky until the turn ends.
    const currentState = agents.get(agentId)?.info.state;
    if (!(currentState === "tool_executing" && newState === "thinking")) {
      updateState(agentId, newState);
    }
  }

  switch (ev.kind) {
    case "system_init": {
      const managed = agents.get(agentId);
      // Two paths reach here: (1) a real bootstrap success, sessionId set to
      // the backend's thread id — install session tracking below; (2) the
      // codex bootstrap-failure path emits an empty sessionId so the agent
      // transitions to idle without us pretending it has a usable session,
      // see backends/codex/adapter.ts bootstrap catch. Slash_commands/skills
      // still land below in either case.
      if (managed && ev.sessionId) {
        const sessionId = ev.sessionId;
        const hadPreviousSession = !!managed.sessionId;
        // Load prior log history if this session was seen before (walks fork ancestry)
        if (!managed.sessionId) {
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
        // Backfill: write any cached log entries that were created before sessionId was known.
        // Skip ephemeral entries — they're UI-only by design and must not reach disk.
        if (!hadPreviousSession) {
          const cached = logCache.get(agentId) ?? [];
          for (const entry of cached) {
            if (entry.ephemeral) continue;
            appendLog(agentId, sessionId, entry);
          }
        }
        persistAll();
      }
      // Capture available slash commands and skills from init.
      const sdkCommands = ev.slashCommands ?? [];
      // Filter out MCP internal command names (mcp__...) — they clutter autocomplete.
      const filteredSdkCommands = sdkCommands.filter(
        (c) => !c.startsWith("mcp__"),
      );
      if (managed) {
        managed.sdkReportedCommands = filteredSdkCommands;
      }
      // Autocomplete: config entries with autocomplete:true + all discovered skills.
      // SDK-reported commands are NOT added to autocomplete (per design).
      // Skills are listed in priority order; deduplicate by name (highest priority wins).
      const discoveredSkills = managed
        ? [
            ...discoverUserSkills(),
            ...discoverProjectSkills(managed.info.cwd),
            ...discoverPluginSkills(),
            ...discoverBundledSkills(),
          ]
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
      break;
    }
    case "assistant_text":
      addLogEntry(agentId, "text", ev.text);
      break;
    case "system_text": {
      addLogEntry(agentId, "system", ev.text);
      // Claude's SDK emits its "Not logged in · Please run /login" notice as
      // a synthetic assistant message that the claude adapter routes here as
      // system_text. Without auth-error detection at this layer, the user
      // saw the terse SDK line with no context. Run the same detection +
      // login-instruction append the error / turn_completed paths use so
      // the chat has actionable next steps either way.
      const managedForAuth = agents.get(agentId);
      if (detectAgentAuthError(managedForAuth, ev.text)) {
        emitLoginInstructions(agentId, agentLoginInstructions(managedForAuth));
      }
      break;
    }
    case "thinking": {
      const managed = agents.get(agentId);
      const duration_ms =
        ev.durationMs ??
        (managed?.thinkingStartedAt
          ? Date.now() - managed.thinkingStartedAt
          : undefined);
      addLogEntry(
        agentId,
        "thinking",
        ev.text,
        duration_ms != null ? { duration_ms } : undefined,
      );
      break;
    }
    case "tool_call": {
      const managed = agents.get(agentId);
      if (managed) {
        managed.toolCallTimestamps.set(ev.toolUseId, Date.now());
      }
      addLogEntry(agentId, "tool_call", ev.name, {
        toolId: ev.toolUseId,
        input: ev.input,
      });
      break;
    }
    case "tool_result": {
      const managed = agents.get(agentId);
      const callStart = managed?.toolCallTimestamps.get(ev.toolUseId);
      const duration_ms =
        ev.durationMs ?? (callStart ? Date.now() - callStart : undefined);
      if (managed && callStart) {
        managed.toolCallTimestamps.delete(ev.toolUseId);
      }
      addLogEntry(
        agentId,
        "tool_result",
        ev.content.slice(0, 10000),
        {
          toolUseId: ev.toolUseId,
          ...(duration_ms != null ? { duration_ms } : {}),
        },
        ev.attachments,
      );
      break;
    }
    case "turn_completed": {
      // Backends report token totals per turn. We accumulate cumulative
      // totals into sessions.json (`usage`) and append a snapshot anchored
      // to the most recently written log entry. The snapshots let /usage's
      // fork accounting subtract the parent's cumulative-at-the-fork-point
      // exactly, instead of double-counting the resumed prefix.
      const managed = agents.get(agentId);
      if (managed?.sessionId && ev.usage) {
        const cumulative = accumulateSessionUsage(
          agentId,
          managed.sessionId,
          ev.usage,
          ev.cost ?? 0,
        );
        if (managed.lastWrittenEntryId) {
          appendSessionUsageSnapshot(
            agentId,
            managed.sessionId,
            managed.lastWrittenEntryId,
            cumulative,
          );
        }
      }
      if (ev.status !== "completed") {
        // Hot-abort path (Codex): the natural turn_completed with
        // status="interrupted" arrives after a user-initiated turn/interrupt.
        // The orchestrator's abort() already logged "Agent interrupted." and
        // flipped state to waiting_for_response — don't re-log as an error
        // or flip state to error. The pendingTurn.resolve() below still fires
        // so the deferred unblocks the wrap-and-wake in abort() (and any
        // sendMessage / flushQueue callers).
        const isHotAbortClean =
          managed?.aborting === true && ev.status === "interrupted";
        if (!isHotAbortClean) {
          // status="failed" while aborting usually means the codex subprocess
          // exited mid-interrupt (handleSubprocessExit synthesizes a failed
          // turn_completed). The state="error" flip below signals abort()'s
          // recovery branch to fall through to replaceSession.
          const isHotAbortDirty =
            managed?.aborting === true && ev.status === "failed";
          const errorText = isHotAbortDirty
            ? ev.error
              ? `Codex exited during interrupt: ${ev.error}`
              : "Codex exited during interrupt — installing a fresh session."
            : (ev.error ?? `Agent stopped: ${ev.status}.`);
          addLogEntry(agentId, "error", errorText);
          if (detectAgentAuthError(managed, errorText)) {
            emitLoginInstructions(agentId, agentLoginInstructions(managed));
          }
          updateState(agentId, "error");
        }
      }
      // Resolve the per-turn deferred. Pre-refactor this lived in runConsumer
      // and fired when the SDK's stream() returned at the result message.
      // Post-refactor stream() is persistent across turns, so we resolve at
      // the turn_completed normalized event instead — same semantic, just at
      // the orchestrator layer.
      const turn = managed?.pendingTurn;
      if (turn) {
        managed.pendingTurn = null;
        turn.resolve();
      }
      break;
    }
    case "usage_update": {
      // Backend emitted running totals outside a turn boundary (Codex). Treat
      // it like a turn_completed for the purposes of accumulation; no
      // turn-completed log/state side effects.
      const managed = agents.get(agentId);
      if (managed?.sessionId) {
        const cumulative = accumulateSessionUsage(
          agentId,
          managed.sessionId,
          ev.tokenUsage,
          0,
        );
        if (managed.lastWrittenEntryId) {
          appendSessionUsageSnapshot(
            agentId,
            managed.sessionId,
            managed.lastWrittenEntryId,
            cumulative,
          );
        }
      }
      break;
    }
    case "compacted":
      addLogEntry(
        agentId,
        "system",
        ev.summary ? `Context compacted: ${ev.summary}` : "Context compacted.",
      );
      break;
    case "error": {
      const managed = agents.get(agentId);
      addLogEntry(agentId, "error", ev.message);
      // diagnoseProcessExit gives Claude-specific hints (CLAUDE_CONFIG_DIR/
      // projects/ path, "session .jsonl missing" wording). Don't run it for
      // non-Claude agents — the message would be wrong and misleading.
      if (managed && managed.info.agentType === "claude") {
        // Best-effort env build: a broken envFile must not mask the original
        // backend error this hint is annotating. Resume preflights still
        // throw on broken env (deliberate); the hint generator does not.
        const hints = diagnoseProcessExit(
          managed.info.cwd,
          managed.sessionId,
          envForHints(managed),
        );
        if (hints) addLogEntry(agentId, "system", hints);
      }
      if (detectAgentAuthError(managed, ev.message)) {
        emitLoginInstructions(agentId, agentLoginInstructions(managed));
      }
      // Reject any in-flight turn so sendMessage / executeSkill don't hang.
      const turn = managed?.pendingTurn;
      if (turn) {
        managed.pendingTurn = null;
        try {
          turn.reject(new Error(ev.message));
        } catch {}
      }
      updateState(agentId, "error");
      break;
    }
    case "approval_request": {
      const managed = agents.get(agentId);
      if (!managed) break;
      // Build the 3-option /resolve prompt. Same UX as the pre-2c
      // requestPermission flow; only difference is the backend now owns the
      // SDK resolver and we route the decision back via session.approve().
      const lines: string[] = [
        `**${ev.title ?? `Wants to use ${ev.toolName}`}**`,
      ];
      if (ev.description) lines.push(ev.description);
      lines.push("");
      lines.push("Reply:");
      // Backend-aware scope wording: Claude applies SDK-suggested pattern
      // rules scoped to the session, so option 1 covers similar calls.
      // Codex caches the exact canonicalized command (cwd, tty, sandbox
      // included), so option 1 only covers byte-identical re-runs.
      lines.push(
        managed.info.agentType === "codex"
          ? "  1. Allow — and don't ask again for this exact command this session"
          : "  1. Allow — and don't ask again for similar calls this session",
      );
      lines.push("  2. Allow — just this time");
      lines.push("  3. Deny");
      lines.push("");
      lines.push("Or type any other message to deny with that as the reason.");
      emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingPermission = {
        approvalId: ev.approvalId,
        toolName: ev.toolName,
      };
      updateState(agentId, "waiting_for_response");
      break;
    }
  }
}

// Create the per-turn deferred that sendMessage / executeSkill await.
// Resolved from processNormalizedEvent's `turn_completed` case — fires
// when the backend signals end-of-turn (Claude: result message; Codex:
// turn/completed). Backends MUST emit exactly one turn_completed per
// send() for this contract to hold.
function createTurnDeferred(managed: ManagedAgent): Promise<void> {
  // Any stale pending turn (shouldn't normally happen; agents are
  // state-gated to one turn at a time) gets rejected so awaiting callers
  // don't leak forever.
  const stale = managed.pendingTurn;
  if (stale) {
    managed.pendingTurn = null;
    try {
      stale.reject(new Error("Superseded by a new turn."));
    } catch {}
  }
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Defensive: a noop catch so a reject() that fires before any awaiter
  // attaches doesn't trip Bun's unhandled-rejection handler (which exits
  // the process). Real awaiters still receive the rejection through their
  // own await. Concretely: sendMessage rejects this deferred in its catch
  // block when session.send() throws BEFORE the `await turn` line runs
  // (e.g. codex bootstrap failure on first message of an agent whose
  // backend CLI is missing). Without this guard the orphan rejection
  // crashes the server. Same pattern as JsonRpcLiteClient.request() in
  // backends/codex/client.ts.
  promise.catch(() => {});
  managed.pendingTurn = { resolve, reject };
  return promise;
}

// Persistent consumer. Runs for the session's lifetime, iterating `stream()`
// once — the BackendSession contract is that stream() yields events for the
// whole session and only returns when the session is closed/exhausted.
// Per-turn boundaries are signalled via `turn_completed` NormalizedEvents,
// which processNormalizedEvent uses to resolve `pendingTurn`.
//
// Bound to a specific session instance: returns when `managed.session` is
// swapped out (abort / resume / fork / etc.) — `session.close()` unblocks the
// parked `stream()` generator.
async function runConsumer(
  agentId: string,
  managed: ManagedAgent,
  boundSession: BackendSession,
) {
  try {
    for await (const ev of boundSession.stream()) {
      // After an abort/resume/fork the dying session may keep yielding
      // events for several seconds before its stream() generator finally
      // ends (the SDK's close() doesn't interrupt mid-chunk). We must keep
      // draining so the inner generator terminates, but we drop the events
      // — otherwise the user sees model output continuing after Ctrl+C.
      if (managed.session !== boundSession) continue;
      // Hot-abort window (session not swapped, just interrupted in place):
      // the cancelled turn may keep streaming thinking / assistant_text /
      // tool_* events for a moment before turn_completed arrives. Drop
      // those so the user doesn't see the cancelled turn continue past the
      // "Agent interrupted." log entry. Let turn_completed through (it
      // settles pendingTurn and exits the abort wait) and error events
      // through (real subprocess failures need to surface and recover).
      //
      // Known acceptable trade-offs in this window:
      //   - usage_update events are dropped, so cumulative-usage accounting
      //     permanently undercounts the interrupted turn's tokens. The
      //     codex adapter's lastCumulativeUsage still advances, so later
      //     turns don't double-count — we just lose the aborted turn from
      //     the running total. Acceptable for cost reporting.
      //   - system_text breadcrumbs from the adapter (e.g. "Codex interrupt
      //     failed: …") are dropped here, so the user only sees the
      //     orchestrator-level fallback message if the timeout path fires.
      //     Acceptable for debug UX.
      //   - tool_call events dropped here mean the matching tool_result
      //     (if it arrives before turn_completed) has no entry in
      //     toolCallTimestamps to clear — pre-existing leak pattern,
      //     slightly wider here.
      if (
        managed.aborting &&
        ev.kind !== "turn_completed" &&
        ev.kind !== "error"
      )
        continue;
      processNormalizedEvent(agentId, ev);
    }
  } catch (err) {
    if (managed.aborting || managed.session !== boundSession) {
      // Expected: abort() or a session swap closed us. The swap path
      // already nulled + rejected pendingTurn with SessionSwappedError.
      return;
    }

    const turn = managed.pendingTurn;
    managed.pendingTurn = null;
    if (turn) turn.reject(err);

    console.error(`Agent ${agentId} stream error:`, errMessage(err));
    const errorText = `Stream error: ${errMessage(err)}`;
    addLogEntry(agentId, "error", errorText);
    // The SDK's "process exited with code 1" is opaque; diagnose common causes.
    // diagnoseProcessExit is Claude-specific (reads CLAUDE_CONFIG_DIR/projects);
    // only call it for claude-typed agents.
    if (managed.info.agentType === "claude") {
      // Best-effort env build — see envForHints note above.
      const hints = diagnoseProcessExit(
        managed.info.cwd,
        managed.sessionId,
        envForHints(managed),
      );
      if (hints) addLogEntry(agentId, "system", hints);
    }
    if (detectAgentAuthError(managed, errorText)) {
      emitLoginInstructions(agentId, agentLoginInstructions(managed));
    }
    updateState(agentId, "error");
  }
}

// Install a freshly-created session on managed and spawn its consumer. Caller
// is responsible for having closed/awaited any previous session first.
function installSession(
  agentId: string,
  managed: ManagedAgent,
  session: BackendSession,
) {
  managed.session = session;
  managed.consumerPromise = runConsumer(agentId, managed, session);
}

// Swap the agent's session: close the current one, await its consumer to
// drain, install the new session + consumer. Rejects any in-flight turn so
// callers awaiting sendMessage's deferred don't hang.
//
// IMPORTANT — drain-before-install is load-bearing. Switching to swap-then-
// drain (install new synchronously, drain old in background) is tempting
// because it would let follow-up messages typed after Ctrl+C reach the LLM
// without waiting ~3s for the old session to drain. Don't do it without
// first verifying there's no on-disk race on the shared sessionId .jsonl
// between the dying-old and starting-new subprocesses — both write to the
// same file when the new session is created with --resume. See task
// 154e2c14's STILL OPEN section for context. The current sendMessage
// papers over the user-visible delay by echoing the typed message to the
// log before awaiting abortPromise (see echoEarly there).
async function replaceSession(
  agentId: string,
  managed: ManagedAgent,
  newSession: BackendSession,
) {
  for (const event of officeState.updateAgent(agentId, {
    sessionSwapping: true,
  }))
    emit(event);
  try {
    const oldConsumer = managed.consumerPromise;
    const turn = managed.pendingTurn;
    managed.pendingTurn = null;
    if (turn) {
      try {
        turn.reject(new SessionSwappedError());
      } catch {}
    }
    try {
      managed.session?.close();
    } catch {}
    managed.session = null;
    if (oldConsumer) {
      try {
        await oldConsumer;
      } catch {}
    }
    installSession(agentId, managed, newSession);
  } finally {
    for (const event of officeState.updateAgent(agentId, {
      sessionSwapping: false,
    }))
      emit(event);
  }
}

// Merge process.env with office and the agent owner's user env files.
// User overrides office; office overrides process.env. Spawn-time failure
// mode: if a configured env file is missing or fails to parse, throw — the
// caller is responsible for surfacing the error to the agent log.
//
// The shared implementation lives in env-loader.ts so cronjob-manager can
// import it without dragging in agent-manager (which would create an import
// cycle through command-handlers). The office-env-file provider is registered
// at agent-manager module init (see initEnvLoader call below) so env-loader
// can read our `officeState` without importing it directly.
function buildSessionEnv(
  managed: ManagedAgent,
): { [key: string]: string | undefined } | undefined {
  return buildEnvForUserId(managed.info.userId);
}

// Error-path env build for diagnostic hints. Resume preflights deliberately
// fail loudly on a broken envFile (an agent expecting custom creds must not
// silently fall through to host creds). Hint generators are different: they
// annotate an already-failed backend error, and a broken envFile here would
// mask the real cause. Swallow and return undefined — the hint just falls back
// to inspecting the default ~/.claude path, which is the worst-case-correct
// behavior when we can't resolve user env.
function envForHints(
  managed: ManagedAgent,
): { [key: string]: string | undefined } | undefined {
  try {
    return buildSessionEnv(managed);
  } catch {
    return undefined;
  }
}

// Register the office-env-file provider once, after `officeState` exists.
// Anchored at module top-level so cronjob-manager (which also imports
// env-loader, possibly before fully running its own module body) can call
// buildEnvFor synchronously by the time any scheduler tick fires.
setOfficeEnvFileProvider(() => officeState.office.envFile);

// Returns the session id to use for an automatic resume attempt, or null if
// the recorded `managed.sessionId` can't safely be resumed and the caller
// should start fresh instead. Applies the "auto-resume policy":
//
//   - Codex threads that never wrote a durable rollout (no file in
//     $CODEX_HOME/sessions, or header-only) are not resumable across process
//     restarts. Without this filter, every startup attempt would surface a
//     "Codex bootstrap failed: no rollout found" error.
//   - Claude is passed through unchanged. createSession's claudeSessionFileExists
//     check still throws if the .jsonl is gone — that's the existing behavior
//     and only applies on cwd moves, which warrant the explicit error.
//
// Pure: does NOT mutate managed or logCache. The call site decides when to
// clear stale UI state (logCache, managed.sessionId) in tandem with the
// session install. Doing the clear BEFORE entering any withAgentRollback
// transaction means a downstream throw rolls back AgentInfo without leaving
// the session/log half-mutated — the cleared state is the correct end state
// regardless, since the old thread was non-durable.
function pickAutoResumeSessionId(managed: ManagedAgent): string | null {
  const candidate = managed.sessionId;
  if (!candidate) return null;
  if (managed.info.agentType === "codex") {
    const env = buildSessionEnv(managed);
    if (!codexRolloutHasHistory(candidate, env)) return null;
  }
  return candidate;
}

// Companion to pickAutoResumeSessionId: when auto-resume policy decided to
// drop a previously-set sessionId, clear the matching UI/cache state so the
// new session's system_init lands as a fresh start (hadPreviousSession=false)
// and the user doesn't see a stale on-disk transcript against a new thread.
// Returns true if a transition was applied — callers that surface a
// "Resumed prior session..." vs "Started a fresh session..." marker can use
// this to choose wording.
function clearStaleAutoResumeState(
  agentId: string,
  managed: ManagedAgent,
): boolean {
  if (!managed.sessionId) return false;
  managed.sessionId = null;
  logCache.set(agentId, []);
  emit({ type: "clear_logs", agentId });
  return true;
}

function createSession(
  managed: ManagedAgent,
  resumeSessionId?: string,
): BackendSession {
  // Clear pendingPermission so a stale approvalId from the old (about-to-close)
  // session can't accidentally route a future user message into a dead approval.
  // The backend's close() resolves any in-flight SDK resolver with deny.
  if (managed.pendingPermission) {
    managed.pendingPermission = null;
  }
  // Preflight checks so failures surface as readable errors instead of the
  // backend's opaque process-exit messages.
  try {
    validateCwd(managed.info.cwd);
  } catch (err) {
    throw new Error(
      `cwd is invalid: ${errMessage(err)}. Click the agent name in the log view header to fix it.`,
      { cause: err },
    );
  }
  // Compute env once — both the resume preflight (Claude sessions dir lookup
  // honors CLAUDE_CONFIG_DIR; Codex sessions dir lookup honors CODEX_HOME)
  // and the session opts use it.
  const env = buildSessionEnv(managed);
  if (
    resumeSessionId &&
    managed.info.agentType === "claude" &&
    !claudeSessionFileExists(managed.info.cwd, resumeSessionId, env)
  ) {
    throw new Error(
      `Cannot resume session ${resumeSessionId.slice(0, 8)}…: its file is missing from ${claudeProjectDir(managed.info.cwd, env)}. ` +
        `Most commonly this happens after the agent's cwd was moved or renamed — the Claude CLI stores sessions under a path derived from cwd. ` +
        `Use /resume to pick a different session, or move the session .jsonl into the new project dir.`,
    );
  }
  if (
    resumeSessionId &&
    managed.info.agentType === "codex" &&
    !codexRolloutFileExists(resumeSessionId, env)
  ) {
    // Strict (explicit-resume) paths: only block on missing-file. Header-only
    // and corrupt rollouts will fail at Codex's thread/resume with a more
    // specific message ("no rollout found", parse errors, etc.). Letting
    // Codex surface those preserves precision for the fork/edit/rollback
    // cases where the on-disk state may legitimately be in transition.
    throw new Error(
      `Cannot resume Codex thread ${resumeSessionId.slice(0, 8)}…: no rollout file found under ${codexSessionsDir(env)}. ` +
        `This usually means the thread was started but never received a user turn before its process exited. ` +
        `Use /resume to pick another session, or start a new conversation.`,
    );
  }
  const room = officeState.rooms[managed.info.room];
  const ownerRecord = managed.info.username
    ? getUserByName(managed.info.username)
    : undefined;
  const systemPrompt = buildSystemPrompt(
    managed.info.name,
    managed.info.id,
    room.name,
    officeState.office.prompt,
    room.prompt,
    managed.info.customInstructions,
    managed.info.username,
    ownerRecord?.memberPrompt ?? null,
  );
  if (resumeSessionId) {
    // The SDK reports cost cumulative-per-process, so a resumed session's
    // counter starts from zero. Roll the current-run usage into the
    // prior-runs accumulator so lifetime cost survives the reset.
    rollSessionUsageOnResume(managed.info.id, resumeSessionId);
  }
  const opts = {
    agentId: managed.info.id,
    cwd: managed.info.cwd,
    systemPrompt,
    modelFamily: managed.info.modelFamily,
    effort: managed.info.effort,
    permissionMode: managed.info.permissionMode,
    // Codex-only sandbox; Claude backend ignores. Undefined falls back to
    // the Codex adapter's "workspace-write" default.
    sandbox: managed.info.codexSandbox,
    env,
  };
  const backend = getBackend(managed.info.agentType);
  return resumeSessionId
    ? backend.resumeSession(resumeSessionId, opts)
    : backend.createSession(opts);
}

export async function spawn(
  name: string,
  cwd: string,
  permissionMode: AgentInfo["permissionMode"],
  desk?: number,
  customInstructions?: string,
  roomId?: string,
  outfit?: AgentOutfit,
  modelFamily?: string,
  effort?: EffortLevel,
  username?: string,
  agentType: AgentInfo["agentType"] = "claude",
  codexSandbox?: AgentInfo["codexSandbox"],
  // Stable identity reference for the spawning user. Drives buildEnvForUserId
  // at every subsequent createSession/resumeSession. Optional for legacy
  // call sites; resolved from `username` if null and the snapshot still
  // matches a known user.
  userId?: string | null,
): Promise<AgentInfo | null> {
  // Spawn is always allowed even if the backend CLI is missing — the failure
  // surfaces as a chat-visible error on first message (codex client's
  // child.on('error') translates ENOENT to an install hint; Claude SDK errors
  // surface analogously). Keeping the policies symmetric across backends means
  // a user can put an agent at a desk before configuring its backend, and the
  // welcome-agent seed gets one Opus and one Codex desk on every fresh install.
  const resolvedCwd = resolveCwd(cwd);

  // Server-side validation. Anything outside the backend's allowlist falls
  // back to a safe default; the wire shapes are permissive (union types over
  // both backends), so a stale UI or hand-crafted client can't pin us to an
  // invalid mode/model/effort.
  const validatedPermissionMode = validatePermissionMode(
    agentType,
    permissionMode,
  );
  const validatedModelFamily = validateModelFamily(agentType, modelFamily);
  const validatedEffort = validateEffort(
    agentType,
    validatedModelFamily,
    effort,
  );
  const validatedCodexSandbox =
    agentType === "codex" ? validateCodexSandbox(codexSandbox) : undefined;

  // Funnel AgentInfo construction through OfficeState so the literal lives in
  // one place. Suppress persistAll during the inner emitEvents — at that point
  // the ManagedAgent isn't in agent-manager's `agents` map yet, so a save
  // would write a snapshot missing the new agent. We persistAll() manually
  // below once both maps are in sync. try/finally guards against an
  // unexpected throw in officeState.spawn leaving the flag stuck false
  // (which would silently break ALL future persistAll triggers).
  officeStatePersistenceEnabled = false;
  let spawned;
  try {
    spawned = officeState.spawn({
      name,
      cwd: resolvedCwd,
      permissionMode: validatedPermissionMode,
      desk,
      roomId,
      customInstructions,
      outfit,
      modelFamily: validatedModelFamily,
      effort: validatedEffort,
      agentType,
      codexSandbox: validatedCodexSandbox,
      // Prefer the supplied userId. For legacy callers that only pass
      // username, resolve via getUserByName so the spawned agent gets a
      // stable userId even if the caller hasn't been migrated.
      userId:
        userId ?? (username ? (getUserByName(username)?.id ?? null) : null),
      username,
      capabilities: getBackend(agentType).capabilities,
    });
  } finally {
    officeStatePersistenceEnabled = true;
  }
  if (!spawned) return null;
  const { agent: info, events } = spawned;
  const id = info.id;

  const managed: ManagedAgent = {
    info,
    session: null,
    sessionId: null,
    consumerPromise: null,
    pendingTurn: null,
    aborting: false,
    abortPromise: null,
    slashCommands: autocompleteCommands(),
    skills: deduplicateSkills([
      ...discoverUserSkills(),
      ...discoverProjectSkills(resolvedCwd),
      ...discoverPluginSkills(),
      ...discoverBundledSkills(),
    ]),
    sdkReportedCommands: [],
    thinkingStartedAt: 0,
    toolCallTimestamps: new Map(),
    topicGenerating: false,
    topicMessageCount: 0,
    topicGenToken: 0,
    pendingResume: false,
    pendingResumeSessions: [],
    pendingModelPick: false,
    pendingEffortPick: false,
    pendingPermission: null,
    ptySidecar: null,
    ptyBuffer: "",
    lastWrittenEntryId: null,
    messageQueue: [],
    flushInProgress: false,
    queueDedupe: new Map(),
  };
  agents.set(id, managed);
  for (const event of events) emit(event);
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
    addLogEntry(
      id,
      "system",
      `Agent "${name}" ready. Working in ${resolvedCwd}. Permission mode: ${info.permissionMode}.`,
    );
    // First stream() will deliver system/init + response to the first send().
  } catch (err) {
    console.error(`Failed to create session for ${name}:`, errMessage(err));
    addLogEntry(id, "error", `Failed to start: ${errMessage(err)}`);
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
  getRooms: () => officeState.rooms,
  getOfficeConfig: () => officeState.office,
  logCache,
  emit,
  addLogEntry,
  emitEphemeralLog,
  updateState,
  updateAgent: (agentId, changes) => officeState.updateAgent(agentId, changes),
  beginTurn,
  createSession,
  replaceSession,
  persistAll,
  persistCurrentSessionTopic,
  createTurnDeferred,
  enqueueMessage,
});

// === Message queue ===
//
// Messages addressed to an agent that's currently busy (thinking / tool_executing)
// land here instead of superseding the in-flight turn. On the next idle
// transition they flush together as one coalesced SDK prompt, with each
// message labelled by sender. Both human senders (WS send_message) and agent
// senders (HTTP POST /agents/:id/message) go through the same queue.
//
// Persistence: in-memory only. The boss accepted that restarts (a developer-only
// event in practice) drop the queue.

const QUEUE_MAX = 50;
const QUEUE_DEDUPE_TTL_MS = 5 * 60_000;

function senderMeta(
  sender: QueuedMessage["sender"],
): Record<string, unknown> | undefined {
  switch (sender.kind) {
    case "user":
      return buildUserMeta(sender.username, sender.device);
    case "agent":
      return {
        sender_agent_id: sender.agentId,
        sender_agent_name: sender.agentName,
        sender_agent_room: sender.roomName,
      };
    default: {
      const _exhaustive: never = sender;
      throw new Error(`unhandled sender kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function senderPrefixText(sender: QueuedMessage["sender"]): string {
  switch (sender.kind) {
    case "user":
      return formatPrefix({ username: sender.username, device: sender.device });
    case "agent":
      return `${formatAgentSenderPrefix(sender.agentId, sender.agentName, sender.roomName)} `;
    default: {
      const _exhaustive: never = sender;
      throw new Error(`unhandled sender kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function emitQueueUpdate(agentId: string, managed: ManagedAgent) {
  emit({
    type: "agent_updated",
    agentId,
    changes: { queue: [...managed.messageQueue] },
  });
}

function generateQueuedId(existing: QueuedMessage[]): string {
  const ids = new Set(existing.map((m) => m.id));
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!ids.has(id)) return id;
  }
}

function isQueueIdleState(s: AgentState): boolean {
  return s === "idle" || s === "waiting_for_response";
}

function recordDedupe(managed: ManagedAgent, clientMessageId: string) {
  const now = Date.now();
  // Lazy prune only when the map has grown past a small threshold so the
  // common (small) case stays O(1). Drops expired entries to bound steady-
  // state memory; the queue cap of QUEUE_MAX provides the true upper bound
  // on accepted distinct ids per minute.
  if (managed.queueDedupe.size > 100) {
    for (const [k, v] of managed.queueDedupe) {
      if (v < now) managed.queueDedupe.delete(k);
    }
  }
  managed.queueDedupe.set(clientMessageId, now + QUEUE_DEDUPE_TTL_MS);
}

// Single entry point for human (via sendMessage) and agent (via HTTP) senders.
// Decides whether to queue, send-immediately, or reject based on agent state.
// `state === "error" | "stopped"` is rejected with 409.
//
// The WS textarea path (sendMessage) is intentionally more permissive: in
// `error`/`stopped`/null-session it falls into a session-recovery branch that
// resumes the prior transcript and continues. The asymmetry is by design.
// A human at a textarea can read the recovery system message and react, while
// a programmatic HTTP caller benefits from an explicit failure so it can
// retry, escalate, or fall back. Hiding a state-recovering side effect behind
// an "ok, queued" response would mislead the sender.
export function enqueueMessage(
  agentId: string,
  msg: {
    sender: QueuedMessage["sender"];
    text: string;
    sdkText?: string;
    attachments?: Attachment[];
    clientMessageId?: string;
  },
): EnqueueResult {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, error: "agent not found", status: 404 };

  const state = managed.info.state;
  if (state === "stopped" || state === "error") {
    return { ok: false, error: `agent_${state}`, status: 409 };
  }

  // Idempotency check first; record only after a successful accept below so
  // a 429-rejected retry doesn't poison the dedup map.
  if (msg.clientMessageId && managed.queueDedupe.has(msg.clientMessageId)) {
    return { ok: true, queued: false, deduped: true };
  }

  if (managed.messageQueue.length >= QUEUE_MAX) {
    return { ok: false, error: "queue_full", status: 429 };
  }

  const id = generateQueuedId(managed.messageQueue);
  const queuedDuringBusyTurn = !isQueueIdleState(state);
  managed.messageQueue.push({
    id,
    sender: msg.sender,
    text: msg.text,
    ...(msg.sdkText ? { sdkText: msg.sdkText } : {}),
    ...(queuedDuringBusyTurn ? { queuedDuringBusyTurn: true } : {}),
    attachments: msg.attachments,
    queuedAt: Date.now(),
  });
  emitQueueUpdate(agentId, managed);
  if (msg.clientMessageId) recordDedupe(managed, msg.clientMessageId);

  // Idle/waiting_for_response with no multi-step in flight: kick off a flush
  // immediately. flushQueue is gated by flushInProgress and re-checks state
  // post-defer, so this is safe to call unconditionally.
  if (isQueueIdleState(state) && !inMultiStepFlow(managed)) {
    flushQueue(agentId).catch((err: unknown) => {
      console.error(
        `flushQueue (idle) failed for ${agentId}:`,
        errMessage(err),
      );
    });
    return { ok: true, queued: false, messageId: id };
  }
  return { ok: true, queued: true, messageId: id };
}

async function flushQueue(agentId: string): Promise<void> {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (managed.flushInProgress) return;
  if (managed.messageQueue.length === 0) return;

  managed.flushInProgress = true;
  // Set by the BackendNotConfiguredError soft-catch below to tell the finally
  // block NOT to auto-re-trigger flushQueue. Without this guard, the catch
  // leaves the agent in a queue-idle state (waiting_for_response satisfies
  // isQueueIdleState the same as idle does) with the queue still intact, so
  // the finally's re-flush condition matches, the re-flush throws the same
  // error, the catch fires again, and we spam-loop on the unconfigured
  // backend. User-paced retries (next sendMessage / next state transition)
  // still get a fresh attempt.
  let backendNotConfigured = false;
  try {
    // Wait for any in-flight turn to truly end before starting a new one. The
    // trigger from updateState fires synchronously inside processMessage,
    // before runConsumer's post-loop code can clear the about-to-resolve
    // pendingTurn — without this wait, createTurnDeferred below would reject
    // that turn and surface a bogus "Superseded" error to the original caller.
    // Wraps the existing deferred so we wake on either resolve or reject.
    if (managed.pendingTurn) {
      const original = managed.pendingTurn;
      await new Promise<void>((wakeUp) => {
        managed.pendingTurn = {
          resolve: () => {
            original.resolve();
            wakeUp();
          },
          reject: (e: unknown) => {
            original.reject(e);
            wakeUp();
          },
        };
      });
    }
    // Re-check post-wait — state and queue can change while we waited. The
    // agents.has() guard catches a kill() during the wait: kill rejects the
    // pendingTurn wrapper (waking us) and removes the agent from the map but
    // doesn't update state, so without this check the session-recovery branch
    // below would spawn an SDK subprocess for a deleted agent.
    if (!agents.has(agentId)) return;
    if (!isQueueIdleState(managed.info.state)) return;
    if (inMultiStepFlow(managed)) return;
    if (managed.messageQueue.length === 0) return;

    if (managed.abortPromise) {
      try {
        await managed.abortPromise;
      } catch {}
      // Re-check again after the abort handoff.
      if (!agents.has(agentId)) return;
      if (!isQueueIdleState(managed.info.state)) return;
      if (inMultiStepFlow(managed)) return;
      if (managed.messageQueue.length === 0) return;
    }
    if (!managed.session) {
      try {
        const sessionId = pickAutoResumeSessionId(managed);
        if (managed.sessionId && !sessionId)
          clearStaleAutoResumeState(agentId, managed);
        installSession(
          agentId,
          managed,
          sessionId
            ? createSession(managed, sessionId)
            : createSession(managed),
        );
        // If the prior session died owing a response, mark the gap. Parity
        // with the SDK's lazy synthetic placeholder injected at this moment.
        const tail = (logCache.get(agentId) ?? []).at(-1);
        if (tail?.kind === "user_message") {
          addLogEntry(agentId, "system", "Previous response was interrupted.");
        }
        addLogEntry(
          agentId,
          "system",
          sessionId
            ? "Resumed prior session before flushing queued messages."
            : "Started a fresh session before flushing queued messages.",
        );
      } catch (err) {
        addLogEntry(
          agentId,
          "error",
          `Cannot start session to flush queue: ${errMessage(err)}`,
        );
        updateState(agentId, "error");
        return;
      }
    }

    // Snapshot the items to send. We DON'T drain yet: a session swap during
    // the await below (e.g. a concurrent /model change) would reject the turn
    // with SessionSwappedError, and silent splice-then-fail would leave the
    // user with chip-less log entries for messages the agent never received.
    // Instead, we send first and then drain + log only on success; on a swap
    // the items remain in the queue and the post-swap idle trigger re-flushes.
    const items = [...managed.messageQueue];

    const promptParts: string[] = [];
    const allAttachments: Attachment[] = [];
    // If any items were queued while the agent was busy, prepend a single
    // coalesced note so the agent doesn't read them as reactions to its most
    // recent reply (the sender hadn't seen that reply when sending them).
    const busyCount = items.reduce(
      (n, m) => (m.queuedDuringBusyTurn ? n + 1 : n),
      0,
    );
    if (busyCount > 0) {
      promptParts.push(
        busyCount === 1
          ? `[Note: this message was queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent it.]`
          : `[Note: these messages were queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent them.]`,
      );
    }
    for (const m of items) {
      // sdkText is set for pre-expanded slash commands (e.g. an /isomux-review
      // queued while the agent was mid-turn): chat shows m.text "/isomux-review",
      // but the SDK needs the full skill prompt.
      promptParts.push(`${senderPrefixText(m.sender)}${m.sdkText ?? m.text}`);
      if (m.attachments) allAttachments.push(...m.attachments);
    }
    const prompt = promptParts.join("\n\n");

    beginTurn(agentId, {
      humanInput: items.some((m) => m.sender.kind === "user"),
    });

    const turn = createTurnDeferred(managed);
    const ownPending = managed.pendingTurn;
    try {
      await managed.session!.send(
        prompt,
        allAttachments.length > 0 ? allAttachments : undefined,
      );
      // Send accepted by the backend. Now finalize: write per-message log entries
      // (provenance) and remove the items from the live queue. Items cancelled
      // mid-send are still in `items` (they did reach the SDK) — log them so
      // chat history matches what the receiver actually saw.
      for (const m of items) {
        // Carry sdkText into the log metadata so editMessage can match this
        // entry against the SDK session (the SDK saw the expanded prompt,
        // not m.text). Same shape executeSkill uses on the immediate path.
        const base = senderMeta(m.sender);
        const meta = m.sdkText ? { ...(base ?? {}), sdkText: m.sdkText } : base;
        addLogEntry(agentId, "user_message", m.text, meta, m.attachments);
      }
      // Trigger topic generation only after the user_message log entries land
      // in logCache. generateTopic reads the first user message synchronously
      // before its first await — running it earlier (e.g. before the send) on
      // a fresh conversation finds an empty cache and bails out, leaving topic
      // null. Matches the sendMessage path which also logs before triggering.
      if (managed.info.topic === null && !managed.topicGenerating) {
        void generateTopic(agentId);
      }
      const sentIds = new Set(items.map((m) => m.id));
      managed.messageQueue = managed.messageQueue.filter(
        (m) => !sentIds.has(m.id),
      );
      emitQueueUpdate(agentId, managed);
      await turn;
    } catch (err) {
      // If we still own the deferred (no session swap, no fresh turn), reject
      // and clear it so awaiting callers don't hang. Done before the kill /
      // SessionSwapped branches because both also benefit from the cleanup.
      if (ownPending && managed.pendingTurn === ownPending) {
        managed.pendingTurn = null;
        try {
          ownPending.reject(err);
        } catch {}
      }
      // Agent killed mid-flush: nothing to log on a deleted agent, and any
      // log entry would leak into logCache for an id that no longer exists.
      if (!agents.has(agentId)) return;
      if (err instanceof SessionSwappedError) {
        // Items still in queue (we didn't drain on the failed attempt). The
        // post-swap state transition will re-trigger flushQueue. Surface a
        // system message only if the queue still has items — when the swap
        // path explicitly cleared the queue (newConversation/resume/editMessage)
        // there's nothing to retry and the message would be misleading noise.
        if (managed.messageQueue.length > 0) {
          addLogEntry(
            agentId,
            "system",
            "Queue flush interrupted by session change; will retry.",
          );
        }
        return;
      }
      if (err instanceof BackendNotConfiguredError) {
        // Backend can't run at all (CLI missing, auth missing, etc.). The
        // .message is already user-actionable — surface verbatim as a system
        // log entry, plus an adjacent terminal-command card when the error
        // carries a companion install/login command (set at the throw site).
        // State goes to waiting_for_response (not idle) so the desk shows
        // the awake/waving pose: the agent has produced output (the install
        // hint) and is waiting for the user to act on it. Idle would render
        // as closed-eyes "sleeping" and look like nothing happened. Items
        // stay in the queue; the next send/flush re-attempts and will
        // surface the same message again until the backend is configured.
        // The local flag suppresses the finally block's auto-re-flush to
        // avoid a tight loop.
        emitLoginInstructions(agentId, {
          text: err.message,
          command: err.command,
        });
        updateState(agentId, "waiting_for_response");
        backendNotConfigured = true;
        return;
      }
      console.error(`Agent ${agentId} flush error:`, errMessage(err));
      addLogEntry(agentId, "error", `Error flushing queue: ${errMessage(err)}`);
      updateState(agentId, "error");
    }
  } finally {
    if (agents.has(agentId)) {
      managed.flushInProgress = false;
      // Re-flush if more arrived during the await, and we're still in an idle
      // state. Skip when the catch path marked the backend as not configured
      // — see the flag's declaration above for why.
      if (
        !backendNotConfigured &&
        managed.messageQueue.length > 0 &&
        isQueueIdleState(managed.info.state) &&
        !inMultiStepFlow(managed)
      ) {
        flushQueue(agentId).catch(() => {});
      }
    }
  }
}

export function cancelQueued(agentId: string, messageId: string): boolean {
  const managed = agents.get(agentId);
  if (!managed) return false;
  const idx = managed.messageQueue.findIndex((m) => m.id === messageId);
  if (idx < 0) return false;
  managed.messageQueue.splice(idx, 1);
  emitQueueUpdate(agentId, managed);
  return true;
}

// Steering action: stop whatever the agent is doing and flush the queue.
// Mapped to the UI "Send now" button. No-op when the queue is empty so users
// who hit it accidentally don't kill an in-flight turn for no reason.
export async function sendNow(agentId: string): Promise<void> {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (managed.messageQueue.length === 0) return;
  const state = managed.info.state;
  if (state === "thinking" || state === "tool_executing") {
    // abort transitions to waiting_for_response (synchronously) and fires the
    // queue-flush trigger in updateState, but that flush awaits abortPromise
    // — so the actual flush happens AFTER abort settles pendingTurn. Net
    // effect: queued items land in the same session (hot-abort) or in the
    // freshly-installed replacement (slow path / Codex fallback), never in a
    // half-closed one.
    await abort(agentId);
  } else {
    flushQueue(agentId).catch(() => {});
  }
}

export async function sendMessage(
  agentId: string,
  text: string,
  username?: string,
  device?: string,
  attachments?: Attachment[],
) {
  const managed = agents.get(agentId);
  if (!managed) return;

  // Route through queue when busy. Multi-step pending flows (permission /
  // resume / model / effort) need the existing path because the user's reply
  // is interpreted as a pick. Slash commands also pass through so /clear,
  // /new etc. can preempt rather than queue.
  const state = managed.info.state;
  const busy = state === "thinking" || state === "tool_executing";
  const isSlash = text.startsWith("/");
  if (busy && !inMultiStepFlow(managed) && !isSlash) {
    const result = enqueueMessage(agentId, {
      sender: { kind: "user", username, device },
      text,
      attachments,
    });
    if (!result.ok) {
      addLogEntry(
        agentId,
        "system",
        `Could not queue message: ${result.error}`,
      );
    }
    return;
  }

  // If the prior session ended owing a response, write the gap breadcrumb
  // before any new entries land. Parity with the SDK's lazy synthetic
  // placeholder injected into its own transcript at this moment.
  if (!managed.session) {
    const tail = (logCache.get(agentId) ?? []).at(-1);
    if (tail?.kind === "user_message") {
      addLogEntry(agentId, "system", "Previous response was interrupted.");
    }
  }

  // Echo "normal" user messages to the log before awaiting abortPromise. The
  // wait below can take ~3s while the SDK's old session drains, and without
  // this echo the user sees no feedback after typing a message right after
  // Ctrl+C. Pending-* replies and slash commands have their own echo paths
  // (or no echo at all for handled slash commands), so we only echo here for
  // the path that ends up at the addLogEntry/send block at the bottom of
  // this function.
  const echoEarly =
    !managed.pendingPermission &&
    !managed.pendingResume &&
    !managed.pendingModelPick &&
    !managed.pendingEffortPick &&
    !text.startsWith("/");
  if (echoEarly) {
    addLogEntry(
      agentId,
      "user_message",
      text,
      buildUserMeta(username, device),
      attachments,
    );
    beginTurn(agentId, { humanInput: true });
    if (managed.info.topic === null && !managed.topicGenerating) {
      void generateTopic(agentId); // fire-and-forget
    }
  }
  // If an abort is mid-handoff, wait for it to install the replacement session.
  // Without this, a follow-up message arriving in the gap between session.close()
  // and installSession sees session=null and falls into the recovery branch below,
  // amputating the agent's context.
  if (managed.abortPromise) {
    try {
      await managed.abortPromise;
    } catch {}
  }
  // Defensive: a permission request can briefly appear during the abort drain
  // (the SDK's `canUseTool` can fire from buffered events before the dying
  // session's signal listener at line 1051 clears pendingPermission). If
  // echoEarly was true at the snapshot, the user typed thinking they were
  // sending a normal message — pendingPermission was null then. Resolve any
  // race-set pendingPermission as deny so the SDK cleans up, and proceed with
  // the normal-message path below; otherwise the user's message would be
  // misinterpreted as a deny reason and lost. Pending-resume/model/effort are
  // user-initiated only, so they can't transition here.
  if (echoEarly && managed.pendingPermission) {
    // Race-set during the abort drain. The dying session (now closed) already
    // resolved its SDK callback with deny inside close(); we just clear the
    // orchestrator-side pointer so the normal-message path proceeds.
    managed.pendingPermission = null;
  }
  // Skip auto-recovery for slash commands: they are control-plane actions
  // (/clear creates a fresh session, /resume picks from disk) and must stay
  // reachable when the data-plane session is broken. Auto-recovery applies the
  // resume policy, which for Claude re-throws the missing-file error and would
  // block the user's escape hatch. Normal messages still hit the recovery path
  // below and surface the descriptive error.
  if (!managed.session && !isSlash) {
    // Try to create a fresh session so the user's next message doesn't silently vanish.
    // pickAutoResumeSessionId returns managed.sessionId when it's safely resumable —
    // the previous session is genuinely dead, but the on-disk transcript is intact and
    // worth restoring. For non-durable Codex threads, it returns null so we fresh-start
    // cleanly instead of crashing on thread/resume.
    try {
      const sessionId = pickAutoResumeSessionId(managed);
      const clearedStale =
        managed.sessionId && !sessionId
          ? clearStaleAutoResumeState(agentId, managed)
          : false;
      // If we wiped logCache while echoEarly already added the user's
      // message to it, the message is now gone from UI/cache. Re-add it
      // here — the bottom of sendMessage won't re-add (echoEarly is still
      // true) and the send below would otherwise vanish from the log.
      if (clearedStale && echoEarly) {
        addLogEntry(
          agentId,
          "user_message",
          text,
          buildUserMeta(username, device),
          attachments,
        );
      }
      installSession(
        agentId,
        managed,
        sessionId ? createSession(managed, sessionId) : createSession(managed),
      );
      addLogEntry(
        agentId,
        "system",
        sessionId
          ? "Resumed prior session after the previous one ended unexpectedly."
          : "Started a fresh session (previous one could not be restored).",
      );
      updateState(agentId, "waiting_for_response");
      // Fall through so the message is actually sent on the new session.
    } catch (err) {
      if (!echoEarly)
        addLogEntry(
          agentId,
          "user_message",
          text,
          buildUserMeta(username, device),
          attachments,
        );
      addLogEntry(
        agentId,
        "error",
        `Cannot start session: ${errMessage(err)}\nType /clear to start fresh, or /resume to pick another session.`,
      );
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
    const userMeta = buildUserMeta(username, device);
    emitEphemeralLog(agentId, "user_message", text, userMeta);
    const trimmed = text.trim();
    const session = managed.session;
    if (!session) {
      emitEphemeralLog(
        agentId,
        "system",
        "Permission could not be resolved — session is gone.",
      );
      return;
    }
    if (trimmed === "1") {
      emitEphemeralLog(
        agentId,
        "system",
        "Permission granted (rule added for this session).",
      );
      await session.approve(pending.approvalId, { kind: "allow_persistent" });
    } else if (trimmed === "2") {
      emitEphemeralLog(agentId, "system", "Permission granted (once).");
      await session.approve(pending.approvalId, { kind: "allow_once" });
    } else if (trimmed === "3") {
      emitEphemeralLog(agentId, "system", "Permission denied.");
      await session.approve(pending.approvalId, { kind: "deny" });
    } else {
      emitEphemeralLog(
        agentId,
        "system",
        "Permission denied with reason forwarded to agent.",
      );
      await session.approve(pending.approvalId, { kind: "deny", reason: text });
    }
    return;
  }

  // Handle /resume two-step: if pendingResume, check if input is a number pick
  if (managed.pendingResume) {
    managed.pendingResume = false;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (
      !isNaN(num) &&
      num >= 1 &&
      num <= managed.pendingResumeSessions.length
    ) {
      const userMeta = buildUserMeta(username, device);
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = managed.pendingResumeSessions[num - 1];
      managed.pendingResumeSessions = [];
      // Resuming a different past session is a context switch; queued
      // messages were addressed to the current session and shouldn't bleed
      // into the resumed transcript. Must run BEFORE replaceSession so the
      // post-swap idle trigger doesn't flush them.
      if (managed.messageQueue.length > 0) {
        managed.messageQueue.length = 0;
        emitQueueUpdate(agentId, managed);
      }
      // Persist current session topic before switching
      persistCurrentSessionTopic(agentId, managed);
      // Perform the resume
      try {
        const newSession = createSession(managed, picked.sessionId);
        await replaceSession(agentId, managed, newSession);
        managed.sessionId = picked.sessionId;
        managed.topicGenerating = false;
        managed.topicMessageCount = 0;
        managed.topicGenToken++;
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
        // Restore topic — officeState.updateAgent fires persistAll via onChange,
        // capturing the new sessionId set above.
        for (const event of officeState.updateAgent(agentId, {
          topic: picked.topic,
          topicStale: false,
        }))
          emit(event);
        emitEphemeralLog(
          agentId,
          "system",
          `Resumed session: ${picked.topic || picked.sessionId.slice(0, 8) + "..."}`,
        );
        updateState(agentId, "waiting_for_response");
        if (!picked.topic) {
          void generateTopic(agentId);
        }
      } catch (err) {
        emitEphemeralLog(
          agentId,
          "error",
          `Failed to resume: ${errMessage(err)}`,
        );
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
      const userMeta = buildUserMeta(username, device);
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = MODEL_FAMILIES[num - 1];
      const label = familyDisplayLabel(picked.family);
      if (picked.family === managed.info.modelFamily) {
        emitEphemeralLog(agentId, "system", `Already using ${label}.`);
      } else {
        // Run the auto-resume policy OUTSIDE withAgentRollback so the clear
        // commits even if the inner transaction fails — the prior Codex
        // thread is non-durable either way, and a rollback that revives a
        // stale logCache+sessionId pointing at a dead thread would only
        // confuse the user.
        const sessionId = pickAutoResumeSessionId(managed);
        if (managed.sessionId && !sessionId)
          clearStaleAutoResumeState(agentId, managed);
        await withAgentRollback(
          managed,
          { modelFamily: picked.family },
          async () => {
            await replaceSession(
              agentId,
              managed,
              sessionId
                ? createSession(managed, sessionId)
                : createSession(managed),
            );
          },
        );
        for (const event of officeState.updateAgent(agentId, {
          modelFamily: picked.family,
        }))
          emit(event);
        addLogEntry(
          agentId,
          "system",
          `Model switched to ${label}. The agent's context may still say they are a different model — the correct model is shown in the top bar.`,
        );
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
      const userMeta = buildUserMeta(username, device);
      emitEphemeralLog(agentId, "user_message", text, userMeta);
      const picked = EFFORT_LEVELS[num - 1];
      const label = effortDisplayLabel(picked.level);
      if (picked.level === managed.info.effort) {
        emitEphemeralLog(agentId, "system", `Already using ${label}.`);
      } else {
        // Auto-resume policy outside the rollback — see model-switch above
        // for the rationale.
        const sessionId = pickAutoResumeSessionId(managed);
        if (managed.sessionId && !sessionId)
          clearStaleAutoResumeState(agentId, managed);
        await withAgentRollback(managed, { effort: picked.level }, async () => {
          await replaceSession(
            agentId,
            managed,
            sessionId
              ? createSession(managed, sessionId)
              : createSession(managed),
          );
        });
        for (const event of officeState.updateAgent(agentId, {
          effort: picked.level,
        }))
          emit(event);
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
    const handled = await handleSlashCommand(
      agentId,
      managed,
      cmd,
      args,
      text,
      username,
      device,
    );
    if (handled) return;
  }

  // Skip if the early echo at the top already covered this. We use the
  // snapshot rather than re-checking pending-* flags because pending-*
  // handlers above clear their flags, so a fall-through (e.g., non-numeric
  // reply during /resume) reaches here with the flag now false but still
  // needs the echo.
  if (!echoEarly) {
    addLogEntry(
      agentId,
      "user_message",
      text,
      buildUserMeta(username, device),
      attachments,
    );
    beginTurn(agentId, { humanInput: true });

    // Auto-generate topic on first user message in a conversation
    if (managed.info.topic === null && !managed.topicGenerating) {
      void generateTopic(agentId); // fire-and-forget
    }
  }

  const prefix = formatPrefix({ username, device });
  const prefixedText = prefix ? `${prefix}${text}` : text;
  const turn = createTurnDeferred(managed);
  const ownPending = managed.pendingTurn;
  try {
    await managed.session!.send(
      prefixedText,
      attachments && attachments.length > 0 ? attachments : undefined,
    );
    await turn;
  } catch (err) {
    // If session.send() (or anything before turn settled) threw, the deferred
    // we just created is still parked in managed.pendingTurn — unless a
    // session swap or a fresh turn took ownership of the slot. Reject + clear
    // only when we still own it so awaiting callers don't hang forever.
    if (ownPending && managed.pendingTurn === ownPending) {
      managed.pendingTurn = null;
      try {
        ownPending.reject(err);
      } catch {}
    }
    if (err instanceof SessionSwappedError) return;
    if (err instanceof BackendNotConfiguredError) {
      // Backend isn't usable (CLI missing, auth missing, etc.). The message
      // is already user-actionable — surface verbatim as a system entry,
      // plus an adjacent terminal-command card when the error carries a
      // companion install/login command. State goes to waiting_for_response
      // (not idle) so the desk shows the awake/waving pose; idle would
      // render as closed-eyes "sleeping" and make it look like the send
      // did nothing.
      emitLoginInstructions(agentId, {
        text: err.message,
        command: err.command,
      });
      updateState(agentId, "waiting_for_response");
      return;
    }
    console.error(`Agent ${agentId} send error:`, errMessage(err));
    addLogEntry(agentId, "error", `Error: ${errMessage(err)}`);
    updateState(agentId, "error");
  }
}

function persistCurrentSessionTopic(agentId: string, managed: ManagedAgent) {
  if (managed.sessionId && managed.info.topic && managed.info.topic !== "...") {
    persistSessionTopic(agentId, managed.sessionId, managed.info.topic);
  }
}

// Upper bound on the hot-abort wait. If codex doesn't ack turn/interrupt and
// emit turn_completed within this window, we abandon the in-place path and
// fall through to replaceSession so Stop is never a permanent no-op. Sized to
// be larger than typical RPC latency by a wide margin but small enough to be
// noticed as "something's wrong" if it ever fires.
const HOT_ABORT_TIMEOUT_MS = 7000;

export async function abort(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  // If no turn is in flight, the SDK stream may have died (e.g. subprocess
  // exited) while the UI still shows "thinking". Reset state so Stop is
  // never a no-op.
  if (!managed.pendingTurn) {
    if (
      managed.info.state === "thinking" ||
      managed.info.state === "tool_executing"
    ) {
      updateState(agentId, "waiting_for_response");
      addLogEntry(
        agentId,
        "system",
        "Agent interrupted (stream was already dead — state reset).",
      );
    }
    return;
  }
  // Re-entry guard: a second Stop while the first is still in flight just
  // waits for it instead of starting another abort that would reassign
  // abortPromise and stack abortDone closures.
  if (managed.aborting && managed.abortPromise) {
    try {
      await managed.abortPromise;
    } catch {}
    return;
  }
  managed.aborting = true;
  let abortDone!: () => void;
  managed.abortPromise = new Promise<void>((res) => {
    abortDone = res;
  });

  // Flip UI state and log the interrupt up front so the agent appears to
  // stop immediately. From the user's perspective the agent stops on Ctrl+C,
  // matching the Claude Code interactive behavior. The hot path keeps the
  // session alive so no drain is needed; the slow path drains while
  // runConsumer suppresses events from the dying session.
  updateState(agentId, "waiting_for_response");
  addLogEntry(agentId, "system", "Agent interrupted.");

  try {
    let needsReplace = !(managed.session && managed.session.canAbortInPlace());

    if (!needsReplace) {
      // Hot path (Codex with an active turn): send turn/interrupt and let
      // the natural turn_completed (status="interrupted") flow through the
      // consumer. The session stays alive — no subprocess kill, no respawn,
      // no .jsonl drain. Saves the ~1-2s replaceSession latency per abort.
      const result = await tryHotAbort(managed);
      if (result === "timeout") {
        addLogEntry(
          agentId,
          "system",
          "Codex didn't honor the interrupt in time; falling back to a fresh session.",
        );
        needsReplace = true;
      } else if (result === "session_died") {
        // Subprocess exit during the wait — processNormalizedEvent already
        // logged the failure and flipped state to "error". Replace below.
        needsReplace = true;
      }
    }

    if (needsReplace) {
      // Apply auto-resume policy at the point of replace, against the
      // freshest managed.sessionId — the hot-abort path can race with
      // session-died events that leave sessionId stale.
      const autoSessionId = pickAutoResumeSessionId(managed);
      if (managed.sessionId && !autoSessionId)
        clearStaleAutoResumeState(agentId, managed);
      const newSession = autoSessionId
        ? createSession(managed, autoSessionId)
        : createSession(managed);
      await replaceSession(agentId, managed, newSession);
      // If we got here via a hot-abort failure, processNormalizedEvent
      // flipped state to "error" — restore waiting_for_response so the
      // agent is usable again.
      if (managed.info.state === "error") {
        updateState(agentId, "waiting_for_response");
      }
    }
  } catch (err) {
    addLogEntry(
      agentId,
      "error",
      `Interrupt handler failed: ${errMessage(err)}`,
    );
    updateState(agentId, "error");
  } finally {
    managed.aborting = false;
    managed.abortPromise = null;
    abortDone();
  }
}

// Returns "ok" if codex acked turn/interrupt and emitted turn_completed
// (status="interrupted") within the timeout; "timeout" if the wait expired;
// "session_died" if the subprocess exited mid-interrupt (synthetic
// turn_completed{failed} routed through the error path and flipped state).
async function tryHotAbort(
  managed: ManagedAgent,
): Promise<"ok" | "timeout" | "session_died"> {
  // Race the RPC + wrap-and-wake against a timeout. The RPC itself can in
  // principle hang (a misbehaving codex that acks neither the request nor
  // the eventual turn_completed); covering both in the race means a single
  // timer protects the whole hot path.
  const inFlight = (async () => {
    await managed.session!.abort();
    // Mirror createSession's stale-approval cleanup: replaceSession would
    // have cleared this; the hot path doesn't go through createSession.
    managed.pendingPermission = null;
    if (!managed.pendingTurn) return;
    // Wrap-and-wake mirrors flushQueue's in-flight-turn wait. We wait here
    // so abortPromise doesn't resolve before pendingTurn settles — otherwise
    // a follow-up createTurnDeferred would supersede the original turn with
    // a "Superseded" error.
    const original = managed.pendingTurn;
    await new Promise<void>((wakeUp) => {
      managed.pendingTurn = {
        resolve: () => {
          original.resolve();
          wakeUp();
        },
        reject: (e: unknown) => {
          original.reject(e);
          wakeUp();
        },
      };
    });
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), HOT_ABORT_TIMEOUT_MS);
    });
    const result = await Promise.race([
      inFlight.then(() => "settled" as const),
      timeout,
    ]);
    if (result === "timeout") return "timeout";
  } finally {
    if (timer) clearTimeout(timer);
  }

  // pendingTurn settled. Distinguish clean interrupt (state still
  // waiting_for_response from the early flip above) from subprocess-death
  // recovery (processNormalizedEvent's error path set state="error").
  return managed.info.state === "error" ? "session_died" : "ok";
}

export async function kill(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  // The backend's close() (below, via managed.session?.close()) resolves any
  // in-flight SDK approval with deny; clearing pendingPermission here just
  // drops the orchestrator's pointer so the next message path doesn't think
  // an approval is pending.
  if (managed.pendingPermission) {
    managed.pendingPermission = null;
  }
  const turn = managed.pendingTurn;
  managed.pendingTurn = null;
  if (turn) {
    try {
      turn.reject(new Error("Agent killed."));
    } catch {}
  }
  const oldConsumer = managed.consumerPromise;
  try {
    managed.session?.close();
  } catch {}
  managed.session = null;
  // Remove from the map so the consumer's outer `agents.has(agentId)` guard exits.
  agents.delete(agentId);
  officeState.kill(agentId);
  logCache.delete(agentId);
  if (oldConsumer) {
    try {
      await oldConsumer;
    } catch {}
  }
  killSidecar(managed);
  emit({ type: "agent_removed", agentId });
}

export async function newConversation(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  managed.pendingResume = false;
  managed.pendingResumeSessions = [];
  managed.pendingModelPick = false;
  managed.pendingEffortPick = false;
  // /clear is a fresh start; queued messages from the prior context shouldn't
  // bleed into the new conversation.
  if (managed.messageQueue.length > 0) {
    managed.messageQueue.length = 0;
    emitQueueUpdate(agentId, managed);
  }
  persistCurrentSessionTopic(agentId, managed);

  try {
    const newSession = createSession(managed);
    await replaceSession(agentId, managed, newSession);
    managed.sessionId = null;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;
    managed.topicGenToken++;
    // Match /clear's behavior: wipe the chat. Without this, the timeline
    // continues across session boundaries and editing an old entry hits the
    // cross-session dead-end.
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId });
    // officeState.resetTopic mutates topic + topicStale, fires persistAll via
    // onChange (capturing the null sessionId set above).
    for (const event of officeState.resetTopic(agentId)) emit(event);
    updateState(agentId, "idle");
    addLogEntry(agentId, "system", "New conversation started.");
  } catch (err) {
    addLogEntry(
      agentId,
      "error",
      `Failed to start new conversation: ${errMessage(err)}`,
    );
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
  // Resuming switches context; queued messages from the prior session
  // shouldn't bleed into the resumed transcript.
  if (managed.messageQueue.length > 0) {
    managed.messageQueue.length = 0;
    emitQueueUpdate(agentId, managed);
  }
  persistCurrentSessionTopic(agentId, managed);

  try {
    const newSession = createSession(managed, sessionId);
    await replaceSession(agentId, managed, newSession);
    managed.sessionId = sessionId;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;
    managed.topicGenToken++;

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

    // Restore topic from sessions.json — officeState.updateAgent fires
    // persistAll via onChange, capturing the new sessionId set above.
    const sessions = listAgentSessions(agentId);
    const sessionEntry = sessions.find((s) => s.sessionId === sessionId);
    const restoredTopic = sessionEntry?.topic ?? null;
    for (const event of officeState.updateAgent(agentId, {
      topic: restoredTopic,
      topicStale: false,
    }))
      emit(event);

    updateState(agentId, "waiting_for_response");
    addLogEntry(
      agentId,
      "system",
      `Resumed session: ${restoredTopic || sessionId.slice(0, 8) + "..."}`,
    );

    // If no topic, regenerate from session logs
    if (!restoredTopic) {
      void generateTopic(agentId);
    }
  } catch (err) {
    addLogEntry(agentId, "error", `Failed to resume: ${errMessage(err)}`);
    updateState(agentId, "error");
  }
}

export async function editMessage(
  agentId: string,
  logEntryId: string,
  newText: string,
  username?: string,
  device?: string,
) {
  const managed = agents.get(agentId);
  if (!managed) return;
  if (managed.info.state !== "waiting_for_response") {
    addLogEntry(agentId, "error", "Cannot edit while agent is busy.");
    return;
  }

  const oldLogCache = [...(logCache.get(agentId) ?? [])];

  // Find target up front so the ephemeral short-circuit and the not-found
  // error can return before the fork pipeline runs.
  const targetEntry = oldLogCache.find((e) => e.id === logEntryId);
  if (!targetEntry || targetEntry.kind !== "user_message") {
    addLogEntry(agentId, "error", "Cannot edit: message not found.");
    return;
  }

  // Ephemeral entries (e.g., unknown / unsupported slash commands echoed via
  // command-handlers.ts's emitEphemeralLog path) never reached the backend
  // transcript, so there's no fork point. Rewrite the failed attempt by
  // trimming it + any trailing ephemeral siblings and re-dispatching through
  // sendMessage, which routes the corrected text back through the slash-
  // command pipeline so a fixed `/cmd` resolves to its handler. Refuse if
  // real turns or later user messages follow — the user can't selectively
  // rewrite without also discarding subsequent conversation.
  if (targetEntry.ephemeral) {
    // Multi-step flows (/resume, /model, /effort, permission prompts) leave
    // pending state on managed expecting the next user message as the pick.
    // Re-dispatching the edited text via sendMessage would be consumed by
    // that pending handler rather than treated as a replacement, silently
    // resuming a session / changing a model / answering a permission prompt.
    // Force the user to answer or cancel the pending flow first.
    if (inMultiStepFlow(managed)) {
      addLogEntry(
        agentId,
        "error",
        "Cannot edit this prompt while an interactive command is pending. Answer or cancel it first.",
      );
      return;
    }
    const targetPos = oldLogCache.findIndex((e) => e.id === logEntryId);
    const afterTarget = oldLogCache.slice(targetPos + 1);
    const hasRealAfter = afterTarget.some((e) => !e.ephemeral);
    const hasUserAfter = afterTarget.some((e) => e.kind === "user_message");
    if (hasRealAfter || hasUserAfter) {
      addLogEntry(
        agentId,
        "error",
        "Cannot edit: this message wasn't sent to the agent and newer messages followed. Send a new message instead.",
      );
      return;
    }
    const trimmed = oldLogCache.slice(0, targetPos);
    logCache.set(agentId, trimmed);
    emit({ type: "clear_logs", agentId });
    for (const entry of trimmed) {
      emit({ type: "log_entry", entry });
    }
    await sendMessage(agentId, newText, username, device);
    return;
  }

  // The fork pipeline below needs a backend session to fork from. Checked
  // here rather than at function entry so the ephemeral short-circuit above
  // can still fix a failed slash command in a session-less / first-message
  // state where sessionId is unset.
  if (!managed.sessionId) {
    addLogEntry(agentId, "error", "Cannot edit: no active session.");
    return;
  }

  // Editing forks the conversation; queued messages were addressed to the
  // pre-edit context and shouldn't bleed into the new branch. Mirrors the
  // behavior of /clear (newConversation) and /resume.
  if (managed.messageQueue.length > 0) {
    managed.messageQueue.length = 0;
    emitQueueUpdate(agentId, managed);
  }

  const oldSessionId = managed.sessionId;
  persistCurrentSessionTopic(agentId, managed);
  const oldTopic = managed.info.topic;
  const oldTopicStale = managed.info.topicStale;

  // Declared up here so the Phase-9 send's catch can reach it. Assigned the
  // moment the turn deferred is installed (Phase 9); null before then so a
  // pre-send throw doesn't try to reject something that was never created.
  let editOwnPending: ManagedAgent["pendingTurn"] = null;

  try {
    // --- Phase 1: Fallible SDK operations (no UI/cache mutations yet) ---

    // 1. Get backend session messages and match by content + occurrence index.
    //    For skill-expanded slash commands the log entry's `content` is the
    //    raw command (e.g. "/grill") but the SDK received the expanded prompt;
    //    `metadata.sdkText` captures that expanded form for matching.
    const backend = getBackend(managed.info.agentType);
    const backendMessages = await backend.getSessionMessages(
      oldSessionId,
      managed.info.cwd,
    );
    const targetUsername = targetEntry.metadata?.username as string | undefined;
    const targetDevice = targetEntry.metadata?.device as string | undefined;
    const targetSdkText =
      (targetEntry.metadata?.sdkText as string | undefined) ??
      targetEntry.content;
    const prefixedContent = `${formatPrefix({ username: targetUsername, device: targetDevice })}${targetSdkText}`;

    // Count which occurrence of this exact content this is among user_message log entries
    const userLogEntries = oldLogCache.filter((e) => e.kind === "user_message");
    let occurrenceIndex = 0;
    for (const e of userLogEntries) {
      const u = e.metadata?.username as string | undefined;
      const d = e.metadata?.device as string | undefined;
      const sdkText = (e.metadata?.sdkText as string | undefined) ?? e.content;
      const prefixed = `${formatPrefix({ username: u, device: d })}${sdkText}`;
      if (prefixed === prefixedContent) {
        if (e.id === logEntryId) break;
        occurrenceIndex++;
      }
    }

    // Find the matching user message in the backend transcript. We pass the
    // target's uuid to forkSessionBeforeMessage; each backend handles
    // predecessor-resolution and first-message semantics internally.
    let matchCount = 0;
    let targetIdx = -1;
    for (let i = 0; i < backendMessages.length; i++) {
      const m = backendMessages[i];
      if (m.role !== "user") continue;
      if (m.text === prefixedContent) {
        if (matchCount === occurrenceIndex) {
          targetIdx = i;
          break;
        }
        matchCount++;
      }
    }

    if (targetIdx === -1) {
      // Walk the agent's on-disk sessions to find which one owns the entry,
      // so the error tells the user where the message actually lives. The
      // chat can show entries from a session that isn't the current backend
      // session — e.g. ContextMenu "New conversation" doesn't clear logCache,
      // so the timeline continues across session boundaries.
      let ownerHint = "";
      try {
        for (const s of listAgentSessions(agentId)) {
          if (s.sessionId === oldSessionId) continue;
          if (loadLog(agentId, s.sessionId).some((e) => e.id === logEntryId)) {
            const label = s.topic ?? s.sessionId.slice(0, 8) + "...";
            ownerHint = ` This message lives in a different session ("${label}"). Use /resume to switch to it first, then edit.`;
            break;
          }
        }
      } catch {}
      addLogEntry(
        agentId,
        "error",
        `Cannot edit: could not locate message in backend session.${ownerHint}`,
      );
      return;
    }

    // 2. Ask the backend to fork before the edited message. The backend
    //    decides whether this produces a real linked branch (kind: "fork",
    //    parent preserved on disk) or a fresh unrelated session (kind:
    //    "fresh", first-message edits on backends without empty-history fork
    //    support — Claude). Codex always returns "fork" (fork-then-rollback
    //    preserves the parent even for first-message edits).
    const targetUuid = backendMessages[targetIdx].uuid;
    const forkResult = await backend.forkSessionBeforeMessage(
      oldSessionId,
      targetUuid,
    );
    const isFreshSession = forkResult.kind === "fresh";
    const newSessionId = forkResult.kind === "fork" ? forkResult.sessionId : "";

    // 3. Persist fork metadata for the linked-branch case only. Fresh
    //    sessions have no historical relationship to the parent — linking
    //    them would mislead /resume's branched UI.
    if (forkResult.kind === "fork") {
      // If the edited entry lives in an ancestor's JSONL (not the current session's own),
      // point forkedFrom at that ancestor directly. This collapses the chain so
      // loadLogWithAncestors cuts at the right level.
      let forkFromSessionId = forkResult.forkedFromSessionId;
      const ownEntries = loadLog(agentId, forkFromSessionId);
      if (!ownEntries.some((e) => e.id === logEntryId)) {
        const sessMap = loadSessionsMap(agentId);
        let walk: string | undefined = sessMap[forkFromSessionId]?.forkedFrom;
        const visited = new Set<string>([forkFromSessionId]);
        while (walk && !visited.has(walk)) {
          visited.add(walk);
          const ancestorEntries = loadLog(agentId, walk);
          if (ancestorEntries.some((e) => e.id === logEntryId)) {
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
      //
      // First-user-message edits (Codex only — Claude returns kind:"fresh"
      // here) start the child from empty context: the fork base must be
      // undefined, not findUsageAtFork's fall-back to the parent's full
      // cumulative. Otherwise lifetime accounting subtracts the parent's
      // entire usage from a child that did none of that work.
      const targetIsFirstUserMessage = !backendMessages
        .slice(0, targetIdx)
        .some((m) => m.role === "user");
      const parentBase = targetIsFirstUserMessage
        ? undefined
        : findUsageAtFork(agentId, forkFromSessionId, logEntryId);
      persistSessionFork(
        agentId,
        newSessionId,
        forkFromSessionId,
        logEntryId,
        oldTopic,
        parentBase,
      );
    }

    // 4. Create new session from fork (or fresh session for non-linked
    //    first-message edits), then close old.
    const newSession = isFreshSession
      ? createSession(managed)
      : createSession(managed, newSessionId);
    await replaceSession(agentId, managed, newSession);
    // For fresh sessions, sessionId is set by the system/init event (like newConversation).
    // For forks, set it now.
    managed.sessionId = isFreshSession ? null : newSessionId;
    managed.topicGenerating = false;
    managed.topicMessageCount = 0;
    managed.topicGenToken++;

    // --- Phase 2: UI/cache mutations (point of no return) ---

    // 5. Build parent entries (everything before the edited message)
    const parentEntries: LogEntry[] = [];
    for (const entry of oldLogCache) {
      if (entry.id === logEntryId) break;
      parentEntries.push(entry);
    }

    // 6. Clear UI and replay parent entries (not persisted — ancestors are loaded
    //    via loadLogWithAncestors on resume, avoiding log duplication on disk)
    logCache.set(agentId, []);
    emit({ type: "clear_logs", agentId });
    if (parentEntries.length > 0) {
      logCache.set(agentId, [...parentEntries]);
      for (const entry of parentEntries) {
        emit({ type: "log_entry", entry });
      }
    }

    // 7. Add system log entry at branch point
    addLogEntry(
      agentId,
      "system",
      `Branched from: ${oldTopic || oldSessionId.slice(0, 8) + "..."}`,
    );

    // 8. Inherit topic (marked stale so it regenerates after first exchange)
    for (const event of officeState.updateAgent(agentId, {
      topic: oldTopic,
      topicStale: true,
    }))
      emit(event);

    // 9. Send the edited message
    beginTurn(agentId, { humanInput: true });
    addLogEntry(
      agentId,
      "user_message",
      newText,
      buildUserMeta(username, device),
    );

    const editPrefix = formatPrefix({ username, device });
    const prefixedNew = editPrefix ? `${editPrefix}${newText}` : newText;
    const turn = createTurnDeferred(managed);
    editOwnPending = managed.pendingTurn;
    await managed.session!.send(prefixedNew);
    await turn;
    // Topic mutation above + system/init persistAll on first-message edits
    // already covered the persisted state; nothing further changes during
    // the turn that needs an end-of-edit snapshot.
  } catch (err) {
    // Symmetric with sendMessage/flushQueue: if session.send() threw before
    // `await turn` ran, the deferred we just installed is still parked in
    // managed.pendingTurn — reject + clear it so abort/state logic doesn't
    // observe a phantom in-flight turn during the rollback below.
    if (editOwnPending && managed.pendingTurn === editOwnPending) {
      managed.pendingTurn = null;
      try {
        editOwnPending.reject(err);
      } catch {}
    }
    // User aborted (or another explicit session swap) after the fork was
    // installed — the fork and its partial turn are a legitimate result,
    // not a failure. The triggering swap's own persistAll covered state.
    if (err instanceof SessionSwappedError) {
      return;
    }
    console.error(`Agent ${agentId} edit/fork error:`, errMessage(err));

    if (managed.sessionId !== oldSessionId) {
      // We switched to the fork — roll back to old session and restore UI
      try {
        const rollbackSession = createSession(managed, oldSessionId);
        await replaceSession(agentId, managed, rollbackSession);
        managed.sessionId = oldSessionId;
      } catch {
        // Can't restore session — the generic-error path below sets state to
        // "error" which surfaces the broken session. The BackendNotConfigured
        // path goes to "idle" regardless (friendlier UX over a rare edge
        // case where both rollback fails AND the backend is unconfigured).
      }

      // Restore the old log cache and UI
      logCache.set(agentId, oldLogCache);
      emit({ type: "clear_logs", agentId });
      for (const entry of oldLogCache) {
        emit({ type: "log_entry", entry });
      }

      // Restore topic
      for (const event of officeState.updateAgent(agentId, {
        topic: oldTopic,
        topicStale: oldTopicStale,
      }))
        emit(event);
    }

    if (err instanceof BackendNotConfiguredError) {
      // Rollback above already restored the pre-edit state; surface the
      // setup-required message calmly so the desk doesn't go red over a
      // misconfigured backend. Plus an adjacent terminal-command card when
      // the error carries a companion install/login command.
      // waiting_for_response (not idle) so the desk shows awake/waving —
      // the agent produced output and is waiting for the user to act on it.
      emitLoginInstructions(agentId, {
        text: err.message,
        command: err.command,
      });
      updateState(agentId, "waiting_for_response");
      return;
    }
    addLogEntry(
      agentId,
      "error",
      `Failed to branch conversation: ${errMessage(err)}`,
    );
    updateState(agentId, "error");
  }
}

export function setTopic(agentId: string, topic: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  // Invalidate any in-flight generateTopic so its delayed LLM result doesn't
  // overwrite the user's manual choice.
  managed.topicGenToken++;
  for (const event of officeState.setTopic(agentId, topic)) emit(event);
  const textCount = (logCache.get(agentId) ?? []).filter(
    (e) => e.kind === "user_message" || e.kind === "text",
  ).length;
  managed.topicMessageCount = textCount;
  // Persist to sessions.json so resume list shows the manual topic
  if (managed.sessionId) {
    persistSessionTopic(agentId, managed.sessionId, managed.info.topic);
  }
  updateManifest();
}

export function resetTopic(agentId: string) {
  const managed = agents.get(agentId);
  if (!managed) return;
  void generateTopic(agentId); // fire-and-forget
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

// --- Editor file open/save — implementation in file-editor.ts ---
//
// The editor is per-WS state (watchers, dirty buffers, tabs); these wrappers
// just resolve paths against the agent's cwd and run the disk ops. Watch
// lifecycle lives in server/index.ts where the WS connection is in scope.

export function openEditorFile(
  agentId: string,
  rawPath: string,
):
  | { ok: true; result: OpenFileResult }
  | { ok: false; error: "not_agent" | "bad_path" } {
  const managed = agents.get(agentId);
  if (!managed) return { ok: false, error: "not_agent" };
  const resolved = resolveEditorPath(rawPath, managed.info.cwd);
  if (resolved.kind === "bad_path") return { ok: false, error: "bad_path" };
  return { ok: true, result: openEditorFileImpl(resolved.path) };
}

export function saveEditorFile(
  absPath: string,
  content: string,
  expectedMtime: number,
  force: boolean,
): SaveFileResult {
  return saveEditorFileImpl(absPath, content, expectedMtime, force);
}

export function resolveEditorPathForAgent(
  agentId: string,
  rawPath: string,
): string | null {
  const managed = agents.get(agentId);
  if (!managed) return null;
  const resolved = resolveEditorPath(rawPath, managed.info.cwd);
  return resolved.kind === "ok" ? resolved.path : null;
}
