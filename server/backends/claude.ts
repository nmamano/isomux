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
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  forkSession as sdkForkSession,
  getSessionMessages as sdkGetSessionMessages,
  type SDKMessage,
  type SDKSession,
  type SDKUserMessage,
  type SessionMessage,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { readFileSync, statSync } from "fs";

import type { Attachment } from "../../shared/types.ts";
import { FAMILY_TO_MODEL, MODEL_FAMILIES, EFFORT_LEVELS } from "../../shared/types.ts";
import type { ModelFamily, EffortLevel } from "../../shared/types.ts";
import { getFilePath, saveFile } from "../persistence.ts";
import { createSafetyHooks } from "../safety-hooks.ts";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";

import type {
  ApprovalDecision,
  AttachmentSpec,
  Backend,
  BackendCapabilities,
  BackendSession,
  ContextUsage,
  CreateSessionOptions,
  ModelOption,
  NormalizedEvent,
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
  TokenUsage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOGIN_INSTRUCTIONS = `To authenticate:
1. Open the built-in terminal
2. Run \`claude\`
3. Type \`/login\`
4. Follow the auth flow

Once complete, it takes effect immediately for all Isomux agents.`;

const AUTH_ERROR_PATTERNS = /unauthori[zs]ed|not authenticated|authentication|auth.*expired|invalid.*token|login.*required|403|401/i;

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
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "cfg",
  "sh", "bash", "py", "js", "ts", "go", "rs", "c", "h", "cpp", "java", "rb",
  "html", "css", "sql", "env", "conf",
]);

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

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

class ClaudeSession implements BackendSession {
  private sdkSession: SDKSession;
  private buffer: NormalizedEvent[] = [];
  private resolveWake: (() => void) | null = null;
  private ended = false;
  private closed = false;
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
    sdkOpts: Parameters<typeof unstable_v2_createSession>[0],
    resumeSessionId?: string,
  ) {
    const optsWithApproval = {
      ...sdkOpts,
      canUseTool: ((toolName, input, callOpts) =>
        this.handleCanUseTool(toolName, input, callOpts)) as CanUseTool,
    };
    this.sdkSession = resumeSessionId
      ? unstable_v2_resumeSession(resumeSessionId, optsWithApproval)
      : unstable_v2_createSession(optsWithApproval);
    void this.feedSDKMessages();
  }

  private async feedSDKMessages() {
    try {
      // SDK's stream() returns per turn (each `result` message ends the
      // generator; the underlying queryIterator is cached, so the NEXT
      // stream() call resumes it). Call it in a loop so subsequent turns and
      // between-turn events keep flowing. Break when the SDK iterator is
      // truly exhausted — detected by stream() returning without having
      // yielded a `result` (process exit / close()).
      while (!this.closed) {
        let lastWasResult = false;
        try {
          for await (const msg of this.sdkSession.stream()) {
            if (msg.type === "result") lastWasResult = true;
            for (const ev of translateSDKMessage(msg, this.agentId)) {
              this.enqueue(ev);
            }
          }
        } catch (err: any) {
          // SDK threw — typically subprocess exit, mid-stream abort, or
          // transport failure. If we initiated the close (this.closed=true),
          // it's expected and we exit quietly. Otherwise surface as a
          // normalized `error` event so the orchestrator can log + update
          // state. Either way stop looping: queryIterator is unusable past
          // this point. We MUST swallow here — feedSDKMessages runs as
          // `void this.feedSDKMessages()`, so an uncaught rejection becomes
          // unhandled and crashes the whole Bun process.
          if (!this.closed) {
            this.enqueue({
              kind: "error",
              message: err?.message ?? String(err),
            });
          }
          break;
        }
        if (!lastWasResult) break;
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
          existing.resolve({ behavior: "deny", message: "Superseded by newer request." });
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
      await this.sdkSession.send(message);
    } else {
      await this.sdkSession.send(text);
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
        result = { behavior: "deny", message: decision.reason ?? "User denied." };
        break;
    }
    pending.resolve(result);
    return Promise.resolve();
  }

  async abort(): Promise<void> {
    // Claude's abort path is orchestrator-managed (close current session +
    // install a replacement). close() is sufficient here; the orchestrator
    // wraps with replaceSession().
    this.close();
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    // The SDKSession runtime carries a `.query` property holding the
    // underlying V1 Query instance — it's not in the public type, but it's
    // how /context worked pre-refactor. We delegate to its getContextUsage
    // method when present. Returns null if the SDK shape changes or the
    // session hasn't reached a state where it can answer.
    const query = (this.sdkSession as any).query;
    if (!query || typeof query.getContextUsage !== "function") return null;
    try {
      const ctx = await query.getContextUsage();
      // SDKControlGetContextUsageResponse is a superset of our ContextUsage
      // shape; pass through with a structural cast.
      return ctx as unknown as ContextUsage;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sdkSession.close();
    } catch {}
    // Resolve any in-flight approvals with deny so the SDK's tool execution
    // unblocks and orchestrator-side awaiters don't hang.
    for (const [, pending] of this.pendingApprovals) {
      try {
        pending.resolve({ behavior: "deny", message: "Session closed." });
      } catch {}
    }
    this.pendingApprovals.clear();
  }
}

// ---------------------------------------------------------------------------
// SDK message → NormalizedEvent translation
// ---------------------------------------------------------------------------

function* translateSDKMessage(
  msg: SDKMessage,
  agentId: string,
): Generator<NormalizedEvent, void> {
  switch (msg.type) {
    case "system": {
      const subtype = (msg as any).subtype;
      if (subtype === "init") {
        // session_id is always present in practice; we still emit system_init
        // (with sessionId undefined) if it's missing so the orchestrator can
        // pick up slash_commands/skills on the same event. The orchestrator
        // guards session-side effects on the sessionId presence.
        const sessionId = (msg as any).session_id as string | undefined;
        yield {
          kind: "system_init",
          sessionId: sessionId || undefined,
          slashCommands: (msg as any).slash_commands ?? [],
          model: (msg as any).model,
        };
      } else if (subtype === "local_command_output") {
        const content = (msg as any).content;
        if (content) yield { kind: "system_text", text: content };
      }
      break;
    }

    case "assistant": {
      const message = (msg as any).message;
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
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              : JSON.stringify(block.content);
        // Extract image blocks → save to disk → emit as attachments. Side-
        // effecting, but persistence is a backend-level concern (not
        // orchestration) and the SDK's wire shape is the only place we
        // have the base64 bytes.
        let attachments: Attachment[] | undefined;
        if (Array.isArray(block.content)) {
          const atts: Attachment[] = [];
          for (const c of block.content as any[]) {
            if (c.type === "image" && c.source?.type === "base64") {
              const decoded = Buffer.from(c.source.data, "base64");
              const ext = c.source.media_type.split("/")[1] ?? "png";
              const att = saveFile(agentId, decoded, c.source.media_type, `image.${ext}`);
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
        };
      }
      break;
    }

    case "result": {
      const subtype = (msg as any).subtype;
      const usageField = (msg as any).usage;
      // Only trust usage from success results. Error-subtype results may omit
      // `usage`; coercing to zeros would overwrite the accurate cumulative.
      const usage: TokenUsage | undefined =
        usageField && subtype === "success"
          ? {
              inputTokens: usageField.input_tokens ?? 0,
              outputTokens: usageField.output_tokens ?? 0,
              cacheReadInputTokens: usageField.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: usageField.cache_creation_input_tokens ?? 0,
            }
          : undefined;
      const cost = (msg as any).total_cost_usd as number | undefined;
      if (subtype === "success") {
        yield { kind: "turn_completed", status: "completed", usage, cost };
      } else {
        const errors = (msg as any).errors as string[] | undefined;
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

function buildClaudeUserMessage(
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
          media_type: att.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
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

function buildSdkOpts(
  opts: CreateSessionOptions,
): Parameters<typeof unstable_v2_createSession>[0] {
  const familyKey = opts.modelFamily as ModelFamily;
  const model = FAMILY_TO_MODEL[familyKey] ?? opts.modelFamily;
  const sdkOpts: any = {
    model,
    permissionMode: opts.permissionMode,
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    // V2 SDKSessionOptions still doesn't expose systemPrompt / extraArgs, so we
    // inject --append-system-prompt and --effort via executableArgs. When
    // pathToClaudeCodeExecutable is a native binary, executableArgs are
    // prepended to the CLI args verbatim (verified against SDK 0.2.116 sdk.mjs).
    executableArgs: ["--append-system-prompt", opts.systemPrompt, "--effort", opts.effort],
    cwd: opts.cwd,
    hooks: createSafetyHooks(),
  };
  if (opts.env) sdkOpts.env = opts.env;
  return sdkOpts;
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export const claudeBackend: Backend = {
  capabilities: CAPABILITIES,

  getModelOptions(): ModelOption[] {
    return MODEL_FAMILIES.map((m) => ({ value: m.family, label: m.label }));
  },

  getPermissionModes(): PermissionModeOption[] {
    return PERMISSION_MODES;
  },

  createSession(opts: CreateSessionOptions): BackendSession {
    return new ClaudeSession(opts.agentId, buildSdkOpts(opts));
  },

  resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession {
    return new ClaudeSession(opts.agentId, buildSdkOpts(opts), sessionId);
  },

  async forkSession(
    sessionId: string,
    upToMessageId: string,
  ): Promise<{ sessionId: string }> {
    const result = await sdkForkSession(sessionId, { upToMessageId });
    return { sessionId: result.sessionId };
  },

  async getSessionMessages(sessionId: string): Promise<NormalizedMessage[]> {
    const messages = await sdkGetSessionMessages(sessionId);
    const out: NormalizedMessage[] = [];
    for (const m of messages) {
      // SessionMessage.type is user/assistant/system (no "result"); narrow to
      // those for the orchestrator's edit-message matching.
      if (m.type !== "user" && m.type !== "assistant" && m.type !== "system") continue;
      out.push({
        uuid: m.uuid,
        role: m.type,
        text: flattenSessionMessageText(m),
      });
    }
    return out;
  },

  async oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string> {
    const familyKey = opts.modelFamily as ModelFamily;
    const model = FAMILY_TO_MODEL[familyKey] ?? opts.modelFamily;
    const result = await unstable_v2_prompt(prompt, {
      model,
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
      // plan mode disables tool execution — the topic-gen prompt only needs the
      // model to think and reply, never run anything.
      permissionMode: "plan",
      ...(opts.env ? { env: opts.env } : {}),
    } as any);
    if (result.subtype !== "success") {
      throw new Error(`oneShotPrompt failed: ${result.subtype}`);
    }
    return result.result;
  },

  detectAuthError(text: string): boolean {
    return AUTH_ERROR_PATTERNS.test(text);
  },

  getLoginInstructions(): string {
    return LOGIN_INSTRUCTIONS;
  },
};

// Flatten a session-store message's content into a plain text string. Used by
// getSessionMessages so the orchestrator's editMessage matching can be a
// straight content-equality check.
function flattenSessionMessageText(m: SessionMessage): string {
  const msg = m.message as any;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

// Re-export EFFORT_LEVELS so consumers can pick a default effort without
// importing from shared/types separately if they don't already.
export { EFFORT_LEVELS };
export type { EffortLevel };
