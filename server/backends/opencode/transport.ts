import { createHash } from "node:crypto";
import {
  openCodeErrorMessage,
  openCodeProviderRefusal,
  openCodeRetryMessage,
} from "./errors.ts";
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
import { openCodeLogPath } from "./profile-paths.ts";
import { OpenCodeUnsupportedHostError } from "./runtime.ts";
import { OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS } from "./server-health.ts";
import { OPENCODE_SAFETY_TOOL } from "./safety-plugin-tool.ts";
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
import {
  translatorFor,
  type Translator,
} from "../../../shared/i18n/translate.ts";

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

export const OPENCODE_EVENT_STREAM_LOST_FAILURE =
  "OpenCode stopped sending updates for this turn. Send your message again.";

export const OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE =
  "OpenCode did not load the Isomux safety checks for this folder, so this turn did not run. Tell the office owner and check the isomux service logs.";

export const OPENCODE_FOLDER_SETUP_NOTICE =
  "OpenCode is installing plugins for this folder. The first turn can take a few minutes.";

export const OPENCODE_FOLDER_SETUP_FAILURE =
  "OpenCode did not finish setting up this folder in 3 minutes. Send your message again to keep waiting.";

// Before OpenCode loads a plugin it installs its plugin SDK into each config
// folder that lacks one: 50-83 s for a new project folder, measured
// 2026-10-15. A server that still answers health during that wait is setting
// up the folder, not frozen, so the turn waits up to this bound.
export const OPENCODE_FOLDER_SETUP_LIMIT_MS = 3 * 60_000;

// OpenCode 1.18.35 sends server.heartbeat on /event every 10 s. Local silent
// provider timeout and 35 s compaction controls measured gaps of 10.000-10.040 s
// on 2026-10-10. 30 s is three missed heartbeats. The same
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

// The folder setup bound passed on a server that answers health. The server
// is not marked: other agents' turns on it are fine, and a replacement would
// start the setup again.
class OpenCodeFolderSetupFailure extends OpenCodeTurnFailure {}

// The member stopped the turn before its prompt went out.
class OpenCodeTurnStopped extends Error {}

export type OpenCodeServerProbe =
  | "healthy"
  | "unhealthy"
  | "refused"
  | "silent";

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
  // The catalog's input and output limits, for the compaction point
  // (openCodeAutoCompactTokens). Server-internal, like the rest of this type.
  inputLimit?: number;
  outputLimit?: number;
  isFree?: boolean;
  supportedEfforts: { level: EffortLevel }[];
}

function openCodeModelIsFree(rawCost: unknown): boolean {
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
  safeErrorSink?: OpenCodeSafeErrorSink;
  streamSilenceSink?: OpenCodeStreamSilenceSink;
  completedStepSink?: (breakdown: OpenCodeContextBreakdown) => void;
  eventStreamDeadlineMs?: number;
  // Translates the notices the transport writes into the chat; English when
  // absent.
  words?: Translator["t"];
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
  private readonly safeErrorSink?: OpenCodeSafeErrorSink;
  private readonly streamSilenceSink?: OpenCodeStreamSilenceSink;
  private readonly words: Translator["t"];
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
  private initializing: Promise<{
    sessionId: string;
    settle: () => void;
  }> | null = null;
  private abortController: AbortController | null = null;
  private activeTurn = false;
  private abortRequested = false;
  private stopPreStreamWait: (() => void) | null = null;
  private folderSetupNoticeShown = false;
  // Set when this turn's prompt request starts. A later mark for a server
  // that stopped answering replaces it even while other turns run on it.
  private promptSent = false;
  private promptSentAt = 0;
  // Open permission requests: request id -> OpenCode session id. OpenCode
  // runs the tool calls of one step in parallel, and each can ask at once.
  private pendingPermissions = new Map<string, string>();
  // The open turn's subagent sessions, nested ones included.
  private subagentSessions = new Set<string>();
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
    this.streamSilenceSink = options.streamSilenceSink;
    this.words = options.words ?? translatorFor("en").t;
    this.completedStepSink = options.completedStepSink;
    this.eventStreamDeadlineMs =
      options.eventStreamDeadlineMs ?? OPENCODE_EVENT_STREAM_DEADLINE_MS;
    this.deadlineScheduler = options.deadlineScheduler ?? realDeadlineScheduler;
  }

  async getModelContextLimit(): Promise<number | null> {
    return (await this.getModelLimits())?.context ?? null;
  }

  // The chosen model's limits from the kept catalog, or null when the
  // catalog gives it no context limit.
  async getModelLimits(): Promise<{
    context: number;
    input?: number;
    output?: number;
  } | null> {
    const models = await this.outsideTurn(() => this.catalog().catch(() => []));
    const model = models.find((entry) => entry.id === this.model);
    if (model?.contextLimit === undefined) return null;
    return {
      context: model.contextLimit,
      ...(model.inputLimit !== undefined ? { input: model.inputLimit } : {}),
      ...(model.outputLimit !== undefined ? { output: model.outputLimit } : {}),
    };
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

  // One initialization at a time, so one lease. The caller whose initialize
  // acquires owns the hold that acquire takes and ends it with the settle it
  // gets back. A caller that waited for another one's initialization runs as
  // on an initialized transport: no hold outside a turn, and a turn takes its
  // own at beginTurn. A failed initialization ends its own hold.
  private async initialize(
    sink: EventSink,
    withinTurn = false,
    onStep?: (step: OpenCodeTurnStep) => void,
  ): Promise<{ sessionId: string; settle: () => void }> {
    if (this.sessionId) return { sessionId: this.sessionId, settle: () => {} };
    onStep?.("acquire");
    while (this.initializing) {
      await this.initializing.catch(() => {});
      if (this.sessionId) {
        sink({
          kind: "system_init",
          sessionId: this.sessionId,
          model: this.model,
        });
        return { sessionId: this.sessionId, settle: () => {} };
      }
    }
    if (this.closed) throw new Error("OpenCode transport is closed.");
    const run = (async () => {
      try {
        return await this.openSession(sink, withinTurn, onStep);
      } finally {
        this.initializing = null;
      }
    })();
    this.initializing = run;
    return run;
  }

  private async openSession(
    sink: EventSink,
    withinTurn: boolean,
    onStep?: (step: OpenCodeTurnStep) => void,
  ): Promise<{ sessionId: string; settle: () => void }> {
    const lease = await this.supervisor.acquire();
    // close() ran during the acquire and had no lease to release.
    if (this.closed) {
      lease.release();
      throw new Error("OpenCode transport is closed.");
    }
    // An initialization that failed after its acquire left its lease.
    this.lease?.release();
    this.lease = lease;
    const settle = () => lease.settle();
    try {
      // A turn-sending transport loads the catalog alongside POST /session.
      if (this.systemPrompt !== undefined) {
        const load = this.catalog();
        load.catch(() => {});
        this.prefetchedCatalog = { serverKey: lease.serverKey, load };
      }
      let sessionId: string;
      if (this.resumedSessionId) {
        sessionId = this.resumedSessionId;
      } else {
        onStep?.("session");
        const init = {
          method: "POST",
          body: JSON.stringify({ title: "Isomux OpenCode session" }),
        };
        const body = allowSession(
          withinTurn
            ? await this.withinDeadline(
                (signal) =>
                  this.request("/session", { ...init, signal }).then((r) =>
                    r.json(),
                  ),
                { notice: sink },
              )
            : await this.request("/session", init).then((r) => r.json()),
        );
        this.contractShapeSink?.("http:session:{id:string}");
        sessionId = body.id;
      }
      this.sessionId = sessionId;
      sink({ kind: "system_init", sessionId, model: this.model });
      return { sessionId, settle };
    } catch (error) {
      settle();
      throw error;
    }
  }

  async send(parts: OpenCodePromptPart[], sink: EventSink): Promise<void> {
    const billedSteps = new Map<
      string,
      { usage?: TokenUsage; cost?: number }
    >();
    let settled = false;
    let turnStarted = false;
    let controller: AbortController | undefined;
    // The step a failure happened in, for the journal.
    let step: OpenCodeTurnStep | undefined;
    const emit: EventSink = (event) => {
      if (event.kind === "turn_completed") {
        if (settled) return;
        settled = true;
        // OpenCode emits per-step charges, including compaction. A repeated
        // part update replaces its snapshot; it must not charge the turn twice.
        let usage: TokenUsage | undefined;
        let cost: number | undefined;
        for (const step of billedSteps.values()) {
          if (step.usage) {
            usage ??= {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            };
            usage.inputTokens += step.usage.inputTokens;
            usage.outputTokens += step.usage.outputTokens;
            usage.cacheReadInputTokens += step.usage.cacheReadInputTokens;
            usage.cacheCreationInputTokens +=
              step.usage.cacheCreationInputTokens;
          }
          if (step.cost !== undefined) cost = (cost ?? 0) + step.cost;
        }
        event = {
          ...event,
          ...(usage ? { usage } : {}),
          ...(cost !== undefined ? { cost } : {}),
          ...(usage || cost !== undefined
            ? {
                costMode: "turn" as const,
                usageId: createHash("sha256")
                  .update(
                    JSON.stringify([
                      this.sessionId,
                      [...billedSteps.keys()].sort(),
                    ]),
                  )
                  .digest("hex"),
              }
            : {}),
        };
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
    const fail = (error: unknown, context: string, at = step): void => {
      // Late failures after settlement or intentional close are deliberately silent.
      if (settled || this.closed) return;
      const safeError = allowTransportError(
        error instanceof OpenCodeTurnFailure ? error.cause : error,
      );
      const failure =
        error instanceof OpenCodeUnsupportedHostError ||
        error instanceof OpenCodeTurnFailure
          ? error.message
          : `${context} (${safeError.name}${safeError.code ? `/${safeError.code}` : ""}; HTTP status: ${safeError.statusCode ?? "unavailable"}).`;
      // Observability must not stop delivery of the failed completion.
      try {
        this.safeErrorSink?.(safeError, this.errorContext(failure, at));
      } catch {
        console.error("OpenCode error sink failed.");
      } finally {
        emit({ kind: "turn_completed", status: "failed", error: failure });
      }
    };
    // The event stream reports its own failures, whatever step the turn is in.
    const failInStream = (error: unknown, context: string): void =>
      fail(error, context, "event_stream");
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
    this.folderSetupNoticeShown = false;
    let settleAcquire = () => {};
    try {
      const { sessionId, settle } = await this.initialize(
        emit,
        true,
        (next) => {
          step = next;
        },
      );
      settleAcquire = settle;
      step = "begin_turn";
      await this.lease!.beginTurn();
      turnStarted = true;
      // A saved setting's server replacement waits for this turn, so the
      // turn runs on the previous settings (task d4a7031e).
      if (this.lease!.replacementPending)
        emit({
          kind: "system_text",
          text: this.words("systemEntries.openCodePreviousSettings"),
          isomuxAuthored: true,
        });
      this.authorityBinding?.activate(this.lease!.pid);
      this.activeTurn = true;
      this.abortRequested = false;
      this.promptSent = false;
      controller = new AbortController();
      this.abortController = controller;
      step = "event_stream";
      try {
        await this.consumeEvents(
          sessionId,
          emit,
          controller.signal,
          failInStream,
          billedSteps,
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          error instanceof OpenCodeTurnStopped ||
          error instanceof OpenCodeFolderSetupFailure
        )
          throw error;
        // No prompt is out yet, so recovery replays nothing. When the guard
        // keeps a live server another turn uses, a missed deadline fails the
        // turn in member words.
        step = "recovery";
        try {
          await this.lease!.recoverBeforePrompt();
        } catch (recoveryError) {
          throw error instanceof OpenCodeTurnFailure ? error : recoveryError;
        }
        this.authorityBinding?.activate(this.lease!.pid);
        step = "event_stream";
        await this.consumeEvents(
          sessionId,
          emit,
          controller.signal,
          failInStream,
          billedSteps,
        );
      }
      if (settled) return;
      step = "safety_plugin";
      await this.requireSafetyPlugin(controller.signal, emit);
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
      step = "prompt";
      const [providerID, modelID] = splitModel(this.model);
      this.promptSent = true;
      this.promptSentAt = Date.now();
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
      if (error instanceof OpenCodeTurnStopped) {
        emit({ kind: "turn_completed", status: "interrupted" });
        return;
      }
      fail(error, "OpenCode turn failed");
    } finally {
      // A turn that ended before beginTurn, even a silent one after close(),
      // still holds its acquire; after beginTurn this is a no-op.
      settleAcquire();
    }
  }

  async abort(): Promise<void> {
    // No prompt is out during a pre-stream wait, so OpenCode has nothing to
    // abort, and a request to this folder would wait on its setup too.
    if (this.stopPreStreamWait) {
      this.stopPreStreamWait();
      return;
    }
    if (!this.sessionId) return;
    this.abortRequested = true;
    await this.rejectPendingPermission();
    await this.request(`/session/${encodeURIComponent(this.sessionId)}/abort`, {
      method: "POST",
    }).catch(() => undefined);
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const sessionId = this.pendingPermissions.get(approvalId);
    if (!sessionId || !this.ownsSession(sessionId)) return;
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
      if (this.activeTurn && this.ownsSession(sessionId))
        this.pendingPermissions.set(approvalId, sessionId);
      throw err;
    }
    // Only after OpenCode took the reject: it closes every open request of
    // the session, so none of the others can be answered after it.
    if (decision.kind === "deny") this.forgetPermissions(sessionId);
  }

  async getSessionMessages(): Promise<NormalizedMessage[]> {
    return this.outsideTurn(async (sessionId) => {
      const response = await this.request(
        `/session/${encodeURIComponent(sessionId)}/message`,
      );
      const messages = allowMessages(await response.json());
      this.contractShapeSink?.("http:message:list");
      return messages;
    });
  }

  // OpenCode copies the messages before messageId; null copies them all.
  async forkAtMessage(messageId: string | null): Promise<string> {
    return this.outsideTurn(async (sessionId) => {
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
    });
  }

  async deleteSession(): Promise<void> {
    await this.outsideTurn(async (sessionId) => {
      await this.request(`/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    });
  }

  // Work outside a turn keeps the hold its acquire took until it ends, so a
  // pending server replacement waits for it. A transport that already has
  // its session took no new hold.
  private async outsideTurn<T>(
    work: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    const { sessionId, settle } = await this.initialize(() => undefined);
    try {
      return await work(sessionId);
    } finally {
      settle();
    }
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
    billedSteps: Map<string, { usage?: TokenUsage; cost?: number }>,
  ): Promise<void> {
    const lease = this.lease!;
    const serverPid = lease.pid;
    const response = await this.withinDeadline(
      (bounded) => this.request("/event", { signal: bounded }),
      { signal, notice: sink },
    );
    if (!response.body) throw new Error("OpenCode event stream has no body.");
    let reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    let decoder = new TextDecoder();
    const assistantMessages = new Set<string>();
    const summaryMessages = new Set<string>();
    const textByPart = new Map<string, string>();
    const reasoningByPart = new Map<string, string>();
    const tools = new Map<string, TrackedTool>();
    const seenPermissions = new Set<string>();
    const safetyWarningState = { shown: false };
    this.subagentSessions.clear();
    // What a silence report names: the turn's open answers, its running
    // tools, its permission names and its last frames.
    const openAnswers = new Set<string>();
    const runningTools = new Set<string>();
    const permissionNames = new Map<string, string>();
    let retryAttempt: number | undefined;
    let lastEvent: OpenCodeStreamFrame | undefined;
    let lastTurnEvent: OpenCodeStreamFrame | undefined;
    let hasCompletedStep = false;
    let overflowPending = false;
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
        silence = { report: silenceAtDeadline() };
        // A recovery that ended the turn wakes the loop below, which waits on
        // the stream it cancelled.
        void recover()
          .catch((error) => {
            reportSilence("error");
            fail(error, "OpenCode event stream recovery failed");
          })
          .finally(() => {
            reportSilence("ended");
            if (settled || signal.aborted) deliver({ value: null });
          });
      }, this.eventStreamDeadlineMs);
    };
    const streamFailure = async (error: unknown): Promise<unknown> =>
      (await this.serverGone(lease, serverPid))
        ? new OpenCodeTurnFailure(OPENCODE_SERVER_STOPPED_FAILURE, {
            cause: error,
          })
        : error;
    // The pump reads the body on its own, so any frame resets the deadline,
    // also while the loop below awaits a permission reply. A fresh read
    // starts a new connection: the loop drops the old one's partial frame.
    // at: when the pump read the chunk. A fresh read is a replay.
    type Read =
      | { value: Uint8Array | null; fresh?: true; at?: number }
      | { error: unknown };
    const pending: Read[] = [];
    let waiter: PromiseWithResolvers<Read> | null = null;
    const deliver = (read: Read): void => {
      const current = waiter;
      waiter = null;
      if (!current) pending.push(read);
      else if ("error" in read) current.reject(read.error);
      else current.resolve(read);
    };
    // A recovery moves the turn to a new connection. The silent one's pump
    // then stops delivering, so its late end or error does not fail the turn.
    let connection = 0;
    let connectionChunks = 0;
    const pump = (current: ReadableStreamDefaultReader<Uint8Array>): void => {
      const id = ++connection;
      connectionChunks = 0;
      reader = current;
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await current.read();
            if (id !== connection) return;
            if (done) break;
            connectionChunks++;
            armDeadline();
            deliver({ value, at: Date.now() });
          }
          deliver({ value: null });
        } catch (error) {
          if (id === connection) deliver({ error });
        }
      })();
    };
    // One journal line per silence: what the turn waited on at the deadline,
    // the health probe, and how the recovery ended. It is written before the
    // recovery's effects, so it comes before a failure's own line.
    let silence: {
      report: Omit<OpenCodeStreamSilence, "probe" | "outcome">;
      probe?: OpenCodeServerProbe;
    } | null = null;
    const reportSilence = (outcome: OpenCodeSilenceOutcome): void => {
      const current = silence;
      silence = null;
      if (!current) return;
      try {
        this.streamSilenceSink?.({
          ...current.report,
          ...(current.probe ? { probe: current.probe } : {}),
          outcome,
        });
      } catch {
        console.error("OpenCode stream silence sink failed.");
      }
    };
    const silenceAtDeadline = (): Omit<
      OpenCodeStreamSilence,
      "probe" | "outcome"
    > => {
      const permissions = [...this.pendingPermissions.keys()].map(
        (id) => permissionNames.get(id) ?? "unknown",
      );
      const running = [...runningTools].map((partId) =>
        safeJournalName(tools.get(partId)?.name),
      );
      const waitingOn: OpenCodeStreamSilence["waitingOn"] = !this.promptSent
        ? "prompt_not_sent"
        : permissions.length > 0
          ? "permission"
          : running.length > 0
            ? "tool"
            : lastTurnEvent?.type === "session.status:retry"
              ? "retry"
              : openAnswers.size > 0
                ? "model"
                : "none";
      const { openCodeLog } = this.errorContext();
      return {
        ...(this.agentId ? { agentId: this.agentId } : {}),
        sessionId,
        silence: recoveries + 1,
        deadlineAt: new Date().toISOString(),
        ...(lastEvent ? { lastEvent } : {}),
        ...(lastTurnEvent ? { lastTurnEvent } : {}),
        ...(this.promptSent
          ? { promptSentAt: new Date(this.promptSentAt).toISOString() }
          : {}),
        waitingOn,
        ...(running.length > 0 ? { tools: running } : {}),
        ...(permissions.length > 0 ? { permissions } : {}),
        ...(waitingOn === "retry" && retryAttempt !== undefined
          ? { retryAttempt }
          : {}),
        ...(this.subagentSessions.size > 0
          ? { subagents: this.subagentSessions.size }
          : {}),
        ...(openCodeLog ? { openCodeLog } : {}),
      };
    };
    // The server did not answer: it is marked, and the supervisor replaces it.
    const unresponsive = (): void => {
      reportSilence("marked");
      lease.markUnresponsive(serverPid, this.promptSent);
      fail(
        new OpenCodeTurnFailure(OPENCODE_SERVER_UNRESPONSIVE_FAILURE, {
          cause: new Error(),
        }),
        "",
      );
    };
    // The server answers, so only this turn fails. Its session is stopped so
    // that it does not run on unseen.
    const failAlone = (): void => {
      if (settled || signal.aborted) return;
      reportSilence("failed_alone");
      if (this.promptSent)
        void this.rejectPendingPermission()
          .then(() =>
            this.request(`/session/${encodeURIComponent(sessionId)}/abort`, {
              method: "POST",
            }),
          )
          .catch(() => undefined);
      fail(
        new OpenCodeTurnFailure(OPENCODE_EVENT_STREAM_LOST_FAILURE, {
          cause: new Error(),
        }),
        "",
      );
    };
    // A missed deadline is evidence about this stream, not about the shared
    // server, which other agents' turns use. Only a server that does not
    // answer is marked. Otherwise the turn moves to a new stream and catches
    // up on what the silent one missed, or fails alone.
    let recoveries = 0;
    const streamStartedAt = Date.now();
    const recover = async (): Promise<void> => {
      // The first stream may be recovered even when it got nothing after its
      // connect frame. A later one must have delivered a heartbeat or an
      // event, so a folder whose streams connect and go silent does not loop.
      const recoverable = recoveries++ === 0 || connectionChunks > 1;
      connection++;
      void reader.cancel().catch(() => undefined);
      const probe = await this.probeServer(lease);
      if (silence) silence.probe = probe;
      if (signal.aborted || settled) return;
      if (probe === "refused" || probe === "unhealthy") {
        unresponsive();
        return;
      }
      if (!recoverable) {
        failAlone();
        return;
      }
      // One bound for the requests below. The new stream subscribes first, so
      // nothing after the reads is lost.
      const bounded = new AbortController();
      signal.addEventListener("abort", () => bounded.abort(), { once: true });
      let expired = false;
      const timer = this.deadlineScheduler.setTimeout(() => {
        expired = true;
        bounded.abort();
      }, this.eventStreamDeadlineMs);
      const read = (path: string): Promise<unknown> =>
        this.request(path, { signal: bounded.signal }).then((r) => r.json());
      let next: Response;
      let status: unknown;
      let permissions: unknown;
      let messages: unknown;
      let promptSent = false;
      try {
        next = await this.request("/event", { signal: bounded.signal });
        // OpenCode registers the listener before it answers, so a prompt
        // sent after this point is seen on the new stream.
        promptSent = this.promptSent;
        [status, permissions, messages] = await Promise.all([
          read("/session/status"),
          read("/permission"),
          read(`/session/${encodeURIComponent(sessionId)}/message`),
          this.findSubagentSessions(streamStartedAt, read),
        ]);
      } catch {
        if (signal.aborted || settled) return;
        // A server that answered health is kept: its folder may be stuck
        // while other folders' turns run on it.
        if (expired && probe === "silent") unresponsive();
        else failAlone();
        return;
      } finally {
        this.deadlineScheduler.clearTimeout(timer);
      }
      if (signal.aborted || settled || !next.body) {
        void next.body?.cancel().catch(() => undefined);
        failAlone();
        return;
      }
      const missed = promptSent
        ? turnReplayFrames(sessionId, messages, this.promptSentAt)
        : { frames: [], finishedStep: false };
      const state = asRecord(asRecord(status)[sessionId]).type;
      if (promptSent && state !== "busy" && state !== "retry") {
        // The session went idle while its stream was silent. The loop below
        // settles the turn from what it missed.
        void next.body.cancel().catch(() => undefined);
        if (
          !this.abortRequested &&
          !hasCompletedStep &&
          !missed.finishedStep &&
          missed.error === undefined
        ) {
          failAlone();
          return;
        }
        reportSilence("completed");
        deliver({
          value: sseFrames([
            ...missed.frames,
            ...(missed.error === undefined
              ? []
              : [
                  {
                    type: "session.error",
                    properties: { sessionID: sessionId, error: missed.error },
                  },
                ]),
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
          fresh: true,
        });
        return;
      }
      // A permission asked while the stream was silent. The loop below drops
      // other sessions' requests and the ones it already handled.
      const asked = Array.isArray(permissions)
        ? (permissions as unknown[]).map((properties) => ({
            type: "permission.asked",
            properties,
          }))
        : [];
      reportSilence("recovered");
      deliver({ value: sseFrames([...missed.frames, ...asked]), fresh: true });
      pump(next.body.getReader());
      armDeadline();
    };
    armDeadline();
    pump(reader);
    const nextChunk = (): Promise<Read> => {
      waiter = Promise.withResolvers<Read>();
      const { promise } = waiter;
      const read = pending.shift();
      if (read) deliver(read);
      return promise;
    };
    void (async () => {
      try {
        while (!signal.aborted) {
          const read = await nextChunk();
          if (!("value" in read) || read.value === null) break;
          if (read.fresh) {
            buffer = "";
            decoder = new TextDecoder();
          }
          buffer =
            `${buffer}${decoder.decode(read.value, { stream: true })}`.replaceAll(
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
            const raw = parseFrame(data);
            if (!raw) continue;
            if (!read.fresh) {
              const seen = {
                type: frameLabel(raw),
                at: new Date(read.at ?? Date.now()).toISOString(),
              };
              lastEvent = seen;
              if (asRecord(raw.properties).sessionID === sessionId)
                lastTurnEvent = seen;
            }
            const event = allowedEvent(raw);
            if (!event) continue;
            if (event.kind === "session_created") {
              if (this.ownsSession(event.parentId))
                this.subagentSessions.add(event.sessionId);
              continue;
            }
            // A subagent reopened with task_id sends no session.created, and
            // after an edit and resend its parent is the session before the
            // fork. The task part of a session this turn owns names it.
            if (
              event.kind === "tool" &&
              event.subagentSessionId &&
              this.ownsSession(event.sessionId)
            )
              this.subagentSessions.add(event.subagentSessionId);
            // A subagent waits on its requests like the agent does, and
            // nothing else answers them. Its other events are its own.
            if (
              event.sessionId !== sessionId &&
              !(
                this.subagentSessions.has(event.sessionId) &&
                (event.kind === "permission" ||
                  event.kind === "permission_fault" ||
                  event.kind === "question")
              )
            )
              continue;
            this.contractShapeSink?.(`sse:${event.kind}`);
            if (event.kind === "assistant") {
              if (event.completed) openAnswers.delete(event.messageId);
              else openAnswers.add(event.messageId);
              if (event.summary) {
                summaryMessages.add(event.messageId);
                assistantMessages.delete(event.messageId);
              } else assistantMessages.add(event.messageId);
            }
            if (event.kind === "retry") {
              retryAttempt = event.attempt;
              sink({
                kind: "system_text",
                text: openCodeRetryMessage(
                  event.message,
                  event.attempt,
                  splitModel(this.model)[0],
                  this.words,
                ),
                isomuxAuthored: true,
              });
            }
            if (
              event.kind === "text" &&
              assistantMessages.has(event.messageId)
            ) {
              const prior = textByPart.get(event.partId) ?? "";
              // After a recovery, the new stream can deliver frames older
              // than the replay. A shorter copy of text already shown is one.
              if (
                event.text.length < prior.length &&
                prior.startsWith(event.text)
              )
                continue;
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
              if (
                event.text.length < prior.length &&
                prior.startsWith(event.text)
              )
                continue;
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
              if (event.status === "running") runningTools.add(event.partId);
              else runningTools.delete(event.partId);
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
              permissionNames.set(event.id, safeJournalName(permissionName));
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
              billedSteps.set(event.partId, {
                usage: event.usage,
                cost: event.cost,
              });
              if (!(event.messageId && summaryMessages.has(event.messageId))) {
                overflowPending = false;
                hasCompletedStep = true;
                if (event.contextBreakdown)
                  this.completedStepSink?.(event.contextBreakdown);
              }
            }
            if (event.kind === "idle") {
              if (this.abortRequested) {
                for (const result of interruptedToolResults(tools.values()))
                  sink(result);
                settle({ kind: "turn_completed", status: "interrupted" });
              } else if (overflowPending) {
                settle({
                  kind: "turn_completed",
                  status: "failed",
                  error: openCodeErrorMessage({ name: "ContextOverflowError" }),
                });
              } else if (hasCompletedStep) {
                settle({
                  kind: "turn_completed",
                  status: "completed",
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
              try {
                this.safeErrorSink?.(event.error, this.errorContext());
              } catch {
                /* Logging cannot end a turn. */
              }
              // OpenCode emits this before automatic compaction and replay.
              // Idle without a later answer is the terminal overflow case.
              if (event.error.name === "ContextOverflowError") {
                overflowPending = true;
                continue;
              }
              const refusal = openCodeProviderRefusal(
                event.error,
                splitModel(this.model)[0],
                this.words,
              );
              const failure =
                refusal === null
                  ? await this.classifyProviderFailure(event.error)
                  : null;
              settle({
                kind: "turn_completed",
                status: "failed",
                error:
                  refusal ??
                  (failure === "model_unavailable"
                    ? openCodeModelUnavailableFailure(this.model)
                    : failure === "authentication"
                      ? OPENCODE_AUTH_FAILURE
                      : openCodeErrorMessage(event.error)),
              });
              return;
            }
          }
        }
        if (!signal.aborted) {
          this.deadlineScheduler.clearTimeout(deadline);
          const failure = await streamFailure(new Error());
          if (!signal.aborted)
            fail(failure, "OpenCode event stream ended before turn completion");
        }
      } catch (error) {
        if (!signal.aborted) {
          this.deadlineScheduler.clearTimeout(deadline);
          const failure = await streamFailure(error);
          if (!signal.aborted) fail(failure, "OpenCode event stream failed");
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

  // The turn's subagent sessions that started while its stream was silent:
  // their session.created events were lost, so their permission requests
  // would be dropped as another session's.
  private async findSubagentSessions(
    since: number,
    read: (path: string) => Promise<unknown>,
  ): Promise<void> {
    const queue = [this.sessionId!, ...this.subagentSessions];
    for (let owner = queue.shift(); owner; owner = queue.shift()) {
      const children = await read(
        `/session/${encodeURIComponent(owner)}/children`,
      );
      if (!Array.isArray(children)) continue;
      for (const child of children.map(asRecord)) {
        const id = stringField(child, "id");
        const created = numberField(asRecord(child.time), "created");
        if (!id || this.subagentSessions.has(id)) continue;
        if (created !== null && created < since) continue;
        this.subagentSessions.add(id);
        queue.push(id);
      }
    }
  }

  // A killed server resets its streams before the kernel reaps its process,
  // so the process check alone can still find it running (task e68394c4). A
  // server that refuses a new connection has stopped too.
  private async serverGone(
    lease: OpenCodeLease,
    pid: number,
  ): Promise<boolean> {
    if (lease.serverStopped(pid)) return true;
    if ((await this.probeServer(lease)) === "refused") return true;
    return lease.serverStopped(pid);
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

  private errorContext(
    failure?: string,
    step?: OpenCodeTurnStep,
  ): OpenCodeErrorContext {
    // Before acquire returns a lease, the supervisor names the same profile.
    const profileDir = this.lease?.profileDir ?? this.supervisor.profileDir;
    return {
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...(failure ? { failure } : {}),
      ...(step ? { step } : {}),
      ...(profileDir ? { openCodeLog: openCodeLogPath(profileDir) } : {}),
    };
  }

  // The agent's session or one of the open turn's subagent sessions.
  private ownsSession(sessionId: string): boolean {
    return sessionId === this.sessionId || this.subagentSessions.has(sessionId);
  }

  // One reject per session is enough: OpenCode rejects the other open
  // requests of that session with it.
  private async rejectPendingPermission(): Promise<void> {
    const firstByOwner = new Map<string, string>();
    for (const [id, owner] of this.pendingPermissions)
      if (this.ownsSession(owner) && !firstByOwner.has(owner))
        firstByOwner.set(owner, id);
    await Promise.all(
      [...firstByOwner].map(([owner, id]) => {
        this.forgetPermissions(owner);
        return this.replyPermission(id, "reject").catch(() => undefined);
      }),
    );
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
  // At the bound, a server that answers health is setting up the folder: the
  // same request keeps waiting, up to the folder setup bound. The bounded
  // signal follows the turn's signal for the response lifetime.
  private async withinDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; notice?: EventSink } = {},
  ): Promise<T> {
    const lease = this.lease!;
    const serverPid = lease.pid;
    const bounded = new AbortController();
    if (options.signal?.aborted) bounded.abort();
    options.signal?.addEventListener("abort", () => bounded.abort(), {
      once: true,
    });
    let expired: "unresponsive" | "setup" | null = null;
    let stopped = false;
    let waiting = true;
    const stop = () => {
      stopped = true;
      bounded.abort();
    };
    this.stopPreStreamWait = stop;
    const expire = (reason: "unresponsive" | "setup") => {
      if (!waiting) return;
      expired = reason;
      bounded.abort();
    };
    let timer = this.deadlineScheduler.setTimeout(() => {
      void this.probeServer(lease)
        .then((probe) => {
          if (!waiting) return;
          if (probe !== "healthy") {
            expire("unresponsive");
            return;
          }
          if (!this.folderSetupNoticeShown) {
            this.folderSetupNoticeShown = true;
            try {
              options.notice?.({
                kind: "system_text",
                text: OPENCODE_FOLDER_SETUP_NOTICE,
                isomuxAuthored: true,
              });
            } catch {
              /* A notice cannot end the wait. */
            }
          }
          timer = this.deadlineScheduler.setTimeout(
            () => expire("setup"),
            OPENCODE_FOLDER_SETUP_LIMIT_MS - this.eventStreamDeadlineMs,
          );
        })
        // Not expected: the wait then ends as at a server that is not healthy.
        .catch(() => expire("unresponsive"));
    }, this.eventStreamDeadlineMs);
    try {
      const result = await work(bounded.signal);
      // A stop that landed after the answer and before this line.
      if (stopped) throw new OpenCodeTurnStopped();
      return result;
    } catch (error) {
      if (stopped) throw new OpenCodeTurnStopped();
      if (expired === "setup")
        throw new OpenCodeFolderSetupFailure(OPENCODE_FOLDER_SETUP_FAILURE, {
          cause: error,
        });
      if (expired !== "unresponsive") throw error;
      lease.markUnresponsive(serverPid, false);
      throw new OpenCodeTurnFailure(OPENCODE_SERVER_UNRESPONSIVE_FAILURE, {
        cause: error,
      });
    } finally {
      waiting = false;
      if (this.stopPreStreamWait === stop) this.stopPreStreamWait = null;
      this.deadlineScheduler.clearTimeout(timer);
    }
  }

  // OpenCode only logs a plugin that fails to load. A folder whose tools lack
  // the safety plugin's tool runs no prompt.
  private async requireSafetyPlugin(
    signal: AbortSignal,
    notice: EventSink,
  ): Promise<void> {
    const ids: unknown = await this.withinDeadline(
      (bounded) =>
        this.request("/experimental/tool/ids", { signal: bounded }).then((r) =>
          r.json(),
        ),
      { signal, notice },
    );
    if (!Array.isArray(ids) || !ids.includes(OPENCODE_SAFETY_TOOL))
      throw new OpenCodeTurnFailure(OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE);
  }

  // One health request, bounded by the adoption health timeout on the
  // deadline scheduler. "refused" is a failed connection: a killed server
  // closes its listener with its streams.
  private async probeServer(
    lease: OpenCodeLease,
  ): Promise<OpenCodeServerProbe> {
    const probe = new AbortController();
    const timer = this.deadlineScheduler.setTimeout(
      () => probe.abort(),
      OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(new URL("/global/health", lease.baseUrl), {
        headers: { authorization: lease.authHeader },
        signal: probe.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok ? "healthy" : "unhealthy";
    } catch {
      return probe.signal.aborted ? "silent" : "refused";
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

function sseFrames(events: object[]): Uint8Array {
  return new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

// The open turn's answers from GET /session/:id/message, as the frames the
// event stream sends for them: the assistant messages OpenCode created after
// the prompt went out. Earlier ones belong to earlier turns, and OpenCode may
// not have stored this turn's user message yet. error: the error of the
// turn's last answer, which the stream sends as session.error.
function turnReplayFrames(
  sessionId: string,
  raw: unknown,
  promptSentAt: number,
): { frames: object[]; finishedStep: boolean; error?: unknown } {
  const frames: object[] = [];
  let finishedStep = false;
  let error: unknown;
  for (const message of Array.isArray(raw) ? raw.map(asRecord) : []) {
    const info = asRecord(message.info);
    const created = numberField(asRecord(info.time), "created");
    if (info.role !== "assistant" || created === null || created < promptSentAt)
      continue;
    frames.push({
      type: "message.updated",
      properties: { sessionID: sessionId, info },
    });
    for (const part of Array.isArray(message.parts)
      ? (message.parts as unknown[])
      : []) {
      frames.push({
        type: "message.part.updated",
        properties: { sessionID: sessionId, part },
      });
      if (asRecord(part).type === "step-finish" && info.summary !== true)
        finishedStep = true;
    }
    error = info.error ?? undefined;
  }
  return { frames, finishedStep, ...(error === undefined ? {} : { error }) };
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
      const inputLimit = positiveNumber(asRecord(model.limit), "input");
      const outputLimit = positiveNumber(asRecord(model.limit), "output");
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
          ...(inputLimit !== null ? { inputLimit } : {}),
          ...(outputLimit !== null ? { outputLimit } : {}),
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
  | {
      kind: "assistant";
      sessionId: string;
      messageId: string;
      summary?: boolean;
      // OpenCode set time.completed: the model request of this answer ended.
      completed?: boolean;
    }
  | { kind: "retry"; sessionId: string; attempt: number; message?: string }
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
      // The session a task tool part runs its subagent in.
      subagentSessionId?: string;
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
      partId: string;
      messageId?: string;
      usage?: TokenUsage;
      contextBreakdown?: OpenCodeContextBreakdown;
      cost?: number;
    }
  | { kind: "idle"; sessionId: string }
  // A subagent's session: OpenCode's task tool runs it as a child session.
  | { kind: "session_created"; sessionId: string; parentId: string }
  | { kind: "error"; sessionId: string; error: SafeOpenCodeError };

// What the Isomux side knows about a failure. Every field is Isomux-authored:
// `failure` is the text the member reads.
export interface OpenCodeErrorContext {
  agentId?: string;
  failure?: string;
  step?: OpenCodeTurnStep;
  openCodeLog?: string;
}

// Where in send() a turn failed. Every step before "prompt" runs before
// OpenCode has the prompt. Choosing the effort has no step: it cannot fail.
export type OpenCodeTurnStep =
  | "acquire"
  | "session"
  | "begin_turn"
  | "event_stream"
  | "recovery"
  | "safety_plugin"
  | "prompt";

export interface OpenCodeStreamFrame {
  type: string;
  at: string;
}

// How a silence's recovery ended. completed: the session finished during the
// silence, and the turn settles from the replay. ended: the turn ended or
// was stopped during the recovery. error: the recovery threw.
export type OpenCodeSilenceOutcome =
  | "recovered"
  | "completed"
  | "failed_alone"
  | "marked"
  | "ended"
  | "error";

// A turn's event stream sent nothing until the deadline. Every field is
// Isomux-authored or an OpenCode name in a fixed shape; no frame body.
export interface OpenCodeStreamSilence {
  agentId?: string;
  sessionId: string;
  // 1 for the turn's first silence.
  silence: number;
  deadlineAt: string;
  // The last frame on the stream, from any session or the server.
  lastEvent?: OpenCodeStreamFrame;
  // The last frame of the turn's own session.
  lastTurnEvent?: OpenCodeStreamFrame;
  promptSentAt?: string;
  // At the deadline, in this order: no prompt sent yet, a permission request
  // the member has not answered, a running tool, a provider retry, an
  // answer whose model request has not ended, or none of these.
  waitingOn:
    | "prompt_not_sent"
    | "permission"
    | "tool"
    | "retry"
    | "model"
    | "none";
  tools?: string[];
  permissions?: string[];
  retryAttempt?: number;
  subagents?: number;
  probe?: OpenCodeServerProbe;
  outcome: OpenCodeSilenceOutcome;
  openCodeLog?: string;
}

export type OpenCodeStreamSilenceSink = (
  silence: Readonly<OpenCodeStreamSilence>,
) => void;

export type OpenCodeSafeErrorSink = (
  error: Readonly<SafeOpenCodeError>,
  context?: Readonly<OpenCodeErrorContext>,
) => void;

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
  const raw = parseFrame(data);
  return raw ? allowedEvent(raw) : null;
}

function parseFrame(data: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

// A frame's OpenCode type for the journal, with the part or status type
// that tells what the session did: "message.part.updated:tool".
function frameLabel(raw: Record<string, unknown>): string {
  const properties = asRecord(raw.properties);
  const detail =
    raw.type === "message.part.updated"
      ? asRecord(properties.part).type
      : raw.type === "session.status"
        ? asRecord(properties.status).type
        : undefined;
  return safeJournalName(
    typeof raw.type === "string" && typeof detail === "string"
      ? `${raw.type}:${detail}`
      : raw.type,
  );
}

// OpenCode names (event, tool and permission types) go to the journal only
// in this shape, so no free text from OpenCode or a provider reaches it.
function safeJournalName(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,80}$/.test(value)
    ? value
    : "unknown";
}

function allowedEvent(raw: Record<string, unknown>): AllowedEvent | null {
  const type = raw.type;
  const properties = asRecord(raw.properties);
  const sessionId = stringField(properties, "sessionID");
  if (!sessionId) return null;
  if (type === "session.idle") return { kind: "idle", sessionId };
  if (type === "session.created") {
    const info = asRecord(properties.info);
    const id = stringField(info, "id");
    const parentId = stringField(info, "parentID");
    if (!id || !parentId) return null;
    return { kind: "session_created", sessionId: id, parentId };
  }
  if (type === "session.status") {
    const status = asRecord(properties.status);
    const attempt = numberField(status, "attempt");
    if (
      status.type === "retry" &&
      attempt !== null &&
      Number.isSafeInteger(attempt) &&
      attempt > 0
    )
      return {
        kind: "retry",
        sessionId,
        attempt,
        ...(typeof status.message === "string"
          ? { message: status.message }
          : {}),
      };
  }
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
      return {
        kind: "assistant",
        sessionId,
        messageId,
        ...(info.summary === true ? { summary: true } : {}),
        ...(numberField(asRecord(info.time), "completed") !== null
          ? { completed: true }
          : {}),
      };
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
      // OpenCode 1.18.35's task tool names the session it runs, new or
      // reopened with task_id, in metadata.sessionId before the subagent starts.
      const subagentSessionId =
        name === "task" ? stringField(metadata, "sessionId") : null;
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
        ...(subagentSessionId ? { subagentSessionId } : {}),
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
        partId,
        ...(messageId ? { messageId } : {}),
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

function classifyOpenCodeError(
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
