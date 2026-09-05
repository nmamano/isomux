// Backend abstraction shared by Claude (claude-agent-sdk) and Codex (App Server).
//
// SessionManager holds the session lifecycle; agent-manager.ts holds queue / abort / fork / topic-gen
// in backend-agnostic form; engines implement this contract under
// server/backends/{claude,codex}/ and the dispatch lives in
// server/backends/index.ts (`getBackend(agentType)`).
//
// All session-lifecycle methods (`createSession`, `resumeSession`) are
// synchronous to mirror the Claude SDK's current shape - backends defer
// any handshake (Codex `initialize` / first `thread/started`) and surface
// the assigned id via the first `system_init` NormalizedEvent on the stream.

// Static per-backend, embedded in the agent payload sent to the UI. The UI
// hides affordances when a capability is false (e.g. greys out the "branch"
// button on a backend without fork support). The wire shape lives in
// shared/types.ts as AgentCapabilities; this is just an alias so backend
// code reads naturally.

import type { AgentCapabilities } from "../../shared/types.ts";
export type BackendCapabilities = AgentCapabilities;

// `filename` (relative to the agent's attachments dir) is resolved to an
// on-disk path via persistence.getFilePath; the shared attachment convention
// (server/attachment-prompt.ts) turns each spec into a path-notice prompt
// line - bytes are never read or embedded.

import type { Attachment, SubagentOrigin } from "../../shared/types.ts";
export type AttachmentSpec = Attachment;
// Re-exported so backend code can name it without reaching into shared/. The
// wire/disk shape lives there because it travels as LogEntry.metadata.subagent.
export type { SubagentOrigin };

// The orchestrator pre-builds the system prompt and resolves env vars before
// handing off - so backends don't need to know about office/room/user state.
// `modelFamily`, `effort`, and `permissionMode` are deliberately untyped at
// this layer: each backend's `getModelOptions()` / `getPermissionModes()`
// defines its own value space (Claude: opus/sonnet/haiku × default/acceptEdits/
// bypassPermissions/auto; Codex: gpt-5 family × sandbox × approvalPolicy).

export interface CreateSessionOptions {
  agentId: string;
  cwd: string;
  systemPrompt: string;
  modelFamily: string;
  effort: string;
  permissionMode: string;
  // Internal caller classification for OpenCode permission profiles. Only an
  // explicit true may select the interactive profile; unattended callers
  // omit it and retain the narrower cron profile.
  interactive?: boolean;
  // Codex-only: SandboxMode string ("read-only" / "workspace-write" /
  // "danger-full-access"). Claude backend ignores. Undefined falls back to
  // the backend's default ("workspace-write" for Codex).
  sandbox?: string;
  env?: { [key: string]: string | undefined };
  // Stable identity of the configured environment sources. Backends that
  // share a process use this for grouping instead of restart-volatile
  // entries inherited from process.env.
  environmentKey?: string;
  // Hash of configured environment-file contents only. Shared-process
  // backends use it to replace a server without changing profile identity.
  environmentRevision?: string;
}

export interface SessionEnvironmentOptions {
  env?: { [key: string]: string | undefined };
  environmentKey?: string;
  environmentRevision?: string;
}

export interface SessionAccessOptions extends SessionEnvironmentOptions {
  cwd: string;
  modelFamily: string;
  permissionMode: string;
  interactive?: boolean;
}

// Same shape Claude's `result` message reports, normalized to camelCase. Codex
// emits these via `thread/tokenUsage/updated` and on `turn/completed`.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// This is the single contract that `processNormalizedEvent` consumes.
// Per-backend translation happens at the backend boundary:
//
//   Claude SDK message  →  NormalizedEvent (Claude adapter)
//   Codex notification  →  NormalizedEvent (Codex adapter)
//
// approval_request: when emitted, the turn is paused (Codex: server is waiting
// for the response to the ServerRequest; Claude: the SDK's canUseTool callback
// is awaiting a resolve). The orchestrator calls `session.approve()` to unblock.

export type NormalizedEvent =
  // First event from a fresh or resumed session/thread. Carries the backend-
  // assigned id; orchestrator persists this as SessionManager.sessionId.
  // sessionId is optional only as a defensive fallback for transports that
  // could emit an init without it (the Claude SDK always supplies one); the
  // orchestrator guards session-related side effects on its presence so
  // slash_commands/skills still reach the UI in the edge case.
  | {
      kind: "system_init";
      sessionId?: string;
      slashCommands?: string[];
      model?: string;
    }
  // Final or streamed assistant text. Backends may emit multiple per turn.
  | { kind: "assistant_text"; text: string }
  // Reasoning / thinking text. `durationMs` set on the final chunk if known.
  | { kind: "thinking"; text: string; durationMs?: number }
  // Backend-originated file display. The orchestrator persists the attachment
  // row using the existing file-view log card.
  | { kind: "file_view"; title: string; attachments: AttachmentSpec[] }
  // Tool call. Pairs with a tool_result by `toolUseId`. `subagent` is set when
  // the call came from a subagent the agent spawned rather than from the agent
  // itself - without it the two are indistinguishable in the transcript.
  | {
      kind: "tool_call";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      subagent?: SubagentOrigin;
    }
  // Tool result. `toolUseId` matches the prior tool_call.
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      attachments?: AttachmentSpec[];
      durationMs?: number;
      isError?: boolean;
      subagent?: SubagentOrigin;
    }
  // Per-tool approval ask. Orchestrator's /resolve UX takes over. `suggestions`
  // are intentionally NOT exposed here - backends keep them internally and
  // apply them automatically on `allow_persistent`. Keeps the orchestrator
  // free of backend-specific permission rule shapes.
  //
  // The allow labels are deliberate display-only cracks in this wall.
  // `allowPersistentLabel` states that this request can represent the normal
  // session-persistent choice. A backend that omits it cannot receive that
  // choice. `allowPrefixLabel` states that the backend has a broader rule:
  // when a backend can offer a BROADER session-scoped allow than "this exact
  // call" (Codex: the prefix rule it suggests alongside an exec approval), it
  // puts the human-readable form of that rule here and the orchestrator offers
  // it as an extra choice. The rule itself never crosses the boundary - the
  // orchestrator answers with `allow_prefix` and the backend applies whatever
  // it was holding for that approvalId.
  //
  // `allowPrefixExample` is a second ready-made label: a shorter prefix worth
  // suggesting as an alternative. Both arrive display-ready and the
  // orchestrator must not take them apart - what counts as a token is the
  // backend's business, and a label it re-split could disagree with the rule
  // the backend would actually store.
  | {
      kind: "approval_request";
      approvalId: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      allowPersistentLabel?: string;
      allowPrefixLabel?: string;
      allowPrefixExample?: string;
    }
  // Backend requested interactive input that is not a tool permission. The
  // payload stays backend-owned and default-denied; callers only need the
  // reviewed request kind and id to fail an unattended turn visibly.
  | {
      kind: "input_request";
      inputType: "question";
      requestId: string;
    }
  // Turn boundary. `cost` is total session cost in USD when the backend
  // reports it (Claude: yes; Codex: not yet).
  | {
      kind: "turn_completed";
      status: "completed" | "interrupted" | "failed";
      usage?: TokenUsage;
      cost?: number;
      error?: string;
      // Set by backends that know the turn failed due to an auth issue but
      // have already coalesced/rewritten `error` so it no longer matches
      // AUTH_ERROR_PATTERNS (Codex does this to prevent the orchestrator
      // from re-emitting the login card after the stderr-driven path
      // already did). Orchestrator uses this for state decisions (auth-
      // failed turns leave the agent in waiting_for_response, not error)
      // without re-running the auth-detect regex on the rewritten string.
      causedByAuth?: boolean;
    }
  // Running token totals between turns (Codex-only at v1). `tokenUsage` is
  // the *delta* since the prior usage event - the orchestrator's accumulator
  // sums these into the session's cumulative total. Backends whose transport
  // reports cumulative totals (e.g. Codex `thread/tokenUsage/updated`) must
  // compute the delta against their last-known cumulative before emitting.
  | { kind: "usage_update"; tokenUsage: TokenUsage }
  // Context compaction occurred mid-conversation (Codex-only at v1).
  | { kind: "compacted"; summary?: string }
  // Backend-level error (stream / RPC failure, etc.).
  | { kind: "error"; message: string; code?: string }
  // Free-text system breadcrumb (e.g. Codex auto-decline notice for an
  // elicitation request). Renders as a system-kind log entry.
  //
  // The orchestrator sniffs every system_text for auth trouble, because most
  // of them are relayed provider output (Codex's stderr is the reason that
  // exists). `isomuxAuthored` marks the ones Isomux wrote itself: they can
  // quote a command or a rule the user typed, and a quoted `401` is not a
  // sign-in problem. Set it ONLY for text Isomux composed - never for
  // anything relayed from a backend.
  | { kind: "system_text"; text: string; isomuxAuthored?: true }
  // Background-task lifecycle breadcrumb (Claude-only at v1). Emitted when a
  // genuinely-background task (run_in_background Bash/Agent, workflow, or a
  // task backgrounded mid-run) starts or settles, so the transcript shows a
  // visible trigger for the wake turn that follows a settle. Foreground
  // subagents are deliberately filtered out by the adapter (they already
  // render as tool calls). `label` is pre-sanitized one-line text; `phase`
  // lets the UI style settle outcomes distinctly.
  | {
      kind: "task_lifecycle";
      phase: "started" | "completed" | "failed" | "stopped";
      taskId: string;
      label: string;
    }
  // A tool call was auto-denied without an interactive prompt (Claude-only at
  // v1): newer SDKs emit system/permission_denied for the deny short-circuit
  // in canUseTool - auto-mode classifier, deny rules, dontAsk mode. The
  // denied tool_result still reaches the model either way; this event just
  // makes the denial visible natively in the transcript. Older SDKs never
  // emit the subtype, so absence is normal. `message` and `decisionReason`
  // are pre-sanitized one-line text from the backend adapter.
  | {
      kind: "permission_denied";
      toolUseId: string;
      toolName: string;
      /** The rejection message returned to the model in the tool_result. */
      message: string;
      /** Human-readable reason from the deciding component, when available. */
      decisionReason?: string;
      /**
       * Subagent id when the denied tool call originated inside a subagent
       * (mirrors the SDK's agent_id). Preserved so stored transcripts keep
       * the origin distinguishable; not displayed at v1.
       */
      agentId?: string;
    };

// Four explicit variants matching the /resolve UX. The Claude backend
// translates `allow_persistent` into session-scoped suggestion updates; the
// Codex backend maps it to codex's own `acceptForSession` (that session
// remembers the exact canonicalized command).
//
// `allow_prefix` is only ever offered when the preceding approval_request
// carried an `allowPrefixLabel`: it means "allow this call, and stop asking
// about commands that start the same way". `prefixText` is the user's own
// choice of how much to cover, passed through as the RAW TEXT they typed;
// omitted means "whatever the backend proposed". Deliberately unparsed: what
// counts as a command token is backend-shaped knowledge, so the backend does
// the splitting AND the validating - a prefix that isn't the start of the
// command being approved is refused there. Answering an approval can
// therefore never widen anything beyond that approval.
// Today only Codex offers this. Like every variant here it is session-scoped
// and in-memory: nothing is written to disk or shared with another agent.

export type ApprovalDecision =
  | { kind: "allow_persistent" }
  | { kind: "allow_prefix"; prefixText?: string }
  | { kind: "allow_once" }
  | { kind: "deny"; reason?: string };

// Returned by `Backend.getSessionMessages`. The single consumer at v1 is
// `editMessage` in agent-manager, which finds the matching user message by
// content + occurrence index to compute the fork point. Only `uuid`, `role`,
// and `text` are needed for that lookup.

export interface NormalizedMessage {
  uuid: string;
  role: "user" | "assistant" | "system" | "result";
  text: string;
}

// Subset of SDKControlGetContextUsageResponse used by the /context UI. Codex
// doesn't expose an equivalent at v1; backends that don't support it return
// null from getContextUsage.
export interface ContextUsage {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories?: { name: string; tokens: number }[];
  memoryFiles?: { path: string; tokens: number }[];
  systemPromptSections?: { name: string; tokens: number }[];
  isAutoCompactEnabled?: boolean;
  autoCompactThreshold?: number;
}

// Backend-agnostic subscription-allowance reading. Same shape as
// SubscriptionUsageWire minus `sampledAtMs` (the orchestrator stamps that at
// commit time). Backends that can't report it return null from
// getSubscriptionUsage - the UI then hides the pill.
export interface SubscriptionUsageWindow {
  label: string;
  usedPercent: number;
  resetsAtMs: number | null;
}

export interface SubscriptionUsage {
  plan: string | null;
  // Non-empty by construction: a backend with no usable window reports
  // "unavailable" instead of an empty array. Order is the backend's stable
  // DISPLAY order (most plan-shaped first), NOT a ranking - the orchestrator
  // picks which window the pill shows.
  windows: SubscriptionUsageWindow[];
}

// Three outcomes, not two. The difference matters because the reading is
// long-lived: it survives /clear and only refreshes at turn boundaries, so
// "the call blew up once" and "this account has no plan allowance" must not
// be the same value.
//   usage       - a reading; replaces whatever was displayed.
//   unavailable - AUTHORITATIVE absence. The backend answered and there is no
//                 plan allowance to report (Claude API-key / Bedrock / Vertex
//                 sessions, a signed-out account). Clears the pill.
//   unknown     - we learned nothing this time (RPC failed, nothing pushed
//                 yet). Leaves the previous reading standing, so a transient
//                 blip can't blank a valid number.
export type SubscriptionUsageResult =
  | { kind: "usage"; usage: SubscriptionUsage }
  | { kind: "unavailable" }
  | { kind: "unknown" };

export interface BackendSession {
  // Stream of normalized events. The persistent consumer (SessionManager.consume)
  // iterates this for the session's lifetime; `close()` ends the iteration.
  stream(): AsyncIterable<NormalizedEvent>;

  // Per-session context usage breakdown for /context. Returns null when the
  // backend doesn't support it (Codex at v1) or the session isn't ready.
  getContextUsage(): Promise<ContextUsage | null>;

  // How much of the signed-in account's subscription allowance is spent.
  // Account-scoped, not conversation-scoped. See SubscriptionUsageResult for
  // why "no plan limits apply" and "the call failed" are different answers.
  // Implementations must swallow their own errors and resolve "unknown"
  // rather than reject - the Claude side rides an explicitly experimental SDK
  // API, and a future change there must degrade to a stale-or-hidden pill,
  // never a crash. Backends are also free to serve a cached value here: this
  // is called on every cumulative-usage event, so the COST policy lives with
  // whoever pays it (Claude throttles its control RPC internally; Codex is
  // reading rate limits the app-server already pushed).
  getSubscriptionUsage(): Promise<SubscriptionUsageResult>;

  // Send a user turn. Attachments are never inlined: each becomes one
  // path-notice text line (shared convention in server/attachment-prompt.ts)
  // and the agent opens the file on demand. Backends only differ in the wire
  // wrapper (Claude: ContentBlockParam[]; Codex: UserInput text items).
  send(text: string, attachments?: AttachmentSpec[]): Promise<void>;

  // Resolve a previously-yielded approval_request. Idempotent per approvalId.
  approve(approvalId: string, decision: ApprovalDecision): Promise<void>;

  // Cancel the in-flight turn. Two dispatch paths in the orchestrator,
  // selected by canAbortInPlace() below:
  //   - In-place (Codex when interruptible): `turn/interrupt` RPC against
  //     the active threadId+turnId; the session stays alive and the natural
  //     turn_completed (status="interrupted") flows through the consumer.
  //   - Replace (Claude or non-interruptible Codex): orchestrator calls
  //     close() and installs a replacement session.
  abort(): Promise<void>;

  // True when abort() will interrupt the in-flight turn in place without
  // closing the underlying subprocess. The orchestrator uses this to skip
  // replaceSession()'s ~1-2s close+respawn drain for healthy Codex sessions.
  // Claude returns false (the SDK has no fine-grained interrupt); Codex
  // returns true when both threadId and the active turnId are set.
  canAbortInPlace(): boolean;

  // Close the session and release resources. Idempotent. Must unblock any
  // parked `stream()` generator.
  close(): void;
}

export interface ModelOption {
  value: string; // backend-specific (Claude: "opus"; Codex: "gpt-5")
  label: string; // UI label
}

export interface PermissionModeOption {
  value: string; // backend-specific value
  label: string; // UI label
}

export interface OneShotOptions {
  // Working directory. Used by Codex (sandbox + RPC client) but ignored by
  // the Claude backend, which forces a neutral cwd internally so caller-cwd
  // context (git status, CLAUDE.md autoload) can't leak into the response.
  cwd?: string;
  modelFamily: string;
  systemPrompt?: string;
  env?: { [key: string]: string | undefined };
  environmentKey?: string;
  environmentRevision?: string;
}

export interface ListModelsOptions {
  cwd: string;
  env?: { [key: string]: string | undefined };
  environmentKey?: string;
  environmentRevision?: string;
  includeHidden?: boolean;
}

// Backend-owned fact about a stored conversation. Callers decide whether a
// missing or empty conversation should start fresh or fail loudly; backends
// own the storage rules needed to classify it.
export type StoredSessionState = "missing" | "empty" | "durable";

export type LoginInstructionKind = "already_authed" | "login" | "not_installed";

export interface LoginInstructions {
  kind: LoginInstructionKind;
  cardEligible: boolean;
  text: string;
  commands?: string[];
}

// Per-model effort option as reported by the backend. Codex's
// ReasoningEffortOption maps directly; backends that don't expose
// per-model efforts can return an empty array.
export interface BackendEffortOption {
  level: string;
  description?: string;
}

// Backend-reported model entry. Shape is intentionally lean - UI uses
// `id` as the wire value (matches CreateSessionOptions.modelFamily) and
// `label` for display. `supportedEfforts` re-renders the effort picker
// per model; `defaultEffort` is the model's preferred effort and is used
// as the snap-to value when the current effort isn't supported.
export interface BackendModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  isFree?: boolean;
  supportedEfforts: BackendEffortOption[];
  defaultEffort?: string;
}

// Result of forkSessionBeforeMessage. Backends choose between producing a
// real linked branch (kind: "fork", with the parent sessionId as
// forkedFromSessionId) and a fresh unrelated session (kind: "fresh", no
// sessionId yet - the orchestrator creates the session and waits for
// system_init to fill the id, just like newConversation). agent-manager
// branches on `kind`: fork → createSession(managed, sessionId) +
// persistSessionFork; fresh → createSession(managed) + skip fork metadata.
export type ForkSessionBeforeMessageResult =
  | { kind: "fork"; sessionId: string; forkedFromSessionId: string }
  | { kind: "fresh" };

export interface Backend {
  readonly capabilities: BackendCapabilities;

  getModelOptions(): ModelOption[];
  getPermissionModes(): PermissionModeOption[];

  // Fetch the auth-appropriate model list from the underlying backend. For
  // Codex this calls `model/list` over the JSON-RPC App Server; for backends
  // without a runtime model API this returns the static getModelOptions()
  // shape promoted to BackendModel. Throws on auth failure or transport
  // error - caller is responsible for surfacing.
  listModels(opts: ListModelsOptions): Promise<BackendModel[]>;

  createSession(opts: CreateSessionOptions): BackendSession;
  resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession;
  inspectStoredSession(
    sessionId: string,
    opts: {
      cwd: string;
      env?: { [key: string]: string | undefined };
      environmentKey?: string;
    },
  ): StoredSessionState;
  checkSessionResumable(
    sessionId: string,
    opts: {
      cwd: string;
      env?: { [key: string]: string | undefined };
      environmentKey?: string;
    },
  ): string | null;

  // Branch a conversation so that `targetMessageId` and everything after it
  // is replaced. The backend resolves predecessor / first-message semantics
  // internally - agent-manager just passes the edited message's id.
  //   - Claude: middle → SDK forkSession at predecessor; first → fresh session
  //   - Codex: thread/fork parent + thread/rollback child to before target's
  //     turn (always linked, including first-message - gives /resume parity)
  forkSessionBeforeMessage(
    sessionId: string,
    targetMessageId: string,
    access?: SessionAccessOptions,
  ): Promise<ForkSessionBeforeMessageResult>;
  getSessionMessages(
    sessionId: string,
    cwd: string,
    access?: SessionAccessOptions,
  ): Promise<NormalizedMessage[]>;

  // Single-prompt operation used by topic generation. Returns the assistant
  // text. Throws on failure.
  oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string>;

  // Inspect a thrown / surfaced error string for known auth-failure signals.
  detectAuthError(text: string): boolean;

  // User-facing instructions for re-authenticating. `text` is surfaced as a
  // system log entry after an auth-error is detected; each entry in
  // `commands`, when present, is emitted as an adjacent terminal-command card
  // the user can click to copy into the built-in terminal. Multiple commands
  // render as a stack of cards in the order returned.
  //
  // `opts.env` carries the agent's resolved spawn env (process.env + office
  // envFile + user envFile, in that override order). Backends that detect
  // env-var auth (e.g. Codex's OPENAI_API_KEY) check it to avoid telling a
  // user to "sign in" when their envFile already authenticates them.
  getLoginInstructions(opts?: {
    env?: { [key: string]: string | undefined };
    environmentKey?: string;
    modelFamily?: string;
  }): LoginInstructions;
}
