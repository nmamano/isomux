import type { NormalizedEvent } from "../types.ts";
import type {
  ApprovalDecision,
  NormalizedMessage,
  TokenUsage,
} from "../types.ts";
import {
  openCodeSupervisor,
  type OpenCodeLease,
  type OpenCodeSupervisor,
} from "./supervisor.ts";

export interface DiscoveredOpenCodeModel {
  id: string;
  label: string;
}

export async function discoverOpenCodeModels(
  supervisor: OpenCodeSupervisor,
  cwd: string,
): Promise<DiscoveredOpenCodeModel[]> {
  const lease = await supervisor.acquire();
  try {
    const url = new URL("/provider", lease.baseUrl);
    url.searchParams.set("directory", cwd);
    const response = await fetch(url, {
      headers: { authorization: lease.authHeader },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode HTTP ${response.status} at /provider.`);
    }
    return allowDiscoveredModels(await response.json());
  } finally {
    lease.release();
  }
}

export interface OpenCodeTransportOptions {
  cwd: string;
  model: string;
  agent?: string;
  supervisor?: OpenCodeSupervisor;
  sessionId?: string;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void;
}

type EventSink = (event: NormalizedEvent) => void;

export function interruptedToolResults(
  tools: Iterable<{ callId: string; terminal: boolean }>,
): NormalizedEvent[] {
  const results: NormalizedEvent[] = [];
  for (const tool of tools) {
    if (!tool.terminal) {
      results.push({
        kind: "tool_result",
        toolUseId: tool.callId,
        content: "Tool interrupted.",
        isError: true,
      });
    }
  }
  return results;
}

export class OpenCodeTransport {
  private readonly supervisor: OpenCodeSupervisor;
  private readonly cwd: string;
  private readonly model: string;
  private readonly agent: string | undefined;
  private readonly resumedSessionId?: string;
  private readonly contractShapeSink?: (shape: string) => void;
  private readonly safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void;
  private lease: OpenCodeLease | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private activeTurn = false;
  private abortRequested = false;
  private pendingPermission: { id: string; sessionId: string } | null = null;
  private closed = false;

  constructor(options: OpenCodeTransportOptions) {
    this.supervisor = options.supervisor ?? openCodeSupervisor;
    this.cwd = options.cwd;
    this.model = options.model;
    this.agent = options.agent;
    this.resumedSessionId = options.sessionId;
    this.contractShapeSink = options.contractShapeSink;
    this.safeErrorSink = options.safeErrorSink;
  }

  async initialize(sink: EventSink): Promise<string> {
    if (this.sessionId) return this.sessionId;
    this.lease = await this.supervisor.acquire();
    if (this.resumedSessionId) {
      this.sessionId = this.resumedSessionId;
    } else {
      const response = await this.request("/session", {
        method: "POST",
        body: JSON.stringify({ title: "Isomux OpenCode session" }),
      });
      const body = allowSession(await response.json());
      this.contractShapeSink?.("http:session:{id:string}");
      this.sessionId = body.id;
    }
    sink({ kind: "system_init", sessionId: this.sessionId, model: this.model });
    return this.sessionId;
  }

  async send(text: string, sink: EventSink): Promise<void> {
    const sessionId = await this.initialize(sink);
    await this.lease!.beginTurn();
    this.activeTurn = true;
    this.abortRequested = false;
    this.abortController = new AbortController();
    const eventsReady = this.consumeEvents(
      sessionId,
      sink,
      this.abortController.signal,
    );
    await eventsReady;
    const [providerID, modelID] = splitModel(this.model);
    try {
      await this.request(
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: "POST",
          body: JSON.stringify({
            model: { providerID, modelID },
            ...(this.agent ? { agent: this.agent } : {}),
            parts: [{ type: "text", text }],
          }),
        },
      );
      this.contractShapeSink?.("http:prompt_async:success");
    } catch (error) {
      this.abortController.abort();
      this.activeTurn = false;
      this.lease!.endTurn();
      sink({
        kind: "turn_completed",
        status: "failed",
        error:
          error instanceof Error ? error.message : "OpenCode request failed.",
      });
    }
  }

  async abort(): Promise<void> {
    if (!this.sessionId) return;
    this.abortRequested = true;
    await this.rejectPendingPermission();
    await this.request(`/session/${encodeURIComponent(this.sessionId)}/abort`, {
      method: "POST",
    }).catch(() => undefined);
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingPermission;
    if (
      !pending ||
      pending.id !== approvalId ||
      pending.sessionId !== this.sessionId
    )
      return;
    if (decision.kind !== "allow_once" && decision.kind !== "deny") {
      throw new Error("OpenCode supports Allow once and Deny in this slice.");
    }
    this.pendingPermission = null;
    await this.replyPermission(
      approvalId,
      decision.kind === "allow_once" ? "once" : "reject",
    );
  }

  async getSessionMessages(): Promise<NormalizedMessage[]> {
    const sessionId = await this.initialize(() => undefined);
    const response = await this.request(
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
    const messages = allowMessages(await response.json());
    this.contractShapeSink?.("http:message:list");
    return messages;
  }

  async forkAtMessage(messageId: string): Promise<string> {
    const sessionId = await this.initialize(() => undefined);
    const response = await this.request(
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify({ messageID: messageId }),
      },
    );
    const child = allowSession(await response.json()).id;
    this.contractShapeSink?.("http:fork:{id:string}");
    return child;
  }

  canAbortInPlace(): boolean {
    return this.activeTurn;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // release() only drops the supervisor reference count. It must keep this
    // lease's endpoint fields usable until this close-time reject and abort
    // chain finishes.
    if (this.activeTurn)
      void this.rejectPendingPermission().then(() => this.abort());
    this.abortController?.abort();
    this.lease?.endTurn();
    this.lease?.release();
  }

  private async consumeEvents(
    sessionId: string,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request("/event", { signal });
    if (!response.body) throw new Error("OpenCode event stream has no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const assistantMessages = new Set<string>();
    const textByPart = new Map<string, string>();
    const reasoningByPart = new Map<string, string>();
    const tools = new Map<
      string,
      { callId: string; name: string; terminal: boolean }
    >();
    const seenPermissions = new Set<string>();
    let stepFinish: { usage?: TokenUsage; cost?: number } | null = null;
    let settled = false;
    const settle = (event: NormalizedEvent): void => {
      if (settled) return;
      settled = true;
      this.activeTurn = false;
      this.pendingPermission = null;
      this.lease?.endTurn();
      sink(event);
      this.abortController?.abort();
    };
    let buffer = "";
    void (async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer =
            `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll(
              "\r\n",
              "\n",
            );
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = parseAllowedEvent(data);
            if (!event || event.sessionId !== sessionId) continue;
            this.contractShapeSink?.(`sse:${event.kind}`);
            if (event.kind === "assistant")
              assistantMessages.add(event.messageId);
            if (
              event.kind === "text" &&
              assistantMessages.has(event.messageId)
            ) {
              const prior = textByPart.get(event.partId) ?? "";
              if (event.text.startsWith(prior)) {
                const delta = event.text.slice(prior.length);
                if (delta) sink({ kind: "assistant_text", text: delta });
              }
              textByPart.set(event.partId, event.text);
            }
            if (
              event.kind === "reasoning" &&
              assistantMessages.has(event.messageId)
            ) {
              const prior = reasoningByPart.get(event.partId) ?? "";
              if (event.text.startsWith(prior)) {
                const delta = event.text.slice(prior.length);
                if (delta)
                  sink({
                    kind: "thinking",
                    text: delta,
                    ...(event.durationMs !== undefined
                      ? { durationMs: event.durationMs }
                      : {}),
                  });
                else if (event.durationMs !== undefined)
                  sink({
                    kind: "thinking",
                    text: "",
                    durationMs: event.durationMs,
                  });
              }
              reasoningByPart.set(event.partId, event.text);
            }
            if (event.kind === "tool") {
              const prior = tools.get(event.partId);
              if (!prior) {
                tools.set(event.partId, {
                  callId: event.callId,
                  name: event.name,
                  terminal: false,
                });
                sink({
                  kind: "tool_call",
                  toolUseId: event.callId,
                  name: event.name,
                  input: event.input,
                });
              }
              const tracked = tools.get(event.partId);
              if (
                tracked &&
                !tracked.terminal &&
                (event.status === "completed" || event.status === "error")
              ) {
                tracked.terminal = true;
                sink({
                  kind: "tool_result",
                  toolUseId: tracked.callId,
                  content: event.output ?? event.error ?? "",
                  ...(event.durationMs !== undefined
                    ? { durationMs: event.durationMs }
                    : {}),
                  ...(event.status === "error" ||
                  (event.exitCode !== undefined && event.exitCode !== 0)
                    ? { isError: true }
                    : {}),
                });
              }
            }
            if (event.kind === "permission") {
              if (seenPermissions.has(event.id)) continue;
              seenPermissions.add(event.id);
              this.pendingPermission = {
                id: event.id,
                sessionId: event.sessionId,
              };
              sink({
                kind: "approval_request",
                approvalId: event.id,
                toolName: event.permission,
                input: event.patterns.length
                  ? { patterns: event.patterns }
                  : {},
                title: `OpenCode wants to use ${event.permission}`,
              });
            }
            if (event.kind === "question") {
              sink({
                kind: "input_request",
                inputType: "question",
                requestId: event.id,
              });
            }
            if (event.kind === "step_finish")
              stepFinish = { usage: event.usage, cost: event.cost };
            if (event.kind === "idle") {
              if (this.abortRequested) {
                for (const result of interruptedToolResults(tools.values()))
                  sink(result);
                settle({ kind: "turn_completed", status: "interrupted" });
              } else if (stepFinish) {
                settle({
                  kind: "turn_completed",
                  status: "completed",
                  ...(stepFinish.usage ? { usage: stepFinish.usage } : {}),
                  ...(stepFinish.cost !== undefined
                    ? { cost: stepFinish.cost }
                    : {}),
                });
              } else {
                settle({
                  kind: "turn_completed",
                  status: "failed",
                  error: "OpenCode became idle without a recorded completion.",
                });
              }
              return;
            }
            if (event.kind === "error") {
              if (this.abortRequested) continue;
              settled = true;
              this.activeTurn = false;
              this.lease?.endTurn();
              this.safeErrorSink?.(event.error);
              const auth = await this.isAuthenticationError(event.error);
              let recoveryError: string | null = null;
              if (auth) {
                try {
                  await this.supervisor.prepareForAuthentication();
                } catch (error) {
                  recoveryError =
                    error instanceof Error
                      ? error.message
                      : "OpenCode login could not prepare the shared server.";
                }
              }
              sink({
                kind: "turn_completed",
                status: "failed",
                error:
                  recoveryError ??
                  (auth
                    ? "OpenCode authentication is not configured."
                    : "OpenCode reported a provider or transport error."),
              });
              this.abortController?.abort();
              return;
            }
          }
        }
        if (!signal.aborted) {
          settle({
            kind: "turn_completed",
            status: "failed",
            error: "OpenCode event stream ended before turn completion.",
          });
        }
      } catch (error) {
        if (!signal.aborted) {
          settle({
            kind: "turn_completed",
            status: "failed",
            error: `OpenCode event stream failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        }
      }
    })();
  }

  private async replyPermission(
    id: string,
    reply: "once" | "reject",
  ): Promise<void> {
    await this.request(`/permission/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
  }

  private async rejectPendingPermission(): Promise<void> {
    const pending = this.pendingPermission;
    if (!pending || pending.sessionId !== this.sessionId) return;
    this.pendingPermission = null;
    await this.replyPermission(pending.id, "reject").catch(() => undefined);
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (!this.lease) throw new Error("OpenCode transport is not initialized.");
    const url = new URL(path, this.lease.baseUrl);
    url.searchParams.set("directory", this.cwd);
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: this.lease.authHeader,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode HTTP ${response.status} at ${path}.`);
    }
    return response;
  }

  private async isAuthenticationError(
    error: SafeOpenCodeError,
  ): Promise<boolean> {
    if (error.statusCode === 401 || error.statusCode === 403) return true;
    if (
      error.name !== "UnknownError" ||
      !error.message?.startsWith(
        `Model not found: ${this.model}. Did you mean:`,
      )
    )
      return false;
    try {
      const response = await this.request("/provider");
      const connected = allowConnectedProviders(await response.json());
      return isAuthenticationError(error, this.model, connected);
    } catch {
      return false;
    }
  }
}

export function splitModel(model: string): [string, string] {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new Error("OpenCode model must use provider/model form.");
  }
  return [model.slice(0, slash), model.slice(slash + 1)];
}

export function allowDiscoveredModels(raw: unknown): DiscoveredOpenCodeModel[] {
  const body = asRecord(raw);
  const connected = new Set(
    Array.isArray(body.connected)
      ? body.connected.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const byId = new Map<string, DiscoveredOpenCodeModel>();
  if (!Array.isArray(body.all)) return [];
  for (const rawProvider of body.all) {
    const provider = asRecord(rawProvider);
    const providerId = stringField(provider, "id");
    if (!providerId || !safeCatalogId(providerId) || !connected.has(providerId))
      continue;
    const providerLabel = safeCatalogLabel(provider.name, providerId);
    const models = asRecord(provider.models);
    for (const [rawModelId, rawModel] of Object.entries(models)) {
      if (!rawModelId) continue;
      const modelId = rawModelId.startsWith(`${providerId}/`)
        ? rawModelId.slice(providerId.length + 1)
        : rawModelId;
      if (!modelId || !safeCatalogId(modelId)) continue;
      const id = `${providerId}/${modelId}`;
      const modelLabel = safeCatalogLabel(asRecord(rawModel).name, modelId);
      if (!byId.has(id)) {
        byId.set(id, { id, label: `${providerLabel} - ${modelLabel}` });
      }
    }
  }
  return [...byId.values()].sort((left, right) => {
    if (left.label !== right.label) return left.label < right.label ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

function safeCatalogId(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function safeCatalogLabel(value: unknown, fallback: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    /(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|bearer)/i.test(
      value,
    )
  )
    return fallback;
  return value;
}

function allowSession(raw: unknown): { id: string } {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as { id?: unknown }).id !== "string"
  ) {
    throw new Error("OpenCode returned an invalid session shape.");
  }
  return { id: (raw as { id: string }).id };
}

export function allowMessages(raw: unknown): NormalizedMessage[] {
  if (!Array.isArray(raw)) {
    throw new Error("OpenCode returned an invalid message list.");
  }
  return raw.map((value) => {
    const message = asRecord(value);
    const info = asRecord(message.info);
    const uuid = stringField(info, "id");
    const role = info.role;
    if (
      !uuid ||
      (role !== "user" &&
        role !== "assistant" &&
        role !== "system" &&
        role !== "result")
    ) {
      throw new Error("OpenCode returned an invalid message shape.");
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
      .map(asRecord)
      .filter((part) => part.type === "text")
      .map((part) => stringField(part, "text") ?? "")
      .join("");
    return { uuid, role, text };
  });
}

type AllowedEvent =
  | { kind: "assistant"; sessionId: string; messageId: string }
  | {
      kind: "text";
      sessionId: string;
      messageId: string;
      partId: string;
      text: string;
    }
  | {
      kind: "reasoning";
      sessionId: string;
      messageId: string;
      partId: string;
      text: string;
      durationMs?: number;
    }
  | {
      kind: "tool";
      sessionId: string;
      partId: string;
      callId: string;
      name: string;
      status: "pending" | "running" | "completed" | "error";
      input: Record<string, unknown>;
      output?: string;
      error?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      kind: "permission";
      sessionId: string;
      id: string;
      permission: string;
      patterns: string[];
    }
  | { kind: "question"; sessionId: string; id: string }
  | {
      kind: "step_finish";
      sessionId: string;
      usage?: TokenUsage;
      cost?: number;
    }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; error: SafeOpenCodeError };

export interface SafeOpenCodeError {
  name?: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
}

export function parseAllowedEvent(data: string): AllowedEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = raw.type;
  const properties = asRecord(raw.properties);
  const sessionId = stringField(properties, "sessionID");
  if (!sessionId) return null;
  if (type === "session.idle") return { kind: "idle", sessionId };
  if (type === "session.error") {
    return { kind: "error", sessionId, error: allowError(properties.error) };
  }
  if (type === "permission.asked") {
    const id = stringField(properties, "id");
    const permission = stringField(properties, "permission");
    if (!id || !permission) return null;
    const patterns = Array.isArray(properties.patterns)
      ? properties.patterns.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return { kind: "permission", sessionId, id, permission, patterns };
  }
  if (type === "question.asked") {
    const id = stringField(properties, "id");
    if (!id) return null;
    return { kind: "question", sessionId, id };
  }
  if (type === "message.updated") {
    const info = asRecord(properties.info);
    const messageId = stringField(info, "id");
    if (info.role === "assistant" && messageId) {
      return { kind: "assistant", sessionId, messageId };
    }
  }
  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    const messageId = stringField(part, "messageID");
    const partId = stringField(part, "id");
    const text = stringField(part, "text");
    if (part.type === "text" && messageId && partId && text !== null) {
      return { kind: "text", sessionId, messageId, partId, text };
    }
    if (part.type === "reasoning" && messageId && partId && text !== null) {
      const time = asRecord(part.time);
      const start = numberField(time, "start");
      const end = numberField(time, "end");
      return {
        kind: "reasoning",
        sessionId,
        messageId,
        partId,
        text,
        ...(start !== null && end !== null
          ? { durationMs: Math.max(0, end - start) }
          : {}),
      };
    }
    if (part.type === "tool" && partId) {
      const state = asRecord(part.state);
      const status = state.status;
      const callId = stringField(part, "callID");
      const name = stringField(part, "tool");
      if (!callId || !name || !isToolStatus(status)) return null;
      const time = asRecord(state.time);
      const metadata = asRecord(state.metadata);
      const start = numberField(time, "start");
      const end = numberField(time, "end");
      return {
        kind: "tool",
        sessionId,
        partId,
        callId,
        name,
        status,
        input: asRecord(state.input),
        ...(typeof state.output === "string" ? { output: state.output } : {}),
        ...(typeof state.error === "string" ? { error: state.error } : {}),
        ...(numberField(metadata, "exit") !== null
          ? { exitCode: numberField(metadata, "exit")! }
          : {}),
        ...(start !== null && end !== null
          ? { durationMs: Math.max(0, end - start) }
          : {}),
      };
    }
    if (part.type === "step-finish") {
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      const input = numberField(tokens, "input");
      const output = numberField(tokens, "output");
      if (!partId) return null;
      const usage =
        input !== null && output !== null
          ? {
              inputTokens: input,
              outputTokens: output,
              cacheReadInputTokens: numberField(cache, "read") ?? 0,
              cacheCreationInputTokens: numberField(cache, "write") ?? 0,
            }
          : undefined;
      const cost = numberField(part, "cost");
      return {
        kind: "step_finish",
        sessionId,
        ...(usage ? { usage } : {}),
        ...(cost !== null ? { cost } : {}),
      };
    }
  }
  return null;
}

function allowError(value: unknown): SafeOpenCodeError {
  const error = asRecord(value);
  const data = asRecord(error.data);
  return {
    ...(typeof error.name === "string" ? { name: error.name } : {}),
    ...(typeof data.message === "string" ? { message: data.message } : {}),
    ...(typeof data.statusCode === "number"
      ? { statusCode: data.statusCode }
      : {}),
    ...(typeof data.isRetryable === "boolean"
      ? { isRetryable: data.isRetryable }
      : {}),
  };
}

export function isAuthenticationError(
  error: SafeOpenCodeError,
  selectedModel: string,
  connectedProviders: string[],
): boolean {
  if (error.statusCode === 401 || error.statusCode === 403) return true;
  if (error.name !== "UnknownError" || !error.message) return false;
  const providerID = splitModel(selectedModel)[0];
  return (
    error.message.startsWith(
      `Model not found: ${selectedModel}. Did you mean:`,
    ) && !connectedProviders.includes(providerID)
  );
}

function allowConnectedProviders(raw: unknown): string[] {
  const connected = asRecord(raw).connected;
  return Array.isArray(connected)
    ? connected.filter((value): value is string => typeof value === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : null;
}

function isToolStatus(
  value: unknown,
): value is "pending" | "running" | "completed" | "error" {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "error"
  );
}
