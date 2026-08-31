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
import {
  openCodeAuthorityBroker,
  type OpenCodeAuthorityBinding,
  type OpenCodeAuthorityBroker,
} from "./authority-broker.ts";
import { OPENCODE_TURN_HANDLE_PLACEHOLDER } from "./office-proxy-shared.ts";
import { OPENCODE_MANUAL_API_KEY_PROVIDERS } from "./login-wrapper.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import {
  evaluateOpenCodePermission,
  type OpenCodePermissionEnvelope,
} from "./safety-adapter.ts";
import type { evaluateProposedAction } from "../../safety-policy.ts";

export const OPENCODE_PERMISSION_ID_WARNING =
  "Isomux stopped this turn: OpenCode asked to use a tool but sent no id " +
  "with the request, so Isomux had no way to answer it. Tell the office " +
  "owner and check the isomux service logs.";

export interface DiscoveredOpenCodeModel {
  id: string;
  label: string;
  requiresConnection?: boolean;
  isFree?: boolean;
}

export function openCodeModelIsFree(rawCost: unknown): boolean {
  const cost = asRecord(rawCost);
  const cache = asRecord(cost.cache);
  const values: unknown[] = [];
  for (const [record, field] of [
    [cost, "input"],
    [cost, "output"],
    [cache, "read"],
    [cache, "write"],
  ] as const) {
    if (field in record) values.push(record[field]);
  }
  return (
    values.length > 0 &&
    values.every((value) => typeof value === "number" && value === 0)
  );
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
  // Administrative transports used only for history/fork operations have no
  // prompt. Any transport that sends a turn must provide one.
  systemPrompt?: string;
  agentToken?: string;
  agentId?: string;
  authorityBroker?: OpenCodeAuthorityBroker;
  agent?: string;
  supervisor?: OpenCodeSupervisor;
  sessionId?: string;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void;
}

export interface OpenCodePromptPart {
  type: "text";
  text: string;
}

type EventSink = (event: NormalizedEvent) => void;

export async function handleOpenCodePermission(
  event: OpenCodePermissionEnvelope,
  options: {
    cwd: string;
    autoApprove: boolean;
    warningState: { shown: boolean };
    reply: (reply: "once" | "reject", message?: string) => Promise<void>;
    sink: EventSink;
    evaluate?: typeof evaluateProposedAction;
  },
): Promise<"answered" | "prompt"> {
  const result = evaluateOpenCodePermission(
    event,
    options.cwd,
    options.evaluate,
  );
  if (result.kind === "fail_open") {
    if (!options.warningState.shown) {
      options.warningState.shown = true;
      options.sink({
        kind: "system_text",
        text: SAFETY_WARNING,
        isomuxAuthored: true,
      });
    }
    if (!options.autoApprove) return "prompt";
    await options.reply("once");
    return "answered";
  }
  if (result.decision.decision === "deny") {
    await options.reply("reject", result.decision.reason);
    options.sink({
      kind: "system_text",
      text: result.decision.reason,
      isomuxAuthored: true,
    });
    return "answered";
  }
  if (options.autoApprove) {
    await options.reply("once");
    return "answered";
  }
  return "prompt";
}

interface TrackedTool {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  callEmitted: boolean;
  terminal: boolean;
}

function toolCall(tool: TrackedTool): NormalizedEvent {
  return {
    kind: "tool_call",
    toolUseId: tool.callId,
    name: tool.name,
    input: tool.input,
  };
}

export function interruptedToolResults(
  tools: Iterable<TrackedTool>,
): NormalizedEvent[] {
  const results: NormalizedEvent[] = [];
  for (const tool of tools) {
    if (!tool.terminal) {
      if (!tool.callEmitted) {
        tool.callEmitted = true;
        results.push(toolCall(tool));
      }
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

export function toolUpdateEvents(
  tool: TrackedTool,
  update: {
    status: "pending" | "running" | "completed" | "error";
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    exitCode?: number;
    durationMs?: number;
  },
): NormalizedEvent[] {
  tool.input = update.input;
  const events: NormalizedEvent[] = [];
  const terminal = update.status === "completed" || update.status === "error";
  if (!tool.callEmitted && (Object.keys(update.input).length > 0 || terminal)) {
    tool.callEmitted = true;
    events.push(toolCall(tool));
  }
  if (!tool.terminal && terminal) {
    tool.terminal = true;
    events.push({
      kind: "tool_result",
      toolUseId: tool.callId,
      content: update.output ?? update.error ?? "",
      ...(update.durationMs !== undefined
        ? { durationMs: update.durationMs }
        : {}),
      ...(update.status === "error" ||
      (update.exitCode !== undefined && update.exitCode !== 0)
        ? { isError: true }
        : {}),
    });
  }
  return events;
}

export class OpenCodeTransport {
  private readonly supervisor: OpenCodeSupervisor;
  private readonly cwd: string;
  private readonly model: string;
  private readonly systemPrompt: string | undefined;
  private readonly agentToken: string | undefined;
  private readonly agentId: string | undefined;
  private readonly authorityBroker: OpenCodeAuthorityBroker;
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
  private authorityBinding: OpenCodeAuthorityBinding | null = null;

  constructor(options: OpenCodeTransportOptions) {
    this.supervisor = options.supervisor ?? openCodeSupervisor;
    this.cwd = options.cwd;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.agentToken = options.agentToken;
    this.agentId = options.agentId;
    this.authorityBroker = options.authorityBroker ?? openCodeAuthorityBroker;
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
    if (this.agentToken && this.agentId && !this.authorityBinding)
      this.authorityBinding = this.authorityBroker.bind(
        this.agentId,
        this.agentToken,
      );
    return this.sessionId;
  }

  async send(parts: OpenCodePromptPart[], sink: EventSink): Promise<void> {
    if (this.systemPrompt === undefined) {
      sink({
        kind: "turn_completed",
        status: "failed",
        error: "OpenCode cannot send a turn without an Isomux system prompt.",
      });
      return;
    }
    const sessionId = await this.initialize(sink);
    await this.lease!.beginTurn();
    try {
      const turnHandle = this.authorityBinding?.activate(this.lease!.pid);
      this.activeTurn = true;
      this.abortRequested = false;
      this.abortController = new AbortController();
      await this.consumeEvents(sessionId, sink, this.abortController.signal);
      const [providerID, modelID] = splitModel(this.model);
      await this.request(
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: "POST",
          body: JSON.stringify({
            model: { providerID, modelID },
            ...(this.agent ? { agent: this.agent } : {}),
            system: turnHandle
              ? this.systemPrompt.replaceAll(
                  OPENCODE_TURN_HANDLE_PLACEHOLDER,
                  turnHandle,
                )
              : this.systemPrompt,
            parts,
          }),
        },
      );
      this.contractShapeSink?.("http:prompt_async:success");
    } catch (error) {
      this.abortController?.abort();
      this.activeTurn = false;
      this.authorityBinding?.deactivate();
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
      throw new Error("OpenCode supports Allow once and Deny.");
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
    this.authorityBinding?.deactivate();
    this.authorityBinding?.unbind();
    this.authorityBinding = null;
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
    const tools = new Map<string, TrackedTool>();
    const seenPermissions = new Set<string>();
    const safetyWarningState = { shown: false };
    let stepFinish: { usage?: TokenUsage; cost?: number } | null = null;
    let settled = false;
    const settle = (event: NormalizedEvent): void => {
      if (settled) return;
      settled = true;
      this.activeTurn = false;
      this.pendingPermission = null;
      this.authorityBinding?.deactivate();
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
                  input: event.input,
                  callEmitted: false,
                  terminal: false,
                });
              }
              const tracked = tools.get(event.partId);
              if (tracked)
                for (const normalized of toolUpdateEvents(tracked, event))
                  sink(normalized);
            }
            if (event.kind === "permission") {
              if (seenPermissions.has(event.id)) continue;
              seenPermissions.add(event.id);
              const handled = await handleOpenCodePermission(event, {
                cwd: this.cwd,
                autoApprove: !!this.agent,
                warningState: safetyWarningState,
                reply: (reply, message) =>
                  this.replyPermission(event.id, reply, message),
                sink,
              });
              if (handled === "answered") continue;
              const permissionName =
                typeof event.permission === "string"
                  ? event.permission
                  : "unknown tool";
              const displayPatterns = Array.isArray(event.patterns)
                ? event.patterns.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              this.pendingPermission = {
                id: event.id,
                sessionId: event.sessionId,
              };
              sink({
                kind: "approval_request",
                approvalId: event.id,
                toolName: permissionName,
                input: displayPatterns.length
                  ? { patterns: displayPatterns }
                  : {},
                title: `OpenCode wants to use ${permissionName}`,
              });
            }
            if (event.kind === "permission_fault") {
              sink({
                kind: "system_text",
                text: OPENCODE_PERMISSION_ID_WARNING,
                isomuxAuthored: true,
              });
              settle({
                kind: "turn_completed",
                status: "failed",
                error: OPENCODE_PERMISSION_ID_WARNING,
              });
              return;
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
              this.authorityBinding?.deactivate();
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
    message?: string,
  ): Promise<void> {
    await this.request(`/permission/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
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
  const connectById = new Map<string, DiscoveredOpenCodeModel>();
  if (!Array.isArray(body.all)) return [];
  for (const rawProvider of body.all) {
    const provider = asRecord(rawProvider);
    const providerId = stringField(provider, "id");
    if (!providerId || !safeCatalogId(providerId)) continue;
    const providerLabel = safeCatalogLabel(provider.name, providerId);
    const models = asRecord(provider.models);
    if (!connected.has(providerId)) {
      if (
        !OPENCODE_MANUAL_API_KEY_PROVIDERS.includes(
          providerId as (typeof OPENCODE_MANUAL_API_KEY_PROVIDERS)[number],
        )
      )
        continue;
      const picked = pickConnectModel(providerId, models, body.default);
      if (picked) {
        connectById.set(picked, {
          id: picked,
          label: providerLabel,
          requiresConnection: true,
        });
      }
      continue;
    }
    for (const [rawModelId, rawModel] of Object.entries(models)) {
      if (!rawModelId) continue;
      const modelId = rawModelId.startsWith(`${providerId}/`)
        ? rawModelId.slice(providerId.length + 1)
        : rawModelId;
      if (!modelId || !safeCatalogId(modelId)) continue;
      const id = `${providerId}/${modelId}`;
      const model = asRecord(rawModel);
      const modelLabel = safeCatalogLabel(model.name, modelId);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          label: `${providerLabel} - ${modelLabel}`,
          ...(openCodeModelIsFree(model.cost) ? { isFree: true } : {}),
        });
      }
    }
  }
  const compare = (
    left: DiscoveredOpenCodeModel,
    right: DiscoveredOpenCodeModel,
  ) => {
    if (left.label !== right.label) return left.label < right.label ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  };
  return [
    ...[...byId.values()].sort(compare),
    ...[...connectById.values()].sort(compare),
  ];
}

function pickConnectModel(
  providerId: string,
  models: Record<string, unknown>,
  rawDefaults: unknown,
): string | null {
  const defaults = asRecord(rawDefaults);
  const defaultId = stringField(defaults, providerId);
  if (!defaultId || !safeCatalogId(defaultId)) return null;
  if (!(defaultId in models) && !(`${providerId}/${defaultId}` in models))
    return null;
  return `${providerId}/${defaultId}`;
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
      permission: unknown;
      patterns: unknown;
      metadata: unknown;
    }
  | { kind: "permission_fault"; sessionId: string }
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
    if (!id) return { kind: "permission_fault", sessionId };
    return {
      kind: "permission",
      sessionId,
      id,
      permission: properties.permission,
      patterns: properties.patterns,
      metadata: properties.metadata,
    } satisfies OpenCodePermissionEnvelope & { kind: "permission" };
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
