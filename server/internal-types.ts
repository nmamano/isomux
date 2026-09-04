import type {
  AgentInfo,
  AgentChoiceInteraction,
  KilledAgentSummary,
  LogEntry,
  PendingPromptKind,
  QueuedMessage,
  SkillInfo,
  SlideFailureReason,
  SlideRecord,
  SubscriptionUsageWire,
} from "../shared/types.ts";
import type { BackendSession } from "./backends/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";

// A committed context-fullness sample (design: internal-docs/
// context-fullness-visibility.md). Window occupancy of the CURRENT
// conversation - prompt size of the last turn vs the model's window - NOT
// cumulative usage accounting (that lives in sessions.json via
// accumulateSessionUsage; keep the two separate). `model` labels the window
// the sample was measured against, so a stale pre-model-swap sample can't get
// relabeled by the agent's current model. `percentage` is the backend's raw
// float (0..100), never a rounded display value.
export interface ContextUsageSnapshot {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  sampledAtMs: number;
  source: "turn_completed" | "usage_update" | "on_demand";
}

// Internal agent state
export interface ManagedAgent {
  // Readonly to enforce that AgentInfo mutation goes through OfficeState
  // (officeState.updateAgent / setTopic / etc.). The shared-reference
  // invariant means OfficeState's mutations land here automatically.
  // The single legitimate escape hatch is `withAgentRollback` in
  // agent-manager, which casts to mutate before a side effect that may need
  // to revert the change.
  readonly info: Readonly<AgentInfo>;
  session: BackendSession | null;
  sessionId: string | null;
  // Persistent consumer loop iterating `session.stream()` for the session's
  // lifetime. Without this, task_notifications buffered between turns get
  // flushed one turn late.
  consumerPromise: Promise<void> | null;
  // Per-turn deferred. sendMessage/executeSkill await this; the consumer
  // resolves it when the turn's `stream()` iterator ends at `result`.
  // `promise` is the same promise `resolve`/`reject` settle. Code that must
  // wait for the in-flight turn to end ATTACHES to it
  // (`pendingTurn.promise.catch(...)`) - it must NEVER replace this record
  // with a delegating wrapper. The old wrap-and-wake pattern had a lost-wakeup
  // hole (task da065287): runAgentTurn's send-throw cleanup only fires when it
  // still owns the installed record, so a wrapper parked around the original
  // was orphaned forever, stranding flushInProgress and wedging all delivery
  // for the agent. Attached waiters wake on any settle, from any settle site.
  pendingTurn: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
    // The user_message entry id anchoring this in-flight turn (the newest deck
    // turn), or null when the turn has no anchor at all. Slide Mode reads it to
    // gate slide generation: a turn is "terminal" once it is no longer this
    // anchor (pendingTurn cleared, or superseded by a newer turn). Filled from
    // two directions, because the anchor is logged on either side of the deferred
    // depending on the path: createTurnDeferred CLAIMS nextTurnAnchorEntryId
    // (every path that logs the user_message before the send), and addLogEntry
    // stamps it directly when the message is logged while the turn already runs
    // (the queued flush, which logs from onSendAccepted). Goes away when
    // pendingTurn is nulled at turn_completed. See server/slide-mode.ts +
    // slide-mode-design.md.
    anchorEntryId: string | null;
  } | null;
  // The user_message entry id logged for a turn whose deferred is not installed
  // yet - sendMessage / executeSkill / editMessage all log the anchor and only
  // then reach runAgentTurn. createTurnDeferred claims it (and clears it, so it
  // is claimed at most once) as the turn's anchorEntryId. Without this the
  // direct-send paths ran with a null anchor, every turn read TERMINAL while it
  // was still streaming, and Slide Mode wrote an empty-turn placeholder for the
  // live turn (task e9429ef3).
  nextTurnAnchorEntryId: string | null;
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
  turnCancelToken: number;
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
  abortCancelToken: number;
  aborting: boolean;
  // The explained backend-failure sentence the STREAM CONSUMER just wrote to
  // chat, held so the turn-owning caller's catch can recognize its own echo
  // (tasks 86678675 / e8168c2a).
  //
  // One death produces two writes inside this one turn pipeline: the consumer
  // logs the failure and then rejects pendingTurn, and that rejection is
  // precisely what wakes sendMessage's / flushQueue's catch, which logs again.
  // Two identical explanations in a row read worse than the two raw ones did.
  // ONE-SHOT: the consumer sets it, the first caller catch consumes it and
  // stays quiet, and anything after that logs normally - so an unrelated later
  // error with the same text is never swallowed. Cleared at turn start too, so
  // it cannot survive into a different turn.
  lastBackendFailure: string | null;
  // Set while abort() is mid-flight (between session.close() and installSession of the
  // replacement). sendMessage awaits this so a follow-up message arriving in the gap
  // doesn't see session=null and amputate context by spinning up a fresh blank session.
  // Also serves as a partial swap-lock: serializes the most user-visible variant
  // (sendMessage-during-abort) of the broader concurrency hole where multiple swap
  // callers (newConversation/resume/editAgent/editMessage/`/clear`) can race and
  // orphan the loser's session. See task 154e2c14. Don't remove without replacing.
  abortPromise: Promise<void> | null;
  slashCommands: {
    name: string;
    description?: string;
    aliasFor?: string;
    autoRun?: boolean;
  }[];
  skills: SkillInfo[];
  sdkReportedCommands: string[]; // commands reported by SDK in system:init
  // Timing: track when phases start for duration_ms computation
  thinkingStartedAt: number;
  // Live turn timing. These are in-memory only and reset on every terminal
  // boundary/session install. `lastNormalizedEventAt` is the watchdog's
  // quiescence clock; before the first event it falls back to turnStartedAt.
  turnStartedAt: number;
  lastNormalizedEventAt: number;
  // Prevent a warn-only watchdog signature from writing every sweep. Reset
  // with the rest of the live turn state.
  busyTurnWatchdogObserved: boolean;
  // Per-turn active tools. The value includes the display name so the logs API
  // can describe the oldest active call without re-reading the transcript.
  toolCallTimestamps: Map<string, { name: string; startedAt: number }>;
  // Topic generation
  topicGenerating: boolean;
  topicMessageCount: number; // text entry count when topic was last generated
  // Bumped by any path that resets the conversation (/clear, /resume, fork,
  // newConversation). generateTopic captures this at start and discards the
  // result if it changed during the await - otherwise an in-flight LLM call
  // would stomp on the cleared state when it finally returns.
  topicGenToken: number;
  // --- Context-window fullness (internal-docs/context-fullness-visibility.md).
  // Latest committed fullness measurement for the CURRENT conversation, or null
  // when none exists (fresh/blank conversation, resumed-but-not-yet-sampled,
  // backend can't report - e.g. Codex before its first turn's tokenUsage
  // notification). In-memory only; lost on server restart and repopulated at
  // the end of the first completed turn.
  contextUsage: ContextUsageSnapshot | null;
  // Conversation-generation token. Bumped SYNCHRONOUSLY (never after an await)
  // by every path that resets or switches the conversation (/clear, engine
  // switch, resume to a different session, edit-fork, abandoned codex thread).
  // An async getContextUsage() refresh captures it at initiation and commits
  // only if it still matches - a late resolution from the old conversation can
  // never repopulate the new one. Same pattern as topicGenToken above, kept
  // separate because setTopic bumps that one without a conversation reset.
  contextGen: number;
  // Monotonic sample-initiation counter; a commit also requires
  // seq > contextUsageCommittedSeq, so an older in-flight request can never
  // overwrite a newer committed sample. Both init 0 and stay global across
  // generations (never reset).
  contextSampleSeq: number;
  contextUsageCommittedSeq: number;
  // Latest pending fire-and-forget refresh, identity-guarded on clear (an older
  // promise's finally must not evict a newer one; a generation reset nulls the
  // slot so nothing waits on an orphaned old-conversation request). The pre-send
  // context-notice step in runAgentTurn awaits it with a bounded timeout so a
  // just-finished turn's sample lands before the notice is evaluated.
  contextSampleInFlight: Promise<void> | null;
  // Agent-facing fullness thresholds already fired THIS generation (the raw
  // percentage values that were crossed, e.g. 60, 85). Evaluated and mutated
  // EXCLUSIVELY by the pre-send notice step in runAgentTurn, at send-accept time
  // - never by the sample-commit path, so a committed high sample can't consume
  // a notice before an outbound message exists to carry it. Reset with the
  // generation (resetContextUsage); restored on edit-fork rollback; preserved on
  // model change (the conversation continues, already-fired notices stay fired).
  firedAgentThresholds: Set<number>;
  // Boss-facing fullness thresholds already fired THIS generation: the
  // ephemeral chat system line ("Context is NN% full. ...") emitted by the
  // sample-commit path (maybeEmitUiContextNotice in agent-manager). Deliberately
  // SEPARATE from firedAgentThresholds - different audiences, and one firing
  // must never suppress the other. Same lifecycle: reset with the generation
  // (resetContextUsage); restored on edit-fork rollback; preserved on model
  // change.
  firedUiThresholds: Set<number>;
  // --- Session-start memory-size notice (task f1a08f05).
  // The formatted notice waiting to ride out on the next message, or null when
  // there is nothing to say (every scope under the ratio) or it has already gone
  // out. Armed by createBackendSession, which already renders the memory layer;
  // consumed by the pre-send step in runAgentTurn at send-accept time, on the
  // same never-before-send rule as firedAgentThresholds.
  memoryNotice: string | null;
  // Whether this conversation has already had its memory notice. Arming skips
  // an agent whose flag is set, which makes the notice once per CONVERSATION
  // rather than once per session process - a model/effort change rebuilds the
  // session mid-conversation and must not re-fire it. Same lifecycle as
  // firedAgentThresholds: cleared with the generation (resetContextUsage),
  // restored on edit-fork rollback (rollback puts the SAME conversation back,
  // so its already-fired notice stays fired). In-memory only, like every other
  // notice flag here - a server restart forgets it, and the next session start
  // may re-notice.
  memoryNoticeFired: boolean;
  // --- Truthful wake-up notice (task e06b7e23).
  // The wake-up line waiting to ride out on the next message, or null when the
  // wake had nothing to warn about (idle eviction, fresh session). Armed by the
  // two dormant-wake paths in agent-manager for a server restart or an
  // unexpected backend death; consumed by the pre-send step in runAgentTurn on
  // the same never-before-send rule as memoryNotice. Without it the warning
  // reaches only the isomux log, and the agent - the one holding a tool result
  // that falsely claims its boss rejected the running command - never sees it.
  // No companion "fired" flag: every wake re-arms it, and there is nothing to
  // suppress across a conversation.
  wakeNotice: string | null;
  // Recovery copy held until the first event proves whether this wake failed
  // only because its provider needs sign-in. That auth path has one notice.
  pendingFreshRecoveryNotice: boolean;
  authNoticeEmittedThisWake: boolean;
  // --- Subscription-allowance usage (the pill next to the context battery).
  // Latest committed reading for the ACCOUNT this agent's backend is signed in
  // to, or null when there is none (Claude API-key/Bedrock/Vertex sessions,
  // Codex before any rate-limit payload, backend call failed). Deliberately
  // NOT tied to contextGen: quota is account-scoped, so /clear, fork and
  // resume leave it alone. In-memory only; lost on server restart and
  // repopulated at the end of the next turn.
  subscriptionUsage: SubscriptionUsageWire | null;
  // ACCOUNT-identity generation token. Bumped SYNCHRONOUSLY (never after an
  // await) by every path that can change which account the agent's backend
  // talks to - engine switch, cross-engine resume, and the rollback of a
  // failed one. A refresh captures it at initiation and commits only if it
  // still matches, so a Claude read started before a switch to Codex can't
  // repopulate Claude figures afterwards. Deliberately NOT bumped by /clear,
  // fork, same-engine resume, or a same-engine model change: none of those
  // change the account, and the quota doesn't reset when a conversation does.
  subscriptionGen: number;
  // Monotonic sample-initiation counter plus the highest seq committed, so a
  // slow older refresh can never overwrite a newer reading - in either
  // direction: an authoritative CLEAR commits through the same guard. Same
  // discipline as contextSampleSeq / contextUsageCommittedSeq above, minus the
  // generation token (there's no conversation to belong to).
  subscriptionSampleSeq: number;
  subscriptionCommittedSeq: number;
  // /resume two-step state
  pendingResume: boolean;
  pendingResumeSessions: {
    sessionId: string;
    lastModified: number;
    topic: string | null;
    topicMessageCount: number;
  }[];
  // /model two-step state
  pendingModelPick: boolean;
  // /effort two-step state
  pendingEffortPick: boolean;
  pendingInteraction?: AgentChoiceInteraction | null;
  pendingInteractionAdded?: AgentChoiceInteraction | null;
  pendingInteractionRemoved?: { interactionId: string; agentId: string } | null;
  // Auto-mode permission prompt two-step state. Carries the approvalId for
  // routing plus enough to interpret the reply; the backend holds the
  // SDK-side resolver and the rules themselves, applied when session.approve()
  // is called with "allow_persistent" or "allow_prefix".
  pendingPermission: {
    approvalId: string;
    toolName: string;
    inputSummary: Record<string, string>;
    allowPersistent: boolean;
    // Human-readable form of the broader session rule the backend offered.
    // Display + gate only: the rule itself stays inside the backend, which
    // applies it on an "allow_prefix" decision. Undefined means no prefix
    // option was shown, so an unmatched number denies with that as the reason.
    allowPrefixLabel?: string;
  } | null;
  // Terminal PTY sidecar (spawned on demand via Node.js)
  ptySidecar: import("bun").Subprocess | null;
  ptyBuffer: string; // buffered output for reconnecting browsers
  // /isomux-usage tracking. The SDK's `result` reports session-cumulative totals,
  // which are written to sessions.json on every turn (`usage` field) along
  // with a per-turn snapshot (`usageSnapshots`). /isomux-usage reads those entries
  // and aggregates per agent. Forked sessions subtract the parent's
  // cumulative-at-the-fork-point so shared turns aren't double-counted.
  lastWrittenEntryId: string | null;
  // Message queue: human + agent senders accumulate here while the agent is
  // busy (state thinking/tool_executing). On transition to idle/waiting_for_response,
  // all entries flush together as one coalesced SDK prompt with sender labels.
  // DURABLE (task 9870b472): mirrored to ~/.isomux/message-queues.json and
  // replayed on boot. Every mutation site MUST persist - acceptance goes
  // through enqueueMessage's transactional write; every post-accept mutation
  // must call persistQueueState (best-effort) alongside its emitQueueUpdate.
  messageQueue: QueuedMessage[];
  // Set synchronously when an inbound message claims recovery of an errored
  // backend. Later messages join the same durable queue instead of starting a
  // second resume against the same transcript.
  autoResumeInProgress: boolean;
  // Set while flushQueue is mid-flight to prevent re-entry from the
  // updateState trigger inside the same flush's await chain. Never cleared by
  // anything other than that flush's own finally - the queue watchdog recovers
  // a wedged flush by cancelling it (session replacement), not by force-
  // clearing this flag, so at most one flush can ever be sending.
  flushInProgress: boolean;
  // Date.now() stamped when the current flush claimed flushInProgress. The
  // queue watchdog uses it to age an ACTIVE flush (an old queued item can
  // coexist with a fresh, healthy flush). Meaningless while !flushInProgress.
  flushStartedAt: number;
  // Date.now() of the watchdog's last forced recovery for this agent. Forced
  // recovery is rate-limited (cooldown) so a truly unrecoverable wedge (an
  // adapter that ignores close/send teardown) escalates via logs instead of
  // replacing sessions every sweep.
  lastForcedRecoveryAt: number;
  // Date.now() of each agent-initiated steer that actually interrupted a turn
  // of THIS receiver (task 80b2bb08), newest last, pruned to the rate-limit
  // window on each check. Per receiver across all senders: what the limit
  // protects is this agent's ability to finish a turn, not any one sender's
  // manners. Only real interruptions are recorded - a steer at an idle receiver
  // costs it nothing. In-memory only; a restart starting a fresh window is
  // correct (no turn survives it to be interrupted). Human "Send now" is not
  // counted and not limited.
  recentSteers: number[];
  // clientMessageId → expiresAtMs. Per-receiver dedup window for HTTP retries.
  // 5 min TTL; entries are pruned lazily inside enqueueMessage. Persisted with
  // the queue so a retry arriving after a restart still dedupes against a
  // replayed item.
  queueDedupe: Map<string, number>;
  // Wall-clock ms of the agent's last activity (turn start, inbound message, or
  // session install/wake). The idle-eviction sweep demotes a live agent to lazy
  // once this is older than the idle threshold. In-memory only; not persisted
  // (a restart lazy-restores everyone regardless).
  lastActiveAt: number;
  // Why the agent currently has no live subprocess, used only to word the wake
  // message accurately: "idle" = demoted by the inactivity sweep; "boot" =
  // lazy-restored on server (re)start; "fresh" = a blank conversation never
  // backed by a subprocess (lazy spawn, or released by /clear) - its wake is
  // silent because there is nothing to announce resuming; "stream-ended" = the
  // backend's event stream ended on its own while the session was still bound
  // (subprocess died without a proper error event) and runConsumer released
  // the dead session pointer. Null while live. In-memory only.
  dormantReason: "idle" | "boot" | "fresh" | "stream-ended" | null;
}

export type AgentEvent =
  | OfficeEvent
  | { type: "interaction_added"; interaction: AgentChoiceInteraction }
  | { type: "interaction_removed"; interactionId: string; agentId: string }
  | { type: "log_entry"; entry: LogEntry }
  // Slide Mode: a turn's slide finished generating. Routed to the WS as the
  // `slide_ready` wire event (room-ACL, like log_entry). sessionId is the
  // conversation (root session) the slide belongs to.
  | {
      type: "slide_ready";
      agentId: string;
      sessionId: string;
      entryId: string;
      slide: SlideRecord;
    }
  // Slide Mode: that turn's generation failed terminally - routed to the WS as
  // `slide_failed` (same room-ACL scope as slide_ready).
  | {
      type: "slide_failed";
      agentId: string;
      sessionId: string;
      entryId: string;
      reason: SlideFailureReason;
    }
  // `rollback: true` marks a clear that RESTORES a prior visible timeline
  // (failed edit-fork rollback) rather than establishing a new conversation
  // boundary - clients keep transient per-conversation cues (the unread dot)
  // instead of dropping them (task 8d763325).
  | { type: "clear_logs"; agentId: string; rollback?: boolean }
  | {
      type: "slash_commands";
      agentId: string;
      commands: {
        name: string;
        description?: string;
        aliasFor?: string;
        autoRun?: boolean;
      }[];
      skills: SkillInfo[];
    }
  | { type: "terminal_output"; agentId: string; data: string }
  | {
      type: "terminal_status";
      agentId: string;
      process: string;
      shell: boolean;
    }
  | { type: "terminal_exit"; agentId: string; exitCode: number }
  // Killed-agent chip lifecycle. Emitted by kill() and revive() in
  // agent-manager. Routed through routeAgentEventToWs with per-session
  // ACL filtering on both variants: drop the event if the agent's
  // `lastRoomId` isn't in the session's visible set. Carrying
  // lastRoomId on both ends keeps the route filter symmetric and
  // closes a minor info-leak on the removed variant.
  | { type: "killed_agent_added"; agent: KilledAgentSummary }
  | { type: "killed_agent_removed"; agentId: string; lastRoomId: string };

export type EventHandler = (event: AgentEvent) => void;

// Thrown at an in-flight turn's deferred when its session is swapped out
// from under it (abort / resume / model switch / etc.). Callers of
// sendMessage / executeSkill / editMessage filter this out so a user-
// initiated interrupt doesn't surface as a scary log entry.
//
// `reason` rides along so catch sites can tell WHY the swap happened without
// racing any external flag: "settings" marks a deliberate settings-driven
// replace (model/effort/permission/sandbox/cwd edit) - flushQueue's handler
// words its interrupt notice as expected behavior instead of a stall
// (task 8ba27b27). Undefined for every other swap (abort slow path,
// setPrivileged, watchdog forced recovery, /clear, /resume, ...).
export class SessionSwappedError extends Error {
  readonly reason?: "settings";
  constructor(message = "Session replaced.", reason?: "settings") {
    super(message);
    this.name = "SessionSwappedError";
    this.reason = reason;
  }
}

// A newer turn claimed the session while an older caller still owned the
// per-turn deferred. Callers discriminate this ownership handoff from backend
// failures without coupling control flow to the diagnostic message text.
export class TurnSupersededError extends Error {
  constructor(message = "Superseded by a new turn.") {
    super(message);
    this.name = "TurnSupersededError";
  }
}

// Thrown by a backend session.send() when the backend isn't usable at all -
// CLI not installed, auth missing, etc. - i.e. the failure is about the
// agent's setup, not about the turn. sendMessage / flushQueue / editMessage
// catch this and route it to a calmer presentation than a real turn error:
// the `message` lands in chat as a system log entry, the agent stays in idle
// instead of transitioning to error, and the user can edit/retry. The
// message itself should already be user-actionable (install hint, login
// prompt, etc.) - it's surfaced verbatim with no "Error:" prefix.
//
// `command` is an optional shell command the user can run to resolve the
// not-configured state (install command, login command). When present, the
// catch site emits a terminal-command card alongside the system message so
// the user can click [Copy to terminal] instead of retyping it.
export class BackendNotConfiguredError extends Error {
  command?: string;
  constructor(message: string, command?: string) {
    super(message);
    this.name = "BackendNotConfiguredError";
    this.command = command;
  }
}

// True while the agent is part-way through a two-step pending flow (the
// previous turn ended asking for a permission decision / resume pick / model
// pick / effort pick). The next user message gets interpreted as the pick, so
// callers that would otherwise queue or defer must take the pending-* path
// instead. Pure derivation from ManagedAgent - lives here so the queueing
// gate in sendMessage and the deferral gate in executeSkill stay in lockstep.
export function inMultiStepFlow(managed: ManagedAgent): boolean {
  return !!(
    managed.pendingPermission ||
    managed.pendingResume ||
    managed.pendingModelPick ||
    managed.pendingEffortPick
  );
}

// Which two-step prompt an agent is parked on, or null when it is not parked
// (task 29daebe2). The same four flags inMultiStepFlow reduces to a boolean,
// kept as a named value so the state can be SHOWN rather than only acted on: a
// prompt-parked agent used to be indistinguishable from one whose backend had
// died, because the prompt itself is written as an ephemeral log entry that
// never reaches disk.
//
// DELIBERATELY AN ENUM AND NOTHING MORE (PendingPromptKind, shared/types.ts).
// It discloses that the agent is waiting and what KIND of answer it wants -
// never the prompt text, the tool name, or the command. This value rides on
// AgentInfo, which reaches every client that can see the agent, so widening it
// would create a new disclosure surface out of what is meant to be a status
// indicator.
export function pendingPromptOf(
  managed: ManagedAgent,
): PendingPromptKind | null {
  if (managed.pendingPermission) return "permission";
  if (managed.pendingResume) return "resume";
  if (managed.pendingModelPick) return "model";
  if (managed.pendingEffortPick) return "effort";
  return null;
}

// Result of sendNow / abort. Both used to be void with an unconditional 204,
// which made "I did the thing" and "I could not and said nothing" identical on
// the wire (tasks 5dcb0a02, 29daebe2). Same shape as CancelResult so the route
// layer maps them with the existing `fail(status, code, message)` helper.
export type SendNowResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; code: string; message: string };

export type AbortResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 500; code: string; message: string };

// Why a requested steer did not interrupt the receiver (task 80b2bb08). Both
// reasons degrade to a plain queue rather than failing the send: the message is
// always accepted, only the interruption is refused.
//   multi_step_flow - the receiver is part-way through a permission / resume /
//     model / effort pick, where the next message is read as the pick. Aborting
//     there would kill a turn and still not deliver (flushQueue declines to run
//     in a multi-step flow).
//   rate_limited - too many interruptions of this receiver in the recent
//     window; letting them through would keep it from ever finishing a turn.
export type SteerDeclineReason = "multi_step_flow" | "rate_limited";

// Result of enqueueMessage. `status` is the HTTP status the WS/HTTP layer
// should forward for the failure case. `steered` / `steerDeclined` are present
// only when the caller asked to steer (and never on a deduped retry, which
// touched nothing).
export type EnqueueResult =
  | {
      ok: true;
      queued: boolean;
      deduped?: boolean;
      messageId?: string;
      steered?: boolean;
      steerDeclined?: SteerDeclineReason;
    }
  | { ok: false; error: string; status: number };

// Immediate acceptance result for a human-attributed message. This resolves
// when the manager accepts or rejects the message, not when the turn finishes.
export type UserSendAcceptance =
  | { ok: true }
  | {
      ok: false;
      status: 404 | 409 | 429 | 500;
      code: string;
      message: string;
    };
