// Per-agent session lifecycle: the BackendSession slot, its consumer, the
// per-turn deferred and the swap/abort bookkeeping, plus the operations that
// move an agent between sessions (install, close-and-drain, replace, kill).
// One instance per managed agent, owned by `ManagedAgent.sessionManager`;
// agent-manager.ts calls the operations and reads the fields through
// getter-only views, so every write goes through this object.
//
// The process slot (task 082ab039) is one SessionSlot, and only the
// operations below move it:
//
//                 live            swapping           released        dead
//   install       refused         refused            -> live         refused
//   closeAndDrain -> released     waits, then runs   -> released     no-op
//   replaceWith   -> swapping     waits, then runs   -> swapping     closes it
//   kill          -> dead         -> dead            -> dead         -> dead
//   stream end    -> released     (no consumer of its own yet)  -   -
//   adoptSessionId: writes sessionId in every kind.
//
// A swap leaves swapping for live when it installed, for released
// ("unbuilt") when its rebuild failed, and stays dead when a kill came. It
// holds the lock until its caller's `after` returned, so the wire's
// sessionSwapping: false comes after those steps. The wire's `dormant` is a
// function of the slot: swapping with nothing installed, or released with a
// reason.
//
// A switching swap sets sessionId to its target as it starts, while the chat,
// the topic and the context reading on screen still belong to the
// conversation it leaves until `after` replays the target. A write about the
// chat on screen (a topic, typed or generated) goes to chatSessionId, which
// names that conversation; a durable log entry written during the drain goes
// to the target's transcript and shows in its replay.
//
// Known residual: a skill waiting on an edit-fork's swap runs after the fork's
// `after` steps, but can start before the fork's own turn (runAgentTurn runs
// after the swap). Messages are queued on that swap, so only skills are
// exposed.
//
// S2 of the SessionManager extraction (task 798922c1) moved the nine fields
// and the seven swap operations here verbatim from agent-manager.ts; S3 moved
// the consumer loop (`consume`). Backend dispatch (`createSession`) still
// lives there; the per-event work and the manager-only diagnostics the loop
// needs arrive through `SessionManagerDeps`. Behaviour-preserving: same
// events, same state transitions, same log lines, same timing.

import type {
  AgentInfo,
  AgentState,
  BackgroundTask,
  LogEntry,
} from "../shared/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import type {
  BackendSession,
  CommandRow,
  EnginePlugin,
  NormalizedEvent,
} from "./backends/types.ts";
import { msg, type LogText } from "../shared/i18n/log-message.ts";
import { errorText } from "./localized-error.ts";
import type { BackendFailureId } from "./backend-failure-text.ts";
import {
  backendStoppedDuringTurn,
  backendFailureMeta,
  humanizeBackendFailure,
  STREAM_ENDED_MID_TURN,
} from "./backend-failure-text.ts";
import {
  AuthNeededError,
  SessionSwappedError,
  TurnSupersededError,
  type AbortResult,
  type AgentEvent,
  type SwapReason,
} from "./internal-types.ts";
import { errMessage } from "../shared/errors.ts";

// Why the agent currently has no live subprocess, used only to word the wake
// message accurately: "idle" = demoted by the inactivity sweep; "boot" =
// lazy-restored on server (re)start; "fresh" = a blank conversation never
// backed by a subprocess (lazy spawn, or released by /clear) - its wake is
// silent because there is nothing to announce resuming; "stream-ended" = the
// backend's event stream ended on its own while the session was still bound
// (subprocess died without a proper error event) and the consumer released
// the dead session pointer. Null while live. In-memory only.
export type DormantReason =
  | "idle"
  | "boot"
  | "fresh"
  | "stream-ended"
  // Released because the secrets or variables in its scope changed.
  | "env"
  // A swap closed the process and could not build its replacement.
  | "unbuilt"
  | null;

// The reasons a caller may give when it releases a live process.
export type ReleaseReason = "idle" | "env" | "fresh";

// The agent's one process slot. Every install and teardown moves it, and
// nothing else writes it.
//   live: a bound process. envStale: an environment change waits for its
//     release.
//   swapping: a swap holds the lock, from before its close until its
//     caller's `after` returned. target: the conversation it installs (null:
//     fresh). switches: the swap changes the conversation (adopt), so a
//     message that arrives meanwhile is queued. chat: the conversation the
//     chat on screen belongs to (the one the swap leaves, until `after`
//     replays the target). installed: the replacement, once the drain ended.
//   released: no process. reason null: not dormant either (a bad cwd at
//     spawn, a failed restore install).
//   dead: killed. Terminal.
export type SessionSlot =
  | {
      kind: "live";
      session: BackendSession;
      consumer: Promise<void>;
      envStale: boolean;
    }
  | {
      kind: "swapping";
      target: string | null;
      switches: boolean;
      chat: string | null;
      installed: { session: BackendSession; consumer: Promise<void> } | null;
      settled: Promise<void>;
    }
  | { kind: "released"; reason: DormantReason }
  | { kind: "dead" };

// replaceWith's options. adopt: the swap switches the conversation, and
// sessionId becomes its target when the swap starts. after: runs after the
// install (or the failed rebuild), while the swap still holds the lock; not
// after a kill.
export interface SwapOptions {
  adopt?: boolean;
  after?: () => void;
}

// closeAndDrainSession's options.
export interface CloseOptions {
  // Why the process goes: the released slot's reason.
  reason: ReleaseReason;
  // Stamped onto the SessionSwappedError handed to the in-flight turn, so
  // catch sites can tell a deliberate settings-driven swap apart from other
  // swaps without racing any external state.
  swapReason?: SwapReason;
}

// The per-turn deferred record. `promise` is the same promise `resolve` /
// `reject` settle. Code that must wait for the in-flight turn to end ATTACHES
// to it (`pendingTurn.promise.catch(...)`) - it must NEVER replace this record
// with a delegating wrapper. The old wrap-and-wake pattern had a lost-wakeup
// hole: runAgentTurn's send-throw cleanup only fires when it still owns the
// installed record, so a wrapper parked around the original was orphaned
// forever, stranding flushInProgress and wedging all delivery for the agent.
// Attached waiters wake on any settle, from any settle site.
export interface PendingTurn {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

// The slice of the managed agent the lifecycle operations touch beyond the
// fields they own: the live-turn clock (cleared at install / close), the
// visible state and dormant flag, the idle clock, and the queue length the
// post-swap kick checks. ManagedAgent satisfies this structurally; unit tests
// build a ten-line host.
export interface SessionHost {
  readonly info: Readonly<
    Pick<AgentInfo, "state" | "dormant" | "backgroundTasks">
  >;
  turnStartedAt: number;
  lastNormalizedEventAt: number;
  busyTurnWatchdogObserved: boolean;
  toolCallTimestamps: { clear(): void };
  lastActiveAt: number;
  messageQueue: { readonly length: number };
  // The live process's plugin list; it goes with the process.
  reportedPlugins?: EnginePlugin[] | null;
  reportedSkills?: CommandRow[] | null;
  // The background work the next wake names as ended
  // (ManagedAgent.releasedBackgroundTasks).
  releasedBackgroundTasks?: BackgroundTask[] | null;
}

// The process died and took its background work with it. Keeps the list for
// the next wake, unless a release already did, before the caller clears the
// live one: the agent's record then saves what ended.
function keepEndedBackground(host: SessionHost): void {
  if (!host.releasedBackgroundTasks && host.info.backgroundTasks?.length)
    host.releasedBackgroundTasks = host.info.backgroundTasks;
}

// What the operations need from the manager. No behaviour hides here: each
// member is the manager function the moved lines already called.
export interface SessionManagerDeps<H extends SessionHost> {
  // officeState.updateAgent: the dormant / sessionSwapping flips.
  updateAgent: (agentId: string, changes: Partial<AgentInfo>) => OfficeEvent[];
  emit: (event: AgentEvent) => void;
  // `agents.get(agentId) === managed`: the killed-during-drain guard.
  isStillManaged: (host: H) => boolean;
  // Backend session assembly (permission bookkeeping, cwd and resume
  // preflight, session env, system prompt, backend dispatch): manager and
  // office state, so it stays in the manager. Synchronous on purpose - a
  // throw here must reach the caller before anything is closed (see
  // replaceWith).
  createSession: (host: H, resumeSessionId?: string) => BackendSession;
  // Whether `session` was built on the agent's current token. A token change
  // (access, privilege, manager) during a swap's drain makes the replacement
  // built before it stale: it has the old stop's tools and a revoked token.
  // Absent: every session counts as current.
  builtOnCurrentToken?: (host: H, session: BackendSession) => boolean;
  // The per-event work: state derivation, log entries, usage refresh, and the
  // turn_completed / error-event settle of pendingTurn (through this object).
  processNormalizedEvent: (agentId: string, ev: NormalizedEvent) => void;
  // The chat entries the consumer writes when a backend dies.
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
  ) => void;
  // Stream-error diagnostics over manager-only state, called by the error
  // branch in this order: whether this turn already needed sign-in (the
  // backend's auth_needed; the stream failure text is never sniffed), asked
  // first because the answer picks the turn's rejection (AuthNeededError) and
  // later the desk state; the pending fixed-cwd reset marker (has / delete /
  // clear the stale auto-resume state); and the Claude-only process-exit
  // hints (null for other engines).
  reconcilePendingFixedCwdReset: (host: H) => void;
  diagnoseProcessExitHints: (
    host: H,
    sessionId: string | null,
  ) => LogText | null;
  authNeededThisTurn: (host: H) => boolean;
  // Post-swap dead-turn normalization.
  updateState: (agentId: string, state: AgentState) => void;
  // Post-swap flush kick.
  requestFlush: (agentId: string, label: string) => void;
  // Read at every drain, so the manager's _testSetConsumerDrainTimeout seam
  // keeps working unchanged.
  getConsumerDrainTimeoutMs: () => number;
  logger: Pick<Console, "warn" | "error">;
  // The slot moved to released (a close or a dead stream): what the agent's
  // next session runs on may differ from what the closed one ran on. Must
  // not throw.
  released?: (host: H) => void;
}

// Upper bound on waiting for a closed session's consumer to drain. A
// BackendSession whose stream() never returns after close() (wedged
// subprocess / adapter bug) used to park closeAndDrainSession - and
// everything stacked behind it (abort's finally, abortPromise, a flushQueue
// parked on abortPromise) - FOREVER, wedging all message delivery for the
// agent. After this timeout we log loudly and proceed.
// KNOWN RISK, accepted deliberately: proceeding without a full drain means
// the wedged old subprocess may still hold the shared session .jsonl while
// a --resume replacement starts writing it (the drain-before-install
// rationale in the replaceSession header). A rare corrupted resume beats a
// permanent office-visible wedge; consume's bound-session guard already
// discards any late in-memory events from the zombie stream. BackendSession
// exposes no harder termination primitive than close() today - if adapters
// grow a hard-kill, the timeout path below should call it before
// proceeding. Test-overridable via _testSetConsumerDrainTimeout.
export const CONSUMER_DRAIN_TIMEOUT_MS = 15_000;

type Bound = { session: BackendSession; consumer: Promise<void> };
type SwappingSlot = Extract<SessionSlot, { kind: "swapping" }>;

export class SessionManager<H extends SessionHost = SessionHost> {
  private current: SessionSlot;
  // The conversation the agent resumes. It outlives the process: a released
  // agent resumes it at its next wake.
  private conversationId: string | null;
  // Per-turn deferred. sendMessage/executeSkill await this; the consumer
  // resolves it when the turn's `stream()` iterator ends at `result`. See
  // PendingTurn for the attach-never-replace rule.
  pendingTurn: PendingTurn | null = null;
  // Monotonic counter bumped by every control-plane action that cancels an
  // in-flight turn (abort, kill, replaceSession). runAgentTurn snapshots it
  // at entry - AFTER beginTurn flips state to thinking - and re-checks
  // after each await during notice assembly. Any change means a Stop or
  // session swap fired before send, so the pre-send turn
  // bails with SessionSwappedError instead of sending the stale prompt
  // into the (possibly swapped) session. The pre-send window between
  // beginTurn and createTurnDeferred is the only place plain `pendingTurn`
  // rejection can't cover, because pendingTurn isn't installed yet - this
  // counter fills that gap.
  turnCancelToken = 0;
  // The turnCancelToken value stamped by abort()'s bump - i.e.
  // `abortCancelToken === turnCancelToken` holds exactly when the LATEST
  // cancellation was user-initiated (Stop / Send-now). flushQueue's
  // SessionSwappedError handler uses this to keep quiet on an intentional
  // interrupt (a retry always follows) while still surfacing the
  // "will retry" system message for unexpected swaps (idle demotion,
  // out-of-band replaceSession), whose bumps advance turnCancelToken past
  // this stamp. Needed because `aborting` doesn't cover the pre-send
  // window: with no pendingTurn installed yet, abort() early-returns
  // before ever setting aborting=true. Init -1 so a never-aborted agent
  // can't accidentally equal token 0.
  abortCancelToken = -1;
  aborting = false;
  // Set while abort() is mid-flight (between session.close() and installSession of the
  // replacement). sendMessage awaits this so a follow-up message arriving in the gap
  // doesn't see session=null and amputate context by spinning up a fresh blank session.
  // Also serves as a partial swap-lock: serializes the most user-visible variant
  // (sendMessage-during-abort) of the broader concurrency hole where multiple swap
  // callers (newConversation/resume/editAgent/editMessage/`/clear`) can race and
  // orphan the loser's session. Don't remove without replacing.
  // Resolves with the initiating abort's outcome, which a joining abort reports
  // as its own. Never rejects.
  abortPromise: Promise<AbortResult> | null = null;
  // The explained backend-failure sentence the STREAM CONSUMER just wrote to
  // chat, held so the turn-owning caller's catch can recognize its own echo.
  //
  // One death produces two writes inside this one turn pipeline: the consumer
  // logs the failure and then rejects pendingTurn, and that rejection is
  // precisely what wakes sendMessage's / flushQueue's catch, which logs again.
  // Two identical explanations in a row read worse than the two raw ones did.
  // ONE-SHOT: the consumer sets it, the first caller catch consumes it and
  // stays quiet, and anything after that logs normally - so an unrelated later
  // error with the same text is never swallowed. Cleared at turn start too, so
  // it cannot survive into a different turn.
  // WHAT the last backend death was, not what it said: the orchestrator
  // compares this against its own classification to suppress a duplicate, and
  // the two writers can now be reading in two different languages
  // (internal-docs/i18n-loop.md, S7).
  lastBackendFailure: BackendFailureId | null = null;

  constructor(
    private readonly agentId: string,
    private readonly deps: SessionManagerDeps<H>,
    initialSessionId: string | null = null,
    // Why a new agent starts without a process (lazy spawn and boot).
    initialReason: DormantReason = null,
  ) {
    this.conversationId = initialSessionId;
    this.current = { kind: "released", reason: initialReason };
  }

  get slot(): SessionSlot {
    return this.current;
  }

  // The installed process: live, or installed by a swap that still runs its
  // caller's `after`.
  private bound(): Bound | null {
    const slot = this.current;
    if (slot.kind === "live") return slot;
    if (slot.kind === "swapping") return slot.installed;
    return null;
  }

  get session(): BackendSession | null {
    return this.bound()?.session ?? null;
  }

  // Persistent consumer loop iterating `session.stream()` for the session's
  // lifetime. Without this, task_notifications buffered between turns get
  // flushed one turn late.
  get consumerPromise(): Promise<void> | null {
    return this.bound()?.consumer ?? null;
  }

  get sessionId(): string | null {
    return this.conversationId;
  }

  // The conversation the chat on screen belongs to: sessionId, except while a
  // switching swap has not yet replayed its target.
  get chatSessionId(): string | null {
    const slot = this.current;
    return slot.kind === "swapping" && slot.switches
      ? slot.chat
      : this.conversationId;
  }

  get swapping(): boolean {
    return this.current.kind === "swapping";
  }

  // A swap that switches the conversation holds the lock: a message that
  // arrives meanwhile is queued for the conversation it installs.
  get swapSwitches(): boolean {
    return this.current.kind === "swapping" && this.current.switches;
  }

  // Why the agent has no process (the wake wording); null while it has one.
  get releasedReason(): DormantReason {
    return this.current.kind === "released" ? this.current.reason : null;
  }

  // An environment change waits for the live process's release.
  get envStale(): boolean {
    return this.current.kind === "live" && this.current.envStale;
  }

  // Marks the live process for a release; false when there is none.
  markEnvStale(): boolean {
    if (this.current.kind !== "live") return false;
    this.current.envStale = true;
    return true;
  }

  clearEnvStale(): void {
    if (this.current.kind === "live") this.current.envStale = false;
  }

  // Resolves once no swap holds the lock. A caller that must act with no swap
  // running re-checks `swapping` after it, in a loop: a new swap can start
  // between the resolve and the caller's next step.
  async swapSettled(): Promise<void> {
    while (this.current.kind === "swapping") await this.current.settled;
  }

  // The plain sessionId writes (system_init, a dropped conversation, a new
  // conversation, a restore that falls back to fresh).
  adoptSessionId(id: string | null): void {
    this.conversationId = id;
  }

  // The kill teardown: cancels the turn, closes the process and leaves the
  // slot dead. Returns the old consumer, for the caller's drain. A swap that
  // drains meanwhile finds the slot dead and closes its replacement.
  kill(_host: H): Promise<void> | null {
    // Any concurrent runAgentTurn that hasn't yet installed pendingTurn
    // (pre-send notice assembly) bails on its next await checkpoint instead
    // of calling session.send on a dying session.
    this.turnCancelToken++;
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    if (turn) {
      try {
        turn.reject(new Error("Agent killed."));
      } catch {}
    }
    const bound = this.bound();
    try {
      bound?.session.close();
    } catch {}
    this.current = { kind: "dead" };
    return bound?.consumer ?? null;
  }

  // The wire's dormant flag for the current slot.
  private dormantOnWire(): boolean {
    const slot = this.current;
    if (slot.kind === "swapping") return slot.installed === null;
    return slot.kind === "released" && slot.reason !== null;
  }

  private emitChanges(changes: Partial<AgentInfo>): void {
    for (const event of this.deps.updateAgent(this.agentId, changes))
      this.deps.emit(event);
  }

  turnIsLive(host: H): boolean {
    return (
      host.turnStartedAt > 0 &&
      (host.info.state === "thinking" || host.info.state === "tool_executing")
    );
  }

  clearLiveTurn(host: H): void {
    host.turnStartedAt = 0;
    host.lastNormalizedEventAt = 0;
    host.busyTurnWatchdogObserved = false;
    host.toolCallTimestamps.clear();
  }

  // Create the per-turn deferred that sendMessage / executeSkill await.
  // Resolved from processNormalizedEvent's `turn_completed` case - fires
  // when the backend signals end-of-turn (Claude: result message; Codex:
  // turn/completed). Backends MUST emit exactly one turn_completed per
  // send() for this contract to hold.
  createTurnDeferred(): Promise<void> {
    // A new turn starts, so whatever the last one died of is history and the
    // echo suppressor must not carry into it. Belt-and-braces - the caller
    // catch consumes the stamp already - but it bounds the lifetime to a turn.
    this.lastBackendFailure = null;
    // Any stale pending turn (shouldn't normally happen; agents are
    // state-gated to one turn at a time) gets rejected so awaiting callers
    // don't leak forever.
    const stale = this.pendingTurn;
    if (stale) {
      this.pendingTurn = null;
      try {
        stale.reject(new TurnSupersededError());
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
    // with a delegating wrapper - see PendingTurn for why replacement is
    // forbidden (lost-wakeup hole).
    this.pendingTurn = {
      promise,
      resolve,
      reject,
    };
    return promise;
  }

  // Install a freshly-created session and spawn its consumer. Only into a
  // released slot: a live process, a swap that holds the slot and a killed
  // agent refuse it, and the passed session is closed so no process outlives
  // the refusal. Returns whether it installed.
  installSession(host: H, session: BackendSession): boolean {
    if (this.current.kind !== "released") {
      try {
        session.close();
      } catch {}
      this.deps.logger.warn(
        `Agent ${this.agentId}: did not install a new session because the agent is ${this.current.kind}; closed the new session.`,
      );
      return false;
    }
    const live: Extract<SessionSlot, { kind: "live" }> = {
      kind: "live",
      session,
      consumer: Promise.resolve(),
      envStale: false,
    };
    this.current = live;
    this.bind(host, live);
    return true;
  }

  // The install steps shared by installSession and a swap. The slot already
  // holds `record`, so the consumer finds its session bound; bind starts the
  // consumer into it.
  private bind(host: H, record: Bound): void {
    // A lazy first-message wake installs the session after beginTurn has
    // already claimed the pre-send window; preserve that live turn. Every
    // replacement closes first (and the teardown clears), while an idle
    // install may safely discard residue.
    if (!this.turnIsLive(host)) this.clearLiveTurn(host);
    host.reportedPlugins = null;
    host.reportedSkills = null;
    record.consumer = this.consume(host, record.session);
    // Stamp activity + clear dormant in lockstep with the session going live, so
    // a just-woken agent isn't immediately re-demoted and `info.dormant` can
    // never disagree with the slot. Guarded so spawn / normal swaps (already
    // non-dormant) don't emit a redundant agent_updated. A new process has
    // the current secrets and variables: the live slot starts unmarked.
    host.lastActiveAt = Date.now();
    if (host.info.dormant) this.emitChanges({ dormant: this.dormantOnWire() });
  }

  // Persistent consumer. Runs for the session's lifetime, iterating `stream()`
  // once - the BackendSession contract is that stream() yields events for the
  // whole session and only returns when the session is closed/exhausted.
  // Per-turn boundaries are signalled via `turn_completed` NormalizedEvents,
  // which processNormalizedEvent uses to resolve `pendingTurn`.
  //
  // Bound to a specific session instance: returns when `this.session` is
  // swapped out (abort / resume / fork / etc.) - `session.close()` unblocks the
  // parked `stream()` generator.
  private async consume(host: H, boundSession: BackendSession): Promise<void> {
    try {
      for await (const ev of boundSession.stream()) {
        // After an abort/resume/fork the dying session may keep yielding
        // events for several seconds before its stream() generator finally
        // ends (the SDK's close() doesn't interrupt mid-chunk). We must keep
        // draining so the inner generator terminates, but we drop the events
        // - otherwise the user sees model output continuing after Ctrl+C.
        if (this.session !== boundSession) continue;
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
        //     turns don't double-count - we just lose the aborted turn from
        //     the running total. Acceptable for cost reporting.
        //   - system_text breadcrumbs from the adapter (e.g. "Codex interrupt
        //     failed: …") are dropped here, so the member only sees the
        //     orchestrator-level fallback message if the timeout path fires.
        //     Acceptable for debug UX.
        //   - tool_call events dropped here can make the matching tool_result
        //     miss its timestamp. Active-tool state is per turn and cleared at
        //     every terminal boundary, so the miss cannot leak into later
        //     observability or watchdog decisions.
        // steer_delivered also passes: the engine recorded a pushed steer in
        // the turn, so the model has it whatever the interrupt does, and the
        // queue must not send it again. background_tasks passes too: it is
        // the process's whole background list, not part of the cancelled
        // turn, and a dropped one would leave a stale count.
        if (
          this.aborting &&
          ev.kind !== "turn_completed" &&
          ev.kind !== "error" &&
          ev.kind !== "steer_delivered" &&
          ev.kind !== "background_tasks"
        )
          continue;
        this.deps.processNormalizedEvent(this.agentId, ev);
      }
      // CLEAN stream end while still bound (no throw, no swap, not aborting):
      // the backend's stream ended on its own - subprocess death the adapter
      // didn't surface as an error event. Two hazards if we just return:
      //   1. a still-owned pendingTurn never settles, permanently stranding
      //      every `await turn` waiter (sendMessage, a parked flushQueue);
      //   2. this.session keeps pointing at a corpse, so the next message
      //      sends into a dead session instead of waking a fresh one.
      // Settle any owned turn, release the pointer (dormant flip mirrors
      // closeAndDrainSession), and - ONLY in the no-owner/pre-send branch -
      // normalize the busy state back to waiting_for_response
      // (enqueueMessage treats thinking/tool_executing as busy and flushQueue
      // rejects non-idle states, so a stuck busy state with no owning caller
      // would strand queued messages forever). The mid-turn branch performs
      // NO state transition; see its comment. All guarded on still-bound +
      // still-alive so a replacement consumer or a killed agent is untouched.
      // No-op when adapters behave (they emit an error or a synthetic
      // turn_completed before ending the stream).
      if (
        this.deps.isStillManaged(host) &&
        this.current.kind === "live" &&
        this.current.session === boundSession &&
        !this.aborting
      ) {
        const turn = this.pendingTurn;
        this.clearLiveTurn(host);
        this.pendingTurn = null;
        this.current = { kind: "released", reason: "stream-ended" };
        host.reportedPlugins = null;
        host.reportedSkills = null;
        // Any turn still in its PRE-SEND window (notice assembly; no
        // pendingTurn installed) must bail at its next checkpoint rather than
        // send into whatever session exists by then - same mechanism
        // closeAndDrainSession uses. Harmless when a post-send turn existed
        // (it is settled via the rejection below).
        this.turnCancelToken++;
        // The background work died with the process.
        keepEndedBackground(host);
        this.emitChanges({
          dormant: this.dormantOnWire(),
          backgroundTasks: null,
        });
        this.deps.released?.(host);
        if (turn) {
          // Mid-turn death: settle the turn and let its OWNING caller's catch
          // (sendMessage / flushQueue) produce the normal loud error state.
          // Deliberately NO state transition here (review-pinned): a
          // synchronous flip to waiting_for_response would fire the queue
          // trigger and could start a replacement turn BEFORE the rejected
          // caller's continuation runs - which would then stamp state=error
          // over a live turn and interfere with its lifecycle. Queued items
          // stay durable and deliver after human recovery.
          try {
            turn.reject(new Error(STREAM_ENDED_MID_TURN));
          } catch {}
          // What the USER reads uses the shared death wording, so this
          // doesn't become a fourth inconsistent death surface. There is no
          // exit code or subtype on this path (the stream simply ended), so it
          // gets the generic line. The rejection text classifies as the same
          // death, so the owning caller's catch adds no second line.
          this.deps.addLogEntry(
            this.agentId,
            "error",
            backendStoppedDuringTurn(),
            {
              backendFailureRaw: STREAM_ENDED_MID_TURN,
            },
          );
          this.lastBackendFailure = "stopped-during-turn";
        } else {
          this.deps.logger.warn(
            `Agent ${this.agentId}: backend stream ended while idle; released the dead session (next message resumes).`,
          );
          if (
            host.info.state === "thinking" ||
            host.info.state === "tool_executing"
          ) {
            // No-owner window only (pre-send: busy state claimed, pendingTurn
            // not yet installed - no caller catch will ever reset the state):
            // normalize so the agent is reachable again. Fires the queue-flush
            // trigger when items are waiting, which wakes a fresh session via
            // the !session branch; the token bump above guarantees the dead
            // pre-send turn can't also send.
            this.deps.updateState(this.agentId, "waiting_for_response");
          }
        }
      }
    } catch (err) {
      if (this.aborting || this.session !== boundSession) {
        // Expected: abort() or a session swap closed us. The swap path
        // already nulled + rejected pendingTurn with SessionSwappedError.
        return;
      }

      const turn = this.pendingTurn;
      this.clearLiveTurn(host);
      this.pendingTurn = null;
      // The failed stream's process took its background work with it.
      keepEndedBackground(host);
      for (const event of this.deps.updateAgent(this.agentId, {
        backgroundTasks: null,
      }))
        this.deps.emit(event);
      // Asked before the rejection: the owning caller keeps the desk waiting
      // for a turn that needed sign-in (AuthNeededError).
      const authNeeded = this.deps.authNeededThisTurn(host);
      if (turn)
        turn.reject(authNeeded ? new AuthNeededError(errMessage(err)) : err);

      // A fresh fixed-cwd session can error before it ever
      // emits system_init (an out-of-band stream failure; the adapter normally
      // routes bootstrap failures through an empty-sessionId system_init, which the
      // handler reconciles). In that case neither system_init reconciliation path
      // runs, so honor the pending-reset marker here too: abandon the old thread's
      // id + logCache so the committed new cwd isn't left paired with the dead old
      // thread. No-op for the common error path (marker absent).
      this.deps.reconcilePendingFixedCwdReset(host);

      this.deps.logger.error(
        `Agent ${this.agentId} stream error:`,
        errMessage(err),
      );
      // TWO texts, on purpose. `rawLine` keeps the original bytes for the
      // metadata diagnostic, which keeps the backend's own wording. `errorLine`
      // is the same framing as a message each reader words, and is the only
      // one that reaches the chat. The suffix inside both is the backend's
      // text either way - only the wrapper is ours.
      const rawLine = `Stream error: ${errMessage(err)}`;
      const errorLine = msg("systemEntries.streamError", {
        error: errorText(err),
      });
      // Classified against the RAW backend message, not the
      // "Stream error: " wrapper - the wrapper is isomux's own framing and
      // would otherwise be pasted in front of the explanation. An UNRECOGNIZED
      // failure keeps the wrapper it has always had; only a classified one
      // replaces the whole line.
      const failure = humanizeBackendFailure(errMessage(err));
      const classified = failure.raw !== undefined;
      this.deps.addLogEntry(
        this.agentId,
        "error",
        classified ? failure.text : errorLine,
        classified
          ? backendFailureMeta({ ...failure, raw: rawLine })
          : undefined,
      );
      this.lastBackendFailure = failure.id;
      // The SDK's "process exited with code 1" is opaque; diagnose common causes.
      // The manager answers null for non-Claude agents (the diagnosis reads
      // CLAUDE_CONFIG_DIR/projects).
      const hints = this.deps.diagnoseProcessExitHints(host, this.sessionId);
      if (hints) this.deps.addLogEntry(this.agentId, "system", hints);
      // Same rationale as the "error"-event path in processNormalizedEvent:
      // a turn that needed sign-in is not an agent failure, so the desk waits
      // for the member instead of showing red.
      this.deps.updateState(
        this.agentId,
        authNeeded ? "waiting_for_response" : "error",
      );
    }
  }

  // Await a (possibly wedged) consumer with the bounded-drain policy above.
  // Returns true if the consumer drained, false on timeout. Never throws.
  async drainConsumerBounded(consumer: Promise<void>): Promise<boolean> {
    const timeoutMs = this.deps.getConsumerDrainTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        consumer.catch(() => {}),
        new Promise<void>((res) => {
          timer = setTimeout(() => {
            timedOut = true;
            res();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      this.deps.logger.error(
        `Agent ${this.agentId}: session consumer did not drain within ${timeoutMs}ms; ` +
          `proceeding without a full drain (the old subprocess may still be alive - ` +
          `see the .jsonl overlap note at CONSUMER_DRAIN_TIMEOUT_MS).`,
      );
    }
    return !timedOut;
  }

  // Close the agent's live session and drain its consumer, leaving it dormant
  // (released with `opts.reason`, no subprocess). Used by demoteToLazy, the
  // environment and account releases and newConversation. A swap that holds
  // the slot is waited for first, so the release runs against what the swap
  // installed; with no swap running, everything up to the drain runs
  // synchronously. Bumps turnCancelToken so any concurrent pre-send turn
  // bails, rejects the in-flight turn, sets info.dormant in lockstep with the
  // slot, and awaits the old consumer (with the bounded-drain policy above)
  // so the dying subprocess never overlaps whatever installs next. CALLERS
  // MUST NOT mutate session-related state after this resolves without
  // re-checking - a message arriving during the drain await may already have
  // woken a fresh session via flushQueue.
  async closeAndDrainSession(host: H, opts: CloseOptions): Promise<void> {
    while (this.current.kind === "swapping") await this.current.settled;
    if (this.current.kind === "dead") return;
    const oldConsumer = this.teardown(host, this.bound(), opts.swapReason);
    this.current = { kind: "released", reason: opts.reason };
    // The closed process takes its background work with it.
    this.emitChanges({ dormant: this.dormantOnWire(), backgroundTasks: null });
    this.deps.released?.(host);
    if (oldConsumer) await this.drainConsumerBounded(oldConsumer);
  }

  // The close steps shared by a release and a swap: cancel the turn, close
  // `bound`'s process. Returns its consumer, for the caller's drain. The
  // caller moves the slot.
  private teardown(
    host: H,
    bound: Bound | null,
    swapReason?: SwapReason,
  ): Promise<void> | null {
    this.clearLiveTurn(host);
    this.turnCancelToken++;
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    if (turn) {
      try {
        turn.reject(new SessionSwappedError(undefined, swapReason));
      } catch {}
    }
    try {
      bound?.session.close();
    } catch {}
    host.reportedPlugins = null;
    host.reportedSkills = null;
    return bound?.consumer ?? null;
  }

  // Swap the agent's session: close the current one, await its consumer to
  // drain, install the new session + consumer. Rejects any in-flight turn so
  // callers awaiting sendMessage's deferred don't hang.
  //
  // IMPORTANT - drain-before-install is load-bearing. Switching to swap-then-
  // drain (install new synchronously, drain old in background) is tempting
  // because it would let follow-up messages typed after Ctrl+C reach the LLM
  // without waiting ~3s for the old session to drain. Don't do it without
  // first verifying there's no on-disk race on the shared sessionId .jsonl
  // between the dying-old and starting-new subprocesses - both write to the
  // same file when the new session is created with --resume. See task
  // 154e2c14's STILL OPEN section for context. The current sendMessage
  // papers over the user-visible delay by echoing the typed message to the
  // log before awaiting abortPromise (see echoEarly there).
  // Callers go through replaceWith below, which builds the replacement first.
  private async replaceSession(
    host: H,
    newSession: BackendSession,
    target: string | null,
    // Passed through to the teardown - see CloseOptions.swapReason.
    swapReason: SwapReason | undefined,
    // Builds the replacement again, for one gone stale during the drain.
    rebuild: () => BackendSession,
    opts: SwapOptions,
  ): Promise<void> {
    // /resume, /model, /effort, edit-fork, abort's slow path,
    // setPrivileged, and the queue watchdog's forced recovery all funnel
    // through here. A swap holds the slot from its close until its caller's
    // `after` returned, so nothing else installs during the drain: a wake
    // waits for the swap (sendMessage, executeSkill) or defers to its
    // post-swap flush kick (flushQueue), and a second swap or a release waits
    // for it here. Only a kill preempts it.
    while (this.current.kind === "swapping") await this.current.settled;
    if (this.current.kind === "dead") {
      try {
        newSession.close();
      } catch {}
      return;
    }
    let settle!: () => void;
    const swap: SwappingSlot = {
      kind: "swapping",
      target,
      switches: opts.adopt === true,
      chat: this.conversationId,
      installed: null,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    const old = this.bound();
    this.current = swap;
    // A swap that switches the conversation adopts it as it starts: a
    // rebuild that fails still resumes the pick at the next wake.
    if (opts.adopt) this.conversationId = target;
    this.emitChanges({ sessionSwapping: true });
    // The teardown bumps the cancel token (covers concurrent pre-send turns)
    // and the slot goes dormant until the install; sessionSwapping covers
    // the UI for the ~3s drain window.
    const oldConsumer = this.teardown(host, old, swapReason);
    this.emitChanges({ dormant: this.dormantOnWire(), backgroundTasks: null });
    let installedByUs = false;
    let afterFailed: { err: unknown } | null = null;
    try {
      if (oldConsumer) await this.drainConsumerBounded(oldConsumer);
      // A kill that lands during the drain leaves the slot dead: close the
      // replacement instead of installing it on the killed agent, which would
      // leak its subprocess and its consumer (task 3e8482e2).
      if (this.current !== swap) {
        try {
          newSession.close();
        } catch {}
      } else {
        const replacement = this.currentReplacement(host, newSession, rebuild);
        if (replacement) {
          const installed: Bound = {
            session: replacement,
            consumer: Promise.resolve(),
          };
          swap.installed = installed;
          this.bind(host, installed);
          installedByUs = true;
        }
        // The caller's steps run when the rebuild failed too: the swap still
        // switched the conversation, and the next wake resumes it. They
        // replay the target, so the chat on screen is the target's from here.
        swap.chat = target;
        try {
          opts.after?.();
        } catch (err) {
          afterFailed = { err };
        }
      }
    } finally {
      if (this.current === swap) {
        this.current = swap.installed
          ? {
              kind: "live",
              session: swap.installed.session,
              consumer: swap.installed.consumer,
              envStale: false,
            }
          : { kind: "released", reason: "unbuilt" };
      }
      this.emitChanges({ sessionSwapping: false });
      settle();
    }
    // Killed during the drain (`after` did not run). The getter, not the
    // field: the slot moved during the awaits above.
    if (this.slot.kind === "dead" || !this.deps.isStillManaged(host)) return;
    // Post-swap dead-turn normalization: only when WE installed, any pre-swap
    // turn is provably dead (the teardown rejected or token-cancelled it), so
    // a lingering busy state is a lie - unless a send claimed a new turn
    // during the drain and waits for this swap to send it (turnIsLive: the
    // teardown cleared the dead turn's clock, and that send set a new one).
    // Out-of-band swaps (setPrivileged, /model, /effort) used to strand the
    // agent visibly "thinking" forever here.
    if (
      installedByUs &&
      !this.pendingTurn &&
      !this.turnIsLive(host) &&
      (host.info.state === "thinking" || host.info.state === "tool_executing")
    ) {
      this.deps.updateState(this.agentId, "waiting_for_response");
    }
    // Post-swap flush kick: a flush cancelled pre-send by this
    // swap left its items queued, and a wake that deferred to us (the
    // sessionSwapping guard) never happened - neither gets retried by a state
    // transition when the agent was already idle, so kick explicitly.
    // requestFlush owns every guard.
    this.deps.requestFlush(this.agentId, "post-swap");
    if (afterFailed) throw afterFailed.err;
  }
  // The replacement to install after the drain: `built`, or a new one when the
  // token changed during the drain (builtOnCurrentToken). Null when the
  // rebuild throws: the agent stays without a session, and its next message
  // starts one on the current token.
  private currentReplacement(
    host: H,
    built: BackendSession,
    rebuild: () => BackendSession,
  ): BackendSession | null {
    if (this.deps.builtOnCurrentToken?.(host, built) ?? true) return built;
    try {
      built.close();
    } catch {}
    try {
      return rebuild();
    } catch (err) {
      this.deps.logger.error(
        `Agent ${this.agentId}: could not rebuild the swap's replacement on the current token:`,
        errMessage(err),
      );
      return null;
    }
  }

  // Every replacement caller's entry point: build the replacement first, then
  // run replaceSession. Deliberately NOT async - the create runs synchronously,
  // and a throw from it (invalid cwd, failed resume preflight, broken env)
  // reaches the caller as a synchronous throw with the old session still
  // bound, the pending turn unsettled and nothing closed, exactly as the
  // former `replaceSession(host, createSession(...))` call sites behaved (the
  // edit path in agent-manager documents the contract: a synchronous create
  // throw rolls back with the old session standing). An async wrapper would
  // turn that throw into a rejected promise and add an event-loop yield
  // before the caller's catch runs (ruling 9).
  // opts.adopt: the swap switches the conversation to `resumeSessionId`
  // (sessionId follows it as the swap starts). opts.after: the caller's steps
  // on the installed session (chat replay, topic, state), run while the swap
  // still holds the slot; a throw from it rejects this promise.
  replaceWith(
    host: H,
    resumeSessionId?: string | null,
    swapReason?: SwapReason,
    opts: SwapOptions = {},
  ): Promise<void> {
    const target = resumeSessionId ?? null;
    const build = () => this.deps.createSession(host, target ?? undefined);
    return this.replaceSession(host, build(), target, swapReason, build, opts);
  }
}
