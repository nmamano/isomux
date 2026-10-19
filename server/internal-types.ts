import type {
  AgentInfo,
  AgentChoiceInteraction,
  KilledAgentSummary,
  LogEntry,
  PendingPromptKind,
  QueuedMessage,
  SkillInfo,
  SubscriptionUsageWire,
} from "../shared/types.ts";
import type { SettingsNoticeArm } from "./settings-notice.ts";
import type { BackendSession, NormalizedEvent } from "./backends/types.ts";
import type { DormantReason, SessionManager } from "./session-manager.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import type { BillingAccount } from "./member-usage-cap.ts";
import type { AutoHandoffTrigger } from "./auto-handoff.ts";

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
  // The engine's own compaction point in tokens (ContextUsage.
  // autoCompactThreshold), when it compacts by itself and says where. Feeds the
  // automatic-handoff trigger only; not on the wire.
  compactAtTokens?: number;
}

// An automatic handoff from the moment it arms until the reset (or an exit).
// In memory only. See internal-docs/auto-handoff-design.md, Appendix C.
export interface AutoHandoffPhase {
  // Set synchronously when the brief turn starts and never cleared on this
  // object: the brief turn's own idle transition must not start a second one.
  briefStarted: boolean;
  trigger: AutoHandoffTrigger;
  // The sample that armed it, for the prompt and the member's lines.
  totalTokens: number;
  percentage: number;
}

export interface ManagedAgent {
  // Readonly to enforce that AgentInfo mutation goes through OfficeState
  // (officeState.updateAgent / setTopic / etc.). The shared-reference
  // invariant means OfficeState's mutations land here automatically.
  // The single legitimate escape hatch is `withAgentRollback` in
  // agent-manager, which casts to mutate before a side effect that may need
  // to revert the change.
  readonly info: Readonly<AgentInfo>;
  // The per-agent session lifecycle object (server/session-manager.ts): the
  // BackendSession slot, its consumer, the per-turn deferred and the swap /
  // abort bookkeeping live there. Read and write them as
  // `managed.sessionManager.<field>`.
  readonly sessionManager: SessionManager<ManagedAgent>;
  // Root captured from the actual Claude launch, before system_init assigns an id.
  launchedClaudeConfigDir?: string;
  // True when that launch selected Bedrock or Vertex: the session has no
  // claude.ai login, so its init must not overwrite the sign-in's connectors.
  launchedClaudeCloud?: boolean;
  // Where the running Claude session's API credential comes from, from its
  // init ("none" = a claude.ai login). Unset until the first init.
  claudeApiKeySource?: string;
  // The account the installed session bills, captured at its launch. The
  // member usage cap compares it with the office sign-in.
  billingAccount?: BillingAccount;
  // The engine's native plan mode is on (/plan). In memory only: a server
  // restart clears it. Every new session of the agent starts in plan mode
  // while it is set.
  planMode?: boolean;
  slashCommands: {
    name: string;
    description?: string;
    aliasFor?: string;
    autoRun?: boolean;
  }[];
  skills: SkillInfo[];
  sdkReportedCommands: string[];
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
  topicGenerating: boolean;
  topicMessageCount: number;
  // Bumped by any path that resets the conversation (/clear, /resume, fork,
  // newConversation). generateTopic captures this at start and discards the
  // result if it changed during the await - otherwise an in-flight LLM call
  // would stomp on the cleared state when it finally returns.
  topicGenToken: number;
  // Set by a failed topic. key is "<agentType>:<one-shot model>"; while it
  // matches, automatic triggers wait until retryAt, and each further failure
  // doubles the wait. A success clears it; the manual refresh ignores it.
  // In-memory only.
  topicBackoff: { key: string; failures: number; retryAt: number } | null;
  // See internal-docs/context-fullness-visibility.md.
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
  // Member-facing fullness thresholds already fired THIS generation: the
  // ephemeral chat system line ("Context is NN% full. ...") emitted by the
  // sample-commit path (maybeEmitUiContextNotice in agent-manager). Deliberately
  // SEPARATE from firedAgentThresholds - different audiences, and one firing
  // must never suppress the other. Same lifecycle: reset with the generation
  // (resetContextUsage); restored on edit-fork rollback; preserved on model
  // change.
  firedUiThresholds: Set<number>;
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
  // The edited text while an edited message's turn runs (editMessage), else
  // unset. Every error entry written meanwhile keeps it (FAILED_EDIT_TEXT_KEY),
  // so a turn that fails late still offers the text back.
  editTurnText?: string;
  // The wake-up line waiting to ride out on the next message, or null when the
  // wake had nothing to warn about (idle eviction, fresh session). Armed by the
  // two dormant-wake paths in agent-manager for a server restart or an
  // unexpected backend death; consumed by the pre-send step in runAgentTurn on
  // the same never-before-send rule as memoryNotice. Without it the warning
  // reaches only the isomux log, and the agent - the one holding a tool result
  // that falsely claims its member rejected the running command - never sees it.
  // No companion "fired" flag: every wake re-arms it, and there is nothing to
  // suppress across a conversation.
  wakeNotice: string | null;
  // Set while an agent's abort waits to be explained on the next turn, else
  // null. Armed by abortByAgent with a fresh object each time, so runAgentTurn
  // can tell the arm it sent from a later one; consumed on the same
  // never-before-send rule, and dropped at a conversation boundary.
  stopNotice: StopNoticeArm | null;
  // Set while a settings restart waits to be explained on the next turn, else
  // null (server/settings-notice.ts). A later edit replaces it with a merged
  // object, so runAgentTurn can tell the arm it sent from a later one; consumed
  // on the same never-before-send rule, and dropped at a conversation boundary.
  settingsNotice: SettingsNoticeArm | null;
  // Automatic handoff (internal-docs/auto-handoff-design.md). All in memory
  // and all per conversation: resetContextUsage clears them, except that
  // newConversation sets the last two for a conversation an automatic
  // handoff opened.
  // The running attempt, or null.
  autoHandoffPhase: AutoHandoffPhase | null;
  // This conversation used its attempt (it failed) or paused the mode. The
  // fullness notices fire as before once this is set.
  autoHandoffSpent: boolean;
  // While the brief turn runs: its text after the last tool call, and its
  // turn status. Filled by the normalized-event handler.
  autoHandoffCapture: { chunks: string[]; status: string | null } | null;
  // Opened by an automatic handoff and not yet sampled. A first sample at or
  // above the trigger pauses the mode for this conversation (the loop guard).
  autoHandoffOpened: boolean;
  // The fresh session's one-shot notice; consumed by runAgentTurn on the
  // never-before-send rule, like wakeNotice.
  autoHandoffNotice: string | null;
  // Resume after a usage limit (server/limit-resume.ts). The reset time a
  // usage_limit_stop reported for the running turn, read when it ends; and the
  // pending resume's fire time (persisted as agents.json limitResumeAt).
  limitStopResetsAtMs: number | null;
  limitResumeAt: number | null;
  // Recovery copy held until the first event proves whether this wake failed
  // only because its provider needs sign-in. That auth path has one notice.
  pendingFreshRecoveryNotice: boolean;
  // The backend said this turn needs sign-in (auth_needed), or the send was
  // stopped as signed out. One sign-in card per turn, and the turn's end
  // leaves the desk waiting instead of red. Reset when a turn begins.
  authNeededThisTurn: boolean;
  // Latest committed reading for the ACCOUNT this agent's backend is signed in
  // to, or null when there is none (Claude API-key/Bedrock/Vertex sessions,
  // Codex before any rate-limit payload, backend call failed). Deliberately
  // NOT tied to contextGen: quota is account-scoped, so /clear, fork and
  // resume leave it alone. Every agent on the same account shows the latest
  // reading any of them took (task 967a09d1). In-memory only; lost on server
  // restart and repopulated at the end of the next turn on the account.
  subscriptionUsage: SubscriptionUsageWire | null;
  // ACCOUNT-identity generation token. Bumped SYNCHRONOUSLY (never after an
  // await) by every path that can change which account the agent's backend
  // talks to - engine switch, cross-engine resume, the rollback of a failed
  // one, a usage account key change (another directory or auth variable) and
  // a sign-in or sign-out in the agent's directory. A refresh captures it at
  // initiation and commits only if it still matches, so a Claude read started
  // before a switch to Codex can't repopulate Claude figures afterwards.
  // Deliberately NOT bumped by /clear, fork, same-engine resume, or a
  // same-engine model change that stay on one account: the quota doesn't
  // reset when a conversation does.
  subscriptionGen: number;
  // The usage account key (server/usage-account.ts) of the installed session,
  // captured at its launch.
  launchedUsageKey?: string | null;
  // The key derived for the agent while it has no session, and the stored
  // session id it was derived for.
  idleUsageKey?: { sessionId: string | null; key: string | null };
  // The key `subscriptionUsage` belongs to. Undefined until first resolved.
  subscriptionKey?: string | null;
  // Monotonic sample-initiation counter plus the highest seq committed, so a
  // slow older refresh can never overwrite a newer reading - in either
  // direction: an authoritative CLEAR commits through the same guard. Same
  // discipline as contextSampleSeq / contextUsageCommittedSeq above, minus the
  // generation token (there's no conversation to belong to).
  subscriptionSampleSeq: number;
  subscriptionCommittedSeq: number;
  pendingResume: boolean;
  pendingResumeSessions: {
    sessionId: string;
    lastModified: number;
    topic: string | null;
    topicMessageCount: number;
  }[];
  pendingModelPick: boolean;
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
    // The card that asks for this request. A click on any other card never
    // answers it.
    interactionId?: string;
  } | null;
  // Permission requests that arrived while pendingPermission was open, oldest
  // first. Claude's parallel subagents can ask at the same time, and each
  // request has its own backend resolver, so none may overwrite another. The
  // next one opens when the open one is answered. `session` is the session
  // that asked: a request from a replaced session is never shown.
  queuedPermissions: {
    event: Extract<NormalizedEvent, { kind: "approval_request" }>;
    inputSummary: Record<string, string>;
    session: BackendSession | null;
  }[];
  ptySidecar: import("./agent-host.ts").AgentProcess | null;
  ptyBuffer: string;
  // The secrets or variables in this agent's scope changed after its
  // terminal started: the terminal keeps its old environment until it
  // restarts, and the panel says so. A new terminal clears it.
  ptyEnvStale?: boolean;
  // The same change, while the agent's process was busy: the process is
  // released when its turn ends, so the next turn starts with the current
  // secrets and variables.
  envStale?: boolean;
  // /isomux-usage tracking. The SDK's `result` reports session-cumulative totals,
  // which are written to sessions.json on every turn (`usage` field) along
  // with a per-turn snapshot (`usageSnapshots`). /isomux-usage reads those entries
  // and aggregates per agent. Forked sessions subtract the parent's
  // cumulative-at-the-fork-point so shared turns aren't double-counted.
  lastWrittenEntryId: string | null;
  // Message queue: human + agent senders accumulate here while the agent is
  // busy (state thinking/tool_executing). On transition to idle/waiting_for_response,
  // all entries flush together as one coalesced SDK prompt with sender labels.
  // Mirrored to ~/.isomux/message-queues.json and
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
  // Holds a conversation change puts on the queue while it swaps sessions
  // and rewrites the chat, so nothing consumes the queue until the next
  // session can take it. One token per change: a release clears only its own
  // hold, so overlapping changes cannot release each other's. In memory only.
  queueHolds: Set<symbol>;
  // The hold a send that failed for a missing or signed-out backend put on
  // the queue, so the flush does not retry in a loop. The next message
  // releases it; a conversation change drops it and carries the queue.
  backendHold: symbol | null;
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
  // of THIS receiver, newest last, pruned to the rate-limit
  // window on each check. Per receiver across all senders: what the limit
  // protects is this agent's ability to finish a turn, not any one sender's
  // manners. Only real interruptions are recorded - a steer at an idle receiver
  // costs it nothing. In-memory only; a restart starting a fresh window is
  // correct (no turn survives it to be interrupted). Human "Send now" is not
  // counted and not limited.
  recentSteers: number[];
  // Queue items the session's PostToolBatch hook delivered inside the running
  // turn (internal-docs/steer-delivery-design.md). They stay in messageQueue
  // (and on disk) until that session's turn_completed drains them; a claim
  // whose session is no longer the installed one is stale and its items flush
  // again (at-least-once). Object references, not queue ids: ids are reused.
  boundaryClaim?: { session: BackendSession; items: Set<QueuedMessage> };
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
  // (subprocess died without a proper error event) and the SessionManager
  // consumer released
  // the dead session pointer. Null while live. In-memory only.
  dormantReason: DormantReason;
}

export type AgentEvent =
  | OfficeEvent
  | { type: "interaction_added"; interaction: AgentChoiceInteraction }
  | { type: "interaction_removed"; interactionId: string; agentId: string }
  | { type: "log_entry"; entry: LogEntry }
  // `rollback: true` marks a clear that RESTORES a prior visible timeline
  // (failed edit-fork rollback) rather than establishing a new conversation
  // boundary - clients keep transient per-conversation cues (the unread dot)
  // instead of dropping them.
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
      envStale?: true;
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
// words its interrupt notice as expected behavior instead of a stall.
// "carry" marks a conversation change that carries the queue to the next
// session (handoff, /clear, new-conversation, engine switch, resume to another
// session, edit-fork), so flushQueue's handler writes no notice at all.
// Undefined for every other swap (abort slow path, setPrivileged, watchdog
// forced recovery, re-resume of the current session, ...).
export type SwapReason = "settings" | "carry";
export class SessionSwappedError extends Error {
  readonly reason?: SwapReason;
  constructor(message = "Session replaced.", reason?: SwapReason) {
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

// A swap closed the session while its send() waited, so the backend never
// took the message (task 8c15e93e: a woken Codex session still booting). Not
// thrown for a member's Stop. A direct send queues its message again, and the
// post-swap flush delivers it to the next session.
export class SwappedBeforeSendError extends SessionSwappedError {
  constructor(message: string, reason?: SwapReason) {
    super(message, reason);
    this.name = "SwappedBeforeSendError";
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
// `command` is an optional shell command the member can run to resolve the
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

// Thrown before a send when the agent's engine is known to be signed out, so
// the message never reaches the provider. The catch sites show the sign-in
// notice and card instead of `message`.
export class BackendSignedOutError extends BackendNotConfiguredError {
  constructor(message: string) {
    super(message);
    this.name = "BackendSignedOutError";
  }
}

/**
 * A turn failed after its backend sent auth_needed. The turn's error line and
 * the sign-in card are already in the chat, so the caller that owns the turn
 * keeps the desk waiting and writes nothing. Keeps the backend's message.
 */
export class AuthNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthNeededError";
  }
}

/** A Codex turn stopped after bounded provider-capacity retries. */
export class ProviderCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCapacityError";
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
    managed.pendingEffortPick ||
    managed.pendingInteraction?.kind === "cronjob"
  );
}

// Which two-step prompt an agent is parked on, or null when it is not parked.
// The same parked states inMultiStepFlow reduces to a boolean,
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
  if (managed.pendingInteraction?.kind === "cronjob") return "cronjob";
  return null;
}

// Result of sendNow / abort. Both used to be void with an unconditional 204,
// which made "I did the thing" and "I could not and said nothing" identical on
// the wire. Same shape as CancelResult so the route
// layer maps them with the existing `fail(status, code, message)` helper.
export type SendNowResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; code: string; message: string };

// One agent stop's claim on ManagedAgent.stopNotice (server/stop-notice-arms.ts).
// An arm goes in before its abort runs, so it is "pending" until the abort
// answers. `backing` links the live arms it replaced: a failed head stands for
// those (a pending one, or a confirmed stop not yet explained), and only those.
export type StopNoticeArm = {
  text: string;
  state: "pending" | "confirmed" | "failed";
  backing: StopNoticeArm | null;
};

export type AbortResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 429 | 500; code: string; message: string };

// Why a requested steer did not interrupt the receiver. Both
// reasons degrade to a plain queue rather than failing the send: the message is
// always accepted, only the interruption is refused.
//   multi_step_flow - the receiver is part-way through a permission / resume /
//     model / effort pick, where the next message is read as the pick. Aborting
//     there would kill a turn and still not deliver (flushQueue declines to run
//     in a multi-step flow).
//   rate_limited - too many interruptions of this receiver in the recent
//     window; letting them through would keep it from ever finishing a turn.
//   auto_handoff - an automatic handoff is under way; the message waits for
//     the fresh session.
export type SteerDeclineReason =
  | "multi_step_flow"
  | "rate_limited"
  | "auto_handoff";

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
  | {
      ok: false;
      error: string;
      status: number;
      // Set with error "usage_cap": when the member usage cap lets the input
      // through again.
      usageCap?: { retryAtMs: number };
    };

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

// A cron run-message outcome (task 44872c41). `deduped`: a resend whose
// clientMessageId matched an accepted attempt; nothing was sent again.
export type RunSendResult =
  | { ok: true; deduped?: boolean }
  | Extract<UserSendAcceptance, { ok: false }>;
