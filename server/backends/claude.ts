// Claude backend (final shape, step 2c).
//
// Owns every `@anthropic-ai/...` import. agent-manager talks to this module
// through the Backend / BackendSession interface only:
//
//   orchestrator        ────────►  claudeBackend.createSession(opts)
//                                          │
//                                          ▼
//   for await (ev of session.stream())  ◄──┤
//   session.send(text, attachments)        │
//   session.approve(approvalId, decision)  │
//   session.close()                        │
//                                          ▼
//                            @anthropic-ai/claude-agent-sdk
//
// The SDK's per-tool approval flow (canUseTool callback) is bridged into the
// NormalizedEvent stream + session.approve() abstraction with an internal
// pendingApprovals correlation map: handleCanUseTool stores the SDK's resolve,
// yields an approval_request event, and approve() looks the resolve up by
// approvalId and feeds it the corresponding PermissionResult.
//
// cronjob-manager.ts still imports the SDK directly - cronjobs are Claude-
// only at v1 (per Round 3 decisions).

import {
  query,
  forkSession as sdkForkSession,
  getSessionMessages as sdkGetSessionMessages,
  type EffortLevel as SdkEffortLevel,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SessionMessage,
  type CanUseTool,
  type HookEvent,
  type HookCallbackMatcher,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

// Internal session-options shape - the boundary between the orchestrator-
// facing `buildSdkOpts` and the SDK adapters. Defined here (not aliased to an
// SDK type) so adapter changes don't ripple into every caller. Every field is
// a valid SDK `Options` field, so `sessionOptsToV1` can spread it verbatim.
//
// `systemPrompt` uses the SDK's typed option (preset + append) rather than a
// raw `--append-system-prompt` CLI flag: the typed option travels inside the
// `initialize` control request over the child's stdin, so the multi-KB prompt
// never appears in the process argv (task e6a0387a - argv is world-readable
// via /proc/<pid>/cmdline and dumped wholesale by `systemctl status`).
export interface SdkSessionOptions {
  model: string;
  pathToClaudeCodeExecutable: string;
  systemPrompt?: Options["systemPrompt"];
  effort?: SdkEffortLevel;
  // The SDK's "flag settings" layer (`--settings`), typed straight off the
  // SDK so this stays a faithful subset. Carries CLAUDE_MEMORY_OFF_SETTINGS;
  // a future writer must merge into it, never assign over it.
  settings?: Options["settings"];
  env?: { [key: string]: string | undefined };
  cwd: string;
  permissionMode: PermissionMode;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
}
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";

import type { Attachment } from "../../shared/types.ts";
import { errMessage } from "../../shared/errors.ts";
import {
  FAMILY_TO_MODEL,
  MODEL_FAMILIES,
  EFFORT_LEVELS,
  effortLevelsFor,
} from "../../shared/types.ts";
import type { ModelFamily, EffortLevel } from "../../shared/types.ts";
import { saveFile } from "../persistence.ts";
import {
  resolveAttachmentNotices,
  formatAttachmentLines,
} from "../attachment-prompt.ts";
import { createSafetyHooks } from "../safety-hooks.ts";
import {
  CLAUDE_NATIVE_BIN,
  claudeProjectDir,
  claudeSessionFileExists,
} from "../cwd-utils.ts";
import {
  isClaudeCodeAuthenticated,
  isClaudeCodeInstalled,
} from "./claude-install-check.ts";

import type {
  ApprovalDecision,
  AttachmentSpec,
  Backend,
  BackendCapabilities,
  BackendModel,
  BackendSession,
  ContextUsage,
  CreateSessionOptions,
  ListModelsOptions,
  ModelOption,
  ForkSessionBeforeMessageResult,
  NormalizedEvent,
  LoginInstructions,
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
  SubagentOrigin,
  SubscriptionUsageResult,
  SubscriptionUsageWindow,
  TokenUsage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOGIN_INSTRUCTIONS = `To authenticate Claude Code:
1. Open the built-in terminal
2. Run \`claude\`
3. Type \`/login\`
4. Follow the auth flow

Once complete, it takes effect immediately for all Isomux agents.

Alternative: add \`ANTHROPIC_API_KEY\` under User Settings → Environment Variables, then \`/clear\`.`;

// Surfaced when an auth-error fires (or the user types /login) but the
// office already has a valid Claude auth (credentials.json present, or
// ANTHROPIC_API_KEY in env). Symmetric with the Codex auto-clear hint.
const ALREADY_AUTHED_INSTRUCTIONS = `Claude Code is signed in. Type \`/clear\` to refresh this agent's session and pick up the new auth.`;

const LOGIN_COMMAND = `claude`;

// Native installer is Anthropic's recommended Claude Code install path
// (see https://github.com/anthropics/claude-code and
// https://code.claude.com/docs/en/setup): user-owned location, auto-update
// in the background, no sudo. npm install -g is now an Advanced /
// deprecated fallback in their docs.
const CLAUDE_CODE_NOT_INSTALLED_MESSAGE = `To install Claude Code, click [Copy to terminal] on the card below:

\`curl -fsSL https://claude.ai/install.sh | bash\`

macOS users with Homebrew can alternatively run \`brew install --cask claude-code\`.

After install, open a new shell and run \`claude\` to sign in. If \`claude\` is not found, make sure \`~/.local/bin\` is on your PATH (\`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc\`).

Alternative: add \`ANTHROPIC_API_KEY\` under User Settings → Environment Variables, then \`/clear\`.`;

const INSTALL_COMMAND = `curl -fsSL https://claude.ai/install.sh | bash`;

const AUTH_ERROR_PATTERNS =
  /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|not logged in|run \/login|403|401/i;

const CAPABILITIES: BackendCapabilities = {
  fork: true,
  hooks: true,
  skills: true,
  oneShot: true,
  canUseTool: true,
  topicGen: true,
  edit: true,
  mcp: true,
};

const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", label: "Default - prompt for each tool" },
  { value: "acceptEdits", label: "Accept edits automatically" },
  { value: "bypassPermissions", label: "Bypass all permissions" },
  { value: "auto", label: "Auto - Isomux decides via /resolve" },
];

// ---------------------------------------------------------------------------
// SDK boundary (SdkConversation / SdkClient)
// ---------------------------------------------------------------------------
// ClaudeSession and the backend module-level functions depend on these
// abstract interfaces, not on the raw SDK exports. Production wiring uses
// `realV1SdkClient` (backed by V1 `query()`); tests inject a `FakeSdkClient`
// via `createClaudeBackend(fakeClient)`.
//
// `SdkConversation.messages()` is a single AsyncIterable covering ALL turns of
// the conversation. V1's `query()` returns exactly that shape, so the adapter
// is a thin wrap.

export interface SdkConversation {
  /** One stream of SDK messages spanning every turn of the conversation. */
  messages(): AsyncIterable<SDKMessage>;
  /** Push a user message into the conversation. */
  send(msg: string | SDKUserMessage): Promise<void>;
  /** Tear down the conversation. Idempotent; never throws. */
  close(): void;
  /** Per-session context-usage breakdown for /context, or null when unavailable. */
  getContextUsage(): Promise<ContextUsage | null>;
  /** Plan-allowance usage of the signed-in claude.ai account (tri-state; see SubscriptionUsageResult). */
  getSubscriptionUsage(): Promise<SubscriptionUsageResult>;
}

export interface SdkOneShotOptions {
  prompt: string;
  model: string;
  pathToClaudeCodeExecutable: string;
  systemPrompt?: string;
  settings?: Options["settings"];
  env?: { [key: string]: string | undefined };
}

// Backend-native memory is off in every isomux launch: isomux memory is the
// only memory an office agent has, so it carries over when the agent's
// backend changes (Nil's ruling, 2026-09-01). Without this the CLI reads and
// writes ~/.claude/projects/<sanitized-cwd>/memory/ on its own and injects
// that MEMORY.md into every session in the cwd.
//
// Why the typed setting and not CLAUDE_CODE_DISABLE_AUTO_MEMORY in env:
// Options.env REPLACES the child's environment instead of merging with
// process.env, and buildSdkOpts sets env only when the caller supplied one,
// so injecting a single variable would either wipe the inherited environment
// for env-less agents or freeze it into a build-time snapshot. The env var
// is also parsed for truthiness ("false" and "0" leave memory ON) and is
// undocumented, while `settings.autoMemoryEnabled` is the documented switch:
// "When false, Claude will not read from or write to the auto-memory
// directory". It lands in the flag-settings layer, which outranks
// ~/.claude/settings.json. The one thing that still beats it is an operator
// envFile setting CLAUDE_CODE_DISABLE_AUTO_MEMORY to an explicitly falsy
// value ("0"/"false"), which the CLI checks before settings.
export const CLAUDE_MEMORY_OFF_SETTINGS: Extract<Options["settings"], object> =
  {
    autoMemoryEnabled: false,
  };

export interface SdkClient {
  createSession(opts: SdkSessionOptions): SdkConversation;
  resumeSession(sessionId: string, opts: SdkSessionOptions): SdkConversation;
  oneShotPrompt(opts: SdkOneShotOptions): Promise<string>;
  forkSession(
    sessionId: string,
    opts: { upToMessageId: string },
  ): Promise<{ sessionId: string }>;
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>;
}

// ---------------------------------------------------------------------------
// V1 SDK adapter - production
// ---------------------------------------------------------------------------
// V1's `query()` consumes an AsyncIterable<SDKUserMessage> as its prompt and
// returns a single `Query` generator that spans all turns. `send()` pushes
// into the input iterable; `close()` ends the iterable + best-effort
// `interrupt()`s the query.

// Exported for test coverage of the passthrough + optional `resume` add-on.
// Internal otherwise. SdkSessionOptions is a strict subset of the SDK's
// `Options` (see the interface comment above), so this is a plain spread by
// design. Do not translate `systemPrompt` into `extraArgs`: extraArgs is
// rendered onto the child's argv (task e6a0387a).
export function sessionOptsToV1(
  opts: SdkSessionOptions,
  resumeSessionId?: string,
): Options {
  return {
    ...opts,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

// Minimal pushable async iterable. Used as the `prompt` argument to
// `query()` so we can drive multi-turn conversations imperatively (each
// `send()` pushes a user message into the iterable; the SDK reads it on the
// next turn boundary).
export interface PushableInput<T> {
  iterable: AsyncIterable<T>;
  push(item: T): void;
  end(): void;
}

export function makePushableInput<T>(): PushableInput<T> {
  const queue: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (ended) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => {
              waiters.push(resolve);
            });
          },
        };
      },
    },
    push(item) {
      if (ended) return;
      if (waiters.length > 0) {
        const w = waiters.shift()!;
        w({ value: item, done: false });
      } else {
        queue.push(item);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        w({ value: undefined as never, done: true });
      }
    },
  };
}

// Anything that satisfies our use of V1's `Query` interface. Lets tests stub
// `query()` without depending on the full SDK shape.
export interface V1QueryLike extends AsyncIterable<SDKMessage> {
  // Return type deliberately loose, like getContextUsage below: SDK 0.3.219
  // widened this to resolve with an interrupt receipt (`still_queued` message
  // uuids) instead of void. We ignore the value, so decoupling from the SDK's
  // exact shape keeps the next widening from breaking the build.
  interrupt(): Promise<unknown>;
  getContextUsage(): Promise<unknown>;
  // The structured data behind `/usage`. OPTIONAL and untyped on purpose:
  // the SDK ships it under a name that shouts it may change or vanish in any
  // release (usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET), so
  // isomux treats its very existence as a runtime question - if a future SDK
  // renames or drops it, the typeof check below turns the pill off instead of
  // failing the build or throwing at runtime.
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
}

// Which claude.ai rate-limit windows isomux surfaces, in DISPLAY order (the
// pill picks its number by usage, not by this order - see agent-manager).
// seven_day leads because it's the one people mean by "my plan allowance";
// the shorter and per-model windows follow.
//
// seven_day_oauth_apps is deliberately left out: it meters third-party OAuth
// apps rather than this session. The SDK's own live gating signal
// (SDKRateLimitInfo.rateLimitType, the field that says which limit actually
// rejected a request) enumerates five_hour / seven_day / seven_day_opus /
// seven_day_sonnet / overage and never oauth_apps, so surfacing it would put
// a number on screen that can't explain anything the agent runs into.
// extra_usage (overage credits) is a different currency and stays out too.
const CLAUDE_RATE_LIMIT_WINDOWS: { key: string; label: string }[] = [
  { key: "seven_day", label: "Weekly" },
  { key: "five_hour", label: "5-hour" },
  { key: "seven_day_opus", label: "Weekly (Opus)" },
  { key: "seven_day_sonnet", label: "Weekly (Sonnet)" },
];

// Minimum gap between actual /usage control RPCs per conversation. The
// orchestrator refreshes on every cumulative-usage event (many per turn) so a
// runaway loop stays visible while it runs; for Codex that's a cache read of
// pushed data, but for Claude it's a round trip to the CLI. Throttling HERE
// rather than in the orchestrator keeps the cost policy with the backend that
// pays it, and keeps Codex's cheap path unthrottled.
const CLAUDE_USAGE_MIN_INTERVAL_MS = 60_000;

// ISO 8601 -> epoch ms, null for anything unparseable. The SDK types resets_at
// as `string | null`, but this whole path is defensive by design.
function parseResetsAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// One window entry -> our shape, or null when there's nothing to show.
// utilization is nullable in the SDK types (the window exists, the number
// isn't in yet); clamping happens here, at the boundary with the unstable
// API, so nothing downstream has to trust the range.
function claudeWindow(
  raw: unknown,
  label: string,
): SubscriptionUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { utilization, resets_at } = raw as {
    utilization?: unknown;
    resets_at?: unknown;
  };
  if (typeof utilization !== "number" || !Number.isFinite(utilization))
    return null;
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, utilization)),
    resetsAtMs: parseResetsAt(resets_at),
  };
}

// Shape the experimental /usage response into isomux's backend-agnostic form.
// Exported for tests. Every field is validated at runtime because the source
// API is explicitly unstable.
//
// The three outcomes are distinct on purpose (see SubscriptionUsageResult):
// `rate_limits_available: false` is the AUTHORITATIVE "this account has no
// plan allowance" (API key / Bedrock / Vertex), so it clears the pill; a
// response we can't make sense of at all is "unknown" and leaves the previous
// reading alone.
export function normalizeClaudeSubscriptionUsage(
  raw: unknown,
): SubscriptionUsageResult {
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const resp = raw as {
    subscription_type?: unknown;
    rate_limits_available?: unknown;
    rate_limits?: unknown;
  };
  if (typeof resp.rate_limits_available !== "boolean")
    return { kind: "unknown" };
  if (!resp.rate_limits_available) return { kind: "unavailable" };
  const limits = resp.rate_limits;
  if (!limits || typeof limits !== "object") return { kind: "unavailable" };
  const byKey = limits as Record<string, unknown>;
  const windows: SubscriptionUsageWindow[] = [];
  for (const { key, label } of CLAUDE_RATE_LIMIT_WINDOWS) {
    const win = claudeWindow(byKey[key], label);
    if (win) windows.push(win);
  }
  // Per-model weekly windows the server sends as a list. Additive and
  // server-labelled ("Fable"), and they DO gate this session, so they belong
  // on screen - the pill's number comes from whichever window is closest to
  // its limit, and one of these can be it.
  if (Array.isArray(byKey.model_scoped)) {
    for (const entry of byKey.model_scoped) {
      const name = (entry as { display_name?: unknown } | null)?.display_name;
      if (typeof name !== "string" || name.length === 0) continue;
      const win = claudeWindow(entry, `Weekly (${name})`);
      if (win) windows.push(win);
    }
  }
  // The account has plan limits, but the response carried no usable number:
  // authoritative enough to clear rather than to freeze a stale figure.
  if (windows.length === 0) return { kind: "unavailable" };
  return {
    kind: "usage",
    usage: {
      plan:
        typeof resp.subscription_type === "string"
          ? resp.subscription_type
          : null,
      windows,
    },
  };
}

export function wrapV1Query(
  q: V1QueryLike,
  input: PushableInput<SDKUserMessage>,
  abortController?: AbortController,
): SdkConversation {
  let closed = false;
  // Throttle state for the experimental /usage call (see
  // CLAUDE_USAGE_MIN_INTERVAL_MS). Per conversation, which is the right scope:
  // the answer describes the account, and every conversation on this box is
  // asking about the same one, but a shared cache would need a lifetime story
  // nobody has asked for.
  let lastUsage: { atMs: number; result: SubscriptionUsageResult } | null =
    null;
  let usageInFlight: Promise<SubscriptionUsageResult> | null = null;
  return {
    messages(): AsyncIterable<SDKMessage> {
      return q;
    },
    async send(msg) {
      if (closed) return;
      const userMsg: SDKUserMessage =
        typeof msg === "string"
          ? {
              type: "user",
              message: { role: "user", content: msg },
              parent_tool_use_id: null,
            }
          : msg;
      input.push(userMsg);
    },
    close() {
      if (closed) return;
      closed = true;
      // End the input iterable first so `query()` sees no-more-input via the
      // normal exit path; then best-effort interrupt to abort any in-flight
      // tool execution. Both must be swallowed - `SdkConversation.close` is
      // documented "never throws", and feedSDKMessages relies on that. The
      // outer try guards a sync throw from `interrupt()` (SDK types say it
      // returns Promise<void>, but the contract here is stronger than the SDK
      // contract); the inner `.catch` handles a promise rejection.
      try {
        input.end();
      } catch {}
      try {
        q.interrupt().catch(() => {});
      } catch {}
      // Force the SDK subprocess to actually terminate. input.end() + interrupt()
      // unwind a healthy or idle turn cleanly, but a session closed mid-turn
      // (e.g. /clear during an active turn) can leave the `claude` child hung in
      // its read loop, never exiting - leaking ~165MB per agent. abortController
      // is the SDK's documented cancel lever ("when aborted, the query will stop
      // and clean up resources"), which tears the subprocess down. Best-effort
      // and swallowed: close() is documented "never throws".
      try {
        abortController?.abort();
      } catch {}
    },
    async getContextUsage(): Promise<ContextUsage | null> {
      try {
        // The single ingestion point for Claude fullness readings: the per-turn
        // sampler, GET .../context, and /context all reach the SDK through
        // here. The bundled CLI's numbers pass through untouched -- it reports
        // the window the session actually gets, which isomux can't derive.
        return (await q.getContextUsage()) as ContextUsage;
      } catch {
        return null;
      }
    },
    async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
      const usage = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      // Absent method = the SDK renamed or dropped the experimental API. That
      // is authoritative in its own way: we will never learn a number here, so
      // clear the pill rather than freeze whatever it last showed.
      if (typeof usage !== "function") return { kind: "unavailable" };
      // Serve the recent answer instead of paying for a fresh RPC, and
      // single-flight concurrent callers onto one request. The interval is
      // measured INITIATION to initiation: `now` is captured before the call
      // and stamped on the result, so a slow response can't stretch the gap to
      // "RPC duration + 60s".
      const now = Date.now();
      if (lastUsage && now - lastUsage.atMs < CLAUDE_USAGE_MIN_INTERVAL_MS) {
        return lastUsage.result;
      }
      if (usageInFlight) return usageInFlight;
      const call: Promise<SubscriptionUsageResult> = (async () => {
        try {
          const result = normalizeClaudeSubscriptionUsage(await usage.call(q));
          lastUsage = { atMs: now, result };
          return result;
        } catch {
          // A failed call teaches us nothing - the caller keeps whatever it
          // had. Deliberately NOT cached, so the next event retries.
          return { kind: "unknown" as const };
        }
      })().finally(() => {
        if (usageInFlight === call) usageInFlight = null;
      });
      usageInFlight = call;
      return call;
    },
  };
}

export const realV1SdkClient: SdkClient = {
  createSession(opts) {
    const input = makePushableInput<SDKUserMessage>();
    // Threaded into close() so it can force the SDK subprocess to terminate
    // (see wrapV1Query.close); the SDK otherwise owns the child and exposes no
    // pid to kill.
    const abortController = new AbortController();
    const q = query({
      prompt: input.iterable,
      options: { ...sessionOptsToV1(opts), abortController },
    });
    return wrapV1Query(q, input, abortController);
  },
  resumeSession(sessionId, opts) {
    const input = makePushableInput<SDKUserMessage>();
    const abortController = new AbortController();
    const q = query({
      prompt: input.iterable,
      options: { ...sessionOptsToV1(opts, sessionId), abortController },
    });
    return wrapV1Query(q, input, abortController);
  },
  async oneShotPrompt({
    prompt,
    model,
    pathToClaudeCodeExecutable,
    systemPrompt,
    settings,
    env,
  }) {
    // One-shot text completion: no tools, no thinking, no filesystem context.
    // V1's typed Options means no more `as any` cast for tools/thinking/
    // settingSources/systemPrompt.
    const q = query({
      prompt,
      options: {
        model,
        pathToClaudeCodeExecutable,
        tools: [],
        thinking: { type: "disabled" },
        settingSources: [],
        cwd: "/tmp",
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(settings ? { settings } : {}),
        ...(env ? { env } : {}),
      },
    });
    let result: SDKResultMessage | null = null;
    for await (const msg of q) {
      if (msg.type === "result") {
        result = msg;
        break;
      }
    }
    if (!result) {
      throw new Error("oneShotPrompt: stream ended without a result message");
    }
    if (result.subtype !== "success") {
      throw new Error(`oneShotPrompt failed: ${result.subtype}`);
    }
    return result.result;
  },
  forkSession(sessionId, opts) {
    return sdkForkSession(sessionId, opts);
  },
  getSessionMessages(sessionId) {
    return sdkGetSessionMessages(sessionId);
  },
};

// ---------------------------------------------------------------------------
// ClaudeSession - BackendSession implementation
// ---------------------------------------------------------------------------
// Concurrency notes:
//   - feedSDKMessages runs as a background task in the constructor. It pumps
//     translated NormalizedEvents into `buffer`, then resolves any waiter.
//   - handleCanUseTool fires from the SDK's event loop. It stores the SDK's
//     `resolve` in pendingApprovals and queues an approval_request event.
//   - stream() yields from `buffer` and parks on `resolveWake` when empty.
//   - approve() resolves the SDK-side `resolve` so the SDK proceeds.
//   - close() resolves any in-flight approvals with deny so the SDK and any
//     orchestrator-side awaiter both unblock.

// Exported for test injection; non-test consumers should go through
// `claudeBackend.createSession` / `claudeBackend.resumeSession`.
export class ClaudeSession implements BackendSession {
  private conversation: SdkConversation;
  private buffer: NormalizedEvent[] = [];
  private resolveWake: (() => void) | null = null;
  private ended = false;
  private closed = false;
  private readonly imageSink: ImageSink;
  // Per-session by construction: dies with the session, so tracked-task state
  // can never go stale across resume/swap (each new session gets a fresh one).
  private readonly taskTracker = new TaskBreadcrumbTracker();
  private pendingApprovals = new Map<
    string,
    {
      resolve: (r: PermissionResult) => void;
      input: Record<string, unknown>;
      suggestions?: PermissionUpdate[];
    }
  >();

  constructor(
    private readonly agentId: string,
    sdkClient: SdkClient,
    sdkOpts: SdkSessionOptions,
    resumeSessionId?: string,
  ) {
    this.imageSink = ({ data, mediaType, suggestedName }) =>
      saveFile(this.agentId, data, mediaType, suggestedName);
    const optsWithApproval: SdkSessionOptions = {
      ...sdkOpts,
      canUseTool: (toolName, input, callOpts) =>
        this.handleCanUseTool(toolName, input, callOpts),
    };
    this.conversation = resumeSessionId
      ? sdkClient.resumeSession(resumeSessionId, optsWithApproval)
      : sdkClient.createSession(optsWithApproval);
    void this.feedSDKMessages();
  }

  private async feedSDKMessages() {
    try {
      // The conversation iterable is a single stream across all turns; the
      // SDK adapter (V2 or V1) handles turn boundaries internally. We just
      // translate each message into NormalizedEvents and enqueue them. On
      // throw - typically subprocess exit, mid-stream abort, or transport
      // failure - if we initiated the close, exit quietly; otherwise emit a
      // normalized `error` event so the orchestrator can log + update state.
      // We MUST swallow here: feedSDKMessages runs as
      // `void this.feedSDKMessages()`, so an uncaught rejection becomes
      // unhandled and crashes the whole Bun process.
      for await (const msg of this.conversation.messages()) {
        for (const ev of translateSDKMessage(msg, this.imageSink)) {
          this.enqueue(ev);
        }
        // Background-task lifecycle breadcrumbs ride after the message's
        // translated events (task_started for a tool arrives in a later SDK
        // message than the tool_use itself, so ordering is naturally correct).
        for (const ev of this.taskTracker.observe(msg)) {
          this.enqueue(ev);
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.enqueue({
          kind: "error",
          message: errMessage(err),
        });
      }
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  private enqueue(ev: NormalizedEvent) {
    this.buffer.push(ev);
    this.wake();
  }

  private wake() {
    if (this.resolveWake) {
      const r = this.resolveWake;
      this.resolveWake = null;
      r();
    }
  }

  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    callOpts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const approvalId = callOpts.toolUseID;
      // If a prior pending request with the same approvalId exists (shouldn't
      // happen - SDK tool calls are serialized - but defensive), deny it.
      const existing = this.pendingApprovals.get(approvalId);
      if (existing) {
        try {
          existing.resolve({
            behavior: "deny",
            message: "Superseded by newer request.",
          });
        } catch {}
      }
      this.pendingApprovals.set(approvalId, {
        resolve,
        input,
        suggestions: callOpts.suggestions,
      });
      this.enqueue({
        kind: "approval_request",
        approvalId,
        toolName,
        input,
        title: callOpts.title ?? `Claude wants to use ${toolName}`,
        description: callOpts.description ?? callOpts.decisionReason,
        allowPersistentLabel:
          "Allow - and don't ask again for similar calls this session",
      });
      callOpts.signal.addEventListener(
        "abort",
        () => {
          const pending = this.pendingApprovals.get(approvalId);
          if (pending) {
            this.pendingApprovals.delete(approvalId);
            pending.resolve({ behavior: "deny", message: "Request aborted." });
          }
        },
        { once: true },
      );
    });
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
    if (attachments && attachments.length > 0) {
      const message = buildClaudeUserMessage(this.agentId, text, attachments);
      await this.conversation.send(message);
    } else {
      await this.conversation.send(text);
    }
  }

  approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return Promise.resolve();
    this.pendingApprovals.delete(approvalId);
    let result: PermissionResult;
    switch (decision.kind) {
      case "allow_persistent": {
        // Scope suggested rules to the session so they don't leak across sessions.
        const sessionScoped = pending.suggestions?.map((s) => ({
          ...s,
          destination: "session" as const,
        }));
        result = {
          behavior: "allow",
          updatedInput: pending.input,
          updatedPermissions: sessionScoped,
        };
        break;
      }
      // The Claude backend never sets allowPrefixLabel, so the /resolve UX
      // never offers this option here. Handled anyway so the switch stays
      // exhaustive: a one-shot allow is the safe reading of "allow, and take
      // this rule too" from a backend that has no rule to take.
      case "allow_prefix":
      case "allow_once":
        result = { behavior: "allow", updatedInput: pending.input };
        break;
      case "deny":
        result = {
          behavior: "deny",
          message: decision.reason ?? "User denied.",
        };
        break;
    }
    pending.resolve(result);
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    // Claude has no in-place interrupt RPC. Callers must check canAbortInPlace()
    // first; the orchestrator's hot-abort dispatch gates on that predicate so
    // this method is unreachable from the normal abort path. Throwing here
    // surfaces accidental direct calls instead of silently closing the session
    // (which would leave callers without a replacement).
    throw new Error(
      "ClaudeSession.abort() is unsupported - use close() + a replacement session, or check canAbortInPlace() before calling.",
    );
  }

  canAbortInPlace(): boolean {
    // The Claude SDK has no fine-grained interrupt RPC; aborts always close
    // the subprocess and require a replacement session.
    return false;
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return this.conversation.getContextUsage();
  }

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    return this.conversation.getSubscriptionUsage();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Resolve pending approvals with deny FIRST so any in-flight canUseTool
    // callback unblocks the SDK side - denying after close() would race the
    // already-tearing-down query and the resolves may become no-ops. Then
    // close the conversation so the message stream terminates cleanly.
    for (const [, pending] of this.pendingApprovals) {
      try {
        pending.resolve({ behavior: "deny", message: "Session closed." });
      } catch {}
    }
    this.pendingApprovals.clear();
    this.conversation.close();
  }
}

// ---------------------------------------------------------------------------
// SDK message → NormalizedEvent translation
// ---------------------------------------------------------------------------

// Callback for persisting inline image blocks extracted from tool_result
// content. Bound to a specific agentId at the call site; injected so the
// translator stays pure-modulo-the-sink (testable without filesystem state).
export type ImageSink = (args: {
  data: Buffer;
  mediaType: string;
  suggestedName: string;
}) => Attachment | null;

// Which loop produced an assistant/user message. The SDK sets
// `parent_tool_use_id` to the Agent/Task tool_use id when the message comes
// from a subagent, and null when it comes from the agent's own loop. Subagent
// tool calls ride the SAME message stream as the parent's (the SDK forwards
// tool_use/tool_result blocks from subagents unconditionally; only their text
// is gated behind `forwardSubagentText`), so without this the transcript reads
// as one flat run of tool calls with no way to tell who made them.
//
// `subagent_type` and `task_description` are model-authored free text, so they
// go through the same one-line cap as the task breadcrumbs. Older SDKs omit
// both; the parent id alone is still enough to mark the call.
function subagentOriginOf(msg: {
  parent_tool_use_id?: string | null;
  subagent_type?: string;
  task_description?: string;
}): SubagentOrigin | undefined {
  const parentToolUseId = msg.parent_tool_use_id;
  if (!parentToolUseId) return undefined;
  const type = msg.subagent_type ? sanitizeTaskLabel(msg.subagent_type) : "";
  const description = msg.task_description
    ? sanitizeTaskLabel(msg.task_description)
    : "";
  return {
    parentToolUseId,
    ...(type ? { type } : {}),
    ...(description ? { description } : {}),
  };
}

export function* translateSDKMessage(
  msg: SDKMessage,
  imageSink: ImageSink,
): Generator<NormalizedEvent, void> {
  switch (msg.type) {
    case "system": {
      const subtype = msg.subtype;
      if (subtype === "init") {
        // session_id is always present in practice; we still emit system_init
        // (with sessionId undefined) if it's missing so the orchestrator can
        // pick up slash_commands/skills on the same event. The orchestrator
        // guards session-side effects on the sessionId presence.
        const sessionId = msg.session_id as string | undefined;
        yield {
          kind: "system_init",
          sessionId: sessionId || undefined,
          slashCommands: msg.slash_commands ?? [],
          model: msg.model,
        };
      } else if (subtype === "local_command_output") {
        const { content } = msg;
        if (content) yield { kind: "system_text", text: content };
      } else if (subtype === "permission_denied") {
        // Auto-denied tool call (SDK >= 0.3.x): the deny short-circuit in
        // canUseTool - auto-mode classifier, deny rule, dontAsk - emits this
        // alongside the is_error tool_result the model sees. Surface it so
        // the transcript shows the denial natively; older SDKs simply never
        // emit the subtype. Free-text fields are sanitized to one line here
        // (message is rule/classifier-authored prose of arbitrary shape).
        yield {
          kind: "permission_denied",
          toolUseId: msg.tool_use_id,
          toolName: msg.tool_name,
          message: sanitizeTaskLabel(msg.message ?? ""),
          ...(msg.decision_reason
            ? { decisionReason: sanitizeTaskLabel(msg.decision_reason) }
            : {}),
          // Subagent origin, preserved for the transcript even though the
          // card doesn't display it yet - dropped here, it's unrecoverable.
          ...(msg.agent_id ? { agentId: msg.agent_id } : {}),
        };
      }
      break;
    }

    case "assistant": {
      const message = msg.message;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      // SDK injects synthetic assistant turns (model === "<synthetic>") for
      // things like usage-limit hits and queue-flush gaps. Map their text to
      // system breadcrumbs so they don't render as Claude-voice.
      const isSynthetic = message?.model === "<synthetic>";
      const subagent = subagentOriginOf(msg);
      // Known divergence from the original message-level deriveState: when
      // text precedes tool_use in the same assistant message, state will
      // flip thinking → tool_executing rather than going straight to
      // tool_executing. Events arrive synchronously inside one consumer-loop
      // turn so the transient is effectively invisible in the UI; we accept
      // it rather than peek-ahead-and-reorder for parity. (Reverse direction,
      // tool_use then text, is handled by the sticky guard in
      // processNormalizedEvent.)
      for (const block of content) {
        if (block.type === "text" && block.text) {
          yield isSynthetic
            ? { kind: "system_text", text: block.text }
            : { kind: "assistant_text", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            kind: "tool_call",
            toolUseId: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            ...(subagent ? { subagent } : {}),
          };
        } else if (block.type === "thinking" && block.thinking) {
          yield { kind: "thinking", text: block.thinking };
        }
      }
      break;
    }

    case "user": {
      const content = msg.message?.content;
      if (!Array.isArray(content)) break;
      const subagent = subagentOriginOf(msg);
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter(
                    (c: {
                      type?: string;
                    }): c is { type: "text"; text: string } =>
                      c.type === "text",
                  )
                  .map((c) => c.text)
                  .join("\n")
              : JSON.stringify(block.content);
        // Extract image blocks → save to disk → emit as attachments. Side-
        // effecting, but persistence is a backend-level concern (not
        // orchestration) and the SDK's wire shape is the only place we
        // have the base64 bytes.
        //
        // Not the canonical "show a file to the boss" path - that's POST
        // /api/agents/:id/read-file (or /api/cronjobs/:id/runs/:runId/read-file
        // for cronjobs); the system prompt teaches those endpoints. This
        // branch stays because it's a useful side effect: when an agent
        // genuinely uses Read on an image to look at it themselves, the
        // image still surfaces in the conversation so the boss can see
        // what the agent saw. Agents don't need to know about this.
        // Codex agents never hit this path; they go straight to /read-file.
        let attachments: Attachment[] | undefined;
        if (Array.isArray(block.content)) {
          const atts: Attachment[] = [];
          type ImageBlock = {
            type: "image";
            source: { type: "base64"; data: string; media_type: string };
          };
          const isImageBlock = (c: unknown): c is ImageBlock => {
            if (!c || typeof c !== "object") return false;
            const o = c as { type?: unknown; source?: { type?: unknown } };
            return o.type === "image" && o.source?.type === "base64";
          };
          for (const c of block.content) {
            if (isImageBlock(c)) {
              const decoded = Buffer.from(c.source.data, "base64");
              const ext = c.source.media_type.split("/")[1] ?? "png";
              const att = imageSink({
                data: decoded,
                mediaType: c.source.media_type,
                suggestedName: `image.${ext}`,
              });
              if (att) atts.push(att);
            }
          }
          if (atts.length > 0) attachments = atts;
        }
        yield {
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: resultText,
          attachments,
          isError: block.is_error === true,
          ...(subagent ? { subagent } : {}),
        };
      }
      break;
    }

    case "result": {
      const subtype = msg.subtype;
      const usageField = msg.usage;
      // Only trust usage from success results. Error-subtype results may omit
      // `usage`; coercing to zeros would overwrite the accurate cumulative.
      const usage: TokenUsage | undefined =
        usageField && subtype === "success"
          ? {
              inputTokens: usageField.input_tokens ?? 0,
              outputTokens: usageField.output_tokens ?? 0,
              cacheReadInputTokens: usageField.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens:
                usageField.cache_creation_input_tokens ?? 0,
            }
          : undefined;
      const cost = msg.total_cost_usd as number | undefined;
      if (subtype === "success") {
        yield { kind: "turn_completed", status: "completed", usage, cost };
      } else {
        const { errors } = msg;
        const errorText = `Agent stopped: ${subtype}. ${errors?.join(", ") || ""}`;
        yield {
          kind: "turn_completed",
          status: "failed",
          usage,
          cost,
          error: errorText,
        };
      }
      break;
    }

    // tool_progress and other SDK message types: no orchestrator-visible
    // counterpart at v1. State stays at tool_executing from the prior
    // tool_call event.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Background-task lifecycle breadcrumbs (TaskBreadcrumbTracker)
// ---------------------------------------------------------------------------
// The SDK emits system/task_started, task_updated, and task_notification for
// EVERY task-shaped thing - including ordinary foreground Bash calls and
// foreground subagents, which already render as their own tool calls.
// Breadcrumbing all of them would double-render every shell command, so this
// tracker only surfaces genuinely-background work:
//
//   any tool_use launched with input.run_in_background === true - the ONLY
//                                 signal that a Bash call or an Agent-tool
//                                 subagent was born background; their
//                                 task_started is otherwise identical to a
//                                 foreground one's
//   task_type "local_workflow"  - Workflow tool runs (return immediately,
//                                 settle via task_notification). No
//                                 run_in_background input to correlate
//                                 against, and there is no foreground
//                                 counterpart, so the task_type alone is safe.
//   task_updated is_backgrounded - a foreground task backgrounded mid-run
//                                 (Ctrl+B / auto-background on timeout)
//
// task_type "local_bash" is NOT a background signal (task 0c7945cd): the SDK
// stamps it on every local shell task, foreground included. Trusting it made
// ordinary Bash calls emit "Background task started" - measured at 217 of 227
// breadcrumbs on one agent and 78 of 78 on another, which in turn made the
// earlyoom incidents in the ad86462c diagnosis look like mid-run backgrounding.
//
// Settle breadcrumbs (task_notification) are emitted only for tasks tracked
// at start, which both filters foreground-subagent noise and dedupes repeated
// notifications for the same task. skip_transcript (ambient/housekeeping
// tasks) mutes both ends. State is per-ClaudeSession, so it dies with the
// session - no cross-session staleness (see feedSDKMessages wiring).
//
// Rationale (task b4cafa53 diagnosis): a background-task settle wakes an idle
// agent with a fresh turn, but the triggering notification was invisible in
// the isomux transcript - the agent appeared to start talking spontaneously.
// These breadcrumbs give the boss the visible trigger.

const TASK_LABEL_MAX = 200;
const TRACKED_TASKS_MAX = 200;
const BG_TOOL_IDS_MAX = 500;

// Collapse to one line and cap length: breadcrumbs must stay unobtrusive and
// task descriptions/summaries are model- or user-authored free text. Also
// reused by the permission_denied translation above for the same reason.
export function sanitizeTaskLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > TASK_LABEL_MAX
    ? `${oneLine.slice(0, TASK_LABEL_MAX - 1)}…`
    : oneLine;
}

interface TrackedTask {
  desc: string;
  // skip_transcript on task_started mutes the settle breadcrumb too - the
  // task is still tracked so its notification stays filtered/deduped.
  silent: boolean;
}

export class TaskBreadcrumbTracker {
  private tracked = new Map<string, TrackedTask>();
  private bgToolUseIds = new Set<string>();

  observe(msg: SDKMessage): NormalizedEvent[] {
    if (msg.type === "assistant") {
      // Record tool_use ids launched with run_in_background: true (Bash and
      // Agent alike) so their task_started can be recognized as background.
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === "tool_use" &&
            (block.input as { run_in_background?: unknown } | null)
              ?.run_in_background === true
          ) {
            this.bgToolUseIds.add(block.id);
            trimInsertionOrdered(this.bgToolUseIds, BG_TOOL_IDS_MAX);
          }
        }
      }
      return [];
    }
    if (msg.type !== "system") return [];

    if (msg.subtype === "task_started") {
      const isBackground =
        msg.task_type === "local_workflow" ||
        (msg.tool_use_id !== undefined &&
          this.bgToolUseIds.has(msg.tool_use_id));
      if (!isBackground || this.tracked.has(msg.task_id)) return [];
      // The correlated tool_use id is consumed - drop it so the bounded set
      // holds only ids still awaiting their task_started.
      if (msg.tool_use_id !== undefined)
        this.bgToolUseIds.delete(msg.tool_use_id);
      const desc = sanitizeTaskLabel(msg.description || msg.task_id);
      const silent = msg.skip_transcript === true;
      this.tracked.set(msg.task_id, { desc, silent });
      trimInsertionOrdered(this.tracked, TRACKED_TASKS_MAX);
      if (silent) return [];
      const kindWord =
        msg.task_type === "local_workflow"
          ? "Workflow"
          : msg.task_type === "local_agent"
            ? "Background agent"
            : "Background task";
      return [
        {
          kind: "task_lifecycle",
          phase: "started",
          taskId: msg.task_id,
          // Re-sanitize the assembled label: desc alone fits the cap, but the
          // prefix can push the total past TASK_LABEL_MAX.
          label: sanitizeTaskLabel(`${kindWord} started: ${desc}`),
        },
      ];
    }

    if (msg.subtype === "task_updated") {
      // Only the foreground→background transition is breadcrumb-worthy here;
      // completion/failure arrives via task_notification.
      if (msg.patch?.is_backgrounded !== true || this.tracked.has(msg.task_id))
        return [];
      const desc = sanitizeTaskLabel(msg.patch.description || msg.task_id);
      this.tracked.set(msg.task_id, { desc, silent: false });
      trimInsertionOrdered(this.tracked, TRACKED_TASKS_MAX);
      return [
        {
          kind: "task_lifecycle",
          phase: "started",
          taskId: msg.task_id,
          label: sanitizeTaskLabel(`Task moved to background: ${desc}`),
        },
      ];
    }

    if (msg.subtype === "task_notification") {
      const rec = this.tracked.get(msg.task_id);
      if (!rec) return []; // foreground noise or duplicate notification
      this.tracked.delete(msg.task_id);
      if (rec.silent || msg.skip_transcript === true) return [];
      // The SDK summary is already a good one-liner ('Background command
      // "…" completed (exit code 0)'); fall back to a constructed label.
      // Sanitize the final string either way so event.label never exceeds
      // TASK_LABEL_MAX.
      const label = sanitizeTaskLabel(
        msg.summary || `Background task ${msg.status}: ${rec.desc}`,
      );
      return [
        {
          kind: "task_lifecycle",
          phase: msg.status,
          taskId: msg.task_id,
          label,
        },
      ];
    }

    return [];
  }
}

// Drop oldest entries past `max`. Map and Set iterate in insertion order, so
// deleting the first key evicts the oldest - a cheap bound against unbounded
// growth in very long sessions (leaked ids just age out).
function trimInsertionOrdered(
  coll: Map<string, unknown> | Set<string>,
  max: number,
) {
  while (coll.size > max) {
    const oldest = coll.keys().next().value;
    if (oldest === undefined) break;
    coll.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// User-message construction (text + attachments → SDKUserMessage)
// ---------------------------------------------------------------------------
// Attachments are NEVER inlined - each becomes one path-notice text line via
// the shared attachment convention (server/attachment-prompt.ts); the agent
// opens files on demand (Read renders images and PDFs). This wrapper only
// puts the shared lines into the SDK's ContentBlockParam shape.

export function buildClaudeUserMessage(
  agentId: string,
  text: string,
  attachments: AttachmentSpec[],
): SDKUserMessage {
  const content: ContentBlockParam[] = [];

  if (text) {
    content.push({ type: "text", text });
  }

  const lines = formatAttachmentLines(
    resolveAttachmentNotices(agentId, attachments),
  );
  if (lines.length > 0) {
    content.push({ type: "text", text: lines.join("\n") });
  }

  // Never emit an empty content array (shared contract with the Codex
  // backend, whose protocol rejects empty input outright).
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// SDK session option builder
// ---------------------------------------------------------------------------
// Shared by createSession / resumeSession. Pulls in safety-hooks, builds the
// typed systemPrompt / effort options, normalizes the model family.

function buildSdkOpts(opts: CreateSessionOptions): SdkSessionOptions {
  const familyKey = opts.modelFamily as ModelFamily;
  const model = FAMILY_TO_MODEL[familyKey] ?? opts.modelFamily;
  const sdkOpts: SdkSessionOptions = {
    model,
    // permissionMode is `string` at the Backend boundary; narrow at the call site.
    permissionMode: opts.permissionMode as PermissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    // "Default with additions": keep the claude_code base prompt and append
    // isomux's assembled prompt. The typed option travels over stdin (the
    // SDK's `initialize` control request), NOT argv - do not route the prompt
    // through extraArgs/CLI flags, that leaks it to `ps`/`systemctl status`
    // (task e6a0387a).
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: opts.systemPrompt,
    },
    // effort is `string` at the Backend boundary; upstream validateEffort
    // guarantees a Claude-legal level (narrower than shared EffortLevel,
    // which includes Codex-only values). Narrow at the call site, same
    // pattern as permissionMode.
    effort: opts.effort as SdkEffortLevel,
    // Backend-native auto-memory off; see CLAUDE_MEMORY_OFF_SETTINGS.
    settings: CLAUDE_MEMORY_OFF_SETTINGS,
    cwd: opts.cwd,
    hooks: createSafetyHooks(),
    // AskUserQuestion has no usable UI in isomux: the canUseTool approval
    // shows only "Allow/Deny" without rendering the question text, and the
    // headless tool execution returns empty answers - which the agent then
    // rationalizes as "you accepted the defaults". Agents should ask
    // clarifying questions in plain chat instead.
    disallowedTools: ["AskUserQuestion"],
  };
  if (opts.env) sdkOpts.env = opts.env;
  return sdkOpts;
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export function createClaudeBackend(
  sdkClient: SdkClient = realV1SdkClient,
): Backend {
  return {
    capabilities: CAPABILITIES,

    getModelOptions(): ModelOption[] {
      return MODEL_FAMILIES.map((m) => ({ value: m.family, label: m.label }));
    },

    getPermissionModes(): PermissionModeOption[] {
      return PERMISSION_MODES;
    },

    async listModels(_opts: ListModelsOptions): Promise<BackendModel[]> {
      // Claude has no runtime model-discovery API: the family list is static
      // and identical across auth tiers. Promote MODEL_FAMILIES to the
      // BackendModel shape so the UI can render Claude through the same
      // fetched-list path it uses for Codex. Effort filtering remains a
      // family-level concern ("max" is top-tier only, etc.) handled UI-side.
      return MODEL_FAMILIES.map((m, i) => ({
        id: m.family,
        label: m.label,
        isDefault: i === 0,
        hidden: false,
        supportedEfforts: effortLevelsFor("claude", m.family).map((e) => ({
          level: e.level,
        })),
      }));
    },

    createSession(opts: CreateSessionOptions): BackendSession {
      return new ClaudeSession(opts.agentId, sdkClient, buildSdkOpts(opts));
    },

    resumeSession(
      sessionId: string,
      opts: CreateSessionOptions,
    ): BackendSession {
      return new ClaudeSession(
        opts.agentId,
        sdkClient,
        buildSdkOpts(opts),
        sessionId,
      );
    },

    inspectStoredSession(): "durable" {
      // Preserve Claude's existing silent auto-resume policy: a stored id is
      // trusted and the SDK surfaces any missing-file error when it starts.
      return "durable";
    },

    checkSessionResumable(sessionId, opts): string | null {
      if (!claudeSessionFileExists(opts.cwd, sessionId, opts.env)) {
        return (
          `Cannot resume session ${sessionId.slice(0, 8)}…: its file is missing from ${claudeProjectDir(opts.cwd, opts.env)}. ` +
          `Most commonly this happens after the cwd was moved or renamed - the Claude CLI stores sessions under a path derived from cwd. ` +
          `Move the session .jsonl into the new project directory to recover it.`
        );
      }
      return null;
    },

    async forkSessionBeforeMessage(
      sessionId: string,
      targetMessageId: string,
    ): Promise<ForkSessionBeforeMessageResult> {
      // Find target's position in the transcript so we can decide between
      // fresh-session (target is the first user message) and a real fork at
      // the predecessor uuid. The SDK call is cheap and side-effect-free.
      //
      // firstUserIdx update MUST run before the target-match break, otherwise
      // when target itself is the first user message (especially target at
      // index 0) firstUserIdx stays -1 and the fresh-vs-fork decision below
      // misroutes to fork (with a -1 predecessor index).
      const messages = await sdkClient.getSessionMessages(sessionId);
      let targetIdx = -1;
      let firstUserIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (firstUserIdx === -1 && m.type === "user") firstUserIdx = i;
        if (m.uuid === targetMessageId) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) {
        throw new Error(
          "forkSessionBeforeMessage: target message not found in session",
        );
      }
      if (targetIdx === firstUserIdx) {
        // First user message: no predecessor to fork at. Return fresh - the
        // orchestrator will create a brand-new session, semantically unrelated
        // to the old one.
        return { kind: "fresh" };
      }
      const predecessorUuid = messages[targetIdx - 1].uuid;
      const result = await sdkClient.forkSession(sessionId, {
        upToMessageId: predecessorUuid,
      });
      return {
        kind: "fork",
        sessionId: result.sessionId,
        forkedFromSessionId: sessionId,
      };
    },

    async getSessionMessages(sessionId: string): Promise<NormalizedMessage[]> {
      const messages = await sdkClient.getSessionMessages(sessionId);
      const out: NormalizedMessage[] = [];
      for (const m of messages) {
        // SessionMessage.type is user/assistant/system (no "result"); narrow
        // to those for the orchestrator's edit-message matching.
        if (m.type !== "user" && m.type !== "assistant" && m.type !== "system")
          continue;
        out.push({
          uuid: m.uuid,
          role: m.type,
          text: flattenSessionMessageText(m),
        });
      }
      return out;
    },

    async oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string> {
      // One-shot text completion: no tools, no extended thinking, no
      // filesystem context. The earlier `permissionMode: "plan"` config added
      // a planning system prompt + adaptive thinking, which produced
      // 200+-token outputs, ~10s+ latency, and a 20%-ish rate of the model
      // roleplaying as an agent attempting the conversation's task. The
      // adapter (V2 or V1) sets tools:[] / thinking:disabled / settingSources:
      // [] / cwd:"/tmp" to keep this a pure single-turn label task.
      const familyKey = opts.modelFamily as ModelFamily;
      const model = FAMILY_TO_MODEL[familyKey] ?? opts.modelFamily;
      return sdkClient.oneShotPrompt({
        prompt,
        model,
        pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
        systemPrompt: opts.systemPrompt,
        // settingSources: [] skips the filesystem layers but not the
        // built-in default (auto-memory ON), so the flag layer is needed
        // here too or the /tmp cwd gets its own memory folder.
        settings: CLAUDE_MEMORY_OFF_SETTINGS,
        env: opts.env,
      });
    },

    detectAuthError(text: string): boolean {
      return AUTH_ERROR_PATTERNS.test(text);
    },

    getLoginInstructions(opts?: {
      env?: { [key: string]: string | undefined };
    }): LoginInstructions {
      // Short-circuit: if the office is already signed in (credentials.json
      // present, or ANTHROPIC_API_KEY in env), the user just needs to /clear
      // a dead session - no walkthrough needed. Symmetric with Codex's
      // ALREADY_AUTHED hint. The check honors the agent's merged env so
      // envFile-set ANTHROPIC_API_KEY counts as authed.
      if (isClaudeCodeAuthenticated(opts?.env)) {
        return {
          kind: "already_authed",
          cardEligible: false,
          text: ALREADY_AUTHED_INSTRUCTIONS,
        };
      }
      // If the user can't actually run `claude` and `/login` (binary missing
      // from PATH), surface the install command first instead of the terminal
      // walkthrough that would just produce a "command not found". The card
      // rides along so the catch site can emit a [Copy to terminal] next to
      // the text.
      return isClaudeCodeInstalled(opts?.env)
        ? {
            kind: "login",
            cardEligible: true,
            text: LOGIN_INSTRUCTIONS,
            commands: [LOGIN_COMMAND],
          }
        : {
            kind: "not_installed",
            cardEligible: false,
            text: CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
            commands: [INSTALL_COMMAND],
          };
    },
  };
}

export const claudeBackend: Backend = createClaudeBackend();

// Flatten a session-store message's content into a plain text string. Used by
// getSessionMessages so the orchestrator's editMessage matching can be a
// straight content-equality check.
export function flattenSessionMessageText(m: SessionMessage): string {
  const msg = m.message as { content?: unknown } | null | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b: {
        type?: string;
        text?: unknown;
      }): b is { type: "text"; text: string } =>
        b?.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

// Re-export EFFORT_LEVELS so consumers can pick a default effort without
// importing from shared/types separately if they don't already.
export { EFFORT_LEVELS };
export type { EffortLevel };
