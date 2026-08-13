// Codex backend adapter.
//
// Implements the Backend / BackendSession contracts (server/backends/types.ts)
// against the Codex App Server's JSON-RPC lite protocol via the
// JsonRpcLiteClient in ./client.ts. One CodexSession owns one threadId and
// one subprocess for v1 - symmetric with Claude. The client layer is built so
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

import { saveFile } from "../../persistence.ts";
import {
  resolveAttachmentNotices,
  formatAttachmentLines,
} from "../../attachment-prompt.ts";
import { mimeTypeForFilename } from "../../mime-types.ts";
import { markdownInlineCode } from "../../../shared/format-human.ts";
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
  SubscriptionUsageResult,
  SubscriptionUsageWindow,
  TokenUsage,
} from "../types.ts";

import {
  JsonRpcLiteClient,
  PASS,
  type JsonRpcId,
  type JsonRpcLiteClientOptions,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type NotificationHandler,
  type ServerRequestHandler,
} from "./client.ts";
import {
  codexWrapperCommandForShell,
  getCodexLoginCommands,
  isCodexAuthenticated,
} from "./native-bin.ts";

import type { InitializeParams } from "./_generated/InitializeParams.ts";
import type { InitializeResponse } from "./_generated/InitializeResponse.ts";
import type { Model as CodexProtocolModel } from "./_generated/v2/Model.ts";
import type { ModelListParams } from "./_generated/v2/ModelListParams.ts";
import type { ModelListResponse } from "./_generated/v2/ModelListResponse.ts";
import type { ThreadRollbackParams } from "./_generated/v2/ThreadRollbackParams.ts";
import type { ThreadRollbackResponse } from "./_generated/v2/ThreadRollbackResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./_generated/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { AccountRateLimitsUpdatedNotification } from "./_generated/v2/AccountRateLimitsUpdatedNotification.ts";
import type { GetAccountRateLimitsResponse } from "./_generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./_generated/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./_generated/v2/RateLimitWindow.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Isomux runs codex against its own isolated CODEX_HOME (~/.isomux/codex-home/
// by default), separate from the user's interactive `~/.codex/`. That means
// the user needs a one-time `codex login` against isomux's CODEX_HOME - the
// [Copy to terminal] card alongside this message has the exact command.
//
// Two [Copy to terminal] cards follow: browser OAuth (default) and
// `--device-auth` (remote / headless). Both target the default
// `~/.isomux/codex-home/`. Users with a per-user envFile `CODEX_HOME`
// (e.g. `~/.isomux-users/<name>/.codex` for billing isolation, see
// internal-docs/isolation-design.md) need to prefix the pasted command
// with their own `CODEX_HOME=<path>` before pressing Enter - the wrapper's
// default only kicks in when CODEX_HOME is unset.
// Same wrapper command the [Copy to terminal] cards use, so the prose and the
// cards never disagree - `~/.isomux/bin/codex` at the default root (byte-for-
// byte prod), the active wrapper path under an ISOMUX_HOME override.
const codexLoginCmd = codexWrapperCommandForShell();
const LOGIN_INSTRUCTIONS = `To sign in to Codex, click [Copy to terminal] on one of the cards below:

- \`${codexLoginCmd} login\`: if running isomux locally
- \`${codexLoginCmd} login --device-auth\`: for your hosted Isomux VPS, or another remote or headless host (e.g. a Mac mini or Linux box you reach over a VPN)

Press Enter to run, follow the prompts, then \`/clear\` this conversation to apply the new auth. Other codex agents apply on their next \`/clear\`.

Alternative: add \`OPENAI_API_KEY\` to your envFile (User Settings → Env File Path, then \`/clear\`). For envFile users with a custom CODEX_HOME: prefix the login commands above with \`CODEX_HOME=<your value>\` first.`;

// Surfaced when an auth-error fires but the office already has a valid
// codex auth (auth.json present, or OPENAI_API_KEY in env). The user's
// signed in; their session just predates the login, so a /clear is all
// they need.
const ALREADY_AUTHED_INSTRUCTIONS = `Codex is signed in. Type \`/clear\` to refresh this agent's session and pick up the new auth.`;

const AUTH_ERROR_PATTERNS =
  /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|chatgpt.*login|openai_api_key|403|401/i;

// Capability flags for the Codex backend. Match the spec's parity table.
// hooks: false - Codex emits hook/* notifications but provides no
// programmatic register-from-client surface at 0.130 (v1).
// edit: true - implemented via fork-then-rollback: thread/fork the parent
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

// Static model options - FALLBACK only. The live set comes from
// codexBackend.listModels() (model/list RPC), which returns the
// auth-appropriate subset (ChatGPT-login vs API-key users see different
// sets) with per-model supportedReasoningEfforts. This list backs
// getModelOptions() and modelDisplayLabel() when the RPC isn't available.
// Slugs verified against `codex debug models` on codex-cli 0.144.1
// (2026-07-11); mirror of CODEX_MODELS in shared/types.ts.
const MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
];

function modelDisplayLabel(slug: string): string {
  return MODEL_OPTIONS.find((m) => m.value === slug)?.label ?? slug;
}

// Permission/approval mode options. AskForApproval enum minus the deprecated
// "on-failure" variant (codex 0.130 emits a deprecation warning on use). The
// granular variant is gated behind experimentalApi but deferred to v1.x per
// the spec.
const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "untrusted", label: "Untrusted - ask on every tool" },
  { value: "on-request", label: "On request - ask when model asks" },
  { value: "never", label: "Never ask (use with sandbox)" },
];

// Default sandbox if the caller doesn't pass one. workspace-write is the
// "Claude-equivalent default" preset from the spec's reference mapping.
const DEFAULT_SANDBOX_MODE = "workspace-write";

const CLIENT_INFO_NAME = "isomux";
const CLIENT_INFO_VERSION = "1.0.0";

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

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

// Human label for a rate-limit window, derived from its duration. Codex names
// its windows "primary"/"secondary", and which of the two is the weekly one
// has moved across codex versions - the duration is the stable fact, so the
// label (and the pick of which window the pill shows) comes from it.
export function codexWindowLabel(minutes: number | null): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
    return "Plan allowance";
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes === MINUTES_PER_DAY) return "Daily";
  if (minutes % MINUTES_PER_DAY === 0)
    return `${minutes / MINUTES_PER_DAY}-day`;
  if (minutes % MINUTES_PER_HOUR === 0)
    return `${minutes / MINUTES_PER_HOUR}-hour`;
  return `${minutes}-minute`;
}

// Codex reports `resetsAt` as a bare epoch number - SECONDS in the payload
// isomux has seen (Pau's reference script feeds it straight to
// datetime.fromtimestamp). The generated schema only says "number", so rather
// than hard-code the unit we pick it by magnitude: any epoch-seconds value
// this century is < 1e11, any epoch-ms value from 1973 on is >= 1e11. Wrong
// only for dates outside roughly 1970-5138, which no reset window is.
const EPOCH_MS_THRESHOLD = 1e11;

export function codexResetsAtMs(resetsAt: unknown): number | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  if (resetsAt <= 0) return null;
  return resetsAt >= EPOCH_MS_THRESHOLD ? resetsAt : resetsAt * 1000;
}

// Which metered bucket isomux displays when the account has several. Codex's
// own metered limit for agent turns is keyed "codex"; a business account can
// carry other meters that say nothing about this agent's turns.
export const CODEX_PREFERRED_LIMIT_ID = "codex";

// Key used for the historical single-bucket view (GetAccountRateLimitsResponse
// .rateLimits, and any notification whose snapshot has no limitId). Kept
// separate from the keyed buckets so the two never merge into each other.
export const CODEX_LEGACY_LIMIT_KEY = "";

export function codexLimitKey(snapshot: RateLimitSnapshot): string {
  return snapshot.limitId ?? CODEX_LEGACY_LIMIT_KEY;
}

// Which cached bucket an ID-LESS rolling update belongs to. limitId is
// nullable metadata, and the generated docs warn that nullable metadata may
// simply be absent from a rolling update - so an id-less push is usually a
// fresher number for a bucket we already know, not news about a new meter.
//   - nothing cached yet: start the legacy bucket (nothing to be ambiguous
//     with, and it's the historical single-bucket shape).
//   - exactly one bucket cached: unambiguous, it's that one.
//   - several buckets cached: genuinely ambiguous. Return null and DROP the
//     update rather than guess - a wrong guess would show one meter's number
//     under another meter's name, and the next keyed push or read re-syncs.
// Exported for tests.
export function resolveCodexUpdateKey(
  buckets: Map<string, RateLimitSnapshot>,
  update: RateLimitSnapshot,
): string | null {
  if (update.limitId !== null) return update.limitId;
  if (buckets.size === 0) return CODEX_LEGACY_LIMIT_KEY;
  if (buckets.size === 1) return buckets.keys().next().value ?? null;
  return null;
}

// Pick the bucket the pill describes: the codex meter when the account has
// one, otherwise the historical view, otherwise whatever single bucket exists.
// Exported for tests.
export function pickCodexLimitBucket(
  buckets: Map<string, RateLimitSnapshot>,
): RateLimitSnapshot | null {
  return (
    buckets.get(CODEX_PREFERRED_LIMIT_ID) ??
    buckets.get(CODEX_LEGACY_LIMIT_KEY) ??
    buckets.values().next().value ??
    null
  );
}

// Merge one rolling window update into what we already knew about that slot.
// The sparse rule is RECURSIVE: an update can carry a fresh usedPercent while
// leaving windowDurationMins / resetsAt null, and treating the whole window as
// replaced would throw away the duration the label is derived from - the
// window would silently become "Plan allowance" with no reset time the first
// time a percentage-only update arrived. usedPercent is the live value and is
// always taken from the update; the nullable metadata falls back.
export function mergeRateLimitWindow(
  prev: RateLimitWindow | null,
  next: RateLimitWindow | null,
): RateLimitWindow | null {
  if (!next) return prev;
  if (!prev) return next;
  return {
    usedPercent: next.usedPercent,
    windowDurationMins: next.windowDurationMins ?? prev.windowDurationMins,
    resetsAt: next.resetsAt ?? prev.resetsAt,
  };
}

// Merge two snapshots of the SAME metered bucket. `newer` wins wherever it
// carries a value; every nullable field falls back to `older`. Used in both
// directions: a rolling update merged onto the cache (cache is older), and a
// late `account/rateLimits/read` merged UNDER a notification that overtook it
// (the read is older). Exported for tests.
export function mergeRateLimitSnapshots(
  older: RateLimitSnapshot,
  newer: RateLimitSnapshot,
): RateLimitSnapshot {
  return {
    limitId: newer.limitId ?? older.limitId,
    limitName: newer.limitName ?? older.limitName,
    // A null window is "not in this update", not "this window is gone". An
    // account that genuinely loses a window reports it via a fresh read (or a
    // new limitId), not by omitting it from a rolling update.
    primary: mergeRateLimitWindow(older.primary, newer.primary),
    secondary: mergeRateLimitWindow(older.secondary, newer.secondary),
    credits: newer.credits ?? older.credits,
    individualLimit: newer.individualLimit ?? older.individualLimit,
    planType: newer.planType ?? older.planType,
    rateLimitReachedType:
      newer.rateLimitReachedType ?? older.rateLimitReachedType,
  };
}

// RateLimitSnapshot -> isomux's backend-agnostic reading. Exported for tests.
// Windows come back in DISPLAY order, longest first (the plan-shaped one
// leads); which of them the pill's number comes from is the orchestrator's
// call, not this function's. Clamping happens here, at the wire boundary.
// "unavailable" means the app-server answered with a snapshot that has no
// usable window - authoritative enough to clear the pill.
export function normalizeCodexSubscriptionUsage(
  snapshot: RateLimitSnapshot | null | undefined,
): SubscriptionUsageResult {
  if (!snapshot) return { kind: "unknown" };
  const scored: { window: SubscriptionUsageWindow; minutes: number }[] = [];
  for (const win of [snapshot.primary, snapshot.secondary]) {
    const w = win as RateLimitWindow | null | undefined;
    if (!w) continue;
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent))
      continue;
    const minutes =
      typeof w.windowDurationMins === "number" &&
      Number.isFinite(w.windowDurationMins)
        ? w.windowDurationMins
        : 0;
    scored.push({
      window: {
        label: codexWindowLabel(minutes || null),
        usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
        resetsAtMs: codexResetsAtMs(w.resetsAt),
      },
      minutes,
    });
  }
  if (scored.length === 0) return { kind: "unavailable" };
  // Longest first; Array.prototype.sort is stable, so equal durations keep
  // primary-before-secondary order.
  scored.sort((a, b) => b.minutes - a.minutes);
  return {
    kind: "usage",
    usage: {
      plan: snapshot.planType ?? null,
      windows: scored.map((s) => s.window),
    },
  };
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
// reject - orchestrator-level state prevents calls until system_init lands).
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
  // The prefix rule codex suggested for this exec approval, if any (its
  // `proposedExecpolicyAmendment`). Held here, never sent to the orchestrator:
  // approve(id, {kind:"allow_prefix"}) reads it back and stores it in the
  // session's in-memory allow list. Null for approvals with no suggestion.
  suggestedPrefix: string[] | null;
  // Tokens of the command this approval is about, when we could read them
  // unambiguously (see commandTokensForPrefixMatch). A user-typed prefix is
  // only accepted if it is the start of THESE tokens, so answering one
  // approval can never grant a rule about some other command.
  commandTokens: string[] | null;
  // The directory this command would run in. Part of any rule granted from
  // this approval - the same argv in another tree is another action.
  cwd: string | null;
  // Settles the JsonRpcLiteClient handler-chain promise that's anchoring this
  // approval. Resolving it lets the client auto-respond with the payload and
  // releases the parked handler frame; rejecting unwinds the await. Without
  // these the handler held a `new Promise(() => {})` that never settled, so
  // each approval leaked one parked handler frame for the life of the session.
  resolve: (response: unknown) => void;
  reject: (err: unknown) => void;
}

// The narrow transport surface CodexSession depends on - exactly the subset of
// JsonRpcLiteClient it calls (lifecycle, request, pending-approval error
// response, and the four handler registrations). Extracted so the T2
// adapter-contract tests can drive the *real* translation logic with curated
// JSON-RPC provider events through a fake transport, without spawning a codex
// subprocess. JsonRpcLiteClient satisfies this structurally; production wiring
// is unchanged (the constructor still builds a real client when none is
// injected). Keep this session-scoped and free of test-only helpers - fixture
// driving lives on the fake in codex/adapter.test.ts, not here.
export interface CodexTransport {
  start(): void;
  initialize(params: InitializeParams): Promise<InitializeResponse>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respondWithError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void;
  onNotification(handler: NotificationHandler): () => void;
  onServerRequest(handler: ServerRequestHandler): () => void;
  onStderr(handler: (chunk: string) => void): () => void;
  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void;
  close(): Promise<void>;
}

export interface CodexSessionInitOpts {
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
  // Test seam (T2 adapter contract): inject a fake transport to drive the real
  // translation with curated provider events. Undefined in production, where
  // the constructor builds a real JsonRpcLiteClient.
  client?: CodexTransport;
}

export class CodexSession implements BackendSession {
  private client: CodexTransport;
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
  // line and pastes the sign-in card repeatedly - what task 5811bae6
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
  // Command prefixes the user chose to stop being asked about, each pinned to
  // the directory it was granted in (e.g. ["rg", "--files"] in /work).
  // Populated only by an explicit `allow_prefix` decision; a later exec
  // approval that starts the same way in the same directory is answered
  // without bothering the user.
  //
  // DELIBERATELY in-memory and per-session: this field IS the whole store.
  // It dies with the session object (/clear, resume, restart, session swap)
  // and no other agent can see it. The tempting alternative - handing codex
  // back its own `acceptWithExecpolicyAmendment` - was measured against codex
  // 0.144.6 and rejected: codex writes the accepted rule to
  // $CODEX_HOME/rules/default.rules, which is durable AND shared by every
  // codex agent in the office (they share one CODEX_HOME). One user's
  // "stop asking me" would silently become a permanent office-wide allow.
  private sessionAllowPrefixes: AllowPrefixRule[] = [];
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
  // start). `last.inputTokens` is the prompt size of the last turn - i.e.
  // what was in context when the model spoke - and `last.outputTokens` is
  // what was appended after. Together they approximate the context fullness
  // heading into the next turn. Using `total.*` here would mis-report cache
  // re-reads (which sum across turns) as live context usage. Null until the
  // first notification arrives (typically right after the first turn).
  private modelContextWindow: number | null = null;
  // Latest known subscription rate limits for the signed-in ChatGPT account,
  // keyed by metered limitId (see codexLimitKey). Fed by
  // `account/rateLimits/updated` notifications and, until one arrives, a
  // single `account/rateLimits/read`. Describes the ACCOUNT, not this thread,
  // so every agent on the same CODEX_HOME sees the same figures. Buckets are
  // kept apart rather than flattened: an account can meter more than one
  // thing, and blending two meters would invent a number.
  private rateLimitBuckets = new Map<string, RateLimitSnapshot>();
  private rateLimitsReadInFlight: Promise<void> | null = null;
  // Set once a read has come back (successfully or not). Distinguishes "no
  // rate-limit data because nothing has been asked or pushed yet" (unknown)
  // from "asked, and this account reports none" (authoritative).
  private rateLimitsReadSettled = false;
  private lastTurnBreakdown: {
    inputNewTokens: number;
    inputCachedTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null = null;
  // Resolves when bootstrap (initialize + thread/start) completes - success
  // or failure. send() / approve() / abort() await this so they don't race
  // the async setup. On failure threadId stays null; callers see a clear
  // "bootstrap failed" error instead of "not initialized yet."
  private bootstrapPromise: Promise<void>;
  // Captured at bootstrap-failure time, re-thrown by send() on the
  // first user message attempt so the actionable error (install hint,
  // auth failure, etc.) lands in chat AND transitions the agent to
  // error state THEN - matches Claude's lazy-auth UX where the agent
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
    this.client = opts.client ?? new JsonRpcLiteClient(clientOpts);
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
          // Decline attestation/generate: the adapter doesn't handle that
          // server request yet (task cdbc2f3e), so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      };
      await this.client.initialize(initParams);

      if (this.opts.resumeThreadId) {
        // Resume an existing thread. Pass current settings as overrides so
        // a UI-side change to permissionMode/sandbox/model/systemPrompt
        // propagates instead of being stuck on whatever the thread was born
        // with - editAgent replaceSession → resumeSession is the path that
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
    // Record so the codegen union strictness doesn't fight us - the wire
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
    // failed - the orchestrator already saw the `error` event from
    // bootstrap and routed it; raising here surfaces the same condition to
    // the awaiting sendMessage / flushQueue caller).
    await this.bootstrapPromise;
    if (this.closed) throw new Error("CodexSession.send: session is closed");
    if (!this.threadId) {
      // Bootstrap failed - wrap the captured error in BackendNotConfiguredError
      // so sendMessage / flushQueue / editMessage know to surface this calmly
      // (system log entry, agent stays idle) rather than as a real turn error
      // that flips the agent to error state. The actionable text (auth prompt,
      // bundled-binary missing hint, etc.) is already in bootstrapError.message
      // and gets surfaced verbatim - no "Error:" wrapping.
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
    // - the orchestrator would surface a bogus mid-turn failure.
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

  // Resolve an "allow, and stop asking" decision into an actual rule, and say
  // out loud what was remembered - this is the only report the user gets, so
  // it has to name the real rule, including when their own prefix is refused.
  //
  // The orchestrator hands over the user's RAW TEXT, not tokens: splitting a
  // command line and deciding what counts as a token is Codex-shaped knowledge
  // and stays on this side of the boundary. What the text is checked against
  // is the command being approved - a typed prefix must be its start. That
  // single rule is what keeps this from being a way to grant arbitrary
  // permissions: you can widen along the command in front of you, never
  // sideways to a command you were never asked about.
  private applyAllowPrefix(
    pending: PendingApproval,
    typedText: string | undefined,
  ): void {
    // Option 4 is only ever offered when this approval carried a rule that
    // passed every gate in offerablePrefix, so an allow_prefix arriving
    // without one (legacy exec approvals, file changes, a shell-shaped
    // command, a stale client) has nothing to grant: it degrades to a plain
    // one-shot allow, silently and with no rule stored. Its presence also
    // means commandTokens is non-null - gate 2 of offerablePrefix.
    if (!pending.suggestedPrefix || !pending.commandTokens) return;
    const typed = typedText ? splitPlainArgv(typedText) : null;
    if (typedText && typedText.trim()) {
      if (!typed) {
        // The user typed something that isn't a plain command, so there is no
        // honest rule to store. Say which failure this is - otherwise they
        // retype a prefix that looks obviously correct and it fails again.
        this.enqueue({
          kind: "system_text",
          isomuxAuthored: true,
          text: `No session rule was added: Isomux only matches rules against plain commands (no quoting, chaining, redirection, globbing or expansion). Allowed once.`,
        });
      } else if (tokensStartWith(pending.commandTokens, typed)) {
        this.rememberAllowPrefix(typed, pending.cwd);
        this.enqueue({
          kind: "system_text",
          isomuxAuthored: true,
          text: this.grantedText(typed, pending.cwd),
        });
      } else {
        this.enqueue({
          kind: "system_text",
          isomuxAuthored: true,
          text: `\`${typed.join(" ")}\` is not the start of the command being approved, so no session rule was added - this command was allowed once.`,
        });
      }
      return;
    }
    this.rememberAllowPrefix(pending.suggestedPrefix, pending.cwd);
    this.enqueue({
      kind: "system_text",
      isomuxAuthored: true,
      text: this.grantedText(pending.suggestedPrefix, pending.cwd),
    });
  }

  // A rule names a directory as well as a command prefix: `rm -rf build` means
  // a different thing in a different tree, and codex can run a command with a
  // workdir of its choosing. Naming the directory in the confirmation is the
  // point - the user should see the scope they just granted, not discover it.
  //
  // The prefix is safe to interpolate by construction (every token satisfies
  // PLAIN_ARGV_TOKEN, which has no backticks in it). The cwd is not: it is
  // whatever path codex sent, and a directory holding a backtick could close
  // the code span early and forge the rest of the sentence.
  private grantedText(prefix: string[], cwd: string | null): string {
    const where = cwd ? ` in ${markdownInlineCode(cwd)}` : "";
    return `Allowing any command starting with \`${prefix.join(" ")}\`${where} for the rest of this session.`;
  }

  // Store a prefix rule for the rest of this session. A rule already covered
  // by a broader one is dropped, and adding a broader rule drops the narrower
  // ones it swallows, so the list stays as small as the user's actual choices
  // allow. (It still grows one entry per genuinely distinct choice - that is
  // the user's own doing and is bounded by how many times they answer "4".)
  private rememberAllowPrefix(prefix: string[], cwd: string | null): void {
    if (prefix.length === 0) return;
    // Copy: the caller's array is held elsewhere (pending approval state), and
    // a stored rule must not change under us afterwards.
    const rule: AllowPrefixRule = { tokens: [...prefix], cwd };
    if (this.sessionAllowPrefixes.some((r) => ruleCovers(r, rule))) return;
    this.sessionAllowPrefixes = this.sessionAllowPrefixes.filter(
      (r) => !ruleCovers(rule, r),
    );
    this.sessionAllowPrefixes.push(rule);
  }

  // Does the command this approval is about start with a prefix the user
  // already allowed for this session, in the same directory? False for
  // anything that isn't a command execution, for requests we can't read a
  // single unambiguous command out of, and for any command that isn't plain
  // argv - see commandTokensForPrefixMatch, which fails closed.
  private matchSessionPrefix(method: string, params: unknown): boolean {
    if (this.sessionAllowPrefixes.length === 0) return false;
    if (!isExecApprovalMethod(method)) return false;
    const tokens = commandTokensForPrefixMatch(params);
    if (!tokens) return false;
    const cwd = approvalCwd(params);
    return this.sessionAllowPrefixes.some(
      (rule) => rule.cwd === cwd && tokensStartWith(tokens, rule.tokens),
    );
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.bootstrapPromise;
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    this.pendingApprovals.delete(approvalId);
    // "Allow, and stop asking about this prefix" is applied here rather than
    // on the wire: we record the rule ourselves and answer codex with a plain
    // one-shot allow. Handing codex its own `acceptWithExecpolicyAmendment`
    // back would make it write the rule to $CODEX_HOME/rules/default.rules -
    // permanent, and shared with every other codex agent on the box.
    if (decision.kind === "allow_prefix") {
      this.applyAllowPrefix(pending, decision.prefixText);
    }
    const decisionWire = mapApprovalDecision(pending.method, decision);
    // Resolving the deferred releases the JsonRpcLiteClient's handler-chain
    // await; the client auto-responds with this payload. (Previously we
    // called client.respond() directly while leaving the promise pending,
    // which leaked one parked handler frame per approval.) The enum variant
    // set differs per method - see mapApprovalDecision for the routing.
    pending.resolve({ decision: decisionWire });
  }

  async abort(): Promise<void> {
    await this.bootstrapPromise;
    if (this.closed) return;
    if (!this.threadId || !this.activeTurnId) {
      // Nothing to interrupt - no in-flight turn (either bootstrap failed
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
    // right after and short-circuits the deferred-rejection's auto-respond - the
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
    // and the response is dropped - so the explicit respondWithError is what
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

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    // Codex PUSHES rate limits, so the common path is a pure cache read - no
    // throttling needed and none applied. The read request only covers the gap
    // before the first notification arrives (a freshly spawned agent that
    // hasn't run a turn yet); the generated docs point at exactly that
    // sequencing, rolling updates being meant to merge into the most recent
    // `account/rateLimits/read` response.
    if (this.rateLimitBuckets.size === 0) await this.readRateLimitsOnce();
    const bucket = pickCodexLimitBucket(this.rateLimitBuckets);
    if (bucket) return normalizeCodexSubscriptionUsage(bucket);
    // No data. Only authoritative once a read actually came back: before that
    // we simply haven't asked yet, and clearing would blank a live pill on
    // every session replacement.
    return this.rateLimitsReadSettled
      ? { kind: "unavailable" }
      : { kind: "unknown" };
  }

  // Merge a sparse rolling update into the matching bucket. A null field in an
  // update means "not included this time" and must NOT clear a value already
  // observed (see AccountRateLimitsUpdatedNotification's doc comment). Fields
  // are merged one by one rather than object-spread so a schema addition can't
  // silently ride in as an unmerged wholesale replacement.
  private mergeRateLimits(next: RateLimitSnapshot): void {
    const key = resolveCodexUpdateKey(this.rateLimitBuckets, next);
    // Ambiguous id-less update against several meters - see
    // resolveCodexUpdateKey. Dropping beats misfiling.
    if (key === null) return;
    const prev = this.rateLimitBuckets.get(key);
    this.rateLimitBuckets.set(
      key,
      prev ? mergeRateLimitSnapshots(prev, next) : next,
    );
  }

  // Fold a `account/rateLimits/read` response in as an OLDER baseline. It was
  // issued before anything that arrived while it was in flight, so a
  // notification that overtook it keeps its fresher numbers - but the baseline
  // still fills whatever that notification left null. Dropping it wholesale
  // (the first version of this) meant a sparse percentage-only push followed
  // by a full read never recovered the window's duration, and therefore its
  // label and reset time.
  private mergeRateLimitsBaseline(
    baseline: RateLimitSnapshot,
    // The response map's key is the AUTHORITATIVE metered limit id; the
    // snapshot's own limitId is nullable metadata that may be absent even when
    // the entry is keyed. Callers pass the map key when they have one, so a
    // `{ codex: {limitId: null, ...} }` entry files under "codex" and not
    // under the legacy bucket, where it could lose selection.
    keyOverride?: string,
  ): void {
    const key = keyOverride ?? codexLimitKey(baseline);
    const newer = this.rateLimitBuckets.get(key);
    this.rateLimitBuckets.set(
      key,
      newer ? mergeRateLimitSnapshots(baseline, newer) : baseline,
    );
  }

  // `account/rateLimits/read`, deduped so concurrent refreshes share one
  // request. Failures are swallowed - the caller reports "unknown" and keeps
  // whatever it had. Deliberately re-attemptable on a later call, so a user
  // who signs in mid-session starts seeing the pill without a restart.
  private readRateLimitsOnce(): Promise<void> {
    if (this.rateLimitsReadInFlight) return this.rateLimitsReadInFlight;
    const inFlight: Promise<void> = (async () => {
      try {
        await this.bootstrapPromise;
        if (this.closed || this.bootstrapError) return;
        const resp = await this.client.request<GetAccountRateLimitsResponse>(
          "account/rateLimits/read",
        );
        this.rateLimitsReadSettled = true;
        // Everything here is an OLDER baseline than anything pushed while the
        // request was in flight - see mergeRateLimitsBaseline. The historical
        // single-bucket view has no map key of its own, so it files under its
        // own limitId (or the legacy key); the keyed entries file under their
        // MAP key, which is the authoritative metered id.
        if (resp?.rateLimits) this.mergeRateLimitsBaseline(resp.rateLimits);
        for (const [limitId, snap] of Object.entries(
          resp?.rateLimitsByLimitId ?? {},
        )) {
          if (snap) this.mergeRateLimitsBaseline(snap, limitId);
        }
      } catch {
        // Unauthenticated, API-key-only, or an app-server that doesn't know
        // the method. Not settled: we learned nothing, so the pill keeps
        // whatever it was showing instead of being cleared.
      }
    })().finally(() => {
      if (this.rateLimitsReadInFlight === inFlight) {
        this.rateLimitsReadInFlight = null;
      }
    });
    this.rateLimitsReadInFlight = inFlight;
    return inFlight;
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
  // per-turn auth-coalescing gate so any auth-shaped string - regardless of
  // which codex path produced it - counts as the one allowed signal per
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
      // before turn/completed lands - misleading UX (the model never ran).
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
        // fetches model/list per-auth, so this branch should be rare -
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
        // failure (not a misleading "interrupted" - which the UI treats as
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
        // drift - this handler was previously broken by exactly that kind of
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
      // Isomux's log-view treats each text entry as its own row - surfacing
      // every delta produces a wall of one-word lines followed by the same
      // text repeated whole on item/completed. Single-entry-per-message
      // matches Claude's behavior and is much more readable. Streaming UX
      // could be reintroduced later via an in-place "append to last text
      // entry" mechanism, but that's a UI-level change, not a wire change.
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        break;

      // ---- Subscription rate limits ----
      // Account-scoped, so it carries no threadId and the per-thread filter
      // above lets it through. Codex pushes these as SPARSE rolling updates:
      // a field that arrives null means "unknown right now", not "cleared",
      // hence mergeRateLimits rather than an assignment.
      case "account/rateLimits/updated": {
        const notif = params as
          | AccountRateLimitsUpdatedNotification
          | null
          | undefined;
        if (notif?.rateLimits) this.mergeRateLimits(notif.rateLimits);
        break;
      }

      // ---- Mid-conversation compaction ----
      case "thread/compacted": {
        // ContextCompactedNotification is { threadId, turnId } - no `summary`
        // on the wire, so the old params.summary read was always undefined.
        // Emit the bare marker (matches the contextCompaction item path in
        // translateCompletedItem).
        this.enqueue({ kind: "compacted" });
        break;
      }

      // ---- Failure / warnings ----
      case "error": {
        // ErrorNotification carries the text at params.error.message (TurnError),
        // not params.message; the old read was always undefined and silently
        // swallowed real errors. Same misread as the one-shot path below.
        const err = params?.error as { message?: string } | undefined;
        const message = err?.message;
        if (message) this.enqueue({ kind: "error", message });
        break;
      }
      // Warning/GuardianWarningNotification carry a ready `message`. Route it
      // through the auth-aware funnel: an auth-shaped warning IS the one allowed
      // auth signal for the turn (the coalescing/self-interrupt is intended).
      case "warning":
      case "guardianWarning": {
        const text = params?.message as string | undefined;
        if (text) this.enqueueAuthAwareSystemText(`[${n.method}] ${text}`);
        break;
      }
      // ModelReroutedNotification has NO `message` (the old read silently
      // dropped it, 5acf4941); build the notice from { fromModel, toModel,
      // reason }. PLAIN enqueue, not the auth-aware funnel - a safety reroute is
      // not an auth signal and must not coalesce with or trip the auth interrupt.
      case "model/rerouted": {
        const from = params?.fromModel as string | undefined;
        const to = params?.toModel as string | undefined;
        const reason = params?.reason as string | undefined;
        if (from && to) {
          const why = reason ? ` (${reason})` : "";
          this.enqueue({
            kind: "system_text",
            text: `[${n.method}] model rerouted from ${from} to ${to}${why}`,
          });
        }
        break;
      }
      // Deprecation/ConfigWarningNotification carry { summary, details? }, NOT
      // `message` - also silently dropped before (same bug class as
      // model/rerouted; an unfiled extension of 5acf4941). PLAIN enqueue, not
      // the auth-aware funnel: a configWarning text can legitimately contain an
      // auth-shaped token (a malformed `openai_api_key` config key, a 401/403),
      // which the funnel would drop or latch as the turn's auth interrupt.
      case "deprecationNotice":
      case "configWarning": {
        const summary = params?.summary as string | undefined;
        const details = params?.details as string | undefined;
        if (summary) {
          const extra = details ? ` (${details})` : "";
          this.enqueue({
            kind: "system_text",
            text: `[${n.method}] ${summary}${extra}`,
          });
        }
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
      // map cleanly to our 3-option /resolve UX - auto-decline at v1.
      case "applyPatchApproval":
      case "execCommandApproval":
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        const approvalId = String(req.id);
        const toolName = inferToolNameFromApproval(req.method, params);
        const title = inferApprovalTitle(req.method, params);
        const description = inferApprovalDescription(req.method, params);
        const commandTokens = isExecApprovalMethod(req.method)
          ? commandTokensForPrefixMatch(params)
          : null;
        const suggestedPrefix = offerablePrefix(
          req.method,
          params,
          commandTokens,
        );

        // Already covered by a prefix the user allowed earlier this session?
        // Answer codex directly and never surface a prompt. The match runs on
        // the command text codex is about to execute, NOT on the suggestion
        // attached to this request - codex's suggestion only describes the
        // FIRST segment of a chained command (measured: `mkdir -p g && whoami`
        // suggests just ["mkdir","-p","g"]), so trusting it here would let a
        // chained command ride in on a rule the user set for its harmless head.
        // The breadcrumb is deliberately generic. It fires once per matched
        // command, and the command itself is right there in the tool call it
        // precedes, so naming the rule adds nothing - while quoting rule text
        // on a repeating line is exactly what we don't want in the log.
        if (this.matchSessionPrefix(req.method, params)) {
          this.enqueue({
            kind: "system_text",
            isomuxAuthored: true,
            text: `Auto-approved by a command-prefix rule for this session.`,
          });
          return {
            decision: mapApprovalDecision(req.method, { kind: "allow_once" }),
          };
        }

        // The promise we return is what the JsonRpcLiteClient's handler chain
        // awaits. session.approve() resolves it with the right enum-variant
        // response shape, the client auto-responds, and the handler frame
        // frees. close() rejects any still-pending entries.
        return new Promise<unknown>((resolve, reject) => {
          this.pendingApprovals.set(approvalId, {
            jsonRpcId: req.id,
            toolName,
            method: req.method,
            suggestedPrefix,
            commandTokens,
            cwd: approvalCwd(params),
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
            // Both labels are built here, already safe to display: the
            // orchestrator renders them and never takes them apart again.
            ...(suggestedPrefix
              ? {
                  allowPrefixLabel: suggestedPrefix.join(" "),
                  ...(suggestedPrefix.length > 1
                    ? {
                        allowPrefixExample: suggestedPrefix
                          .slice(0, -1)
                          .join(" "),
                      }
                    : {}),
                }
              : {}),
          });
        });
      }

      // ---- Permissions request: auto-decline with JSON-RPC error ----
      case "item/permissions/requestApproval":
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined permissions request from codex (v1 doesn't expose permission-profile changes - use the spawn dialog to pick a different sandbox/approval policy).`,
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
        // Unknown server request - let the client respond method-not-found.
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
    // user how to opt into project-local config - neither is actionable
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
// We map our /resolve UX to: allow_persistent -> acceptForSession,
// allow_once -> accept, deny -> decline. "cancel" is intentionally not used:
// it interrupts the whole turn, which is harsher than the user typically
// means by a single-tool deny.
//
// allow_prefix maps to the same one-shot allow as allow_once. The rule half
// of that decision is applied inside approve(), in Isomux's own memory -
// codex's "acceptWithExecpolicyAmendment" is NEVER sent, because codex
// persists the amendment to $CODEX_HOME/rules/default.rules where it would
// outlive the session and leak to every other codex agent sharing that home.
function mapApprovalDecision(
  method: string,
  decision: ApprovalDecision,
): string {
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    switch (decision.kind) {
      case "allow_persistent":
        return "approved_for_session";
      case "allow_prefix":
      case "allow_once":
        return "approved";
      case "deny":
        return "denied";
    }
  }
  // v2 command-execution + file-change approvals - same enum variant names.
  switch (decision.kind) {
    case "allow_persistent":
      return "acceptForSession";
    case "allow_prefix":
    case "allow_once":
      return "accept";
    case "deny":
      return "decline";
  }
}

function isExecApprovalMethod(method: string): boolean {
  return (
    method === "execCommandApproval" ||
    method === "item/commandExecution/requestApproval"
  );
}

// One session-scoped allow: a command prefix plus the directory it applies to.
interface AllowPrefixRule {
  tokens: string[];
  cwd: string | null;
}

// Does rule `a` already cover everything rule `b` would allow?
function ruleCovers(a: AllowPrefixRule, b: AllowPrefixRule): boolean {
  return a.cwd === b.cwd && tokensStartWith(b.tokens, a.tokens);
}

// The directory a command approval would run in. Null when absent or not a
// string, which simply makes it its own scope - rules granted from such an
// approval only ever match other approvals that are equally cwd-less.
function approvalCwd(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const cwd = (params as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

// The prefix rule this approval may offer, or null for "no option 4 here".
// Codex suggests one in `proposedExecpolicyAmendment` - its own idea of "the
// rule that would stop this prompt coming back", e.g. ["rg", "--files"] - and
// this is where that suggestion has to earn its place. Four gates, all
// required:
//
//   1. The exact v2 method. Not "is this an exec approval": the legacy
//      execCommandApproval has no such field today, and if some future codex
//      grew one we would rather not have quietly sprouted a new option on a
//      path nobody designed for it.
//   2. The command itself must be plain argv. A chained or quoted command
//      can't be covered by a rule at all, so offering the option would be
//      offering something guaranteed to be refused.
//   3. Every suggested token must be plain argv too. That is display safety
//      as much as matching: the tokens are shown back inside backticks, and a
//      token holding whitespace or a backtick would render an ambiguous - or
//      forged - rule in the prompt.
//   4. The suggestion must be the START of the command being approved. This
//      is the one that matters: without it, a request could ask to run
//      command A while suggesting a perfectly innocuous-looking rule B, and
//      a user answering "4" about A would be storing a rule about B. The
//      invariant is the same one typed prefixes obey - a rule can only ever
//      describe the command in front of you.
//
// Exported for tests.
export function offerablePrefix(
  method: string,
  params: unknown,
  commandTokens: string[] | null,
): string[] | null {
  if (method !== "item/commandExecution/requestApproval") return null;
  if (!commandTokens) return null;
  if (!params || typeof params !== "object") return null;
  const raw = (params as Record<string, unknown>).proposedExecpolicyAmendment;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((t) => typeof t === "string" && PLAIN_ARGV_TOKEN.test(t)))
    return null;
  const suggestion = raw as string[];
  if (!tokensStartWith(commandTokens, suggestion)) return null;
  return suggestion;
}

// Split a plain-argv command line into tokens, or null if it isn't one. The
// single place that decides what "a token" means; both the command codex sent
// and any prefix the user typed go through it.
function splitPlainArgv(text: string): string[] | null {
  const tokens = text.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => PLAIN_ARGV_TOKEN.test(t))) return null;
  return tokens;
}

// One token of a "plain argv" command line. This is an ALLOWLIST on purpose:
// a denylist of shell metacharacters is one forgotten character (or one new
// shell feature) away from matching a rule against something the user never
// agreed to. Everything outside this set - quoting, escaping, expansion,
// globbing, redirection, chaining, comments, braces, tildes, control
// characters, anything non-ASCII - puts the command outside the matcher
// entirely, and it gets a prompt like any other.
const PLAIN_ARGV_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;

// The tokens of the single command this approval is about, or null when we
// can't be sure what "the command" is. Null means "ask the user", and every
// uncertain case lands there:
//   - not exactly one parsed command action (nothing unambiguous to match)
//   - a missing or non-string command
//   - a command that isn't plain argv by the grammar above
// Note what this deliberately does NOT do: it reads `commandActions` only to
// pick out the one command STRING codex is about to run, and re-derives the
// tokens itself. Codex's own parse (the action `type`, its `path` field, its
// suggested amendment) is never treated as authority over what will execute.
//
// Runs of spaces collapse - `rg  --files` and `rg --files` are the same
// command line. Any other whitespace (tab, newline, CR) stays inside its
// token and is rejected by the grammar.
// Exported for tests.
export function commandTokensForPrefixMatch(params: unknown): string[] | null {
  if (!params || typeof params !== "object") return null;
  const actions = (params as Record<string, unknown>).commandActions;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const command = (actions[0] as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  return splitPlainArgv(command);
}

function tokensStartWith(tokens: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length > tokens.length) return false;
  return prefix.every((token, i) => tokens[i] === token);
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
// Attachments are NEVER inlined (no localImage, no text-file contents) - each
// becomes one path-notice line from the shared attachment convention
// (server/attachment-prompt.ts), identical across backends; the agent opens
// files on demand (view_image for images, shell tools otherwise). This
// wrapper only puts the shared lines into Codex UserInput text items.
// Exported for tests.
export function buildCodexUserInput(
  text: string,
  attachments: AttachmentSpec[] | undefined,
  agentId: string,
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  if (text) {
    inputs.push({ type: "text", text, text_elements: [] });
  }
  const lines = formatAttachmentLines(
    resolveAttachmentNotices(agentId, attachments ?? []),
  );
  if (lines.length > 0) {
    inputs.push({ type: "text", text: lines.join("\n"), text_elements: [] });
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
    // mirrors oneShotPrompt but skips thread/start - model/list is a
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
          // Decline attestation/generate: the adapter doesn't handle that
          // server request yet (task cdbc2f3e), so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
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
    // message edit drops everything and starts the child from scratch - but
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
          // Decline attestation/generate: the adapter doesn't handle that
          // server request yet (task cdbc2f3e), so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
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
          // Decline attestation/generate: the adapter doesn't handle that
          // server request yet (task cdbc2f3e), so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
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
    // one-shot prompt flow.
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
          // Decline attestation/generate: the adapter doesn't handle that
          // server request yet (task cdbc2f3e), so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
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
            // ErrorNotification text is at params.error.message (TurnError), not
            // params.message (mirrors the streaming error arm in handleNotification).
            const err = params?.error as { message?: string } | undefined;
            const msg = err?.message;
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
