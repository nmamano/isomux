// Per-agent session lifecycle: the BackendSession slot, its consumer, the
// per-turn deferred and the swap/abort bookkeeping, plus the operations that
// move an agent between sessions (install, close-and-drain, replace). One
// instance per managed agent, owned by `ManagedAgent.sessionManager`;
// agent-manager.ts calls the operations and reads the fields through
// getter-only views, so every write goes through this object.
//
// S2 of the SessionManager extraction (task 798922c1): the nine fields and
// these seven operations moved here verbatim from agent-manager.ts. The
// consumer loop (`runConsumer`) and backend dispatch (`createSession`) still
// live there and arrive through `SessionManagerDeps`. Behaviour-preserving:
// same events, same state transitions, same log lines, same timing.

import type { AgentInfo, AgentState } from "../shared/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import type { BackendSession } from "./backends/types.ts";
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
// (subprocess died without a proper error event) and runConsumer released
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
  // The persistent consumer loop (still in agent-manager for S2).
  runConsumer: (
    agentId: string,
    host: H,
    session: BackendSession,
  ) => Promise<void>;
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
// permanent office-visible wedge; runConsumer's bound-session guard already
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
    this.consumerPromise = this.deps.runConsumer(this.agentId, host, session);
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
}
