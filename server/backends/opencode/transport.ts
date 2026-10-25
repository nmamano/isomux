import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  openCodeErrorMessage,
  openCodeProviderLine,
  openCodeProviderRefusal,
  openCodeRetryMessage,
} from "./errors.ts";
import type { NormalizedEvent } from "../types.ts";
import { authSignal } from "../auth-signal.ts";
import type {
  ApprovalDecision,
  NormalizedMessage,
  TokenUsage,
} from "../types.ts";
import {
  OPENCODE_CRON_AGENT,
  openCodeAgentRules,
  openCodeSupervisor,
  type OpenCodeLease,
  type OpenCodeSupervisor,
} from "./supervisor.ts";
import { openCodeMcpServerConfig } from "./config-layers.ts";
import { MCP_SERVER_PREFIX } from "../../../shared/mcp-servers.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import {
  openCodeAuthorityBroker,
  type OpenCodeAuthorityBinding,
  type OpenCodeAuthorityBroker,
} from "./authority-broker.ts";
import { OPENCODE_TURN_HANDLE_PLACEHOLDER } from "./office-proxy-shared.ts";
import { openCodeLogPath, openCodeSafetyPluginDir } from "./profile-paths.ts";
import { OpenCodeUnsupportedHostError } from "./runtime.ts";
import { OPENCODE_ADOPTION_HEALTH_TIMEOUT_MS } from "./server-health.ts";
import { OPENCODE_SAFETY_PLUGIN_ID } from "./safety-plugin-tool.ts";
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
  joinLogText,
  msg,
  type LogText,
} from "../../../shared/i18n/log-message.ts";
import { providerText } from "../provider-text.ts";

// The OpenCode 2.1.4 transport (task e47be82a): the /api routes and the
// /api/event frames of @opencode/cli 2.1.4, as recorded on 2026-10-25 in
// fixtures/v2 and internal-docs/opencode-gate/report-2.1.4.md.

export const OPENCODE_PERMISSION_ID_WARNING =
  "Isomux stopped this turn: OpenCode asked to use a tool but sent no id " +
  "with the request, so Isomux had no way to answer it. Tell the office " +
  "owner and check the isomux service logs.";

export const OPENCODE_AUTH_FAILURE =
  "OpenCode authentication is not configured.";

// The one OpenCode sign-in predicate: the turn's auth signal and the
// backend's detectAuthError both use it.
export function detectOpenCodeAuthError(text: string): boolean {
  return text.includes(OPENCODE_AUTH_FAILURE);
}

export const OPENCODE_SERVER_STOPPED_FAILURE =
  "The OpenCode server stopped during this turn. Send your message again.";

export const OPENCODE_SERVER_UNRESPONSIVE_FAILURE =
  "The OpenCode server stopped responding during this turn. Send your message again.";

export const OPENCODE_EVENT_STREAM_LOST_FAILURE =
  "OpenCode stopped sending updates for this turn. Send your message again.";

export const OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE =
  "OpenCode did not load the Isomux safety checks for this folder, so this turn did not run. Tell the office owner and check the isomux service logs.";

export const OPENCODE_SETTINGS_MISSING_FAILURE =
  "OpenCode did not load the Isomux settings for this folder, so this turn did not run. Tell the office owner and check the isomux service logs.";

export const OPENCODE_FOLDER_SETUP_NOTICE =
  "OpenCode is still setting up this folder. The first turn can take a few minutes.";

export const OPENCODE_FOLDER_SETUP_FAILURE =
  "OpenCode did not finish setting up this folder in 3 minutes. Send your message again to keep waiting.";

export const OPENCODE_INSTRUCTIONS_TOO_LARGE_FAILURE =
  "OpenCode refused this agent's system prompt because it is too large, so this turn did not run. Shorten the instructions or memory added to it.";

export const OPENCODE_TURN_STALLED_FAILURE =
  "OpenCode stopped this turn without finishing it. Send your message again.";

export const OPENCODE_COMPACTION_FAILED_NOTICE = "Context compaction failed.";

// A server that still answers health while a folder opens is setting up the
// folder, not frozen, so the turn waits up to this bound. The bound is kept
// from 1.18.35, which installed its plugin SDK into each new config folder
// first: 50-83 s, measured 2026-10-15. 2.1.4 no longer does that (gate P5),
// but at folder open it still imports the folder's .opencode/plugins and
// starts its local MCP commands, with no time limit of its own. A slow 2.1.4
// folder open was not measured.
export const OPENCODE_FOLDER_SETUP_LIMIT_MS = 3 * 60_000;

// OpenCode 2.1.4 sends an SSE comment ": heartbeat" on /api/event every
// 15.000 s (measured 2026-10-25), and no data frame. 45 s is three missed
// heartbeats. The same bound covers the requests a turn makes before its
// stream reads: with 8 sessions on one 1.18.35 server, /event headers took at
// most 0.5 s, POST /session 1.7 s and /provider 12.8 s (2026-10-07).
export const OPENCODE_EVENT_STREAM_DEADLINE_MS = 45_000;

// Heartbeats keep a stream alive while the turn's session makes no progress,
// for example after a sequence collision (upstream #53146) stops its writes.
// After this long without a frame of the turn's sessions, and while no
// request of the turn waits for the member, the turn asks the server whether
// the session still runs.
export const OPENCODE_TURN_PROGRESS_CHECK_MS = 60_000;

// A turn stops waiting for the catalog at the deadline above, but the load
// goes on so a late success is kept. This bound only frees the slot of a
// load that never answers, so a later caller can try again.
export const OPENCODE_CATALOG_LOAD_LIMIT_MS = 5 * 60_000;

// How often a turn asks again for a list that 2.1.4 fills a moment after a
// start or a folder open: the plugin rows of a folder, and the providers.
const OPENCODE_LIST_POLL_MS = 250;

// The instruction entry that carries the agent's system prompt. 2.1.4 puts
// it in the system message as <context key="isomux">, and a changed value
// reaches the model at the next step as an update (2026-10-25). 2.1.4 takes
// at most 256 KiB per entry and answers 413 above it; the system prompts of
// this office's OpenCode agents were 19-41 KB on 2026-10-25.
const OPENCODE_INSTRUCTIONS_KEY = "isomux";

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

// providerExplains: the provider's own line follows, so this one does not
// repeat that the provider refused.
export function openCodeModelUnavailableFailure(
  model: string,
  providerExplains = false,
): string {
  return providerExplains
    ? `OpenCode cannot use model \`${model}\`.`
    : `OpenCode cannot use model \`${model}\`: the provider refused this model.`;
}

export function openCodeModelGoneFailure(model: string): string {
  return `OpenCode no longer lists model \`${model}\`.`;
}

export const OPENCODE_EFFORT_CATALOG_UNAVAILABLE =
  "OpenCode did not return its model list, so this turn runs at the model's default effort.";

export function openCodeEffortUnavailableNotice(
  model: string,
  effort: string,
): string {
  return `\`${model}\` has no \`${effort}\` effort, so this turn runs at its default effort. Pick an effort in the agent settings.`;
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

// 2.1.4 lists a model's prices as tiers. A model is free when it has at
// least one tier and every price of every tier is zero.
function openCodeModelIsFree(rawCost: unknown): boolean {
  if (!Array.isArray(rawCost) || rawCost.length === 0) return false;
  return rawCost.every((tier) => {
    const cost = asRecord(tier);
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
  });
}

// The MCP server configs Isomux sent, per server process, folder and name:
// a hash of url and headers, so a rotated header is sent again. Only a
// cache: after an Isomux restart it is empty, and every server is sent again.
const sentMcpServers = new WeakMap<
  OpenCodeSupervisor,
  { serverKey: string; sent: Map<string, string> }
>();

function mcpServerHash(server: AgentMcpServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        server.url,
        Object.entries(server.headers).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

// The folders whose Isomux top layer was found, per server process (C3).
const checkedConfigs = new WeakMap<
  OpenCodeSupervisor,
  { serverKey: string; folders: Set<string> }
>();

// One catalog per OpenCode server process and directory (/api/model takes
// the folder, and a project config can add models). A running server does
// not reload its model registry, and every change to the model list replaces
// the server (internal-docs/opencode-oc1-scope.md), so the server key is the
// invalidation. Callers share one load; only a success is kept.
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
    // A row carries its provider's settings, which can hold an API key.
    // Reduce it to scalars right here and never log, store or forward the
    // raw body.
    const response = await fetch(
      new URL(folderPath("/api/model", cwd), lease.baseUrl),
      {
        headers: { authorization: lease.authHeader },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenCode HTTP ${response.status} at /api/model.`);
    }
    const models = allowDiscoveredModels(await response.json());
    // 2.1.4 lists no model for a moment after a start (gate E4a): an empty
    // list is a catalog that has not loaded yet, not one to keep.
    if (models.length === 0) throw new Error("OpenCode listed no model yet.");
    return models;
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
  // The environment of the session's shell commands, from the env the
  // agent's conversation started with (supervisor.toolEnvironment).
  toolEnvironment?: Record<string, string>;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: OpenCodeSafeErrorSink;
  streamSilenceSink?: OpenCodeStreamSilenceSink;
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
      });
    }
    if (!options.autoApprove) return "prompt";
    await options.reply("once");
    return "answered";
  }
  if (result.decision.decision === "deny") {
    // With a message, 2.1.4 fails only this tool with the reason, and the
    // turn goes on (2026-10-25).
    await options.reply("reject", result.decision.reason);
    options.sink({
      kind: "system_text",
      text: result.decision.reason,
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
  calledAt?: number;
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
      tool.terminal = true;
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

// The state of one turn that the stream loop and send() share.
interface TurnInput {
  // The id of the prompt's input, from the prompt answer. null until then.
  id: string | null;
  // The turn's busy period began: OpenCode delivered this turn's input.
  armed: boolean;
  // The server time of that delivery, for "idle after the prompt".
  deliveredAt?: number;
  // Frames that come before the prompt answer, in order: the deliveries and
  // the terminal frames of the session, decided once the id is known.
  early: Array<
    | { kind: "delivered"; id: string; at?: number }
    | { kind: "terminal"; frame: Record<string, unknown> }
  >;
  // Isomux rejected a request of the turn's own session without a message.
  // 2.1.4 then ends the busy period as interrupted/shutdown (T3), which a
  // member's Deny on 1.18.35 ended as completed (2026-10-25).
  rejected: boolean;
  // Those rejects still in flight. Each sets rejected once OpenCode takes
  // it, and the shutdown frame can come before the reply's answer.
  rejecting: Array<Promise<void>>;
  // Wakes the loop when the id arrives, to decide the early frames.
  onId?: () => void;
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
  private readonly toolEnvironment?: Record<string, string>;
  private readonly contractShapeSink?: (shape: string) => void;
  private readonly safeErrorSink?: OpenCodeSafeErrorSink;
  private readonly streamSilenceSink?: OpenCodeStreamSilenceSink;
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
  // The agent the session runs with, as far as this transport set it: the
  // create value, or the last switch. null for a resumed session, whose
  // stored agent can be another mode's (2.1.4's prompt has no agent field).
  private sessionAgent: string | null = null;
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
  private turnInput: TurnInput = {
    id: null,
    armed: false,
    early: [],
    rejected: false,
    rejecting: [],
  };
  // A failed turn's session stop that is still in flight. The next prompt
  // waits on it, so that the late interrupt does not stop the next turn.
  private sessionStop: Promise<void> | null = null;
  // Open permission requests: request id -> OpenCode session id. OpenCode
  // runs the tool calls of one step in parallel, and each can ask at once.
  private pendingPermissions = new Map<string, string>();
  // The open turn's question forms: form id -> session id.
  private openForms = new Map<string, string>();
  // The open turn's subagent sessions, nested ones included.
  private subagentSessions = new Set<string>();
  // The open turn's sink, so a request that OpenCode closes outside a member
  // answer can be withdrawn from the orchestrator.
  private turnSink: EventSink | null = null;
  // Restarts the open turn's progress check after a member answer.
  private resumeProgressCheck: (() => void) | null = null;
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
    this.toolEnvironment = options.toolEnvironment;
    this.contractShapeSink = options.contractShapeSink;
    this.safeErrorSink = options.safeErrorSink;
    this.streamSilenceSink = options.streamSilenceSink;
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

  // The agent this transport's mode runs with: build for a normal session.
  private modeAgent(): string {
    return this.agent ?? "build";
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
      // A turn-sending transport loads the catalog alongside the session.
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
        const agent = this.modeAgent();
        const init = {
          method: "POST",
          // C1: the agent and its full rule list. The location has no
          // workspace: 2.1.4 then runs shell commands with the session's
          // environment (core/src/shell.ts:268-272).
          body: JSON.stringify({
            title: "Isomux OpenCode session",
            location: { directory: this.cwd },
            agent,
            permissions: openCodeAgentRules(agent),
          }),
        };
        const body = allowSession(
          withinTurn
            ? await this.withinDeadline(
                (signal) =>
                  this.request("/api/session", { ...init, signal }).then((r) =>
                    r.json(),
                  ),
                { notice: sink },
              )
            : await this.request("/api/session", init).then((r) => r.json()),
        );
        this.contractShapeSink?.("http:session:{data:{id:string}}");
        sessionId = body.id;
        this.sessionAgent = agent;
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
    // Set when this turn's prompt request starts. this.promptSent can still
    // hold the previous turn's value until this turn begins.
    let promptOut = false;
    // The step a failure happened in, for the journal.
    let step: OpenCodeTurnStep | undefined;
    const emit: EventSink = (event) => {
      if (event.kind === "turn_completed") {
        if (settled) return;
        settled = true;
        // OpenCode charges per step and per compaction. A repeated frame
        // replaces its snapshot; it must not charge the turn twice.
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
        // A request still open when the turn ends can never be answered, so
        // OpenCode gets a reject and does not wait on it. A request that
        // arrives late is refused in the same way (consumeEvents).
        const rejected = this.rejectPendingPermission();
        // A turn that fails after its prompt went out stops its session, so
        // that it does not run on unseen. The interrupt comes after the
        // reject, as in abort(). A stopped server has nothing to stop, and a
        // marked one is replaced. After a failure OpenCode reported itself,
        // the session is idle already and the interrupt changes nothing: one
        // rule for every failure is deliberate.
        if (
          event.status === "failed" &&
          promptOut &&
          event.error !== OPENCODE_SERVER_STOPPED_FAILURE &&
          event.error !== OPENCODE_SERVER_UNRESPONSIVE_FAILURE &&
          this.sessionId
        ) {
          const path = `/api/session/${encodeURIComponent(this.sessionId)}/interrupt`;
          const stop: Promise<void> = rejected
            .then(() => this.request(path, { method: "POST" }))
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              if (this.sessionStop === stop) this.sessionStop = null;
            });
          this.sessionStop = stop;
        }
        for (const id of this.pendingPermissions.keys())
          sink({ kind: "approval_withdrawn", approvalId: id });
        this.pendingPermissions.clear();
        this.openForms.clear();
        this.turnSink = null;
        this.resumeProgressCheck = null;
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
          text: msg("systemEntries.openCodePreviousSettings"),
        });
      this.authorityBinding?.activate(this.lease!.pid);
      this.activeTurn = true;
      this.abortRequested = false;
      this.promptSent = false;
      this.turnInput = {
        id: null,
        armed: false,
        early: [],
        rejected: false,
        rejecting: [],
      };
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
      const session = encodeURIComponent(sessionId);
      // 1010dd4b: the session's shell commands run with the environment of
      // the agent's conversation, without the server's password. The store
      // is in memory, so a replaced server needs it again: every turn.
      if (this.toolEnvironment) {
        step = "environment";
        await this.request(`/api/session/${session}/environment`, {
          method: "PUT",
          signal: controller.signal,
          body: JSON.stringify({ variables: this.toolEnvironment }),
        });
      }
      if (settled) return;
      step = "mcp";
      await this.syncMcpServers(controller.signal, emit);
      if (settled) return;
      step = "config";
      await this.requireIsomuxConfig(controller.signal, emit);
      if (settled) return;
      step = "safety_plugin";
      await this.requireSafetyPlugin(controller.signal, emit);
      if (settled) return;
      // After beginTurn and recovery, which can each replace the server.
      const { variant, notice } = await this.resolveEffort();
      if (settled) return;
      await this.previousSessionStop();
      if (settled) return;
      // A stop during the waits above: no prompt is out, so none goes.
      if (this.abortRequested) {
        emit({ kind: "turn_completed", status: "interrupted" });
        return;
      }
      if (notice) emit({ kind: "system_text", text: notice });
      // R7: the session runs with this mode's agent and its rules. 2.1.4
      // changes an agent only through this route; PATCH ignores the field
      // (2026-10-25).
      const agent = this.modeAgent();
      if (this.sessionAgent !== agent) {
        // Rules set on the session come after the agent's own, so the
        // session takes the new agent's rules first (C1).
        step = "permissions";
        await this.request(`/api/session/${session}`, {
          method: "PATCH",
          signal: controller.signal,
          body: JSON.stringify({ permissions: openCodeAgentRules(agent) }),
        });
        if (settled) return;
        step = "agent";
        await this.request(`/api/session/${session}/agent`, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ agent }),
        });
        this.sessionAgent = agent;
      }
      if (settled) return;
      // A PUT of the same value changes nothing for the model.
      step = "instructions";
      try {
        await this.request(
          `/api/experimental/session/${session}/instructions/entries/${OPENCODE_INSTRUCTIONS_KEY}`,
          {
            method: "PUT",
            signal: controller.signal,
            body: JSON.stringify({ value: this.systemPrompt }),
          },
        );
      } catch (error) {
        if (asRecord(error).statusCode === 413)
          throw new OpenCodeTurnFailure(
            OPENCODE_INSTRUCTIONS_TOO_LARGE_FAILURE,
            { cause: error },
          );
        throw error;
      }
      if (settled) return;
      // E4: an explicit model on every prompt. Without one, 2.1.4 runs the
      // prompt on its default free cloud model.
      step = "model";
      const [providerID, modelID] = splitModel(this.model);
      await this.request(`/api/session/${session}/model`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          model: { providerID, id: modelID, ...(variant ? { variant } : {}) },
        }),
      });
      if (settled) return;
      if (this.abortRequested) {
        emit({ kind: "turn_completed", status: "interrupted" });
        return;
      }
      step = "prompt";
      promptOut = true;
      this.promptSent = true;
      this.promptSentAt = Date.now();
      const response = await this.request(`/api/session/${session}/prompt`, {
        method: "POST",
        signal: controller.signal,
        // The 2.1.4 prompt takes text only.
        body: JSON.stringify({
          text: parts.map((part) => part.text).join("\n\n"),
        }),
      });
      const input = stringField(
        asRecord(asRecord(await response.json()).data),
        "id",
      );
      this.contractShapeSink?.("http:prompt:{data:{id:string}}");
      if (!input)
        throw new Error("OpenCode returned an invalid prompt answer.");
      this.turnInput.id = input;
      this.turnInput.onId?.();
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

  // Waits up to the stream deadline for a failed turn's session stop. A
  // stop request to a server that froze must not hold the next turn.
  private async previousSessionStop(): Promise<void> {
    const stop = this.sessionStop;
    if (!stop) return;
    let timer: unknown;
    const bound = new Promise<void>((resolve) => {
      timer = this.deadlineScheduler.setTimeout(
        resolve,
        this.eventStreamDeadlineMs,
      );
    });
    try {
      await Promise.race([stop, bound]);
    } finally {
      this.deadlineScheduler.clearTimeout(timer);
    }
  }

  async abort(): Promise<void> {
    // No prompt is out during a pre-stream wait, so OpenCode has nothing to
    // interrupt, and a request to this folder would wait on its setup too.
    if (this.stopPreStreamWait) {
      this.stopPreStreamWait();
      return;
    }
    if (!this.sessionId) return;
    this.abortRequested = true;
    await this.rejectPendingPermission();
    // No resume: queued input stays parked (T5).
    await this.request(
      `/api/session/${encodeURIComponent(this.sessionId)}/interrupt`,
      { method: "POST" },
    ).catch(() => undefined);
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const sessionId = this.pendingPermissions.get(approvalId);
    if (!sessionId || !this.ownsSession(sessionId)) return;
    // C2: Isomux never sends "always", which 2.1.4 saves for the whole
    // project (gate P2). OpenCode agents offer Allow once and Deny only, so
    // no session rule list changes.
    if (decision.kind !== "allow_once" && decision.kind !== "deny") {
      throw new Error("OpenCode supports Allow once and Deny.");
    }
    // Out of the map while the reply is in flight, so an abort cannot answer
    // it a second time.
    this.pendingPermissions.delete(approvalId);
    this.resumeProgressCheck?.();
    try {
      await this.replyPermission(
        sessionId,
        approvalId,
        decision.kind === "allow_once" ? "once" : "reject",
        decision.kind === "deny" ? decision.reason : undefined,
      );
    } catch (err) {
      // Another reject of the session closed the request first: 2.1.4
      // answers 404, and the request is gone (2026-10-25).
      if (asRecord(err).statusCode === 404) return;
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
      const messages = allowMessages(await this.readMessages(sessionId));
      this.contractShapeSink?.("http:message:list");
      return messages;
    });
  }

  // Every item of a session, oldest first. T7: 2.1.4 refuses a cursor
  // together with an order, so later pages name the cursor only.
  private async readMessages(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const path = `/api/session/${encodeURIComponent(sessionId)}/message`;
    let query = "?limit=200&order=asc";
    for (;;) {
      const body = asRecord(
        await this.request(`${path}${query}`, signal ? { signal } : {}).then(
          (r) => r.json(),
        ),
      );
      const page: unknown = body.data;
      if (!Array.isArray(page))
        throw new Error("OpenCode returned an invalid message list.");
      items.push(...(page as unknown[]));
      const next = stringField(asRecord(body.cursor), "next");
      if (!next || page.length === 0) return items;
      query = `?cursor=${encodeURIComponent(next)}&limit=200`;
    }
  }

  // OpenCode copies the messages before messageId; null copies them all.
  async forkAtMessage(messageId: string | null): Promise<string> {
    return this.outsideTurn(async (sessionId) => {
      const response = await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          body: JSON.stringify(messageId === null ? {} : { before: messageId }),
        },
      );
      const child = allowSession(await response.json()).id;
      this.contractShapeSink?.("http:fork:{data:{id:string}}");
      return child;
    });
  }

  async deleteSession(): Promise<void> {
    await this.outsideTurn(async (sessionId) => {
      await this.request(`/api/session/${encodeURIComponent(sessionId)}`, {
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
    // lease's endpoint fields usable until this close-time reject and
    // interrupt chain finishes.
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
      (bounded) => this.request("/api/event", { signal: bounded }),
      { signal, notice: sink },
    );
    if (!response.body) throw new Error("OpenCode event stream has no body.");
    let reader: ReadableStreamDefaultReader<Uint8Array> =
      response.body.getReader();
    let decoder = new TextDecoder();
    const turn = this.turnInput;
    // Text and reasoning by (message, ordinal), tools by (message, id) (T6).
    const textByPart = new Map<string, string>();
    const reasoningByPart = new Map<string, string>();
    const reasoningStarted = new Map<string, number>();
    const tools = new Map<string, TrackedTool>();
    const seenPermissions = new Set<string>();
    const safetyWarningState = { shown: false };
    this.subagentSessions.clear();
    // What a silence report names: the turn's open steps, its running
    // tools, its permission names and its last frames.
    const openSteps = new Set<string>();
    const runningTools = new Set<string>();
    const permissionNames = new Map<string, string>();
    let retryAttempt: number | undefined;
    let lastEvent: OpenCodeStreamFrame | undefined;
    let lastTurnEvent: OpenCodeStreamFrame | undefined;
    let lastStepError: unknown;
    let settled = false;
    // A turn that ends on a sign-in failure sends auth_needed first.
    const settle = (
      event: NormalizedEvent,
      options: { authNeeded?: boolean } = {},
    ): void => {
      if (settled) return;
      settled = true;
      this.deadlineScheduler.clearTimeout(progressTimer);
      if (options.authNeeded) {
        sink({ kind: "auth_needed" });
        sink(event);
        return;
      }
      for (const out of authSignal(event, detectOpenCodeAuthError)) sink(out);
    };
    const fail = (error: unknown, context: string): void => {
      if (settled) return;
      settled = true;
      this.deadlineScheduler.clearTimeout(progressTimer);
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
    // T9: the progress check. It runs after the prompt went out, restarts at
    // every frame of the turn's sessions, and waits while a request of the
    // turn waits for the member: a session parked on a permission stays in
    // /api/session/active, with its parent (2026-10-25), but a member can
    // take hours to answer.
    let progressTimer: unknown;
    let checking = false;
    const armProgress = (): void => {
      this.deadlineScheduler.clearTimeout(progressTimer);
      if (signal.aborted || settled || !this.promptSent) return;
      if (this.pendingPermissions.size > 0 || this.openForms.size > 0) return;
      progressTimer = this.deadlineScheduler.setTimeout(() => {
        if (signal.aborted || settled || checking) return;
        checking = true;
        void checkProgress()
          .catch(() => armProgress())
          .finally(() => {
            checking = false;
          });
      }, OPENCODE_TURN_PROGRESS_CHECK_MS);
    };
    this.resumeProgressCheck = armProgress;
    const checkProgress = async (): Promise<void> => {
      const read = (path: string): Promise<unknown> =>
        this.request(path, { signal }).then((r) => r.json());
      const [rawSession, active] = await Promise.all([
        read(`/api/session/${encodeURIComponent(sessionId)}`),
        read("/api/session/active"),
      ]);
      if (signal.aborted || settled) return;
      const session = asRecord(asRecord(rawSession).data);
      const messages = await this.readMessages(sessionId, signal);
      if (signal.aborted || settled) return;
      const finished = finishedAfterInput(session, messages, turn);
      if (finished) {
        deliver({
          value: sseFrames([
            ...turnReplayFrames(sessionId, messages, turn.id),
            outcomeFrame(sessionId, finished, turn.rejected),
          ]),
          fresh: true,
          replay: true,
        });
        return;
      }
      if (asRecord(asRecord(active).data)[sessionId] !== undefined) {
        armProgress();
        return;
      }
      fail(
        new OpenCodeTurnFailure(OPENCODE_TURN_STALLED_FAILURE, {
          cause: new Error(),
        }),
        "",
      );
      deliver({ value: null });
    };
    const streamFailure = async (error: unknown): Promise<unknown> =>
      (await this.serverGone(lease, serverPid))
        ? new OpenCodeTurnFailure(OPENCODE_SERVER_STOPPED_FAILURE, {
            cause: error,
          })
        : error;
    // The pump reads the body on its own, so any chunk resets the deadline,
    // a heartbeat comment included, also while the loop below awaits a
    // permission reply. A fresh read starts a new connection: the loop drops
    // the old one's partial frame. at: when the pump read the chunk.
    // replay: frames Isomux built from a read, not from the stream.
    type Read =
      | { value: Uint8Array | null; fresh?: true; replay?: true; at?: number }
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
    // The prompt answer decides the frames that came before it.
    // T9 starts here too: a prompt that OpenCode took but never delivers
    // (its insert failed) sends no frame of the turn, only heartbeats.
    turn.onId = () => {
      armProgress();
      deliver({ value: new Uint8Array(0) });
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
      const running = [...runningTools].map((key) =>
        safeJournalName(tools.get(key)?.name),
      );
      const waitingOn: OpenCodeStreamSilence["waitingOn"] = !this.promptSent
        ? "prompt_not_sent"
        : permissions.length > 0
          ? "permission"
          : running.length > 0
            ? "tool"
            : lastTurnEvent?.type === "session.retry.scheduled"
              ? "retry"
              : openSteps.size > 0
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
    // The server answers, so only this turn fails. The turn's end stops its
    // session (send).
    const failAlone = (): void => {
      if (settled || signal.aborted) return;
      reportSilence("failed_alone");
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
    // up on what the silent one missed, or fails alone. T2: /api/event
    // replays nothing, so the catch-up comes from the session's state.
    let recoveries = 0;
    const recover = async (): Promise<void> => {
      // The first stream may be recovered even when it got nothing after its
      // connect frame. A later one must have delivered a heartbeat or a
      // frame, so a folder whose streams connect and go silent does not loop.
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
      let rawSession: unknown;
      let requests: unknown[] = [];
      let messages: unknown[] = [];
      let promptSent = false;
      try {
        next = await this.request("/api/event", { signal: bounded.signal });
        // OpenCode registers the listener before it answers, so a prompt
        // sent after this point is seen on the new stream.
        promptSent = this.promptSent;
        const [session, own, folder, items] = await Promise.all([
          read(`/api/session/${encodeURIComponent(sessionId)}`),
          read(`/api/session/${encodeURIComponent(sessionId)}/permission`),
          // A subagent's requests are in its own session's list only; the
          // folder's list holds every open request, each with its session.
          read(folderPath("/api/permission/request", this.cwd)),
          promptSent
            ? this.readMessages(sessionId, bounded.signal)
            : Promise.resolve([]),
        ]);
        rawSession = session;
        messages = items;
        requests = [...listData(own), ...listData(folder)];
        await this.adoptSubagents(requests, read);
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
        ? turnReplayFrames(sessionId, messages, turn.id)
        : [];
      const finished = promptSent
        ? finishedAfterInput(
            asRecord(asRecord(rawSession).data),
            messages,
            turn,
          )
        : null;
      if (finished) {
        // The session went idle while its stream was silent. The loop below
        // settles the turn from what it missed and the outcome.
        void next.body.cancel().catch(() => undefined);
        reportSilence("completed");
        deliver({
          value: sseFrames([
            ...missed,
            outcomeFrame(sessionId, finished, turn.rejected),
          ]),
          fresh: true,
          replay: true,
        });
        return;
      }
      // A request asked while the stream was silent. The loop below drops
      // other sessions' requests and the ones it already handled.
      const asked = requests.map((data) => ({
        type: "permission.asked",
        data,
      }));
      reportSilence("recovered");
      deliver({
        value: sseFrames([...missed, ...asked]),
        fresh: true,
        replay: true,
      });
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
    // An end of this turn's busy period, mapped to the turn's end.
    const terminal = async (frame: Record<string, unknown>): Promise<void> => {
      const data = asRecord(frame.data);
      if (frame.type === "session.execution.succeeded") {
        settle({ kind: "turn_completed", status: "completed" });
        return;
      }
      if (frame.type === "session.execution.interrupted") {
        // A member's stop wins over the deny mapping below.
        if (this.abortRequested || data.reason !== "shutdown") {
          for (const result of interruptedToolResults(tools.values()))
            sink(result);
          settle({ kind: "turn_completed", status: "interrupted" });
          return;
        }
        // T3: a Deny without a message ends the busy period like this. A
        // shutdown that Isomux did not cause is a failure.
        await Promise.all(turn.rejecting);
        if (turn.rejected) {
          for (const result of interruptedToolResults(tools.values()))
            sink(result);
          settle({ kind: "turn_completed", status: "completed" });
          return;
        }
        fail(new Error(), "OpenCode shut down the turn");
        return;
      }
      const error = allowError(data.error ?? lastStepError);
      try {
        this.safeErrorSink?.(error, this.errorContext());
      } catch {
        /* Logging cannot end a turn. */
      }
      const refusal = openCodeProviderRefusal(error, splitModel(this.model)[0]);
      const failure =
        refusal === null
          ? await this.classifyProviderFailure(error, signal)
          : null;
      if (
        failure === "authentication" ||
        failure === "provider_not_connected"
      ) {
        const signIn = await this.signInFailure(error, failure);
        settle(
          {
            kind: "turn_completed",
            status: "failed",
            error: signIn.error,
            ...(signIn.pickModel ? { pickModel: true as const } : {}),
          },
          { authNeeded: signIn.authNeeded },
        );
        return;
      }
      // Another model fixes this turn: the line offers the picker.
      if (failure === "model_gone" || failure === "model_refused") {
        settle({
          kind: "turn_completed",
          status: "failed",
          error:
            failure === "model_gone"
              ? openCodeModelGoneFailure(this.model)
              : openCodeModelUnavailableFailure(this.model),
          pickModel: true,
          ...(failure === "model_gone" ? { goneModel: this.model } : {}),
        });
        return;
      }
      settle({
        kind: "turn_completed",
        status: "failed",
        error: refusal ?? openCodeErrorMessage(error),
      });
    };
    // The frames that came before the prompt answer, decided by its id.
    const decideEarly = async (): Promise<boolean> => {
      if (turn.id === null) return false;
      const early = turn.early.splice(0);
      for (const item of early) {
        if (item.kind === "delivered") {
          if (item.id === turn.id && !turn.armed) {
            turn.armed = true;
            turn.deliveredAt = item.at;
          }
        } else if (turn.armed) {
          await terminal(item.frame);
          return true;
        }
      }
      return false;
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
          if (await decideEarly()) return;
          buffer =
            `${buffer}${decoder.decode(read.value, { stream: true })}`.replaceAll(
              "\r\n",
              "\n",
            );
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const text = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!text) continue;
            const frame = parseFrame(text);
            if (!frame) continue;
            const type = typeof frame.type === "string" ? frame.type : "";
            const data = asRecord(frame.data);
            const frameSessionId = frameSession(frame);
            if (!read.replay) {
              const seen = {
                type: safeJournalName(frame.type),
                at: new Date(read.at ?? Date.now()).toISOString(),
              };
              lastEvent = seen;
              if (frameSessionId === sessionId) lastTurnEvent = seen;
            }
            if (!frameSessionId) continue;
            // A subagent's session: OpenCode's subagent tool runs it as a
            // child session.
            if (type === "session.created") {
              const parentId = stringField(data, "parentID");
              if (parentId && this.ownsSession(parentId))
                this.adoptSubagent(frameSessionId);
              continue;
            }
            const own = frameSessionId === sessionId;
            // A subagent waits on its requests like the agent does, and
            // nothing else answers them. Its other frames are its own.
            if (
              !own &&
              !(
                this.subagentSessions.has(frameSessionId) &&
                (type.startsWith("permission.") || type.startsWith("form."))
              )
            )
              continue;
            this.contractShapeSink?.(`sse:${safeJournalName(type)}`);
            armProgress();
            const created = numberField(frame, "created") ?? undefined;
            const message = stringField(data, "assistantMessageID") ?? "";
            if (type === "session.inbox.delivered") {
              const inbox = stringField(data, "inboxID");
              if (!inbox) continue;
              if (turn.id === null)
                turn.early.push({ kind: "delivered", id: inbox, at: created });
              else if (inbox === turn.id && !turn.armed) {
                turn.armed = true;
                turn.deliveredAt = created;
              }
              continue;
            }
            if (TERMINAL_FRAMES.has(type)) {
              if (turn.id === null) {
                turn.early.push({ kind: "terminal", frame });
                continue;
              }
              // A late end of an earlier busy period.
              if (!turn.armed) continue;
              await terminal(frame);
              return;
            }
            if (type === "session.step.started") {
              if (message) openSteps.add(message);
              continue;
            }
            if (
              type === "session.step.ended" ||
              type === "session.step.failed"
            ) {
              if (message) openSteps.delete(message);
              if (type === "session.step.failed") lastStepError = data.error;
              const tokens = allowTokens(data.tokens);
              const cost = numberField(data, "cost");
              if (message && (tokens || cost !== null))
                billedSteps.set(message, {
                  ...(tokens ? { usage: tokens.usage } : {}),
                  ...(cost !== null ? { cost } : {}),
                });
              if (type === "session.step.ended" && tokens)
                this.completedStepSink?.(tokens.context);
              continue;
            }
            if (
              type === "session.compaction.ended" ||
              type === "session.compaction.failed"
            ) {
              const tokens = allowTokens(data.tokens);
              const cost = numberField(data, "cost");
              if (tokens || cost !== null)
                billedSteps.set(
                  `compaction:${stringField(data, "inputID") ?? stringField(frame, "id") ?? type}`,
                  {
                    ...(tokens ? { usage: tokens.usage } : {}),
                    ...(cost !== null ? { cost } : {}),
                  },
                );
              // T4: a failed compaction does not fail the turn.
              if (type === "session.compaction.failed")
                sink({
                  kind: "system_text",
                  text: OPENCODE_COMPACTION_FAILED_NOTICE,
                });
              continue;
            }
            if (type === "session.retry.scheduled") {
              const attempt = numberField(data, "attempt");
              if (
                attempt === null ||
                !Number.isSafeInteger(attempt) ||
                attempt < 2
              )
                continue;
              // Attempt 2 is the first retry.
              retryAttempt = attempt - 1;
              sink({
                kind: "system_text",
                text: openCodeRetryMessage(
                  stringField(asRecord(data.error), "message") ?? undefined,
                  retryAttempt,
                  splitModel(this.model)[0],
                ),
              });
              continue;
            }
            if (
              type === "session.text.delta" ||
              type === "session.text.ended" ||
              type === "session.reasoning.delta" ||
              type === "session.reasoning.ended"
            ) {
              const ordinal = numberField(data, "ordinal") ?? 0;
              const key = `${message}:${ordinal}`;
              const reasoning = type.startsWith("session.reasoning.");
              const parts = reasoning ? reasoningByPart : textByPart;
              const prior = parts.get(key) ?? "";
              let delta = "";
              if (type.endsWith(".delta")) {
                delta = stringField(data, "delta") ?? "";
                parts.set(key, prior + delta);
              } else {
                // The ended frame holds the whole part: only what the deltas
                // missed is new.
                const whole = stringField(data, "text") ?? "";
                if (whole.startsWith(prior)) delta = whole.slice(prior.length);
                if (whole.length >= prior.length) parts.set(key, whole);
              }
              if (!reasoning) {
                if (delta) sink({ kind: "assistant_text", text: delta });
                continue;
              }
              const started = reasoningStarted.get(key);
              const durationMs =
                type === "session.reasoning.ended" &&
                started !== undefined &&
                created !== undefined
                  ? Math.max(0, created - started)
                  : undefined;
              if (delta || durationMs !== undefined)
                sink({
                  kind: "thinking",
                  text: delta,
                  ...(durationMs !== undefined ? { durationMs } : {}),
                });
              continue;
            }
            if (type === "session.reasoning.started") {
              const ordinal = numberField(data, "ordinal") ?? 0;
              if (created !== undefined)
                reasoningStarted.set(`${message}:${ordinal}`, created);
              continue;
            }
            if (type.startsWith("session.tool.")) {
              const id = stringField(data, "id");
              if (!id) continue;
              const key = `${message}:${id}`;
              let tool = tools.get(key);
              if (!tool) {
                tool = {
                  callId: key,
                  name: stringField(data, "name") ?? "unknown",
                  input: {},
                  callEmitted: false,
                  terminal: false,
                };
                tools.set(key, tool);
              }
              if (type === "session.tool.input.started") {
                tool.name = stringField(data, "name") ?? tool.name;
                continue;
              }
              if (type === "session.tool.called") {
                tool.input = asRecord(data.input);
                tool.calledAt ??= created;
                const subagent = stringField(tool.input, "sessionID");
                if (tool.name === "subagent" && subagent)
                  this.adoptSubagent(subagent);
                if (!tool.callEmitted && !tool.terminal) {
                  tool.callEmitted = true;
                  runningTools.add(key);
                  sink(toolCall(tool));
                }
                continue;
              }
              if (type === "session.tool.progress") {
                // The subagent tool names its child session before the
                // child runs, new or reopened.
                const child = stringField(asRecord(data.metadata), "sessionID");
                if (tool.name === "subagent" && child)
                  this.adoptSubagent(child);
                continue;
              }
              if (
                type !== "session.tool.success" &&
                type !== "session.tool.failed"
              )
                continue;
              runningTools.delete(key);
              if (tool.terminal) continue;
              tool.terminal = true;
              if (!tool.callEmitted) {
                tool.callEmitted = true;
                sink(toolCall(tool));
              }
              const success = type === "session.tool.success";
              // T3: a shell command that exits non-zero is a success frame
              // with its exit code.
              const exit = numberField(asRecord(data.metadata), "exit");
              sink({
                kind: "tool_result",
                toolUseId: tool.callId,
                content: success
                  ? toolText(data.content)
                  : (stringField(asRecord(data.error), "message") ?? ""),
                ...(tool.calledAt !== undefined && created !== undefined
                  ? { durationMs: Math.max(0, created - tool.calledAt) }
                  : {}),
                ...(!success || (exit !== null && exit !== 0)
                  ? { isError: true }
                  : {}),
              });
              continue;
            }
            if (type === "permission.replied") {
              // OpenCode closed a request: by a member answer, which took it
              // out of the map, or by another reject of its session.
              const request = stringField(data, "requestID");
              if (request && this.pendingPermissions.delete(request)) {
                sink({ kind: "approval_withdrawn", approvalId: request });
                armProgress();
              }
              continue;
            }
            if (type === "permission.asked") {
              const id = stringField(data, "id");
              if (!id) {
                sink({
                  kind: "system_text",
                  text: OPENCODE_PERMISSION_ID_WARNING,
                });
                settle({
                  kind: "turn_completed",
                  status: "failed",
                  error: OPENCODE_PERMISSION_ID_WARNING,
                });
                return;
              }
              if (seenPermissions.has(id)) continue;
              seenPermissions.add(id);
              const envelope: OpenCodePermissionEnvelope = {
                id,
                sessionId: frameSessionId,
                action: data.action,
                resources: data.resources,
                metadata: data.metadata,
              };
              // After the turn settles, no member can answer a request and
              // no one reads what its tool does, so it is refused unseen.
              const refuseLate = (): void =>
                void this.replyPermission(frameSessionId, id, "reject").catch(
                  () => undefined,
                );
              if (signal.aborted) {
                refuseLate();
                continue;
              }
              const handled = await handleOpenCodePermission(envelope, {
                cwd: this.cwd,
                autoApprove: !!this.agent,
                warningState: safetyWarningState,
                reply: (reply, message) =>
                  this.replyPermission(frameSessionId, id, reply, message),
                sink,
              });
              if (handled === "answered") continue;
              if (signal.aborted) {
                refuseLate();
                continue;
              }
              const permissionName =
                typeof data.action === "string" ? data.action : "unknown tool";
              const displayPatterns = Array.isArray(data.resources)
                ? data.resources.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              this.pendingPermissions.set(id, frameSessionId);
              this.deadlineScheduler.clearTimeout(progressTimer);
              permissionNames.set(id, safeJournalName(permissionName));
              sink({
                kind: "approval_request",
                approvalId: id,
                toolName: permissionName,
                input: displayPatterns.length
                  ? { patterns: displayPatterns }
                  : {},
                title: `OpenCode wants to use ${permissionName}`,
              });
              continue;
            }
            if (type === "form.created") {
              const form = asRecord(data.form);
              const id = stringField(form, "id");
              if (!id || asRecord(form.metadata).kind !== "question") continue;
              this.openForms.set(id, frameSessionId);
              this.deadlineScheduler.clearTimeout(progressTimer);
              sink({
                kind: "input_request",
                inputType: "question",
                requestId: id,
              });
              continue;
            }
            if (type === "form.cancelled" || type === "form.replied") {
              const id = stringField(data, "id") ?? stringField(data, "formID");
              if (id) this.openForms.delete(id);
              armProgress();
            }
          }
        }
        if (!signal.aborted && !settled) {
          this.deadlineScheduler.clearTimeout(deadline);
          const failure = await streamFailure(new Error());
          if (!signal.aborted)
            fail(failure, "OpenCode event stream ended before turn completion");
        }
      } catch (error) {
        if (!signal.aborted && !settled) {
          this.deadlineScheduler.clearTimeout(deadline);
          const failure = await streamFailure(error);
          if (!signal.aborted) fail(failure, "OpenCode event stream failed");
        }
      } finally {
        this.deadlineScheduler.clearTimeout(deadline);
        this.deadlineScheduler.clearTimeout(progressTimer);
      }
    })();
    // The pump adds hops between a read and its handling. One event-loop turn
    // lets the loop settle what the stream already holds (an early failure)
    // before the caller submits the prompt.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // The turn's subagent sessions among the sessions of open requests: their
  // session.created frames were lost in a silence. A child names its parent;
  // the walk stops at a session the turn owns, at a root, or after 8 levels.
  private async adoptSubagents(
    requests: unknown[],
    read: (path: string) => Promise<unknown>,
  ): Promise<void> {
    const parents = new Map<string, string | null>();
    for (const request of requests) {
      const start = stringField(asRecord(request), "sessionID");
      if (!start || this.ownsSession(start)) continue;
      const chain: string[] = [];
      let current: string | null = start;
      for (let level = 0; current && level < 8; level++) {
        if (this.ownsSession(current)) {
          for (const session of chain) this.adoptSubagent(session);
          break;
        }
        chain.push(current);
        if (!parents.has(current)) {
          const session = asRecord(
            asRecord(await read(`/api/session/${encodeURIComponent(current)}`))
              .data,
          );
          parents.set(current, stringField(session, "parentID"));
        }
        current = parents.get(current) ?? null;
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
    sessionId: string,
    id: string,
    reply: "once" | "reject",
    message?: string,
  ): Promise<void> {
    const sent = this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(id)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: reply,
          ...(message ? { message } : {}),
        }),
      },
    );
    // A reject without a message of the turn's own session ends its busy
    // period (T3), once OpenCode took it. A 404 means another reject closed
    // the request, and that reject counts.
    if (reply === "reject" && !message && sessionId === this.sessionId) {
      const turn = this.turnInput;
      turn.rejecting.push(
        sent.then(
          () => {
            turn.rejected = true;
          },
          () => undefined,
        ),
      );
    }
    await sent;
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

  // A subagent's session of the open turn. A child does not inherit its
  // parent's environment (probe, 2026-10-25), so it gets the turn's. A child
  // shell command that runs before this PUT lands, or after it failed, runs
  // with the server's environment.
  private adoptSubagent(sessionId: string): void {
    if (this.subagentSessions.has(sessionId)) return;
    this.subagentSessions.add(sessionId);
    if (!this.toolEnvironment) return;
    void this.request(
      `/api/session/${encodeURIComponent(sessionId)}/environment`,
      {
        method: "PUT",
        body: JSON.stringify({ variables: this.toolEnvironment }),
      },
    ).catch(() => undefined);
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
        return this.replyPermission(owner, id, "reject").catch(() => undefined);
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

  // A pause on the deadline scheduler, ended early by the signal.
  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.deadlineScheduler.setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          this.deadlineScheduler.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
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

  // 1010dd4b: the folder's Isomux MCP servers become the supervisor's
  // current list before every prompt, so a change reaches the next turn
  // without a new server. 2.1.4 keeps a run-time add per folder until the
  // server stops, above any config layer's server of that name
  // (config/plugin/mcp.ts:51-53). Removal reads the folder's list and is
  // stateless, so it holds across an Isomux restart that adopted the
  // server: every name with Isomux's prefix (shared/mcp-servers.ts) that
  // the list lacks is Isomux's to remove. A PUT answers before the server
  // connects (probe, 2026-10-25), so a slow MCP server does not hold the
  // turn.
  private async syncMcpServers(
    signal: AbortSignal,
    notice: EventSink,
  ): Promise<void> {
    const servers = this.lease!.mcpServers;
    const body: unknown = await this.withinDeadline(
      (bounded) =>
        this.request(folderPath("/api/mcp", this.cwd), {
          signal: bounded,
        }).then((r) => r.json()),
      { signal, notice },
    );
    const serverKey = this.lease!.serverKey;
    let kept = sentMcpServers.get(this.supervisor);
    if (!kept || kept.serverKey !== serverKey) {
      kept = { serverKey, sent: new Map() };
      sentMcpServers.set(this.supervisor, kept);
    }
    const sent = kept.sent;
    const key = (name: string) => `${this.cwd}\0${name}`;
    const wanted = new Set(servers.map((server) => server.name));
    const listed = new Set<string>();
    const path = (name: string) =>
      folderPath(`/api/experimental/mcp/${encodeURIComponent(name)}`, this.cwd);
    for (const row of listData(body).map(asRecord)) {
      const name = stringField(row, "name");
      if (!name) continue;
      listed.add(name);
      if (!name.startsWith(MCP_SERVER_PREFIX) || wanted.has(name)) continue;
      sent.delete(key(name));
      try {
        await this.request(path(name), { method: "DELETE", signal });
      } catch (error) {
        // Another turn in the folder removed it first.
        if (asRecord(error).statusCode !== 404) throw error;
      }
    }
    for (const server of servers) {
      const hash = mcpServerHash(server);
      // A server the folder still lists with the config Isomux sent: a
      // repeated PUT costs up to 0.94 s (probe, 2026-10-25) and changes
      // nothing. One OpenCode marks failed stays listed; OpenCode retries it.
      if (listed.has(server.name) && sent.get(key(server.name)) === hash)
        continue;
      sent.delete(key(server.name));
      await this.request(path(server.name), {
        method: "PUT",
        signal,
        body: JSON.stringify({ config: openCodeMcpServerConfig(server) }),
      });
      sent.set(key(server.name), hash);
    }
  }

  // C3: 2.1.4 drops a malformed OPENCODE_CONFIG_CONTENT with only a
  // warning, and the folder then runs without Isomux's rules. Isomux's top
  // layer is the document without a path that defines the cron agent: a
  // well-known remote document has no path either. Once per server process
  // and folder; only a pass is kept.
  private async requireIsomuxConfig(
    signal: AbortSignal,
    notice: EventSink,
  ): Promise<void> {
    const serverKey = this.lease!.serverKey;
    let kept = checkedConfigs.get(this.supervisor);
    if (!kept || kept.serverKey !== serverKey) {
      kept = { serverKey, folders: new Set() };
      checkedConfigs.set(this.supervisor, kept);
    }
    if (kept.folders.has(this.cwd)) return;
    const body: unknown = await this.withinDeadline(
      (bounded) =>
        this.request(folderPath("/api/config", this.cwd), {
          signal: bounded,
        }).then((r) => r.json()),
      { signal, notice },
    );
    const entries = Array.isArray(body) ? body.map(asRecord) : [];
    const loaded = entries.some((entry) => {
      if (entry.type !== "document" || entry.path !== undefined) return false;
      const agent = asRecord(asRecord(entry.info).agents)[OPENCODE_CRON_AGENT];
      return typeof agent === "object" && agent !== null;
    });
    if (!loaded)
      throw new OpenCodeTurnFailure(OPENCODE_SETTINGS_MISSING_FAILURE);
    kept.folders.add(this.cwd);
  }

  // S2: OpenCode 2.1.4 loads plugins fail-open, lazily per folder, and a
  // project plugin with the same id displaces Isomux's, so before every
  // prompt the folder's plugin rows must show the Isomux plugin active and
  // alone with its id. An active row names the plugin's entry file; a row
  // whose load failed names the folder (gate sp-p3, 2026-10-25).
  private async requireSafetyPlugin(
    signal: AbortSignal,
    notice: EventSink,
  ): Promise<void> {
    const dir = openCodeSafetyPluginDir(this.lease!.profileDir);
    const ours = (row: Record<string, unknown>): boolean => {
      const source = asRecord(row.source);
      return (
        source.type === "local" &&
        (source.path === dir || source.path === join(dir, "index.js"))
      );
    };
    const refuse = () =>
      new OpenCodeTurnFailure(OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE);
    for (let waited = 0; ; waited += OPENCODE_LIST_POLL_MS) {
      const body: unknown = await this.withinDeadline(
        (bounded) =>
          this.request(folderPath("/api/plugin", this.cwd), {
            signal: bounded,
          }).then((r) => r.json()),
        { signal, notice },
      );
      const rows = listData(body).map(asRecord);
      const claimants = rows.filter(
        (row) => row.id === OPENCODE_SAFETY_PLUGIN_ID,
      );
      const own = rows.filter(ours);
      // Another row with the plugin's id, or two of them: an impostor.
      if (claimants.some((row) => !ours(row)) || claimants.length > 1)
        throw refuse();
      const states = own.map((row) => asRecord(row.state).status);
      if (states.some((state) => state !== "active" && state !== "loading"))
        throw refuse();
      if (
        own.some(
          (row) =>
            asRecord(row.state).status === "active" &&
            row.id === OPENCODE_SAFETY_PLUGIN_ID,
        )
      )
        return;
      // An empty list, our row loading, or no row of ours yet: the folder's
      // plugins still load (active after 357-1842 ms in 20 new folders,
      // 2026-10-25).
      if (waited >= this.eventStreamDeadlineMs) throw refuse();
      await this.pause(OPENCODE_LIST_POLL_MS, signal);
      if (signal.aborted || this.abortRequested) return;
    }
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
      const response = await fetch(new URL("/api/info", lease.baseUrl), {
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
        new Error(`OpenCode HTTP ${response.status} at ${url.pathname}.`),
        {
          statusCode: response.status,
        },
      );
    }
    return response;
  }

  private async classifyProviderFailure(
    error: SafeOpenCodeError,
    signal: AbortSignal,
  ): Promise<OpenCodeProviderFailure> {
    if (error.statusCode === 403) return "model_refused";
    if (error.statusCode === 401 || error.name === "provider.auth")
      return "authentication";
    if (error.name !== "provider.no-route") return null;
    // R4: 2.1.4 lists no provider for a moment after a start, and an
    // unknown model fails at once. An empty list is waited for, as the
    // catalog is; a list that stays empty decides nothing.
    try {
      for (let waited = 0; ; waited += OPENCODE_LIST_POLL_MS) {
        // A Stop or a close ends the wait: nothing reads the answer.
        if (signal.aborted || this.abortRequested) return null;
        const providers = listData(
          await this.request(folderPath("/api/provider", this.cwd), {
            signal,
          }).then((r) => r.json()),
        ).map(asRecord);
        if (providers.length > 0) {
          const provider = splitModel(this.model)[0];
          // A connected provider without the model: OpenCode no longer has it.
          return providers.some(
            (row) => row.id === provider && row.activation === "enabled",
          )
            ? "model_gone"
            : "provider_not_connected";
        }
        if (waited >= this.eventStreamDeadlineMs) return null;
        await this.pause(OPENCODE_LIST_POLL_MS, signal);
      }
    } catch {
      return null;
    }
  }

  // The sign-in line and its OPENCODE_API_KEY guidance only when that key
  // would fix the failure: a model of a provider the key serves that is not
  // free, on a server started without the key. Otherwise a free model's
  // refusal, a rejected key or another provider's failure would read as
  // missing sign-in (task 10a09ec8). OpenCode's own words go with either.
  private async signInFailure(
    error: SafeOpenCodeError,
    failure: "authentication" | "provider_not_connected",
  ): Promise<{ error: LogText; authNeeded: boolean; pickModel?: true }> {
    const provider = splitModel(this.model)[0];
    const words = providerText(error.message);
    const withWords = (line: LogText): LogText =>
      words === null
        ? line
        : joinLogText([line, openCodeProviderLine(provider, words)], "\n");
    if (await this.needsOpenCodeKey(provider))
      return { error: withWords(OPENCODE_AUTH_FAILURE), authNeeded: true };
    // A model of a connected provider fixes the turn.
    if (failure === "provider_not_connected")
      return {
        error: withWords(
          openCodeModelUnavailableFailure(this.model, words !== null),
        ),
        authNeeded: false,
        pickModel: true,
      };
    // Without OpenCode's words, another model is the fix that needs no
    // config.
    if (words === null)
      return {
        error: `OpenCode could not sign in to the provider of model \`${this.model}\`.`,
        authNeeded: false,
        pickModel: true,
      };
    return { error: openCodeProviderLine(provider, words), authNeeded: false };
  }

  private async needsOpenCodeKey(provider: string): Promise<boolean> {
    if (!OPENCODE_KEY_PROVIDERS.has(provider)) return false;
    if (this.lease?.hasLaunchVariable("OPENCODE_API_KEY") === true)
      return false;
    // A catalog that does not load, or a model it does not list, is not free.
    const models = await this.withinCatalogWait(this.catalog()).catch(() => []);
    return models.find((model) => model.id === this.model)?.isFree !== true;
  }
}

const TERMINAL_FRAMES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

// A route that serves one folder names it in the query.
function folderPath(path: string, cwd: string): string {
  return `${path}?${new URLSearchParams({ "location[directory]": cwd })}`;
}

function listData(raw: unknown): unknown[] {
  const data = asRecord(raw).data;
  return Array.isArray(data) ? data : [];
}

// The session a frame belongs to; a form names it inside the form.
function frameSession(frame: Record<string, unknown>): string | null {
  const data = asRecord(frame.data);
  return (
    stringField(data, "sessionID") ??
    stringField(asRecord(data.form), "sessionID")
  );
}

function sseFrames(events: object[]): Uint8Array {
  return new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

// The outcome of a session that went idle after this turn's input, or null:
// from GET /api/session/:id (its idle time is a server time, compared with
// the server time of the input's delivery), or from an idle item after the
// turn's own input in its messages.
function finishedAfterInput(
  session: Record<string, unknown>,
  messages: unknown[],
  turn: TurnInput,
): string | null {
  const idle = numberField(asRecord(session.time), "idle");
  const outcome = stringField(session, "outcome");
  if (
    turn.armed &&
    turn.deliveredAt !== undefined &&
    idle !== null &&
    idle >= turn.deliveredAt &&
    outcome
  )
    return outcome;
  if (turn.id === null) return null;
  const items = messages.map(asRecord);
  const input = items.findIndex(
    (item) => item.type === "user" && item.id === turn.id,
  );
  if (input < 0) return null;
  const after = items.slice(input + 1).find((item) => item.type === "idle");
  return after ? (stringField(after, "outcome") ?? null) : null;
}

// The terminal frame that a session's outcome stands for.
function outcomeFrame(
  sessionId: string,
  outcome: string,
  rejected: boolean,
): object {
  if (outcome === "succeeded")
    return {
      type: "session.execution.succeeded",
      data: { sessionID: sessionId },
    };
  if (outcome === "interrupted")
    return {
      type: "session.execution.interrupted",
      data: { sessionID: sessionId, reason: rejected ? "shutdown" : "user" },
    };
  return { type: "session.execution.failed", data: { sessionID: sessionId } };
}

// The open turn's answers from its messages, as the frames the stream sends
// for them: the assistant items after the turn's own input. Earlier ones
// belong to earlier turns. The loop takes from them only what it has not
// shown (R3): an ended part adds the text the stream missed, and a tool
// already called or ended is not shown again.
function turnReplayFrames(
  sessionId: string,
  raw: unknown[],
  inputId: string | null,
): object[] {
  if (inputId === null) return [];
  const items = raw.map(asRecord);
  const input = items.findIndex(
    (item) => item.type === "user" && item.id === inputId,
  );
  if (input < 0) return [];
  const frames: object[] = [];
  const frame = (type: string, data: Record<string, unknown>) =>
    frames.push({ type, data: { sessionID: sessionId, ...data } });
  for (const item of items.slice(input + 1)) {
    if (item.type !== "assistant") continue;
    const message = stringField(item, "id");
    if (!message) continue;
    const at = { assistantMessageID: message };
    const ordinals = { text: 0, reasoning: 0 };
    for (const part of Array.isArray(item.content)
      ? item.content.map(asRecord)
      : []) {
      if (part.type === "text" || part.type === "reasoning") {
        frame(`session.${part.type}.ended`, {
          ...at,
          ordinal: ordinals[part.type]++,
          text: stringField(part, "text") ?? "",
        });
        continue;
      }
      if (part.type !== "tool") continue;
      const id = stringField(part, "id");
      if (!id) continue;
      const state = asRecord(part.state);
      frame("session.tool.input.started", {
        ...at,
        id,
        name: stringField(part, "name") ?? "unknown",
      });
      const child = stringField(asRecord(state.metadata), "sessionID");
      if (child)
        frame("session.tool.progress", {
          ...at,
          id,
          metadata: { sessionID: child },
        });
      frame("session.tool.called", { ...at, id, input: asRecord(state.input) });
      if (state.status === "completed")
        frame("session.tool.success", {
          ...at,
          id,
          content: state.content,
          metadata: state.metadata,
        });
      else if (state.status === "error" || state.status === "failed")
        frame("session.tool.failed", { ...at, id, error: state.error });
    }
    if (numberField(asRecord(item.time), "completed") !== null)
      frame("session.step.ended", {
        ...at,
        tokens: item.tokens,
        cost: item.cost,
      });
  }
  return frames;
}

// A tool result's text items, one per line.
function toolText(content: unknown): string {
  return (Array.isArray(content) ? content.map(asRecord) : [])
    .filter((item) => item.type === "text")
    .map((item) => stringField(item, "text") ?? "")
    .join("\n");
}

// A step's tokens: the usage it bills and the context it fills. In 2.1.4
// input leaves out the cache and output leaves out reasoning (the mock's
// 11 prompt tokens with 2 cached arrive as input 9 and cache read 2,
// 2026-10-25). The bill keeps 1.18.35's fields; the summed total stands in
// for 1.18.35's tokens.total, the context of one answer step.
function allowTokens(
  raw: unknown,
): { usage: TokenUsage; context: OpenCodeContextBreakdown } | null {
  const tokens = asRecord(raw);
  const cache = asRecord(tokens.cache);
  const input = numberField(tokens, "input");
  const output = numberField(tokens, "output");
  if (input === null || output === null) return null;
  const reasoning = numberField(tokens, "reasoning") ?? 0;
  const cacheRead = numberField(cache, "read") ?? 0;
  const cacheWrite = numberField(cache, "write") ?? 0;
  return {
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
    },
    context: {
      totalTokens: input + output + reasoning + cacheRead + cacheWrite,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
    },
  };
}

export function splitModel(model: string): [string, string] {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new Error("OpenCode model must use provider/model form.");
  }
  return [model.slice(0, slash), model.slice(slash + 1)];
}

// The rows of GET /api/model: 2.1.4 lists the enabled models of the
// providers it can use (gate E4a).
export function allowDiscoveredModels(raw: unknown): DiscoveredOpenCodeModel[] {
  const byId = new Map<string, DiscoveredOpenCodeModel>();
  for (const model of listData(raw).map(asRecord)) {
    if (model.enabled !== true || model.status !== "active") continue;
    const providerId = stringField(model, "providerID");
    if (!providerId || !safeCatalogId(providerId)) continue;
    const rawModelId =
      stringField(model, "modelID") ?? stringField(model, "id");
    if (!rawModelId) continue;
    const modelId = rawModelId.startsWith(`${providerId}/`)
      ? rawModelId.slice(providerId.length + 1)
      : rawModelId;
    if (!modelId || !safeCatalogId(modelId)) continue;
    const id = `${providerId}/${modelId}`;
    const modelLabel = safeCatalogLabel(model.name, modelId);
    const contextLimit = positiveNumber(asRecord(model.limit), "context");
    const inputLimit = positiveNumber(asRecord(model.limit), "input");
    const outputLimit = positiveNumber(asRecord(model.limit), "output");
    const variants = new Set(
      (Array.isArray(model.variants) ? model.variants.map(asRecord) : [])
        .map((variant) => variant.id)
        .filter((value): value is string => typeof value === "string"),
    );
    const supportedEfforts = EFFORT_LEVELS.filter(({ level }) =>
      variants.has(level),
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
            : `${providerId} - ${modelLabel}`,
        ...(contextLimit !== null ? { contextLimit } : {}),
        ...(inputLimit !== null ? { inputLimit } : {}),
        ...(outputLimit !== null ? { outputLimit } : {}),
        ...(openCodeModelIsFree(model.cost) ? { isFree: true } : {}),
        supportedEfforts,
      });
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
  const id = stringField(asRecord(asRecord(raw).data), "id");
  if (!id) throw new Error("OpenCode returned an invalid session shape.");
  return { id };
}

// The member's messages and the model's answers. The items OpenCode writes
// itself (a model or agent switch, an idle marker, an instruction update)
// are not part of the conversation, and no fork can target them.
export function allowMessages(raw: unknown): NormalizedMessage[] {
  if (!Array.isArray(raw)) {
    throw new Error("OpenCode returned an invalid message list.");
  }
  const messages: NormalizedMessage[] = [];
  for (const value of raw) {
    const item = asRecord(value);
    if (item.type !== "user" && item.type !== "assistant") continue;
    const uuid = stringField(item, "id");
    if (!uuid) throw new Error("OpenCode returned an invalid message shape.");
    const text =
      item.type === "user"
        ? (stringField(item, "text") ?? "")
        : (Array.isArray(item.content) ? item.content.map(asRecord) : [])
            .filter((part) => part.type === "text")
            .map((part) => stringField(part, "text") ?? "")
            .join("");
    messages.push({ uuid, role: item.type, text });
  }
  return messages;
}

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
  | "environment"
  | "mcp"
  | "config"
  | "safety_plugin"
  | "permissions"
  | "agent"
  | "instructions"
  | "model"
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
  // the member has not answered, a running tool, a provider retry, a model
  // step that has not ended, or none of these.
  waitingOn:
    | "prompt_not_sent"
    | "permission"
    | "tool"
    | "retry"
    | "model"
    | "none";
  tools?: string[];
  permissions?: string[];
  // The retry's number: 1 for the first retry.
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

// name: the 2.1.4 error type of an OpenCode failure ("provider.auth"), or a
// reviewed class name of a local one.
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
  const status = value.statusCode;
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

function parseFrame(data: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

// OpenCode names (event, tool and permission types) go to the journal only
// in this shape, so no free text from OpenCode or a provider reaches it.
function safeJournalName(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,80}$/.test(value)
    ? value
    : "unknown";
}

function positiveNumber(record: Record<string, unknown>, field: string) {
  const value = numberField(record, field);
  return value !== null && value > 0 ? value : null;
}

// A 2.1.4 structured error {type, message, status, response}. The response
// body is the provider's raw answer and is never read (T10).
function allowError(value: unknown): SafeOpenCodeError {
  const error = asRecord(value);
  const status = error.status;
  return {
    ...(typeof error.type === "string" ? { name: error.type } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { statusCode: status }
      : {}),
  };
}

export type OpenCodeProviderFailure =
  | "authentication"
  | "model_refused"
  | "model_gone"
  | "provider_not_connected"
  | null;

// The providers OPENCODE_API_KEY signs in to: OpenCode Zen and OpenCode Go.
const OPENCODE_KEY_PROVIDERS = new Set(["opencode", "opencode-go"]);

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
