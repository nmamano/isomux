// Test-only Backend implementation.
//
// Scripts NormalizedEvents deterministically so the T1 test tier can drive
// AgentManager / CronjobManager without any real LLM call or subprocess. It is
// injected through the managers' backend resolver (deps.resolveBackend), so the
// production getBackend dispatch is never reached under test.
//
// Design notes (mirrors the real BackendSession lifecycle in
// server/backends/claude.ts so it exercises the same orchestrator paths):
//   - stream() yields from an internal buffer and parks on a wake promise when
//     empty; endStream()/close() unblock a parked generator.
//   - push()/pushAll() are the test-facing scripting surface. Pushes after
//     close() or endStream() are ignored (the real stream is terminated too).
//   - close() and abort() are idempotent.
//
// Not imported by any production path.

import type {
  Backend,
  BackendCapabilities,
  BackendSession,
  CreateSessionOptions,
  NormalizedEvent,
  NormalizedMessage,
  ApprovalDecision,
  AttachmentSpec,
  ContextUsage,
  ModelOption,
  PermissionModeOption,
  BackendModel,
  ListModelsOptions,
  OneShotOptions,
  ForkSessionBeforeMessageResult,
  SubscriptionUsageResult,
  TokenUsage,
} from "../backends/types.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

export interface FakeSentMessage {
  text: string;
  attachments?: AttachmentSpec[];
}

export interface FakeSessionConfig {
  // When true (default), createSession/resumeSession enqueues a system_init
  // immediately, mirroring the real contract where the backend-assigned id is
  // surfaced via the first system_init event (see backends/types.ts).
  autoSystemInit?: boolean;
  // slashCommands carried on the auto system_init (default []).
  slashCommands?: string[];
  // canAbortInPlace() return value (default false, matching Claude).
  abortInPlace?: boolean;
  // getContextUsage() return value (default null, matching Codex v1). The
  // function form is called per invocation and lets a test control resolution
  // timing/values (context-fullness commit-protocol races and ordering).
  contextUsage?: ContextUsage | null | (() => Promise<ContextUsage | null>);
  // getSubscriptionUsage() return value. Default "unknown" (nothing learned),
  // which is the Codex-before-any-rate-limit-data shape and leaves the pill
  // untouched. Function form for tests that need per-call control over the
  // value or its resolution timing.
  subscriptionUsage?:
    | SubscriptionUsageResult
    | (() => Promise<SubscriptionUsageResult>);
  // Optional auto-responder invoked on each send() - lets a test script a
  // reply turn without reaching into the session mid-flight.
  onSend?: (
    text: string,
    attachments: AttachmentSpec[] | undefined,
    session: FakeSession,
  ) => void;
  // When true, send() parks on a test-controlled promise instead of resolving
  // immediately - settle it with releaseSends()/failSends(). Models a backend
  // whose send RPC is in flight (queue-reliability tests hold a turn in the
  // send window and inject send failures).
  manualSend?: boolean;
  // When true, close() marks the session closed (pushes ignored, closed
  // observable) but does NOT end the stream - a parked stream() stays parked
  // until the test calls endStream() explicitly. Models a wedged subprocess
  // whose stream never terminates after close (the bounded-drain scenarios);
  // releasable so swap-race tests can unblock the drain mid-test.
  hangOnClose?: boolean;
}

// A scriptable BackendSession. Construct via FakeBackend.createSession /
// resumeSession; drive it from a test with push()/pushAll()/completeTurn().
export class FakeSession implements BackendSession {
  // --- observation surface (test-facing, read-only by convention) ---
  readonly opts: CreateSessionOptions;
  readonly sessionId: string;
  readonly isResume: boolean;
  readonly sent: FakeSentMessage[] = [];
  readonly approvals: { approvalId: string; decision: ApprovalDecision }[] = [];
  abortCount = 0;
  closed = false;

  // --- internals (mirror ClaudeSession's buffer/wake/ended pattern) ---
  private buffer: NormalizedEvent[] = [];
  private resolveWake: (() => void) | null = null;
  private ended = false;
  private readonly abortInPlace: boolean;
  private readonly contextUsage: FakeSessionConfig["contextUsage"];
  private readonly subscriptionUsage: FakeSessionConfig["subscriptionUsage"];
  private readonly onSend?: FakeSessionConfig["onSend"];
  private readonly manualSend: boolean;
  private readonly hangOnClose: boolean;
  private sendWaiters: {
    resolve: () => void;
    reject: (err: unknown) => void;
  }[] = [];

  constructor(
    opts: CreateSessionOptions,
    sessionId: string,
    isResume: boolean,
    cfg: FakeSessionConfig = {},
  ) {
    this.opts = opts;
    this.sessionId = sessionId;
    this.isResume = isResume;
    this.abortInPlace = cfg.abortInPlace ?? false;
    this.contextUsage = cfg.contextUsage ?? null;
    this.subscriptionUsage = cfg.subscriptionUsage ?? { kind: "unknown" };
    this.onSend = cfg.onSend;
    this.manualSend = cfg.manualSend ?? false;
    this.hangOnClose = cfg.hangOnClose ?? false;
    if (cfg.autoSystemInit ?? true) {
      this.push({
        kind: "system_init",
        sessionId,
        slashCommands: cfg.slashCommands ?? [],
      });
    }
  }

  // --- scripting helpers ---

  // Enqueue one event. Ignored once the session is closed/ended (the real
  // stream is terminated at that point too).
  push(ev: NormalizedEvent): void {
    if (this.closed || this.ended) return;
    this.buffer.push(ev);
    this.wake();
  }

  pushAll(evs: NormalizedEvent[]): void {
    for (const ev of evs) this.push(ev);
  }

  // Convenience: optional assistant text followed by a turn_completed boundary.
  completeTurn(opts?: {
    text?: string;
    status?: "completed" | "interrupted" | "failed";
    usage?: TokenUsage;
    cost?: number;
    error?: string;
  }): void {
    if (opts?.text !== undefined) {
      this.push({ kind: "assistant_text", text: opts.text });
    }
    this.push({
      kind: "turn_completed",
      status: opts?.status ?? "completed",
      usage: opts?.usage,
      cost: opts?.cost,
      error: opts?.error,
    });
  }

  // Terminate the event stream (idempotent). Unblocks a parked stream().
  endStream(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  // Settle all parked manualSend sends successfully (in call order).
  releaseSends(): void {
    const waiters = this.sendWaiters;
    this.sendWaiters = [];
    for (const w of waiters) w.resolve();
  }

  // Settle all parked manualSend sends with a rejection (in call order).
  failSends(err: unknown): void {
    const waiters = this.sendWaiters;
    this.sendWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private wake(): void {
    if (this.resolveWake) {
      const r = this.resolveWake;
      this.resolveWake = null;
      r();
    }
  }

  // --- BackendSession contract ---

  async *stream(): AsyncGenerator<NormalizedEvent, void> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.resolveWake = resolve;
      });
    }
  }

  async send(text: string, attachments?: AttachmentSpec[]): Promise<void> {
    this.sent.push({ text, attachments });
    this.onSend?.(text, attachments, this);
    if (this.manualSend) {
      await new Promise<void>((resolve, reject) => {
        this.sendWaiters.push({ resolve, reject });
      });
    }
  }

  // Set by a test to make approve() reject, modelling a backend that will not
  // (or can no longer) accept a permission decision. The orchestrator has to
  // treat that as "the prompt is NOT resolved" rather than reporting success,
  // so the path needs to be reachable under test.
  approveError: Error | null = null;

  approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (this.approveError) return Promise.reject(this.approveError);
    this.approvals.push({ approvalId, decision });
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    this.abortCount++;
  }

  canAbortInPlace(): boolean {
    return this.abortInPlace;
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const v = this.contextUsage;
    return typeof v === "function" ? v() : (v ?? null);
  }

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    const v = this.subscriptionUsage;
    if (typeof v === "function") return v();
    return v ?? { kind: "unknown" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hangOnClose) {
      // Wedged-subprocess model: the stream stays parked (pushes are ignored
      // via `closed`, but the generator never returns) until the test calls
      // endStream() explicitly.
      return;
    }
    this.ended = true;
    this.wake();
  }
}

export interface FakeBackendConfig {
  capabilities?: BackendCapabilities;
  modelOptions?: ModelOption[];
  permissionModes?: PermissionModeOption[];
  models?: BackendModel[];
  // detectAuthError predicate (default: never an auth error).
  isAuthError?: (text: string) => boolean;
  loginInstructions?: { text: string; commands?: string[] };
  // oneShotPrompt response (default deterministic). Function form receives the
  // prompt + opts so topic-gen-style assertions can vary the reply.
  oneShot?: string | ((prompt: string, opts: OneShotOptions) => string);
  forkResult?: ForkSessionBeforeMessageResult;
  sessionMessages?: NormalizedMessage[];
  // Per-session defaults applied to every created/resumed FakeSession.
  session?: FakeSessionConfig;
}

// A Backend whose sessions are scriptable FakeSessions. Construct one per test,
// optionally configured, and inject it via the managers' resolveBackend dep.
export class FakeBackend implements Backend {
  readonly capabilities: BackendCapabilities;

  // --- observation surface ---
  readonly sessions: FakeSession[] = [];
  createSessionCount = 0;
  resumeSessionCount = 0;
  oneShotCount = 0;
  listModelsCount = 0;
  forkCount = 0;

  private readonly cfg: FakeBackendConfig;
  private sessionCounter = 0;

  constructor(cfg: FakeBackendConfig = {}) {
    this.cfg = cfg;
    this.capabilities = cfg.capabilities ?? { ...DEFAULT_AGENT_CAPABILITIES };
  }

  // --- test helpers ---

  get lastSession(): FakeSession | undefined {
    return this.sessions[this.sessions.length - 1];
  }

  // Most-recently-created session for an agent (across reconnects).
  sessionForAgent(agentId: string): FakeSession | undefined {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i].opts.agentId === agentId) return this.sessions[i];
    }
    return undefined;
  }

  // --- Backend contract ---

  getModelOptions(): ModelOption[] {
    return this.cfg.modelOptions ?? [{ value: "fake", label: "Fake" }];
  }

  getPermissionModes(): PermissionModeOption[] {
    return this.cfg.permissionModes ?? [{ value: "default", label: "Default" }];
  }

  async listModels(_opts: ListModelsOptions): Promise<BackendModel[]> {
    this.listModelsCount++;
    return (
      this.cfg.models ?? [
        { id: "fake", label: "Fake", supportedEfforts: [], isDefault: true },
      ]
    );
  }

  createSession(opts: CreateSessionOptions): BackendSession {
    this.createSessionCount++;
    const sessionId = `fake-session-${++this.sessionCounter}`;
    const session = new FakeSession(opts, sessionId, false, this.cfg.session);
    this.sessions.push(session);
    return session;
  }

  resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession {
    this.resumeSessionCount++;
    const session = new FakeSession(opts, sessionId, true, this.cfg.session);
    this.sessions.push(session);
    return session;
  }

  async forkSessionBeforeMessage(
    _sessionId: string,
    _targetMessageId: string,
  ): Promise<ForkSessionBeforeMessageResult> {
    this.forkCount++;
    return this.cfg.forkResult ?? { kind: "fresh" };
  }

  async getSessionMessages(
    _sessionId: string,
    _cwd: string,
  ): Promise<NormalizedMessage[]> {
    return this.cfg.sessionMessages ?? [];
  }

  async oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string> {
    this.oneShotCount++;
    const r = this.cfg.oneShot;
    if (typeof r === "function") return r(prompt, opts);
    return r ?? "fake response";
  }

  detectAuthError(text: string): boolean {
    return this.cfg.isAuthError ? this.cfg.isAuthError(text) : false;
  }

  getLoginInstructions(_opts?: {
    env?: { [key: string]: string | undefined };
  }): { text: string; commands?: string[] } {
    return this.cfg.loginInstructions ?? { text: "fake login instructions" };
  }
}
