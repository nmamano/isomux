import type {
  AgentInfo,
  KilledAgentSummary,
  LogEntry,
  QueuedMessage,
  SkillInfo,
} from "../shared/types.ts";
import type { BackendSession } from "./backends/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";

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
  pendingTurn: { resolve: () => void; reject: (err: unknown) => void } | null;
  // The aggregate `afterTurn` promise for the most recent turn — all plugins'
  // afterTurn hooks raced against their per-plugin timeout, joined here.
  // runAgentTurn awaits this before starting the next turn so memory writes
  // / audit writes / etc. land before the next retrieval. Self-clears on
  // settle (set to null inside runAfterTurn's .finally) so a timed-out
  // afterTurn doesn't poison every subsequent turn with a 10s wait.
  afterTurnPromise: Promise<void> | null;
  // Monotonic counter bumped by every control-plane action that cancels an
  // in-flight turn (abort, kill, replaceSession). runAgentTurn snapshots it
  // at entry — AFTER beginTurn flips state to thinking — and re-checks
  // after each await during plugin retrieval. Any change means a Stop or
  // session swap fired while plugin work was running, so the pre-send turn
  // bails with SessionSwappedError instead of sending the stale prompt
  // into the (possibly swapped) session. The pre-send window between
  // beginTurn and createTurnDeferred is the only place plain `pendingTurn`
  // rejection can't cover, because pendingTurn isn't installed yet — this
  // counter fills that gap.
  turnCancelToken: number;
  // The turnCancelToken value stamped by abort()'s bump — i.e.
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
  // Set while abort() is mid-flight (between session.close() and installSession of the
  // replacement). sendMessage awaits this so a follow-up message arriving in the gap
  // doesn't see session=null and amputate context by spinning up a fresh blank session.
  // Also serves as a partial swap-lock: serializes the most user-visible variant
  // (sendMessage-during-abort) of the broader concurrency hole where multiple swap
  // callers (newConversation/resume/editAgent/editMessage/`/clear`) can race and
  // orphan the loser's session. See task 154e2c14. Don't remove without replacing.
  abortPromise: Promise<void> | null;
  slashCommands: { name: string; description?: string; aliasFor?: string }[];
  skills: SkillInfo[];
  sdkReportedCommands: string[]; // commands reported by SDK in system:init
  // Timing: track when phases start for duration_ms computation
  thinkingStartedAt: number;
  toolCallTimestamps: Map<string, number>; // toolUseId → start timestamp
  // Topic generation
  topicGenerating: boolean;
  topicMessageCount: number; // text entry count when topic was last generated
  // Bumped by any path that resets the conversation (/clear, /resume, fork,
  // newConversation). generateTopic captures this at start and discards the
  // result if it changed during the await — otherwise an in-flight LLM call
  // would stomp on the cleared state when it finally returns.
  topicGenToken: number;
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
  // Auto-mode permission prompt two-step state. Carries only the approvalId
  // for routing; the backend holds the SDK-side resolver and the suggestion
  // rules, applied automatically when session.approve() is called with
  // "allow_persistent".
  pendingPermission: {
    approvalId: string;
    toolName: string;
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
  // In-memory only — not persisted across restarts.
  messageQueue: QueuedMessage[];
  // Set while flushQueue is mid-flight to prevent re-entry from the
  // updateState trigger inside the same flush's await chain.
  flushInProgress: boolean;
  // clientMessageId → expiresAtMs. Per-receiver dedup window for HTTP retries.
  // 5 min TTL; entries are pruned lazily inside enqueueMessage.
  queueDedupe: Map<string, number>;
  // Wall-clock ms of the agent's last activity (turn start, inbound message, or
  // session install/wake). The idle-eviction sweep demotes a live agent to lazy
  // once this is older than the idle threshold. In-memory only; not persisted
  // (a restart lazy-restores everyone regardless).
  lastActiveAt: number;
  // Why the agent currently has no live subprocess, used only to word the wake
  // message accurately: "idle" = demoted by the inactivity sweep; "boot" =
  // lazy-restored on server (re)start; "fresh" = a blank conversation never
  // backed by a subprocess (lazy spawn, or released by /clear) — its wake is
  // silent because there is nothing to announce resuming. Null while live.
  // In-memory only.
  dormantReason: "idle" | "boot" | "fresh" | null;
}

export type AgentEvent =
  | OfficeEvent
  | { type: "log_entry"; entry: LogEntry }
  | { type: "clear_logs"; agentId: string }
  | {
      type: "slash_commands";
      agentId: string;
      commands: { name: string; description?: string; aliasFor?: string }[];
      skills: SkillInfo[];
    }
  | { type: "terminal_output"; agentId: string; data: string }
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
export class SessionSwappedError extends Error {
  constructor(message = "Session replaced.") {
    super(message);
    this.name = "SessionSwappedError";
  }
}

// Thrown by a backend session.send() when the backend isn't usable at all —
// CLI not installed, auth missing, etc. — i.e. the failure is about the
// agent's setup, not about the turn. sendMessage / flushQueue / editMessage
// catch this and route it to a calmer presentation than a real turn error:
// the `message` lands in chat as a system log entry, the agent stays in idle
// instead of transitioning to error, and the user can edit/retry. The
// message itself should already be user-actionable (install hint, login
// prompt, etc.) — it's surfaced verbatim with no "Error:" prefix.
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
// instead. Pure derivation from ManagedAgent — lives here so the queueing
// gate in sendMessage and the deferral gate in executeSkill stay in lockstep.
export function inMultiStepFlow(managed: ManagedAgent): boolean {
  return !!(
    managed.pendingPermission ||
    managed.pendingResume ||
    managed.pendingModelPick ||
    managed.pendingEffortPick
  );
}

// Result of enqueueMessage. `status` is the HTTP status the WS/HTTP layer
// should forward for the failure case.
export type EnqueueResult =
  | { ok: true; queued: boolean; deduped?: boolean; messageId?: string }
  | { ok: false; error: string; status: number };
