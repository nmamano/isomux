// A member's /handoff, the automatic handoff, the resume after a usage limit
// (server/limit-resume.ts) and the wake after a server restart
// (server/restart-wake.ts), with the turn record the wake reads. Moved out of
// createAgentManager (server/agent-manager.ts), which wires it.
import type {
  AgentState,
  Attachment,
  LogEntry,
  QueuedMessage,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { formatPrefix } from "../shared/identity.ts";
import {
  msg,
  type LogMessage,
  type LogText,
} from "../shared/i18n/log-message.ts";
import type { LimitResumeClock, ManagerDeps } from "./agent-manager.ts";
import { runAgentTurn } from "./agent-turn.ts";
import { recordAudit } from "./audit-store.ts";
import {
  autoHandoffBriefPrompt,
  handoffBriefPrompt,
  autoHandoffMeasureParams,
  autoHandoffTokensOf,
  autoHandoffTrigger,
  joinBriefChunks,
  type AutoHandoffTrigger,
} from "./auto-handoff.ts";
import {
  AuthNeededError,
  BackendNotConfiguredError,
  ProviderCapacityError,
  SessionSwappedError,
  inMultiStepFlow,
  pendingPromptOf,
  type AutoHandoffPhase,
  type ContextUsageSnapshot,
  type EnqueueResult,
  type ManagedAgent,
  type ManualHandoffRequest,
} from "./internal-types.ts";
import {
  LIMIT_RESUME_BOOT_DELAY_MS,
  LIMIT_RESUME_TEXT,
  limitResumeDueAt,
  limitResumeOn,
  limitResumeWaitMs,
} from "./limit-resume.ts";
import {
  directInputCapped,
  managerCapped,
  UsageCapError,
} from "./member-usage-cap.ts";
import {
  loadTurnsInFlightRaw,
  saveTurnsInFlight,
  type PersistedAgent,
} from "./persistence.ts";
import {
  RESTART_WAKE_CLEAR_DELAY_MS,
  RESTART_WAKE_TEXT,
  planRestartWakes,
  restartWakeDelayMs,
  type TurnInFlightRecord,
} from "./restart-wake.ts";
import { flushRunning, queueHeld } from "./queue-flush.ts";
import { serverStopping } from "./server-stop.ts";

export interface HandoffAndWakeDeps {
  agents: Map<string, ManagedAgent>;
  limitResumeClock: LimitResumeClock;
  maybeEmitUiContextNotice: (managed: ManagedAgent) => void;
  emitEphemeralLog: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
  ) => unknown;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => unknown;
  pickAutoResumeSessionId: (managed: ManagedAgent) => string | null;
  claimAutoResume: (
    agentId: string,
    managed: ManagedAgent,
    sessionId: string,
  ) => void;
  releaseBackendHold: (agentId: string, managed: ManagedAgent) => void;
  requestFlush: (agentId: string, label: string) => void;
  persistAll: () => void;
  getAgentDisplay: (
    agentId: string,
  ) => { name: string; roomName: string } | null;
  enqueueMessage: (
    agentId: string,
    msg: {
      sender: QueuedMessage["sender"];
      text: string;
      limitResume?: boolean;
      limitResumeMemberIds?: string[];
      restartWake?: boolean;
    },
  ) => EnqueueResult;
  persistQueueState: (agentId: string, managed: ManagedAgent) => void;
  memberIdsOf: (username: string | undefined) => string[];
  ownedTurnFailure: (
    agentId: string,
    managed: ManagedAgent,
    err: unknown,
    opts: {
      username?: string;
      label: string;
      frame: (error: LogMessage | string) => LogText;
    },
  ) => void;
  handoffBody: (
    agentId: string,
    text: string,
    auto?: AutoHandoffPhase,
  ) => Promise<EnqueueResult>;
  isQueueIdleState: (s: AgentState) => boolean;
  turnsInFlightFile: ManagerDeps["turnsInFlightFile"];
  restartWakeClock: ManagerDeps["restartWakeClock"];
  serverStopping: ManagerDeps["serverStopping"];
}

export function createHandoffAndWake(deps: HandoffAndWakeDeps) {
  const {
    agents,
    limitResumeClock,
    maybeEmitUiContextNotice,
    emitEphemeralLog,
    addLogEntry,
    pickAutoResumeSessionId,
    claimAutoResume,
    releaseBackendHold,
    requestFlush,
    persistAll,
    getAgentDisplay,
    enqueueMessage,
    persistQueueState,
    memberIdsOf,
    ownedTurnFailure,
    handoffBody,
    isQueueIdleState,
  } = deps;

  // Wake after a server restart (server/restart-wake.ts). turnsInFlight holds
  // this boot's turns; wakesOwed the cut turns of the previous boot whose wake
  // is not sent yet. turns-in-flight.json mirrors both.
  const turnsInFlight = new Map<string, TurnInFlightRecord>();
  const wakesOwed = new Map<string, TurnInFlightRecord>();
  const turnRecordClearTimers = new Map<string, unknown>();
  // Turn deferreds a record clear already waits on.
  const watchedTurnEnds = new WeakSet<Promise<void>>();
  const restartWakeTimers = new Map<string, unknown>();
  const restartWakeClock: LimitResumeClock = deps.restartWakeClock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const isServerStopping = deps.serverStopping ?? serverStopping;

  // A member's typed /handoff (command-handlers): arms the phase with
  // `manual`, so the brief turn and the switch run as the automatic ones do.
  function requestHandoff(
    agentId: string,
    rawText: string,
    request: ManualHandoffRequest,
  ): void {
    const managed = agents.get(agentId);
    if (!managed) return;
    const userMeta: Record<string, unknown> = {};
    if (request.username) userMeta.username = request.username;
    if (request.device) userMeta.device = request.device;
    const refuse = (line: LogMessage) => {
      emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      emitEphemeralLog(agentId, "system", line);
    };
    // One handoff at a time: a running brief turn, a reset, or a /handoff
    // that waits for the current turn.
    const current = managed.autoHandoffPhase;
    if (
      handoffInProgress.has(agentId) ||
      current?.briefStarted ||
      current?.manual
    ) {
      refuse(msg("commands.handoff.underWay"));
      return;
    }
    if (!managed.sessionManager.sessionId) {
      refuse(msg("commands.handoff.empty"));
      return;
    }
    // After a failed turn the agent is in error: the brief turn needs the
    // conversation resumed first, as a message's enqueue does.
    const state = managed.info.state;
    const resumeId =
      state === "error" ? pickAutoResumeSessionId(managed) : null;
    if (state === "error" && resumeId === null) {
      refuse(msg("commands.handoff.notResumable"));
      return;
    }
    // The echo pairs with the prompt the brief turn sends, for edit-fork.
    addLogEntry(agentId, "user_message", rawText, {
      ...userMeta,
      sdkText: manualBriefText(request),
    });
    // An armed automatic handoff with no brief yet gives way, as it does to
    // an agent's own handoff call.
    const busy =
      state === "thinking" ||
      state === "tool_executing" ||
      managed.sessionManager.pendingTurn !== null;
    managed.autoHandoffPhase = { briefStarted: false, manual: request };
    if (busy) {
      addLogEntry(agentId, "system", msg("commands.handoff.waiting"));
      return;
    }
    // The resume's move out of error fires updateState's flush trigger,
    // which starts the brief turn.
    if (resumeId !== null) {
      claimAutoResume(agentId, managed, resumeId);
      return;
    }
    // A member's request for a turn retries a backend that failed, as a
    // message does; the release flushes, which starts the brief turn.
    releaseBackendHold(agentId, managed);
    requestFlush(agentId, "handoff");
  }

  // The manual brief turn's text: the member prefix, then the prompt.
  function manualBriefText(request: ManualHandoffRequest): string {
    return `${formatPrefix({ username: request.username, device: request.device })}${handoffBriefPrompt(request.note)}`;
  }

  // A member's /handoff waits for the current turn: the queue gate runs it
  // even when no message waits.
  function handoffWaiting(managed: ManagedAgent): boolean {
    const phase = managed.autoHandoffPhase;
    return !!phase?.manual && !phase.briefStarted;
  }

  // In-flight handoff guard. A SECOND concurrent handoff for the same agent
  // must not run: its brief would go ahead of the first's, and its reset would
  // throw away the fresh session the first one just woke. We reject the second
  // with 409 handoff_in_progress rather than chaining; first wins, the loser is
  // told to retry.
  const handoffInProgress = new Set<string>();

  // ---- Automatic handoff (internal-docs/auto-handoff-design.md) ----------
  //
  // Arms from a committed sample (evaluateAutoHandoff), or from a member's
  // /handoff (requestHandoff, with `manual`). The next message to arrive, or
  // for /handoff the end of the current turn, runs one brief turn in the old
  // session (runAutoHandoff), then hands off through handoffBody. While the phase is set, every send path queues
  // and flushQueue starts the brief turn instead of sending, so that message
  // and the rest of the queue go to the fresh session. Every exit clears the
  // phase and lets the queue flush.

  // Called on every committed sample. Pauses a conversation an automatic
  // handoff opened above the trigger (the loop guard), and arms on a sample
  // from the end of a completed turn.
  function evaluateAutoHandoff(
    managed: ManagedAgent,
    turnStatus: "completed" | "interrupted" | "failed" | undefined,
  ): void {
    const snap = managed.contextUsage;
    if (!snap) return;
    const opened = managed.autoHandoffOpened;
    managed.autoHandoffOpened = false;
    if (
      managed.info.autoHandoff === false ||
      !managed.info.capabilities.autoHandoff
    )
      return;
    const trigger = autoHandoffTrigger(snap, autoHandoffTokensOf(managed.info));
    const above = snap.totalTokens >= trigger.tokens;
    if (!above || managed.autoHandoffSpent || managed.autoHandoffPhase) return;
    const agentId = managed.info.id;
    if (opened) {
      managed.autoHandoffSpent = true;
      addLogEntry(agentId, "system", msg("systemEntries.autoHandoff.paused"));
      return;
    }
    // A member who pressed Stop wants attention, not a reset.
    if (turnStatus !== "completed") return;
    armAutoHandoffPhase(managed, snap, trigger);
    // The reply that crossed the trigger stays on screen: the brief turn
    // starts when the next message arrives (flushQueue).
  }

  // A settings edit (editAgent) arms from the latest sample of any source:
  // the member's edit is the intent, so a stopped turn's sample counts too.
  function armAutoHandoffFromEdit(agentId: string, managed: ManagedAgent) {
    const snap = managed.contextUsage;
    if (
      !snap ||
      managed.info.autoHandoff === false ||
      !managed.info.capabilities.autoHandoff ||
      managed.autoHandoffPhase ||
      managed.autoHandoffSpent ||
      handoffInProgress.has(agentId)
    )
      return;
    const trigger = autoHandoffTrigger(snap, autoHandoffTokensOf(managed.info));
    if (snap.totalTokens >= trigger.tokens)
      armAutoHandoffPhase(managed, snap, trigger);
  }

  function armAutoHandoffPhase(
    managed: ManagedAgent,
    snap: ContextUsageSnapshot,
    trigger: AutoHandoffTrigger,
  ) {
    managed.autoHandoffPhase = {
      briefStarted: false,
      trigger,
      totalTokens: snap.totalTokens,
      percentage: snap.percentage,
    };
  }

  // Resume after a usage limit (server/limit-resume.ts). The fire time is
  // managed.limitResumeAt; this map holds the timer that waits for it.
  const limitResumeTimers = new Map<string, unknown>();

  function scheduleLimitResume(
    agentId: string,
    managed: ManagedAgent,
    minWaitMs = 0,
  ): void {
    const prev = limitResumeTimers.get(agentId);
    if (prev !== undefined) limitResumeClock.clearTimeout(prev);
    limitResumeTimers.delete(agentId);
    const dueAt = managed.limitResumeAt;
    if (dueAt === null) return;
    const timer = limitResumeClock.setTimeout(
      () => {
        limitResumeTimers.delete(agentId);
        fireLimitResume(agentId);
      },
      limitResumeWaitMs(dueAt, limitResumeClock.now(), minWaitMs),
    );
    limitResumeTimers.set(agentId, timer);
  }

  // A turn a usage limit stopped has ended. A reset time that is not in the
  // future arms nothing (the loop guard in limit-resume.ts).
  function armLimitResume(
    agentId: string,
    managed: ManagedAgent,
    resetsAtMs: number,
  ): void {
    if (!limitResumeOn(managed.info)) return;
    const dueAt = limitResumeDueAt(resetsAtMs, limitResumeClock.now());
    if (dueAt === null) return;
    managed.limitResumeAt = dueAt;
    persistAll();
    scheduleLimitResume(agentId, managed);
  }

  function dropLimitResume(agentId: string, managed: ManagedAgent): void {
    if (managed.limitResumeAt === null) return;
    managed.limitResumeAt = null;
    const timer = limitResumeTimers.get(agentId);
    if (timer !== undefined) limitResumeClock.clearTimeout(timer);
    limitResumeTimers.delete(agentId);
    if (agents.get(agentId) === managed) persistAll();
  }

  // Boot: a pending resume of the conversation the agent restored. One due
  // during downtime fires shortly after boot.
  function restoreLimitResume(p: PersistedAgent): void {
    const managed = agents.get(p.id);
    const dueAt = p.limitResumeAt;
    if (!managed || typeof dueAt !== "number" || !Number.isFinite(dueAt))
      return;
    if (!managed.sessionManager.sessionId || !limitResumeOn(managed.info))
      return;
    managed.limitResumeAt = dueAt;
    scheduleLimitResume(p.id, managed, LIMIT_RESUME_BOOT_DELAY_MS);
  }

  // Why a due resume does not go out, or null when it does. A busy agent is
  // already working, so the resume would stack a second turn.
  function limitResumeSkipReason(managed: ManagedAgent): string | null {
    if (!limitResumeOn(managed.info)) return "switched off";
    if (!managed.sessionManager.sessionId) return "no conversation";
    const state = managed.info.state;
    if (state === "stopped") return "stopped";
    if (!isQueueIdleState(state) && state !== "error") return "busy";
    if (managed.sessionManager.pendingTurn || flushRunning(managed))
      return "busy";
    if (managed.messageQueue.length > 0) return "messages queued";
    if (inMultiStepFlow(managed) || pendingPromptOf(managed) !== null)
      return "prompt pending";
    if (managed.autoHandoffPhase) return "automatic handoff";
    if (queueHeld(managed)) return "conversation change";
    return null;
  }

  // The pending resume is cleared before the send, whatever the outcome, so
  // a resume never repeats. The queue does the rest: it wakes a released
  // session, resumes an agent in the error state, and applies the member
  // usage cap.
  function fireLimitResume(agentId: string): void {
    const managed = agents.get(agentId);
    if (!managed || managed.limitResumeAt === null) return;
    if (limitResumeClock.now() < managed.limitResumeAt) {
      scheduleLimitResume(agentId, managed);
      return;
    }
    dropLimitResume(agentId, managed);
    const skip = limitResumeSkipReason(managed);
    const self = getAgentDisplay(agentId);
    if (skip || !self) {
      console.log(
        `Resume after usage limit skipped for ${agentId}: ${skip ?? "agent not found"}`,
      );
      return;
    }
    const result = enqueueMessage(agentId, {
      sender: {
        kind: "agent",
        agentId,
        agentName: self.name,
        roomName: self.roomName,
      },
      text: LIMIT_RESUME_TEXT,
      limitResume: true,
      // The resume continues the stopped turn, so it stays that turn's
      // members': no turn ran since (a busy state drops the resume).
      // turnMemberIds is not persisted, so a resume that fires after a
      // restart has none.
      limitResumeMemberIds: [...managed.info.turnMemberIds],
    });
    if (!result.ok)
      console.warn(
        `Resume after usage limit not delivered to ${agentId}: ${result.status} ${result.error}`,
      );
  }

  // Wake after a server restart (server/restart-wake.ts). The record is
  // written at once when a turn starts, so a crash a moment later finds it.
  function writeTurnsInFlight(): void {
    const store: Record<string, TurnInFlightRecord> = {};
    for (const [id, r] of wakesOwed) store[id] = r;
    for (const [id, r] of turnsInFlight) store[id] = r;
    try {
      saveTurnsInFlight(store, deps.turnsInFlightFile);
    } catch (err) {
      console.error(
        "Failed to persist turns in flight (a restart may not wake a cut turn):",
        errMessage(err),
      );
    }
  }

  // A new turn (beginTurn). It replaces the entry of the turn before, so the
  // mark of a woken turn does not carry over to the next one. Any turn drops
  // the agent's owed wake: the wake would speak of a turn that is over.
  function recordTurnStart(agentId: string, managed: ManagedAgent): void {
    const timer = turnRecordClearTimers.get(agentId);
    if (timer !== undefined) restartWakeClock.clearTimeout(timer);
    turnRecordClearTimers.delete(agentId);
    dropOwedRestartWake(agentId);
    turnsInFlight.set(agentId, {
      // Wall time: it orders the wakes at the next boot, in another process.
      since: Date.now(),
      ...(managed.flush.running?.restartWake
        ? { restartWake: true as const }
        : {}),
    });
    if (managed.flush.running) managed.flush.running.restartWake = false;
    writeTurnsInFlight();
  }

  // The agent left the busy states. The entry goes after a delay, and only if
  // the turn is over by then and the server is not stopping: when the server
  // stops, every backend dies at once and ends its turn, in either order with
  // the stop signal (server/server-stop.ts).
  function scheduleTurnRecordClear(agentId: string): void {
    if (!turnsInFlight.has(agentId)) return;
    const prev = turnRecordClearTimers.get(agentId);
    if (prev !== undefined) restartWakeClock.clearTimeout(prev);
    const timer = restartWakeClock.setTimeout(() => {
      turnRecordClearTimers.delete(agentId);
      if (isServerStopping()) return;
      const managed = agents.get(agentId);
      if (
        managed &&
        (managed.info.state === "thinking" ||
          managed.info.state === "tool_executing")
      )
        return;
      // The turn is not over (a permission prompt, or a Stop whose abort is
      // still draining), and its end may come with no further state change:
      // try again when it settles. Attach to the deferred; never replace it.
      const pending = managed?.sessionManager.pendingTurn;
      if (pending) {
        if (!watchedTurnEnds.has(pending.promise)) {
          watchedTurnEnds.add(pending.promise);
          const again = () => scheduleTurnRecordClear(agentId);
          pending.promise.then(again, again);
        }
        return;
      }
      if (turnsInFlight.delete(agentId)) writeTurnsInFlight();
    }, RESTART_WAKE_CLEAR_DELAY_MS);
    turnRecordClearTimers.set(agentId, timer);
  }

  function dropOwedRestartWake(agentId: string): boolean {
    const timer = restartWakeTimers.get(agentId);
    if (timer !== undefined) restartWakeClock.clearTimeout(timer);
    restartWakeTimers.delete(agentId);
    return wakesOwed.delete(agentId);
  }

  // kill(): the agent's entries go now.
  function forgetTurnRecord(agentId: string): void {
    const timer = turnRecordClearTimers.get(agentId);
    if (timer !== undefined) restartWakeClock.clearTimeout(timer);
    turnRecordClearTimers.delete(agentId);
    const owed = dropOwedRestartWake(agentId);
    if (turnsInFlight.delete(agentId) || owed) writeTurnsInFlight();
  }

  // Boot: plan the wakes from the previous boot's record. An agent with
  // queued messages gets its wake at once, so it joins the replay; the
  // others go out a few at a time.
  function restoreRestartWakes(): void {
    const raw = loadTurnsInFlightRaw(deps.turnsInFlightFile);
    const plan = planRestartWakes(raw, {
      exists: (id) => agents.has(id),
      resumable: (id) => {
        const m = agents.get(id);
        return !!m && pickAutoResumeSessionId(m) !== null;
      },
    });
    for (const { agentId, reason } of plan.drop) {
      console.log(`Restart wake skipped for ${agentId}: ${reason}`);
      // The woken turn was cut before its send landed: its wake is still in
      // the durable queue, and must not go out a second time.
      const managed = agents.get(agentId);
      if (reason !== "already woken" || !managed) continue;
      const kept = managed.messageQueue.filter((m) => !m.restartWake);
      if (kept.length === managed.messageQueue.length) continue;
      console.log(
        `Dropping the queued restart wake of ${agentId}: its turn was cut again`,
      );
      managed.messageQueue = kept;
      persistQueueState(agentId, managed);
    }
    for (const id of plan.wake)
      wakesOwed.set(id, raw[id] as TurnInFlightRecord);
    writeTurnsInFlight();
    let spread = 0;
    for (const id of plan.wake) {
      const managed = agents.get(id)!;
      if (managed.messageQueue.length > 0) {
        fireRestartWake(id);
        continue;
      }
      const timer = restartWakeClock.setTimeout(() => {
        restartWakeTimers.delete(id);
        fireRestartWake(id);
      }, restartWakeDelayMs(spread++));
      restartWakeTimers.set(id, timer);
    }
  }

  // Why an owed wake does not go out, or null when it does. Queued messages
  // are no reason: the wake joins them.
  function restartWakeSkipReason(managed: ManagedAgent): string | null {
    const state = managed.info.state;
    if (state === "stopped") return "stopped";
    if (!isQueueIdleState(state) && state !== "error") return "busy";
    if (managed.sessionManager.pendingTurn) return "busy";
    if (inMultiStepFlow(managed) || pendingPromptOf(managed) !== null)
      return "prompt pending";
    if (managed.autoHandoffPhase) return "automatic handoff";
    if (queueHeld(managed)) return "conversation change";
    // A wake from a boot that ended before the turn started is replayed.
    if (managed.messageQueue.some((m) => m.restartWake))
      return "already queued";
    return null;
  }

  // The owed entry goes when the wake is sent: from then on the wake is in
  // the durable queue, and the turn it starts carries the mark. A wake the
  // queue refuses stays owed, for the next boot.
  function fireRestartWake(agentId: string): void {
    if (!wakesOwed.has(agentId)) return;
    const managed = agents.get(agentId);
    const self = getAgentDisplay(agentId);
    const skip = managed ? restartWakeSkipReason(managed) : null;
    if (!managed || !self || skip) {
      dropOwedRestartWake(agentId);
      writeTurnsInFlight();
      console.log(
        `Restart wake skipped for ${agentId}: ${skip ?? "agent not found"}`,
      );
      return;
    }
    const result = enqueueMessage(agentId, {
      sender: {
        kind: "agent",
        agentId,
        agentName: self.name,
        roomName: self.roomName,
      },
      text: RESTART_WAKE_TEXT,
      restartWake: true,
    });
    if (!result.ok) {
      console.warn(
        `Restart wake not delivered to ${agentId}: ${result.status} ${result.error}`,
      );
      return;
    }
    dropOwedRestartWake(agentId);
    writeTurnsInFlight();
  }

  // Check-and-set with no await before it, so only one caller starts the
  // brief turn. briefStarted stays true until the phase goes.
  function startAutoHandoffBrief(agentId: string, managed: ManagedAgent): void {
    const phase = managed.autoHandoffPhase;
    if (!phase || phase.briefStarted) return;
    phase.briefStarted = true;
    void runAutoHandoff(agentId, managed, phase);
  }

  async function runAutoHandoff(
    agentId: string,
    managed: ManagedAgent,
    phase: AutoHandoffPhase,
  ): Promise<void> {
    if (!phase.manual)
      addLogEntry(agentId, "system", autoHandoffLine(phase, "writing"));
    const capture: NonNullable<ManagedAgent["autoHandoffCapture"]> = {
      chunks: [],
      status: null,
      limitStopped: false,
    };
    managed.autoHandoffCapture = capture;
    let threw = false;
    let temporary = false;
    try {
      // runAgentTurn calls beginTurn before its first await, so the agent is
      // busy before this function yields.
      await runAgentTurn(
        phase.manual
          ? {
              managed,
              sdkText: manualBriefText(phase.manual),
              memberIds: memberIdsOf(phase.manual.username),
              usageCapped: directInputCapped(phase.manual.username),
              usageCapUsername: phase.manual.username,
            }
          : {
              managed,
              sdkText: autoHandoffBriefPrompt(phase),
              memberIds: [],
              // No member sent it: capped as the agent's other input no
              // human sends, by its manager (usage-caps-design.md 3b).
              usageCapped: managerCapped(managed.info.userId),
            },
      );
    } catch (err) {
      threw = true;
      temporary = temporaryBriefTurnError(err);
      if (agents.has(agentId)) briefTurnFailure(agentId, managed, err);
    } finally {
      if (managed.autoHandoffCapture === capture)
        managed.autoHandoffCapture = null;
    }
    // A conversation boundary (/clear, resume, fork), a stop or a kill took
    // the phase: the member's action explains it.
    if (!agents.has(agentId) || managed.autoHandoffPhase !== phase) return;
    const brief = joinBriefChunks(managed.info.agentType, capture.chunks);
    if (
      threw ||
      capture.limitStopped ||
      capture.status !== "completed" ||
      !brief
    ) {
      failAutoHandoff(agentId, managed, phase, {
        temporary: temporary || capture.limitStopped,
      });
      return;
    }
    const result = await handoffBody(agentId, brief, phase);
    if (!agents.has(agentId)) return;
    if (!result.ok) {
      if (managed.autoHandoffPhase === phase)
        failAutoHandoff(agentId, managed, phase, {
          temporary: TEMPORARY_HANDOFF_ERRORS.has(result.error),
        });
      return;
    }
    // A typed /handoff records nothing, as a typed /clear does.
    if (phase.manual) return;
    recordAudit({
      actor: {
        kind: "auto_handoff",
        id: "auto-handoff",
        name: "auto-handoff",
        ...(managed.info.userId ? { ownerId: managed.info.userId } : {}),
      },
      operation: "agents.handoff",
      targets: [agentId],
      fields: [],
    });
  }

  // The brief turn's own errors, worded and stated as on a member's send.
  function briefTurnFailure(
    agentId: string,
    managed: ManagedAgent,
    err: unknown,
  ): void {
    // The swapper (stop, send-now, a settings change, a reset) owns the state.
    if (err instanceof SessionSwappedError) return;
    ownedTurnFailure(agentId, managed, err, {
      label: "auto-handoff brief",
      frame: (raw) => msg("systemEntries.genericError", { error: raw }),
    });
  }

  // The member's two lines, the old chat's ("writing") and the fresh chat's
  // first ("done"). Both name the limit that fired, so they give one reason.
  function autoHandoffLine(
    phase: AutoHandoffPhase & { manual?: undefined },
    which: "writing" | "done",
  ): LogMessage {
    const params = autoHandoffMeasureParams(phase.trigger);
    switch (phase.trigger.measure) {
      case "tokens":
        return which === "writing"
          ? msg("systemEntries.autoHandoff.writingTokens", params)
          : msg("systemEntries.autoHandoff.doneTokens", params);
      case "percent":
        return which === "writing"
          ? msg("systemEntries.autoHandoff.writingPercent", params)
          : msg("systemEntries.autoHandoff.donePercent", params);
      case "compaction":
        return which === "writing"
          ? msg("systemEntries.autoHandoff.writingCompaction", params)
          : msg("systemEntries.autoHandoff.doneCompaction", params);
    }
  }

  // handoffBody refusals that can pass later: the cap, a failed write, or
  // another handoff under way.
  const TEMPORARY_HANDOFF_ERRORS = new Set([
    "usage_cap",
    "persist_failed",
    "handoff_in_progress",
  ]);

  // A brief turn that could not run now: the next completed turn shows it
  // can, so the automatic attempt stays open.
  function temporaryBriefTurnError(err: unknown): boolean {
    return (
      err instanceof UsageCapError ||
      err instanceof ProviderCapacityError ||
      err instanceof BackendNotConfiguredError ||
      err instanceof AuthNeededError
    );
  }

  // No handoff: the conversation continues and the queue flushes to the old
  // session. A failed automatic attempt uses the conversation's attempt, so
  // the fullness notices come back; a failed /handoff leaves it. A temporary
  // failure leaves the automatic attempt open: the next completed turn above
  // the trigger arms it again (evaluateAutoHandoff).
  function failAutoHandoff(
    agentId: string,
    managed: ManagedAgent,
    phase: AutoHandoffPhase,
    opts: { temporary?: boolean } = {},
  ): void {
    managed.autoHandoffPhase = null;
    if (phase.manual) {
      addLogEntry(agentId, "system", msg("systemEntries.handoff.failed"));
    } else if (opts.temporary) {
      addLogEntry(agentId, "system", msg("systemEntries.autoHandoff.retry"));
    } else {
      managed.autoHandoffSpent = true;
      addLogEntry(agentId, "system", msg("systemEntries.autoHandoff.failed"));
      maybeEmitUiContextNotice(managed);
    }
    // After the phase goes, nothing else may be waiting for it: flush what
    // queued up behind it.
    requestFlush(agentId, "auto-handoff release");
  }

  return {
    requestHandoff,
    handoffWaiting,
    handoffInProgress,
    evaluateAutoHandoff,
    armAutoHandoffFromEdit,
    armLimitResume,
    dropLimitResume,
    restoreLimitResume,
    recordTurnStart,
    scheduleTurnRecordClear,
    forgetTurnRecord,
    restoreRestartWakes,
    startAutoHandoffBrief,
    autoHandoffLine,
  };
}
