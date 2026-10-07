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
import { OpenCodeUnsupportedHostError } from "./runtime.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import {
  evaluateOpenCodePermission,
  type OpenCodePermissionEnvelope,
} from "./safety-adapter.ts";
import type { evaluateProposedAction } from "../../safety-policy.ts";
import {
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../../shared/types.ts";

export const OPENCODE_PERMISSION_ID_WARNING =
  "Isomux stopped this turn: OpenCode asked to use a tool but sent no id " +
  "with the request, so Isomux had no way to answer it. Tell the office " +
  "owner and check the isomux service logs.";

export const OPENCODE_AUTH_FAILURE =
  "OpenCode authentication is not configured.";

export const OPENCODE_SERVER_STOPPED_FAILURE =
  "The OpenCode server stopped during this turn. Send your message again.";

export const OPENCODE_SERVER_UNRESPONSIVE_FAILURE =
  "The OpenCode server stopped responding during this turn. Send your message again.";

// OpenCode 1.18.23 sends server.heartbeat on /event every 10 s, also during a
// silent 90 s tool call and a 90 s wait for the first model token (largest
// gap 10.3 s, measured 2026-10-07). 30 s is three missed heartbeats. The same
// bound covers the requests a turn makes before its stream reads: with 8
// sessions on one server, /event headers took at most 0.5 s, POST /session
// 1.7 s and /provider 12.8 s (2026-10-07).
export const OPENCODE_EVENT_STREAM_DEADLINE_MS = 30_000;

// A turn stops waiting for the catalog at the deadline above, but the load
// goes on so a late success is kept. This bound only frees the slot of a
// load that never answers, so a later caller can try again.
export const OPENCODE_CATALOG_LOAD_LIMIT_MS = 5 * 60_000;

export interface OpenCodeDeadlineScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const realDeadlineScheduler: OpenCodeDeadlineScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// A failure whose message is already member-facing copy.
class OpenCodeTurnFailure extends Error {}

export function openCodeModelUnavailableFailure(model: string): string {
  return `OpenCode cannot use model \`${model}\`: the provider refused this model. Pick another model with \`/model\`.`;
}

export const OPENCODE_EFFORT_CATALOG_UNAVAILABLE =
  "OpenCode did not return its model list, so this turn runs at the model's default effort.";

export function openCodeEffortUnavailableNotice(
  model: string,
  effort: string,
): string {
  return `\`${model}\` has no \`${effort}\` effort, so this turn runs at its default effort. Pick an effort in the agent settings.`;
}

export function openCodeModelNotFoundPrefix(model: string): string {
  return `Model not found: ${model}. Did you mean:`;
}

export interface DiscoveredOpenCodeModel {
  id: string;
  label: string;
  contextLimit?: number;
  isFree?: boolean;
  supportedEfforts: { level: EffortLevel }[];
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

// One catalog per OpenCode server process and directory (/provider takes the
// directory, and a project opencode.json can add models). A running server
// does not reload its model registry, and every change to the model list
// replaces the server (internal-docs/opencode-oc1-scope.md), so the server
// key is the invalidation. Callers share one load; only a success is kept.
const keptCatalogs = new WeakMap<
  OpenCodeSupervisor,
  {
    serverKey: string;
    byCwd: Map<string, Promise<DiscoveredOpenCodeModel[]>>;
  }
>();

function keptCatalog(
  supervisor: OpenCodeSupervisor,
  lease: OpenCodeLease,
  cwd: string,
  scheduler: OpenCodeDeadlineScheduler = realDeadlineScheduler,
): Promise<DiscoveredOpenCodeModel[]> {
  const serverKey = lease.serverKey;
  let kept = keptCatalogs.get(supervisor);
  if (!kept || kept.serverKey !== serverKey) {
    kept = { serverKey, byCwd: new Map() };
    keptCatalogs.set(supervisor, kept);
  }
  const byCwd = kept.byCwd;
  const existing = byCwd.get(cwd);
  if (existing) return existing;
  const load = loadCatalog(lease, cwd, scheduler);
  byCwd.set(cwd, load);
  load.catch(() => {
    if (byCwd.get(cwd) === load) byCwd.delete(cwd);
  });
  return load;
}

async function loadCatalog(
  lease: OpenCodeLease,
  cwd: string,
  scheduler: OpenCodeDeadlineScheduler,
): Promise<DiscoveredOpenCodeModel[]> {
  const controller = new AbortController();
  const timer = scheduler.setTimeout(
    () => controller.abort(),
    OPENCODE_CATALOG_LOAD_LIMIT_MS,
  );
  try {
    // The /provider body echoes provider API keys in cleartext (measured
    // 2026-09-02 with OPENCODE_API_KEY set: the key appears twice). Reduce it
    // to scalars right here and never log, store or forward the raw body.
    const url = new URL("/provider", lease.baseUrl);
    url.searchParams.set("directory", cwd);
    const response = await fetch(url, {
      headers: { authorization: lease.authHeader },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode HTTP ${response.status} at /provider.`);
    }
    return allowDiscoveredModels(await response.json());
  } finally {
    scheduler.clearTimeout(timer);
  }
}

export async function discoverOpenCodeModels(
  supervisor: OpenCodeSupervisor,
  cwd: string,
): Promise<DiscoveredOpenCodeModel[]> {
  const lease = await supervisor.acquire();
  try {
    return await keptCatalog(supervisor, lease, cwd);
  } finally {
    lease.release();
  }
}

export interface OpenCodeTransportOptions {
  cwd: string;
  model: string;
  effort?: string;
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
  completedStepSink?: (breakdown: OpenCodeContextBreakdown) => void;
  eventStreamDeadlineMs?: number;
  deadlineScheduler?: OpenCodeDeadlineScheduler;
}

export interface OpenCodeContextBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
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
  private readonly effort: string;
  private readonly systemPrompt: string | undefined;
  private readonly agentToken: string | undefined;
  private readonly agentId: string | undefined;
  private readonly authorityBroker: OpenCodeAuthorityBroker;
  private readonly agent: string | undefined;
  private readonly resumedSessionId?: string;
  private readonly contractShapeSink?: (shape: string) => void;
  private readonly safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void;
  private readonly completedStepSink?: (
    breakdown: OpenCodeContextBreakdown,
  ) => void;
  private readonly eventStreamDeadlineMs: number;
  private readonly deadlineScheduler: OpenCodeDeadlineScheduler;
  private lease: OpenCodeLease | null = null;
  private prefetchedCatalog: {
    serverKey: string;
    load: Promise<DiscoveredOpenCodeModel[]>;
  } | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private activeTurn = false;
  private abortRequested = false;
  // Set when this turn's prompt request starts; a later missed stream
  // deadline then replaces the server even while other turns run on it.
  private promptSent = false;
  // Open permission requests: request id -> OpenCode session id. OpenCode
  // runs the tool calls of one step in parallel, and each can ask at once.
  private pendingPermissions = new Map<string, string>();
  // The open turn's sink, so a request that OpenCode closes outside a member
  // answer can be withdrawn from the orchestrator.
  private turnSink: EventSink | null = null;
  private closed = false;
  private authorityBinding: OpenCodeAuthorityBinding | null = null;

  constructor(options: OpenCodeTransportOptions) {
    this.supervisor = options.supervisor ?? openCodeSupervisor;
    this.cwd = options.cwd;
    this.model = options.model;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.agentToken = options.agentToken;
    this.agentId = options.agentId;
    this.authorityBroker = options.authorityBroker ?? openCodeAuthorityBroker;
    if (this.agentToken && this.agentId) {
      this.authorityBinding = this.authorityBroker.bind(
        this.agentId,
        this.agentToken,
      );
    }
    this.systemPrompt = this.authorityBinding
      ? options.systemPrompt?.replaceAll(
          OPENCODE_TURN_HANDLE_PLACEHOLDER,
          this.authorityBinding.handle,
        )
      : options.systemPrompt;
    this.agent = options.agent;
    this.resumedSessionId = options.sessionId;
    this.contractShapeSink = options.contractShapeSink;
    this.safeErrorSink = options.safeErrorSink;
    this.completedStepSink = options.completedStepSink;
    this.eventStreamDeadlineMs =
      options.eventStreamDeadlineMs ?? OPENCODE_EVENT_STREAM_DEADLINE_MS;
    this.deadlineScheduler = options.deadlineScheduler ?? realDeadlineScheduler;
  }

  async getModelContextLimit(): Promise<number | null> {
    await this.initialize(() => undefined);
    const models = await this.catalog().catch(() => []);
    return (
      models.find((model) => model.id === this.model)?.contextLimit ?? null
    );
  }

  modelId(): string {
    return this.model;
  }

  private catalog(): Promise<DiscoveredOpenCodeModel[]> {
    if (!this.lease)
      return Promise.reject(
        new Error("OpenCode transport is not initialized."),
      );
    return keptCatalog(
      this.supervisor,
      this.lease,
      this.cwd,
      this.deadlineScheduler,
    );
  }

  // The variant for the chosen effort on the server that receives the
  // prompt, or the notice that this turn runs at the model's default effort.
  private async resolveEffort(): Promise<{
    variant?: EffortLevel;
    notice?: string;
  }> {
    const lease = this.lease!;
    for (;;) {
      const serverKey = lease.serverKey;
      // A turn makes one catalog request at most: a failed prefetch for this
      // server is the answer, not a reason to load again.
      const prefetch = this.prefetchedCatalog;
      this.prefetchedCatalog = null;
      const resolved = await this.effortFrom(
        prefetch && prefetch.serverKey === serverKey
          ? prefetch.load
          : this.catalog(),
      );
      if (lease.serverKey === serverKey) return resolved;
    }
  }

  private async effortFrom(
    catalog: Promise<DiscoveredOpenCodeModel[]>,
  ): Promise<{ variant?: EffortLevel; notice?: string }> {
    let models: DiscoveredOpenCodeModel[];
    try {
      models = await this.withinCatalogWait(catalog);
    } catch {
      return { notice: OPENCODE_EFFORT_CATALOG_UNAVAILABLE };
    }
    const levels: string[] =
      models
        .find((model) => model.id === this.model)
        ?.supportedEfforts.map((option) => option.level) ?? [];
    if (levels.includes(this.effort))
      return { variant: this.effort as EffortLevel };
    // A model without variants has no effort to honor (the dialogs hide the
    // field), and a model missing from the catalog fails at the prompt.
    if (levels.length === 0) return {};
    return { notice: openCodeEffortUnavailableNotice(this.model, this.effort) };
  }

  async initialize(sink: EventSink, withinTurn = false): Promise<string> {
    if (this.sessionId) return this.sessionId;
    this.lease = await this.supervisor.acquire();
    // A turn-sending transport loads the catalog alongside POST /session.
    if (this.systemPrompt !== undefined) {
      const load = this.catalog();
      load.catch(() => {});
      this.prefetchedCatalog = { serverKey: this.lease.serverKey, load };
    }
    if (this.resumedSessionId) {
      this.sessionId = this.resumedSessionId;
    } else {
      const init = {
        method: "POST",
        body: JSON.stringify({ title: "Isomux OpenCode session" }),
      };
      const body = allowSession(
        withinTurn
          ? await this.withinDeadline((signal) =>
              this.request("/session", { ...init, signal }).then((r) =>
                r.json(),
              ),
            )
          : await this.request("/session", init).then((r) => r.json()),
      );
      this.contractShapeSink?.("http:session:{id:string}");
      this.sessionId = body.id;
    }
    sink({ kind: "system_init", sessionId: this.sessionId, model: this.model });
    return this.sessionId;
  }

  async send(parts: OpenCodePromptPart[], sink: EventSink): Promise<void> {
    let settled = false;
    let turnStarted = false;
    let controller: AbortController | undefined;
    const emit: EventSink = (event) => {
      if (event.kind === "turn_completed") {
        if (settled) return;
        settled = true;
        this.activeTurn = false;
        // A request still open when the turn ends can never be answered.
        for (const id of this.pendingPermissions.keys())
          sink({ kind: "approval_withdrawn", approvalId: id });
        this.pendingPermissions.clear();
        this.turnSink = null;
        this.authorityBinding?.deactivate();
        if (turnStarted) this.lease?.endTurn();
        controller?.abort();
      }
      sink(event);
    };
    this.turnSink = emit;
    const fail = (error: unknown, context: string): void => {
      // Late failures after settlement or intentional close are deliberately silent.
      if (settled || this.closed) return;
      const safeError = allowTransportError(
        error instanceof OpenCodeTurnFailure ? error.cause : error,
      );
      // Observability must not stop delivery of the failed completion.
      try {
        this.safeErrorSink?.(safeError);
      } catch {
        console.error("OpenCode error sink failed.");
      } finally {
        emit({
          kind: "turn_completed",
          status: "failed",
          error:
            error instanceof OpenCodeUnsupportedHostError ||
            error instanceof OpenCodeTurnFailure
              ? error.message
              : `${context} (${safeError.name}${safeError.code ? `/${safeError.code}` : ""}; HTTP status: ${safeError.statusCode ?? "unavailable"}).`,
        });
      }
    };
    if (this.systemPrompt === undefined) {
      fail(
        new Error(),
        "OpenCode cannot send a turn without an Isomux system prompt",
      );
      return;
    }
    if (this.systemPrompt.includes(OPENCODE_TURN_HANDLE_PLACEHOLDER)) {
      fail(
        new Error(),
        "OpenCode cannot send office instructions without an authority binding",
      );
      return;
    }
    try {
      const sessionId = await this.initialize(emit, true);
      await this.lease!.beginTurn();
      turnStarted = true;
      this.authorityBinding?.activate(this.lease!.pid);
      this.activeTurn = true;
      this.abortRequested = false;
      this.promptSent = false;
      controller = new AbortController();
      this.abortController = controller;
      try {
        await this.consumeEvents(sessionId, emit, controller.signal, fail);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // No prompt is out yet, so recovery replays nothing. When the guard
        // keeps a live server another turn uses, a missed deadline fails the
        // turn in member words.
        try {
          await this.lease!.recoverBeforePrompt();
        } catch (recoveryError) {
          throw error instanceof OpenCodeTurnFailure ? error : recoveryError;
        }
        this.authorityBinding?.activate(this.lease!.pid);
        await this.consumeEvents(sessionId, emit, controller.signal, fail);
      }
      if (settled) return;
      // After beginTurn and recovery, which can each replace the server.
      const { variant, notice } = await this.resolveEffort();
      if (settled) return;
      // A stop during the catalog wait: no prompt is out, so none goes.
      if (this.abortRequested) {
        emit({ kind: "turn_completed", status: "interrupted" });
        return;
      }
      if (notice)
        emit({ kind: "system_text", text: notice, isomuxAuthored: true });
      const [providerID, modelID] = splitModel(this.model);
      this.promptSent = true;
      await this.request(
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            model: { providerID, modelID },
            ...(variant ? { variant } : {}),
            ...(this.agent ? { agent: this.agent } : {}),
            system: this.systemPrompt,
            parts,
          }),
        },
      );
      this.contractShapeSink?.("http:prompt_async:success");
    } catch (error) {
      fail(error, "OpenCode turn failed");
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
    const sessionId = this.pendingPermissions.get(approvalId);
    if (!sessionId || sessionId !== this.sessionId) return;
    if (decision.kind !== "allow_once" && decision.kind !== "deny") {
      throw new Error("OpenCode supports Allow once and Deny.");
    }
    // Out of the map while the reply is in flight, so an abort cannot answer
    // it a second time.
    this.pendingPermissions.delete(approvalId);
    try {
      await this.replyPermission(
        approvalId,
        decision.kind === "allow_once" ? "once" : "reject",
      );
    } catch (err) {
      // OpenCode did not take the answer, so the request is still open,
      // unless its turn ended meanwhile.
      if (this.activeTurn && this.sessionId === sessionId)
        this.pendingPermissions.set(approvalId, sessionId);
      throw err;
    }
    // Only after OpenCode took the reject: it closes every open request of
    // the session, so none of the others can be answered after it.
    if (decision.kind === "deny") this.forgetPermissions(sessionId);
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

  // OpenCode copies the messages before messageId; null copies them all.
  async forkAtMessage(messageId: string | null): Promise<string> {
    const sessionId = await this.initialize(() => undefined);
    const response = await this.request(
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(
          messageId === null ? {} : { messageID: messageId },
        ),
      },
    );
    const child = allowSession(await response.json()).id;
    this.contractShapeSink?.("http:fork:{id:string}");
    return child;
  }

  async deleteSession(): Promise<void> {
    const sessionId = await this.initialize(() => undefined);
    await this.request(`/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
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
    onFailure: (error: unknown, context: string) => void,
  ): Promise<void> {
    const lease = this.lease!;
    const serverPid = lease.pid;
    const response = await this.withinDeadline(
      (bounded) => this.request("/event", { signal: bounded }),
      { signal },
    );
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
      sink(event);
    };
    const fail = (error: unknown, context: string): void => {
      if (settled) return;
      settled = true;
      onFailure(error, context);
    };
    let buffer = "";
    let deadline: unknown;
    const armDeadline = (): void => {
      this.deadlineScheduler.clearTimeout(deadline);
      if (signal.aborted || settled) return;
      deadline = this.deadlineScheduler.setTimeout(() => {
        if (signal.aborted || settled) return;
        lease.markUnresponsive(serverPid, this.promptSent);
        fail(
          new OpenCodeTurnFailure(OPENCODE_SERVER_UNRESPONSIVE_FAILURE, {
            cause: new Error(),
          }),
          "",
        );
        void reader.cancel().catch(() => undefined);
      }, this.eventStreamDeadlineMs);
    };
    const streamFailure = (error: unknown): unknown =>
      lease.serverStopped(serverPid)
        ? new OpenCodeTurnFailure(OPENCODE_SERVER_STOPPED_FAILURE, {
            cause: error,
          })
        : error;
    // The pump reads the body on its own, so any frame resets the deadline,
    // also while the loop below awaits a permission reply.
    type Read = { value: Uint8Array | null } | { error: unknown };
    const pending: Read[] = [];
    let waiter: PromiseWithResolvers<Uint8Array | null> | null = null;
    const deliver = (read: Read): void => {
      const current = waiter;
      waiter = null;
      if (!current) pending.push(read);
      else if ("error" in read) current.reject(read.error);
      else current.resolve(read.value);
    };
    armDeadline();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armDeadline();
          deliver({ value });
        }
        deliver({ value: null });
      } catch (error) {
        deliver({ error });
      }
    })();
    const nextChunk = (): Promise<Uint8Array | null> => {
      waiter = Promise.withResolvers<Uint8Array | null>();
      const { promise } = waiter;
      const read = pending.shift();
      if (read) deliver(read);
      return promise;
    };
    void (async () => {
      try {
        while (!signal.aborted) {
          const value = await nextChunk();
          if (value === null) break;
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
              this.pendingPermissions.set(event.id, event.sessionId);
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
            if (event.kind === "step_finish") {
              stepFinish = { usage: event.usage, cost: event.cost };
              if (event.contextBreakdown)
                this.completedStepSink?.(event.contextBreakdown);
            }
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
                fail(
                  new Error(),
                  "OpenCode became idle without a recorded completion",
                );
              }
              return;
            }
            if (event.kind === "error") {
              if (this.abortRequested) continue;
              this.safeErrorSink?.(event.error);
              const failure = await this.classifyProviderFailure(event.error);
              settle({
                kind: "turn_completed",
                status: "failed",
                error:
                  failure === "model_unavailable"
                    ? openCodeModelUnavailableFailure(this.model)
                    : failure === "authentication"
                      ? OPENCODE_AUTH_FAILURE
                      : "OpenCode reported a provider or transport error.",
              });
              return;
            }
          }
        }
        if (!signal.aborted) {
          fail(
            streamFailure(new Error()),
            "OpenCode event stream ended before turn completion",
          );
        }
      } catch (error) {
        if (!signal.aborted) {
          fail(streamFailure(error), "OpenCode event stream failed");
        }
      } finally {
        this.deadlineScheduler.clearTimeout(deadline);
      }
    })();
    // The pump adds hops between a read and its handling. One event-loop turn
    // lets the loop settle what the stream already holds (an early failure)
    // before the caller submits the prompt.
    await new Promise<void>((resolve) => setImmediate(resolve));
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

  // One reject is enough: OpenCode rejects the other open requests of the
  // session with it.
  private async rejectPendingPermission(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const id = [...this.pendingPermissions].find(
      ([, owner]) => owner === sessionId,
    )?.[0];
    if (!id) return;
    this.forgetPermissions(sessionId);
    await this.replyPermission(id, "reject").catch(() => undefined);
  }

  private forgetPermissions(sessionId: string): void {
    for (const [id, owner] of this.pendingPermissions) {
      if (owner !== sessionId) continue;
      this.pendingPermissions.delete(id);
      this.turnSink?.({ kind: "approval_withdrawn", approvalId: id });
    }
  }

  // The turn stops waiting at the deadline; the shared load goes on. A slow
  // catalog is no sign of a frozen server, so the server is not marked.
  private async withinCatalogWait<T>(work: Promise<T>): Promise<T> {
    let timer: unknown;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = this.deadlineScheduler.setTimeout(
        () => reject(new Error("OpenCode catalog wait expired.")),
        this.eventStreamDeadlineMs,
      );
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      this.deadlineScheduler.clearTimeout(timer);
    }
  }

  // A request a turn makes before its stream reads. A frozen server accepts
  // the connection and never answers, so only this bound reaches the mark.
  // The bounded signal follows the turn's signal for the response lifetime.
  private async withinDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const lease = this.lease!;
    const serverPid = lease.pid;
    const bounded = new AbortController();
    if (options.signal?.aborted) bounded.abort();
    options.signal?.addEventListener("abort", () => bounded.abort(), {
      once: true,
    });
    let timedOut = false;
    const timer = this.deadlineScheduler.setTimeout(() => {
      timedOut = true;
      bounded.abort();
    }, this.eventStreamDeadlineMs);
    try {
      return await work(bounded.signal);
    } catch (error) {
      if (!timedOut) throw error;
      lease.markUnresponsive(serverPid, false);
      throw new OpenCodeTurnFailure(OPENCODE_SERVER_UNRESPONSIVE_FAILURE, {
        cause: error,
      });
    } finally {
      this.deadlineScheduler.clearTimeout(timer);
    }
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
      throw Object.assign(
        new Error(`OpenCode HTTP ${response.status} at ${path}.`),
        {
          statusCode: response.status,
        },
      );
    }
    return response;
  }

  private async classifyProviderFailure(
    error: SafeOpenCodeError,
  ): Promise<OpenCodeProviderFailure> {
    if (error.statusCode === 401 || error.statusCode === 403)
      return classifyOpenCodeError(error, this.model, []);
    if (
      error.name !== "UnknownError" ||
      !error.message?.startsWith(openCodeModelNotFoundPrefix(this.model))
    )
      return null;
    try {
      const response = await this.request("/provider");
      const connected = allowConnectedProviders(await response.json());
      return classifyOpenCodeError(error, this.model, connected);
    } catch {
      return null;
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
    if (!providerId || !safeCatalogId(providerId)) continue;
    if (!connected.has(providerId)) continue;
    const providerLabel = safeCatalogLabel(provider.name, providerId);
    const models = asRecord(provider.models);
    for (const [rawModelId, rawModel] of Object.entries(models)) {
      if (!rawModelId) continue;
      const modelId = rawModelId.startsWith(`${providerId}/`)
        ? rawModelId.slice(providerId.length + 1)
        : rawModelId;
      if (!modelId || !safeCatalogId(modelId)) continue;
      const id = `${providerId}/${modelId}`;
      const model = asRecord(rawModel);
      const modelLabel = safeCatalogLabel(model.name, modelId);
      const contextLimit = positiveNumber(asRecord(model.limit), "context");
      const variants = asRecord(model.variants);
      const supportedEfforts = EFFORT_LEVELS.filter(({ level }) =>
        Object.hasOwn(variants, level),
      ).map(({ level }) => ({ level }));
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          // The two house providers prefix every model; "OpenCode Zen - " or
          // "OpenCode Go - " on each row is noise - the picker groups
          // them as pay-as-you-go and subscription instead. Other providers
          // keep the prefix - it disambiguates same-named models across them.
          label:
            providerId === "opencode" || providerId === "opencode-go"
              ? modelLabel
              : `${providerLabel} - ${modelLabel}`,
          ...(contextLimit !== null ? { contextLimit } : {}),
          ...(openCodeModelIsFree(model.cost) ? { isFree: true } : {}),
          supportedEfforts,
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
  return [...byId.values()].sort(compare);
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
      contextBreakdown?: OpenCodeContextBreakdown;
      cost?: number;
    }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId: string; error: SafeOpenCodeError };

export interface SafeOpenCodeError {
  name?: string;
  code?: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
}

// Exception messages, paths, headers and arbitrary names can contain secrets.
// Project local failures onto reviewed class names and a valid HTTP status.
function allowTransportError(error: unknown): SafeOpenCodeError {
  const value = asRecord(error);
  const names = [
    "Error",
    "TypeError",
    "SyntaxError",
    "RangeError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "AggregateError",
    "AbortError",
    "TimeoutError",
  ];
  const name =
    typeof value.name === "string" && names.includes(value.name)
      ? value.name
      : "UnknownError";
  const status = value.statusCode ?? value.status;
  const codes = [
    "ConnectionRefused",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_STREAM_PREMATURE_CLOSE",
  ];
  return {
    name,
    ...(typeof value.code === "string"
      ? { code: codes.includes(value.code) ? value.code : "UnknownCode" }
      : {}),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { statusCode: status }
      : {}),
  };
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
      const reasoning = numberField(tokens, "reasoning");
      // Per-message total is the fullness signal. OpenCode's session table also
      // has cumulative tokens_input, tokens_output, and tokens_cache_read
      // columns (storage.ts): if a future release makes this total cumulative,
      // reading it through would pin every OpenCode battery at 100%.
      const total = numberField(tokens, "total");
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
      const contextBreakdown =
        total !== null &&
        total >= 0 &&
        input !== null &&
        output !== null &&
        reasoning !== null
          ? {
              totalTokens: total,
              inputTokens: input,
              outputTokens: output,
              reasoningTokens: reasoning,
              cacheReadInputTokens: numberField(cache, "read") ?? 0,
              cacheCreationInputTokens: numberField(cache, "write") ?? 0,
            }
          : undefined;
      return {
        kind: "step_finish",
        sessionId,
        ...(usage ? { usage } : {}),
        ...(contextBreakdown ? { contextBreakdown } : {}),
        ...(cost !== null ? { cost } : {}),
      };
    }
  }
  return null;
}

function positiveNumber(record: Record<string, unknown>, field: string) {
  const value = numberField(record, field);
  return value !== null && value > 0 ? value : null;
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

export type OpenCodeProviderFailure =
  | "authentication"
  | "model_unavailable"
  | null;

export function classifyOpenCodeError(
  error: SafeOpenCodeError,
  selectedModel: string,
  connectedProviders: string[],
): OpenCodeProviderFailure {
  if (error.statusCode === 403) return "model_unavailable";
  if (error.statusCode === 401) return "authentication";
  if (error.name !== "UnknownError" || !error.message) return null;
  const providerID = splitModel(selectedModel)[0];
  if (!error.message.startsWith(openCodeModelNotFoundPrefix(selectedModel)))
    return null;
  return connectedProviders.includes(providerID)
    ? "model_unavailable"
    : "authentication";
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
