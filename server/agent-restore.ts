// The install of a persisted agent at boot and at revive
// (restoreOrReviveAgent), the boot restore of every agent (restoreAgents) and
// the OpenCode profile key moves that run before it. Moved out of
// createAgentManager (server/agent-manager.ts), which wires it.
import { newFlushState } from "./queue-flush.ts";
import type { AgentAccess, AgentAccessGrant } from "../shared/agent-access.ts";
import type { ApiTokenLimits } from "../shared/api-token-limits.ts";
import { versionOf } from "../shared/blob-version.ts";
import { errMessage } from "../shared/errors.ts";
import {
  logTextFields,
  msg,
  renderLogText,
  type LogMessage,
  type LogText,
} from "../shared/i18n/log-message.ts";
import type { OfficeState } from "../shared/office-state.ts";
import type {
  AgentBackendType,
  AgentInfo,
  Attachment,
  LogEntry,
} from "../shared/types.ts";
import type { CeilingAgent, CeilingClamp } from "./member-ceiling.ts";
import { rmSync } from "fs";
import { claudeConfigDirOf } from "./provider-skill-links.ts";
import { join } from "path";
import { getAgentHost } from "./agent-host.ts";
import { managerOf } from "./agent-system-prompt.ts";
import type { ManagerDeps } from "./agent-manager.ts";
import type { createAgentSkills } from "./agent-skills.ts";
import { resolveAgentEngineSettings } from "./agent-validators.ts";
import { persistedAutoHandoffTokens } from "./auto-handoff.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import { moveOpenCodeSession } from "./backends/opencode/session-transfer.ts";
import { openCodeSupervisorForEnvironment } from "./backends/opencode/supervisor.ts";
import type { BackendSession, StoredSessionState } from "./backends/types.ts";
import { resolveClaudeSessionRoot } from "./claude-session-root.ts";
import { autocompleteCommands } from "./commands.ts";
import { STATE_ROOT } from "./config.ts";
import {
  buildEnvForUserId,
  claudeFamilyModelsForUserId,
  environmentSourceKeyForUserId,
  limitedClaudeFamiliesForUserId,
} from "./env-loader.ts";
import type { createHandoffAndWake } from "./handoff-and-wake.ts";
import { english } from "./i18n.ts";
import { mintAgentToken } from "./identity/tokens.ts";
import {
  freshTurnFlags,
  type AgentEvent,
  type ManagedAgent,
} from "./internal-types.ts";
import { errorText } from "./localized-error.ts";
import type { mcpServersForUserId } from "./mcp-servers.ts";
import type { createMessageQueue } from "./message-queue.ts";
import type { createOfficePersistence } from "./office-persistence.ts";
import {
  completeProfileKeyMove,
  readProfileKeyState,
  type ProfileKeyMove,
} from "./opencode-profile-keys.ts";
import {
  backfillSessionEngineConfigs,
  ensureSessionClaudeConfigDir,
  getSessionClaudeConfigDir,
  loadLogWithAncestors,
  saveMessageQueues,
  storedTopic,
  type PersistedAgent,
  type Room,
} from "./persistence.ts";
import {
  SessionManager,
  type DormantReason,
  type SessionManagerDeps,
} from "./session-manager.ts";
import {
  deduplicateSkills,
  discoverBundledSkills,
  discoverPluginSkills,
  discoverProjectSkills,
  discoverSyncedSkills,
  discoverUserSkills,
  type UserSkillRoot,
} from "./skills.ts";
import { spawnTreeFields } from "./spawn-agent-limits.ts";
import type { createTaskStore } from "./task-store.ts";

type MessageQueue = ReturnType<typeof createMessageQueue>;
type HandoffAndWake = ReturnType<typeof createHandoffAndWake>;
type AgentSkills = ReturnType<typeof createAgentSkills>;

export interface AgentRestoreDeps {
  agents: Map<string, ManagedAgent>;
  officeState: OfficeState;
  getBackend: ManagerDeps["resolveBackend"];
  emit: (event: AgentEvent) => void;
  // Puts the sign-in on the agent's info (server/usage-readings.ts).
  refreshSignIn: (managed: ManagedAgent) => void;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => unknown;
  createSession: (
    managed: ManagedAgent,
    resumeSessionId?: string,
  ) => BackendSession;
  sessionManagerDeps: SessionManagerDeps<ManagedAgent>;
  logCache: Map<string, LogEntry[]>;
  taskStore: ReturnType<typeof createTaskStore>;
  initialLoadedAgents: Room[];
  resolveAgentUserId: (p: PersistedAgent) => string | null;
  userSkillRootsForInfo: (
    info: Pick<AgentInfo, "agentType" | "userId">,
    env: { [key: string]: string | undefined } | undefined,
  ) => UserSkillRoot[];
  tokenUserIdFor: (info: AgentInfo) => string | null;
  noteUnresumableSession: (
    agentId: string,
    agentType: AgentInfo["agentType"],
    sessionId: string,
    state: StoredSessionState | "unknown",
  ) => void;
  summarizeEndedSession: (agentId: string, sessionId: string | null) => void;
  readPersistedQueueRecord: MessageQueue["readPersistedQueueRecord"];
  queueStore: MessageQueue["queueStore"];
  setQueueStoreCache: MessageQueue["setQueueStoreCache"];
  restoreLimitResume: HandoffAndWake["restoreLimitResume"];
  restoreRestartWakes: HandoffAndWake["restoreRestartWakes"];
  persistAll: ReturnType<typeof createOfficePersistence>["persistAll"];
  requestFlush: (agentId: string, label: string) => void;
  agentMcpServers: (
    userId: string | null | undefined,
  ) => ReturnType<typeof mcpServersForUserId>;
  buildOpenCodeLaunchEnvironmentForUserId: AgentSkills["buildOpenCodeLaunchEnvironmentForUserId"];
  openCodeEnvironmentRevisionForUserId: AgentSkills["openCodeEnvironmentRevisionForUserId"];
  openCodeSkillPathsForUserId: AgentSkills["openCodeSkillPathsForUserId"];
  accessFields: (src: { access?: AgentAccess; pack?: ApiTokenLimits }) => {
    access?: AgentAccess;
    pack?: ApiTokenLimits;
  };
  accessGrantOf: (src: {
    access?: AgentAccess;
    privileged?: boolean;
    pack?: ApiTokenLimits;
  }) => AgentAccessGrant;
  needsInterruptionMarker: (
    tail: Pick<LogEntry, "kind"> | undefined,
  ) => boolean;
  // Sets the closure's officeStatePersistenceEnabled once the boot restore
  // has filled the live map.
  enableOfficeStatePersistence: () => void;
  profileKeyMoveLimitMs: ManagerDeps["profileKeyMoveLimitMs"];
  // What the agent ceiling of the manager does to an agent
  // (server/member-ceiling.ts): a boot or a revive installs it moved down.
  memberCeilingClamp: (agent: CeilingAgent) => CeilingClamp;
}

export function createAgentRestore(deps: AgentRestoreDeps) {
  const {
    agents,
    officeState,
    getBackend,
    emit,
    addLogEntry,
    createSession,
    sessionManagerDeps,
    logCache,
    taskStore,
    initialLoadedAgents,
    resolveAgentUserId,
    userSkillRootsForInfo,
    tokenUserIdFor,
    noteUnresumableSession,
    summarizeEndedSession,
    readPersistedQueueRecord,
    queueStore,
    setQueueStoreCache,
    restoreLimitResume,
    restoreRestartWakes,
    persistAll,
    requestFlush,
    agentMcpServers,
    buildOpenCodeLaunchEnvironmentForUserId,
    openCodeEnvironmentRevisionForUserId,
    openCodeSkillPathsForUserId,
    accessFields,
    accessGrantOf,
    needsInterruptionMarker,
    enableOfficeStatePersistence,
    memberCeilingClamp,
  } = deps;

  function clampedToCeiling(
    persisted: PersistedAgent,
    agentType: AgentBackendType,
    userId: string | null,
  ): PersistedAgent {
    const clamp = memberCeilingClamp({
      id: persisted.id,
      name: persisted.name,
      cwd: persisted.cwd,
      agentType,
      modelFamily: persisted.modelFamily,
      userId,
      ...(persisted.access ? { access: persisted.access } : {}),
      privileged: persisted.privileged ?? false,
      ...(persisted.pack ? { pack: persisted.pack } : {}),
    });
    if (clamp.kind !== "move") return persisted;
    const { pack: _old, ...rest } = persisted;
    return {
      ...rest,
      privileged: false,
      access: clamp.grant.access,
      ...(clamp.grant.pack ? { pack: clamp.grant.pack } : {}),
    };
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
    // The receptionist restores with the lobby as its room id: it has no
    // container room, so roomIdx is ignored when this is set.
    roomIdOverride?: string;
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
    const agentType = opts.persisted.agentType ?? "claude";
    const userId = resolveAgentUserId(opts.persisted);
    // An agent above its manager's agent ceiling comes back at the ceiling, so
    // no session ever runs above it. One the engine cannot move keeps its stop
    // and gets no session (createSession).
    const p = clampedToCeiling(opts.persisted, agentType, userId);
    const restoredCwd = p.cwd;
    // Canonicalize persisted values without making one malformed agent stop the
    // boot restore. Interactive spawn/edit applies the stricter mismatch guard.
    const { modelFamily, permissionMode, effort, codexSandbox } =
      resolveAgentEngineSettings(agentType, p);
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
    // Silent restore policy: each backend classifies its own stored session;
    // this caller decides that only durable sessions auto-resume.
    let resumeSessionId: string | null = null;
    // The stored state of a session this restore drops, for its note.
    let droppedState: StoredSessionState | null = null;
    if (p.lastSessionId) {
      try {
        let restoreEnv = buildEnvForUserId(userId);
        if (agentType === "claude") {
          const root = resolveClaudeSessionRoot(
            p.lastSessionId,
            restoredCwd,
            restoreEnv,
            getSessionClaudeConfigDir(p.id, p.lastSessionId),
            userId,
          );
          ensureSessionClaudeConfigDir(p.id, p.lastSessionId, root);
          restoreEnv = {
            ...(restoreEnv ?? getAgentHost().baseEnv()),
            CLAUDE_CONFIG_DIR: root,
          };
        }
        const stored = getBackend(agentType).inspectStoredSession(
          p.lastSessionId,
          {
            cwd: restoredCwd,
            env: restoreEnv,
            environmentKey: environmentSourceKeyForUserId(userId),
          },
        );
        if (stored === "durable") resumeSessionId = p.lastSessionId;
        else droppedState = stored;
      } catch {
        // Preserve the previous indeterminate rule: let the backend attempt
        // the resume and surface a precise error instead of silently dropping.
        resumeSessionId = p.lastSessionId;
      }
    }
    const desk = opts.deskOverride ?? p.desk;
    // Resolve the agent's stable roomId from its container room
    // (opts.roomIdx is the physical truth from the persisted bucket). Clamp +
    // log if the index is out of range (corrupt state) rather than silently
    // mapping to room 0.
    const containerRoom = officeState.rooms[opts.roomIdx];
    if (opts.roomIdOverride) {
      // No container room to reconcile against.
    } else if (!containerRoom) {
      console.error(
        `[3c] restore: roomIdx ${opts.roomIdx} out of range for agent ${p.id} (${officeState.rooms.length} room(s)); clamping to room 0`,
      );
    } else if (p.roomId && p.roomId !== containerRoom.id) {
      console.log(
        `[3c] restore: agent ${p.id} persisted roomId ${p.roomId} != container ${containerRoom.id}; using container`,
      );
    }
    const roomId =
      opts.roomIdOverride ??
      containerRoom?.id ??
      officeState.rooms[0]?.id ??
      "";
    const info: AgentInfo = {
      id: p.id,
      name: p.name,
      desk,
      roomId,
      cwd: restoredCwd,
      outfit: p.outfit,
      permissionMode,
      modelFamily,
      effort,
      // Pose tracks whether there's a conversation, not whether the subprocess
      // is loaded. A resumable session (resumeSessionId set) comes back
      // "waiting_for_response" - it finished its last turn and is waiting on the
      // human - whether restored eagerly or lazily; only a genuinely blank agent
      // (no resumable session) is "idle". Keying this off opts.lazy used to leak
      // the RAM detail into the UI: every conversation agent slept (idle pose)
      // after a restart until messaged, and lost Tab priority to blank desks.
      // editMessage forks from the on-disk session, so a dormant
      // "waiting_for_response" agent edits fine (the fork wakes it).
      state: resumeSessionId ? "waiting_for_response" : "idle",
      topic: storedTopic(p.topic),
      topicGenerating: false,
      customInstructions: p.customInstructions ?? null,
      // Derived from the blob (never persisted separately), so legacy records
      // that predate the field backfill correctly on load.
      customInstructionsVersion: versionOf(p.customInstructions ?? ""),
      agentType,
      ...(codexSandbox ? { codexSandbox } : {}),
      ...(p.officeFreeModel ? { officeFreeModel: p.officeFreeModel } : {}),
      capabilities: getBackend(agentType).capabilities,
      limitedClaudeFamilies: limitedClaudeFamiliesForUserId(userId),
      claudeFamilyModels: claudeFamilyModelsForUserId(userId),
      userId,
      // The member's name now, not the snapshot: an office renamed a member
      // before renames reached the snapshot heals here, at a boot and at a
      // revive (task 3278f29c).
      manager: managerOf({ userId, manager: p.manager ?? null }).name,
      privileged: p.privileged ?? false,
      ...accessFields(p),
      ...spawnTreeFields(p),
      ...(p.autoHandoff === false ? { autoHandoff: false } : {}),
      ...persistedAutoHandoffTokens(p.autoHandoffTokens),
      ...(p.limitResume === false ? { limitResume: false } : {}),
      queue: [],
      sessionSwapping: false,
      turnMemberIds: [],
      // Dormant iff lazy-restored (no subprocess). Eager paths install a session
      // below, which clears it (already false here, so installSession no-ops).
      dormant: !!opts.lazy,
    };
    officeState.addExistingAgent(info);
    // Boot migration runs after managers load persisted state. Keep skill
    // discovery from turning a pending env import into a boot failure; session
    // creation still resolves the env again and surfaces the repair instruction.
    let discoveryEnv: { [key: string]: string | undefined } | undefined;
    try {
      discoveryEnv = buildEnvForUserId(userId);
    } catch {
      discoveryEnv = undefined;
    }
    const discoverySkillRoots = userSkillRootsForInfo(info, discoveryEnv);
    // A never-started agent stays a blank conversation across a restart,
    // and so does one whose stored session this restore dropped: its note
    // is already in the chat (noteUnresumableSession). Mark those fresh so
    // the first wake adds no other notice. An eager restore installs below.
    const releasedAs: DormantReason = opts.lazy
      ? p.lastSessionId && !droppedState
        ? "boot"
        : "fresh"
      : null;
    const sessionManager = new SessionManager<ManagedAgent>(
      p.id,
      sessionManagerDeps,
      resumeSessionId,
      releasedAs,
    );
    const managed: ManagedAgent = {
      info,
      sessionManager,
      slashCommands: autocompleteCommands(info.agentType),
      skills: deduplicateSkills([
        ...discoverUserSkills(discoverySkillRoots),
        ...discoverProjectSkills(p.cwd, info.agentType),
        // Only Claude loads plugin skills.
        ...(info.agentType === "claude"
          ? discoverPluginSkills(claudeConfigDirOf(discoveryEnv), p.cwd)
          : []),
        ...discoverBundledSkills(),
        // Account-synced skills are Claude's too.
        ...(info.agentType === "claude"
          ? discoverSyncedSkills(
              claudeConfigDirOf(discoveryEnv),
              null,
              new Set(),
            )
          : []),
      ]),
      sdkReportedCommands: [],
      reportedPlugins: null,
      reportedSkills: null,
      thinkingStartedAt: 0,
      turnStartedAt: 0,
      lastNormalizedEventAt: 0,
      busyTurnWatchdogObserved: false,
      toolCallTimestamps: new Map(),
      topicGenToken: 0,
      topicBackoff: null,
      summaryPending: null,
      contextUsage: null,
      contextGen: 0,
      contextSampleSeq: 0,
      contextUsageCommittedSeq: 0,
      contextSampleInFlight: null,
      firedAgentThresholds: new Set(),
      firedUiThresholds: new Set(),
      memoryNotice: null,
      memoryNoticeFired: false,
      wakeNotice: null,
      signInNotice: null,
      stopNotice: null,
      settingsNotice: null,
      autoHandoffPhase: null,
      autoHandoffSpent: false,
      autoHandoffCapture: null,
      autoHandoffOpened: false,
      autoHandoffNotice: null,
      turnFlags: freshTurnFlags(),
      limitResumeAt: null,
      ...(p.heardFrom?.length ? { heardFrom: new Set(p.heardFrom) } : {}),
      ...(p.heardFromMembers?.length
        ? { heardFromMembers: new Set(p.heardFromMembers) }
        : {}),
      officeFallback: p.officeFallback === true,
      pendingFreshRecoveryNotice: false,
      subscriptionUsage: null,
      subscriptionGen: 0,
      subscriptionSampleSeq: 0,
      subscriptionCommittedSeq: 0,
      pendingResume: false,
      pendingResumeSessions: [],
      pendingModelPick: false,
      pendingEffortPick: false,
      pendingInteraction: null,
      pendingPermission: null,
      queuedPermissions: [],
      ptySidecar: null,
      ptyBuffer: "",
      lastWrittenEntryId: null,
      messageQueue: [],
      autoResumeInProgress: false,
      flush: newFlushState(),
      freeModelResend: null,
      freeModelRetryTurn: false,
      lastForcedRecoveryAt: 0,
      recentSteers: [],
      queueDedupe: new Map(),
      lastActiveAt: Date.now(),
      releasedBackgroundTasks: null,
      savedBackgroundTasks: null,
    };
    // The work the last run's end ended: the first wake after a restart names
    // it. A dropped conversation ("fresh") starts blank, with nothing to name.
    if (releasedAs === "boot" && p.backgroundTasks?.length)
      managed.releasedBackgroundTasks = p.backgroundTasks;
    // Re-seed the durable queue + dedupe window
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
    mintAgentToken(p.id, tokenUserIdFor(info), accessGrantOf(p));
    // Worked out again, never carried over: the sign-in may have changed
    // while the server was down.
    deps.refreshSignIn(managed);
    if (p.lastSessionId && droppedState)
      noteUnresumableSession(p.id, agentType, p.lastSessionId, droppedState);

    if (resumeSessionId) {
      const history = loadLogWithAncestors(p.id, resumeSessionId);
      if (history.length > 0) {
        logCache.set(p.id, [...history]);
      }
    }

    // Lazy restore: stop here. The agent is on its desk (addExistingAgent above),
    // state="idle", dormant=true, sessionId set, transcript loaded into logCache,
    // and its token is minted - everything the wake path needs. The first message
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
      needsInterruptionMarker((logCache.get(p.id) ?? []).at(-1))
    );

    // Session install: try resume, optionally fall back to fresh on failure,
    // record state=error if both fail. agent_added is deferred to after this
    // settles so the broadcast state reflects reality (and so a failed revive
    // never emits an add the client will then see removed).
    let sessionOk = false;
    let sessionError: LogMessage | string | null = null;

    try {
      const session = resumeSessionId
        ? createSession(managed, resumeSessionId)
        : createSession(managed);
      managed.sessionManager.installSession(managed, session);
      sessionOk = true;
    } catch (err) {
      sessionError = errorText(err);
      if (resumeSessionId && opts.fallbackToFreshOnResumeFailure) {
        console.warn(
          `[revive] Resume of ${p.name} failed, falling back to fresh session: ${errMessage(err)}`,
        );
        summarizeEndedSession(p.id, managed.sessionManager.sessionId);
        managed.sessionManager.adoptSessionId(null);
        // Keep the loaded transcript in logCache so the chat view shows the
        // historical conversation (especially important for legacy revivals
        // where the SDK can never resume because cwd/project dir don't
        // match). New messages start a fresh SDK session that doesn't have
        // that context, but the member can read the past.
        // Clear the historical topic - it was derived from the OLD session
        // that we can no longer resume. The fresh session will regenerate
        // its own topic from new messages.
        officeState.updateAgent(p.id, { state: "idle", topic: null });
        try {
          const freshSession = createSession(managed);
          managed.sessionManager.installSession(managed, freshSession);
          sessionOk = true;
          sessionError = null;
        } catch (err2) {
          sessionError = errorText(err2);
        }
      }
    }

    if (!sessionOk) {
      console.error(
        `Failed to restore session for ${p.name}:`,
        sessionError === null
          ? "(unknown)"
          : renderLogText(english, sessionError),
      );
      officeState.updateAgent(p.id, { state: "error" });
      const entry: LogEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        agentId: p.id,
        timestamp: Date.now(),
        kind: "error",
        ...logTextFields(
          msg("systemEntries.restoreOnStartupFailed", {
            error: sessionError ?? "(unknown)",
          }),
        ),
      };
      const cached = logCache.get(p.id) ?? [];
      cached.push(entry);
      logCache.set(p.id, cached);
    }

    // Marker write: only after resume actually happened (fresh fallback
    // nulls managed.sessionManager.sessionId so this skips). Mirrors the SDK's own lazy
    // placeholder for interrupted-on-resume sessions.
    if (
      sessionOk &&
      shouldAddInterruptionMarker &&
      resumeSessionId !== null &&
      managed.sessionManager.sessionId === resumeSessionId
    ) {
      addLogEntry(p.id, "system", msg("systemEntries.previousInterrupted"));
    }

    // Emit only on success so a failed revive doesn't flicker an add the
    // client will then see removed by the rollback.
    if (opts.emitAgentAdded && sessionOk) {
      emit({ type: "agent_added", agent: info });
    }

    return {
      sessionOk,
      sessionError:
        sessionError === null ? null : renderLogText(english, sessionError),
    };
  }

  // Restore agents from disk on startup. Creates sessions and loads log history.
  // Boot step 2 of the OpenCode profile key migration
  // (server/opencode-profile-keys.ts): the pending moves, one after the
  // other, within one total limit. Each move that ends leaves the file, so a
  // failed move does not run at every boot; moves the limit cut off stay for
  // the next boot, and the boot goes on.
  async function runPendingProfileKeyMoves(): Promise<void> {
    let moves: ProfileKeyMove[];
    try {
      moves = readProfileKeyState()?.pendingMoves ?? [];
    } catch (error) {
      console.error(`[opencode] ${errMessage(error)}`);
      return;
    }
    if (moves.length === 0) return;
    const limitMs = deps.profileKeyMoveLimitMs ?? 60_000;
    let expired = false;
    const run = (async () => {
      for (const move of moves) {
        if (expired) return;
        try {
          await moveOpenCodeSession({
            sessionId: move.sessionId,
            fromProfileDir: openCodeProfilePaths(move.fromKey).profileDir,
            target: openCodeSupervisorForEnvironment(
              move.toKey,
              buildOpenCodeLaunchEnvironmentForUserId(move.userId),
              openCodeEnvironmentRevisionForUserId(move.userId),
              agentMcpServers(move.userId),
              openCodeSkillPathsForUserId(move.userId),
            ),
            targetEnvironmentKey: move.toKey,
          });
          completeProfileKeyMove(move);
        } catch (error) {
          // The owner's environment did not load: the move stays pending.
          console.error(
            `[opencode] session ${move.sessionId} of agent ${move.agentId} was not moved: ${errMessage(error)}`,
          );
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.then(() => "done" as const),
      new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), limitMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "expired") {
      expired = true;
      console.error(
        `[opencode] the profile moves took over ${limitMs / 1000} s; the rest wait for the next boot`,
      );
    }
  }

  async function restoreAgents() {
    // Clean up the pre-0.2.116 per-agent launcher scripts. Isomux now passes the
    // native Claude binary directly, so these are orphaned.
    try {
      rmSync(join(STATE_ROOT, "launchers"), {
        recursive: true,
        force: true,
      });
    } catch {}

    // Before any restore inspects a session: an agent's last session that
    // the profile key migration moves must be in its new profile by then.
    await runPendingProfileKeyMoves();

    // Rooms were seeded at module init from initialLoadedAgents - reuse
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
        restoreLimitResume(p);
      }
    }
    // Round-trip migrations back to disk in case the load step filled in new
    // fields (room ids, prompt/envFile defaults) that weren't present before.
    // Must run AFTER agents are populated or persistAll writes empty rooms.
    persistAll();
    try {
      officeState.setTasksDirect(taskStore.load());
    } catch (error) {
      console.error(
        "[tasks] could not load task storage; starting with an empty board",
        error,
      );
      officeState.setTasksDirect([]);
    }
    enableOfficeStatePersistence();
    // Durable-queue hygiene: drop records for agents that no
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
          setQueueStoreCache(next);
        } catch (err) {
          console.error(
            "Failed to prune stale message-queue records:",
            errMessage(err),
          );
        }
      }
    }
    // Wakes after the restart, before the replay kick so a wake for an agent
    // with queued messages joins that replay.
    restoreRestartWakes();
    // Boot replay kick: resume delivery exactly where the restart cut it off.
    // Fire-and-forget - each flush wakes its (dormant) agent via the !session
    // resume branch. The turn runner is configured before restoreAgents runs
    // (see isomux-office.ts boot ordering), so runAgentTurn is safe to enter. The
    // queue watchdog is the backstop if any kick is lost.
    for (const [agentId, m] of agents) {
      if (m.messageQueue.length > 0) {
        console.log(
          `Replaying ${m.messageQueue.length} queued message(s) for ${m.info.name} (${agentId})`,
        );
        requestFlush(agentId, "boot-replay");
      }
    }
    return [...agents.values()].map((a) => a.info);
  }

  return {
    restoreOrReviveAgent,
    restoreAgents,
  };
}
