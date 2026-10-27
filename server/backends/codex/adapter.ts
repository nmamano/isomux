// Codex backend adapter.
//
// Implements the Backend / BackendSession contracts (server/backends/types.ts)
// against the Codex App Server's JSON-RPC lite protocol via the
// JsonRpcLiteClient in ./client.ts. One CodexSession owns one threadId and
// one subprocess for v1 - symmetric with Claude. The client layer is built so
// a future shared-subprocess deployment can swap in without touching this
// adapter (subscribers filter by threadId from day one).
//
// Critical invariants this code maintains:
//
//   1. Exactly one turn_completed NormalizedEvent per send(). Codex emits one
//      turn/completed per turn (Completed or Failed); turn/interrupted maps
//      to status:"interrupted". Subprocess death mid-turn synthesizes a
//      failed turn_completed so the orchestrator's pendingTurn unblocks.
//      A turn that stays silent after a terminal error notification is ended
//      as failed by the turn watchdog, and its late turn/completed is dropped.
//
//   2. Per-thread filtering. Every codex notification with a threadId is
//      filtered against this session's threadId. Sub-agent / review-mode
//      child threads have their own ids and must never resolve our turn.
//      One deliberate carve-out: a KNOWN child thread's
//      item/started and item/completed surface as subagent tool activity -
//      display only, never turn bookkeeping.
//
//   3. experimentalApi: true at initialize. We generated schemas with
//      --experimental, so missing this flag would silently strip experimental
//      fields on the wire.

import { readFileSync, statSync } from "fs";
import { basename } from "path";
import { filterMissingToolOutputRepeats } from "../../../shared/codex-diagnostics.ts";

import { saveFile } from "../../persistence.ts";
import {
  resolveAttachmentNotices,
  formatAttachmentLines,
} from "../../attachment-prompt.ts";
import { mimeTypeForFilename } from "../../mime-types.ts";
import { markdownInlineCode } from "../../../shared/format-human.ts";
import { errMessage } from "../../../shared/errors.ts";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import {
  msg,
  renderLogText,
  type LogMessage,
} from "../../../shared/i18n/log-message.ts";
import {
  inertMarkdown,
  providerRefusal,
  providerText,
} from "../provider-text.ts";
import { authSignal } from "../auth-signal.ts";
import { sanitizeTaskLabel } from "../task-label.ts";
import { effectiveCodexSandbox } from "./sandbox-probe.ts";
import {
  CODEX_DEFAULT_SANDBOX,
  type BackgroundTask,
  type SubagentOrigin,
} from "../../../shared/types.ts";
import { BackendNotConfiguredError } from "../../internal-types.ts";
import {
  codexRolloutFileExists,
  codexSessionsDir,
  inspectCodexStoredSession,
} from "../../cwd-utils.ts";

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
  LoginInstructions,
  ModelOption,
  NormalizedEvent,
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
  SessionAccessOptions,
  SubscriptionUsageResult,
  SubscriptionUsageWindow,
  TokenUsage,
} from "../types.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";

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
import { SAFETY_WARNING } from "./safety-hook.ts";
import type {
  CodexSafetyHookIdentity,
  CodexSafetyPreflightResult,
} from "./safety-hook-install.ts";
import {
  codexWrapperCommandForShell,
  ensureCodexWrapperScript,
  codexEnvApiKeyWins,
  getCodexLoginCommands,
  isCodexAuthenticated,
} from "./native-bin.ts";

import type { InitializeParams } from "./_generated/InitializeParams.ts";
import type { InitializeResponse } from "./_generated/InitializeResponse.ts";
import type { Model as CodexProtocolModel } from "./_generated/v2/Model.ts";
import type { ModelListParams } from "./_generated/v2/ModelListParams.ts";
import type { ModelListResponse } from "./_generated/v2/ModelListResponse.ts";
import type { ThreadForkParams } from "./_generated/v2/ThreadForkParams.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./_generated/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./_generated/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { TokenUsageBreakdown } from "./_generated/v2/TokenUsageBreakdown.ts";
import type { AccountRateLimitsUpdatedNotification } from "./_generated/v2/AccountRateLimitsUpdatedNotification.ts";
import type { ErrorNotification } from "./_generated/v2/ErrorNotification.ts";
import type { ToolRequestUserInputResponse } from "./_generated/v2/ToolRequestUserInputResponse.ts";
import type { GetAccountRateLimitsResponse } from "./_generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./_generated/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./_generated/v2/RateLimitWindow.ts";
import type { PlanType } from "./_generated/PlanType.ts";

// Isomux runs codex against its own isolated CODEX_HOME (~/.isomux/codex-home/
// by default), separate from the user's interactive `~/.codex/`. That means
// the user needs a one-time `codex login` against isomux's CODEX_HOME - the
// [Copy to terminal] card alongside this message has the exact command.
//
// The terminal card targets the default `~/.isomux/codex-home/`. Users with a
// managed personal variable `CODEX_HOME`
// (e.g. `~/.isomux-users/<name>/.codex` for billing isolation, see
// internal-docs/isolation-design.md) need to prefix the pasted command
// with their own `CODEX_HOME=<path>` before pressing Enter - the wrapper's
// default only kicks in when CODEX_HOME is unset.
// Same wrapper command the [Copy to terminal] card uses, so the prose and the
// card never disagree - `~/.isomux/bin/codex` at the default root (byte-for-
// byte prod), the active wrapper path under an ISOMUX_HOME override.
const codexLoginCmd = codexWrapperCommandForShell();
// The sign-in walkthrough. The JSON-RPC reply to a token refresh request is
// for the engine, so it carries the English render.
function loginInstructions(): LogMessage {
  return msg("systemEntries.loginInstructions.codex", {
    command: codexLoginCmd,
  });
}

// A provider refusal as the member line (task 2bd836d5), or null when the
// error is not one: a 401 and "unauthorized" stay on the sign-in path, and
// usage limits, capacity and Codex's own failures keep their paths.
export function codexProviderRefusal(
  error:
    | { message?: string | null; codexErrorInfo?: unknown }
    | null
    | undefined,
  provider: string,
): LogMessage | null {
  if (!error || !isCodexRefusal(error.codexErrorInfo)) return null;
  const message = providerText(error.message ?? undefined);
  return message === null ? null : providerRefusal(provider, message);
}

const CODEX_REFUSAL_KINDS = new Set([
  "rateLimitExceeded",
  "flexUnavailable",
  "cyberPolicy",
  // Codex 0.160 (codex-rs/protocol/src/error.rs); not in the generated
  // CodexErrorInfo yet.
  "bioPolicy",
  "invalidPrompt",
  "misalignmentPolicyViolation",
]);

// The variants that carry the provider's HTTP status.
const CODEX_HTTP_KINDS = [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseTooManyFailedAttempts",
];

function isCodexRefusal(info: unknown): boolean {
  if (typeof info === "string") return CODEX_REFUSAL_KINDS.has(info);
  if (!info || typeof info !== "object") return false;
  for (const kind of CODEX_HTTP_KINDS) {
    const variant = (info as Record<string, unknown>)[kind];
    if (!variant || typeof variant !== "object") continue;
    const status = (variant as { httpStatusCode?: unknown }).httpStatusCode;
    return (
      typeof status === "number" &&
      status >= 400 &&
      status <= 499 &&
      status !== 401
    );
  }
  return false;
}

// Benign Codex stderr lines, dropped from the chat one line at a time. None
// is actionable for an Isomux member:
// - bubblewrap: Codex logs this at ERROR level, but it is a note on how its
//   Linux sandbox works.
// - trusted project: Codex logs this at ERROR level; it tells the user how
//   to opt into project-local config.
// - PATH aliases: Codex refuses to create its helper binaries when
//   CODEX_HOME is under the temp dir (an ISOMUX_HOME under /tmp), then
//   proceeds without them (task a671cf65).
const BENIGN_STDERR_LINES = [
  /bubblewrap.*needs access to create user namespaces/i,
  /until the project is trusted, but skills still load/i,
  /could not create PATH aliases/i,
];

// A 403 is the provider refusing the request, not a sign-in failure (task
// 2bd836d5): Codex logs it on stderr, and a match there would interrupt the
// turn before the refusal reaches the member.
const AUTH_ERROR_PATTERNS =
  /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|chatgpt.*login|openai_api_key|401/i;

// The one Codex sign-in predicate: the session's auth signals and
// codexBackend.detectAuthError both use it.
function detectCodexAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.test(text);
}

// Per-thread config overrides, sent with every thread/start and
// thread/resume (the `config` map takes dotted keys, same as `-c`). A
// per-thread override beats editing the shared config.toml under CODEX_HOME
// (no file mutation, and it holds for a per-user CODEX_HOME too), and it wins
// over the same key in config.toml. Codex type-checks these keys (a
// non-boolean is rejected at thread/start) but ignores an unknown key
// silently, so the adapter test pins the exact spelling.
// - Memories: backend-native memory is off in every isomux launch: isomux
//   memory is the only memory an office agent has, so it carries over when
//   the agent's backend changes. Codex 0.144 ships a memories feature whose
//   keys upstream documents as defaulting to true; pinning both keeps a
//   default flip from turning it on.
// - Network: Codex's sandbox blocks all network, loopback included, so a
//   sandboxed agent could not reach the office API. Codex applies this key
//   only in workspace-write, and it overrides a member's config.toml
//   `network_access = false` (Nil's ruling, 2026-10-25: the sandbox limits
//   files, not network). Read-only has no config key; its network goes on
//   every turn/start (codexTurnSandboxPolicy).
const CODEX_THREAD_CONFIG_OVERRIDES: Readonly<Record<string, boolean>> = {
  "memories.use_memories": false,
  "memories.generate_memories": false,
  "sandbox_workspace_write.network_access": true,
};

// The turn-level sandbox policy for a thread's sandbox mode, else null. Codex
// 0.164 has no config key for read-only network access, only this turn/start
// field. Codex keeps it for later turns, but thread/resume resets the thread
// to the plain mode, so every turn/start sends it.
export function codexTurnSandboxPolicy(
  sandbox: string,
): { type: "readOnly"; networkAccess: true } | null {
  return sandbox === "read-only"
    ? { type: "readOnly", networkAccess: true }
    : null;
}

// The thread config of an agent session: the pins above and the remote MCP
// servers Isomux registers (server/mcp-servers.ts) as `mcp_servers.<name>`
// with `url` and `http_headers`. This map goes over the app-server's stdin;
// `-c` (argv), `env_http_headers` and `bearer_token_env_var` (environment)
// would expose the header. Codex merges it with config.toml per key, so the
// names carry Isomux's reserved prefix.
export function codexThreadConfig(
  mcpServers: AgentMcpServer[] | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...CODEX_THREAD_CONFIG_OVERRIDES };
  for (const server of mcpServers ?? []) {
    config[`mcp_servers.${server.name}`] = {
      url: server.url,
      http_headers: { ...server.headers },
    };
  }
  return config;
}

// Capability flags for the Codex backend. Match the spec's parity table.
// hooks: false - Codex emits hook/* notifications but provides no
// programmatic register-from-client surface at 0.130 (v1).
// edit: true - implemented via thread/fork with beforeTurnId: the child
// excludes the edited message's turn and every later turn, and the parent is
// preserved. See forkSessionBeforeMessage below.
const CAPABILITIES: BackendCapabilities = {
  fork: false,
  hooks: false,
  skills: true,
  canUseTool: true,
  topicGen: true,
  edit: true,
  mcp: true,
  autoHandoff: true,
  limitResume: true,
};

// Static model options - FALLBACK only. The live set comes from
// codexBackend.listModels() (model/list RPC), which returns the
// auth-appropriate subset (ChatGPT-login vs API-key users see different
// sets) with per-model supportedReasoningEfforts. This list backs
// getModelOptions() and modelDisplayLabel() when the RPC isn't available.
// Slugs listed by `codex debug models` on codex-cli 0.164.0, 2026-10-25;
// mirror of CODEX_MODELS in shared/types.ts.
const MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.5", label: "GPT-5.5" },
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

// Raw turn shape assembled from the paged turn and item APIs. We type loosely
// here because the orchestrator only consumes a couple of fields; the
// generated Turn type is richer than we need.
interface RawTurn {
  id: string;
  // ThreadItem union is broad (~20 variants); the consumers here narrow by
  // `type` and read id/text/content directly. Keep loose to avoid coupling
  // the helper to the generated schema.
  items: unknown[];
}

const THREAD_HISTORY_PAGE_LIMIT = 100;
const THREAD_HISTORY_PAGE_CAP = 1_000;

// JSON-RPC "method not found". Codex answers thread/items/list with it for a
// thread stored with legacy history (threads from before paginated history);
// those threads still list their turns with the items inline.
const JSON_RPC_METHOD_NOT_FOUND = -32601;

// What the model receives as the answer to each request_user_input question.
const REQUEST_USER_INPUT_ANSWER =
  "The member cannot see this question. Ask it in your reply, then end your turn and wait for the member's answer.";

// One pass over thread/turns/list. With itemsView "full" each turn carries its
// items; with "notLoaded" the items come from thread/items/list.
async function listThreadTurns(
  client: Pick<JsonRpcLiteClient, "request">,
  threadId: string,
  itemsView: "notLoaded" | "full",
): Promise<RawTurn[]> {
  const turns: RawTurn[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  const seenTurnCursors = new Set<string>();
  for (let page = 0; page < THREAD_HISTORY_PAGE_CAP; page += 1) {
    const resp: { data?: unknown[]; nextCursor?: string | null } =
      await client.request<{
        data?: unknown[];
        nextCursor?: string | null;
      }>("thread/turns/list", {
        threadId,
        cursor,
        limit: THREAD_HISTORY_PAGE_LIMIT,
        sortDirection: "asc",
        itemsView,
      });
    for (const raw of resp.data ?? []) {
      const id = (raw as { id?: unknown })?.id;
      if (typeof id !== "string" || seenIds.has(id)) continue;
      const items = (raw as { items?: unknown })?.items;
      turns.push({
        id,
        items:
          itemsView === "full" && Array.isArray(items)
            ? [...(items as unknown[])]
            : [],
      });
      seenIds.add(id);
    }
    const next: string | null = resp.nextCursor ?? null;
    if (!next) break;
    if (seenTurnCursors.has(next))
      throw new Error("thread/turns/list returned a repeated cursor");
    seenTurnCursors.add(next);
    cursor = next;
    if (page === THREAD_HISTORY_PAGE_CAP - 1)
      throw new Error("thread/turns/list exceeded the page cap");
  }
  return turns;
}

// Paged parent-thread history. Used by
// both getSessionMessages (flattens to NormalizedMessage[]) and
// forkSessionBeforeMessage (needs the turn that holds the edited message).
export async function readThreadTurns(
  client: Pick<JsonRpcLiteClient, "request">,
  threadId: string,
): Promise<RawTurn[]> {
  const turns = await listThreadTurns(client, threadId, "notLoaded");
  const byId = new Map(turns.map((turn) => [turn.id, turn]));

  let cursor: string | null = null;
  const seenItemCursors = new Set<string>();
  for (let page = 0; page < THREAD_HISTORY_PAGE_CAP; page += 1) {
    let resp: {
      data?: Array<{ turnId?: unknown; item?: unknown }>;
      nextCursor?: string | null;
    };
    try {
      resp = await client.request<{
        data?: Array<{ turnId?: unknown; item?: unknown }>;
        nextCursor?: string | null;
      }>("thread/items/list", {
        threadId,
        cursor,
        limit: THREAD_HISTORY_PAGE_LIMIT,
        sortDirection: "asc",
      });
    } catch (err) {
      if (
        page === 0 &&
        (err as { code?: unknown })?.code === JSON_RPC_METHOD_NOT_FOUND
      )
        return listThreadTurns(client, threadId, "full");
      throw err;
    }
    for (const entry of resp.data ?? []) {
      if (typeof entry.turnId === "string" && entry.item !== undefined)
        byId.get(entry.turnId)?.items.push(entry.item);
    }
    const next: string | null = resp.nextCursor ?? null;
    if (!next) break;
    if (seenItemCursors.has(next))
      throw new Error("thread/items/list returned a repeated cursor");
    seenItemCursors.add(next);
    cursor = next;
    if (page === THREAD_HISTORY_PAGE_CAP - 1)
      throw new Error("thread/items/list exceeded the page cap");
  }
  return turns;
}

// Locate the turn (by index) whose items array contains an item with the
// given id. Returns -1 if not found. Used by forkThreadBeforeItem to
// translate from item-level message uuid → the turn to fork before.
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

// Fork a thread so that the child ends before the turn that holds
// targetItemId. The edit target is a message isomux sent with turn/start, so
// it opens its turn, and that turn and every later one are excluded
// (thread/fork beforeTurnId). An agent steer is a userMessage inside a running
// turn (turn/steer), but it is never an edit target. null forks the whole
// history. Returns the child thread id. Codex 0.160 has no thread/rollback,
// so the fork must not be rolled back after the fact.
export async function forkThreadBeforeItem(
  client: Pick<JsonRpcLiteClient, "request">,
  threadId: string,
  targetItemId: string | null,
): Promise<string> {
  const params: ThreadForkParams = { threadId, excludeTurns: true };
  if (targetItemId !== null) {
    const turns = await readThreadTurns(client, threadId);
    const targetTurnIndex = findTurnIndexContainingItemId(turns, targetItemId);
    if (targetTurnIndex === -1) {
      throw new Error(
        "forkSessionBeforeMessage: target message not found in thread turns",
      );
    }
    params.beforeTurnId = turns[targetTurnIndex].id;
  }
  const resp = await client.request<{ thread: { id: string } }>(
    "thread/fork",
    params,
  );
  return resp.thread.id;
}

// Codex TokenUsageBreakdown -> our Claude-style TokenUsage (mapping at the
// thread/tokenUsage/updated handler). null gives all zeros.
function codexTokenUsage(b: TokenUsageBreakdown | null): TokenUsage {
  return {
    inputTokens: b ? Math.max(0, b.inputTokens - b.cachedInputTokens) : 0,
    outputTokens: b ? b.outputTokens : 0,
    cacheReadInputTokens: b ? b.cachedInputTokens : 0,
    cacheCreationInputTokens: 0,
  };
}

// Per-field a - b, floored at zero.
function subtractTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadInputTokens: Math.max(
      0,
      a.cacheReadInputTokens - b.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: 0,
  };
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

// Human label for a rate-limit window, derived from its duration. Codex names
// its windows "primary"/"secondary", and which of the two is the weekly one
// has moved across codex versions - the duration is the stable fact, so the
// label (and the pick of which window the pill shows) comes from it.
function codexWindowLabel(minutes: number | null): string {
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

function codexResetsAtMs(resetsAt: unknown): number | null {
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

function codexLimitKey(snapshot: RateLimitSnapshot): string {
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
function resolveCodexUpdateKey(
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
function pickCodexLimitBucket(
  buckets: Map<string, RateLimitSnapshot>,
): { key: string; snapshot: RateLimitSnapshot } | null {
  for (const key of [CODEX_PREFERRED_LIMIT_ID, CODEX_LEGACY_LIMIT_KEY]) {
    const snapshot = buckets.get(key);
    if (snapshot) return { key, snapshot };
  }
  const first = buckets.entries().next().value;
  return first ? { key: first[0], snapshot: first[1] } : null;
}

// Merge one rolling window update into what we already knew about that slot.
// The sparse rule is RECURSIVE: an update can carry a fresh usedPercent while
// leaving windowDurationMins / resetsAt null, and treating the whole window as
// replaced would throw away the duration the label is derived from - the
// window would silently become "Plan allowance" with no reset time the first
// time a percentage-only update arrived. usedPercent is the live value and is
// always taken from the update; the nullable metadata falls back.
function mergeRateLimitWindow(
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
    // Nothing reads it yet. Falling back on null is our convention for
    // metadata here, not a documented upstream contract.
    normalModelSlug: newer.normalModelSlug ?? older.normalModelSlug,
    // A null window is "not in this update", not "this window is gone". An
    // account that genuinely loses a window reports it via a fresh read (or a
    // new limitId), not by omitting it from a rolling update.
    primary: mergeRateLimitWindow(older.primary, newer.primary),
    secondary: mergeRateLimitWindow(older.secondary, newer.secondary),
    credits: newer.credits ?? older.credits,
    individualLimit: newer.individualLimit ?? older.individualLimit,
    // THE ONE FIELD THAT DOES NOT FALL BACK. Every other nullable field here
    // treats null as "not in this update" and keeps the older value. The
    // generated schema says the opposite for this one: "`None` is unavailable,
    // not a sparse-update recovery". So a newer null means the backend is no
    // longer telling us, and carrying the old answer forward would invent a
    // spend-control state nobody reported. Newer wins exactly, null included.
    spendControlReached: newer.spendControlReached,
    planType: newer.planType ?? older.planType,
    rateLimitReachedType:
      newer.rateLimitReachedType ?? older.rateLimitReachedType,
  };
}

// Wire plan slugs -> the labels Codex itself shows in /status, copied from
// openai/codex rust-v0.164.0 codex-rs/tui/src/subscription.rs
// (SubscriptionDisplay::Status; sci and sci_plus take KnownPlan::display_name
// in codex-rs/protocol/src/auth.rs). Typed over the whole PlanType union, so a
// schema regen that adds a plan fails the typecheck until it has a label.
// A slug outside the union passes through verbatim.
const CODEX_PLAN_DISPLAY_NAMES: Record<PlanType, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro 200",
  prolite: "Pro 100",
  promax: "Pro 500",
  team: "Business",
  self_serve_business_usage_based: "Business",
  business: "Enterprise",
  self_serve_business_prolite: "Business Premium",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
  unknown: "Unknown",
};

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
      plan: snapshot.planType
        ? (CODEX_PLAN_DISPLAY_NAMES[snapshot.planType] ?? snapshot.planType)
        : null,
      windows: scored.map((s) => s.window),
    },
  };
}

// Which child-thread items surface in the parent's transcript. Tool activity
// only, matching Claude subagents: a child's agentMessage/reasoning stays
// internal, and parent-scoped markers (contextCompaction -> `compacted`)
// must never fire from a child.
const SUBAGENT_VISIBLE_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);

const LATE_TOOL_RESULT_NOTICE = "Turn ended before this tool result arrived.";

function isToolActivityItem(rawItem: unknown): boolean {
  const type = (rawItem as { type?: unknown } | null)?.type;
  return typeof type === "string" && SUBAGENT_VISIBLE_ITEMS.has(type);
}

// Tool items whose card shows at item/started, so a long command has its card
// while it runs. Their started items already carry the card's input. A
// webSearch is not here: its query is empty until item/completed.
const CARD_AT_START_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "collabAgentToolCall",
]);

// The card of a tool item, the same from its started and its completed item.
// Null for an item that is not a tool call.
function toolCallFor(
  item: Record<string, unknown>,
  subagent?: SubagentOrigin,
): Extract<NormalizedEvent, { kind: "tool_call" }> | null {
  const toolUseId = item.id as string;
  const origin = subagent ? { subagent } : {};
  switch (item.type) {
    case "commandExecution": {
      const command = item.command as string | undefined;
      const cwd = item.cwd as string | undefined;
      return {
        kind: "tool_call",
        toolUseId,
        name: "Bash",
        input: cwd ? { command, cwd } : { command },
        ...origin,
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        kind: "tool_call",
        toolUseId,
        name: "Edit",
        input: { changes },
        ...origin,
      };
    }
    case "mcpToolCall":
      return {
        kind: "tool_call",
        toolUseId,
        name: `mcp__${item.server as string}__${item.tool as string}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
        ...origin,
      };
    case "webSearch": {
      const query = item.query as string | undefined;
      return {
        kind: "tool_call",
        toolUseId,
        name: "WebSearch",
        input: query ? { query } : {},
        ...origin,
      };
    }
    case "collabAgentToolCall": {
      const prompt = typeof item.prompt === "string" ? item.prompt : null;
      const model = typeof item.model === "string" ? item.model : null;
      const receivers = collabReceivers(item);
      return {
        kind: "tool_call",
        toolUseId,
        name: typeof item.tool === "string" ? item.tool : "collabAgent",
        input: {
          ...(prompt ? { prompt } : {}),
          ...(model ? { model } : {}),
          ...(receivers.length ? { threadIds: receivers } : {}),
        },
      };
    }
    default:
      return null;
  }
}

function collabReceivers(item: Record<string, unknown>): string[] {
  return Array.isArray(item.receiverThreadIds)
    ? (item.receiverThreadIds as string[])
    : [];
}

// One bounded line for SubagentOrigin labels (same 200-char cap as
// sanitizeTaskLabel in ../task-label.ts - the UI pill ellipsizes, but the
// metadata is persisted per entry).
function subagentLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

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
  start(): Promise<CodexSafetyPreflightResult>;
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
  sandbox?: string; // SandboxMode enum string; falls back to CODEX_DEFAULT_SANDBOX
  env?: { [key: string]: string | undefined };
  resumeThreadId?: string;
  // Remote MCP servers for the thread config (codexThreadConfig).
  mcpServers?: AgentMcpServer[];
  // Codex's native plan collaboration mode: true sets it, false clears it,
  // undefined keeps what a resumed thread has.
  planMode?: boolean;
  // Test seam (T2 adapter contract): inject a fake transport to drive the real
  // translation with curated provider events. Undefined in production, where
  // the constructor builds a real JsonRpcLiteClient.
  client?: CodexTransport;
  // Deterministic timer seam for capacity-retry contract tests and the bound
  // on a usage-limited turn's rate-limit read.
  scheduleRetry?: (delayMs: number, run: () => void) => () => void;
  // Deterministic timer seam for the turn watchdog (CODEX_TURN_ERROR_WATCHDOG_MS).
  scheduleTurnWatchdog?: (delayMs: number, run: () => void) => () => void;
  // Deterministic timer seam for the background-terminal poll
  // (CODEX_BACKGROUND_POLL_MS).
  scheduleBackgroundPoll?: (delayMs: number, run: () => void) => () => void;
}

const CODEX_CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

// The longest a usage-limited turn's end waits for a rate-limit read.
export const CODEX_LIMIT_RESET_READ_MS = 3_000;

// While a thread has background terminals, how often the session lists them.
export const CODEX_BACKGROUND_POLL_MS = 30_000;

// How long a turn may stay silent after a terminal error notification before
// the session ends it as failed itself.
export const CODEX_TURN_ERROR_WATCHDOG_MS = 60_000;
const CODEX_TURN_WATCHDOG_FALLBACK =
  "Codex sent an error and then stopped responding.";

type TurnErrorLike = { message?: string | null; codexErrorInfo?: unknown };

// When the usage limit that stopped a turn resets, from the account's
// rate-limit snapshot (epoch ms), or null when the snapshot does not say.
// rateLimitReachedType "rate_limit_reached" is a window limit; the workspace
// credit and usage-limit types, and a reached spend control, do not end at a
// window reset, so they give null. A snapshot that does not name the type
// counts only when a window is at 100%. The reset is the latest one among the
// windows at the limit (both must reset before a turn can run), or, when none
// reports 100%, among the fullest windows. Exported for tests.
export function codexUsageLimitResetMs(
  snapshot: RateLimitSnapshot | null,
): number | null {
  if (!snapshot || snapshot.spendControlReached === true) return null;
  const reached = snapshot.rateLimitReachedType;
  if (reached !== null && reached !== "rate_limit_reached") return null;
  const windows = [snapshot.primary, snapshot.secondary].flatMap((w) => {
    const at = w ? codexResetsAtMs(w.resetsAt) : null;
    return w && at !== null ? [{ used: w.usedPercent, at }] : [];
  });
  const full = windows.filter((w) => w.used >= 100);
  if (reached === null && full.length === 0) return null;
  const top = Math.max(...windows.map((w) => w.used));
  const chosen = full.length > 0 ? full : windows.filter((w) => w.used === top);
  if (chosen.length === 0) return null;
  return Math.max(...chosen.map((w) => w.at));
}

export class CodexSession implements BackendSession {
  private client: CodexTransport;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  // Steer ids sent with turn/steer that codex has not recorded yet.
  private readonly pendingSteerIds = new Set<string>();
  private buffer: NormalizedEvent[] = [];
  private resolveWake: (() => void) | null = null;
  private ended = false;
  private closed = false;
  // Tracks whether we've yielded turn_completed for the current turn so we
  // can synthesize a failed one on subprocess exit if not.
  private turnInFlight = false;
  // Covers the turn/start request window without weakening turnInFlight's
  // stricter invariant: a request that has not succeeded must not cause a
  // later subprocess exit to synthesize a phantom turn_completed.
  private turnStarting = false;
  // Codex can deliver completed tool items after the matching turn/completed.
  // The orchestrator keeps those results as evidence, and this latch adds one
  // terminal breadcrumb per episode rather than one repeated line per item.
  // A successful turn/start clears it for the next real turn.
  private lateToolResultNoticeEmitted = false;
  // Distinguishes a genuinely late item from a curated/pre-turn item received
  // while the session is idle. Armed only by the terminal notification that
  // establishes the ordering defect.
  private lateToolResultNoticeArmed = false;
  // Auth-error coalescing for codex stderr. Codex CLI internally retries the
  // OpenAI websocket 5+ times on 401 with exponential backoff, emitting one
  // `ERROR ... 401 Unauthorized` stderr line per retry. Forwarding each one
  // as system_text triggers the auth-detect path in agent-manager on every
  // line and pastes the sign-in card repeatedly, producing an "infinite loop"
  // UX. Symmetric with the Claude SDK,
  // which emits at most one auth signal per send: gate auth-shaped stderr
  // to one signal per user-initiated turn (`authSignalsAllowedThisTurn`
  // opens before turn/start in send(), closes on turn/completed or send
  // failure; `authSignalEmittedThisTurn` is the once-per-turn latch).
  // Pre-turn stderr (codex's startup websocket pre-warm) is silenced.
  private authSignalsAllowedThisTurn = false;
  private authSignalEmittedThisTurn = false;
  private readonly missingToolOutputNotices = new Set<string>();
  // Set when we ourselves issue turn/interrupt to short-circuit codex's
  // ~12s websocket retry budget on a doomed-by-auth turn. The natural
  // turn/completed from codex will land with status="interrupted"; the
  // turn/completed handler maps it back to status="failed" + the standard
  // auth summary so the user sees a clear failure, not a vague "interrupted".
  private selfInterruptedForAuth = false;
  private capacityErrorThisAttempt: string | null = null;
  // The refusal line of this attempt's terminal error notification. Codex
  // sends the same error again on the failed turn/completed, which shows it.
  private refusalThisAttempt: LogMessage | null = null;
  // This attempt's last terminal error notification, for the turn watchdog.
  private terminalErrorThisAttempt: TurnErrorLike | null = null;
  private cancelTurnWatchdog: (() => void) | null = null;
  // The turn the watchdog ended. Its own turn/completed can still arrive,
  // even after the next turn started, and is dropped. A known id is kept
  // until that completion; an unknown id (null) drops the first completion
  // while no turn is in flight, until the next successful turn/start.
  private abandonedTurn: { id: string | null } | null = null;
  // The provider Codex reports for the thread (thread/start, thread/resume).
  private modelProvider = "openai";
  // A usage limit ended this turn (codexErrorInfo "usageLimitExceeded").
  private usageLimitThisTurn = false;
  // Codex's limit error, held until the turn's end shows whether a reset time
  // replaces it: its sentence names the server's time zone, and agent-manager
  // words the reset for each reader (endUsageLimitedTurn).
  private heldLimitEvents: NormalizedEvent[] = [];
  // Items of this attempt the chat already shows: completed items and tool
  // cards shown at item/started. A capacity retry runs only while it is 0.
  private shownItemsThisAttempt = 0;
  // Ids of tool items whose card was shown at item/started. Their completed
  // item adds only the result. Not cleared at turn end: codex can complete an
  // item after turn/completed.
  private readonly shownToolCalls = new Set<string>();
  private capacityRetryCount = 0;
  private cancelCapacityRetry: (() => void) | null = null;
  // The sandbox mode the thread runs with (effectiveCodexSandbox), set at
  // bootstrap. Picks the turn-level policy in turnStartParams.
  private effectiveSandbox = "";
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
  // Resumed threads only. Codex's `total` counts from thread start, and after
  // thread/resume codex may replay the last persisted usage under an old
  // turnId. A notification counts toward usage only when its turnId is a turn
  // this session saw start; the first such one sets the baseline to
  // total - last, so the pre-resume lifetime is never emitted again.
  private ownTurnIds = new Set<string>();
  private resumeBaselineSet = false;
  // Window size from the latest tokenUsage notification; the /context
  // denominator. Null until the first notification arrives.
  private modelContextWindow: number | null = null;
  // Child (subagent / review-mode) threads spawned by this thread, keyed by
  // child thread id. Registered from thread/started (parentThreadId === ours),
  // collabAgentToolCall spawns (richest info,
  // overwrites), and subAgentActivity items (set-if-absent). Consulted by
  // the notification filter so a known child's item/completed can surface
  // as subagent tool activity; the value is the SubagentOrigin stamped on
  // those entries. Lives and dies with this session instance, like the
  // thread itself.
  private childThreads = new Map<string, SubagentOrigin>();
  // Background work (AgentInfo.backgroundTasks): known child threads whose
  // thread/status/changed says active, and the background terminals the
  // last successful thread/backgroundTerminals/list reported. `backgroundSent`
  // is the list last sent, so an equal list sends nothing.
  private runningChildren = new Set<string>();
  private backgroundTerminals: BackgroundTask[] = [];
  private backgroundSent = "[]";
  private backgroundListInFlight = false;
  private cancelBackgroundPoll: (() => void) | null = null;
  // Latest known subscription rate limits for the signed-in ChatGPT account,
  // keyed by metered limitId (see codexLimitKey). Fed by
  // `account/rateLimits/updated` notifications and, until one arrives, a
  // single `account/rateLimits/read`. Describes the ACCOUNT, not this thread,
  // so every agent on the same CODEX_HOME sees the same figures. Buckets are
  // kept apart rather than flattened: an account can meter more than one
  // thing, and blending two meters would invent a number.
  private rateLimitBuckets = new Map<string, RateLimitSnapshot>();
  private rateLimitObservedAtMs = new Map<string, number>();
  private rateLimitBucketRevision = new Map<string, number>();
  private rateLimitsRevision = 0;
  private rateLimitsReadInFlight: Promise<boolean> | null = null;
  // Set once a read has come back (successfully or not). Distinguishes "no
  // rate-limit data because nothing has been asked or pushed yet" (unknown)
  // from "asked, and this account reports none" (authoritative).
  private rateLimitsReadSettled = false;
  // Latest snapshot for /context. We use the `last` (most recent turn) field
  // of the tokenUsage notification, not `total` (cumulative-since-thread-
  // start). `last.inputTokens` is the prompt size of the last turn - i.e.
  // what was in context when the model spoke - and `last.outputTokens` is
  // what was appended after. Together they approximate the context fullness
  // heading into the next turn. Using `total.*` here would mis-report cache
  // re-reads (which sum across turns) as live context usage. Null until the
  // first notification arrives: on a new thread, after the first turn; on a
  // resumed thread, codex 0.160.0 replays the last persisted usage right
  // after thread/resume, before any turn (measured 2026-10-19).
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
  // Exact hooks.json source and matcher position installed for this process.
  // hook/completed does not include the command, so both fields are required
  // to distinguish Isomux's run from a user hook in the same file.
  private safetyHookIdentity: CodexSafetyHookIdentity | null = null;

  constructor(private readonly opts: CodexSessionInitOpts) {
    // JsonRpcLiteClient.start() applies the isomux CODEX_HOME default so
    // every codex subprocess (session bootstrap + listModels + oneShot +
    // fork + read) spawns under the same effective env. A managed personal
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

  private async bootstrap(): Promise<void> {
    let safety: CodexSafetyPreflightResult | null = null;
    try {
      safety = await this.client.start();
      this.safetyHookIdentity = safety.hookIdentity;
      const initParams: InitializeParams = {
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          // Decline attestation/generate: the adapter doesn't handle that server
          // request yet, so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      };
      await this.client.initialize(initParams);

      const sandboxChoice = await effectiveCodexSandbox(
        this.opts.sandbox ?? CODEX_DEFAULT_SANDBOX,
      );
      this.effectiveSandbox = sandboxChoice.sandbox;
      // The thread stores its collaboration mode, so a resumed thread can
      // already be in plan mode.
      let threadInPlanMode = false;
      if (this.opts.resumeThreadId) {
        // Resume an existing thread. Pass current settings as overrides so
        // a UI-side change to permissionMode/sandbox/model/systemPrompt
        // propagates instead of being stuck on whatever the thread was born
        // with - editAgent replaceSession → resumeSession is the path that
        // exercises this, and without the overrides the resumed thread
        // silently keeps the original policy.
        const resumeResp = await this.client.request<{
          thread: { id: string };
          modelProvider?: string;
          collaborationMode?: { mode?: string } | null;
        }>("thread/resume", {
          threadId: this.opts.resumeThreadId,
          excludeTurns: true,
          approvalPolicy: this.opts.permissionMode,
          sandbox: sandboxChoice.sandbox,
          model: this.opts.modelFamily,
          developerInstructions: this.opts.systemPrompt,
          persistExtendedHistory: false,
          config: codexThreadConfig(this.opts.mcpServers),
        });
        this.threadId = resumeResp.thread.id;
        if (resumeResp.modelProvider)
          this.modelProvider = resumeResp.modelProvider;
        threadInPlanMode = resumeResp.collaborationMode?.mode === "plan";
      } else {
        const startParams = this.buildThreadStartParams(sandboxChoice.sandbox);
        const startResp = await this.client.request<{
          thread: { id: string };
          modelProvider?: string;
        }>("thread/start", startParams);
        this.threadId = startResp.thread.id;
        if (startResp.modelProvider)
          this.modelProvider = startResp.modelProvider;
      }

      this.enqueue({
        kind: "system_init",
        sessionId: this.threadId,
        slashCommands: [],
        model: this.opts.modelFamily,
      });
      // An unset planMode keeps the thread's stored mode. Plan mode is set
      // again on a thread already in it: the stored mode carries the model
      // and effort it was set with, and it outranks the thread/resume
      // overrides.
      const plan = this.opts.planMode ?? threadInPlanMode;
      if (plan || threadInPlanMode) {
        let on = plan;
        try {
          await this.setCollaborationMode(plan);
        } catch (err) {
          on = threadInPlanMode;
          this.enqueueSignalled({ kind: "system_text", text: errMessage(err) });
        }
        this.enqueue({ kind: "plan_mode", on });
      }
      if (safety.warning) {
        this.enqueue({ kind: "system_text", text: safety.warning });
      }
      if (sandboxChoice.fellBack) {
        this.enqueue({
          kind: "system_text",
          text: msg("systemEntries.codexSandboxUnavailable"),
        });
      }
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
      if (safety?.warning) {
        this.enqueue({ kind: "system_text", text: safety.warning });
      }
      this.markEnded();
    }
  }

  // EXPERIMENTAL in the app-server schema. developer_instructions null keeps
  // Codex's own instructions for the mode.
  private async setCollaborationMode(plan: boolean): Promise<void> {
    await this.client.request("thread/settings/update", {
      threadId: this.threadId,
      collaborationMode: {
        mode: plan ? "plan" : "default",
        settings: {
          model: this.opts.modelFamily,
          reasoning_effort: this.opts.effort || null,
          developer_instructions: null,
        },
      },
    });
  }

  async setPlanMode(on: boolean): Promise<void> {
    await this.bootstrapPromise;
    if (this.closed)
      throw new Error("CodexSession.setPlanMode: session is closed");
    if (!this.threadId)
      throw new BackendNotConfiguredError(
        this.bootstrapError?.message ?? "Codex bootstrap failed",
      );
    await this.setCollaborationMode(on);
    this.enqueue({ kind: "plan_mode", on });
  }

  private buildThreadStartParams(sandbox: string): Record<string, unknown> {
    // sandbox is a SandboxMode enum string; approvalPolicy is the
    // AskForApproval enum string. We deliberately keep this as a plain
    // Record so the codegen union strictness doesn't fight us - the wire
    // schema is what we're targeting.
    const params: Record<string, unknown> = {
      cwd: this.opts.cwd,
      developerInstructions: this.opts.systemPrompt,
      model: this.opts.modelFamily,
      sandbox,
      approvalPolicy: this.opts.permissionMode,
      experimentalRawEvents: false,
      // persistExtendedHistory is deprecated in 0.130 and ignored by the
      // server, but the wire schema still requires the field.
      persistExtendedHistory: false,
      config: codexThreadConfig(this.opts.mcpServers),
    };
    if (this.opts.effort) {
      // ReasoningEffort enum string. Best-effort pass-through; codex
      // accepts a subset, mismatched values fail at handshake time.
      params.reasoningEffort = this.opts.effort;
    }
    return params;
  }

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
    this.capacityRetryCount = 0;
    this.capacityErrorThisAttempt = null;
    this.refusalThisAttempt = null;
    this.terminalErrorThisAttempt = null;
    this.clearTurnWatchdog();
    this.usageLimitThisTurn = false;
    this.shownItemsThisAttempt = 0;
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
    this.turnStarting = true;
    try {
      await this.client.request("turn/start", this.turnStartParams(input));
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
      if (detectCodexAuthError(message)) {
        this.enqueueAuthAwareSystemText(
          `Codex auth error during turn start: ${message}`,
        );
      }
      this.authSignalsAllowedThisTurn = false;
      this.authSignalEmittedThisTurn = false;
      this.selfInterruptedForAuth = false;
      this.turnStarting = false;
      throw err;
    }
    this.turnInFlight = true;
    this.turnStarting = false;
    this.lateToolResultNoticeEmitted = false;
    this.lateToolResultNoticeArmed = false;
    if (this.abandonedTurn?.id === null) this.abandonedTurn = null;
  }

  private scheduleCapacityRetry(delayMs: number, run: () => void): () => void {
    if (this.opts.scheduleRetry) return this.opts.scheduleRetry(delayMs, run);
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  }

  // Sends the background work list when it differs from the last one sent.
  private sendBackgroundTasks(): void {
    const tasks: BackgroundTask[] = [];
    for (const id of this.runningChildren) {
      const origin = this.childThreads.get(id);
      tasks.push({
        id,
        kind: "agent",
        label: sanitizeTaskLabel(origin?.description || origin?.type || id),
      });
    }
    tasks.push(...this.backgroundTerminals);
    const key = JSON.stringify(tasks);
    if (key === this.backgroundSent) return;
    this.backgroundSent = key;
    this.enqueue({ kind: "background_tasks", tasks });
  }

  // Lists the thread's background terminals (every page), and polls again
  // while any run. One call at a time; a failed call keeps the last list.
  private async refreshBackgroundTerminals(): Promise<void> {
    if (this.closed || !this.threadId || this.backgroundListInFlight) return;
    this.backgroundListInFlight = true;
    let terminals: BackgroundTask[] | null = [];
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const resp: ThreadBackgroundTerminalsListResponse =
          await this.client.request<ThreadBackgroundTerminalsListResponse>(
            "thread/backgroundTerminals/list",
            { threadId: this.threadId, ...(cursor ? { cursor } : {}) },
          );
        for (const t of resp.data ?? [])
          terminals.push({
            id: t.processId,
            kind: "command",
            label: sanitizeTaskLabel(t.command || t.processId),
          });
        cursor = resp.nextCursor ?? null;
        if (!cursor) break;
      }
    } catch {
      terminals = null;
    } finally {
      this.backgroundListInFlight = false;
    }
    if (this.closed) return;
    if (terminals) {
      this.backgroundTerminals = terminals;
      this.sendBackgroundTasks();
    }
    if (this.backgroundTerminals.length > 0) this.scheduleBackgroundPoll();
  }

  private scheduleBackgroundPoll(): void {
    this.cancelBackgroundPoll?.();
    const schedule =
      this.opts.scheduleBackgroundPoll ??
      ((delayMs: number, run: () => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.cancelBackgroundPoll = schedule(CODEX_BACKGROUND_POLL_MS, () => {
      this.cancelBackgroundPoll = null;
      void this.refreshBackgroundTerminals();
    });
  }

  private clearCapacityRetry(): void {
    this.cancelCapacityRetry?.();
    this.cancelCapacityRetry = null;
    this.capacityErrorThisAttempt = null;
    this.shownItemsThisAttempt = 0;
    this.capacityRetryCount = 0;
  }

  private armTurnWatchdog(): void {
    this.cancelTurnWatchdog?.();
    const schedule =
      this.opts.scheduleTurnWatchdog ??
      ((delayMs: number, run: () => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.cancelTurnWatchdog = schedule(CODEX_TURN_ERROR_WATCHDOG_MS, () => {
      this.cancelTurnWatchdog = null;
      this.fireTurnWatchdog();
    });
  }

  private clearTurnWatchdog(): void {
    this.cancelTurnWatchdog?.();
    this.cancelTurnWatchdog = null;
  }

  // Codex sent a terminal error and then nothing on our thread for
  // CODEX_TURN_ERROR_WATCHDOG_MS: end the turn as turn/completed would have.
  private fireTurnWatchdog(): void {
    if (this.closed) return;
    // An open approval waits for the member, not for Codex.
    if (this.turnStarting || this.pendingApprovals.size > 0) {
      this.armTurnWatchdog();
      return;
    }
    if (!this.turnInFlight) return;
    const turnId = this.activeTurnId;
    this.abandonedTurn = { id: turnId };
    // Direct, not requestSelfInterruptForAuth: that latch remaps the status.
    if (this.threadId && turnId) {
      this.client
        .request("turn/interrupt", { threadId: this.threadId, turnId })
        .catch(() => {});
    }
    this.activeTurnId = null;
    this.settleTurn(
      "failed",
      this.terminalErrorThisAttempt,
      CODEX_TURN_WATCHDOG_FALLBACK,
    );
  }

  private finishCapacityBackoff(
    status: "interrupted" | "failed",
    error: string,
  ): boolean {
    if (!this.cancelCapacityRetry) return false;
    this.clearCapacityRetry();
    this.clearTurnWatchdog();
    this.turnInFlight = false;
    this.turnStarting = false;
    this.activeTurnId = null;
    this.enqueue({ kind: "turn_completed", status, error });
    return true;
  }

  // The params of every turn/start: a user turn and a capacity retry.
  private turnStartParams(input: unknown[]): Record<string, unknown> {
    const sandboxPolicy = codexTurnSandboxPolicy(this.effectiveSandbox);
    return {
      threadId: this.threadId,
      input,
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    };
  }

  private retryCapacityTurn(delayMs: number): void {
    const retryNumber = this.capacityRetryCount;
    this.enqueue({
      kind: "provider_capacity_retry",
      attempt: retryNumber,
      maxAttempts: CODEX_CAPACITY_RETRY_DELAYS_MS.length,
      delayMs,
    });
    this.cancelCapacityRetry = this.scheduleCapacityRetry(delayMs, () => {
      this.cancelCapacityRetry = null;
      if (this.closed || !this.threadId) return;
      this.capacityErrorThisAttempt = null;
      this.refusalThisAttempt = null;
      this.terminalErrorThisAttempt = null;
      this.shownItemsThisAttempt = 0;
      this.turnStarting = true;
      // The failed turn already persisted the original user item. An empty
      // turn asks Codex to run from that history without appending it again.
      void this.client
        .request("turn/start", this.turnStartParams([]))
        .then(() => {
          this.turnStarting = false;
          this.turnInFlight = true;
          this.lateToolResultNoticeEmitted = false;
          this.lateToolResultNoticeArmed = false;
          if (this.abandonedTurn?.id === null) this.abandonedTurn = null;
        })
        .catch((err) => {
          this.turnStarting = false;
          this.turnInFlight = false;
          const message = errMessage(err);
          this.enqueue({
            kind: "turn_completed",
            status: "failed",
            error: message,
          });
        });
    });
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
          text: `No session rule was added: Isomux only matches rules against plain commands (no quoting, chaining, redirection, globbing or expansion). Allowed once.`,
        });
      } else if (tokensStartWith(pending.commandTokens, typed)) {
        this.rememberAllowPrefix(typed, pending.cwd);
        this.enqueue({
          kind: "system_text",
          text: this.grantedText(typed, pending.cwd),
        });
      } else {
        this.enqueue({
          kind: "system_text",
          text: `\`${typed.join(" ")}\` is not the start of the command being approved, so no session rule was added - this command was allowed once.`,
        });
      }
      return;
    }
    this.rememberAllowPrefix(pending.suggestedPrefix, pending.cwd);
    this.enqueue({
      kind: "system_text",
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
    if (
      this.finishCapacityBackoff(
        "interrupted",
        "Provider-capacity retry interrupted.",
      )
    )
      return;
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
      this.enqueueSignalled({
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

  // turn/steer with the active turn as expectedTurnId: codex accepts the text
  // only while that turn runs, and records it (a userMessage item whose
  // clientId is steerId, surfaced as steer_delivered) after the running tool.
  async steer(text: string, steerId: string): Promise<boolean> {
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) return false;
    this.pendingSteerIds.add(steerId);
    try {
      await this.client.request("turn/steer", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: turnId,
        clientUserMessageId: steerId,
      });
      return true;
    } catch {
      this.pendingSteerIds.delete(steerId);
      return false;
    }
  }

  // Codex recorded a steer this session sent: its userMessage item carries
  // the steer id as clientId. Started and completed both carry it; the first
  // one reports it.
  private noteSteerRecorded(item: unknown): void {
    const it = item as { type?: unknown; clientId?: unknown } | null;
    if (it?.type !== "userMessage" || typeof it.clientId !== "string") return;
    if (!this.pendingSteerIds.delete(it.clientId)) return;
    this.enqueue({ kind: "steer_delivered", steerId: it.clientId });
  }

  canAbortInPlace(): boolean {
    return (
      !this.closed &&
      this.threadId !== null &&
      (this.activeTurnId !== null || this.cancelCapacityRetry !== null)
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTurnWatchdog();
    this.cancelBackgroundPoll?.();
    this.cancelBackgroundPoll = null;
    this.finishCapacityBackoff(
      "failed",
      "Codex session closed during provider-capacity backoff.",
    );
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
      // No compactAtTokens: where Codex compacts is not knowable at runtime,
      // so the automatic handoff uses its 500k/85% limits alone. With the
      // upstream defaults (codex-rs 0.153.4: openai_models.rs
      // auto_compact_token_limit = min(configured limit, 90% of the raw
      // window); turn_context.rs reports the usable window, 95% of the raw
      // one), Codex compacts at 0.9 raw and the 85% limit fires at 0.8075 raw,
      // about 25k tokens earlier on a 272k model. But the model catalog can
      // come from the backend, config.toml can set
      // model_auto_compact_token_limit, and app-server reports neither
      // (config/read gives only a configured limit; Model has no such field).
    };
  }

  async getSubscriptionUsage(options?: {
    forceRefresh?: boolean;
  }): Promise<SubscriptionUsageResult> {
    // Periodic samples use pushed data. An on-demand self-check always asks
    // app-server, while concurrent callers still share one request.
    const refreshed =
      options?.forceRefresh || this.rateLimitBuckets.size === 0
        ? await this.readRateLimits()
        : false;
    const bucket = pickCodexLimitBucket(this.rateLimitBuckets);
    if (bucket) {
      const normalized = normalizeCodexSubscriptionUsage(bucket.snapshot);
      if (normalized.kind !== "usage") return normalized;
      const observedAtMs = this.rateLimitObservedAtMs.get(bucket.key);
      // Both bucket write paths stamp this map. If that invariant ever breaks,
      // keep the manager's prior sample instead of inventing a newer time.
      if (observedAtMs === undefined) return { kind: "unknown" };
      return {
        ...normalized,
        observedAtMs,
        refreshed: options?.forceRefresh && refreshed ? true : undefined,
      };
    }
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
    // This is the receipt time of the merged snapshot. Nullable fields that
    // the sparse push omits can still come from an older snapshot.
    this.rateLimitObservedAtMs.set(key, Date.now());
    this.rateLimitBucketRevision.set(key, ++this.rateLimitsRevision);
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
    requestRevision = this.rateLimitsRevision,
  ): void {
    const key = keyOverride ?? codexLimitKey(baseline);
    const current = this.rateLimitBuckets.get(key);
    const currentIsNewer =
      (this.rateLimitBucketRevision.get(key) ?? 0) > requestRevision;
    this.rateLimitBuckets.set(
      key,
      !current
        ? baseline
        : currentIsNewer
          ? mergeRateLimitSnapshots(baseline, current)
          : mergeRateLimitSnapshots(current, baseline),
    );
    if (!currentIsNewer) {
      this.rateLimitObservedAtMs.set(key, Date.now());
      this.rateLimitBucketRevision.set(key, ++this.rateLimitsRevision);
    }
  }

  // `account/rateLimits/read`, deduped so concurrent refreshes share one
  // request. Failures are swallowed - the caller reports "unknown" and keeps
  // whatever it had. Deliberately re-attemptable on a later call, so a user
  // who signs in mid-session starts seeing the pill without a restart.
  private readRateLimits(): Promise<boolean> {
    if (this.rateLimitsReadInFlight) return this.rateLimitsReadInFlight;
    const inFlight: Promise<boolean> = (async () => {
      try {
        await this.bootstrapPromise;
        if (this.closed || this.bootstrapError) return false;
        const requestRevision = this.rateLimitsRevision;
        const resp = await this.client.request<GetAccountRateLimitsResponse>(
          "account/rateLimits/read",
        );
        this.rateLimitsReadSettled = true;
        // A completed read is authoritative for every bucket that existed
        // before it began. Remove those snapshots before folding in the
        // response, but preserve any push that arrived while the read waited.
        for (const key of this.rateLimitBuckets.keys()) {
          if ((this.rateLimitBucketRevision.get(key) ?? 0) > requestRevision)
            continue;
          this.rateLimitBuckets.delete(key);
          this.rateLimitObservedAtMs.delete(key);
          this.rateLimitBucketRevision.delete(key);
        }
        // Everything here is an OLDER baseline than anything pushed while the
        // request was in flight - see mergeRateLimitsBaseline. The historical
        // single-bucket view has no map key of its own, so it files under its
        // own limitId (or the legacy key); the keyed entries file under their
        // MAP key, which is the authoritative metered id.
        if (resp?.rateLimits)
          this.mergeRateLimitsBaseline(
            resp.rateLimits,
            undefined,
            requestRevision,
          );
        for (const [limitId, snap] of Object.entries(
          resp?.rateLimitsByLimitId ?? {},
        )) {
          if (snap)
            this.mergeRateLimitsBaseline(snap, limitId, requestRevision);
        }
        return true;
      } catch {
        // Unauthenticated, API-key-only, or an app-server that doesn't know
        // the method. Not settled: we learned nothing, so the pill keeps
        // whatever it was showing instead of being cleared.
        return false;
      }
    })().finally(() => {
      if (this.rateLimitsReadInFlight === inFlight) {
        this.rateLimitsReadInFlight = null;
      }
    });
    this.rateLimitsReadInFlight = inFlight;
    return inFlight;
  }

  private enqueue(ev: NormalizedEvent): void {
    this.buffer.push(ev);
    this.wake();
  }

  // End a turn a usage limit stopped: the reset time goes ahead of the
  // turn_completed (server/limit-resume.ts). The pushed snapshot usually has
  // it already. When it does not, or its reset is already past (the cache
  // still shows the window that stopped an earlier turn), one bounded
  // account/rateLimits/read is awaited first, so a push that comes after the
  // error costs seconds, not the resume. No reset time found: the turn ends
  // with no stop event.
  private endUsageLimitedTurn(turnCompleted: NormalizedEvent): void {
    const resetsAtMs = (): number | null =>
      codexUsageLimitResetMs(
        pickCodexLimitBucket(this.rateLimitBuckets)?.snapshot ?? null,
      );
    const finish = (at: number | null) => {
      if (at !== null) {
        this.heldLimitEvents = [];
        this.enqueue({ kind: "usage_limit_stop", resetsAtMs: at });
      } else this.flushHeldLimitEvents();
      this.enqueue(turnCompleted);
    };
    const known = resetsAtMs();
    if (known !== null && known > Date.now()) {
      finish(known);
      return;
    }
    let cancel: (() => void) | undefined;
    const bound = new Promise<void>((res) => {
      cancel = this.scheduleCapacityRetry(CODEX_LIMIT_RESET_READ_MS, res);
    });
    void Promise.race([this.readRateLimits(), bound]).then(() => {
      cancel?.();
      finish(resetsAtMs());
    });
  }

  // Funnel for codex text that streams within a turn and can repeat (stderr,
  // advisory and retrying error notifications). Applies the per-turn
  // auth-coalescing gate: the first auth-shaped string of a user-initiated
  // turn becomes the turn's one auth_needed (the text itself is dropped; the
  // sign-in card explains it), and the rest are silent. Other text goes out
  // as system_text.
  private enqueueAuthAwareSystemText(text: string): void {
    if (detectCodexAuthError(text)) {
      if (!this.authSignalsAllowedThisTurn) return;
      if (this.authSignalEmittedThisTurn) return;
      this.authSignalEmittedThisTurn = true;
      this.enqueue({ kind: "auth_needed" });
      // Short-circuit codex's websocket retry budget. The retries are doomed,
      // and without an interrupt the agent sits in "thinking" for ~12s
      // before turn/completed lands - misleading UX (the model never ran).
      this.requestSelfInterruptForAuth();
      return;
    }
    this.enqueue({ kind: "system_text", text });
  }

  // One codex-sourced event that is not part of a repeating stream: an
  // auth-shaped one is preceded (error, failed turn) or replaced (text) by
  // auth_needed. Text Isomux wrote itself uses plain enqueue.
  private enqueueSignalled(ev: NormalizedEvent): void {
    for (const out of authSignal(ev, detectCodexAuthError)) this.enqueue(out);
  }

  // A turn that ends with no reset time still shows Codex's limit error.
  private flushHeldLimitEvents(): void {
    const held = this.heldLimitEvents;
    this.heldLimitEvents = [];
    for (const ev of held) this.enqueue(ev);
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

  // Ends the turn: one turn_completed for codex's turn/completed and for the
  // turn watchdog alike.
  private settleTurn(
    rawStatus: "completed" | "interrupted" | "failed",
    turnError: TurnErrorLike | null | undefined,
    fallbackError?: string,
  ): void {
    const rawError = turnError?.message ?? undefined;
    const capacityError = this.capacityErrorThisAttempt;
    const wasSelfInterruptForAuth = this.selfInterruptedForAuth;
    this.terminalErrorThisAttempt = null;
    this.turnInFlight = false;
    this.lateToolResultNoticeArmed = true;
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
    // remap status="interrupted" → "failed" so the member sees a clear
    // failure (not a misleading "interrupted" - which the UI treats as
    // a user-initiated stop). Substitute the error to the same auth
    // summary used for the stderr-driven path; the codex-emitted error
    // on a client-interrupt is usually empty or unhelpful.
    const status = wasSelfInterruptForAuth ? "failed" : rawStatus;
    // The turn failed on the sign-in failure this turn already signalled
    // (auth_needed): it ends with no error, and the sign-in card explains
    // it. A turn that ends on some other error keeps it.
    const turnLevelAuthShaped = !!rawError && detectCodexAuthError(rawError);
    const causedByAuth =
      this.authSignalEmittedThisTurn &&
      (wasSelfInterruptForAuth || turnLevelAuthShaped);
    const refusal = causedByAuth
      ? null
      : (this.refusalThisAttempt ??
        codexProviderRefusal(turnError, this.modelProvider));
    this.refusalThisAttempt = null;
    // Any other error text can quote the provider: bounded and redacted.
    const error = causedByAuth
      ? undefined
      : (refusal ?? providerText(rawError) ?? fallbackError);
    // Close the per-turn auth-coalescing gate now that the turn has
    // settled. Next user send opens it again in send().
    this.authSignalsAllowedThisTurn = false;
    this.authSignalEmittedThisTurn = false;
    this.selfInterruptedForAuth = false;
    // An auth-shaped turn error with no signal earlier in the turn gets its
    // auth_needed now, ahead of the turn's end.
    const signalled = authSignal(
      {
        kind: "turn_completed",
        status,
        error: capacityError ?? error,
        ...(capacityError ? { causedByProviderCapacity: true } : {}),
        ...(refusal !== null && !capacityError
          ? { providerRefusal: true }
          : {}),
      },
      detectCodexAuthError,
    );
    const turnCompleted = signalled.pop()!;
    for (const ev of signalled) this.enqueue(ev);
    const usageLimited =
      this.usageLimitThisTurn ||
      turnError?.codexErrorInfo === "usageLimitExceeded";
    this.usageLimitThisTurn = false;
    if (usageLimited) this.endUsageLimitedTurn(turnCompleted);
    else {
      this.flushHeldLimitEvents();
      this.enqueue(turnCompleted);
    }
    this.clearCapacityRetry();
  }

  private handleNotification(n: JsonRpcNotification): void {
    const params = n.params as Record<string, unknown> | null | undefined;
    // Codex settled a server request itself (for example when its turn
    // ended). An approval we still hold was not answered by the member, so
    // withdraw it. Request ids are unique per connection, so this runs before
    // the thread filter. approve() deletes its entry first, so a member answer
    // never comes back here.
    if (n.method === "serverRequest/resolved") {
      const approvalId = String(params?.requestId);
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) return;
      this.pendingApprovals.delete(approvalId);
      // Unwind the parked handler frame, the same way abort() does.
      try {
        pending.resolve({
          decision: mapApprovalDecision(pending.method, { kind: "deny" }),
        });
      } catch {}
      this.enqueue({ kind: "approval_withdrawn", approvalId });
      return;
    }
    // Per-thread filter: every notification carrying a threadId must match
    // ours. Sub-agent / review-mode child threads have their own ids.
    const eventThreadId = params?.threadId;
    if (
      eventThreadId !== undefined &&
      this.threadId &&
      eventThreadId !== this.threadId
    ) {
      // Carve-out: a KNOWN child thread's started and completed items
      // surface as subagent tool activity. Everything else from foreign
      // threads - turn lifecycle, token usage, deltas - stays dropped, so
      // parent turn bookkeeping is untouched.
      if (n.method === "item/started" || n.method === "item/completed") {
        const origin = this.childThreads.get(eventThreadId as string);
        if (origin && params?.item) {
          if (n.method === "item/started")
            this.translateStartedItem(params.item, origin);
          else this.translateCompletedItem(params.item, origin);
        }
      }
      // A known child counts as background work while it is active.
      if (
        (n.method === "thread/status/changed" ||
          n.method === "thread/closed") &&
        this.childThreads.has(eventThreadId as string)
      ) {
        const status = params?.status as { type?: string } | undefined;
        if (n.method === "thread/status/changed" && status?.type === "active")
          this.runningChildren.add(eventThreadId as string);
        else this.runningChildren.delete(eventThreadId as string);
        this.sendBackgroundTasks();
      }
      return;
    }
    // Traffic on our thread keeps a turn alive after a terminal error;
    // threadless pushes (account rate limits) say nothing about it.
    if (
      this.cancelTurnWatchdog &&
      this.threadId &&
      eventThreadId === this.threadId
    )
      this.armTurnWatchdog();

    switch (n.method) {
      case "turn/started": {
        const turn = params?.turn as { id?: string } | undefined;
        if (turn?.id) this.ownTurnIds.add(turn.id);
        // A late start of the turn the watchdog ended names that turn.
        if (
          this.abandonedTurn?.id === null &&
          !this.turnInFlight &&
          !this.turnStarting
        ) {
          if (turn?.id) this.abandonedTurn = { id: turn.id };
          break;
        }
        if (turn?.id) this.activeTurnId = turn.id;
        break;
      }
      case "turn/completed": {
        const turn = params?.turn as
          | { id?: string; status?: string; error?: TurnErrorLike | null }
          | undefined;
        const abandoned = this.abandonedTurn;
        if (
          abandoned &&
          (abandoned.id === null
            ? !this.turnInFlight
            : turn?.id === abandoned.id)
        ) {
          this.abandonedTurn = null;
          break;
        }
        this.clearTurnWatchdog();
        // A steer the turn did not record was dropped with it; the
        // orchestrator delivers it again (agent-manager drainBoundaryClaim).
        this.pendingSteerIds.clear();
        const rawStatus = mapTurnStatus(turn?.status);
        const capacityError = this.capacityErrorThisAttempt;
        // Codex can deliver completed items after turn/completed. This gate
        // prevents an item the chat already shows (a completed item or a
        // card shown at start) from being replayed. A late item can
        // still arrive after we schedule the empty-input continuation; that
        // continuation resumes from persisted history and does not repeat the
        // original user prompt.
        const canRetryCapacity =
          rawStatus === "failed" &&
          capacityError !== null &&
          this.shownItemsThisAttempt === 0 &&
          this.capacityRetryCount < CODEX_CAPACITY_RETRY_DELAYS_MS.length;
        this.activeTurnId = null;
        if (canRetryCapacity) {
          const delayMs =
            CODEX_CAPACITY_RETRY_DELAYS_MS[this.capacityRetryCount];
          this.capacityRetryCount += 1;
          this.retryCapacityTurn(delayMs);
          break;
        }
        this.settleTurn(rawStatus, turn?.error);
        void this.refreshBackgroundTerminals();
        break;
      }

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
        const cumulative = codexTokenUsage(tu.total);
        let delta: TokenUsage = codexTokenUsage(null);
        const resumed = Boolean(this.opts.resumeThreadId);
        // On a resumed thread, a report for a turn this session did not start
        // (the resume replay) emits a zero delta: it still refreshes /context.
        if (!resumed || this.ownTurnIds.has(notif.turnId)) {
          if (resumed && !this.resumeBaselineSet) {
            // The first report of a turn has total = pre-turn total + last.
            this.lastCumulativeUsage = subtractTokenUsage(
              cumulative,
              codexTokenUsage(tu.last),
            );
            this.resumeBaselineSet = true;
          }
          delta = subtractTokenUsage(cumulative, this.lastCumulativeUsage);
          this.lastCumulativeUsage = cumulative;
        }
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

      // ThreadStartedNotification is { thread } with NO top-level threadId,
      // so it reaches this switch even when it announces a child thread. A
      // thread whose parentThreadId is ours is a subagent (or review-mode)
      // thread: register it so its tool items surface with a subagent
      // origin. Our own thread (parentThreadId null) falls through.
      case "thread/started": {
        const thread = params?.thread as
          | {
              id?: string;
              parentThreadId?: string | null;
              agentNickname?: string | null;
              agentRole?: string | null;
              preview?: string;
            }
          | null
          | undefined;
        if (
          thread?.id &&
          thread.parentThreadId &&
          thread.parentThreadId === this.threadId &&
          !this.childThreads.has(thread.id)
        ) {
          const type = thread.agentNickname ?? thread.agentRole ?? undefined;
          const preview =
            typeof thread.preview === "string" && thread.preview.trim()
              ? subagentLabel(thread.preview)
              : undefined;
          this.childThreads.set(thread.id, {
            parentToolUseId: thread.id,
            ...(type ? { type } : {}),
            ...(preview ? { description: preview } : {}),
          });
        }
        break;
      }

      case "item/started": {
        // The record of a steer, or the card of a tool call that now runs.
        // Everything else waits for item/completed.
        const item = params?.item;
        this.noteSteerRecorded(item);
        if (
          item &&
          this.translateStartedItem(item) &&
          (this.turnInFlight || this.turnStarting)
        )
          this.shownItemsThisAttempt += 1;
        break;
      }
      case "item/completed": {
        const item = params?.item;
        if (item) {
          this.noteSteerRecorded(item);
          if (this.turnInFlight || this.turnStarting)
            this.shownItemsThisAttempt += 1;
          this.translateCompletedItem(item);
          if (
            !(this.turnInFlight || this.turnStarting) &&
            this.lateToolResultNoticeArmed &&
            isToolActivityItem(item) &&
            !this.lateToolResultNoticeEmitted
          ) {
            this.lateToolResultNoticeEmitted = true;
            this.enqueue({
              kind: "system_text",
              text: LATE_TOOL_RESULT_NOTICE,
            });
          }
        }
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

      case "thread/compacted": {
        // ContextCompactedNotification is { threadId, turnId } - no `summary`
        // on the wire, so the old params.summary read was always undefined.
        // Emit the bare marker (matches the contextCompaction item path in
        // translateCompletedItem).
        this.enqueue({ kind: "compacted" });
        break;
      }

      case "error": {
        // ErrorNotification carries the text at params.error.message (TurnError),
        // not params.message; the old read was always undefined and silently
        // swallowed real errors. A retryable stream error does not end the
        // turn: keep it visible as a plain system entry, without rejecting the
        // orchestrator's pending turn or involving the auth-error funnel.
        const notification = params as ErrorNotification | null | undefined;
        const message = notification?.error.message;
        if (
          notification &&
          notification.willRetry !== true &&
          (this.turnInFlight || this.turnStarting)
        ) {
          this.terminalErrorThisAttempt = notification.error;
          this.armTurnWatchdog();
        }
        // A usage limit ends the turn; turn/completed follows and reports
        // the reset time (endUsageLimitedTurn).
        if (
          notification?.willRetry === false &&
          notification.error.codexErrorInfo === "usageLimitExceeded"
        )
          this.usageLimitThisTurn = true;
        if (
          message &&
          notification.willRetry === false &&
          notification.error.codexErrorInfo === "serverOverloaded"
        ) {
          this.capacityErrorThisAttempt = message;
          break;
        }
        // A refusal waits for the failed turn/completed that repeats it, so
        // the member reads it once.
        if (notification?.willRetry !== true) {
          const refusal = codexProviderRefusal(
            notification?.error,
            this.modelProvider,
          );
          if (refusal !== null) {
            this.refusalThisAttempt = refusal;
            break;
          }
        }
        // The text can quote the provider, so it is bounded and redacted.
        const shown = providerText(message);
        if (shown !== null) {
          // A retrying error repeats like stderr, so it takes the per-turn
          // auth gate; a terminal one is a single event.
          if (notification?.willRetry === true)
            this.enqueueAuthAwareSystemText(inertMarkdown(shown));
          else if (notification?.error.codexErrorInfo === "usageLimitExceeded")
            this.heldLimitEvents.push(
              ...authSignal(
                { kind: "error", message: shown },
                detectCodexAuthError,
              ),
            );
          else this.enqueueSignalled({ kind: "error", message: shown });
        }
        break;
      }
      case "hook/completed": {
        const run = params?.run as
          | {
              sourcePath?: unknown;
              displayOrder?: unknown;
              status?: unknown;
              entries?: unknown;
            }
          | undefined;
        const identity = this.safetyHookIdentity;
        const isIsomuxRun =
          !!identity &&
          run?.sourcePath === identity.sourcePath &&
          Number(run?.displayOrder) === identity.displayOrder;
        if (!isIsomuxRun) break;
        const entries = Array.isArray(run?.entries)
          ? (run.entries as Array<{ kind?: unknown; text?: unknown }>)
          : [];
        const caughtFault = entries.some(
          (entry) => entry.text === SAFETY_WARNING,
        );
        const executionFailure =
          run?.status === "failed" ||
          entries.some(
            (entry) => entry.kind === "error" || entry.kind === "warning",
          );
        if (caughtFault || executionFailure) {
          this.enqueue({ kind: "system_text", text: SAFETY_WARNING });
        }
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

  // Shows the card of a tool item at item/started (CARD_AT_START_ITEMS).
  // True when it emitted a card.
  private translateStartedItem(
    rawItem: unknown,
    subagent?: SubagentOrigin,
  ): boolean {
    const item = rawItem as Record<string, unknown>;
    const type = item?.type as string;
    if (!CARD_AT_START_ITEMS.has(type)) return false;
    if (subagent && !SUBAGENT_VISIBLE_ITEMS.has(type)) return false;
    const toolUseId = item.id as string;
    if (this.shownToolCalls.has(toolUseId)) return false;
    const call = toolCallFor(item, subagent);
    if (!call) return false;
    this.shownToolCalls.add(toolUseId);
    this.enqueue(call);
    return true;
  }

  // The card of a completed tool item, unless item/started showed it.
  // Returns the item id, which the result carries.
  private showToolCall(
    item: Record<string, unknown>,
    subagent?: SubagentOrigin,
  ): string {
    const toolUseId = item.id as string;
    if (!this.shownToolCalls.delete(toolUseId)) {
      const call = toolCallFor(item, subagent);
      if (call) this.enqueue(call);
    }
    return toolUseId;
  }

  private translateCompletedItem(
    rawItem: unknown,
    subagent?: SubagentOrigin,
  ): void {
    // ThreadItem union is too broad (~20 variants) to model exactly here.
    // Cast to a loose Record so per-branch field reads stay typed without
    // committing to the generated schema.
    const item = rawItem as Record<string, unknown>;
    // `subagent` set = this item came from a child thread.
    // Only tool activity surfaces from there - see SUBAGENT_VISIBLE_ITEMS.
    if (subagent && !SUBAGENT_VISIBLE_ITEMS.has(item?.type as string)) return;
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
        const aggregatedOutput = item.aggregatedOutput as string | undefined;
        const exitCode = item.exitCode as number | undefined;
        const durationMs = item.durationMs as number | undefined;
        const toolUseId = this.showToolCall(item, subagent);
        const content =
          (aggregatedOutput ?? "") +
          (exitCode != null ? `\n(exit code ${exitCode})` : "");
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content,
          durationMs: durationMs ?? undefined,
          isError: exitCode != null && exitCode !== 0,
          ...(subagent ? { subagent } : {}),
        });
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = (changes as { path?: string; kind?: unknown }[])
          .map((c) => `${c.path ?? "?"} (${formatPatchChangeKind(c.kind)})`)
          .join("\n");
        const status = item.status as string | undefined;
        const toolUseId = this.showToolCall(item, subagent);
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content: `${summary}\n\nstatus: ${status ?? "unknown"}`,
          isError:
            status != null && status !== "completed" && status !== "applied",
          ...(subagent ? { subagent } : {}),
        });
        break;
      }
      case "mcpToolCall": {
        const durationMs = item.durationMs as number | undefined;
        const toolUseId = this.showToolCall(item, subagent);
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
          ...(subagent ? { subagent } : {}),
        });
        break;
      }
      case "webSearch": {
        const actionSummary = formatWebSearchAction(item.action);
        const toolUseId = this.showToolCall(item, subagent);
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content: actionSummary,
          isError: false,
          ...(subagent ? { subagent } : {}),
        });
        break;
      }
      // The proposed plan of plan mode. It is the answer of the turn, so it
      // shows as an agent message.
      case "plan": {
        const text = item.text as string | undefined;
        if (text) this.enqueue({ kind: "assistant_text", text });
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
          this.enqueueSignalled({
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
      // The parent's collab tool call (spawnAgent / sendInput / resumeAgent /
      // wait / closeAgent) - the codex counterpart of Claude's Task card.
      // Rendered as a normal tool card under the codex tool
      // name, and a spawn's receiver threads are registered as children so
      // their own tool items surface. The card can show at item/started; the
      // registration waits for completion, where the receiver ids exist.
      case "collabAgentToolCall": {
        const toolUseId = item.id as string;
        const status = item.status as string | undefined;
        const prompt = typeof item.prompt === "string" ? item.prompt : null;
        const model = typeof item.model === "string" ? item.model : null;
        const receivers = collabReceivers(item);
        if (item.tool === "spawnAgent") {
          for (const childId of receivers) {
            if (typeof childId !== "string" || !childId) continue;
            // Merge with any earlier thread/started registration: keep its
            // nickname/role as the type (beats a model slug as the pill
            // label), take the spawn's prompt as the description.
            const prev = this.childThreads.get(childId);
            const type = prev?.type ?? model ?? undefined;
            const description = prompt
              ? subagentLabel(prompt)
              : prev?.description;
            this.childThreads.set(childId, {
              parentToolUseId: toolUseId,
              ...(type ? { type } : {}),
              ...(description ? { description } : {}),
            });
          }
        }
        this.showToolCall(item);
        const states = item.agentsStates as
          | Record<
              string,
              { status?: string; message?: string | null } | undefined
            >
          | null
          | undefined;
        const stateLines = states
          ? Object.entries(states).map(
              ([tid, st]) =>
                `${tid}: ${st?.status ?? "?"}${st?.message ? ` - ${st.message}` : ""}`,
            )
          : [];
        this.enqueue({
          kind: "tool_result",
          toolUseId,
          content: [`status: ${status ?? "unknown"}`, ...stateLines].join("\n"),
          isError: status === "failed",
        });
        break;
      }
      // Subagent lifecycle markers on the parent thread. No card of their
      // own (the collab card + the child's surfaced tool items carry the
      // visibility), but they name the child thread id - so they double as
      // a registration path for spawns with no collab call (e.g. agent-file
      // thread spawns). Set-if-absent: never clobber richer labels.
      case "subAgentActivity": {
        const childId =
          typeof item.agentThreadId === "string" ? item.agentThreadId : null;
        if (childId && !this.childThreads.has(childId)) {
          const path = typeof item.agentPath === "string" ? item.agentPath : "";
          const name = path ? basename(path).replace(/\.[^.]*$/, "") : "";
          this.childThreads.set(childId, {
            parentToolUseId: (item.id as string) || childId,
            ...(name ? { type: name } : {}),
          });
        }
        break;
      }
      // userMessage, hookPrompt, dynamicToolCall, sleep, enteredReviewMode,
      // exitedReviewMode: ignored at v1.
      default:
        break;
    }
  }

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
            allowPersistentLabel:
              "Allow - and don't ask again for this exact command this session",
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

      case "item/permissions/requestApproval":
        this.enqueue({
          kind: "system_text",
          text: `Auto-declined permissions request from codex (v1 doesn't expose permission-profile changes - use the spawn dialog to pick a different sandbox/approval policy).`,
        });
        throw new Error(
          "Permissions profile changes are not supported in Isomux v1.",
        );

      case "item/tool/requestUserInput": {
        // Isomux has no question card, so the model must ask in the chat,
        // as a Claude agent does with AskUserQuestion off. A JSON-RPC error
        // cannot say that: Codex's app-server (bespoke_event_handling.rs)
        // replaces any client error with empty answers, and core
        // (tools/handlers/request_user_input.rs) sends the model only the
        // answers. So every question gets the instruction as a free-form
        // answer (Codex sets isOther on every question). Never an option
        // label: the model would read it as the member's choice.
        const questions = Array.isArray(params?.questions)
          ? (params.questions as unknown[])
          : [];
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const q of questions) {
          const id = (q as { id?: unknown } | null)?.id;
          if (typeof id === "string") {
            answers[id] = { answers: [REQUEST_USER_INPUT_ANSWER] };
          }
        }
        return { answers } satisfies ToolRequestUserInputResponse;
      }

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

      case "account/chatgptAuthTokens/refresh":
        // We don't have a token store; respond with an error so codex falls
        // back to user-facing login flow.
        // auth_needed brings the sign-in walkthrough, so the error states
        // the problem only. Isomux wrote this text, so it signals directly
        // rather than through authSignal.
        this.enqueue({ kind: "auth_needed" });
        this.enqueue({
          kind: "error",
          message: msg("systemEntries.codexTokenRefresh"),
        });
        throw new Error(
          `No token store: ${renderLogText(translatorFor("en"), loginInstructions())}`,
        );

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

  private handleStderr(chunk: string): void {
    // Codex stderr is opaque process output. Route to the agent log as
    // system_text so the member has visibility. Codex's rust tracing colors
    // its log lines, so strip ANSI CSI sequences - the escapes would be
    // persisted verbatim and reach the chat as literal bytes (task
    // ebe1bc1e). Then trim trailing newlines and skip pure whitespace.
    const text = filterMissingToolOutputRepeats(
      // eslint-disable-next-line no-control-regex -- ESC is the point here
      chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd(),
      this.missingToolOutputNotices,
    );
    // A chunk is one pipe read and can carry several lines, so drop the
    // benign ones line by line and keep the rest.
    const kept = text
      .split("\n")
      .filter((line) => !BENIGN_STDERR_LINES.some((re) => re.test(line)))
      .join("\n");
    if (!kept.trim()) return;
    // Route through the auth-aware gate so codex's websocket retry burst
    // produces at most one user-visible signal per turn (Claude-SDK parity).
    this.enqueueAuthAwareSystemText(`[codex stderr] ${kept}`);
  }

  private handleSubprocessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.closed) return;
    this.flushHeldLimitEvents();
    if (
      this.finishCapacityBackoff(
        "failed",
        `codex subprocess exited${code != null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""} during provider-capacity backoff`,
      )
    ) {
      this.markEnded();
      return;
    }
    // The per-turn auth-coalescing gate must close on subprocess death so an
    // unlikely-but-possible later stderr (e.g. drained late) doesn't sneak
    // through with a stale-open gate.
    this.clearTurnWatchdog();
    this.authSignalsAllowedThisTurn = false;
    this.authSignalEmittedThisTurn = false;
    this.selfInterruptedForAuth = false;
    // If a turn was in flight when codex died, synthesize a failed
    // turn_completed so the orchestrator's pendingTurn unblocks.
    if (this.turnInFlight) {
      this.turnInFlight = false;
      // A refusal latched before the exit is still the reason the turn failed.
      const refusal = this.refusalThisAttempt;
      this.refusalThisAttempt = null;
      this.enqueue(
        refusal !== null
          ? {
              kind: "turn_completed",
              status: "failed",
              error: refusal,
              providerRefusal: true,
            }
          : {
              kind: "turn_completed",
              status: "failed",
              error: `codex subprocess exited${code != null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""} mid-turn`,
            },
      );
    } else {
      this.enqueue({
        kind: "system_text",
        text: `Codex subprocess exited${code != null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""}.`,
      });
    }
    this.markEnded();
  }
}

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
function offerablePrefix(
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
// can't be sure what "the command" is. Null means "ask the member", and every
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
function commandTokensForPrefixMatch(params: unknown): string[] | null {
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
function buildCodexUserInput(
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
  // Keep an ordinary blank send as an explicit user turn. Capacity retries do
  // not use this builder: Codex accepts input: [] as a history continuation.
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

// The model/list client's launcher, for tests: a fake binary, its args, and
// no safety preflight (the fake runs no tools).
type CodexListModelsClientOptions = Pick<
  JsonRpcLiteClientOptions,
  "codexBin" | "args" | "skipSafetyPreflightForTestProbe"
>;

// codexBackend.listModels, with the launcher open to tests. An abort of
// opts.signal rejects at once and closes the client, which kills the
// app-server's process group (launcher and native grandchild).
export async function listCodexModels(
  opts: ListModelsOptions,
  launcher: CodexListModelsClientOptions = {},
): Promise<BackendModel[]> {
  const signal = opts.signal;
  signal?.throwIfAborted();
  // Spin up a one-shot JsonRpcLiteClient just for model/list. The pattern
  // mirrors oneShotPrompt but skips thread/start - model/list is a
  // server-level RPC, not thread-scoped. ~1-2s end-to-end including
  // subprocess spawn.
  const client = new JsonRpcLiteClient({
    ...launcher,
    cwd: opts.cwd,
    env: opts.env,
  });
  const started = client.start();
  if (!signal) return listModelsOver(client, started, opts);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      // A close() while start() is still before its spawn would mark the
      // client killed with no child yet, and the child spawned next would
      // then never be signalled. Close once start() has settled.
      const close = () => void client.close();
      started.then(close, close);
      reject(new Error("Codex model discovery was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([listModelsOver(client, started, opts), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// model/list over a started client, paginated until nextCursor === null.
// Closes the client whatever the outcome.
async function listModelsOver(
  client: JsonRpcLiteClient,
  started: Promise<unknown>,
  opts: ListModelsOptions,
): Promise<BackendModel[]> {
  try {
    await started;
    await client.initialize({
      clientInfo: {
        name: CLIENT_INFO_NAME,
        version: CLIENT_INFO_VERSION,
        title: null,
      },
      capabilities: {
        experimentalApi: true,
        // Decline attestation/generate: the adapter doesn't handle that server
        // request yet, so opting in would surface
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
}

export const codexBackend: Backend = {
  capabilities: CAPABILITIES,
  toolBoundaryDelivery: true,
  planMode: true,

  getModelOptions(): ModelOption[] {
    return MODEL_OPTIONS;
  },

  getPermissionModes(): PermissionModeOption[] {
    return PERMISSION_MODES;
  },

  listModels(opts: ListModelsOptions): Promise<BackendModel[]> {
    return listCodexModels(opts);
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
      mcpServers: opts.mcpServers,
      planMode: opts.planMode,
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
      mcpServers: opts.mcpServers,
      planMode: opts.planMode,
    });
  },

  inspectStoredSession(sessionId, opts) {
    return inspectCodexStoredSession(sessionId, opts.env);
  },

  checkSessionResumable(sessionId, opts): LogMessage | null {
    // Explicit-resume paths only block on missing-file. Header-only and corrupt
    // rollouts surface through Codex's own thread/resume error with a more
    // specific message.
    if (!codexRolloutFileExists(sessionId, opts.env)) {
      return msg("systemEntries.codexSession.missing", {
        thread: sessionId.slice(0, 8),
        dir: codexSessionsDir(opts.env),
      });
    }
    return null;
  },

  async forkSessionBeforeMessage(
    sessionId: string,
    targetMessageId: string | null,
    access?: SessionAccessOptions,
  ): Promise<ForkSessionBeforeMessageResult> {
    // thread/fork leaves the parent unaltered. Always a linked fork, also for
    // a first-message edit (the child is empty), so /resume shows the parent
    // as the original branch. The agent's cwd and env pick the CODEX_HOME
    // that holds the thread (task d32356f2).
    const client = new JsonRpcLiteClient({
      cwd: access?.cwd,
      env: access?.env,
    });
    try {
      await client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          // Decline attestation/generate: the adapter doesn't handle that server
          // request yet, so opting in would surface
          // unhandled requests. 0.144 made this capability required.
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      });

      const childThreadId = await forkThreadBeforeItem(
        client,
        sessionId,
        targetMessageId,
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

  async getSessionMessages(
    sessionId: string,
    cwd: string,
    access?: SessionAccessOptions,
  ): Promise<NormalizedMessage[]> {
    // The paged history APIs return turns and items separately. Each Turn
    // is one round of work; we flatten user and assistant items across all
    // turns in order so the orchestrator's edit-message matching can find
    // user messages by content + occurrence index.
    const client = new JsonRpcLiteClient({
      cwd: access?.cwd ?? cwd,
      env: access?.env,
    });
    try {
      await client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          // Decline attestation/generate: the adapter doesn't handle that server
          // request yet, so opting in would surface
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
      await client.start();
      await client.initialize({
        clientInfo: {
          name: CLIENT_INFO_NAME,
          version: CLIENT_INFO_VERSION,
          title: null,
        },
        capabilities: {
          experimentalApi: true,
          // Decline attestation/generate: the adapter doesn't handle that server
          // request yet, so opting in would surface
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
          // This path issues its own thread/start instead of going through
          // buildThreadStartParams, so the pin has to be repeated here.
          // ephemeral:true governs thread persistence, not the memories
          // feature.
          config: { ...CODEX_THREAD_CONFIG_OVERRIDES },
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
    return detectCodexAuthError(text);
  },

  // Without credentials Codex still takes the turn and retries the provider
  // until it reports a raw 401.
  isKnownSignedOut(env?: { [key: string]: string | undefined }): boolean {
    return !isCodexAuthenticated(env);
  },

  async getLoginInstructions(opts?: {
    env?: { [key: string]: string | undefined };
    credentialsRejected?: boolean;
  }): Promise<LoginInstructions> {
    // After a rejection, an OPENAI_API_KEY in env with no stored sign-in is
    // what Codex used, so the key is wrong: neither a /clear nor a sign-in
    // helps until the member fixes or removes it. With a stored sign-in, the
    // sign-in was rejected: the walkthrough below.
    if (opts?.credentialsRejected && (await codexEnvApiKeyWins(opts.env))) {
      return {
        kind: "login",
        cardEligible: false,
        text: msg("systemEntries.loginInstructions.codexKeyRejected"),
      };
    }
    // Signed in already (auth.json present, or OPENAI_API_KEY in env): the
    // session predates the login, so a /clear is all the member needs.
    // After a rejection auth.json proves nothing: Codex re-reads it before it
    // gives up on a 401, so a failing session already holds what is on disk,
    // and a dead token stays there.
    if (!opts?.credentialsRejected && isCodexAuthenticated(opts?.env)) {
      return {
        kind: "already_authed",
        cardEligible: false,
        text: msg("systemEntries.loginInstructions.codexSignedIn"),
      };
    }
    return {
      kind: "login",
      cardEligible: true,
      text: loginInstructions(),
      commands: getCodexLoginCommands(),
    };
  },

  logoutCommand(): string {
    ensureCodexWrapperScript();
    return `${codexWrapperCommandForShell()} logout`;
  },
};
