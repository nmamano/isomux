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
// cronjob-manager.ts still imports the SDK directly — cronjobs are Claude-
// only at v1 (per Round 3 decisions).

import {
  query,
  forkSession as sdkForkSession,
  getSessionMessages as sdkGetSessionMessages,
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

// Internal session-options shape — the boundary between the orchestrator-
// facing `buildSdkOpts` and the SDK adapters. Defined here (not aliased to an
// SDK type) so adapter changes don't ripple into every caller, and so the
// `executableArgs` field can carry the V2-style `--flag value` pairs isomux
// has historically produced. The V1 adapter parses those into V1's typed
// `extraArgs` via `translateExecutableArgs` below.
export interface SdkSessionOptions {
  model: string;
  pathToClaudeCodeExecutable: string;
  executableArgs?: string[];
  env?: { [key: string]: string | undefined };
  cwd: string;
  permissionMode: PermissionMode;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
}
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { readFileSync, statSync } from "fs";

import type { Attachment } from "../../shared/types.ts";
import { errMessage } from "../../shared/errors.ts";
import {
  FAMILY_TO_MODEL,
  MODEL_FAMILIES,
  EFFORT_LEVELS,
  claudeFamilySupportsMaxEffort,
} from "../../shared/types.ts";
import type { ModelFamily, EffortLevel } from "../../shared/types.ts";
import { getFilePath, saveFile } from "../persistence.ts";
import { createSafetyHooks } from "../safety-hooks.ts";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
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
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
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

Once complete, it takes effect immediately for all Isomux agents.`;

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

Alternative: add \`ANTHROPIC_API_KEY\` to your envFile (User Settings → Env File Path, then \`/clear\`).`;

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
  { value: "default", label: "Default — prompt for each tool" },
  { value: "acceptEdits", label: "Accept edits automatically" },
  { value: "bypassPermissions", label: "Bypass all permissions" },
  { value: "auto", label: "Auto — Isomux decides via /resolve" },
];

const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "sh",
  "bash",
  "py",
  "js",
  "ts",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "java",
  "rb",
  "html",
  "css",
  "sql",
  "env",
  "conf",
]);

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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
}

export interface SdkOneShotOptions {
  prompt: string;
  model: string;
  pathToClaudeCodeExecutable: string;
  systemPrompt?: string;
  env?: { [key: string]: string | undefined };
}

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
// V1 SDK adapter — production
// ---------------------------------------------------------------------------
// V1's `query()` consumes an AsyncIterable<SDKUserMessage> as its prompt and
// returns a single `Query` generator that spans all turns. `send()` pushes
// into the input iterable; `close()` ends the iterable + best-effort
// `interrupt()`s the query.

// V2 used `executableArgs: ["--append-system-prompt", X, "--effort", Y]` to
// prepend Claude CLI flags. V1's `executableArgs` is for the JS runtime
// (node/bun/deno), not the Claude CLI — forwarding our pairs would be a
// behavioral bug. Translate to V1's typed `extraArgs`.
//
// Deliberately narrow: only the pairs `buildSdkOpts` actually produces are
// recognized. Anything else throws — adding a new flag through this path
// without updating this translator would silently drop it.
export function translateExecutableArgs(
  executableArgs: string[],
): Record<string, string> {
  const extraArgs: Record<string, string> = {};
  for (let i = 0; i < executableArgs.length; i++) {
    const flag = executableArgs[i];
    const value = executableArgs[i + 1];
    if (flag === "--append-system-prompt") {
      if (typeof value !== "string") {
        throw new Error(
          "translateExecutableArgs: --append-system-prompt requires a string value",
        );
      }
      extraArgs["append-system-prompt"] = value;
      i++;
    } else if (flag === "--effort") {
      if (typeof value !== "string") {
        throw new Error(
          "translateExecutableArgs: --effort requires a string value",
        );
      }
      extraArgs.effort = value;
      i++;
    } else {
      throw new Error(
        `translateExecutableArgs: unrecognized arg ${JSON.stringify(flag)} ` +
          `(V1's executableArgs is for the JS runtime, not the Claude CLI — ` +
          `add a case here only if the flag is one we own)`,
      );
    }
  }
  return extraArgs;
}

// Exported for test coverage of the executableArgs→extraArgs swap and the
// optional `resume` add-on. Internal otherwise.
export function sessionOptsToV1(
  opts: SdkSessionOptions,
  resumeSessionId?: string,
): Options {
  const { executableArgs, ...rest } = opts;
  const extraArgs =
    executableArgs && executableArgs.length > 0
      ? translateExecutableArgs(executableArgs)
      : undefined;
  return {
    ...rest,
    ...(extraArgs ? { extraArgs } : {}),
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
  interrupt(): Promise<void>;
  getContextUsage(): Promise<unknown>;
}

export function wrapV1Query(
  q: V1QueryLike,
  input: PushableInput<SDKUserMessage>,
  abortController?: AbortController,
): SdkConversation {
  let closed = false;
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
      // tool execution. Both must be swallowed — `SdkConversation.close` is
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
      // its read loop, never exiting — leaking ~165MB per agent. abortController
      // is the SDK's documented cancel lever ("when aborted, the query will stop
      // and clean up resources"), which tears the subprocess down. Best-effort
      // and swallowed: close() is documented "never throws".
      try {
        abortController?.abort();
      } catch {}
    },
    async getContextUsage(): Promise<ContextUsage | null> {
      try {
        const ctx = await q.getContextUsage();
        return ctx as ContextUsage;
      } catch {
        return null;
      }
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
// ClaudeSession — BackendSession implementation
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
      // throw — typically subprocess exit, mid-stream abort, or transport
      // failure — if we initiated the close, exit quietly; otherwise emit a
      // normalized `error` event so the orchestrator can log + update state.
      // We MUST swallow here: feedSDKMessages runs as
      // `void this.feedSDKMessages()`, so an uncaught rejection becomes
      // unhandled and crashes the whole Bun process.
      for await (const msg of this.conversation.messages()) {
        for (const ev of translateSDKMessage(msg, this.imageSink)) {
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
      // happen — SDK tool calls are serialized — but defensive), deny it.
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
      "ClaudeSession.abort() is unsupported — use close() + a replacement session, or check canAbortInPlace() before calling.",
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Resolve pending approvals with deny FIRST so any in-flight canUseTool
    // callback unblocks the SDK side — denying after close() would race the
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
        // Not the canonical "show a file to the boss" path — that's POST
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
// User-message construction (text + attachments → SDKUserMessage)
// ---------------------------------------------------------------------------
// Moved here from user-message.ts: the construction is fully SDK-coupled
// (ContentBlockParam shapes, image base64 inlining, document base64 inlining
// for PDFs). The orchestrator hands the backend plain text + AttachmentSpec[]
// and the backend builds whatever wire shape the engine wants.

export function buildClaudeUserMessage(
  agentId: string,
  text: string,
  attachments: AttachmentSpec[],
): SDKUserMessage {
  const content: ContentBlockParam[] = [];

  if (text) {
    content.push({ type: "text", text });
  }

  for (const att of attachments) {
    const filePath = getFilePath(agentId, att.filename);
    if (!filePath) continue;

    if (IMAGE_MEDIA_TYPES.has(att.mediaType)) {
      const data = readFileSync(filePath).toString("base64");
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.mediaType as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data,
        },
      });
    } else if (att.mediaType === "application/pdf") {
      // Claude API limits: 100 pages, ~32MB base64. Check file size as a proxy.
      const stats = statSync(filePath);
      if (stats.size > 10 * 1024 * 1024) {
        // Too large to send inline — give the agent the file path instead
        content.push({
          type: "text",
          text: `Attached PDF "${att.originalName}" (${(stats.size / 1024 / 1024).toFixed(1)}MB) is too large to display inline. The file is saved at: ${filePath}`,
        });
      } else {
        const data = readFileSync(filePath).toString("base64");
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data,
          },
        });
      }
    } else {
      const ext = att.originalName.includes(".")
        ? att.originalName.split(".").pop()!.toLowerCase()
        : "";
      if (TEXT_FILE_EXTENSIONS.has(ext)) {
        const fileContent = readFileSync(filePath, "utf-8");
        content.push({
          type: "text",
          text: `--- File: ${att.originalName} ---\n${fileContent}\n---`,
        });
      } else {
        content.push({
          type: "text",
          text: `Attached file ${att.originalName} (unable to see content) [Reminder: do not pretend that you can see it or infer its content]`,
        });
      }
    }
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
// --append-system-prompt / --effort args, normalizes the model family.

function buildSdkOpts(opts: CreateSessionOptions): SdkSessionOptions {
  const familyKey = opts.modelFamily as ModelFamily;
  const model = FAMILY_TO_MODEL[familyKey] ?? opts.modelFamily;
  const sdkOpts: SdkSessionOptions = {
    model,
    // permissionMode is `string` at the Backend boundary; narrow at the call site.
    permissionMode: opts.permissionMode as PermissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    // executableArgs injects --append-system-prompt and --effort. When
    // pathToClaudeCodeExecutable is a native binary, executableArgs are
    // prepended to the CLI args verbatim (verified against SDK 0.2.116 sdk.mjs).
    executableArgs: [
      "--append-system-prompt",
      opts.systemPrompt,
      "--effort",
      opts.effort,
    ],
    cwd: opts.cwd,
    hooks: createSafetyHooks(),
    // AskUserQuestion has no usable UI in isomux: the canUseTool approval
    // shows only "Allow/Deny" without rendering the question text, and the
    // headless tool execution returns empty answers — which the agent then
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
        supportedEfforts: EFFORT_LEVELS.filter((e) => {
          if (e.level === "max") return claudeFamilySupportsMaxEffort(m.family);
          if (e.level === "minimal") return false;
          return true;
        }).map((e) => ({ level: e.level })),
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
        // First user message: no predecessor to fork at. Return fresh — the
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
        env: opts.env,
      });
    },

    detectAuthError(text: string): boolean {
      return AUTH_ERROR_PATTERNS.test(text);
    },

    getLoginInstructions(opts?: {
      env?: { [key: string]: string | undefined };
    }): { text: string; commands?: string[] } {
      // Short-circuit: if the office is already signed in (credentials.json
      // present, or ANTHROPIC_API_KEY in env), the user just needs to /clear
      // a dead session — no walkthrough needed. Symmetric with Codex's
      // ALREADY_AUTHED hint. The check honors the agent's merged env so
      // envFile-set ANTHROPIC_API_KEY counts as authed.
      if (isClaudeCodeAuthenticated(opts?.env)) {
        return { text: ALREADY_AUTHED_INSTRUCTIONS };
      }
      // If the user can't actually run `claude` and `/login` (binary missing
      // from PATH), surface the install command first instead of the terminal
      // walkthrough that would just produce a "command not found". The card
      // rides along so the catch site can emit a [Copy to terminal] next to
      // the text.
      return isClaudeCodeInstalled()
        ? { text: LOGIN_INSTRUCTIONS, commands: [LOGIN_COMMAND] }
        : {
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
