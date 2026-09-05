// Per-agent session lifecycle: the BackendSession slot, its consumer, the
// per-turn deferred and the swap/abort bookkeeping, plus the operations that
// move an agent between sessions (install, close-and-drain, replace). One
// instance per managed agent, owned by `ManagedAgent.sessionManager`;
// agent-manager.ts calls the operations and reads the fields through
// getter-only views, so every write goes through this object.
//
// S2 of the SessionManager extraction (task 798922c1) moved the nine fields
// and the seven swap operations here verbatim from agent-manager.ts; S3 moved
// the consumer loop (`consume`). Backend dispatch (`createSession`) still
// lives there; the per-event work and the manager-only diagnostics the loop
// needs arrive through `SessionManagerDeps`. Behaviour-preserving: same
// events, same state transitions, same log lines, same timing.

import type { AgentInfo, AgentState, LogEntry } from "../shared/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import type { BackendSession, NormalizedEvent } from "./backends/types.ts";
import {
  BACKEND_STOPPED_DURING_TURN,
  backendFailureMeta,
  humanizeBackendFailure,
} from "./backend-failure-text.ts";
import {
  SessionSwappedError,
  TurnSupersededError,
  type AgentEvent,
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
export type DormantReason = "idle" | "boot" | "fresh" | "stream-ended" | null;

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
  readonly info: Readonly<Pick<AgentInfo, "state" | "dormant">>;
  turnStartedAt: number;
  lastNormalizedEventAt: number;
  busyTurnWatchdogObserved: boolean;
  toolCallTimestamps: { clear(): void };
  lastActiveAt: number;
  dormantReason: DormantReason;
  messageQueue: { readonly length: number };
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
  // The per-event work: state derivation, log entries, usage refresh, and the
  // turn_completed / error-event settle of pendingTurn (through this object).
  processNormalizedEvent: (agentId: string, ev: NormalizedEvent) => void;
  // The chat entries the consumer writes when a backend dies.
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: string,
    metadata?: Record<string, unknown>,
  ) => void;
  // Stream-error diagnostics over manager-only state, called by the error
  // branch in this order: the pending fixed-cwd reset marker (has / delete /
  // clear the stale auto-resume state), the Claude-only process-exit hints
  // (null for other engines), and auth detection (emits the login
  // instructions when true and returns the classification for updateState).
  reconcilePendingFixedCwdReset: (host: H) => void;
  diagnoseProcessExitHints: (
    host: H,
    sessionId: string | null,
  ) => string | null;
  handleDetectedAuthError: (host: H, errorText: string) => boolean;
  // Post-swap dead-turn normalization.
  updateState: (agentId: string, state: AgentState) => void;
  // Post-swap flush kick.
  flushQueue: (agentId: string) => Promise<void>;
  // Read at every drain, so the manager's _testSetConsumerDrainTimeout seam
  // keeps working unchanged.
  getConsumerDrainTimeoutMs: () => number;
  logger: Pick<Console, "warn" | "error">;
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

export class SessionManager<H extends SessionHost = SessionHost> {
  session: BackendSession | null = null;
  sessionId: string | null;
  // Persistent consumer loop iterating `session.stream()` for the session's
  // lifetime. Without this, task_notifications buffered between turns get
  // flushed one turn late.
  consumerPromise: Promise<void> | null = null;
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
  abortPromise: Promise<void> | null = null;
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
  lastBackendFailure: string | null = null;

  constructor(
    private readonly agentId: string,
    private readonly deps: SessionManagerDeps<H>,
    initialSessionId: string | null = null,
  ) {
    this.sessionId = initialSessionId;
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

  // Install a freshly-created session and spawn its consumer. Caller is
  // responsible for having closed/awaited any previous session first.
  installSession(host: H, session: BackendSession): void {
    // A lazy first-message wake installs the session after beginTurn has
    // already claimed the pre-send window; preserve that live turn. Every
    // replacement closes first (and closeAndDrainSession clears), while an
    // idle install may safely discard residue.
    if (!this.turnIsLive(host)) this.clearLiveTurn(host);
    this.session = session;
    this.consumerPromise = this.consume(host, session);
    // Stamp activity + clear dormant in lockstep with the session going live, so
    // a just-woken agent isn't immediately re-demoted and `info.dormant` can
    // never disagree with `session !== null`. Guarded so spawn / normal swaps
    // (already non-dormant) don't emit a redundant agent_updated.
    host.lastActiveAt = Date.now();
    host.dormantReason = null;
    if (host.info.dormant) {
      for (const event of this.deps.updateAgent(this.agentId, {
        dormant: false,
      }))
        this.deps.emit(event);
    }
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
        //     failed: …") are dropped here, so the user only sees the
        //     orchestrator-level fallback message if the timeout path fires.
        //     Acceptable for debug UX.
        //   - tool_call events dropped here can make the matching tool_result
        //     miss its timestamp. Active-tool state is per turn and cleared at
        //     every terminal boundary, so the miss cannot leak into later
        //     observability or watchdog decisions.
        if (
          this.aborting &&
          ev.kind !== "turn_completed" &&
          ev.kind !== "error"
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
        this.session === boundSession &&
        !this.aborting
      ) {
        const turn = this.pendingTurn;
        this.clearLiveTurn(host);
        this.pendingTurn = null;
        this.session = null;
        this.consumerPromise = null;
        host.dormantReason = "stream-ended";
        // Any turn still in its PRE-SEND window (notice assembly; no
        // pendingTurn installed) must bail at its next checkpoint rather than
        // send into whatever session exists by then - same mechanism
        // closeAndDrainSession uses. Harmless when a post-send turn existed
        // (it is settled via the rejection below).
        this.turnCancelToken++;
        for (const event of this.deps.updateAgent(this.agentId, {
          dormant: true,
        }))
          this.deps.emit(event);
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
            turn.reject(
              new Error("Backend stream ended unexpectedly mid-turn."),
            );
          } catch {}
          // The rejection text above stays raw - it is an internal Error that
          // callers log to the console. What the USER reads uses the shared
          // death wording, so this doesn't become a fourth
          // inconsistent death surface. There is no exit code or subtype on
          // this path (the stream simply ended), so it gets the generic line.
          this.deps.addLogEntry(
            this.agentId,
            "error",
            BACKEND_STOPPED_DURING_TURN,
            {
              backendFailureRaw: "Backend stream ended unexpectedly mid-turn.",
            },
          );
          this.lastBackendFailure = BACKEND_STOPPED_DURING_TURN;
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
      if (turn) turn.reject(err);

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
      const errorText = `Stream error: ${errMessage(err)}`;
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
        classified ? failure.text : errorText,
        classified
          ? backendFailureMeta({ text: failure.text, raw: errorText })
          : undefined,
      );
      this.lastBackendFailure = classified ? failure.text : errorText;
      // The SDK's "process exited with code 1" is opaque; diagnose common causes.
      // The manager answers null for non-Claude agents (the diagnosis reads
      // CLAUDE_CONFIG_DIR/projects).
      const hints = this.deps.diagnoseProcessExitHints(host, this.sessionId);
      if (hints) this.deps.addLogEntry(this.agentId, "system", hints);
      // Same rationale as the "error"-event path in processNormalizedEvent:
      // auth errors aren't agent failures, surface them as
      // waiting_for_response to match the (rare)
      // bundled-codex-binary-doesn't-resolve case in
      // surfaceBackendNotConfigured, and avoid an erroneous red-desk signal.
      const isAuthError = this.deps.handleDetectedAuthError(host, errorText);
      this.deps.updateState(
        this.agentId,
        isAuthError ? "waiting_for_response" : "error",
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
  // (session === null, no subprocess). Shared by replaceSession (installs a
  // replacement right after) and demoteToLazy (doesn't). Bumps turnCancelToken
  // so any concurrent pre-send turn bails, rejects the in-flight turn, sets
  // info.dormant in lockstep with session, and awaits the old consumer (with
  // the bounded-drain policy above) so the dying subprocess never overlaps
  // whatever installs next. CALLERS MUST NOT
  // mutate session-related state after this resolves without re-checking - a
  // message arriving during the drain await may already have woken a fresh
  // session via flushQueue.
  async closeAndDrainSession(
    host: H,
    // Stamped onto the SessionSwappedError handed to the in-flight turn, so
    // catch sites can tell a deliberate settings-driven swap apart from other
    // swaps without racing any external state.
    swapReason?: "settings",
  ): Promise<void> {
    this.clearLiveTurn(host);
    this.turnCancelToken++;
    const oldConsumer = this.consumerPromise;
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    if (turn) {
      try {
        turn.reject(new SessionSwappedError(undefined, swapReason));
      } catch {}
    }
    try {
      this.session?.close();
    } catch {}
    this.session = null;
    this.consumerPromise = null;
    for (const event of this.deps.updateAgent(this.agentId, { dormant: true }))
      this.deps.emit(event);
    if (oldConsumer) {
      await this.drainConsumerBounded(oldConsumer);
    }
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
  // Public for one external caller: the typed /clear path (command-handlers)
  // hands in a session it built itself, because its pending-control and queue
  // bookkeeping must run between create and swap. Every other swap goes
  // through replaceWith below.
  async replaceSession(
    host: H,
    newSession: BackendSession,
    // Passed through to closeAndDrainSession - see its swapReason note.
    swapReason?: "settings",
  ): Promise<void> {
    // /clear, /resume, /model, /effort, edit-fork, abort's slow path,
    // setPrivileged, and the queue watchdog's forced recovery all funnel
    // through here. closeAndDrainSession bumps the
    // cancel token (covers concurrent pre-send turns, same as before) and flips
    // dormant=true; installSession flips it back. The transient dormant blip is
    // invisible (v1 renders no badge) and sessionSwapping already covers the UI
    // for the ~3s drain window.
    let installedByUs = false;
    for (const event of this.deps.updateAgent(this.agentId, {
      sessionSwapping: true,
    }))
      this.deps.emit(event);
    try {
      await this.closeAndDrainSession(host, swapReason);
      // During the drain await the
      // session slot is null, and a concurrent installer can legitimately win
      // it - flushQueue's wake branch defers to us via its sessionSwapping
      // guard, but sendMessage's wakeSessionForSend does not. If someone won,
      // do NOT clobber their live session (the old behavior left their
      // in-flight turn sending into a foreign session); close our
      // never-installed replacement instead. Residual race for callers that
      // need THEIR specific session installed (/resume pick, edit-fork): the
      // concurrent wake now wins and the pick no-ops - rarer and safer than
      // cross-thread delivery.
      if (this.session === null) {
        this.installSession(host, newSession);
        installedByUs = true;
      } else {
        try {
          newSession.close();
        } catch {}
        this.deps.logger.warn(
          `Agent ${this.agentId}: a concurrent wake installed a session during the swap drain; keeping it and discarding the replacement.`,
        );
      }
    } finally {
      for (const event of this.deps.updateAgent(this.agentId, {
        sessionSwapping: false,
      }))
        this.deps.emit(event);
    }
    // PARKED FOR NIL (task 3e8482e2): a kill that lands during the drain
    // above nulls the slot and drops the record, so the install just ran on
    // the orphaned object and this guard only skips the normalization below.
    // Preserve this order exactly until the fix slice (ruling 7).
    if (!this.deps.isStillManaged(host)) return; // killed during the drain
    // Post-swap dead-turn normalization: only when WE
    // installed (atomic with the null-check above - no await between), any
    // pre-swap turn is provably dead (closeAndDrainSession rejected or
    // token-cancelled it) and no new turn can exist (a wake would have
    // installed a session, contradicting ownership), so a lingering busy
    // state is a lie. Out-of-band swaps (setPrivileged, /model, /effort)
    // used to strand the agent visibly "thinking" forever here.
    if (
      installedByUs &&
      !this.pendingTurn &&
      (host.info.state === "thinking" || host.info.state === "tool_executing")
    ) {
      this.deps.updateState(this.agentId, "waiting_for_response");
    }
    // Post-swap flush kick: a flush cancelled pre-send by this
    // swap left its items queued, and a wake that deferred to us (the
    // sessionSwapping guard) never happened - neither gets retried by a state
    // transition when the agent was already idle, so kick explicitly.
    // flushQueue re-checks state/queue/flow/flushInProgress itself.
    if (host.messageQueue.length > 0) {
      this.deps.flushQueue(this.agentId).catch((err: unknown) => {
        this.deps.logger.error(
          `flushQueue (post-swap) failed for ${this.agentId}:`,
          errMessage(err),
        );
      });
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
  replaceWith(
    host: H,
    resumeSessionId?: string | null,
    swapReason?: "settings",
  ): Promise<void> {
    const newSession = this.deps.createSession(
      host,
      resumeSessionId ?? undefined,
    );
    return this.replaceSession(host, newSession, swapReason);
  }
}
