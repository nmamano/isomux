// Backend abstraction shared by Claude (claude-agent-sdk) and Codex (App Server).
//
// agent-manager.ts holds runConsumer / queue / abort / fork / topic-gen / etc.
// in backend-agnostic form; engines implement this contract under
// server/backends/{claude,codex}/ and the dispatch lives in
// server/backends/index.ts (`getBackend(agentType)`).
//
// All session-lifecycle methods (`createSession`, `resumeSession`) are
// synchronous to mirror the Claude SDK's current shape — backends defer
// any handshake (Codex `initialize` / first `thread/started`) and surface
// the assigned id via the first `system_init` NormalizedEvent on the stream.

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
// Static per-backend, embedded in the agent payload sent to the UI. The UI
// hides affordances when a capability is false (e.g. greys out the "branch"
// button on a backend without fork support). The wire shape lives in
// shared/types.ts as AgentCapabilities; this is just an alias so backend
// code reads naturally.

import type { AgentCapabilities } from "../../shared/types.ts";
export type BackendCapabilities = AgentCapabilities;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
// Backends use `filename` (relative to the agent's attachments dir, resolved
// via persistence.getFilePath) to read the bytes and embed them in whatever
// shape the underlying transport wants.

import type { Attachment } from "../../shared/types.ts";
export type AttachmentSpec = Attachment;

// ---------------------------------------------------------------------------
// createSession / resumeSession options
// ---------------------------------------------------------------------------
// The orchestrator pre-builds the system prompt and resolves env vars before
// handing off — so backends don't need to know about office/room/user state.
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
  // Codex-only: SandboxMode string ("read-only" / "workspace-write" /
  // "danger-full-access"). Claude backend ignores. Undefined falls back to
  // the backend's default ("workspace-write" for Codex).
  sandbox?: string;
  env?: { [key: string]: string | undefined };
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------
// Same shape Claude's `result` message reports, normalized to camelCase. Codex
// emits these via `thread/tokenUsage/updated` and on `turn/completed`.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// ---------------------------------------------------------------------------
// NormalizedEvent — what `BackendSession.stream()` yields
// ---------------------------------------------------------------------------
// This is the single contract that `processNormalizedEvent` (introduced in
// step 2b) consumes. Per-backend translation happens at the backend boundary:
//
//   Claude SDK message  →  NormalizedEvent (Claude adapter)
//   Codex notification  →  NormalizedEvent (Codex adapter)
//
// approval_request: when emitted, the turn is paused (Codex: server is waiting
// for the response to the ServerRequest; Claude: the SDK's canUseTool callback
// is awaiting a resolve). The orchestrator calls `session.approve()` to unblock.

export type NormalizedEvent =
  // First event from a fresh or resumed session/thread. Carries the backend-
  // assigned id; orchestrator persists this as ManagedAgent.sessionId.
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
  // Tool call. Pairs with a tool_result by `toolUseId`.
  | {
      kind: "tool_call";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  // Tool result. `toolUseId` matches the prior tool_call.
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      attachments?: AttachmentSpec[];
      durationMs?: number;
      isError?: boolean;
    }
  // Per-tool approval ask. Orchestrator's /resolve UX takes over. `suggestions`
  // are intentionally NOT exposed here — backends keep them internally and
  // apply them automatically on `allow_persistent`. Keeps the orchestrator
  // free of backend-specific permission rule shapes.
  | {
      kind: "approval_request";
      approvalId: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
    }
  // Turn boundary. `cost` is total session cost in USD when the backend
  // reports it (Claude: yes; Codex: not yet).
  | {
      kind: "turn_completed";
      status: "completed" | "interrupted" | "failed";
      usage?: TokenUsage;
      cost?: number;
      error?: string;
    }
  // Running token totals between turns (Codex-only at v1). `tokenUsage` is
  // the *delta* since the prior usage event — the orchestrator's accumulator
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
  | { kind: "system_text"; text: string };

// ---------------------------------------------------------------------------
// Approval decisions
// ---------------------------------------------------------------------------
// Three explicit variants matching the existing 3-button /resolve UX. The
// Claude backend translates `allow_persistent` into session-scoped suggestion
// updates; the Codex backend treats `allow_persistent` and `allow_once`
// identically (binary allow/deny semantics).

export type ApprovalDecision =
  | { kind: "allow_persistent" }
  | { kind: "allow_once" }
  | { kind: "deny"; reason?: string };

// ---------------------------------------------------------------------------
// NormalizedMessage — backend-agnostic view of an on-disk session transcript
// ---------------------------------------------------------------------------
// Returned by `Backend.getSessionMessages`. The single consumer at v1 is
// `editMessage` in agent-manager, which finds the matching user message by
// content + occurrence index to compute the fork point. Only `uuid`, `role`,
// and `text` are needed for that lookup.

export interface NormalizedMessage {
  uuid: string;
  role: "user" | "assistant" | "system" | "result";
  text: string;
}

// ---------------------------------------------------------------------------
// BackendSession — per-conversation handle
// ---------------------------------------------------------------------------

export interface BackendSession {
  // Stream of normalized events. The persistent consumer in agent-manager
  // iterates this for the session's lifetime; `close()` ends the iteration.
  stream(): AsyncIterable<NormalizedEvent>;

  // Send a user turn. Attachments are inlined per backend's preferred shape
  // (Claude: ContentBlockParam[]; Codex: per-Item input variants).
  send(text: string, attachments?: AttachmentSpec[]): Promise<void>;

  // Resolve a previously-yielded approval_request. Idempotent per approvalId.
  approve(approvalId: string, decision: ApprovalDecision): Promise<void>;

  // Cancel the in-flight turn. Implementations differ:
  //   - Claude: `session.close()` + caller installs a replacement session
  //   - Codex:  `turn/interrupt` RPC against the active threadId+turnId
  // Returns when the turn is confirmed cancelled; the orchestrator's
  // replaceSession() handles any session swap on top of this.
  abort(): Promise<void>;

  // Close the session and release resources. Idempotent. Must unblock any
  // parked `stream()` generator.
  close(): void;
}

// ---------------------------------------------------------------------------
// Backend — engine-level metadata + session factory
// ---------------------------------------------------------------------------

export interface ModelOption {
  value: string;        // backend-specific (Claude: "opus"; Codex: "gpt-5")
  label: string;        // UI label
}

export interface PermissionModeOption {
  value: string;        // backend-specific value
  label: string;        // UI label
}

export interface OneShotOptions {
  cwd: string;
  modelFamily: string;
  effort: string;
  env?: { [key: string]: string | undefined };
}

export interface Backend {
  readonly capabilities: BackendCapabilities;

  getModelOptions(): ModelOption[];
  getPermissionModes(): PermissionModeOption[];

  createSession(opts: CreateSessionOptions): BackendSession;
  resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession;

  forkSession(sessionId: string, upToMessageId: string): Promise<{ sessionId: string }>;
  getSessionMessages(sessionId: string, cwd: string): Promise<NormalizedMessage[]>;

  // Single-prompt operation used by topic generation. Returns the assistant
  // text. Throws on failure.
  oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string>;

  // Inspect a thrown / surfaced error string for known auth-failure signals.
  detectAuthError(text: string): boolean;

  // User-facing instructions for re-authenticating. Surfaced as a system log
  // entry after an auth-error is detected.
  getLoginInstructions(): string;
}
