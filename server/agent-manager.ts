import type {
  AgentBackendType,
  AgentInfo,
  AgentOutfit,
  AgentState,
  Attachment,
  EffortLevel,
  KilledAgentSummary,
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
  effortLevelsFor,
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
  buildManifest,
  persistSessionTopic,
  persistSessionFork,
  persistSessionCwd,
  getSessionCwd,
  ensureSessionCwd,
  getSessionEngineConfig,
  stampSessionEngineConfig,
  backfillSessionEngineConfigs,
  type SessionEngineConfig,
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
  loadMessageQueuesRaw,
  saveMessageQueues,
  saveFile as savePersistedFile,
  type PersistedAgent,
  type Room,
  type AgentHistory,
  type AgentHistoryEntry,
} from "./persistence.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { autocompleteCommands } from "./commands.ts";
import { join, basename } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import { rmSync, statSync, readFileSync, existsSync } from "fs";
import {
  resolveCwd,
  validateCwd,
  claudeSessionFileExists,
  claudeProjectDir,
  codexRolloutFileExists,
  codexRolloutHasHistory,
  codexSessionsDir,
  moveClaudeSessionFile,
  diagnoseProcessExit,
} from "./cwd-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { memoryStore } from "./memory-store.ts";
import { generateOutfit } from "./outfit.ts";
import { computeIsomuxDiff, resolveDiffCwd } from "./isomux-diff.ts";
import { capturePreview } from "./preview-capture.ts";
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
import { getBackend as defaultResolveBackend } from "./backends/index.ts";
import type {
  ApprovalDecision,
  Backend,
  BackendSession,
  NormalizedEvent,
} from "./backends/types.ts";
import { OfficeState } from "../shared/office-state.ts";
import { versionOf } from "../shared/blob-version.ts";
import { buildEnvForUserId, setOfficeEnvFileProvider } from "./env-loader.ts";
import {
  mintAgentToken,
  revokeAgentToken,
  getAgentTokenRaw,
} from "./identity/tokens.ts";
import { getUserByName } from "./users.ts";
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
import {
  configurePluginHooks,
  runAgentTurn,
  stripPluginPrefix,
} from "./plugin-hooks.ts";
// --- Dependency injection (Phase 0.2) ---
//
// AgentManager was a singleton function-module (module-level officeState /
// eventHandler / agents map + exported functions). It is now an instantiable
// unit: createAgentManager(deps) owns its collaborators; the production wiring
// lives in createProductionAgentManager() at the bottom of this file. Tests
// inject a FakeBackend resolver, a capturing event sink, and a fresh
// OfficeState + persisted-agent snapshot for isolation. See
// internal-docs/generic-runtime-refactor.md (Phase 0.2 / "Dependency injection
// and module shape").

export interface ManagerDeps {
  // Backend resolver (production: getBackend). The ~16 body call sites flow
  // through this, making FakeBackend injectable into the orchestrator.
  resolveBackend: (agentType: AgentBackendType) => Backend;
  // Office / rooms / tasks state. The caller seeds rooms synchronously so
  // getRooms() returns real persisted ids before the async restoreAgents()
  // completes (auth.ts's snapshot provider depends on this).
  officeState: OfficeState;
  // The persisted rooms+agents snapshot (Room[] — each room carries its agents)
  // used by restoreAgents(). Production loads agents.json ONCE and seeds
  // officeState rooms from this same array, so boot reads it exactly once and
  // the auth snapshot sees what restore uses.
  initialRooms: Room[];
  // Event sink. Optional at construction (default noop); index.ts registers the
  // real WS-broadcast sink via onEvent() AFTER construction, because that
  // closure references broadcast helpers defined later in index.ts.
  eventSink?: EventHandler;
}

// Public surface of an AgentManager instance, derived from the explicitly
// assembled return object below. (See handoff note re: ReturnType vs a
// hand-written interface.)
export type AgentManager = ReturnType<typeof createAgentManager>;

export function createAgentManager(deps: ManagerDeps) {
  const getBackend = deps.resolveBackend;
  const officeState = deps.officeState;
  const initialLoadedAgents = deps.initialRooms;

  // Wire the plugin-hooks module to agent-manager's module-private pieces
  // (beginTurn / createTurnDeferred / logCache / room lookup). Called once at
  // boot from server/index.ts. Lives here rather than in plugin-hooks.ts so
  // that file stays decoupled from this one — runAgentTurn is the only
  // reverse import.
  function configurePluginHooksDeps(): void {
    configurePluginHooks({
      beginTurn,
      createTurnDeferred,
      getLogCache: (agentId) => logCache.get(agentId),
      getRoom: (roomId) => {
        const r = roomById(roomId);
        return r ? { id: r.id, name: r.name } : null;
      },
    });
  }

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
    commands?: string[];
  } {
    if (!managed) return { text: LOGIN_INSTRUCTIONS };
    // Resolve the merged env (process.env + office envFile + user envFile, in
    // override order) so the backend can recognize env-var auth (e.g. Codex
    // OPENAI_API_KEY in the user's envFile) and skip the full sign-in
    // walkthrough at a user who's already authed. Best-effort: if the envFile
    // is broken or missing now (e.g. user deleted it mid-session),
    // buildEnvForUserId throws — we want the original auth-error guidance to
    // still surface, not have the hint generator itself fail. Fall back to
    // undefined so the backend uses process.env. Mirrors the envForHints
    // pattern elsewhere in this file.
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(managed.info.userId);
    } catch {
      env = undefined;
    }
    return getBackend(managed.info.agentType).getLoginInstructions({ env });
  }

  // Emit a system log entry with the login/install text, plus an adjacent
  // terminal-command card per companion shell command the backend supplies.
  // Centralizes the dual-emission pattern so the four detectAgentAuthError
  // callsites and the BackendNotConfiguredError catch all render the same
  // shape: explanatory text first, then one or more clickable cards in the
  // order returned (e.g. Codex emits browser-OAuth + device-auth so the user
  // can pick based on whether the host has a usable browser).
  function emitLoginInstructions(
    agentId: string,
    instructions: { text: string; commands?: string[] },
  ): void {
    addLogEntry(agentId, "system", instructions.text);
    for (const command of instructions.commands ?? []) {
      emitAgentTerminalCommand(agentId, command);
    }
  }

  // Surface a BackendNotConfiguredError to the user: emit the actionable
  // hint+card, drain any queued sibling-agent messages (with a single summary
  // system entry so they don't vanish silently), then transition state to
  // waiting_for_response.
  //
  // The drain is load-bearing: it prevents the cross-path duplicate where one
  // user send produced two hint+card emissions. The original failure mode was
  // sendMessage's catch emitting once, then calling updateState — which sees
  // the still-queued sibling message and triggers flushQueue, which throws
  // the same BackendNotConfiguredError again, emitting the second hint+card.
  // Draining the queue in the catch zeroes messageQueue.length so updateState's
  // queue-flush trigger short-circuits.
  //
  // We deliberately don't suppress the hint+card on subsequent attempts —
  // every user message that hits a broken backend gets the full actionable
  // message. Boss preference: simpler over a terser repeated-failure UX.
  function surfaceBackendNotConfigured(
    agentId: string,
    managed: ManagedAgent,
    err: BackendNotConfiguredError,
  ): void {
    emitLoginInstructions(agentId, {
      text: err.message,
      commands: err.command ? [err.command] : undefined,
    });
    const queuedCount = managed.messageQueue.length;
    if (queuedCount > 0) {
      managed.messageQueue.length = 0;
      addLogEntry(
        agentId,
        "system",
        `Cleared ${queuedCount} queued message${queuedCount === 1 ? "" : "s"} because the backend is not configured.`,
      );
      emitQueueUpdate(agentId, managed);
      persistQueueState(agentId, managed);
    }
    updateState(agentId, "waiting_for_response");
  }

  // Build the metadata blob attached to a user_message log entry. Carries
  // username + device so display helpers can reconstruct `[Nil (Phone)]`. Old
  // log entries written before the device split lack the device key — readers
  // fall through to plain `[Nil]`.
  function buildUserMeta(
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
  // Agents mid-way through a LIVE Codex cwd change. The old thread is being
  // abandoned (a resumed Codex thread can't change cwd), but managed.sessionId is
  // kept pointing at it until the fresh thread's system_init lands, so the success
  // path's "new thread id" clear-branch runs and a synchronous replace failure can
  // roll back with the old id intact. The gap this set closes: Codex bootstraps
  // ASYNChronously, so a fresh-thread bootstrap FAILURE emits system_init with an
  // empty sessionId, which bypasses that clear-branch — leaving the abandoned old
  // id + stale logCache bound to the already-committed new cwd. The system_init
  // handler consumes this marker to clear that state on the empty-init path.
  const pendingCodexCwdReset = new Set<string>(); // agentId
  // Event sink (instance-scoped). index.ts overrides this via onEvent() after
  // construction; deps.eventSink lets tests capture emitted events.
  let eventHandler: EventHandler = deps.eventSink ?? (() => {});
  let officeStatePersistenceEnabled = false;
  // Fields on AgentInfo that aren't included in the persisted shape (see
  // persistAll below). agent_updated events that only touch these don't need
  // disk writes — relevant because state transitions fire many times per turn.
  const EPHEMERAL_AGENT_FIELDS = new Set([
    "state",
    "sessionSwapping",
    "topicStale",
    "turnHadHumanInput",
    // Pure runtime field: not in the persisted shape, and restore overrides it
    // (everyone lazy-restores dormant regardless). Without this, every dormant
    // toggle — demote, wake, swap, and now every lazy spawn + /clear release —
    // fires a full persistAll for nothing.
    "dormant",
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

  function getRooms(): RoomWire[] {
    return officeState.rooms.map((r) => ({ ...r }));
  }

  function getOfficeSettings(): OfficeSettings {
    return {
      prompt: officeState.office.prompt,
      envFile: officeState.office.envFile,
      name: officeState.office.name,
    };
  }

  function getTasks(): TaskItem[] {
    return [...officeState.tasks];
  }

  function addTask(
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

  function updateTask(
    id: string,
    changes: Partial<
      Pick<
        TaskItem,
        "title" | "description" | "priority" | "status" | "assignee"
      >
    >,
  ): TaskItem | null {
    const events = officeState.updateTask(id, changes);
    if (events.length === 0) return null;
    for (const event of events) eventHandler(event);
    return officeState.tasks.find((t) => t.id === id) ?? null;
  }

  function deleteTask(id: string): boolean {
    const before = officeState.tasks.length;
    const events = officeState.deleteTask(id);
    if (officeState.tasks.length === before) return false;
    for (const event of events) eventHandler(event);
    return true;
  }

  // Update office settings. Caller is responsible for validating envFile (see validateEnvPath).
  function setOfficeSettings(
    prompt: string | null,
    envFile: string | null,
    name: string | null,
  ) {
    const events = officeState.setOfficeSettings(prompt, envFile, name);
    // System prompt is rebuilt at every createSession from current office/room/agent
    // config, so the new office prompt automatically lands on the next conversation.
    for (const event of events) eventHandler(event);
  }

  function setRoomSettings(roomId: string, prompt: string | null): boolean {
    const events = officeState.setRoomSettings(roomId, prompt);
    if (events.length === 0) return false;
    // System prompt is rebuilt at every createSession — next conversation picks up
    // the new room prompt automatically.
    for (const event of events) eventHandler(event);
    return true;
  }

  // Validate an env file path. Returns key count on success, throws on failure.
  function validateEnvPath(path: string): number {
    const parsed = readEnvFile(path);
    return Object.keys(parsed).length;
  }

  function onEvent(handler: EventHandler) {
    eventHandler = handler;
  }

  // Get cached logs for an agent (used when browser connects after restore)
  function getAgentLogs(agentId: string): LogEntry[] {
    return logCache.get(agentId) ?? [];
  }

  function getAgentCommands(agentId: string): {
    commands: { name: string; description?: string }[];
    skills: SkillInfo[];
  } {
    const managed = agents.get(agentId);
    return {
      commands: managed?.slashCommands ?? [],
      skills: managed?.skills ?? [],
    };
  }

  function listSessions(agentId: string) {
    return listAgentSessions(agentId);
  }

  function getCurrentSessionId(agentId: string): string | null {
    return agents.get(agentId)?.sessionId ?? null;
  }

  // Phase 3c: resolve a stable roomId to its GLOBAL index in officeState.rooms
  // (canonical room order). roomId is the authority; this index is a derived
  // persist/display value — the persistence bucket order and the manifest's
  // human-readable room number — recomputed from roomId here. A live agent's
  // roomId always names a real room
  // (closeRoom is empty-only; roomId is validated at spawn, move, and restore),
  // so a miss is a genuine invariant breach: log loud and return -1 — NEVER
  // silently coerce to room 0. Callers apply their own safe fallback off -1.
  function globalRoomIndexOf(roomId: string): number {
    const idx = officeState.rooms.findIndex((r) => r.id === roomId);
    if (idx < 0) {
      console.error(
        `[3c] globalRoomIndexOf: unknown roomId "${roomId}" (${officeState.rooms.length} room(s)); returning -1`,
      );
    }
    return idx;
  }

  // Companion lookup for the sites that want the RoomWire object, not the index.
  // Returns undefined on miss (globalRoomIndexOf already logged loud); callers
  // keep their existing `if (!room)` fallback / suppression.
  function roomById(roomId: string): RoomWire | undefined {
    const idx = globalRoomIndexOf(roomId);
    return idx < 0 ? undefined : officeState.rooms[idx];
  }

  // Server-controlled view of an agent's identity, used by the HTTP message
  // endpoint to derive the sender label instead of trusting the request body.
  // Prevents an attacker from spoofing identity or injecting prefix-delimiter
  // characters into the prompt that follows.
  function getAgentDisplay(
    agentId: string,
  ): { name: string; roomName: string } | null {
    const managed = agents.get(agentId);
    if (!managed) return null;
    const room = roomById(managed.info.roomId);
    if (!room) return null;
    return { name: managed.info.name, roomName: room.name };
  }

  // Best-effort system note into an agent's chat (a plain log entry: boss-
  // visible in the UI, burns no turn, never enters the SDK conversation).
  // Used by the scheduled-message scheduler for delivery-failure notices.
  // Returns false when the agent doesn't exist.
  function addSystemNote(agentId: string, text: string): boolean {
    if (!agents.has(agentId)) return false;
    addLogEntry(agentId, "system", text);
    return true;
  }

  // validateCwd is re-exposed via the returned AgentManager (imported from
  // cwd-utils.ts); the bare module re-export is gone with the singleton.

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

  async function editAgent(
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
      agentType?: AgentInfo["agentType"];
    },
  ) {
    const managed = agents.get(agentId);
    if (!managed) return;

    // Engine switch. Changing the engine isn't a normal field edit: it starts a
    // FRESH conversation on the new engine (the current one is preserved in the
    // resume history, not lost). The dialog sends the new engine's chosen
    // model/effort/permission/sandbox, which we hand to newConversation as
    // overrides — it validates each against the target engine (undefined falls
    // back to that engine's default), recomputes capabilities, persists the old
    // session's topic (so it shows in the resume picker), and wipes the live
    // chat. Metadata edited in the same save (name/cwd/outfit/customInstructions)
    // is applied first; cwd was already validated by the route handler. We
    // deliberately do NOT move the old session's files — it's abandoned to
    // history under its own engine/cwd.
    if (
      (changes.agentType === "claude" || changes.agentType === "codex") &&
      changes.agentType !== managed.info.agentType
    ) {
      const meta: Parameters<typeof officeState.editAgent>[1] = {};
      if (changes.name) meta.name = changes.name;
      if (changes.cwd) meta.cwd = resolveCwd(changes.cwd);
      if (changes.outfit) meta.outfit = changes.outfit;
      if (changes.customInstructions !== undefined)
        meta.customInstructions = changes.customInstructions;
      if (Object.keys(meta).length > 0) {
        for (const event of officeState.editAgent(agentId, meta)) emit(event);
      }
      await newConversation(agentId, changes.agentType, {
        modelFamily: changes.modelFamily,
        effort: changes.effort,
        permissionMode: changes.permissionMode,
        codexSandbox: changes.codexSandbox,
      });
      return;
    }

    // Backend-specific validation. OfficeState can't reach the backend layer,
    // so we validate here and pass already-canonicalized values to it. NOTE:
    // the REST edit dep (index.ts) already rejected a mismatched modelFamily
    // with 422 invalid_model_family — the coercion below is canonicalization
    // for internal callers, not input laundering for the API surface.
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
      const targetModelFamily =
        validated.modelFamily ?? managed.info.modelFamily;
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

    // cwd is a property of the session: changing it must retarget the live
    // backend session (a backend process's cwd is fixed at spawn), so all the
    // cwd side effects — the Claude file move, the stored-cwd stamp, the Codex
    // thread drop — are deferred into the replace transaction below, where they
    // can be rolled back together with the mirror if the session install fails.
    // Capture the pre-mutation cwd + the agent's current identity env now (env is
    // stable across this edit — username isn't an editable field here).
    const cwdChanging = !!validated.cwd && validated.cwd !== managed.info.cwd;
    const oldCwd = managed.info.cwd;
    const targetCwd = validated.cwd;
    const cwdMoveEnv = cwdChanging
      ? buildEnvForUserId(managed.info.userId)
      : undefined;

    // Snapshot of all editable fields, captured BEFORE the mutation lands.
    // Used to roll the full edit back if session recreate fails — matches the
    // prior withAgentRollback contract, where the entire `updated` partial was
    // reverted on throw (not just the recreate-relevant subset).
    const snapshot: Partial<AgentInfo> = {
      name: managed.info.name,
      cwd: managed.info.cwd,
      outfit: managed.info.outfit,
      customInstructions: managed.info.customInstructions,
      // The version token travels WITH the blob (lockstep invariant): a
      // rollback that restored the blob but kept the bumped token would leave
      // the stored token underived from the stored blob, and every client —
      // which never saw an agent_updated for the held-back edit — would false-
      // 409 on its next valid instructions edit.
      customInstructionsVersion: managed.info.customInstructionsVersion,
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
    const settingTriggersReplace = !!(
      updated.modelFamily ||
      updated.effort ||
      updated.permissionMode ||
      updated.codexSandbox
    );
    const isClaude = managed.info.agentType === "claude";

    const codexCwdChange = cwdChanging && !isClaude;
    // A cwd change retargets the session. If a live backend process exists it
    // must be replaced (a process's cwd is fixed at spawn); if not, relocating the
    // on-disk session file + restamping its cwd is enough — the next message
    // resumes there (createSession always resumes at managed.info.cwd). Setting
    // changes (model/effort/permission/sandbox) replace regardless, as before.
    const needReplace =
      settingTriggersReplace || (cwdChanging && managed.session !== null);
    // Claude relocates its active session's files on ANY cwd change that has a
    // session id — live or lazily-restored (session null, sessionId set) — so a
    // later resume finds the .jsonl under the new project dir. Matches the
    // pre-per-session-cwd behavior, which moved files gated only on sessionId.
    const needClaudeFileMove =
      cwdChanging && isClaude && managed.sessionId !== null;

    // Codex can't carry a cwd across a resume (thread/resume ignores cwd — see
    // backends/codex/adapter.ts), so a cwd change abandons the thread; the next
    // message starts a fresh one in the new cwd. Split by whether a replace runs:
    //   - NO replace (lazy process AND cwd-only change): there's no session-install
    //     transaction to protect, so drop the id + clear logs NOW. The next message
    //     spawns fresh in the new cwd.
    //   - replace WILL run (live process, OR a setting change forces one): DEFER the
    //     drop into the replace via pendingCodexCwdReset (set below). Dropping now
    //     would lose the still-valid old id if that replace then fails and the edit
    //     rolls back — the lazy-cwd+setting foot-gun. Leaving sessionId set also
    //     lets the success-path system_init clear-branch (new id !== old id) wipe
    //     the abandoned chat.
    if (codexCwdChange && managed.sessionId && !needReplace) {
      clearStaleAutoResumeState(agentId, managed);
    }

    if (needReplace || needClaudeFileMove) {
      const activeSessionId = managed.sessionId;
      let claudeFileMoved = false;

      // Claude cwd change: relocate the active session's files to the new project
      // dir BEFORE any resume so createSession finds them there. A failed move
      // means Claude can't locate the .jsonl, so abort the whole edit (roll the
      // mirror back, reverse any partial move) rather than stamp the session into
      // a cwd it can't be resumed from — keeps source-of-truth metadata honest.
      if (needClaudeFileMove && activeSessionId && targetCwd) {
        const moved = moveClaudeSessionFile(
          activeSessionId,
          oldCwd,
          targetCwd,
          cwdMoveEnv,
        );
        if (!moved.ok) {
          officeState.updateAgent(agentId, snapshot);
          // Reverse a partial move so the file ends up where the rolled-back
          // mirror says it is. If the reverse itself fails the on-disk location no
          // longer matches oldCwd — surface that rather than mislead the user.
          let reversed = true;
          if (moved.moved) {
            reversed = moveClaudeSessionFile(
              activeSessionId,
              targetCwd,
              oldCwd,
              cwdMoveEnv,
            ).ok;
          }
          throw new Error(
            `Failed to move session files to ${targetCwd}: ${moved.error}. ` +
              (reversed
                ? `cwd change aborted; the session stays in ${oldCwd}.`
                : `cwd change aborted, but the session files could not be moved ` +
                  `back and now live in ${targetCwd}; resume may fail until they ` +
                  `are restored.`),
          );
        }
        // Lazy edits have no createSession preflight, so a session whose .jsonl is
        // missing at BOTH ends would otherwise get stamped into a cwd it can't be
        // resumed from. Proceed only if the file actually lives at the target now
        // — either we just moved it, or it was already there. (Live edits are also
        // covered: createSession's resume preflight would catch a missing file,
        // but failing here is a cleaner error and skips a pointless session spawn.)
        const fileAtTarget =
          moved.moved ||
          claudeSessionFileExists(targetCwd, activeSessionId, cwdMoveEnv);
        if (!fileAtTarget) {
          officeState.updateAgent(agentId, snapshot);
          throw new Error(
            `Session file for ${activeSessionId.slice(0, 8)}… was not found in ` +
              `${oldCwd} or ${targetCwd}; cwd change aborted. Start a new ` +
              `conversation to work in ${targetCwd}.`,
          );
        }
        claudeFileMoved = moved.moved;
      }

      // Replace the live session when needed. For a live Codex cwd change this
      // forces a fresh thread (a resumed Codex thread keeps its birth cwd); Claude
      // passes its active session through and resumes it at the new cwd. Skipped
      // entirely in the lazy case (no live process to retarget).
      if (needReplace) {
        // A Codex cwd change that reaches this replace (live, or lazy + a setting
        // change that forced the replace) abandons the old thread for a fresh one.
        // We intentionally do NOT drop managed.sessionId yet: leaving it set means
        // (a) the success-path system_init clear-branch (new id !== old id) wipes
        // the abandoned thread's chat without contaminating the fresh thread, and
        // (b) a SYNCHRONOUS createSession/replaceSession throw rolls back with the
        // old id intact (so a failed combined cwd+setting edit doesn't lose a
        // still-valid session pointer). But Codex bootstraps async — a fresh-thread
        // bootstrap failure lands later as system_init with an empty sessionId,
        // bypassing that clear-branch. Mark the agent so the empty-init path (and
        // the consumer's pre-init error path) knows to abandon the old id +
        // logCache. Cleared in the catch below (replace never installed the fresh
        // session, so the old one stands and there's nothing to abandon).
        if (codexCwdChange) pendingCodexCwdReset.add(agentId);
        const sessionId = codexCwdChange
          ? null
          : pickAutoResumeSessionId(managed);
        if (managed.sessionId && !sessionId && !codexCwdChange)
          clearStaleAutoResumeState(agentId, managed);
        try {
          await replaceSession(
            agentId,
            managed,
            sessionId
              ? createSession(managed, sessionId)
              : createSession(managed),
          );
        } catch (err) {
          // replaceSession failed before installing the fresh session: the old
          // session still stands, so there's no abandoned thread to reconcile.
          pendingCodexCwdReset.delete(agentId);
          officeState.updateAgent(agentId, snapshot);
          // Roll the Claude file move back so the on-disk session location stays
          // consistent with the rolled-back mirror. Surface a reverse failure —
          // otherwise the user sees only the replace error while the file sits in
          // the target cwd.
          if (claudeFileMoved && activeSessionId && targetCwd) {
            const rev = moveClaudeSessionFile(
              activeSessionId,
              targetCwd,
              oldCwd,
              cwdMoveEnv,
            );
            if (!rev.ok) {
              addLogEntry(
                agentId,
                "system",
                `Warning: after the failed cwd change, session files could not be ` +
                  `moved back to ${oldCwd} and now live in ${targetCwd}; resume ` +
                  `may fail until they are restored.`,
              );
            }
          }
          throw err;
        }
      }

      // Record the active session's new cwd as source of truth (after any replace
      // succeeded). Only the Claude same-session case needs an explicit stamp;
      // fresh sessions (Codex cwd change, or a from-scratch session) get stamped
      // by system_init's ensureSessionCwd.
      if (cwdChanging && isClaude && managed.sessionId && targetCwd) {
        persistSessionCwd(agentId, managed.sessionId, targetCwd);
      }
    }

    for (const event of events) eventHandler(event);
  }

  function swapDesks(deskA: number, deskB: number, roomId: string) {
    const events = officeState.swapDesks(deskA, deskB, roomId);
    for (const event of events) eventHandler(event);
  }

  function createRoom(name?: string): string {
    const events = officeState.createRoom(name);
    const created = events.find((e) => e.type === "room_created");
    if (!created) throw new Error("failed to create room");
    for (const event of events) eventHandler(event);
    return created.room.id;
  }

  function closeRoom(roomId: string): boolean {
    const events = officeState.closeRoom(roomId);
    if (events.length === 0) return false;
    for (const event of events) eventHandler(event);
    return true;
  }

  function renameRoom(roomId: string, name: string): boolean {
    const events = officeState.renameRoom(roomId, name);
    if (events.length === 0) return false;
    // Room name appears in the system prompt header; it's rebuilt at every
    // createSession, so agents in this room pick up the new name on their next
    // conversation automatically.
    for (const event of events) eventHandler(event);
    return true;
  }

  function moveAgent(agentId: string, targetRoomId: string): boolean {
    const events = officeState.moveAgent(agentId, targetRoomId);
    if (events.length === 0) return false;
    for (const event of events) eventHandler(event);
    return true;
  }

  function getAllAgents(): AgentInfo[] {
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

  // Shared entry builder for the on-disk manifest (agents-summary.json) and
  // the GET /agents discovery endpoint — one source so they can't drift.
  function manifestEntries() {
    const rooms = officeState.rooms;
    return [...agents.values()].map((a) => {
      // Phase 3c: the manifest's `room` number (and its room name) is a
      // derived display field, recomputed from the authoritative roomId.
      const roomIdx = globalRoomIndexOf(a.info.roomId);
      return {
        id: a.info.id,
        name: a.info.name,
        desk: a.info.desk,
        room: roomIdx,
        roomName: rooms[roomIdx]?.name ?? `Room ${roomIdx + 1}`,
        roomId: a.info.roomId,
        topic: a.info.topic,
        cwd: a.info.cwd,
        modelFamily: a.info.modelFamily,
        // Concrete model id: for Claude families resolve via FAMILY_TO_MODEL,
        // for Codex agents the value itself IS the codex model id (e.g. "gpt-5.5").
        model: isClaudeFamily(a.info.modelFamily)
          ? FAMILY_TO_MODEL[a.info.modelFamily]
          : a.info.modelFamily,
        username: a.info.username,
      };
    });
  }

  function updateManifest() {
    writeManifest(manifestEntries());
  }

  // Live manifest for GET /agents — same JSON shape as the file writeManifest
  // persists to ~/.isomux/agents-summary.json.
  function getManifest() {
    return buildManifest(manifestEntries());
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
      // Phase 3c: bucket into the persisted rooms array by the roomId-derived
      // global index (AgentInfo no longer carries a dense room field).
      const roomIdx = globalRoomIndexOf(a.info.roomId);
      if (roomIdx >= 0 && roomIdx < persistedRooms.length) {
        persistedRooms[roomIdx].agents.push({
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
          roomId: a.info.roomId,
          privileged: a.info.privileged ?? false,
        });
      }
    }
    saveAgents(persistedRooms);
    updateManifest();
    updateAgentHistory();
  }

  // Snapshot live agents into history. Loop only iterates the live `agents`
  // map, so killed entries are preserved as-is (their `killedAt` and revive
  // payload stamped by `kill()` survive). Two consumers: /isomux-usage attribution
  // for killed agents, and the spawn menu's revive chips (which read the snapshot
  // to rehydrate config).
  function updateAgentHistory() {
    const history: AgentHistory = loadAgentHistory();
    for (const a of agents.values()) {
      const room = roomById(a.info.roomId);
      if (!room) continue;
      history[a.info.id] = {
        name: a.info.name,
        lastRoomId: room.id,
        lastRoomName: room.name,
        killedAt: null,
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
        privileged: a.info.privileged ?? false,
      };
    }
    saveAgentHistory(history);
  }

  // Wire-summary chip payload for a live agent at kill time.
  function buildKilledAgentSummary(
    agentId: string,
    a: ManagedAgent,
  ): KilledAgentSummary | null {
    const room = roomById(a.info.roomId);
    if (!room) return null;
    return {
      id: agentId,
      name: a.info.name,
      agentType: a.info.agentType,
      lastRoomId: room.id,
      lastRoomName: room.name,
      topic: a.info.topic,
      killedAt: Date.now(),
    };
  }

  // Wire-summary chip payload from a history entry. Legacy pre-revive entries
  // (only name + lastRoom*, no killedAt) surface as Claude chips with their
  // log-dir mtime as a proxy for the kill time — revive() defaults the
  // missing config fields and tries to surface the on-disk transcript.
  function killedAgentSummaryFromHistory(
    agentId: string,
    entry: AgentHistoryEntry,
    fallbackKilledAt: number,
  ): KilledAgentSummary {
    return {
      id: agentId,
      name: entry.name,
      agentType: entry.agentType ?? "claude",
      lastRoomId: entry.lastRoomId,
      lastRoomName: entry.lastRoomName,
      topic: entry.topic ?? null,
      killedAt: entry.killedAt ?? fallbackKilledAt,
    };
  }

  // All currently-killed agents, sorted newest-first. Caller layers ACL
  // filtering and the cap. Legacy entries (no killedAt) get the agent's log
  // dir mtime as a proxy so they sort approximately by recency.
  function getKilledAgentSummaries(): KilledAgentSummary[] {
    const history = loadAgentHistory();
    const summaries: KilledAgentSummary[] = [];
    for (const [id, entry] of Object.entries(history)) {
      if (agents.has(id)) continue; // revived agents have a history entry but are alive
      const fallback = entry.killedAt ? 0 : legacyKilledAtFromDisk(id);
      // Skip entries with no killedAt AND no on-disk log dir — there's nothing
      // to revive and no ordering signal.
      if (!entry.killedAt && !fallback) continue;
      summaries.push(killedAgentSummaryFromHistory(id, entry, fallback));
    }
    summaries.sort((a, b) => b.killedAt - a.killedAt);
    return summaries;
  }

  // For legacy entries (no kill-time stamp), use the agent's log directory
  // mtime as a "last-touched" proxy. One stat call per legacy entry; fine
  // for the ~100-entry scale this file reaches in practice.
  function legacyKilledAtFromDisk(agentId: string): number {
    try {
      return statSync(join(STATE_ROOT, "logs", agentId)).mtimeMs;
    } catch {
      return 0;
    }
  }

  // Shared per-agent install path used by both restoreAgents() at boot and
  // revive(). Validates persisted config, builds AgentInfo + ManagedAgent,
  // loads logs, attempts session startup. Boot skips the agent_added emit
  // (full_state covers it on first connect); revive emits it after a
  // successful install (rolls back via agents.delete + officeState.kill
  // otherwise so the killed-agent chip stays retryable).
  function restoreOrReviveAgent(opts: {
    persisted: PersistedAgent;
    roomIdx: number;
    // Caller-chosen desk override (revive uses this; boot falls through to persisted.desk).
    deskOverride?: number;
    emitAgentAdded: boolean;
    // Revive-only: on resume failure (missing/corrupt session), retry as
    // fresh. Boot leaves the agent in error state with an explanation log.
    fallbackToFreshOnResumeFailure?: boolean;
    // Boot-only: restore the agent lazy (no subprocess) rather than eagerly
    // spawning a session. The agent comes back on its desk, conversation intact,
    // dormant; the first message wakes it via flushQueue's !session branch. This
    // is what makes a restart free idle agents' RAM instead of re-spawning all
    // of them at once (the OOM thundering-herd). Revive leaves this unset (eager,
    // preserving its resume-failure fallback).
    lazy?: boolean;
  }): { sessionOk: boolean; sessionError: string | null } {
    const p = opts.persisted;
    const agentType = p.agentType ?? "claude";
    const userId = resolveAgentUserId(p);
    // Same validators as spawn/edit — canonicalizes persisted values
    // (e.g. codex 0.130 deprecated "on-failure" → "on-request").
    const modelFamily = validateModelFamily(agentType, p.modelFamily);
    const permissionMode = validatePermissionMode(agentType, p.permissionMode);
    const effort = validateEffort(agentType, modelFamily, p.effort);
    const codexSandbox =
      agentType === "codex" ? validateCodexSandbox(p.codexSandbox) : undefined;
    // Tag any pre-feature sessions (no stored engine) with this agent's current
    // engine before it can switch. Runs once per agent at boot/revive; at this
    // point current-engine == the engine every existing session ran under, so a
    // later cross-engine resume of an old session flips back correctly instead of
    // dead-ending on a wrong-backend createSession. (See backfill comment.)
    backfillSessionEngineConfigs(p.id, {
      agentType,
      modelFamily,
      effort,
      permissionMode,
      codexSandbox,
    });
    // Codex auto-resume policy: thread must have on-disk history to resume.
    // Claude trusts lastSessionId (createSession surfaces a missing-file error).
    let resumeSessionId: string | null = null;
    if (p.lastSessionId) {
      if (agentType === "codex") {
        try {
          const restoreEnv = buildEnvForUserId(userId);
          if (codexRolloutHasHistory(p.lastSessionId, restoreEnv)) {
            resumeSessionId = p.lastSessionId;
          }
        } catch {
          resumeSessionId = p.lastSessionId;
        }
      } else {
        resumeSessionId = p.lastSessionId;
      }
    }
    const persistedTopicCount = resumeSessionId
      ? (listAgentSessions(p.id).find((s) => s.sessionId === resumeSessionId)
          ?.topicMessageCount ?? 0)
      : 0;
    const desk = opts.deskOverride ?? p.desk;
    // Phase 3c: resolve the agent's stable roomId from its container room
    // (opts.roomIdx is the physical truth from the persisted bucket). Clamp +
    // log if the index is out of range (corrupt state) rather than silently
    // mapping to room 0.
    const containerRoom = officeState.rooms[opts.roomIdx];
    if (!containerRoom) {
      console.error(
        `[3c] restore: roomIdx ${opts.roomIdx} out of range for agent ${p.id} (${officeState.rooms.length} room(s)); clamping to room 0`,
      );
    } else if (p.roomId && p.roomId !== containerRoom.id) {
      console.log(
        `[3c] restore: agent ${p.id} persisted roomId ${p.roomId} != container ${containerRoom.id}; using container`,
      );
    }
    const roomId = containerRoom?.id ?? officeState.rooms[0]?.id ?? "";
    const info: AgentInfo = {
      id: p.id,
      name: p.name,
      desk,
      roomId,
      cwd: p.cwd,
      outfit: p.outfit,
      permissionMode,
      modelFamily,
      effort,
      // Pose tracks whether there's a conversation, not whether the subprocess
      // is loaded. A resumable session (resumeSessionId set) comes back
      // "waiting_for_response" — it finished its last turn and is waiting on the
      // human — whether restored eagerly or lazily; only a genuinely blank agent
      // (no resumable session) is "idle". Keying this off opts.lazy used to leak
      // the RAM detail into the UI: every conversation agent slept (idle pose)
      // after a restart until messaged, and lost Tab priority to blank desks.
      // editMessage forks from the on-disk session, so a dormant
      // "waiting_for_response" agent edits fine (the fork wakes it).
      state: resumeSessionId ? "waiting_for_response" : "idle",
      topic: p.topic ?? null,
      // Determined by the textCount scan below after logs load.
      topicStale: false,
      customInstructions: p.customInstructions ?? null,
      // Derived from the blob (never persisted separately), so legacy records
      // that predate the field backfill correctly on load.
      customInstructionsVersion: versionOf(p.customInstructions ?? ""),
      agentType,
      ...(codexSandbox ? { codexSandbox } : {}),
      capabilities: getBackend(agentType).capabilities,
      userId,
      username: p.username ?? null,
      privileged: p.privileged ?? false,
      queue: [],
      sessionSwapping: false,
      turnHadHumanInput: false,
      // Dormant iff lazy-restored (no subprocess). Eager paths install a session
      // below, which clears it (already false here, so installSession no-ops).
      dormant: !!opts.lazy,
    };
    officeState.addExistingAgent(info);
    const managed: ManagedAgent = {
      info,
      session: null,
      sessionId: resumeSessionId,
      consumerPromise: null,
      pendingTurn: null,
      afterTurnPromise: null,
      turnCancelToken: 0,
      abortCancelToken: -1,
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
      topicMessageCount: persistedTopicCount,
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
      flushStartedAt: 0,
      lastForcedRecoveryAt: 0,
      queueDedupe: new Map(),
      lastActiveAt: Date.now(),
      dormantReason: opts.lazy ? "boot" : null,
    };
    // Durable queue replay (task 9870b472): re-seed the queue + dedupe window
    // persisted by the previous run so a restart doesn't drop queued messages
    // (delivery order preserved; expired dedupe keys dropped). restoreAgents
    // kicks a flush for every non-empty replayed queue after the loop. A
    // revived agent has no record (kill removes it), so this no-ops there.
    const persisted = readPersistedQueueRecord(p.id);
    if (persisted) {
      managed.messageQueue = persisted.queue;
      managed.queueDedupe = persisted.dedupe;
    }
    agents.set(p.id, managed);
    // Mint (or rotate, on revive) the agent's bearer token before any
    // createSession/resumeSession below reads it via buildSessionEnv. Boot
    // restore and revive both funnel here, so "rotated on revive" is automatic;
    // revoked when the agent leaves the map (kill, or the revive rollback). The
    // persisted privileged flag stamps the token's capability set.
    mintAgentToken(p.id, userId, p.privileged ?? false);

    if (resumeSessionId) {
      const history = loadLogWithAncestors(p.id, resumeSessionId);
      if (history.length > 0) {
        logCache.set(p.id, [...history]);
      }
      if (info.topic) {
        const textCount = history.filter(
          (e) => e.kind === "user_message" || e.kind === "text",
        ).length;
        const drift = textCount - persistedTopicCount;
        if (drift > 0) {
          info.topicStale = true;
        }
        // Lazy restore skips eager topic-gen: generateTopic spawns a transient
        // one-shot subprocess, and firing a burst of them during boot is the
        // exact thundering-herd lazy restore exists to avoid. The drift re-check
        // on the agent's next real turn regenerates it.
        if (!opts.lazy && drift >= TOPIC_REGEN_THRESHOLD) {
          void generateTopic(p.id);
        }
      }
    }

    // Lazy restore: stop here. The agent is on its desk (addExistingAgent above),
    // state="idle", dormant=true, sessionId set, transcript loaded into logCache,
    // and its token is minted — everything the wake path needs. The first message
    // resumes it via flushQueue's !session branch, which writes its own
    // interruption marker from the logCache tail. No createSession = no boot
    // subprocess and zero idle RAM. (emitAgentAdded is false on boot; the snapshot
    // returned by restoreAgents carries the agent.)
    if (opts.lazy) {
      if (opts.emitAgentAdded) emit({ type: "agent_added", agent: info });
      return { sessionOk: true, sessionError: null };
    }

    // Decision now, write later: the marker only lands on disk after
    // session install succeeds AND we actually resumed (not fresh-fellback).
    // See gated addLogEntry below.
    const shouldAddInterruptionMarker = !!(
      resumeSessionId &&
      (logCache.get(p.id) ?? []).at(-1)?.kind === "user_message"
    );

    // Session install: try resume, optionally fall back to fresh on failure,
    // record state=error if both fail. agent_added is deferred to after this
    // settles so the broadcast state reflects reality (and so a failed revive
    // never emits an add the client will then see removed).
    let sessionOk = false;
    let sessionError: string | null = null;

    try {
      const session = resumeSessionId
        ? createSession(managed, resumeSessionId)
        : createSession(managed);
      installSession(p.id, managed, session);
      sessionOk = true;
    } catch (err) {
      sessionError = errMessage(err);
      if (resumeSessionId && opts.fallbackToFreshOnResumeFailure) {
        console.warn(
          `[revive] Resume of ${p.name} failed, falling back to fresh session: ${sessionError}`,
        );
        managed.sessionId = null;
        // Keep the loaded transcript in logCache so the chat view shows the
        // historical conversation (especially important for legacy revivals
        // where the SDK can never resume because cwd/project dir don't
        // match). New messages start a fresh SDK session that doesn't have
        // that context, but the boss can read the past.
        // Clear the historical topic — it was derived from the OLD session
        // that we can no longer resume. The fresh session will regenerate
        // its own topic from new messages.
        officeState.updateAgent(p.id, { state: "idle", topic: null });
        try {
          const freshSession = createSession(managed);
          installSession(p.id, managed, freshSession);
          sessionOk = true;
          sessionError = null;
        } catch (err2) {
          sessionError = errMessage(err2);
        }
      }
    }

    if (!sessionOk) {
      console.error(
        `Failed to restore session for ${p.name}:`,
        sessionError ?? "(unknown)",
      );
      officeState.updateAgent(p.id, { state: "error" });
      const entry: LogEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        agentId: p.id,
        timestamp: Date.now(),
        kind: "error",
        content: `Failed to restore on startup: ${sessionError ?? "(unknown)"}\nType /clear to start fresh, or /resume to pick another session.`,
      };
      const cached = logCache.get(p.id) ?? [];
      cached.push(entry);
      logCache.set(p.id, cached);
    }

    // Marker write: only after resume actually happened (fresh fallback
    // nulls managed.sessionId so this skips). Mirrors the SDK's own lazy
    // placeholder for interrupted-on-resume sessions.
    if (
      sessionOk &&
      shouldAddInterruptionMarker &&
      resumeSessionId !== null &&
      managed.sessionId === resumeSessionId
    ) {
      addLogEntry(p.id, "system", "Previous response was interrupted.");
    }

    // Emit only on success so a failed revive doesn't flicker an add the
    // client will then see removed by the rollback.
    if (opts.emitAgentAdded && sessionOk) {
      emit({ type: "agent_added", agent: info });
    }

    return { sessionOk, sessionError };
  }

  // Restore agents from disk on startup. Creates sessions and loads log history.
  async function restoreAgents() {
    // Clean up the pre-0.2.116 per-agent launcher scripts. Isomux now passes the
    // native Claude binary directly, so these are orphaned.
    try {
      rmSync(join(STATE_ROOT, "launchers"), {
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
        restoreOrReviveAgent({
          persisted: p,
          roomIdx,
          emitAgentAdded: false,
          // Boot restores agents lazy: no subprocess until first message. Frees
          // idle RAM and removes the all-at-once respawn spike on restart.
          lazy: true,
        });
      }
    }
    // Round-trip migrations back to disk in case the load step filled in new
    // fields (room ids, prompt/envFile defaults) that weren't present before.
    // Must run AFTER agents are populated or persistAll writes empty rooms.
    persistAll();
    officeState.setTasksDirect(loadTasks());
    officeStatePersistenceEnabled = true;
    // Durable-queue hygiene (task 9870b472): drop records for agents that no
    // longer exist (e.g. killed while the store write failed, or removed from
    // agents.json by hand). Copy-on-success like every store write: the cache
    // only advances to the pruned view once it is actually on disk.
    {
      const stale = Object.keys(queueStore()).filter((k) => !agents.has(k));
      if (stale.length > 0) {
        const next = { ...queueStore() };
        for (const key of stale) delete next[key];
        try {
          saveMessageQueues(next);
          queueStoreCache = next;
        } catch (err) {
          console.error(
            "Failed to prune stale message-queue records:",
            errMessage(err),
          );
        }
      }
    }
    // Boot replay kick: resume delivery exactly where the restart cut it off.
    // Fire-and-forget — each flush wakes its (dormant) agent via the !session
    // resume branch. Plugin hooks are configured before restoreAgents runs
    // (see index.ts boot ordering), so runAgentTurn is safe to enter. The
    // queue watchdog is the backstop if any kick is lost.
    for (const [agentId, m] of agents) {
      if (m.messageQueue.length > 0) {
        console.log(
          `Replaying ${m.messageQueue.length} queued message(s) for ${m.info.name} (${agentId})`,
        );
        flushQueue(agentId).catch((err: unknown) => {
          console.error(
            `flushQueue (boot-replay) failed for ${agentId}:`,
            errMessage(err),
          );
        });
      }
    }
    return [...agents.values()].map((a) => a.info);
  }

  function getAgent(agentId: string): AgentInfo | undefined {
    return agents.get(agentId)?.info;
  }

  // Run the same path-resolution as /isomux-edit and emit an `edit-request` log
  // entry so the boss can open the file in the editor side panel. Mirrors
  // emitAgentDiff. The card shows an [Open in editor] button — the panel never
  // auto-opens (matches the rejected "server auto-opens panel" decision).
  function emitAgentEditRequest(
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
  function emitAgentTerminalCommand(
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

  // Display cap for POST /api/agents/:id/read-file. Independent from the editor
  // panel's 1 MB text cap (file-editor.ts) — this one bounds binary/image
  // display payloads served through /api/files.
  const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;

  // Resolve a path against the agent's cwd, copy it into the agent's files dir
  // (hash-deduped via saveFile), and emit a `file-view` log entry so the UI
  // renders the attachment inline. Replaces the older convention of asking
  // agents to Read an image so the Claude SDK's tool_result image extraction
  // would surface it. Mirrors emitAgentEditRequest's error-surface pattern:
  // path/size/io failures become system messages, not HTTP errors.
  function emitAgentReadFile(
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

  // Screenshot a URL (headless Chrome CLI via preview-capture.ts)
  // and emit a `file-view` card, reusing read-file's attachment path. Used by
  // POST /api/agents/:id/preview-url (task dcfd5a97). Unlike the sync
  // affordances this is async, and failures return structured HTTP errors
  // (status + code) instead of system chat messages: a failed screenshot has
  // no boss-facing value, and the calling agent is the one who must react
  // (start the dev server, fix the URL, retry). The entry's `content` is the
  // sanitized origin+pathname; the UI renders it as a visible caption.
  async function emitAgentPreviewUrl(
    agentId: string,
    body: unknown,
  ): Promise<
    { ok: true } | { ok: false; status: number; code: string; error: string }
  > {
    const managed = agents.get(agentId);
    if (!managed)
      return {
        ok: false,
        status: 404,
        code: "not_found",
        error: "agent not found",
      };
    const result = await capturePreview(body);
    if (!result.ok) return result;
    const att = savePersistedFile(
      agentId,
      result.png,
      "image/png",
      result.filename,
    );
    if (!att) {
      return {
        ok: false,
        status: 500,
        code: "save_failed",
        error: "failed to persist the screenshot",
      };
    }
    // metadata.preview marks the caption as renderable: the UI shows
    // `content` under the image ONLY for entries carrying this marker, so
    // read-file cards (content = the attachment's own filename) and any other
    // file-view producer stay caption-free by explicit contract, not
    // inference.
    addLogEntry(agentId, "file-view", result.caption, { preview: true }, [att]);
    return { ok: true };
  }

  // Run the same diff machinery as /isomux-diff and emit the result into the
  // agent's chat stream. Used by POST /api/agents/:id/diff so an agent can show
  // the boss a styled diff card without the boss invoking the slash command.
  function emitAgentDiff(
    agentId: string,
    dir?: string,
    commit?: string,
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
    const result = computeIsomuxDiff(resolved.cwd, { commit });
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
      case "bad_commit":
        addLogEntry(
          agentId,
          "system",
          `Cannot diff \`${result.attempted}\`: ${result.message}.`,
        );
        break;
      case "clean":
        addLogEntry(
          agentId,
          "system",
          commit
            ? `\`${commit}\` introduced no file changes (empty commit?).`
            : `Working tree clean in \`${result.cwd}\` — no uncommitted changes.`,
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
    managed.lastActiveAt = Date.now();
    if (managed.info.turnHadHumanInput !== opts.humanInput) {
      for (const event of officeState.updateAgent(agentId, {
        turnHadHumanInput: opts.humanInput,
      }))
        emit(event);
    }
    // Idempotency: runAgentTurn always calls beginTurn at the moment of send,
    // even when the call site already did an early-echo beginTurn (sendMessage's
    // top-of-function path that wants the UI to flip to "thinking" immediately
    // before the ~3s abortPromise wait). Re-entering updateState with state
    // already === "thinking" would re-emit an agent_updated event for an
    // unchanged value; this early-return keeps the second call free of side
    // effects.
    if (managed.info.state === "thinking") return;
    updateState(agentId, "thinking");
  }

  function updateState(agentId: string, state: AgentState) {
    const managed = agents.get(agentId);
    if (!managed) return;
    if (state === "thinking" && managed.info.state !== "thinking") {
      managed.thinkingStartedAt = Date.now();
    }
    const prev = managed.info.state;
    for (const event of officeState.updateAgent(agentId, { state }))
      emit(event);

    // Turn-end activity stamp: entering a queue-idle state means the turn just
    // finished, so reset the idle clock here too (not only at turn start). "Idle
    // N min" should mean "quiet for N min" — otherwise a long turn that ends
    // would be demoted by the very next sweep and a boss follow-up moments later
    // would eat a cold resume.
    if (state !== prev && isQueueIdleState(state)) {
      managed.lastActiveAt = Date.now();
    }

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
      // /isomux-usage's per-turn snapshots have a stable anchor inside the log.
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

  // Auto-regenerate the topic once this many new user_message+text entries have
  // accumulated since the topic was last generated. The goal is catching
  // "the conversation is now about a fundamentally different thing" (the same
  // signal /clear gives explicitly), not chasing every subtle drift — a smaller
  // number would burn Sonnet calls on minor shifts that the original topic
  // still describes well enough. Users who want an earlier refresh have the ↻
  // button in LogView (calls resetTopic, no threshold).
  const TOPIC_REGEN_THRESHOLD = 20;

  // True when the conversation has accumulated enough new exchanges since the
  // topic was generated that the topic likely no longer describes what the
  // agent is actually working on. Used by the post-resume / post-restart /
  // long-session triggers; the manual ↻ button uses the looser topicStale
  // signal (any drift at all) via resetTopic directly.
  function shouldAutoRegenerateTopic(managed: ManagedAgent): boolean {
    if (!managed.info.topicStale) return false;
    if (managed.info.topic === null || managed.info.topic === "...")
      return false;
    const textCount = (logCache.get(managed.info.id) ?? []).filter(
      (e) => e.kind === "user_message" || e.kind === "text",
    ).length;
    return textCount - managed.topicMessageCount >= TOPIC_REGEN_THRESHOLD;
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

    // Build context: first user message + last 5 user messages.
    // textEntries (user + text) is still the drift-counting source — it
    // measures how far the conversation has moved since the last regen — but
    // the labeller itself only sees user messages. Assistant text in the
    // prompt biases the model toward whatever the agent happened to quote /
    // paste from files, which produces confidently-wrong labels rooted in
    // incidental content (e.g. a labeller fed a file-read snippet describing
    // mermaid will label the conversation "mermaid" even if the user never
    // asked about mermaid). Restricting to user messages anchors the label
    // to what the user actually said. Each message is capped at 1000 chars
    // so a single long bug report doesn't crowd out the rest.
    const logs = logCache.get(agentId) ?? [];
    const textEntries = logs.filter(
      (e) => e.kind === "user_message" || e.kind === "text",
    );
    const userEntries = logs.filter((e) => e.kind === "user_message");
    const firstUserMsg = userEntries[0];
    if (!firstUserMsg) {
      managed.topicGenerating = false;
      for (const event of officeState.updateAgent(agentId, { topic: null }))
        emit(event);
      return;
    }

    const CAP = 1000;
    const lastFive = userEntries.slice(-5);
    let context: string;
    if (userEntries.length <= 1) {
      context = `User message: ${firstUserMsg.content.slice(0, CAP)}`;
    } else {
      // Deduplicate if first message is already in lastFive
      const recent = lastFive.filter((e) => e.id !== firstUserMsg.id);
      context =
        `First message: ${firstUserMsg.content.slice(0, CAP)}\n\nRecent messages:\n` +
        recent.map((e) => `User: ${e.content.slice(0, CAP)}`).join("\n");
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
        managed.info.agentType === "claude"
          ? "sonnet"
          : managed.info.modelFamily;
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
        // Persist topic + the textCount at which it was generated, so that on
        // resume/restart we can compute drift against the replayed history and
        // decide whether to auto-refresh.
        if (managed.sessionId) {
          persistSessionTopic(
            agentId,
            managed.sessionId,
            topic,
            textEntries.length,
          );
        }
      }
    } catch (err) {
      const text = errMessage(err);
      // Auth-error topic-gen failures are expected when the agent is in the
      // not-yet-signed-in state — the user already sees the auth card in
      // chat, so the server-side log is just noise. Suppress those
      // specifically; keep other failures visible for debugging.
      if (!detectAgentAuthError(managed, text)) {
        console.error(`Topic generation failed for ${agentId}:`, text);
      }
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
          // A live Codex cwd change is committing: the fresh thread bootstrapped.
          // The clear-branch below (new id !== old id) handles abandoning the old
          // thread's chat, so just retire the pending-reset marker here.
          pendingCodexCwdReset.delete(agentId);
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
          // Record the cwd this session was born in (source of truth for
          // per-session cwd). Idempotent: a fork already stamped its cwd via
          // persistSessionFork so this no-ops there; a plain fresh session
          // (spawn / new conversation) gets the agent's current mirror cwd here.
          ensureSessionCwd(agentId, sessionId, managed.info.cwd);
          // Record the engine config (agentType + model/effort/permission/
          // sandbox) this session is running under. Overwrite, not backfill:
          // every model/effort/permission/engine change funnels through a
          // session replace -> fresh system_init, so re-stamping the live
          // config here keeps the active session's stored config in lockstep,
          // which is what a later resume restores. (For a cross-engine resume
          // managed.info was already set to the session's engine before
          // createSession, so this writes the same values back — a no-op.)
          //
          // LOAD-BEARING: this is the ONLY thing that keeps a session's stored
          // engine/model in sync with the live agent. The invariant relies on
          // EVERY change to agentType/modelFamily/effort/permissionMode/
          // codexSandbox going through a session replace (which re-fires
          // system_init). A future code path that mutates those fields via a
          // bare officeState.updateAgent WITHOUT replacing the session would
          // silently desync the stored config and break resume fidelity — route
          // it through replaceSession, or re-stamp here.
          stampSessionEngineConfig(agentId, sessionId, {
            agentType: managed.info.agentType,
            modelFamily: managed.info.modelFamily,
            effort: managed.info.effort,
            permissionMode: managed.info.permissionMode,
            codexSandbox: managed.info.codexSandbox,
          });
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
        } else if (managed && pendingCodexCwdReset.has(agentId)) {
          // Empty-sessionId system_init while a live Codex cwd change was pending:
          // the fresh thread failed to bootstrap (see backends/codex/adapter.ts).
          // replaceSession already closed the old process and AgentInfo.cwd is
          // committed to the new cwd, but managed.sessionId / logCache still point
          // at the now-abandoned old thread. Drop them so the agent doesn't later
          // associate the old thread with the new cwd — the next message starts a
          // genuinely fresh conversation in the new dir. The old thread's
          // transcript remains on disk under its own id (resumable via /resume).
          pendingCodexCwdReset.delete(agentId);
          clearStaleAutoResumeState(agentId, managed);
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
          emitLoginInstructions(
            agentId,
            agentLoginInstructions(managedForAuth),
          );
        }
        break;
      }
      case "task_lifecycle":
        // Background-task breadcrumb (start / settle). metadata.taskEvent
        // lets the UI style settle outcomes; the label is pre-sanitized
        // one-line text from the backend adapter.
        addLogEntry(agentId, "system", ev.label, {
          taskEvent: { taskId: ev.taskId, phase: ev.phase },
        });
        break;
      case "permission_denied": {
        // Auto-mode / rule denial of a tool call, surfaced natively (the
        // denied tool_result still reaches the model). metadata
        // .permissionDenied lets the UI render a distinct denial card; the
        // content string keeps the entry readable for raw consumers. Fields
        // arrive pre-sanitized (one line) from the backend adapter.
        const reason = ev.decisionReason || ev.message;
        addLogEntry(
          agentId,
          "system",
          `Tool call denied: ${ev.toolName}${reason ? ` (${reason})` : ""}`,
          {
            permissionDenied: {
              toolUseId: ev.toolUseId,
              toolName: ev.toolName,
              message: ev.message,
              ...(ev.decisionReason
                ? { decisionReason: ev.decisionReason }
                : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          },
        );
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
            ...(ev.isError != null ? { isError: ev.isError } : {}),
          },
          ev.attachments,
        );
        break;
      }
      case "turn_completed": {
        // Backends report token totals per turn. We accumulate cumulative
        // totals into sessions.json (`usage`) and append a snapshot anchored
        // to the most recently written log entry. The snapshots let /isomux-usage's
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
            // Auth detection: trust the backend's `causedByAuth` flag when set
            // (Codex sets it after rewriting the error string to avoid double-
            // emission of the login card). Fall back to regex on the raw error
            // text for backends that don't set the flag.
            const isAuthError =
              ev.causedByAuth === true ||
              detectAgentAuthError(managed, errorText);
            // Only emit when the regex path caught it — if the backend already
            // coalesced (causedByAuth=true), the login card was emitted earlier
            // in the turn and re-emitting here would duplicate it.
            if (ev.causedByAuth !== true && isAuthError) {
              emitLoginInstructions(agentId, agentLoginInstructions(managed));
            }
            // Auth-failed turns: leave the agent in waiting_for_response so the
            // desk reads "user needs to sign in," not "agent crashed." Non-auth
            // failures still flip to "error" so genuine failures surface.
            updateState(
              agentId,
              isAuthError ? "waiting_for_response" : "error",
            );
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
          ev.summary
            ? `Context compacted: ${ev.summary}`
            : "Context compacted.",
        );
        break;
      case "file_view":
        addLogEntry(agentId, "file-view", ev.title, undefined, ev.attachments);
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
        const isAuthError = detectAgentAuthError(managed, ev.message);
        if (isAuthError) {
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
        // Auth errors aren't agent failures — the agent is fine, the user just
        // needs to sign in. waiting_for_response matches what
        // surfaceBackendNotConfigured already does (e.g. on the rare bundled-
        // codex-binary-doesn't-resolve case) and avoids the red-desk indicator
        // that would imply something crashed. Non-auth errors still flip to
        // error so the desk surfaces the real failure.
        updateState(agentId, isAuthError ? "waiting_for_response" : "error");
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
        lines.push(
          "Or type any other message to deny with that as the reason.",
        );
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
    // The promise rides on the record so waiters (flushQueue's in-flight-turn
    // handoff, tryHotAbort) can ATTACH to it instead of replacing the record
    // with a delegating wrapper — see the pendingTurn field comment in
    // internal-types.ts for why replacement is forbidden (lost-wakeup hole,
    // task da065287).
    managed.pendingTurn = { promise, resolve, reject };
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
      // CLEAN stream end while still bound (no throw, no swap, not aborting):
      // the backend's stream ended on its own — subprocess death the adapter
      // didn't surface as an error event. Two hazards if we just return:
      //   1. a still-owned pendingTurn never settles, permanently stranding
      //      every `await turn` waiter (sendMessage, a parked flushQueue —
      //      the task da065287 wedge class);
      //   2. managed.session keeps pointing at a corpse, so the next message
      //      sends into a dead session instead of waking a fresh one.
      // Settle any owned turn, release the pointer (dormant flip mirrors
      // closeAndDrainSession), and — ONLY in the no-owner/pre-send branch —
      // normalize the busy state back to waiting_for_response
      // (enqueueMessage treats thinking/tool_executing as busy and flushQueue
      // rejects non-idle states, so a stuck busy state with no owning caller
      // would strand queued messages forever). The mid-turn branch performs
      // NO state transition; see its comment. All guarded on still-bound +
      // still-alive so a replacement consumer or a killed agent is untouched.
      // No-op when adapters behave (they emit an error or a synthetic
      // turn_completed before ending the stream).
      if (
        agents.get(agentId) === managed &&
        managed.session === boundSession &&
        !managed.aborting
      ) {
        const turn = managed.pendingTurn;
        managed.pendingTurn = null;
        managed.session = null;
        managed.consumerPromise = null;
        managed.dormantReason = "stream-ended";
        // Any turn still in its PRE-SEND window (plugin retrieval; no
        // pendingTurn installed) must bail at its next checkpoint rather than
        // send into whatever session exists by then — same mechanism
        // closeAndDrainSession uses. Harmless when a post-send turn existed
        // (it is settled via the rejection below).
        managed.turnCancelToken++;
        for (const event of officeState.updateAgent(agentId, {
          dormant: true,
        }))
          emit(event);
        if (turn) {
          // Mid-turn death: settle the turn and let its OWNING caller's catch
          // (sendMessage / flushQueue) produce the normal loud error state.
          // Deliberately NO state transition here (review-pinned): a
          // synchronous flip to waiting_for_response would fire the queue
          // trigger and could start a replacement turn BEFORE the rejected
          // caller's continuation runs — which would then stamp state=error
          // over a live turn and interfere with its lifecycle. Queued items
          // stay durable and deliver after human recovery.
          try {
            turn.reject(
              new Error("Backend stream ended unexpectedly mid-turn."),
            );
          } catch {}
          addLogEntry(
            agentId,
            "error",
            "Backend stream ended unexpectedly mid-turn.",
          );
        } else {
          console.warn(
            `Agent ${agentId}: backend stream ended while idle; released the dead session (next message resumes).`,
          );
          if (
            managed.info.state === "thinking" ||
            managed.info.state === "tool_executing"
          ) {
            // No-owner window only (pre-send: busy state claimed, pendingTurn
            // not yet installed — no caller catch will ever reset the state):
            // normalize so the agent is reachable again. Fires the queue-flush
            // trigger when items are waiting, which wakes a fresh session via
            // the !session branch; the token bump above guarantees the dead
            // pre-send turn can't also send.
            updateState(agentId, "waiting_for_response");
          }
        }
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

      // A fresh Codex session installed for a cwd change can error before it ever
      // emits system_init (an out-of-band stream failure; the adapter normally
      // routes bootstrap failures through an empty-sessionId system_init, which the
      // handler reconciles). In that case neither system_init reconciliation path
      // runs, so honor the pending-reset marker here too: abandon the old thread's
      // id + logCache so the committed new cwd isn't left paired with the dead old
      // thread. No-op for the common error path (marker absent).
      if (pendingCodexCwdReset.has(agentId)) {
        pendingCodexCwdReset.delete(agentId);
        clearStaleAutoResumeState(agentId, managed);
      }

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
      const isAuthError = detectAgentAuthError(managed, errorText);
      if (isAuthError) {
        emitLoginInstructions(agentId, agentLoginInstructions(managed));
      }
      // Same rationale as the "error"-event path above: auth errors aren't
      // agent failures, surface them as waiting_for_response to match the
      // (rare) bundled-codex-binary-doesn't-resolve case in
      // surfaceBackendNotConfigured, and avoid an erroneous red-desk signal.
      updateState(agentId, isAuthError ? "waiting_for_response" : "error");
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
    // Stamp activity + clear dormant in lockstep with the session going live, so
    // a just-woken agent isn't immediately re-demoted and `info.dormant` can
    // never disagree with `session !== null`. Guarded so spawn / normal swaps
    // (already non-dormant) don't emit a redundant agent_updated.
    managed.lastActiveAt = Date.now();
    managed.dormantReason = null;
    if (managed.info.dormant) {
      for (const event of officeState.updateAgent(agentId, { dormant: false }))
        emit(event);
    }
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
  // Toggle an agent's privileged flag (task 98d63ef7). Authorization (a USER
  // with room access; NEVER an agent) is the agents.setPrivileged route's job —
  // this is the core mutation only. Persists the flag (onChange → persistAll),
  // re-mints the bearer token with the new capability set, and for a LIVE agent
  // session-swaps onto the new token (resuming the current session so context is
  // preserved — same machinery as /model; interrupts an in-flight turn). A lazy
  // agent (no live session) needs no swap: the re-minted token is already in the
  // store, so its next createSession picks it up via buildSessionEnv. Idempotent:
  // toggling to the current value is a no-op (no re-mint, no interruption).
  // Returns the updated AgentInfo, or null if the agent isn't live (killed/
  // unknown — the route guard already rejects those, this is defensive).
  async function setPrivileged(
    agentId: string,
    privileged: boolean,
  ): Promise<AgentInfo | null> {
    const managed = agents.get(agentId);
    if (!managed) return null;
    if ((managed.info.privileged ?? false) === privileged) return managed.info;
    for (const event of officeState.updateAgent(agentId, { privileged }))
      emit(event);
    // Re-mint REVOKES the old token, so a live agent MUST be swapped below or its
    // in-flight token dies mid-turn.
    mintAgentToken(agentId, managed.info.userId, privileged);
    if (managed.session !== null) {
      const sessionId = pickAutoResumeSessionId(managed);
      await replaceSession(
        agentId,
        managed,
        sessionId ? createSession(managed, sessionId) : createSession(managed),
      );
    }
    return managed.info;
  }

  // Upper bound on waiting for a closed session's consumer to drain. A
  // BackendSession whose stream() never returns after close() (wedged
  // subprocess / adapter bug) used to park closeAndDrainSession — and
  // everything stacked behind it (abort's finally, abortPromise, a flushQueue
  // parked on abortPromise) — FOREVER, wedging all message delivery for the
  // agent (task da065287). After this timeout we log loudly and proceed.
  // KNOWN RISK, accepted deliberately: proceeding without a full drain means
  // the wedged old subprocess may still hold the shared session .jsonl while
  // a --resume replacement starts writing it (the drain-before-install
  // rationale in the replaceSession header). A rare corrupted resume beats a
  // permanent office-visible wedge; runConsumer's bound-session guard already
  // discards any late in-memory events from the zombie stream. BackendSession
  // exposes no harder termination primitive than close() today — if adapters
  // grow a hard-kill, the timeout path below should call it before
  // proceeding. Test-overridable via _testSetConsumerDrainTimeout.
  const CONSUMER_DRAIN_TIMEOUT_MS = 15_000;
  let consumerDrainTimeoutMs = CONSUMER_DRAIN_TIMEOUT_MS;

  // Await a (possibly wedged) consumer with the bounded-drain policy above.
  // Returns true if the consumer drained, false on timeout. Never throws.
  async function drainConsumerBounded(
    agentId: string,
    consumer: Promise<void>,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        consumer.catch(() => {}),
        new Promise<void>((res) => {
          timer = setTimeout(() => {
            timedOut = true;
            res();
          }, consumerDrainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      console.error(
        `Agent ${agentId}: session consumer did not drain within ${consumerDrainTimeoutMs}ms; ` +
          `proceeding without a full drain (the old subprocess may still be alive — ` +
          `see the .jsonl overlap note at CONSUMER_DRAIN_TIMEOUT_MS).`,
      );
    }
    return !timedOut;
  }

  // Close the agent's live session and drain its consumer, leaving it dormant
  // (session === null, no subprocess). Shared by replaceSession (installs a
  // replacement right after) and demoteToLazy (doesn't). Bumps turnCancelToken
  // so any concurrent pre-send turn bails, rejects the in-flight turn, sets
  // info.dormant in lockstep with session, and awaits the old consumer (with
  // the bounded-drain policy above) so the dying subprocess never overlaps
  // whatever installs next. CALLERS MUST NOT
  // mutate session-related state after this resolves without re-checking — a
  // message arriving during the drain await may already have woken a fresh
  // session via flushQueue.
  async function closeAndDrainSession(agentId: string, managed: ManagedAgent) {
    managed.turnCancelToken++;
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
    managed.consumerPromise = null;
    for (const event of officeState.updateAgent(agentId, { dormant: true }))
      emit(event);
    if (oldConsumer) {
      await drainConsumerBounded(agentId, oldConsumer);
    }
  }

  async function replaceSession(
    agentId: string,
    managed: ManagedAgent,
    newSession: BackendSession,
  ) {
    // /clear, /resume, /model, /effort, edit-fork, abort's slow path,
    // setPrivileged, and the queue watchdog's forced recovery all funnel
    // through here. closeAndDrainSession bumps the
    // cancel token (covers concurrent pre-send turns, same as before) and flips
    // dormant=true; installSession flips it back. The transient dormant blip is
    // invisible (v1 renders no badge) and sessionSwapping already covers the UI
    // for the ~3s drain window.
    let installedByUs = false;
    for (const event of officeState.updateAgent(agentId, {
      sessionSwapping: true,
    }))
      emit(event);
    try {
      await closeAndDrainSession(agentId, managed);
      // Conditional install (task 314ee9fb): during the drain await the
      // session slot is null, and a concurrent installer can legitimately win
      // it — flushQueue's wake branch defers to us via its sessionSwapping
      // guard, but sendMessage's wakeSessionForSend does not. If someone won,
      // do NOT clobber their live session (the old behavior left their
      // in-flight turn sending into a foreign session); close our
      // never-installed replacement instead. Residual race for callers that
      // need THEIR specific session installed (/resume pick, edit-fork): the
      // concurrent wake now wins and the pick no-ops — rarer and safer than
      // cross-thread delivery; full swap/wake serialization is task 154e2c14.
      if (managed.session === null) {
        installSession(agentId, managed, newSession);
        installedByUs = true;
      } else {
        try {
          newSession.close();
        } catch {}
        console.warn(
          `Agent ${agentId}: a concurrent wake installed a session during the swap drain; keeping it and discarding the replacement.`,
        );
      }
    } finally {
      for (const event of officeState.updateAgent(agentId, {
        sessionSwapping: false,
      }))
        emit(event);
    }
    if (agents.get(agentId) !== managed) return; // killed during the drain
    // Post-swap dead-turn normalization (task 314ee9fb): only when WE
    // installed (atomic with the null-check above — no await between), any
    // pre-swap turn is provably dead (closeAndDrainSession rejected or
    // token-cancelled it) and no new turn can exist (a wake would have
    // installed a session, contradicting ownership), so a lingering busy
    // state is a lie. Out-of-band swaps (setPrivileged, /model, /effort)
    // used to strand the agent visibly "thinking" forever here.
    if (
      installedByUs &&
      !managed.pendingTurn &&
      (managed.info.state === "thinking" ||
        managed.info.state === "tool_executing")
    ) {
      updateState(agentId, "waiting_for_response");
    }
    // Post-swap flush kick (task 314ee9fb): a flush cancelled pre-send by this
    // swap left its items queued, and a wake that deferred to us (the
    // sessionSwapping guard) never happened — neither gets retried by a state
    // transition when the agent was already idle, so kick explicitly.
    // flushQueue re-checks state/queue/flow/flushInProgress itself.
    if (managed.messageQueue.length > 0) {
      flushQueue(agentId).catch((err: unknown) => {
        console.error(
          `flushQueue (post-swap) failed for ${agentId}:`,
          errMessage(err),
        );
      });
    }
  }

  // --- Idle eviction: demote idle agents to lazy to reclaim subprocess RAM ----
  // A live backend subprocess holds ~165MB resident even when idle. After
  // IDLE_EVICT_MS of inactivity an agent is demoted to lazy (subprocess closed,
  // session resumable on disk); the next message wakes it via flushQueue's
  // !session branch. lazy-restore at boot starts everyone dormant; this sweep
  // re-demotes agents that woke and then went quiet again.
  const IDLE_EVICT_MS = 2 * 60 * 60_000;
  let demoteCount = 0;

  // Wake-message wording, accurate to WHY the agent was dormant: a sweep-demoted
  // agent was released for idleness; a lazy-restored one was released by a
  // server (re)start. A genuine crash uses each wake path's own wording.
  function dormantWakeMessage(reason: ManagedAgent["dormantReason"]): string {
    if (reason === "boot")
      return "Resumed your session after the server restarted.";
    if (reason === "stream-ended")
      return "Resumed your session after the backend stream ended unexpectedly.";
    return "Resumed your session (it was released while idle to save memory).";
  }

  // Synchronous guard: only demote a fully-quiescent, resumable live agent.
  // Re-checked immediately before the close in demoteToLazy with no await
  // between, so a turn/message can't slip in. `pickAutoResumeSessionId !== null`
  // covers both "has a sessionId to resume" and the Codex durable-rollout
  // requirement (a non-durable Codex thread would wake into a fresh, context-
  // less session).
  function canDemote(managed: ManagedAgent): boolean {
    return (
      managed.session !== null &&
      isQueueIdleState(managed.info.state) &&
      !managed.pendingTurn &&
      !inMultiStepFlow(managed) &&
      !managed.abortPromise &&
      !managed.info.sessionSwapping &&
      !managed.flushInProgress &&
      managed.messageQueue.length === 0 &&
      pickAutoResumeSessionId(managed) !== null
    );
  }

  // Demote one agent to lazy. Returns true if it demoted. Safe against a message
  // arriving mid-drain: closeAndDrainSession nulls the session synchronously, a
  // concurrent wake (flushQueue) installs a fresh session during the drain
  // await, and this function touches nothing afterward so it can't clobber that
  // wake. The on-disk resume race the replaceSession header warns about doesn't
  // apply: canDemote requires a quiescent agent (idle, no in-flight turn), so
  // the closing subprocess isn't mid-write to the shared session .jsonl.
  async function demoteToLazy(agentId: string): Promise<boolean> {
    const managed = agents.get(agentId);
    if (!managed) return false;
    if (!canDemote(managed)) return false;
    managed.dormantReason = "idle";
    await closeAndDrainSession(agentId, managed);
    demoteCount++;
    console.log(
      `[idle-evict] demoted ${managed.info.name} (${agentId}) to lazy (total ${demoteCount})`,
    );
    return true;
  }

  // Periodic sweep: demote every live agent idle past `idleMs`. Snapshots the
  // map first (demoteToLazy awaits and the map can change between iterations).
  // Returns the count demoted.
  async function sweepIdleAgents(
    idleMs: number = IDLE_EVICT_MS,
  ): Promise<number> {
    const now = Date.now();
    let demoted = 0;
    for (const [agentId, managed] of [...agents.entries()]) {
      if (managed.session === null) continue;
      if (now - managed.lastActiveAt < idleMs) continue;
      if (!canDemote(managed)) continue;
      if (await demoteToLazy(agentId)) demoted++;
    }
    return demoted;
  }

  // --- Queue delivery watchdog (task da065287, layer 3) ----------------------
  // Self-heal sweep for the invariant "a queued message cannot sit
  // indefinitely while the agent is idle". Driven by a 30s interval in
  // index.ts's import.meta.main block (tests call it directly, like
  // sweepIdleAgents). It only ever acts on the stuck SIGNATURE — idle-state
  // agent, non-empty queue, no multi-step flow — which excludes every
  // legitimate wait: a running turn holds thinking/tool_executing (busy states
  // are deliberately never watchdogged: a long turn is indistinguishable from
  // a hung one), permission/pick flows are inMultiStepFlow, and normal
  // handoffs/aborts resolve well under the deadline.
  //
  // Two actions:
  //   - No flush in progress + oldest item older than stuckMs: a trigger was
  //     missed somewhere — just flushQueue() (idempotent, benign).
  //   - A flush in progress whose flushStartedAt is older than stuckMs: the
  //     flush is wedged on some await that never settled. Recovery reuses
  //     abort's slow-path machinery — a bounded session replacement — which
  //     settles the zombie through existing channels (turnCancelToken bump for
  //     pre-send, pendingTurn rejection for handoff/await-turn, session close
  //     for in-send) so the zombie's OWN catch/finally clears flushInProgress
  //     and re-fires the flush. flushInProgress is NEVER force-cleared here:
  //     that would allow two live flushes and a double-send (review-pinned).
  //     Residue: an adapter whose send() neither settles nor reacts to
  //     close() keeps the flag held — and later replacements cannot settle it
  //     either (its pendingTurn was already rejected on the first attempt) —
  //     so forced recovery is rate-limited per agent and escalates via logs
  //     rather than replacing sessions every sweep. That terminal behavior is
  //     deliberate and documented; the 60s guarantee does not cover an
  //     adapter that violates close/send teardown.
  const QUEUE_WATCHDOG_STUCK_MS = 60_000;
  const FORCED_RECOVERY_COOLDOWN_MS = 5 * 60_000;

  async function sweepStuckFlushes(
    stuckMs: number = QUEUE_WATCHDOG_STUCK_MS,
  ): Promise<number> {
    const now = Date.now();
    let acted = 0;
    for (const [agentId, managed] of [...agents.entries()]) {
      if (agents.get(agentId) !== managed) continue; // killed mid-sweep
      if (managed.messageQueue.length === 0) continue;
      if (!isQueueIdleState(managed.info.state)) continue;
      if (inMultiStepFlow(managed)) continue;
      // A swap owns its own retry via the post-swap kick.
      if (managed.info.sessionSwapping) continue;
      if (!managed.flushInProgress) {
        const oldest = managed.messageQueue[0]?.queuedAt ?? now;
        if (now - oldest < stuckMs) continue;
        console.warn(
          `[queue-watchdog] ${managed.info.name} (${agentId}): ${managed.messageQueue.length} message(s) queued while idle for ${now - oldest}ms with no flush in progress; re-triggering flush`,
        );
        flushQueue(agentId).catch((err: unknown) => {
          console.error(
            `flushQueue (watchdog) failed for ${agentId}:`,
            errMessage(err),
          );
        });
        acted++;
        continue;
      }
      if (now - managed.flushStartedAt < stuckMs) continue;
      if (now - managed.lastForcedRecoveryAt < FORCED_RECOVERY_COOLDOWN_MS)
        continue;
      managed.lastForcedRecoveryAt = now;
      console.error(
        `[queue-watchdog] ${managed.info.name} (${agentId}): flush stuck for ${now - managed.flushStartedAt}ms with ${managed.messageQueue.length} message(s) queued; forcing recovery via session replacement`,
      );
      addLogEntry(agentId, "system", "Message delivery stalled; recovering.");
      try {
        // Same resume-or-fresh dance as abort's slow path.
        const sessionId = pickAutoResumeSessionId(managed);
        if (managed.sessionId && !sessionId)
          clearStaleAutoResumeState(agentId, managed);
        await replaceSession(
          agentId,
          managed,
          sessionId
            ? createSession(managed, sessionId)
            : createSession(managed),
        );
        acted++;
      } catch (err) {
        console.error(
          `[queue-watchdog] forced recovery failed for ${agentId}:`,
          errMessage(err),
        );
      }
    }
    return acted;
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
    const base = buildEnvForUserId(managed.info.userId);
    const token = getAgentTokenRaw(managed.info.id);
    if (!token) return base;
    // Inject the agent's own bearer token (Phase 2.1) so its self-affordance /
    // inter-agent message curls authenticate as itself. In-memory secret, never
    // persisted/logged; spread process.env when there's no env-file base so the
    // subprocess keeps PATH/HOME/etc. Redaction tests assert it stays out of
    // prompts, logs, errors, diffs, and the WS.
    return { ...(base ?? process.env), ISOMUX_AGENT_TOKEN: token };
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

  // The office-env-file provider for env-loader is registered by the production
  // factory (createProductionAgentManager), NOT here, so DI tests that construct
  // their own AgentManager don't clobber that env-loader process-global. The
  // production factory registers it before CronjobManager's scheduler starts, so
  // buildEnvFor still resolves the office envFile by the first tick.

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
    // Phase 3c: a live agent's roomId always resolves to a real room; roomById
    // logs loud and we fail fast (vs silently building a prompt for room 0).
    const room = roomById(managed.info.roomId)!;
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
      managed.info.privileged ?? false,
      memoryStore.renderForPromptMulti([
        { scope: "office", scopeId: null, label: "Office-wide" },
        {
          scope: "room",
          scopeId: managed.info.roomId,
          label: `Room "${room.name}"`,
        },
        // Boss notes auto-load ONLY for this agent's manager boss (stable
        // userId), so one boss's notes never bleed into another's context.
        ...(managed.info.userId
          ? [
              {
                scope: "boss" as const,
                scopeId: managed.info.userId,
                label: `Boss "${managed.info.username ?? "boss"}"`,
              },
            ]
          : []),
        { scope: "agent", scopeId: managed.info.id, label: "Your agent" },
      ]),
      managed.info.agentType,
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

  async function spawn(
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
    // welcome-agent seed gets one Claude and one Codex desk on every fresh install.
    const resolvedCwd = resolveCwd(cwd);

    // Server-side validation. Anything outside the backend's allowlist falls
    // back to a safe default; the wire shapes are permissive (union types over
    // both backends), so a stale UI or hand-crafted client can't pin us to an
    // invalid mode/model/effort. NOTE: the REST spawn dep (index.ts) rejects a
    // mismatched modelFamily with 422 invalid_model_family BEFORE this runs —
    // the coercion here is a last-resort default for internal callers (welcome
    // seed, tests), not input laundering for the API surface.
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
      afterTurnPromise: null,
      turnCancelToken: 0,
      abortCancelToken: -1,
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
      flushStartedAt: 0,
      lastForcedRecoveryAt: 0,
      queueDedupe: new Map(),
      lastActiveAt: Date.now(),
      dormantReason: null,
    };
    agents.set(id, managed);
    // Mint the agent's bearer token before the first createSession (deferred to
    // the first message now) reads it via buildSessionEnv. Revoked in kill()
    // when the agent leaves the map.
    mintAgentToken(id, info.userId, info.privileged ?? false);

    // Lazy spawn: a brand-new agent holds NO subprocess until it's actually used.
    // Instead of eagerly installing a session (~165MB resident for a blank
    // conversation that may never be messaged), set the agent up dormant exactly
    // like boot lazy-restore: on its desk, idle, token minted, slash/skill
    // defaults seeded. The first message wakes it via flushQueue's !session
    // branch (createSession fresh — a new agent has no sessionId to resume),
    // worded silently because there's nothing to announce resuming.
    //
    // createSession's own cwd preflight is deferred to that first wake, so do a
    // cheap validateCwd here to still surface an obviously-bad cwd at spawn time.
    // On failure the agent lands in error state (not dormant — an errored agent
    // isn't a releasable blank), matching today's bad-cwd-at-spawn UX. The
    // dormant flag is set BEFORE the events emit below so the agent_added
    // broadcast already carries it (no transient not-dormant flicker); the same
    // `info` ref backs officeState's copy and the event, so they stay in sync.
    let cwdError: string | null = null;
    try {
      validateCwd(resolvedCwd);
      info.dormant = true;
      managed.dormantReason = "fresh";
    } catch (err) {
      cwdError = errMessage(err);
    }

    for (const event of events) emit(event);
    // Send commands immediately so autocomplete works before SDK init
    emit({
      type: "slash_commands",
      agentId: id,
      commands: managed.slashCommands,
      skills: managed.skills,
    });
    persistAll();

    if (cwdError) {
      console.error(`Failed to validate cwd for ${name}:`, cwdError);
      addLogEntry(id, "error", `Failed to start: ${cwdError}`);
      updateState(id, "error");
    } else {
      addLogEntry(
        id,
        "system",
        `Agent "${name}" ready. Working in ${resolvedCwd}. Permission mode: ${info.permissionMode}.`,
      );
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
    globalRoomIndexOf,
    roomById,
    getOfficeConfig: () => officeState.office,
    logCache,
    emit,
    addLogEntry,
    emitEphemeralLog,
    updateState,
    updateAgent: (agentId, changes) =>
      officeState.updateAgent(agentId, changes),
    beginTurn,
    emitLoginInstructionsFor: (agentId, managed) =>
      emitLoginInstructions(agentId, agentLoginInstructions(managed)),
    createSession,
    replaceSession,
    persistAll,
    persistCurrentSessionTopic,
    wakeDormantSession: (agentId, managed, rawText, username, device) =>
      wakeSessionForSend(agentId, managed, {
        // echoEarly:false — executeSkill echoes the user's command AFTER the
        // wake, so the helper must not echo on success (it only re-adds in the
        // rare clearedStale path, and echoes once on the error path before
        // executeSkill bails).
        echoEarly: false,
        text: rawText,
        username,
        device,
      }),
    createTurnDeferred,
    enqueueMessage,
  });

  // === Message queue ===
  //
  // Messages addressed to an agent that's currently busy (thinking / tool_executing)
  // land here instead of superseding the in-flight turn. On the next idle
  // transition they flush together as one coalesced SDK prompt, with each
  // message labelled by sender. Both human senders (via sendMessage) and agent
  // senders (via the unified /api/agents/:id/messages route) go through the same queue.
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
        throw new Error(
          `unhandled sender kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  function senderPrefixText(sender: QueuedMessage["sender"]): string {
    switch (sender.kind) {
      case "user":
        return formatPrefix({
          username: sender.username,
          device: sender.device,
        });
      case "agent":
        return `${formatAgentSenderPrefix(sender.agentId, sender.agentName, sender.roomName)} `;
      default: {
        const _exhaustive: never = sender;
        throw new Error(
          `unhandled sender kind: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  // Per-item flush prefix. Plain messages get the bare sender prefix; a
  // SCHEDULED message (scheduledFor set by scheduled-messages.ts at fire time)
  // is explicitly marked so the receiver doesn't read it as a live
  // conversational turn: a self-addressed one reads as coming from the agent's
  // own past self (no reply expected), and a gone sender is called out because
  // scheduled messages always deliver (Nil's decision, task 8ff369b5) — the
  // receiver decides what the sender's absence means.
  function queuedItemPrefix(m: QueuedMessage, receiverAgentId: string): string {
    if (m.scheduledFor === undefined || m.sender.kind !== "agent") {
      return senderPrefixText(m.sender);
    }
    const when = new Date(m.scheduledFor).toISOString();
    if (m.sender.agentId === receiverAgentId) {
      return `[Scheduled message from your own past self, scheduled for delivery at ${when}] `;
    }
    const gone = m.scheduledSenderGone
      ? " The sender agent no longer exists, so it will not see a reply."
      : "";
    return `${senderPrefixText(m.sender)}[This message was scheduled by the sender for delivery at ${when}.${gone}] `;
  }

  function emitQueueUpdate(agentId: string, managed: ManagedAgent) {
    emit({
      type: "agent_updated",
      agentId,
      changes: { queue: [...managed.messageQueue] },
    });
  }

  // --- Durable message queues (task 9870b472) --------------------------------
  // The live queue + dedupe window are mirrored to ~/.isomux/message-queues.json
  // and replayed at boot so a restart no longer drops queued messages.
  // Acceptance (enqueueMessage) persists TRANSACTIONALLY (throw → roll back →
  // 500 persist_failed, so the sender knows to retry); every post-accept
  // mutation persists best-effort via persistQueueState — the backend already
  // accepted (or the user explicitly cleared), so stale disk merely widens
  // at-least-once replay. emitQueueUpdate stays free of disk I/O on purpose;
  // each mutation site calls the persist helper explicitly.

  let queueStoreCache: Record<string, unknown> | null = null;
  function queueStore(): Record<string, unknown> {
    if (!queueStoreCache) queueStoreCache = loadMessageQueuesRaw();
    return queueStoreCache;
  }

  // Narrow an unknown loaded item to a QueuedMessage. Strict on the fields the
  // flush path reads (id/text/queuedAt/sender shape); parity-loose on optional
  // extras (sdkText/attachments/scheduledFor), matching the boundary style of
  // malformedSendFields.
  function isValidQueuedMessage(v: unknown): v is QueuedMessage {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.text !== "string" ||
      typeof r.queuedAt !== "number"
    )
      return false;
    const s = r.sender as Record<string, unknown> | null | undefined;
    if (typeof s !== "object" || s === null) return false;
    if (s.kind === "user") return true;
    if (s.kind === "agent")
      return (
        typeof s.agentId === "string" &&
        typeof s.agentName === "string" &&
        typeof s.roomName === "string"
      );
    return false;
  }

  // Snapshot the agent's durable record, or null when there is nothing worth
  // keeping (empty queue, no unexpired dedupe keys).
  function buildQueueRecord(
    managed: ManagedAgent,
  ): { queue: QueuedMessage[]; dedupe: Record<string, number> } | null {
    const now = Date.now();
    const dedupe: Record<string, number> = {};
    for (const [k, v] of managed.queueDedupe) if (v > now) dedupe[k] = v;
    if (managed.messageQueue.length === 0 && Object.keys(dedupe).length === 0)
      return null;
    return { queue: [...managed.messageQueue], dedupe };
  }

  // THROWS — the transactional acceptance path in enqueueMessage.
  // COPY-ON-SUCCESS (review-pinned): mutate a copy, write it, and only commit
  // the copy to the cache after the write succeeds. Mutating the live cache
  // before a failed save would leave a phantom record that the NEXT successful
  // save (for any agent) silently resurrects — a message whose sender was told
  // 500 would come back from the dead on the following restart. The cache must
  // always mirror the last successfully-persisted disk state.
  function persistQueueStateThrow(agentId: string, managed: ManagedAgent) {
    const next = { ...queueStore() };
    const rec = buildQueueRecord(managed);
    if (rec === null) delete next[agentId];
    else next[agentId] = rec;
    saveMessageQueues(next);
    queueStoreCache = next;
  }

  // Best-effort — every post-accept mutation site.
  function persistQueueState(agentId: string, managed: ManagedAgent) {
    try {
      persistQueueStateThrow(agentId, managed);
    } catch (err) {
      console.error(
        `Failed to persist message queue for ${agentId} (durability degraded; live delivery unaffected):`,
        errMessage(err),
      );
    }
  }

  // Best-effort removal — kill(). Copy-on-success, same rationale as above.
  function removeQueueRecord(agentId: string) {
    try {
      if (!(agentId in queueStore())) return;
      const next = { ...queueStore() };
      delete next[agentId];
      saveMessageQueues(next);
      queueStoreCache = next;
    } catch (err) {
      console.error(
        `Failed to remove persisted message queue for ${agentId}:`,
        errMessage(err),
      );
    }
  }

  // Boot-replay read: validate one persisted record. Invalid items are dropped
  // with a log line; expired dedupe keys are dropped silently.
  function readPersistedQueueRecord(
    agentId: string,
  ): { queue: QueuedMessage[]; dedupe: Map<string, number> } | null {
    const raw = queueStore()[agentId];
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const queue: QueuedMessage[] = [];
    if (Array.isArray(r.queue)) {
      for (const item of r.queue) {
        if (isValidQueuedMessage(item)) queue.push(item);
        else
          console.error(
            `Dropping invalid persisted queued message for ${agentId}:`,
            JSON.stringify(item)?.slice(0, 200),
          );
      }
    }
    const dedupe = new Map<string, number>();
    const now = Date.now();
    if (
      typeof r.dedupe === "object" &&
      r.dedupe !== null &&
      !Array.isArray(r.dedupe)
    ) {
      for (const [k, v] of Object.entries(
        r.dedupe as Record<string, unknown>,
      )) {
        if (typeof v === "number" && Number.isFinite(v) && v > now)
          dedupe.set(k, v);
      }
    }
    if (queue.length === 0 && dedupe.size === 0) return null;
    return { queue, dedupe };
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
  function enqueueMessage(
    agentId: string,
    msg: {
      sender: QueuedMessage["sender"];
      text: string;
      sdkText?: string;
      attachments?: Attachment[];
      clientMessageId?: string;
      // Set by the scheduled-message scheduler at fire time (see
      // scheduled-messages.ts). Copied onto the queued item below — dropping
      // the copy would silently lose the scheduled marker in the flush prefix.
      scheduledFor?: number;
      scheduledSenderGone?: boolean;
    },
  ): EnqueueResult {
    const managed = agents.get(agentId);
    if (!managed) return { ok: false, error: "agent not found", status: 404 };
    // Inbound traffic counts as activity so a dormant agent that just woke (or a
    // busy one mid-conversation) isn't demoted out from under the next message.
    managed.lastActiveAt = Date.now();

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
      ...(msg.scheduledFor !== undefined
        ? { scheduledFor: msg.scheduledFor }
        : {}),
      ...(msg.scheduledSenderGone ? { scheduledSenderGone: true } : {}),
      attachments: msg.attachments,
      queuedAt: Date.now(),
    });
    // Transactional acceptance (task 9870b472): item + dedupe key land in
    // memory, then ONE combined durable write. On failure both are rolled back
    // and the request fails — acking a message the disk never saw would be
    // silent loss on restart, hiding the retry signal from the sender.
    // (recordDedupe's lazy pruning of OTHER expired keys needn't roll back;
    // only the submitted key must.) Emit/flush happen only after the persist.
    if (msg.clientMessageId) recordDedupe(managed, msg.clientMessageId);
    try {
      persistQueueStateThrow(agentId, managed);
    } catch (err) {
      managed.messageQueue.pop();
      if (msg.clientMessageId) managed.queueDedupe.delete(msg.clientMessageId);
      console.error(
        `Failed to persist queued message for ${agentId}; rejecting the send:`,
        errMessage(err),
      );
      return { ok: false, error: "persist_failed", status: 500 };
    }
    emitQueueUpdate(agentId, managed);

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
    managed.flushStartedAt = Date.now();
    try {
      // Wait for any in-flight turn to truly end before starting a new one. The
      // trigger from updateState fires synchronously inside processMessage,
      // before runConsumer's post-loop code can clear the about-to-resolve
      // pendingTurn — without this wait, createTurnDeferred below would reject
      // that turn and surface a bogus "Superseded" error to the original caller.
      // ATTACH to the deferred's promise (snapshot once — the slot may be
      // nulled by the settle path while we're parked); never replace the
      // record with a wrapper. A wrapper could be orphaned by any settle that
      // bypasses managed.pendingTurn (e.g. runAgentTurn's send-throw cleanup,
      // which rejects only the record it installed), permanently stranding
      // flushInProgress — the task da065287 lost-wakeup bug.
      {
        const pending = managed.pendingTurn;
        if (pending) await pending.promise.catch(() => {});
      }
      // Re-check post-wait — state and queue can change while we waited. The
      // agents.has() guard catches a kill() during the wait: kill settles the
      // pendingTurn deferred (waking us) and removes the agent from the map but
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
        // A session swap is mid-drain (replaceSession's closeAndDrainSession
        // nulls the session before awaiting the old consumer). Don't race it
        // by installing a wake session the swap would then have to yield to —
        // bail and let replaceSession's post-swap flush kick re-fire us
        // against the properly installed session (task 314ee9fb).
        if (managed.info.sessionSwapping) return;
        try {
          // Capture before installSession clears them: a clean wake (idle
          // eviction or restart) gets an accurate calm message; only a genuine
          // unexpected death gets the alarming one.
          const wasDormant = managed.info.dormant ?? false;
          const dormantReason = managed.dormantReason;
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
            addLogEntry(
              agentId,
              "system",
              "Previous response was interrupted.",
            );
          }
          // A blank-conversation wake (lazy spawn / released by /clear) is
          // SILENT: there's no prior thread to announce resuming, and under the
          // old eager paths the first message hit an already-live session and
          // logged nothing — so a "Started a fresh session…" note here would be
          // a NEW regression. Every other wake keeps its existing wording.
          if (sessionId) {
            addLogEntry(
              agentId,
              "system",
              wasDormant
                ? dormantWakeMessage(dormantReason)
                : "Resumed prior session before flushing queued messages.",
            );
          } else if (!(wasDormant && dormantReason === "fresh")) {
            addLogEntry(
              agentId,
              "system",
              "Started a fresh session before flushing queued messages.",
            );
          }
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
      // unprefixedParts mirrors promptParts but without the sender prefix per
      // item. Plugins receive the joined unprefixed version as `originalText`
      // so memory/audit see user intent without `[Nil (Phone)]` noise that
      // belongs to isomux's routing layer rather than the user's message.
      const unprefixedParts: string[] = [];
      const allAttachments: Attachment[] = [];
      // If any items were queued while the agent was busy, prepend a single
      // coalesced note so the agent doesn't read them as reactions to its most
      // recent reply (the sender hadn't seen that reply when sending them).
      const busyCount = items.reduce(
        (n, m) => (m.queuedDuringBusyTurn ? n + 1 : n),
        0,
      );
      if (busyCount > 0) {
        const note =
          busyCount === 1
            ? `[Note: this message was queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent it.]`
            : `[Note: these messages were queued while you were processing your previous turn — the sender had not seen your most recent reply when they sent them.]`;
        promptParts.push(note);
        unprefixedParts.push(note);
      }
      for (const m of items) {
        // sdkText is set for pre-expanded slash commands (e.g. an /subagent-review
        // queued while the agent was mid-turn): chat shows m.text "/subagent-review",
        // but the SDK needs the full skill prompt.
        const body = m.sdkText ?? m.text;
        promptParts.push(`${queuedItemPrefix(m, agentId)}${body}`);
        unprefixedParts.push(body);
        if (m.attachments) allAttachments.push(...m.attachments);
      }
      const prompt = promptParts.join("\n\n");
      const originalText = unprefixedParts.join("\n\n");

      try {
        await runAgentTurn({
          managed,
          // No single "user-typed" string for a coalesced flush; the prompt
          // composition is the closest approximation, and plugins generally
          // use originalText (sender prefixes stripped) anyway.
          visibleText: prompt,
          originalText,
          sdkText: prompt,
          attachments: allAttachments.length > 0 ? allAttachments : undefined,
          origin: "queued",
          humanInput: items.some((m) => m.sender.kind === "user"),
          onSendAccepted: () => {
            // Send accepted by the backend. Finalize: write per-message log
            // entries (provenance) and remove the items from the live queue.
            // Items cancelled mid-send are still in `items` (they did reach
            // the SDK) — log them so chat history matches what the receiver
            // actually saw. Runs synchronously inside runAgentTurn between
            // session.send resolving and the newLogEntries snapshot, so
            // these user_messages stay OUT of the afterTurn slice (they
            // belong to "the prompt", not "the agent's response").
            for (const m of items) {
              // Carry sdkText into the log metadata so editMessage can match
              // this entry against the SDK session (the SDK saw the expanded
              // prompt, not m.text). Same shape executeSkill uses on the
              // immediate path.
              let meta = senderMeta(m.sender);
              if (m.sdkText) meta = { ...(meta ?? {}), sdkText: m.sdkText };
              // Scheduled-delivery provenance (see scheduled-messages.ts):
              // mirrors the flush-prefix marker into the persisted log entry.
              if (m.scheduledFor !== undefined) {
                meta = {
                  ...(meta ?? {}),
                  scheduled_for: m.scheduledFor,
                  ...(m.scheduledSenderGone
                    ? { scheduled_sender_gone: true }
                    : {}),
                };
              }
              addLogEntry(agentId, "user_message", m.text, meta, m.attachments);
            }
            // Trigger topic generation only after the user_message log entries
            // land in logCache. generateTopic reads the first user message
            // synchronously before its first await — running it earlier (e.g.
            // before the send) on a fresh conversation finds an empty cache
            // and bails out, leaving topic null. Matches the sendMessage path
            // which also logs before triggering.
            if (
              (managed.info.topic === null ||
                shouldAutoRegenerateTopic(managed)) &&
              !managed.topicGenerating
            ) {
              void generateTopic(agentId);
            }
            const sentIds = new Set(items.map((m) => m.id));
            managed.messageQueue = managed.messageQueue.filter(
              (m) => !sentIds.has(m.id),
            );
            emitQueueUpdate(agentId, managed);
            // Best-effort durable-removal (task 9870b472). A crash between the
            // backend accepting the send and this write replays the items on
            // next boot — at-least-once, mirroring scheduled-messages'
            // enqueue-then-persist-removal decision.
            persistQueueState(agentId, managed);
          },
        });
      } catch (err) {
        // runAgentTurn re-throws whatever the underlying turn threw and has
        // already cleaned up the pendingTurn deferred if session.send fell
        // before await turn. Per-site error semantics remain here.
        //
        // Agent killed mid-flush: nothing to log on a deleted agent, and any
        // log entry would leak into logCache for an id that no longer exists.
        if (!agents.has(agentId)) return;
        if (err instanceof SessionSwappedError) {
          // Items still in queue (we didn't drain on the failed attempt). The
          // post-swap state transition (or this function's own finally block)
          // will re-trigger flushQueue. Surface a system message only if the
          // queue still has items — when the swap path explicitly cleared the
          // queue (newConversation/resume/editMessage) there's nothing to
          // retry and the message would be misleading noise.
          //
          // Also stay quiet when the cancellation was user-initiated (Stop /
          // Send-now): abort() already logged "Agent interrupted." and the
          // retry is automatic, so "will retry" is redundant noise there.
          // Two signals, covering the two windows a flush turn can be
          // cancelled in:
          //   - pre-send (parked in plugin retrieval, pendingTurn not yet
          //     installed): abort() early-returns without setting `aborting`,
          //     but its token stamp makes abortCancelToken === turnCancelToken.
          //   - post-send (abort's slow path replaces the session):
          //     closeAndDrainSession bumps the token PAST the stamp, but the
          //     rejection lands while `aborting` is still true.
          // Unexpected swaps (idle demotion, out-of-band replaceSession)
          // match neither and still surface the message.
          const userInitiated =
            managed.aborting ||
            managed.turnCancelToken === managed.abortCancelToken;
          if (managed.messageQueue.length > 0 && !userInitiated) {
            addLogEntry(
              agentId,
              "system",
              "Queue flush interrupted by session change; will retry.",
            );
          }
          return;
        }
        if (err instanceof BackendNotConfiguredError) {
          // Backend can't run at all (CLI missing, auth missing, etc.).
          // surfaceBackendNotConfigured emits the hint+card, drains the queue
          // (so messageQueue.length goes to zero — which prevents the
          // updateState transition below from re-firing flushQueue and
          // double-emitting the hint), and transitions state to
          // waiting_for_response.
          surfaceBackendNotConfigured(agentId, managed, err);
          return;
        }
        console.error(`Agent ${agentId} flush error:`, errMessage(err));
        addLogEntry(
          agentId,
          "error",
          `Error flushing queue: ${errMessage(err)}`,
        );
        updateState(agentId, "error");
      }
    } finally {
      if (agents.has(agentId)) {
        managed.flushInProgress = false;
        // Re-flush if more arrived during the await, and we're still in an idle
        // state. After a BackendNotConfiguredError catch the queue is empty,
        // so this naturally no-ops on that path. The sessionSwapping exclusion
        // mirrors the early-return in the wake branch above — without it, a
        // flush bailing on a mid-drain swap would re-fire itself from here in
        // a tight async loop for the whole drain window; the post-swap kick in
        // replaceSession owns the retry instead.
        if (
          managed.messageQueue.length > 0 &&
          isQueueIdleState(managed.info.state) &&
          !inMultiStepFlow(managed) &&
          !managed.info.sessionSwapping
        ) {
          flushQueue(agentId).catch(() => {});
        }
      }
    }
  }

  function cancelQueued(agentId: string, messageId: string): boolean {
    const managed = agents.get(agentId);
    if (!managed) return false;
    const idx = managed.messageQueue.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    managed.messageQueue.splice(idx, 1);
    emitQueueUpdate(agentId, managed);
    persistQueueState(agentId, managed);
    return true;
  }

  // Steering action: stop whatever the agent is doing and flush the queue.
  // Mapped to the UI "Send now" button. No-op when the queue is empty so users
  // who hit it accidentally don't kill an in-flight turn for no reason.
  async function sendNow(agentId: string): Promise<void> {
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

  // Wake a session-less agent so a pending send has somewhere to go. Shared by
  // two call sites in sendMessage: the normal-message path (any session-less
  // agent) and the skill path (dormant agents only — see the call sites for why
  // the gating differs). Returns true if a session is ready to send on; false
  // if starting one failed (an error was already logged and state set to
  // "error"), in which case the caller must return.
  function wakeSessionForSend(
    agentId: string,
    managed: ManagedAgent,
    opts: {
      echoEarly: boolean;
      text: string;
      username?: string;
      device?: string;
      attachments?: Attachment[];
    },
  ): boolean {
    const { echoEarly, text, username, device, attachments } = opts;
    // Try to create a fresh session so the user's next message doesn't silently
    // vanish. pickAutoResumeSessionId returns managed.sessionId when it's safely
    // resumable — the previous session is genuinely dead, but the on-disk
    // transcript is intact and worth restoring. For non-durable Codex threads,
    // it returns null so we fresh-start cleanly instead of crashing on
    // thread/resume.
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
      // Capture before installSession clears them: a clean wake (idle eviction
      // or restart) gets an accurate calm message; only a genuine unexpected
      // death gets the alarming one.
      const wasDormant = managed.info.dormant ?? false;
      const dormantReason = managed.dormantReason;
      installSession(
        agentId,
        managed,
        sessionId ? createSession(managed, sessionId) : createSession(managed),
      );
      // A blank-conversation wake (lazy spawn / released by /clear) is SILENT
      // — nothing to announce, and the old eager paths logged nothing on the
      // first message to a fresh agent. Every other recovery keeps its
      // existing wording (the "ended unexpectedly" alarm only for a genuine
      // unexpected death of a non-dormant session).
      //
      // Cosmetic edge: pickAutoResumeSessionId gates on durability, but a Codex
      // rollout lost in the TOCTOU window between that check and createSession
      // here would fresh-start while we still logged the calm "resumed" wording
      // — wrong message, right outcome. The canDemote durability gate makes this
      // window vanishingly rare, so we accept the cosmetic mismatch rather than
      // re-probe durability under the wake.
      if (sessionId) {
        addLogEntry(
          agentId,
          "system",
          wasDormant
            ? dormantWakeMessage(dormantReason)
            : "Resumed prior session after the previous one ended unexpectedly.",
        );
      } else if (!(wasDormant && dormantReason === "fresh")) {
        addLogEntry(
          agentId,
          "system",
          "Started a fresh session (previous one could not be restored).",
        );
      }
      // State contract (review-pinned): a busy state here belongs to the
      // CALLER — sendMessage's early-echo beginTurn claims "thinking" for the
      // very message this wake serves, before any await. Flipping it to
      // waiting_for_response would (a) flicker the UI and (b) — now that
      // queues are durable — synchronously fire the queue-flush trigger and
      // race a flush into the caller's pre-send window, superseding the
      // caller's own deferred (observed as a bogus "Superseded by a new
      // turn." flush error during error-state recovery with a surviving
      // queue). Preserve the claimed state; the caller's turn completion
      // produces the idle transition that flushes any queued items. Non-busy
      // states still normalize so the agent leaves "error"/dormant idle
      // before the send — that covers the executeSkill wakeDormantSession
      // caller too, which is never busy here (it enqueues instead of waking
      // when busy, and canDemote guarantees a demoted agent's queue was
      // empty).
      if (
        managed.info.state !== "thinking" &&
        managed.info.state !== "tool_executing"
      ) {
        updateState(agentId, "waiting_for_response");
      }
      return true;
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
      return false;
    }
  }

  async function sendMessage(
    agentId: string,
    text: string,
    username?: string,
    device?: string,
    attachments?: Attachment[],
    opts?: { sendNow?: boolean },
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
      } else if (opts?.sendNow) {
        // Ctrl/Cmd+Enter "deliver now": the message just landed in the queue,
        // so trigger the same abort+flush the /send-now endpoint runs. The
        // flag is read ONLY inside this branch, so its guards (busy, no
        // multi-step flow, not a slash command) apply for free — everywhere
        // else a sendNow message takes the plain path. Fire-and-forget like
        // the endpoint's own wiring (sendNow handles its own state).
        void sendNow(agentId);
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
      if (
        (managed.info.topic === null || shouldAutoRegenerateTopic(managed)) &&
        !managed.topicGenerating
      ) {
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
      // Fall through on success so the message is actually sent on the new
      // session; bail on failure (an error was logged inside the helper).
      if (
        !wakeSessionForSend(agentId, managed, {
          echoEarly,
          text,
          username,
          device,
          attachments,
        })
      )
        return;
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
      let decision: ApprovalDecision;
      let resumeState: AgentState;
      if (trimmed === "1") {
        emitEphemeralLog(
          agentId,
          "system",
          "Permission granted (rule added for this session).",
        );
        decision = { kind: "allow_persistent" };
        resumeState = "tool_executing";
      } else if (trimmed === "2") {
        emitEphemeralLog(agentId, "system", "Permission granted (once).");
        decision = { kind: "allow_once" };
        resumeState = "tool_executing";
      } else if (trimmed === "3") {
        emitEphemeralLog(agentId, "system", "Permission denied.");
        decision = { kind: "deny" };
        resumeState = "thinking";
      } else {
        emitEphemeralLog(
          agentId,
          "system",
          "Permission denied with reason forwarded to agent.",
        );
        decision = { kind: "deny", reason: text };
        resumeState = "thinking";
      }
      // The reply hands the turn back to the agent, so flip out of the
      // `waiting_for_response` state the prompt parked us in (set ~:1952) and
      // back to a busy state. Without this the activity indicator stays blank —
      // `waiting_for_response` has no STATE_LABELS entry — so the agent looks
      // frozen while the backend resumes (`tool_result` is deliberately
      // state-neutral, so the blank window otherwise lasts until the model's
      // next thinking/text/tool_call event). Allow → tool_executing (the blocked
      // tool is about to run); deny → thinking (the model resumes to handle it).
      //
      // This MUST precede `await session.approve()`: Codex's approve() awaits its
      // bootstrap promise, and while that's pending `pendingPermission` has
      // already been cleared. If we were still at `waiting_for_response` (a
      // queue-idle state) an inbound message could race into the active turn and
      // skip the queue.
      updateState(agentId, resumeState);
      try {
        await session.approve(pending.approvalId, decision);
      } catch (err) {
        emitEphemeralLog(
          agentId,
          "error",
          `Failed to resolve permission: ${errMessage(err)}`,
        );
        updateState(agentId, "error");
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
          persistQueueState(agentId, managed);
        }
        // Persist current session topic before switching
        persistCurrentSessionTopic(agentId, managed);
        // Perform the resume
        try {
          // cwd is a property of the session: restore the picked session's cwd
          // before spawning (transactional — rolled back if the resume fails).
          const { prevCwd, switched, storedCwdInvalid } =
            applySessionCwdForResume(agentId, managed, picked.sessionId);
          // Restore the picked session's engine before spawning so a cross-engine
          // pick uses the right backend (rolled back if the resume fails).
          const engine = applySessionEngineForResume(
            agentId,
            managed,
            picked.sessionId,
          );
          try {
            const newSession = createSession(managed, picked.sessionId);
            await replaceSession(agentId, managed, newSession);
          } catch (err) {
            if (switched) rollbackSessionCwd(agentId, prevCwd);
            if (engine.switched && engine.prevConfig)
              rollbackSessionEngine(agentId, engine.prevConfig);
            throw err;
          }
          managed.sessionId = picked.sessionId;
          // Record the cwd we resumed in: backfill legacy/missing, or repair a
          // present-but-invalid value so it isn't sticky on future resumes.
          recordResumedSessionCwd(
            agentId,
            picked.sessionId,
            managed.info.cwd,
            storedCwdInvalid,
          );
          managed.topicGenerating = false;
          // Restore the textCount baseline from sessions.json so drift is
          // measured against the replayed history, not from zero (otherwise
          // any first new message after resume trivially trips the threshold).
          managed.topicMessageCount = picked.topicMessageCount;
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
          const replayedTextCount = history.filter(
            (e) => e.kind === "user_message" || e.kind === "text",
          ).length;
          const drift = replayedTextCount - picked.topicMessageCount;
          // Restore topic — officeState.updateAgent fires persistAll via onChange,
          // capturing the new sessionId set above. topicStale reflects whether
          // the replayed history has moved past the topic's generation point.
          for (const event of officeState.updateAgent(agentId, {
            topic: picked.topic,
            topicStale: drift > 0,
          }))
            emit(event);
          emitEphemeralLog(
            agentId,
            "system",
            `Resumed session: ${picked.topic || picked.sessionId.slice(0, 8) + "..."}`,
          );
          updateState(agentId, "waiting_for_response");
          // Regenerate immediately if there's no topic at all, or if the
          // resumed conversation has drifted enough since the topic was last
          // generated. Waiting for the next user_message would let one stale
          // message through; firing here keeps the resumed agent's topic
          // honest from the moment the user sees it.
          if (!picked.topic || drift >= TOPIC_REGEN_THRESHOLD) {
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
      // Same backend/model-filtered list the /effort handler rendered
      // (command-handlers.ts) — indices must line up. validateEffort below is
      // belt-and-braces against future drift between the two lists.
      const effortLevels = effortLevelsFor(
        managed.info.agentType,
        managed.info.modelFamily,
      );
      if (!isNaN(num) && num >= 1 && num <= effortLevels.length) {
        const userMeta = buildUserMeta(username, device);
        emitEphemeralLog(agentId, "user_message", text, userMeta);
        const picked = {
          level: validateEffort(
            managed.info.agentType,
            managed.info.modelFamily,
            effortLevels[num - 1].level,
          ),
        };
        const label = effortDisplayLabel(picked.level);
        if (picked.level === managed.info.effort) {
          emitEphemeralLog(agentId, "system", `Already using ${label}.`);
        } else {
          // Auto-resume policy outside the rollback — see model-switch above
          // for the rationale.
          const sessionId = pickAutoResumeSessionId(managed);
          if (managed.sessionId && !sessionId)
            clearStaleAutoResumeState(agentId, managed);
          await withAgentRollback(
            managed,
            { effort: picked.level },
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
            effort: picked.level,
          }))
            emit(event);
          addLogEntry(
            agentId,
            "system",
            `Thinking effort switched to ${label}.`,
          );
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

    // A slash command that wasn't intercepted above is a skill — it expands to
    // a prompt and runs the model (runAgentTurn -> session.send), so it needs a
    // live session. Control commands (/clear, /resume, ...) were handled and
    // returned above, so they never reach here; that's what preserves their
    // no-auto-wake escape hatch on a broken session. Wake a DORMANT agent here
    // (the normal lazy-restore path — skipped at the top because isSlash). A
    // genuinely-broken (non-dormant) session is left alone so runAgentTurn
    // surfaces the descriptive "no session, type /clear" error.
    if (!managed.session && managed.info.dormant) {
      if (
        !wakeSessionForSend(agentId, managed, {
          echoEarly,
          text,
          username,
          device,
          attachments,
        })
      )
        return;
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

      // First-message bootstrap (topic === null) OR drift-driven refresh after
      // resume/restart/long session (shouldAutoRegenerateTopic). The threshold
      // inside the helper keeps cost bounded to ~one regen per
      // TOPIC_REGEN_THRESHOLD new user/text entries.
      if (
        (managed.info.topic === null || shouldAutoRegenerateTopic(managed)) &&
        !managed.topicGenerating
      ) {
        void generateTopic(agentId); // fire-and-forget
      }
    }

    const prefix = formatPrefix({ username, device });
    const prefixedText = prefix ? `${prefix}${text}` : text;
    try {
      await runAgentTurn({
        managed,
        visibleText: text,
        // sendMessage's raw user text is `text`; the sender prefix is
        // applied above as `prefixedText` which becomes sdkText.
        originalText: text,
        sdkText: prefixedText,
        attachments,
        origin: "user",
        humanInput: true,
      });
    } catch (err) {
      // runAgentTurn re-throws whatever the underlying turn threw; it also
      // handles the deferred-cleanup invariant (rejecting managed.pendingTurn
      // if session.send threw before await turn ran). The per-call-site catch
      // remains responsible for the distinct error semantics each path needs.
      if (err instanceof SessionSwappedError) return;
      if (err instanceof BackendNotConfiguredError) {
        // Backend isn't usable (CLI missing, auth missing, etc.).
        // surfaceBackendNotConfigured emits the hint+card, drains any queued
        // sibling messages (preventing the cross-path updateState→flushQueue
        // duplicate emit), and transitions state to waiting_for_response.
        surfaceBackendNotConfigured(agentId, managed, err);
        return;
      }
      console.error(`Agent ${agentId} send error:`, errMessage(err));
      addLogEntry(agentId, "error", `Error: ${errMessage(err)}`);
      updateState(agentId, "error");
    }
  }

  function persistCurrentSessionTopic(agentId: string, managed: ManagedAgent) {
    if (
      managed.sessionId &&
      managed.info.topic &&
      managed.info.topic !== "..."
    ) {
      persistSessionTopic(
        agentId,
        managed.sessionId,
        managed.info.topic,
        managed.topicMessageCount,
      );
    }
  }

  // Upper bound on the hot-abort wait. If codex doesn't ack turn/interrupt and
  // emit turn_completed within this window, we abandon the in-place path and
  // fall through to replaceSession so Stop is never a permanent no-op. Sized to
  // be larger than typical RPC latency by a wide margin but small enough to be
  // noticed as "something's wrong" if it ever fires.
  const HOT_ABORT_TIMEOUT_MS = 7000;

  async function abort(agentId: string) {
    const managed = agents.get(agentId);
    if (!managed) return;
    // Bump the cancel token unconditionally. Stop is always a cancellation
    // event from the runAgentTurn pre-send window's perspective — whether
    // the agent is mid-plugin-retrieval (no pendingTurn yet) or mid-real-
    // turn (pendingTurn installed), the token bump is the signal that
    // tells runAgentTurn to bail before session.send if it hasn't run yet.
    // For the post-send path the existing pendingTurn rejection (below) is
    // still the cancellation mechanism; the token bump is harmless there.
    managed.turnCancelToken++;
    // Stamp this bump as user-initiated so a flush turn it cancels stays
    // quiet (see the SessionSwappedError handler in flushQueue). Must be
    // stamped HERE, not with `aborting = true` below: in the pre-send
    // window pendingTurn is null and abort() returns early, so `aborting`
    // never covers exactly the case where the stamp matters most.
    managed.abortCancelToken = managed.turnCancelToken;
    // If no turn is in flight, the SDK stream may have died (e.g. subprocess
    // exited) OR runAgentTurn may be mid-plugin-retrieval. Either way reset
    // state so Stop is never a no-op.
    if (!managed.pendingTurn) {
      if (
        managed.info.state === "thinking" ||
        managed.info.state === "tool_executing"
      ) {
        updateState(agentId, "waiting_for_response");
        addLogEntry(agentId, "system", "Agent interrupted.");
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
      let needsReplace = !(
        managed.session && managed.session.canAbortInPlace()
      );

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
      // Attach to the in-flight turn's promise (snapshot once) so abortPromise
      // doesn't resolve before pendingTurn settles — otherwise a follow-up
      // createTurnDeferred would supersede the original turn with a
      // "Superseded" error. Mirrors flushQueue's in-flight-turn wait; never
      // replace the record with a wrapper (lost-wakeup hole, task da065287).
      const pending = managed.pendingTurn;
      if (!pending) return;
      await pending.promise.catch(() => {});
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

  async function kill(agentId: string) {
    const managed = agents.get(agentId);
    if (!managed) return;
    // Stamp the history entry with killedAt + final state BEFORE removing
    // the agent from the live map. After deletion, updateAgentHistory skips
    // this entry (loop is over live agents only), so this write is the
    // authoritative kill-time snapshot.
    const killedSummary = buildKilledAgentSummary(agentId, managed);
    {
      const room = roomById(managed.info.roomId);
      if (room) {
        const history = loadAgentHistory();
        history[agentId] = {
          name: managed.info.name,
          lastRoomId: room.id,
          lastRoomName: room.name,
          killedAt: Date.now(),
          cwd: managed.info.cwd,
          outfit: managed.info.outfit,
          permissionMode: managed.info.permissionMode,
          modelFamily: managed.info.modelFamily,
          effort: managed.info.effort,
          agentType: managed.info.agentType,
          codexSandbox: managed.info.codexSandbox,
          lastSessionId: managed.sessionId,
          topic: managed.info.topic,
          customInstructions: managed.info.customInstructions,
          userId: managed.info.userId,
          username: managed.info.username,
          // Snapshot privilege so a kill→revive round-trip restores it (this
          // kill-time entry is authoritative — updateAgentHistory skips killed
          // agents, and revive reads entry.privileged).
          privileged: managed.info.privileged ?? false,
        };
        saveAgentHistory(history);
      }
    }
    // Bump the cancel token so any concurrent runAgentTurn that hasn't yet
    // installed pendingTurn (pre-send plugin retrieval) bails on its next
    // await checkpoint instead of calling session.send on a dying session.
    managed.turnCancelToken++;
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
    // The agent left the live map; revoke its bearer token (mirrors the mint at
    // spawn/restore). A killed agent has no subprocess and no valid token.
    revokeAgentToken(agentId);
    officeState.kill(agentId);
    logCache.delete(agentId);
    // A killed agent's durable queue record must not replay into a future
    // revive (task 9870b472).
    removeQueueRecord(agentId);
    // Drop any pending live-Codex-cwd-change marker so a kill during the
    // sub-second replace window doesn't leave a dangling entry for a dead agent.
    pendingCodexCwdReset.delete(agentId);
    if (oldConsumer) {
      // Bounded like closeAndDrainSession: a wedged stream must not park the
      // kill() caller forever (same hazard class as task da065287).
      await drainConsumerBounded(agentId, oldConsumer);
    }
    killSidecar(managed);
    emit({ type: "agent_removed", agentId });
    if (killedSummary) {
      emit({ type: "killed_agent_added", agent: killedSummary });
    }
  }

  // Revive a previously-killed agent. Same id/outfit/config, rehydrated
  // from agent-history. Caller picks placement (target room + desk); the
  // original lastRoomId is used only as an ACL provenance check.
  //
  // Read-only validation runs first; on session failure we roll the
  // install back so the killed-agent chip stays available for retry.
  async function revive(
    agentId: string,
    roomId: string,
    desk: number,
  ): Promise<
    | { ok: true; agent: AgentInfo }
    | { ok: false; error: string; field?: "name" | "desk" | "room" }
  > {
    // 1. Must be currently killed (not in live map).
    if (agents.has(agentId)) {
      return { ok: false, error: "That agent is already alive." };
    }
    const history = loadAgentHistory();
    const entry = history[agentId];
    if (!entry) {
      return { ok: false, error: "Killed agent not found in history." };
    }
    // Legacy pre-revive entries have only name + lastRoom*. Missing fields
    // are defaulted below — agentType→claude, cwd→home, outfit→random — so
    // the boss can recover the on-disk transcript. The fresh-fallback path
    // in restoreOrReviveAgent kicks in when the SDK can't resume the legacy
    // session id (different project dir), and the log cache stays loaded
    // so the historical chat is visible against the fresh session.

    // 2. Original room must still exist (don't re-key a private-room
    // agent into an unrelated room).
    if (!officeState.rooms.some((r) => r.id === entry.lastRoomId)) {
      return { ok: false, error: "Agent's original room no longer exists." };
    }

    // 3. Target room must exist (ws handler ACL-gates the room id).
    const roomIdx = officeState.rooms.findIndex((r) => r.id === roomId);
    if (roomIdx < 0) {
      return { ok: false, error: "Target room not found.", field: "room" };
    }

    // 4. Desk free at command time (chip list may be stale across tabs).
    const taken = new Set(
      officeState
        .getAllAgents()
        .filter((a) => a.roomId === roomId)
        .map((a) => a.desk),
    );
    if (desk < 0 || desk >= 8 || taken.has(desk)) {
      return {
        ok: false,
        error: "That desk is no longer free.",
        field: "desk",
      };
    }

    // 5. Name collision against LIVE agents only (history keeps dead names).
    const nameLower = entry.name.trim().toLowerCase();
    const collision = officeState
      .getAllAgents()
      .some((a) => a.name.toLowerCase() === nameLower);
    if (collision) {
      return {
        ok: false,
        error: `Name "${entry.name}" is already taken.`,
        field: "name",
      };
    }

    // 6. Resolve cwd; fall back to home if the saved path is gone or
    // missing entirely (legacy entries).
    let resolvedCwd: string = entry.cwd ?? homedir();
    try {
      validateCwd(resolvedCwd);
    } catch {
      console.warn(
        `[revive] cwd "${resolvedCwd}" for ${entry.name} is invalid; falling back to ~`,
      );
      resolvedCwd = homedir();
    }

    // 7. Pick a resume session. Prefer the kill-time lastSessionId; for
    // legacy entries (no stamp), use the most recent .jsonl on disk so the
    // historical transcript can be surfaced. The fresh-fallback path in
    // restoreOrReviveAgent handles the case where the SDK can't actually
    // resume that session id.
    let resumeFromSession: string | null = entry.lastSessionId ?? null;
    if (!resumeFromSession) {
      const sessions = listAgentSessions(agentId);
      resumeFromSession = sessions[0]?.sessionId ?? null;
    }

    // cwd is a property of the session: if the resumed session recorded its own
    // cwd, prefer it over the killed-agent history snapshot (resolved above) so
    // the agent revives in the directory that session actually ran in. Keep the
    // snapshot fallback when the stored cwd is gone/invalid.
    if (resumeFromSession) {
      const sessionCwd = getSessionCwd(agentId, resumeFromSession);
      if (sessionCwd) {
        try {
          resolvedCwd = validateCwd(sessionCwd);
        } catch {
          // Stored session cwd unavailable — keep the step-6 fallback.
        }
      }
    }

    const persisted: PersistedAgent = {
      id: agentId,
      name: entry.name,
      desk,
      cwd: resolvedCwd,
      // Legacy entries default to a fresh random outfit + Claude. Validators
      // inside restoreOrReviveAgent canonicalize modelFamily/effort/etc.
      outfit: entry.outfit ?? generateOutfit(),
      permissionMode: entry.permissionMode ?? "auto",
      modelFamily: entry.modelFamily,
      effort: entry.effort,
      agentType: entry.agentType ?? "claude",
      codexSandbox: entry.codexSandbox,
      lastSessionId: resumeFromSession,
      topic: entry.topic ?? null,
      customInstructions: entry.customInstructions ?? null,
      userId: entry.userId,
      username: entry.username,
      privileged: entry.privileged ?? false,
    };

    const installResult = restoreOrReviveAgent({
      persisted,
      roomIdx,
      deskOverride: desk,
      emitAgentAdded: true,
      fallbackToFreshOnResumeFailure: true,
    });

    if (!installResult.sessionOk) {
      // Rollback. agent_added wasn't emitted (helper gates on sessionOk),
      // so the agent_removed below is an idempotent no-op on clients.
      // Manual rollback avoids re-stamping killedAt — the chip retains
      // its original kill-time order.
      agents.delete(agentId);
      // Revive failed and we're removing the just-installed agent; revoke the
      // token minted in restoreOrReviveAgent so a non-live agent has none.
      revokeAgentToken(agentId);
      for (const event of officeState.kill(agentId)) emit(event);
      logCache.delete(agentId);
      return {
        ok: false,
        error: `Failed to start session: ${installResult.sessionError ?? "unknown error"}`,
      };
    }

    const managed = agents.get(agentId);
    if (!managed) {
      return { ok: false, error: "Revive failed: agent did not install." };
    }

    // persistAll's live snapshot loop clears killedAt and updates lastRoom*
    // for us; no separate history write needed here.
    // lastRoomId on the removed event matches the add event's ACL filter.
    emit({
      type: "killed_agent_removed",
      agentId,
      lastRoomId: entry.lastRoomId,
    });
    persistAll();

    return { ok: true, agent: managed.info };
  }

  async function newConversation(
    agentId: string,
    targetAgentType?: AgentBackendType,
    // Engine-switch only: the new engine's model/effort/permission/sandbox to
    // apply. Each is validated against the target engine; undefined falls back
    // to that engine's default. Ignored when no engine change happens.
    engineOverrides?: {
      modelFamily?: string;
      effort?: EffortLevel;
      permissionMode?: AgentInfo["permissionMode"];
      codexSandbox?: AgentInfo["codexSandbox"];
    },
  ) {
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
      persistQueueState(agentId, managed);
    }
    persistCurrentSessionTopic(agentId, managed);

    // Switching engine always starts a fresh conversation. Cross-engine model/
    // effort/permission values aren't interchangeable (a Claude model slug is
    // meaningless to Codex and vice-versa), so reset to the target engine's
    // defaults rather than coercing the current values, and recompute
    // capabilities so UI affordances follow. The fresh session is stamped with
    // this config at its system_init.
    if (targetAgentType && targetAgentType !== managed.info.agentType) {
      // Validate any provided override against the TARGET engine (undefined ->
      // that engine's default). Never coerce a source-engine value: e.g.
      // validateModelFamily(codex, "opus") would pass "opus" straight through.
      const modelFamily = validateModelFamily(
        targetAgentType,
        engineOverrides?.modelFamily,
      );
      for (const event of officeState.updateAgent(agentId, {
        agentType: targetAgentType,
        modelFamily,
        effort: validateEffort(
          targetAgentType,
          modelFamily,
          engineOverrides?.effort,
        ),
        permissionMode: validatePermissionMode(
          targetAgentType,
          engineOverrides?.permissionMode,
        ),
        codexSandbox:
          targetAgentType === "codex"
            ? validateCodexSandbox(engineOverrides?.codexSandbox)
            : undefined,
        capabilities: getBackend(targetAgentType).capabilities,
      }))
        emit(event);
    }

    // Release-on-clear: a blank conversation holds NO subprocess. Instead of
    // creating a fresh LIVE session here (the old replaceSession path, ~165MB
    // for a conversation that may sit untouched), close the current session and
    // leave the agent dormant; the next message wakes a fresh blank one via
    // flushQueue's !session branch.
    //
    // ORDER IS LOAD-BEARING. Everything user-visible and every state reset
    // happens BEFORE the drain await, and NOTHING runs after it. A message that
    // arrives during closeAndDrainSession's drain wakes a fresh session
    // (flushQueue sees session===null) — so (1) sessionId must already be null
    // and the topic/log state already blanked, or that wake would resume the
    // just-cleared thread; and (2) no post-drain write may run, or it would
    // clobber the concurrent wake (e.g. stomp its waiting_for_response back to
    // idle). This inverts the old structure, which did updateState/addLogEntry
    // AFTER the session swap.
    managed.sessionId = null;
    managed.dormantReason = "fresh";
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
    // Last statement: close the live session and drain its consumer, leaving the
    // agent dormant (info.dormant=true). Rejects any in-flight turn with
    // SessionSwappedError; runConsumer's catch returns early on the stale
    // session so the rejected turn can't touch state after this resolves.
    await closeAndDrainSession(agentId, managed);
  }

  // Switch the agent's mirror cwd to a session's stored cwd ahead of a resume, so
  // the resumed conversation runs in the directory it left off in. cwd is a
  // property of the session; the agent's cwd field is just the mirror. Validates
  // the stored cwd first and returns the previous cwd, whether a switch happened
  // (so the caller can roll back if the session fails to start), and whether the
  // stored cwd was present-but-invalid (so the caller can REPAIR the bad metadata
  // after a successful fallback resume — otherwise the invalid value is sticky and
  // every future resume repeats the same fallback). Legacy sessions with no stored
  // cwd leave the mirror untouched and the caller backfills via ensureSessionCwd.
  function applySessionCwdForResume(
    agentId: string,
    managed: ManagedAgent,
    sessionId: string,
  ): { prevCwd: string; switched: boolean; storedCwdInvalid: boolean } {
    const prevCwd = managed.info.cwd;
    const storedCwd = getSessionCwd(agentId, sessionId);
    if (!storedCwd || storedCwd === prevCwd)
      return { prevCwd, switched: false, storedCwdInvalid: false };
    try {
      const resolvedStored = validateCwd(storedCwd);
      for (const event of officeState.updateAgent(agentId, {
        cwd: resolvedStored,
      }))
        emit(event);
      return { prevCwd, switched: true, storedCwdInvalid: false };
    } catch (err) {
      // Stored cwd is gone/invalid — resume in the current mirror cwd instead of
      // failing, and tell the user. createSession's own preflight still validates
      // cwd and (for Claude) the session file's presence.
      addLogEntry(
        agentId,
        "system",
        `Session's saved directory \`${storedCwd}\` is unavailable (${errMessage(err)}); resuming in \`${prevCwd}\`.`,
      );
      return { prevCwd, switched: false, storedCwdInvalid: true };
    }
  }

  // Record the cwd a session actually resumed in. Repairs a present-but-invalid
  // stored cwd (overwrite) so it isn't sticky; otherwise backfills a legacy/
  // missing value without clobbering or reordering an existing valid one.
  function recordResumedSessionCwd(
    agentId: string,
    sessionId: string,
    cwd: string,
    storedCwdInvalid: boolean,
  ) {
    if (storedCwdInvalid) {
      persistSessionCwd(agentId, sessionId, cwd);
    } else {
      ensureSessionCwd(agentId, sessionId, cwd);
    }
  }

  // Roll the mirror cwd back after a failed resume (pairs with
  // applySessionCwdForResume) so the agent isn't left pointing at a cwd for a
  // session that didn't actually resume.
  function rollbackSessionCwd(agentId: string, prevCwd: string) {
    for (const event of officeState.updateAgent(agentId, { cwd: prevCwd }))
      emit(event);
  }

  // Engine config (agentType + model/effort/permission/sandbox) is a property of
  // the session, mirroring cwd. Before a resume, restore the session's stored
  // engine onto the agent so createSession picks the right backend, runs the
  // right backend's preflight, and starts with the right model. Recomputes
  // capabilities from the new backend so UI affordances follow. Returns the prior
  // config so the caller can roll back if the resume fails. Legacy sessions with
  // no stored engine (agentType undefined) leave the agent untouched — a
  // pre-feature agent only ever ran the one engine it still has.
  function applySessionEngineForResume(
    agentId: string,
    managed: ManagedAgent,
    sessionId: string,
  ): { prevConfig: SessionEngineConfig | null; switched: boolean } {
    const stored = getSessionEngineConfig(agentId, sessionId);
    if (!stored || !stored.agentType)
      return { prevConfig: null, switched: false };
    const cur = managed.info;
    const same =
      stored.agentType === cur.agentType &&
      stored.modelFamily === cur.modelFamily &&
      stored.effort === cur.effort &&
      stored.permissionMode === cur.permissionMode &&
      (stored.codexSandbox ?? undefined) === (cur.codexSandbox ?? undefined);
    if (same) return { prevConfig: null, switched: false };
    const prevConfig: SessionEngineConfig = {
      agentType: cur.agentType,
      modelFamily: cur.modelFamily,
      effort: cur.effort,
      permissionMode: cur.permissionMode,
      codexSandbox: cur.codexSandbox,
    };
    for (const event of officeState.updateAgent(agentId, {
      agentType: stored.agentType,
      modelFamily: stored.modelFamily ?? cur.modelFamily,
      effort: stored.effort ?? cur.effort,
      permissionMode: stored.permissionMode ?? cur.permissionMode,
      codexSandbox: stored.codexSandbox,
      capabilities: getBackend(stored.agentType).capabilities,
    }))
      emit(event);
    return { prevConfig, switched: true };
  }

  // Roll the agent's engine config back after a failed resume (pairs with
  // applySessionEngineForResume) so a switch that didn't take doesn't leave the
  // agent pointing at the wrong backend.
  function rollbackSessionEngine(
    agentId: string,
    prevConfig: SessionEngineConfig,
  ) {
    for (const event of officeState.updateAgent(agentId, {
      agentType: prevConfig.agentType,
      modelFamily: prevConfig.modelFamily,
      effort: prevConfig.effort,
      permissionMode: prevConfig.permissionMode,
      codexSandbox: prevConfig.codexSandbox,
      capabilities: getBackend(prevConfig.agentType).capabilities,
    }))
      emit(event);
  }

  async function resume(agentId: string, sessionId: string) {
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
      persistQueueState(agentId, managed);
    }
    persistCurrentSessionTopic(agentId, managed);

    try {
      // cwd is a property of the session: restore the cwd this session ran in
      // before spawning (transactional — rolled back below if the resume fails).
      const { prevCwd, switched, storedCwdInvalid } = applySessionCwdForResume(
        agentId,
        managed,
        sessionId,
      );
      // Engine is also a property of the session: restore it before createSession
      // so the right backend is used (and rolled back below if the resume fails).
      const engine = applySessionEngineForResume(agentId, managed, sessionId);
      let newSession;
      try {
        newSession = createSession(managed, sessionId);
        await replaceSession(agentId, managed, newSession);
      } catch (err) {
        if (switched) rollbackSessionCwd(agentId, prevCwd);
        if (engine.switched && engine.prevConfig)
          rollbackSessionEngine(agentId, engine.prevConfig);
        throw err;
      }
      managed.sessionId = sessionId;
      // Record the cwd we actually resumed in: backfill a legacy/missing value, or
      // repair a present-but-invalid one so it isn't sticky on future resumes.
      recordResumedSessionCwd(
        agentId,
        sessionId,
        managed.info.cwd,
        storedCwdInvalid,
      );
      managed.topicGenerating = false;
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

      // Restore topic + topicMessageCount baseline from sessions.json so drift
      // can be measured against the replayed history.
      const sessions = listAgentSessions(agentId);
      const sessionEntry = sessions.find((s) => s.sessionId === sessionId);
      const restoredTopic = sessionEntry?.topic ?? null;
      const restoredCount = sessionEntry?.topicMessageCount ?? 0;
      managed.topicMessageCount = restoredCount;
      const replayedTextCount = history.filter(
        (e) => e.kind === "user_message" || e.kind === "text",
      ).length;
      const drift = replayedTextCount - restoredCount;
      for (const event of officeState.updateAgent(agentId, {
        topic: restoredTopic,
        topicStale: drift > 0,
      }))
        emit(event);

      updateState(agentId, "waiting_for_response");
      addLogEntry(
        agentId,
        "system",
        `Resumed session: ${restoredTopic || sessionId.slice(0, 8) + "..."}`,
      );

      // Regenerate now (rather than waiting for the next user_message) if the
      // topic is missing or the replayed history has drifted past the
      // refresh threshold — same policy as the /resume two-step flow above.
      if (!restoredTopic || drift >= TOPIC_REGEN_THRESHOLD) {
        void generateTopic(agentId);
      }
    } catch (err) {
      addLogEntry(agentId, "error", `Failed to resume: ${errMessage(err)}`);
      updateState(agentId, "error");
    }
  }

  async function editMessage(
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
      persistQueueState(agentId, managed);
    }

    const oldSessionId = managed.sessionId;
    persistCurrentSessionTopic(agentId, managed);
    const oldTopic = managed.info.topic;
    const oldTopicStale = managed.info.topicStale;

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
      const targetUsername = targetEntry.metadata?.username as
        | string
        | undefined;
      const targetDevice = targetEntry.metadata?.device as string | undefined;
      const targetSdkText =
        (targetEntry.metadata?.sdkText as string | undefined) ??
        targetEntry.content;
      const prefixedContent = `${formatPrefix({ username: targetUsername, device: targetDevice })}${targetSdkText}`;

      // Count which occurrence of this exact content this is among user_message log entries
      const userLogEntries = oldLogCache.filter(
        (e) => e.kind === "user_message",
      );
      let occurrenceIndex = 0;
      for (const e of userLogEntries) {
        const u = e.metadata?.username as string | undefined;
        const d = e.metadata?.device as string | undefined;
        const sdkText =
          (e.metadata?.sdkText as string | undefined) ?? e.content;
        const prefixed = `${formatPrefix({ username: u, device: d })}${sdkText}`;
        if (prefixed === prefixedContent) {
          if (e.id === logEntryId) break;
          occurrenceIndex++;
        }
      }

      // Find the matching user message in the backend transcript. We pass the
      // target's uuid to forkSessionBeforeMessage; each backend handles
      // predecessor-resolution and first-message semantics internally.
      //
      // stripPluginPrefix recovers `sdkText` from any turn where a beforeTurn
      // plugin (e.g. mem0) contributed a prefix block — the SDK records the
      // wrapped `${blocks}\n\nUser message:\n${sdkText}` form, but log entries
      // only carry `sdkText`. Without the strip, every edit on a turn that lit
      // up a plugin would fall through to the "could not locate" branch below.
      let matchCount = 0;
      let targetIdx = -1;
      for (let i = 0; i < backendMessages.length; i++) {
        const m = backendMessages[i];
        if (m.role !== "user") continue;
        if (stripPluginPrefix(m.text) === prefixedContent) {
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
            if (
              loadLog(agentId, s.sessionId).some((e) => e.id === logEntryId)
            ) {
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
      const newSessionId =
        forkResult.kind === "fork" ? forkResult.sessionId : "";

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
        // Count the parent's user/text entries up to the fork point — that's
        // the baseline for measuring drift on the new branch. Persisting it
        // alongside the inherited topic lets a later /resume of this fork
        // correctly recognize that the topic is in sync (or not).
        let parentTopicMessageCount = 0;
        for (const entry of oldLogCache) {
          if (entry.id === logEntryId) break;
          if (entry.kind === "user_message" || entry.kind === "text") {
            parentTopicMessageCount++;
          }
        }
        persistSessionFork(
          agentId,
          newSessionId,
          forkFromSessionId,
          logEntryId,
          oldTopic,
          parentTopicMessageCount,
          // Fork inherits the active session's cwd (cwd is per-session).
          managed.info.cwd,
          parentBase,
        );
        // Stamp the fork's inherited engine inline (a fork runs the parent's
        // engine, like cwd). The fork's own system_init would stamp it anyway,
        // but doing it here too closes the narrow window where the process dies
        // before that init: an un-tagged orphan fork resumed after a later engine
        // switch would dead-end on the wrong backend (same trap as legacy
        // sessions). managed.info holds the current engine at fork time.
        stampSessionEngineConfig(agentId, newSessionId, {
          agentType: managed.info.agentType,
          modelFamily: managed.info.modelFamily,
          effort: managed.info.effort,
          permissionMode: managed.info.permissionMode,
          codexSandbox: managed.info.codexSandbox,
        });
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
      // Build parentEntries up front so we can both seed managed.topicMessageCount
      // and replay them into logCache below from the same computation.
      const parentEntries: LogEntry[] = [];
      for (const entry of oldLogCache) {
        if (entry.id === logEntryId) break;
        parentEntries.push(entry);
      }
      // Anchor drift detection to the parent's text count at the fork point.
      // Zeroing here (as the previous code did) would trip the regen threshold
      // on the very first new exchange in the fork — defeating the threshold's
      // debounce. Match what's persisted alongside the inherited topic above.
      managed.topicMessageCount = parentEntries.filter(
        (e) => e.kind === "user_message" || e.kind === "text",
      ).length;
      managed.topicGenToken++;

      // --- Phase 2: UI/cache mutations (point of no return) ---

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

      // 8. Inherit parent's topic, marked stale. The drift-aware trigger in
      //    the next user_message path will regenerate it once the fork has
      //    accumulated TOPIC_REGEN_THRESHOLD new user/text entries; the ↻
      //    button is enabled immediately for users who want it sooner.
      for (const event of officeState.updateAgent(agentId, {
        topic: oldTopic,
        topicStale: true,
      }))
        emit(event);

      // 9. Send the edited message. The user_message log entry lands before
      // runAgentTurn so it's part of the visible timeline; runAgentTurn's
      // newLogEntries snapshot is taken AFTER, so the user_message is
      // excluded from the slice plugins observe.
      addLogEntry(
        agentId,
        "user_message",
        newText,
        buildUserMeta(username, device),
      );

      const editPrefix = formatPrefix({ username, device });
      const prefixedNew = editPrefix ? `${editPrefix}${newText}` : newText;
      await runAgentTurn({
        managed,
        visibleText: newText,
        // Raw replacement text is what the user actually wants the model to
        // see; sender prefix is isomux routing applied below.
        originalText: newText,
        sdkText: prefixedNew,
        origin: "edit-fork",
        humanInput: true,
      });
      // Topic mutation above + system/init persistAll on first-message edits
      // already covered the persisted state; nothing further changes during
      // the turn that needs an end-of-edit snapshot.
    } catch (err) {
      // runAgentTurn re-throws whatever the underlying turn threw and has
      // already cleaned up the pendingTurn deferred if session.send fell
      // before await turn. The rollback below still needs to restore the
      // pre-edit fork state for non-swap errors.
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
        // misconfigured backend.
        surfaceBackendNotConfigured(agentId, managed, err);
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

  function setTopic(agentId: string, topic: string) {
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
    // Persist to sessions.json so resume list shows the manual topic; the
    // count anchors future drift detection to the moment the user signed off.
    if (managed.sessionId) {
      persistSessionTopic(
        agentId,
        managed.sessionId,
        managed.info.topic,
        textCount,
      );
    }
    updateManifest();
  }

  function resetTopic(agentId: string) {
    const managed = agents.get(agentId);
    if (!managed) return;
    void generateTopic(agentId); // fire-and-forget
  }

  // --- Terminal PTY management — implementation in terminal.ts ---

  const terminalDeps: TerminalDeps = {
    getAgent: (agentId) => agents.get(agentId),
    emit: (event) => emit(event),
  };

  function openTerminal(agentId: string): boolean {
    return openTerminalImpl(agentId, terminalDeps);
  }

  function getTerminalBuffer(agentId: string): string | null {
    return getTerminalBufferImpl(agentId, terminalDeps);
  }

  function terminalInput(agentId: string, data: string) {
    terminalInputImpl(agentId, data, terminalDeps);
  }

  function terminalResize(agentId: string, cols: number, rows: number) {
    terminalResizeImpl(agentId, cols, rows, terminalDeps);
  }

  function closeTerminal(agentId: string) {
    closeTerminalImpl(agentId, terminalDeps);
  }

  // Test-only seam (projection/ACL net). Seed a fake PTY sidecar + buffered
  // output so the terminal_open buffered-replay path can be exercised without a
  // real node-pty sidecar: node-pty's native binding won't run under Bun, so
  // FakeBackend has no PTY. This sets the exact "already running" state
  // openTerminal early-returns on, so the REAL openTerminal (no spawn) and the
  // REAL getTerminalBuffer run against it. Throws on an unknown agent so a test
  // can't silently seed nothing. Never called in production; exposed only as
  // `_testSeedTerminalBuffer`, not part of the production terminal API.
  function _testSeedTerminalBuffer(agentId: string, buffer: string): boolean {
    const managed = agents.get(agentId);
    if (!managed) {
      throw new Error(`_testSeedTerminalBuffer: unknown agent ${agentId}`);
    }
    // Only the truthiness of ptySidecar is read on the replay path; cleanup
    // paths tolerate a missing stdin and only ever call kill().
    managed.ptySidecar = {
      kill() {
        /* test stub: no real PTY process to signal */
      },
    } as unknown as import("bun").Subprocess;
    managed.ptyBuffer = buffer;
    return true;
  }

  // Test-only: override the bounded-drain timeout (see CONSUMER_DRAIN_TIMEOUT_MS).
  // Returns the previous value so a test can restore it in afterEach.
  function _testSetConsumerDrainTimeout(ms: number): number {
    const prev = consumerDrainTimeoutMs;
    consumerDrainTimeoutMs = ms;
    return prev;
  }

  // Test-only: simulate an unknown-bug wedged flush (flushInProgress held with
  // an aged flushStartedAt) so sweepStuckFlushes' forced-recovery contract can
  // be exercised. Once layers 1–2 of task da065287 exist, every wire-
  // constructible wedge is already recovered by those layers themselves — the
  // forced path is insurance for wedges we haven't found, which by definition
  // can't be manufactured through honest machinery.
  function _testWedgeFlush(agentId: string, ageMs: number): void {
    const managed = agents.get(agentId);
    if (!managed) throw new Error(`_testWedgeFlush: unknown agent ${agentId}`);
    managed.flushInProgress = true;
    managed.flushStartedAt = Date.now() - ageMs;
  }

  // --- Editor file open/save — implementation in file-editor.ts ---
  //
  // The editor is per-WS state (watchers, dirty buffers, tabs); these wrappers
  // just resolve paths against the agent's cwd and run the disk ops. Watch
  // lifecycle lives in server/index.ts where the WS connection is in scope.

  function openEditorFile(
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

  function saveEditorFile(
    absPath: string,
    content: string,
    expectedMtime: number,
    expectedRev: number | undefined,
    force: boolean,
  ): SaveFileResult {
    return saveEditorFileImpl(
      absPath,
      content,
      expectedMtime,
      expectedRev,
      force,
    );
  }

  function resolveEditorPathForAgent(
    agentId: string,
    rawPath: string,
  ): string | null {
    const managed = agents.get(agentId);
    if (!managed) return null;
    const resolved = resolveEditorPath(rawPath, managed.info.cwd);
    return resolved.kind === "ok" ? resolved.path : null;
  }

  // Explicitly assembled public surface (see AgentManager type above). Mirrors
  // exactly the symbols server/index.ts consumed off the old namespace import.
  return {
    configurePluginHooksDeps,
    getRooms,
    globalRoomIndexOf,
    roomById,
    getOfficeSettings,
    getTasks,
    addTask,
    updateTask,
    deleteTask,
    setOfficeSettings,
    setRoomSettings,
    validateEnvPath,
    onEvent,
    getAgentLogs,
    getAgentCommands,
    listSessions,
    getCurrentSessionId,
    getAgentDisplay,
    editAgent,
    setPrivileged,
    swapDesks,
    createRoom,
    closeRoom,
    renameRoom,
    moveAgent,
    getAllAgents,
    getManifest,
    getKilledAgentSummaries,
    restoreAgents,
    demoteToLazy,
    sweepIdleAgents,
    sweepStuckFlushes,
    getAgent,
    emitAgentEditRequest,
    emitAgentTerminalCommand,
    emitAgentReadFile,
    emitAgentDiff,
    emitAgentPreviewUrl,
    spawn,
    enqueueMessage,
    addSystemNote,
    cancelQueued,
    sendNow,
    sendMessage,
    abort,
    kill,
    revive,
    newConversation,
    resume,
    editMessage,
    setTopic,
    resetTopic,
    openTerminal,
    getTerminalBuffer,
    terminalInput,
    terminalResize,
    closeTerminal,
    _testSeedTerminalBuffer,
    _testSetConsumerDrainTimeout,
    _testWedgeFlush,
    openEditorFile,
    saveEditorFile,
    resolveEditorPathForAgent,
    validateCwd,
    buildEnvForUserId,
  };
}

// Production factory: wires today's defaults. Loads the persisted office/agents
// snapshot ONCE, seeds OfficeState rooms from it (synchronous, so getRooms() is
// valid before the async restoreAgents()), injects the real getBackend
// resolver, and registers the office-env-file provider for env-loader. index.ts
// calls this at boot; tests construct createAgentManager(...) with fakes.
export function createProductionAgentManager(overrides?: {
  resolveBackend?: typeof defaultResolveBackend;
}): AgentManager {
  const initialOfficeConfig = loadOfficeConfig();
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
  const manager = createAgentManager({
    resolveBackend: overrides?.resolveBackend ?? defaultResolveBackend,
    officeState,
    initialRooms: initialLoadedAgents,
  });
  // Production-only global registration (kept out of createAgentManager so DI
  // tests don't clobber this env-loader process-global).
  setOfficeEnvFileProvider(() => officeState.office.envFile);
  return manager;
}
