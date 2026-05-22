// Codex backend adapter.
//
// Implements the Backend / BackendSession contracts (server/backends/types.ts)
// against the Codex App Server's JSON-RPC lite protocol via the
// JsonRpcLiteClient in ./client.ts. One CodexSession owns one threadId and
// one subprocess for v1 — symmetric with Claude. The client layer is built so
// a future shared-subprocess deployment can swap in without touching this
// adapter (subscribers filter by threadId from day one).
//
// Critical invariants this code maintains (per the Codex Expert's review):
//
//   1. Exactly one turn_completed NormalizedEvent per send(). Codex emits one
//      turn/completed per turn (Completed or Failed); turn/interrupted maps
//      to status:"interrupted". Subprocess death mid-turn synthesizes a
//      failed turn_completed so the orchestrator's pendingTurn unblocks.
//
//   2. Per-thread filtering. Every codex notification with a threadId is
//      filtered against this session's threadId. Sub-agent / review-mode
//      child threads have their own ids and must never resolve our turn.
//
//   3. experimentalApi: true at initialize. We generated schemas with
//      --experimental, so missing this flag would silently strip experimental
//      fields on the wire.

import { readFileSync, statSync } from "fs";
import { basename } from "path";

import { getFilePath, saveFile } from "../../persistence.ts";
import { mimeTypeForFilename } from "../../mime-types.ts";
import { errMessage } from "../../../shared/errors.ts";
import { BackendNotConfiguredError } from "../../internal-types.ts";

import type {
  ApprovalDecision,
  AttachmentSpec,
  Backend,
  BackendCapabilities,
  BackendEffortOption,
  BackendModel,
  BackendSession,
  ContextUsage,
  CreateSessionOptions,
  ForkSessionBeforeMessageResult,
  ListModelsOptions,
  ModelOption,
  NormalizedEvent,
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
  TokenUsage,
} from "../types.ts";

import {
  JsonRpcLiteClient,
  PASS,
  type JsonRpcId,
  type JsonRpcLiteClientOptions,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./client.ts";
import { getCodexLoginCommands, isCodexAuthenticated } from "./native-bin.ts";

import type { InitializeParams } from "./_generated/InitializeParams.ts";
import type { Model as CodexProtocolModel } from "./_generated/v2/Model.ts";
import type { ModelListParams } from "./_generated/v2/ModelListParams.ts";
import type { ModelListResponse } from "./_generated/v2/ModelListResponse.ts";
import type { ThreadRollbackParams } from "./_generated/v2/ThreadRollbackParams.ts";
import type { ThreadRollbackResponse } from "./_generated/v2/ThreadRollbackResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./_generated/v2/ThreadTokenUsageUpdatedNotification.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Isomux runs codex against its own isolated CODEX_HOME (~/.isomux/codex-home/
// by default), separate from the user's interactive `~/.codex/`. That means
// the user needs a one-time `codex login` against isomux's CODEX_HOME — the
// [Copy to terminal] card alongside this message has the exact command.
//
// Two [Copy to terminal] cards follow: browser OAuth (default) and
// `--device-auth` (remote / headless). Both target the default
// `~/.isomux/codex-home/`. Users with a per-user envFile `CODEX_HOME`
// (e.g. `~/.isomux-users/<name>/.codex` for billing isolation, see
// internal-docs/isolation-design.md) need to prefix the pasted command
// with their own `CODEX_HOME=<path>` before pressing Enter — the wrapper's
// default only kicks in when CODEX_HOME is unset.
const LOGIN_INSTRUCTIONS = `To sign in to Codex, click [Copy to terminal] on one of the cards below:

- \`~/.isomux/bin/codex login\`: if running isomux locally
- \`~/.isomux/bin/codex login --device-auth\`: for remote or headless hosts (e.g. a Mac mini or Linux box you reach over a VPN)

Press Enter to run, follow the prompts, then \`/clear\` this conversation to apply the new auth. Other codex agents apply on their next \`/clear\`. Or add \`OPENAI_API_KEY\` to your envFile (User Settings → Env File Path, then \`/clear\`). envFile users: prefix the command with \`CODEX_HOME=<your custom Codex home>\` first.`;

// Surfaced when an auth-error fires but the office already has a valid
// codex auth (auth.json present, or OPENAI_API_KEY in env). The user's
// signed in; their session just predates the login, so a /clear is all
// they need.
const ALREADY_AUTHED_INSTRUCTIONS = `Codex is signed in. Type \`/clear\` to refresh this agent's session and pick up the new auth.`;

const AUTH_ERROR_PATTERNS =
  /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|chatgpt.*login|openai_api_key|403|401/i;

// Capability flags for the Codex backend. Match the spec's parity table.
// hooks: false — Codex emits hook/* notifications but provides no
// programmatic register-from-client surface at 0.130 (v1).
// edit: true — implemented via fork-then-rollback: thread/fork the parent
// (preserves it), then thread/rollback the child by the number of turns to
// drop. Matches Claude's preserved-parent UX without per-message fork
// support upstream. See forkSessionBeforeMessage below.
const CAPABILITIES: BackendCapabilities = {
  fork: false,
  hooks: false,
  skills: true,
  oneShot: true,
  canUseTool: true,
  topicGen: true,
  edit: true,
  mcp: true,
};

// Model options. Hardcoded at v1 — known limitation: model/list (Codex RPC)
// would return the auth-appropriate subset (ChatGPT-login vs API-key users
// see different sets, and each model declares its own
// supportedReasoningEfforts). Wiring model/list at session bootstrap +
// per-model effort picker is task 3929f8ec. Slugs verified against `codex
// debug models` on codex-cli 0.130.0 (2026-05-11); mirror of CODEX_MODELS
// in shared/types.ts.
const MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];

function modelDisplayLabel(slug: string): string {
  return MODEL_OPTIONS.find((m) => m.value === slug)?.label ?? slug;
}

// Permission/approval mode options. AskForApproval enum minus the deprecated
// "on-failure" variant (codex 0.130 emits a deprecation warning on use). The
// granular variant is gated behind experimentalApi but deferred to v1.x per
// the spec.
const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "untrusted", label: "Untrusted — ask on every tool" },
  { value: "on-request", label: "On request — ask when model asks" },
  { value: "never", label: "Never ask (use with sandbox)" },
];

// Default sandbox if the caller doesn't pass one. workspace-write is the
// "Claude-equivalent default" preset from the spec's reference mapping.
const DEFAULT_SANDBOX_MODE = "workspace-write";

const CLIENT_INFO_NAME = "isomux";
const CLIENT_INFO_VERSION = "1.0.0";

// Cap for inlined text-ish attachments. Larger files get a stub pointer so the
// model still knows the file is there without us blasting megabytes of stray
// logs / build output into context.
const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024;

// Media-type allowlist for inlining attachment contents into the prompt.
// Anything outside this list (binary blobs, unknown formats) gets a stub.
const INLINE_TEXT_MEDIA_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
];

function isInlinableTextMedia(mediaType: string): boolean {
  return INLINE_TEXT_MEDIA_PREFIXES.some((prefix) =>
    mediaType.startsWith(prefix),
  );
}

function formatWebSearchAction(action: unknown): string {
  if (!action || typeof action !== "object") return "";
  const a = action as Record<string, unknown>;
  switch (a.type) {
    case "search": {
      const queries = Array.isArray(a.queries)
        ? a.queries.filter((q): q is string => typeof q === "string")
        : [];
      const query = queries.length
        ? queries.join(" | ")
        : typeof a.query === "string"
          ? a.query
          : "";
      return query ? `search: ${query}` : "search";
    }
    case "openPage": {
      const url = typeof a.url === "string" ? a.url : "";
      return url ? `openPage: ${url}` : "openPage";
    }
    case "findInPage": {
      const pattern = typeof a.pattern === "string" ? a.pattern : "";
      const url = typeof a.url === "string" ? a.url : "";
      if (pattern && url) return `findInPage: ${pattern} @ ${url}`;
      return pattern || url ? `findInPage: ${pattern || url}` : "findInPage";
    }
    case "other":
      return "other";
    default:
      return "";
  }
}

function compactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  // Display-only cleanup for approval context; downstream logic never
  // introspects this object.
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value == null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value).length > 0;
      return true;
    }),
  );
}

// Raw turn shape from thread/read includeTurns:true. We type loosely here
// because the orchestrator only consumes a couple of fields; the generated
// Turn type is richer than we need.
interface RawTurn {
  id: string;
  // ThreadItem union is broad (~20 variants); the consumers here narrow by
  // `type` and read id/text/content directly. Keep loose to avoid coupling
  // the helper to the generated schema.
  items: unknown[];
}

// Single thread/read call returning the parent thread's turn list. Used by
// both getSessionMessages (flattens to NormalizedMessage[]) and
// forkSessionBeforeMessage (needs turn structure for rollback arithmetic).
async function readThreadTurns(
  client: JsonRpcLiteClient,
  threadId: string,
): Promise<RawTurn[]> {
  const resp = await client.request<{ thread: { turns?: unknown[] } }>(
    "thread/read",
    { threadId, includeTurns: true },
  );
  const rawTurns = resp.thread?.turns ?? [];
  return rawTurns.map((raw): RawTurn => {
    const t = raw as { id?: unknown; items?: unknown };
    return {
      id: typeof t?.id === "string" ? t.id : "",
      items: Array.isArray(t?.items) ? t.items : [],
    };
  });
}

// Locate the turn (by index) whose items array contains an item with the
// given id. Returns -1 if not found. Used by forkSessionBeforeMessage to
// translate from item-level message uuid → turn-level rollback count.
function findTurnIndexContainingItemId(
  turns: RawTurn[],
  itemId: string,
): number {
  for (let i = 0; i < turns.length; i++) {
    const items = turns[i].items;
    for (const item of items) {
      if ((item as { id?: unknown })?.id === itemId) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// CodexSession
// ---------------------------------------------------------------------------
//
// State machine:
//
//   constructor()
//        │  (spawn subprocess; start bootstrap)
//        ▼
//   INITIALIZING ──── initialize() + thread/start ────► READY (system_init emitted)
//        │                                                  │
//        │                                                  │  send()/approve()/abort()
//        ▼                                                  │
//      CLOSED  ◄──────── close() ────────────────────────── │
//
// While INITIALIZING, send/approve/abort calls queue or reject (we just
// reject — orchestrator-level state prevents calls until system_init lands).
//
// Stream output is buffered exactly like ClaudeSession: enqueue + wake the
// stream's parked promise; stream() yields from buffer.

interface PendingApproval {
  jsonRpcId: JsonRpcId;
  toolName: string;
  // The server-request method that issued this approval. Different methods
  // have different response enums (legacy ReviewDecision vs v2
  // CommandExecutionApprovalDecision vs v2 FileChangeApprovalDecision); we
  // keep the method here so approve() can pick the right wire shape.
  method: string;
  // Settles the JsonRpcLiteClient handler-chain promise that's anchoring this
  // approval. Resolving it lets the client auto-respond with the payload and
  // releases the parked handler frame; rejecting unwinds the await. Without
  // these the handler held a `new Promise(() => {})` that never settled, so
  // each approval leaked one parked handler frame for the life of the session.
  resolve: (response: unknown) => void;
  reject: (err: unknown) => void;
}

interface CodexSessionInitOpts {
  agentId: string;
  cwd: string;
  systemPrompt: string;
  modelFamily: string;
  effort: string;
  permissionMode: string;
  sandbox?: string; // SandboxMode enum string; falls back to DEFAULT_SANDBOX_MODE
  env?: { [key: string]: string | undefined };
  resumeThreadId?: string;
  ephemeral?: boolean;
}

class CodexSession implements BackendSession {
  private client: JsonRpcLiteClient;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private buffer: NormalizedEvent[] = [];
  private resolveWake: (() => void) | null = null;
  private ended = false;
  private closed = false;
  // Tracks whether we've yielded turn_completed for the current turn so we
  // can synthesize a failed one on subprocess exit if not.
  private turnInFlight = false;
  // Auth-error coalescing for codex stderr. Codex CLI internally retries the
  // OpenAI websocket 5+ times on 401 with exponential backoff, emitting one
  // `ERROR ... 401 Unauthorized` stderr line per retry. Forwarding each one
  // as system_text triggers the auth-detect path in agent-manager on every
  // line and pastes the sign-in card repeatedly — what task 5811bae6
  // described as the "infinite loop" UX. Symmetric with the Claude SDK,
  // which emits at most one auth signal per send: gate auth-shaped stderr
  // to one signal per user-initiated turn (`authSignalsAllowedThisTurn`
  // opens before turn/start in send(), closes on turn/completed or send
  // failure; `authSignalEmittedThisTurn` is the once-per-turn latch).
  // Pre-turn stderr (codex's startup websocket pre-warm) is silenced.
  private authSignalsAllowedThisTurn = false;
  private authSignalEmittedThisTurn = false;
  // Set when we ourselves issue turn/interrupt to short-circuit codex's
  // ~12s websocket retry budget on a doomed-by-auth turn. The natural
  // turn/completed from codex will land with status="interrupted"; the
  // turn/completed handler maps it back to status="failed" + the standard
  // auth summary so the user sees a clear failure, not a vague "interrupted".
  private selfInterruptedForAuth = false;
  // jsonRpcId-keyed map of in-flight server-initiated approval requests. The
  // orchestrator references these by approvalId == jsonRpcId.
  private pendingApprovals = new Map<string, PendingApproval>();
  // Running totals from Codex's cumulative tokenUsage notifications. We diff
  // against this when emitting usage_update so the orchestrator's accumulator
  // (which sums deltas) gets the right value.
  private lastCumulativeUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  // Latest snapshot for /context. We use the `last` (most recent turn) field
  // of the tokenUsage notification, not `total` (cumulative-since-thread-
  // start). `last.inputTokens` is the prompt size of the last turn — i.e.
  // what was in context when the model spoke — and `last.outputTokens` is
  // what was appended after. Together they approximate the context fullness
  // heading into the next turn. Using `total.*` here would mis-report cache
  // re-reads (which sum across turns) as live context usage. Null until the
  // first notification arrives (typically right after the first turn).
  private modelContextWindow: number | null = null;
  private lastTurnBreakdown: {
    inputNewTokens: number;
    inputCachedTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null = null;
  // Resolves when bootstrap (initialize + thread/start) completes — success
  // or failure. send() / approve() / abort() await this so they don't race
  // the async setup. On failure threadId stays null; callers see a clear
  // "bootstrap failed" error instead of "not initialized yet."
  private bootstrapPromise: Promise<void>;
  // Captured at bootstrap-failure time, re-thrown by send() on the
  // first user message attempt so the actionable error (install hint,
  // auth failure, etc.) lands in chat AND transitions the agent to
  // error state THEN — matches Claude's lazy-auth UX where the agent
  // looks idle from spawn until the user actually messages it.
  private bootstrapError: Error | null = null;

  constructor(private readonly opts: CodexSessionInitOpts) {
    // JsonRpcLiteClient.start() applies the isomux CODEX_HOME default so
    // every codex subprocess (session bootstrap + listModels + oneShot +
    // fork + read) spawns under the same effective env. Per-user envFile
    // CODEX_HOME (see internal-docs/isolation-design.md) is honored
    // verbatim by withIsomuxCodexHome.
    const clientOpts: JsonRpcLiteClientOptions = {
      cwd: opts.cwd,
      env: opts.env,
    };
    this.client = new JsonRpcLiteClient(clientOpts);
    this.client.onStderr((chunk) => this.handleStderr(chunk));
    this.client.onNotification((n) => this.handleNotification(n));
    this.client.onServerRequest((req) => this.handleServerRequest(req));
    this.client.onExit((code, signal) =>
      this.handleSubprocessExit(code, signal),
    );
    this.bootstrapPromise = this.bootstrap();
  }

  // -------------------------------------------------------------------------
  // Bootstrap: spawn → initialize → thread/start → emit system_init
  // -------------------------------------------------------------------------

  private async bootstrap(): Promise<void> {
    try {
      this.client.start();
      const initParams: InitializeParams = {
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      };
      await this.client.initialize(initParams);

      if (this.opts.resumeThreadId) {
        // Resume an existing thread. Pass current settings as overrides so
        // a UI-side change to permissionMode/sandbox/model/systemPrompt
        // propagates instead of being stuck on whatever the thread was born
        // with — editAgent replaceSession → resumeSession is the path that
        // exercises this, and without the overrides the resumed thread
        // silently keeps the original policy.
        const resumeResp = await this.client.request<{
          thread: { id: string };
        }>("thread/resume", {
          threadId: this.opts.resumeThreadId,
          approvalPolicy: this.opts.permissionMode,
          sandbox: this.opts.sandbox ?? DEFAULT_SANDBOX_MODE,
          model: this.opts.modelFamily,
          developerInstructions: this.opts.systemPrompt,
          persistExtendedHistory: false,
        });
        this.threadId = resumeResp.thread.id;
      } else {
        // Start a new thread.
        const startParams = this.buildThreadStartParams();
        const startResp = await this.client.request<{ thread: { id: string } }>(
          "thread/start",
          startParams,
        );
        this.threadId = startResp.thread.id;
      }

      this.enqueue({
        kind: "system_init",
        sessionId: this.threadId,
        slashCommands: [],
        model: this.opts.modelFamily,
      });
    } catch (err) {
      // Defer the error to send(): we want this agent to look idle from
      // spawn so the desk indicator doesn't go red before the user has
      // even tried it (Claude's auth-failure UX is the reference). Emit
      // system_init so the orchestrator transitions us to idle instead
      // of leaving the agent in pre-init; sessionId is unused for a
      // never-started thread (nothing to persist, nothing to resume).
      this.bootstrapError =
        err instanceof Error ? err : new Error(errMessage(err));
      this.enqueue({
        kind: "system_init",
        sessionId: "",
        slashCommands: [],
        model: this.opts.modelFamily,
      });
      this.markEnded();
    }
  }

  private buildThreadStartParams(): Record<string, unknown> {
    // sandbox is a SandboxMode enum string; approvalPolicy is the
    // AskForApproval enum string. We deliberately keep this as a plain
    // Record so the codegen union strictness doesn't fight us — the wire
    // schema is what we're targeting.
    const params: Record<string, unknown> = {
      cwd: this.opts.cwd,
      developerInstructions: this.opts.systemPrompt,
      model: this.opts.modelFamily,
      sandbox: this.opts.sandbox ?? DEFAULT_SANDBOX_MODE,
      approvalPolicy: this.opts.permissionMode,
      experimentalRawEvents: false,
      // persistExtendedHistory is deprecated in 0.130 and ignored by the
      // server, but the wire schema still requires the field.
      persistExtendedHistory: false,
    };
    if (this.opts.ephemeral) params.ephemeral = true;
    if (this.opts.effort) {
      // ReasoningEffort enum string. Best-effort pass-through; codex
      // accepts a subset, mismatched values fail at handshake time.
      params.reasoningEffort = this.opts.effort;
    }
    return params;
  }

  // -------------------------------------------------------------------------
  // BackendSession surface
  // -------------------------------------------------------------------------

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
    // Wait for bootstrap (initialize + thread/start) to finish so callers
    // who fire send() immediately after a session swap don't race. After
    // bootstrap, threadId is either set (success) or still null (bootstrap
    // failed — the orchestrator already saw the `error` event from
    // bootstrap and routed it; raising here surfaces the same condition to
    // the awaiting sendMessage / flushQueue caller).
    await this.bootstrapPromise;
    if (this.closed) throw new Error("CodexSession.send: session is closed");
    if (!this.threadId) {
      // Bootstrap failed — wrap the captured error in BackendNotConfiguredError
      // so sendMessage / flushQueue / editMessage know to surface this calmly
      // (system log entry, agent stays idle) rather than as a real turn error
      // that flips the agent to error state. The actionable text (auth prompt,
      // bundled-binary missing hint, etc.) is already in bootstrapError.message
      // and gets surfaced verbatim — no "Error:" wrapping.
      throw new BackendNotConfiguredError(
        this.bootstrapError?.message ?? "Codex bootstrap failed; cannot send",
      );
    }

    const input = buildCodexUserInput(text, attachments, this.opts.agentId);
    // Open the auth-stderr gate before turn/start. The gate must be open
    // during turn/start's await window because codex's websocket retry burst
    // can land on stderr before the RPC returns. If turn/start itself throws,
    // close the gate so subsequent unsolicited codex stderr stays silent.
    this.authSignalsAllowedThisTurn = true;
    this.authSignalEmittedThisTurn = false;
    // Only flip turnInFlight after turn/start succeeds. If the request throws
    // (e.g. wire error) we don't want handleSubprocessExit to later synthesize
    // a phantom failed turn_completed for a turn that never actually started
    // — the orchestrator would surface a bogus mid-turn failure.
    try {
      await this.client.request("turn/start", {
        threadId: this.threadId,
        input,
      });
    } catch (err) {
      // If turn/start itself rejects with an auth-shaped error (a future
      // codex revision could pre-check auth before accepting the turn),
      // emit the same single auth signal we'd emit from stderr so the
      // user still gets the sign-in card. Without this, flushQueue's
      // generic catch logs "Error flushing queue: ..." with no auth
      // detection and the login card is lost on this code path. The
      // helper enforces the once-per-turn latch; the post-throw clears
      // also close the gate so any remaining auth-shaped notification
      // for this dead turn stays silent.
      const message = errMessage(err);
      if (AUTH_ERROR_PATTERNS.test(message)) {
        this.enqueueAuthAwareSystemText(
          `Codex auth error during turn start: ${message}`,
        );
      }
      this.authSignalsAllowedThisTurn = false;
      this.authSignalEmittedThisTurn = false;
      this.selfInterruptedForAuth = false;
      throw err;
    }
    this.turnInFlight = true;
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.bootstrapPromise;
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    this.pendingApprovals.delete(approvalId);
    const decisionWire = mapApprovalDecision(pending.method, decision);
    // Resolving the deferred releases the JsonRpcLiteClient's handler-chain
    // await; the client auto-responds with this payload. (Previously we
    // called client.respond() directly while leaving the promise pending,
    // which leaked one parked handler frame per approval.) The enum variant
    // set differs per method — see mapApprovalDecision for the routing.
    pending.resolve({ decision: decisionWire });
  }

  async abort(): Promise<void> {
    await this.bootstrapPromise;
    if (this.closed) return;
    if (!this.threadId || !this.activeTurnId) {
      // Nothing to interrupt — no in-flight turn (either bootstrap failed
      // or no send happened yet).
      return;
    }
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch (err) {
      this.enqueue({
        kind: "system_text",
        text: `Codex interrupt failed: ${errMessage(err)}`,
      });
    }
    // Release any in-flight server-initiated approval requests so the parked
    // JsonRpcLiteClient handler frames don't leak across to the next turn.
    // close() can use respondWithError because client.close() runs synchronously
    // right after and short-circuits the deferred-rejection's auto-respond — the
    // hot-abort path doesn't close the client, so we must resolve cleanly to
    // avoid double-responding on the wire (one -32000, then a -32603 from the
    // catch in JsonRpcLiteClient.handleServerRequest). Routing through
    // mapApprovalDecision keeps the wire shape identical to a user-driven deny.
    for (const [, pending] of this.pendingApprovals) {
      try {
        const decisionWire = mapApprovalDecision(pending.method, {
          kind: "deny",
          reason: "Turn interrupted",
        });
        pending.resolve({ decision: decisionWire });
      } catch {}
    }
    this.pendingApprovals.clear();
  }

  canAbortInPlace(): boolean {
    return !this.closed && this.threadId !== null && this.activeTurnId !== null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Tell codex about in-flight approvals before tearing down. Respond on
    // the wire FIRST: the deferred rejection below would also trigger an
    // auto-respond, but by the time that fires we've called client.close()
    // and the response is dropped — so the explicit respondWithError is what
    // codex actually sees. Then reject the deferred so the parked handler
    // frame unwinds and the promise frees.
    for (const [, pending] of this.pendingApprovals) {
      try {
        this.client.respondWithError(
          pending.jsonRpcId,
          -32000,
          "Session closed",
        );
      } catch {}
      try {
        pending.reject(new Error("Session closed"));
      } catch {}
    }
    this.pendingApprovals.clear();
    // Fire-and-forget close on the client; subprocess exit handler tidies up.
    void this.client.close();
    this.markEnded();
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    // Codex doesn't expose a context-usage RPC; we synthesize one from the
    // last-turn breakdown cached in the `thread/tokenUsage/updated` handler.
    // See the lastTurnBreakdown field comment for why `last.*` is the right
    // signal (vs `total.*`, which sums cache re-reads across turns).
    if (
      this.lastTurnBreakdown === null ||
      this.modelContextWindow === null ||
      this.modelContextWindow <= 0
    ) {
      return null;
    }
    const maxTokens = this.modelContextWindow;
    const b = this.lastTurnBreakdown;
    const totalTokens =
      b.inputNewTokens +
      b.inputCachedTokens +
      b.outputTokens +
      b.reasoningOutputTokens;
    const percentage = Math.min(100, (totalTokens / maxTokens) * 100);
    const categories = [
      { name: "Input (new)", tokens: b.inputNewTokens },
      { name: "Input (cached)", tokens: b.inputCachedTokens },
      { name: "Output", tokens: b.outputTokens },
      { name: "Reasoning", tokens: b.reasoningOutputTokens },
    ];
    return {
      model: modelDisplayLabel(this.opts.modelFamily),
      totalTokens,
      maxTokens,
      percentage,
      categories,
    };
  }

  // -------------------------------------------------------------------------
  // Buffer / wake helpers
  // -------------------------------------------------------------------------

  private enqueue(ev: NormalizedEvent): void {
    this.buffer.push(ev);
    this.wake();
  }

  // Funnel for system_text emissions whose payload may carry codex-sourced
  // text (stderr, advisory notifications, error messages). Applies the
  // per-turn auth-coalescing gate so any auth-shaped string — regardless of
  // which codex path produced it — counts as the one allowed signal per
  // user-initiated turn. Hardcoded system_text (image notices, model-not-
  // supported, auto-declined cards, etc.) bypasses this helper because we
  // know its content is safe.
  private enqueueAuthAwareSystemText(text: string): void {
    if (AUTH_ERROR_PATTERNS.test(text)) {
      if (!this.authSignalsAllowedThisTurn) return;
      if (this.authSignalEmittedThisTurn) return;
      this.authSignalEmittedThisTurn = true;
      // Short-circuit codex's websocket retry budget. The retries are doomed,
      // and without an interrupt the agent sits in "thinking" for ~12s
      // before turn/completed lands — misleading UX (the model never ran).
      this.requestSelfInterruptForAuth();
    }
    this.enqueue({ kind: "system_text", text });
  }

  // Fire-and-forget turn/interrupt when an auth signal latches. Best-effort:
  // if activeTurnId hasn't been observed yet (turn/started notification
  // hasn't arrived) or codex doesn't honor the interrupt, we fall back to
  // the natural ~12s retry-exhaustion timer.
  private requestSelfInterruptForAuth(): void {
    if (this.selfInterruptedForAuth) return;
    if (!this.threadId || !this.activeTurnId) return;
    this.selfInterruptedForAuth = true;
    this.client
      .request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      })
      .catch(() => {});
  }

  private attachmentFromPath(rawPath: unknown): AttachmentSpec | null {
    if (typeof rawPath !== "string" || rawPath.length === 0) return null;
    try {
      const st = statSync(rawPath);
      if (!st.isFile()) return null;
      return saveFile(
        this.opts.agentId,
        readFileSync(rawPath),
        mimeTypeForFilename(rawPath),
        basename(rawPath),
      );
    } catch {
      return null;
    }
  }

  private wake(): void {
    if (this.resolveWake) {
      const r = this.resolveWake;
      this.resolveWake = null;
      r();
    }
  }

  private markEnded(): void {
    this.ended = true;
    this.wake();
  }

  // -------------------------------------------------------------------------
  // Notification routing
  // -------------------------------------------------------------------------

  private handleNotification(n: JsonRpcNotification): void {
    const params = n.params as Record<string, unknown> | null | undefined;
    // Per-thread filter: every notification carrying a threadId must match
    // ours. Sub-agent / review-mode child threads have their own ids.
    const eventThreadId = params?.threadId;
    if (
      eventThreadId !== undefined &&
      this.threadId &&
      eventThreadId !== this.threadId
    ) {
      return;
    }

    switch (n.method) {
      // ---- Turn lifecycle ----
      case "turn/started": {
        const turn = params?.turn as { id?: string } | undefined;
        if (turn?.id) this.activeTurnId = turn.id;
        break;
      }
      case "turn/completed": {
        const turn = params?.turn as
          | {
              status?: string;
              error?: { message?: string } | null;
            }
          | undefined;
        const rawStatus = mapTurnStatus(turn?.status);
        const rawError = turn?.error?.message ?? undefined;
        const wasSelfInterruptForAuth = this.selfInterruptedForAuth;
        this.activeTurnId = null;
        this.turnInFlight = false;
        // "Model not supported" safety net. The spawn / edit dialog now
        // fetches model/list per-auth, so this branch should be rare —
        // most commonly it'll fire when the user's auth tier changed since
        // the agent was created. Re-opening settings reloads the list.
        if (
          rawError &&
          /model.*not supported|not supported.*model/i.test(rawError)
        ) {
          this.enqueue({
            kind: "system_text",
            text: "This Codex model isn't available on your current login. Open the agent's settings to refresh the model list and pick one that is.",
          });
        }
        // If we self-interrupted to short-circuit a doomed-by-auth turn,
        // remap status="interrupted" → "failed" so the user sees a clear
        // failure (not a misleading "interrupted" — which the UI treats as
        // a user-initiated stop). Substitute the error to the same auth
        // summary used for the stderr-driven path; the codex-emitted error
        // on a client-interrupt is usually empty or unhelpful.
        const status = wasSelfInterruptForAuth ? "failed" : rawStatus;
        // Substitute the turn-level error to a non-auth-shaped summary so
        // agent-manager's auth-detect path doesn't re-fire on the same root
        // cause. The user still has the concrete 401 detail from the earlier
        // [codex stderr] system_text. Whole-string substitution (not
        // keyword-stripping) keeps the rewritten message readable.
        const turnLevelAuthShaped =
          !!rawError && AUTH_ERROR_PATTERNS.test(rawError);
        const causedByAuth =
          this.authSignalEmittedThisTurn &&
          (wasSelfInterruptForAuth || turnLevelAuthShaped);
        const error = causedByAuth
          ? "Codex turn failed after an auth error; see the prior Codex auth notice."
          : rawError;
        // Close the per-turn auth-coalescing gate now that the turn has
        // settled. Next user send opens it again in send().
        this.authSignalsAllowedThisTurn = false;
        this.authSignalEmittedThisTurn = false;
        this.selfInterruptedForAuth = false;
        this.enqueue({
          kind: "turn_completed",
          status,
          error,
          // Signal causedByAuth so agent-manager keeps the agent in
          // waiting_for_response (auth issue → user needs to sign in)
          // instead of "error" (which would imply something crashed).
          // The error string itself is rewritten to a non-auth-shaped
          // summary above, so the orchestrator's auth-detect regex
          // wouldn't catch it.
          ...(causedByAuth ? { causedByAuth: true } : {}),
        });
        break;
      }

      // ---- Token usage ----
      // Wire shape: ThreadTokenUsageUpdatedNotification (v2). The payload
      // carries two breakdowns: `total` (cumulative since thread start) and
      // `last` (most recent turn only). We use them for different things:
      //   - `total` → usage_update delta (lifetime billing accounting)
      //   - `last`  → /context snapshot (current context fullness)
      // TokenUsageBreakdown field semantics (per OpenAI):
      //   inputTokens   = prompt total (incl. cache hits)
      //   cachedInputTokens = subset that came from cache
      //   outputTokens  = completion tokens (reasoning is a subset for
      //                    reasoning-capable models, not separate)
      //   reasoningOutputTokens = reasoning subset of outputTokens
      // Translation to our Claude-style TokenUsage:
      //   ours inputTokens = inputTokens - cachedInputTokens (new prompt)
      //   ours cacheReadInputTokens = cachedInputTokens
      //   ours cacheCreationInputTokens = 0 (Codex doesn't separate)
      //   ours outputTokens = outputTokens (reasoning already included)
      case "thread/tokenUsage/updated": {
        // Typed against the generated v2 schema so tsc catches future wire
        // drift — this handler was previously broken by exactly that kind of
        // schema mismatch (was reading `params.usage`, never existed in v2).
        const notif = params as
          | ThreadTokenUsageUpdatedNotification
          | null
          | undefined;
        const tu = notif?.tokenUsage;
        if (!tu) break;
        // `total` drives the cumulative usage_update event (lifetime billing).
        const total = tu.total;
        const totalInput = total.inputTokens;
        const totalCached = total.cachedInputTokens;
        const totalOutput = total.outputTokens;
        const cumulative: TokenUsage = {
          inputTokens: Math.max(0, totalInput - totalCached),
          outputTokens: totalOutput,
          cacheReadInputTokens: totalCached,
          cacheCreationInputTokens: 0,
        };
        const delta: TokenUsage = {
          inputTokens: Math.max(
            0,
            cumulative.inputTokens - this.lastCumulativeUsage.inputTokens,
          ),
          outputTokens: Math.max(
            0,
            cumulative.outputTokens - this.lastCumulativeUsage.outputTokens,
          ),
          cacheReadInputTokens: Math.max(
            0,
            cumulative.cacheReadInputTokens -
              this.lastCumulativeUsage.cacheReadInputTokens,
          ),
          cacheCreationInputTokens: 0,
        };
        this.lastCumulativeUsage = cumulative;
        // `last` drives the /context snapshot (current context fullness).
        const last = tu.last;
        const lastInput = last.inputTokens;
        const lastCached = last.cachedInputTokens;
        const lastOutput = last.outputTokens;
        const lastReasoning = last.reasoningOutputTokens;
        if (tu.modelContextWindow !== null) {
          this.modelContextWindow = tu.modelContextWindow;
        }
        this.lastTurnBreakdown = {
          inputNewTokens: Math.max(0, lastInput - lastCached),
          inputCachedTokens: lastCached,
          outputTokens: Math.max(0, lastOutput - lastReasoning),
          reasoningOutputTokens: lastReasoning,
        };
        this.enqueue({ kind: "usage_update", tokenUsage: delta });
        break;
      }

      // ---- Item lifecycle ----
      case "item/started":
        // Carries the full ThreadItem but we wait for completion.
        break;
      case "item/completed": {
        const item = params?.item;
        if (item) this.translateCompletedItem(item);
        break;
      }
      // Streaming deltas (item/agentMessage/delta, item/reasoning/textDelta,
      // item/reasoning/summaryTextDelta) are intentionally ignored. Codex
      // emits them at sub-word granularity (one entry per token), and
      // Isomux's log-view treats each text entry as its own row — surfacing
      // every delta produces a wall of one-word lines followed by the same
      // text repeated whole on item/completed. Single-entry-per-message
      // matches Claude's behavior and is much more readable. Streaming UX
      // could be reintroduced later via an in-place "append to last text
      // entry" mechanism, but that's a UI-level change, not a wire change.
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        break;

      // ---- Mid-conversation compaction ----
      case "thread/compacted": {
        const summary = params?.summary as string | undefined;
        this.enqueue({ kind: "compacted", summary });
        break;
      }

      // ---- Failure / warnings ----
      case "error": {
        const message = params?.message as string | undefined;
        if (message) this.enqueue({ kind: "error", message });
        break;
      }
      case "warning":
      case "guardianWarning":
      case "deprecationNotice":
      case "configWarning":
      case "model/rerouted": {
        const text = params?.message as string | undefined;
        if (text) this.enqueueAuthAwareSystemText(`[${n.method}] ${text}`);
        break;
      }

      // ---- Plan stream ----
      case "item/plan/delta": {
        // Deltas arrive at token granularity; the completed plan item below is
        // the durable card we want in the log.
        break;
      }

      // Everything else (hook/*, fuzzy*, mcpServer/*, thread/realtime/*,
      // account/*, app/*, fs/*, process/*, windows*, externalAgentConfig/*,
      // remoteControl/*, thread/goal/*, rawResponseItem/*, item/auto-
      // ApprovalReview/*, item/commandExecution/outputDelta, etc.): ignored
      // at v1. The "item/...outputDelta" streams could feed richer UI later.
      default:
        break;
    }
  }

  private translateCompletedItem(rawItem: unknown): void {
    // ThreadItem union is too broad (~20 variants) to model exactly here.
    // Cast to a loose Record so per-branch field reads stay typed without
    // committing to the generated schema.
    const item = rawItem as Record<string, unknown>;
    switch (item?.type) {
      case "agentMessage": {
        const text = item.text as string | undefined;
        if (text) this.enqueue({ kind: "assistant_text", text });
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(item.summary)
          ? item.summary.join("\n")
          : "";
        const content = Array.isArray(item.content)
          ? item.content.join("\n")
          : "";
        const joined = [summary, content].filter(Boolean).join("\n\n");
        if (joined) this.enqueue({ kind: "thinking", text: joined });
        break;
      }
      case "commandExecution": {
        const command = item.command as string | undefined;
        const cwd = item.cwd as string | undefined;
        const aggregatedOutput = item.aggregatedOutput as string | undefined;
        const exitCode = item.exitCode as number | undefined;
        const durationMs = item.durationMs as number | undefined;
        const toolUseId = item.id as string;
        this.enqueue({
          kind: "tool_call",
          toolUseId,
          name: "Bash",
          input: cwd ? { command, cwd } : { command },
        });
        const content =
          (aggregatedOutput ?? "") +
          (exitCode != null ? `\n(exit code ${exitCode})` : "");
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content,
          durationMs: durationMs ?? undefined,
          isError: exitCode != null && exitCode !== 0,
        });
        break;
      }
      case "fileChange": {
        const toolUseId = item.id as string;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = (changes as { path?: string; kind?: unknown }[])
          .map((c) => `${c.path ?? "?"} (${formatPatchChangeKind(c.kind)})`)
          .join("\n");
        const status = item.status as string | undefined;
        this.enqueue({
          kind: "tool_call",
          toolUseId,
          name: "Edit",
          input: { changes },
        });
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content: `${summary}\n\nstatus: ${status ?? "unknown"}`,
          isError:
            status != null && status !== "completed" && status !== "applied",
        });
        break;
      }
      case "mcpToolCall": {
        const toolUseId = item.id as string;
        const server = item.server as string;
        const tool = item.tool as string;
        const durationMs = item.durationMs as number | undefined;
        this.enqueue({
          kind: "tool_call",
          toolUseId,
          name: `mcp__${server}__${tool}`,
          input: (item.arguments ?? {}) as Record<string, unknown>,
        });
        const result = item.result;
        const error = item.error;
        const content = error
          ? `Error: ${JSON.stringify(error)}`
          : JSON.stringify(result ?? {});
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content,
          durationMs: durationMs ?? undefined,
          isError: !!error,
        });
        break;
      }
      case "webSearch": {
        const toolUseId = item.id as string;
        const query = item.query as string | undefined;
        const actionSummary = formatWebSearchAction(item.action);
        this.enqueue({
          kind: "tool_call",
          toolUseId,
          name: "WebSearch",
          input: query ? { query } : {},
        });
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content: actionSummary,
          isError: false,
        });
        break;
      }
      case "plan": {
        const text = item.text as string | undefined;
        if (text) this.enqueue({ kind: "thinking", text });
        break;
      }
      case "imageView": {
        const att = this.attachmentFromPath(item.path);
        if (att) {
          this.enqueue({
            kind: "file_view",
            title: att.originalName,
            attachments: [att],
          });
        } else {
          this.enqueue({
            kind: "system_text",
            text: `Codex viewed an image, but Isomux could not display it.`,
          });
        }
        break;
      }
      case "imageGeneration": {
        const att = this.attachmentFromPath(item.savedPath);
        if (att) {
          const title =
            typeof item.revisedPrompt === "string" && item.revisedPrompt.trim()
              ? item.revisedPrompt
              : att.originalName;
          this.enqueue({
            kind: "file_view",
            title,
            attachments: [att],
          });
        } else if (item.status === "failed") {
          const result = typeof item.result === "string" ? item.result : "";
          this.enqueue({
            kind: "system_text",
            text: result
              ? `Codex image generation failed: ${result}`
              : `Codex image generation failed.`,
          });
        } else {
          this.enqueue({
            kind: "system_text",
            text: `Codex generated an image, but Isomux could not display it.`,
          });
        }
        break;
      }
      case "contextCompaction":
        this.enqueue({ kind: "compacted" });
        break;
      // userMessage, hookPrompt, dynamicToolCall, collabAgentToolCall,
      // enteredReviewMode, exitedReviewMode: ignored at v1.
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Server-initiated request routing
  // -------------------------------------------------------------------------

  private async handleServerRequest(req: JsonRpcRequest): Promise<unknown> {
    const params = req.params as Record<string, unknown> | null | undefined;
    // Per-thread filter on server requests that target a thread.
    if (
      params?.threadId !== undefined &&
      this.threadId &&
      params.threadId !== this.threadId
    ) {
      return PASS;
    }

    switch (req.method) {
      // ---- Approvals routed through orchestrator (binary allow/deny UX) ----
      // item/permissions/requestApproval has a richer response shape
      // (GrantedPermissionProfile + scope + strictAutoReview) that doesn't
      // map cleanly to our 3-option /resolve UX — auto-decline at v1.
      case "applyPatchApproval":
      case "execCommandApproval":
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        const approvalId = String(req.id);
        const toolName = inferToolNameFromApproval(req.method, params);
        const title = inferApprovalTitle(req.method, params);
        const description = inferApprovalDescription(req.method, params);
        // The promise we return is what the JsonRpcLiteClient's handler chain
        // awaits. session.approve() resolves it with the right enum-variant
        // response shape, the client auto-responds, and the handler frame
        // frees. close() rejects any still-pending entries.
        return new Promise<unknown>((resolve, reject) => {
          this.pendingApprovals.set(approvalId, {
            jsonRpcId: req.id,
            toolName,
            method: req.method,
            resolve,
            reject,
          });
          this.enqueue({
            kind: "approval_request",
            approvalId,
            toolName,
            input: extractApprovalInput(req.method, params),
            title,
            description,
          });
        });
      }

      // ---- Permissions request: auto-decline with JSON-RPC error ----
      case "item/permissions/requestApproval":
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined permissions request from codex (v1 doesn't expose permission-profile changes — use the spawn dialog to pick a different sandbox/approval policy).`,
        });
        throw new Error(
          "Permissions profile changes are not supported in Isomux v1.",
        );

      // ---- Auto-decline (correct response shapes per server schema) ----
      case "item/tool/requestUserInput":
        // ToolRequestUserInputResponse shape is { answers: HashMap<...> }, no
        // canceled/decline field. Sending a JSON-RPC error is the correct
        // way to say "the client can't answer this."
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined structured tool-input request from codex (v1 doesn't support agent-issued Q&A).`,
        });
        throw new Error(
          "Isomux v1 does not implement item/tool/requestUserInput.",
        );

      case "mcpServer/elicitation/request":
        // Confirmed against the schema: { action: "accept" | "decline" | "cancel" }.
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined MCP elicitation request (v1 doesn't surface MCP elicitation UX).`,
        });
        return { action: "decline" };

      case "item/tool/call":
        // DynamicToolCallResponse shape is { contentItems, success }, no
        // canceled field. We could synthesize a "tool not implemented"
        // failure response, but a JSON-RPC error is clearer for v1: the
        // agent sees the tool call failed at the protocol level rather than
        // as an opaque "tool returned this" reply.
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined dynamic tool call from codex (v1 doesn't expose dynamic tools).`,
        });
        throw new Error(
          "Isomux v1 does not implement item/tool/call (dynamic tools).",
        );

      // ---- Auth token refresh ----
      case "account/chatgptAuthTokens/refresh":
        // We don't have a token store; respond with an error so codex falls
        // back to user-facing login flow.
        this.enqueue({
          kind: "error",
          message: `Codex requested a ChatGPT auth token refresh, but Isomux has no token store. ${LOGIN_INSTRUCTIONS}`,
        });
        throw new Error(`No token store: ${LOGIN_INSTRUCTIONS}`);

      // Untested at v1: attestation/generate (codex requests an attestation
      // token for upstream OpenAI calls). Falls to method-not-found via PASS
      // below. If codex hard-fails on missing attestation in some flows,
      // wire a real handler here. Subprocess-death synthesis covers the
      // worst-case (hung turn) regardless.
      default:
        // Unknown server request — let the client respond method-not-found.
        return PASS;
    }
  }

  // -------------------------------------------------------------------------
  // Stderr + subprocess exit
  // -------------------------------------------------------------------------

  private handleStderr(chunk: string): void {
    // Codex stderr is opaque process output. Route to the agent log as
    // system_text so the boss has visibility. Trim trailing newlines and
    // skip pure whitespace.
    const text = chunk.trimEnd();
    if (!text) return;
    // Drop known-benign startup notices. Codex logs these at ERROR level
    // but they're informational: the bubblewrap line is a "here's how our
    // Linux sandbox works" note, and the trusted-project line tells the
    // user how to opt into project-local config — neither is actionable
    // for Isomux users in the chat.
    if (
      /bubblewrap.*needs access to create user namespaces/i.test(text) ||
      /until the project is trusted, but skills still load/i.test(text)
    ) {
      return;
    }
    // Route through the auth-aware gate so codex's websocket retry burst
    // produces at most one user-visible signal per turn (Claude-SDK parity).
    this.enqueueAuthAwareSystemText(`[codex stderr] ${text}`);
  }

  private handleSubprocessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.closed) return;
    // The per-turn auth-coalescing gate must close on subprocess death so an
    // unlikely-but-possible later stderr (e.g. drained late) doesn't sneak
    // through with a stale-open gate.
    this.authSignalsAllowedThisTurn = false;
    this.authSignalEmittedThisTurn = false;
    this.selfInterruptedForAuth = false;
    // If a turn was in flight when codex died, synthesize a failed
    // turn_completed so the orchestrator's pendingTurn unblocks.
    if (this.turnInFlight) {
      this.turnInFlight = false;
      this.enqueue({
        kind: "turn_completed",
        status: "failed",
        error: `codex subprocess exited${code != null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""} mid-turn`,
      });
    } else {
      this.enqueue({
        kind: "system_text",
        text: `Codex subprocess exited${code != null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""}.`,
      });
    }
    this.markEnded();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapTurnStatus(
  status: string | undefined,
): "completed" | "interrupted" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function formatPatchChangeKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (!kind || typeof kind !== "object") return "modified";
  const type = (kind as { type?: unknown }).type;
  if (typeof type !== "string") return "modified";
  if (type !== "update") return type;
  const movePath = (kind as { move_path?: unknown }).move_path;
  return typeof movePath === "string" && movePath.length > 0
    ? `update -> ${movePath}`
    : "update";
}

// The approval response enums differ by method:
//   applyPatchApproval / execCommandApproval (legacy):  ReviewDecision
//     -> "approved" | "approved_for_session" | "denied"
//   item/commandExecution/requestApproval (v2):  CommandExecutionApprovalDecision
//     -> "accept" | "acceptForSession" | "acceptWithExecpolicyAmendment"
//        | "decline" | "cancel"
//   item/fileChange/requestApproval (v2):  FileChangeApprovalDecision
//     -> "accept" | "acceptForSession" | "decline" | "cancel"
// We map our 3-button /resolve UX to: allow_persistent -> acceptForSession,
// allow_once -> accept, deny -> decline. "cancel" is intentionally not used:
// it interrupts the whole turn, which is harsher than the user typically
// means by a single-tool deny.
function mapApprovalDecision(
  method: string,
  decision: ApprovalDecision,
): string {
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    switch (decision.kind) {
      case "allow_persistent":
        return "approved_for_session";
      case "allow_once":
        return "approved";
      case "deny":
        return "denied";
    }
  }
  // v2 command-execution + file-change approvals — same enum variant names.
  switch (decision.kind) {
    case "allow_persistent":
      return "acceptForSession";
    case "allow_once":
      return "accept";
    case "deny":
      return "decline";
  }
}

function inferToolNameFromApproval(method: string, _params: unknown): string {
  switch (method) {
    case "applyPatchApproval":
    case "item/fileChange/requestApproval":
      return "Edit";
    case "execCommandApproval":
    case "item/commandExecution/requestApproval":
      return "Bash";
    case "item/permissions/requestApproval":
      return "Permissions";
    default:
      return method;
  }
}

function inferApprovalTitle(method: string, rawParams: unknown): string {
  const params = rawParams as
    | {
        command?: string | string[];
        commandActions?: { command?: string }[];
      }
    | null
    | undefined;
  switch (method) {
    case "applyPatchApproval":
    case "item/fileChange/requestApproval":
      return `Codex wants to apply a patch`;
    case "execCommandApproval":
    case "item/commandExecution/requestApproval": {
      const rawCommand = params?.command;
      const cmd = Array.isArray(rawCommand)
        ? rawCommand.join(" ")
        : (rawCommand ?? params?.commandActions?.[0]?.command ?? "");
      return cmd
        ? `Codex wants to run: \`${cmd.slice(0, 80)}\``
        : `Codex wants to run a command`;
    }
    case "item/permissions/requestApproval":
      return `Codex wants to change permissions`;
    default:
      return `Codex wants approval`;
  }
}

function inferApprovalDescription(
  _method: string,
  params: unknown,
): string | undefined {
  const reason = (params as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason === "string" && reason.trim()) return reason;
  return undefined;
}

function extractApprovalInput(
  method: string,
  params: unknown,
): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const p = params as Record<string, unknown>;

  if (
    method === "execCommandApproval" ||
    method === "item/commandExecution/requestApproval"
  ) {
    const command = Array.isArray(p.command)
      ? p.command.filter((part): part is string => typeof part === "string")
      : p.command;
    return compactRecord({
      command: Array.isArray(command) ? command.join(" ") : command,
      cwd: p.cwd,
      reason: p.reason,
      networkApprovalContext: p.networkApprovalContext,
      additionalPermissions: p.additionalPermissions,
    });
  }

  if (method === "applyPatchApproval") {
    return compactRecord({
      fileChanges: p.fileChanges,
      grantRoot: p.grantRoot,
      reason: p.reason,
    });
  }

  if (method === "item/fileChange/requestApproval") {
    return compactRecord({
      itemId: p.itemId,
      grantRoot: p.grantRoot,
      reason: p.reason,
    });
  }

  return {};
}

// Build the UserInput[] for turn/start from plain text + Isomux attachments.
// Codex's UserInput variants are: text, image, localImage, skill, mention. For
// v1 we pass text + localImage paths for image attachments; non-image
// attachments (PDFs, text files) get inlined as a text description. This is
// a UX simplification — richer attachment support is a follow-up.
function buildCodexUserInput(
  text: string,
  attachments: AttachmentSpec[] | undefined,
  agentId: string,
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  if (text) {
    inputs.push({ type: "text", text, text_elements: [] });
  }
  if (attachments && attachments.length > 0) {
    const textChunks: string[] = [];
    for (const att of attachments) {
      const filePath = getFilePath(agentId, att.filename);
      if (!filePath) continue;
      if (att.mediaType.startsWith("image/")) {
        inputs.push({ type: "localImage", path: filePath });
      } else if (att.mediaType === "application/pdf") {
        textChunks.push(`Attached PDF "${att.originalName}" at ${filePath}`);
      } else if (isInlinableTextMedia(att.mediaType)) {
        // Text-ish file: inline up to MAX_INLINE_ATTACHMENT_BYTES. Stat first
        // so we don't read the whole file when it would just get dropped.
        try {
          const size = statSync(filePath).size;
          if (size > MAX_INLINE_ATTACHMENT_BYTES) {
            textChunks.push(
              `Attached file "${att.originalName}" (${size} bytes; exceeds ${MAX_INLINE_ATTACHMENT_BYTES}-byte inline cap). Path: ${filePath}`,
            );
          } else {
            const content = readFileSync(filePath, "utf-8");
            textChunks.push(
              `--- File: ${att.originalName} ---\n${content}\n---`,
            );
          }
        } catch {
          textChunks.push(
            `Attached file ${att.originalName} (could not read content) at ${filePath}`,
          );
        }
      } else {
        // Unknown / binary media: don't inline. Hand codex the path so it can
        // open the file with a tool if it needs to.
        textChunks.push(
          `Attached file "${att.originalName}" (${att.mediaType}) at ${filePath}`,
        );
      }
    }
    if (textChunks.length > 0) {
      inputs.push({
        type: "text",
        text: textChunks.join("\n\n"),
        text_elements: [],
      });
    }
  }
  // turn/start with empty input is invalid; ensure at least an empty text.
  if (inputs.length === 0) {
    inputs.push({ type: "text", text: "", text_elements: [] });
  }
  return inputs;
}

// Translate a Codex protocol Model into the BackendModel shape the rest of
// the system consumes. We pick `model` (the wire slug) as `id` since that's
// what gets passed to thread/start; `displayName` is the human label.
function toBackendModel(m: CodexProtocolModel): BackendModel {
  const supportedEfforts: BackendEffortOption[] = (
    m.supportedReasoningEfforts ?? []
  ).map((opt) => ({
    level: opt.reasoningEffort,
    description: opt.description,
  }));
  return {
    id: m.model,
    label: m.displayName || m.model,
    description: m.description || undefined,
    isDefault: m.isDefault,
    hidden: m.hidden,
    supportedEfforts,
    defaultEffort: m.defaultReasoningEffort,
  };
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export const codexBackend: Backend = {
  capabilities: CAPABILITIES,

  getModelOptions(): ModelOption[] {
    return MODEL_OPTIONS;
  },

  getPermissionModes(): PermissionModeOption[] {
    return PERMISSION_MODES;
  },

  async listModels(opts: ListModelsOptions): Promise<BackendModel[]> {
    // Spin up a one-shot JsonRpcLiteClient just for model/list. The pattern
    // mirrors oneShotPrompt but skips thread/start — model/list is a
    // server-level RPC, not thread-scoped. Pagination loops until
    // nextCursor === null. ~1-2s end-to-end including subprocess spawn.
    const client = new JsonRpcLiteClient({ cwd: opts.cwd, env: opts.env });
    try {
      client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      const collected: CodexProtocolModel[] = [];
      let cursor: string | null = null;
      // Hard cap on iterations: defensive against a malformed nextCursor
      // loop. Real model lists are well under 100 entries.
      for (let i = 0; i < 32; i++) {
        const params: ModelListParams = {
          cursor: cursor ?? null,
          limit: null,
          includeHidden: opts.includeHidden ?? false,
        };
        const resp = await client.request<ModelListResponse>(
          "model/list",
          params,
        );
        collected.push(...resp.data);
        if (!resp.nextCursor) break;
        cursor = resp.nextCursor;
      }
      return collected.map(toBackendModel);
    } finally {
      await client.close();
    }
  },

  createSession(opts: CreateSessionOptions): BackendSession {
    return new CodexSession({
      agentId: opts.agentId,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      modelFamily: opts.modelFamily,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      sandbox: opts.sandbox,
      env: opts.env,
    });
  },

  resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession {
    return new CodexSession({
      agentId: opts.agentId,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      modelFamily: opts.modelFamily,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      sandbox: opts.sandbox,
      env: opts.env,
      resumeThreadId: sessionId,
    });
  },

  async forkSessionBeforeMessage(
    sessionId: string,
    targetMessageId: string,
  ): Promise<ForkSessionBeforeMessageResult> {
    // Strategy: fork-then-rollback. Codex 0.130's thread/fork copies whole
    // threads (no per-message granularity), so to preserve the parent and
    // produce a child rolled back to before the edited message we:
    //   1. thread/read the parent → walk turns to find which one contains
    //      targetMessageId
    //   2. thread/fork(parent) → child threadId (parent unaltered)
    //   3. thread/rollback(child, numTurns) → drops the target's turn and
    //      everything after it, leaving the child at the predecessor's turn
    //
    // Turn arithmetic: a user message always starts a new turn in Codex's
    // model. So if target is in turn K (0-indexed), the turns to preserve
    // are [0..K-1] and the turns to drop are [K..totalTurns-1]. That gives
    // numTurns = totalTurns - K, which equals totalTurns when K=0 (first-
    // message edit drops everything and starts the child from scratch — but
    // still as a fork, so /resume shows the parent as the original branch).
    const client = new JsonRpcLiteClient();
    try {
      client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });

      const turns = await readThreadTurns(client, sessionId);
      const targetTurnIndex = findTurnIndexContainingItemId(
        turns,
        targetMessageId,
      );
      if (targetTurnIndex === -1) {
        throw new Error(
          "forkSessionBeforeMessage: target message not found in thread turns",
        );
      }
      const numTurns = turns.length - targetTurnIndex;
      if (numTurns < 1) {
        // Defensive: target was found in turns so this shouldn't happen, but
        // bail before issuing a rollback rejected by the server (numTurns
        // must be >= 1 per the protocol).
        throw new Error(
          "forkSessionBeforeMessage: computed numTurns < 1 (programming error)",
        );
      }

      const forkResp = await client.request<{ thread: { id: string } }>(
        "thread/fork",
        {
          threadId: sessionId,
          excludeTurns: true,
        },
      );
      const childThreadId = forkResp.thread.id;

      const rollbackParams: ThreadRollbackParams = {
        threadId: childThreadId,
        numTurns,
      };
      await client.request<ThreadRollbackResponse>(
        "thread/rollback",
        rollbackParams,
      );

      return {
        kind: "fork",
        sessionId: childThreadId,
        forkedFromSessionId: sessionId,
      };
    } finally {
      await client.close();
    }
  },

  async getSessionMessages(sessionId: string): Promise<NormalizedMessage[]> {
    // thread/read returns the Thread, with rollout history populated in
    // thread.turns[].items[] only when includeTurns:true is set. Each Turn
    // is one round of work; we flatten user and assistant items across all
    // turns in order so the orchestrator's edit-message matching can find
    // user messages by content + occurrence index.
    const client = new JsonRpcLiteClient();
    try {
      client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      const turns = await readThreadTurns(client, sessionId);
      const out: NormalizedMessage[] = [];
      type ThreadItem = {
        type?: string;
        id?: string;
        content?: unknown;
        text?: string;
      };
      for (const turn of turns) {
        for (const raw of turn.items) {
          const item = raw as ThreadItem;
          if (item?.type === "userMessage" && typeof item.id === "string") {
            const text = Array.isArray(item.content)
              ? (item.content as { type?: string; text?: string }[])
                  .filter(
                    (c): c is { type: "text"; text: string } =>
                      c.type === "text" && typeof c.text === "string",
                  )
                  .map((c) => c.text)
                  .join("")
              : "";
            out.push({ uuid: item.id, role: "user", text });
          } else if (
            item?.type === "agentMessage" &&
            typeof item.id === "string"
          ) {
            out.push({
              uuid: item.id,
              role: "assistant",
              text: item.text ?? "",
            });
          }
        }
      }
      return out;
    } finally {
      await client.close();
    }
  },

  async oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string> {
    // Per the spec: thread/start ephemeral:true → turn/start → consume one
    // agentMessage → thread/archive. Costs one turn but mirrors Claude's
    // unstable_v2_prompt flow.
    const client = new JsonRpcLiteClient({ cwd: opts.cwd, env: opts.env });
    try {
      client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      const startResp = await client.request<{ thread: { id: string } }>(
        "thread/start",
        {
          cwd: opts.cwd,
          model: opts.modelFamily,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      );
      const threadId = startResp.thread.id;
      let result = "";
      let resolved = false;
      // Fail closed: callers (topic generation, etc.) need to distinguish a
      // genuine empty response from a turn that errored or was interrupted.
      // We keep awaiting the same `done` to collect any final state, but throw
      // after archive so the caller sees the real failure.
      let failure: Error | null = null;
      const done = new Promise<void>((resolve) => {
        client.onNotification((n) => {
          const params = n.params as Record<string, unknown> | null | undefined;
          if (params?.threadId !== threadId) return;
          if (n.method === "item/completed") {
            const item = params?.item as
              | { type?: string; text?: string }
              | undefined;
            if (
              item?.type === "agentMessage" &&
              typeof item.text === "string"
            ) {
              result = item.text;
            }
          } else if (n.method === "turn/completed") {
            const turn = params?.turn as
              | { status?: string; error?: { message?: string } | null }
              | undefined;
            if (turn?.status && turn.status !== "completed") {
              failure = new Error(
                `Codex one-shot turn ${turn.status}: ${turn.error?.message ?? "no detail"}`,
              );
            }
            if (!resolved) {
              resolved = true;
              resolve();
            }
          } else if (n.method === "error") {
            const msg = params?.message;
            failure = new Error(
              `Codex one-shot error: ${typeof msg === "string" ? msg : "unknown"}`,
            );
            if (!resolved) {
              resolved = true;
              resolve();
            }
          }
        });
      });
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      await done;
      // Best-effort archive; ignore errors.
      try {
        await client.request("thread/archive", { threadId });
      } catch {}
      if (failure) throw failure as Error;
      return result;
    } finally {
      await client.close();
    }
  },

  detectAuthError(text: string): boolean {
    return AUTH_ERROR_PATTERNS.test(text);
  },

  getLoginInstructions(opts?: {
    env?: { [key: string]: string | undefined };
  }): { text: string; commands?: string[] } {
    if (isCodexAuthenticated(opts?.env)) {
      return { text: ALREADY_AUTHED_INSTRUCTIONS };
    }
    return { text: LOGIN_INSTRUCTIONS, commands: getCodexLoginCommands() };
  },
};
