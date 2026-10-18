import { join } from "node:path";
import { logOpenCodeError, logOpenCodeStreamSilence } from "./errors.ts";
// OpenCode backend boundary. The production singleton uses the pinned OC1
// server transport. createOpenCodeTracerBackend remains as the deterministic
// no-process test double that proved the S1a orchestrator seam.

import type {
  ApprovalDecision,
  AttachmentSpec,
  Backend,
  BackendCapabilities,
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
  SessionAccessOptions,
  SessionEnvironmentOptions,
  StoredSessionState,
  SubscriptionUsageResult,
} from "../types.ts";
import { OPENCODE_TRACER_MODEL } from "../../../shared/types.ts";
import {
  discoverOpenCodeModels,
  OPENCODE_AUTH_FAILURE,
  OpenCodeTransport,
  splitModel,
  type OpenCodeContextBreakdown,
  type OpenCodeSafeErrorSink,
  type OpenCodeStreamSilenceSink,
} from "./transport.ts";
import {
  OPENCODE_CRON_AGENT,
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  openCodeSupervisorForEnvironment,
  updateOpenCodeSupervisorSettings,
  type OpenCodeSupervisor,
} from "./supervisor.ts";
import { inspectOpenCodeStoredSession } from "./storage.ts";
import { getAgentHost } from "../../agent-host.ts";
import { AGENT_ROOT } from "../../split/roots.ts";

// The folder topic labels run in. The agent's folder would apply its project
// config, plugins and AGENTS.md to a labelling call; Claude's one-shot uses a
// neutral cwd and no settings layers too. It is in agent space: in the default
// install that is the state root, which the office safety policy keeps agents
// from writing; in split mode the policy does not cover it.
export const OPENCODE_ONE_SHOT_DIR = join(AGENT_ROOT, "opencode", "one-shot");
import {
  formatAttachmentLines,
  resolveAttachmentNotices,
} from "../../attachment-prompt.ts";

const AUTH_GUIDANCE =
  "Add `OPENCODE_API_KEY` on the Integrations page (Variables tab), then `/clear`, or use an agent with the Claude or Codex backend.";

// Where OpenCode compacts a session on its own, on its default path:
// SessionCompaction.isOverflow fires when a step's total tokens reach the
// usable window, which is limit.input - min(20000, maxOutput) when the model
// has an input limit and limit.context - maxOutput otherwise, with maxOutput =
// min(limit.output, 32000) or 32000 when the output limit is 0. Off that path:
// config compaction.auto = false turns it off, compaction.reserved replaces
// the 20000 buffer, and the env var OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX
// replaces 32000. The config Isomux writes (supervisor.ts) sets none of them;
// Isomux does not read a member's own OpenCode config or that env var.
// Source checked: vn() and yy() in the JavaScript bundled in OpenCode 1.18.35
// (2026-10-14). The window the sample's percentage uses is limit.context.
const OPENCODE_COMPACTION_BUFFER = 20_000;
const OPENCODE_OUTPUT_TOKEN_MAX = 32_000;
export function openCodeAutoCompactTokens(limits: {
  context: number;
  input?: number;
  output?: number;
}): number {
  const maxOutput =
    Math.min(limits.output ?? 0, OPENCODE_OUTPUT_TOKEN_MAX) ||
    OPENCODE_OUTPUT_TOKEN_MAX;
  if (limits.input)
    return Math.max(
      0,
      limits.input - Math.min(OPENCODE_COMPACTION_BUFFER, maxOutput),
    );
  return Math.max(0, limits.context - maxOutput);
}

const CAPABILITIES: BackendCapabilities = {
  fork: true,
  hooks: false,
  skills: false,
  canUseTool: true,
  // oneShotPrompt supports topic generation.
  topicGen: true,
  edit: true,
  mcp: false,
  autoHandoff: true,
  // No engine signal for a usage limit stop and its reset time.
  limitResume: false,
};
const TRACER_CAPABILITIES: BackendCapabilities = {
  ...CAPABILITIES,
  fork: false,
  edit: false,
  canUseTool: false,
  topicGen: false,
  autoHandoff: false,
};

const TRACER_MODELS: ModelOption[] = [
  { value: OPENCODE_TRACER_MODEL, label: "OpenCode tracer" },
];

const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", label: "Ask" },
  { value: "bypassPermissions", label: "Bypass all permissions" },
];

export function permissionAgent(
  opts: Pick<CreateSessionOptions, "permissionMode" | "interactive">,
): string | undefined {
  if (opts.permissionMode === "bypassPermissions") {
    return opts.interactive === true
      ? OPENCODE_INTERACTIVE_BYPASS_AGENT
      : OPENCODE_CRON_AGENT;
  }
  return undefined;
}

interface TracerOptions {
  failAuth?: boolean;
}

export interface OpenCodeBackendOptions {
  supervisor?: OpenCodeSupervisor;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: OpenCodeSafeErrorSink;
  streamSilenceSink?: OpenCodeStreamSilenceSink;
  bindingAgentSink?: (sessionId: string, agent: string | undefined) => void;
  oneShotTimeoutMs?: number;
}

// Free gateway models were measured at 2-6 s on a good run and 37-190 s on
// a slow one (2026-10-17); the agent manager backs off after a failure.
const ONE_SHOT_TIMEOUT_MS = 120_000;
const ONE_SHOT_CLEANUP_TIMEOUT_MS = 1_000;

function productionModel(model: string): string {
  if (model === OPENCODE_TRACER_MODEL) {
    throw new Error(
      "This OpenCode agent uses the retired tracer model. Open agent settings and select a connected model.",
    );
  }
  splitModel(model);
  return model;
}

class OpenCodeServerSession implements BackendSession {
  private readonly events: NormalizedEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private readonly transport: OpenCodeTransport;
  private readonly agentId: string;
  private latestContextBreakdown: OpenCodeContextBreakdown | null = null;

  constructor(
    opts: CreateSessionOptions,
    model: string,
    supervisor: OpenCodeSupervisor,
    sessionId?: string,
    contractShapeSink?: (shape: string) => void,
    safeErrorSink?: OpenCodeSafeErrorSink,
    private readonly onSessionId?: (sessionId: string) => void,
    streamSilenceSink?: OpenCodeStreamSilenceSink,
  ) {
    this.agentId = opts.agentId;
    this.transport = new OpenCodeTransport({
      cwd: opts.cwd,
      model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
      agentToken: opts.env?.ISOMUX_AGENT_TOKEN,
      agentId: opts.agentId,
      agent: permissionAgent(opts),
      supervisor,
      sessionId,
      contractShapeSink,
      safeErrorSink,
      streamSilenceSink,
      words: opts.words,
      completedStepSink: (breakdown) => {
        this.latestContextBreakdown = breakdown;
      },
    });
  }

  private push = (event: NormalizedEvent): void => {
    if (this.ended) return;
    if (event.kind === "system_init" && event.sessionId) {
      this.onSessionId?.(event.sessionId);
    }
    this.events.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  };

  async *stream(): AsyncIterable<NormalizedEvent> {
    while (true) {
      while (this.events.length > 0) yield this.events.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const breakdown = this.latestContextBreakdown;
    if (!breakdown) return null;
    let limits: Awaited<ReturnType<OpenCodeTransport["getModelLimits"]>>;
    try {
      limits = await this.transport.getModelLimits();
    } catch {
      return null;
    }
    if (limits === null) return null;
    const maxTokens = limits.context;
    return {
      model: this.transport.modelId(),
      totalTokens: breakdown.totalTokens,
      maxTokens,
      percentage: Math.min(100, (breakdown.totalTokens / maxTokens) * 100),
      categories: [
        { name: "Input", tokens: breakdown.inputTokens },
        { name: "Cached input", tokens: breakdown.cacheReadInputTokens },
        {
          name: "Cache creation",
          tokens: breakdown.cacheCreationInputTokens,
        },
        { name: "Output", tokens: breakdown.outputTokens },
        { name: "Reasoning", tokens: breakdown.reasoningTokens },
      ],
      compactAtTokens: openCodeAutoCompactTokens(limits),
    };
  }

  async getSubscriptionUsage(_options?: {
    forceRefresh?: boolean;
  }): Promise<SubscriptionUsageResult> {
    return { kind: "unavailable" };
  }

  async send(text: string, attachments?: AttachmentSpec[]): Promise<void> {
    await this.transport.send(
      buildOpenCodePromptParts(text, attachments, this.agentId),
      this.push,
    );
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.transport.approve(approvalId, decision);
  }

  async abort(): Promise<void> {
    await this.transport.abort();
  }

  canAbortInPlace(): boolean {
    return this.transport.canAbortInPlace();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.transport.close();
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async deleteStoredSession(): Promise<void> {
    await this.transport.deleteSession();
  }
}

export function buildOpenCodePromptParts(
  text: string,
  attachments: AttachmentSpec[] | undefined,
  agentId: string,
): Array<{ type: "text"; text: string }> {
  const parts: Array<{ type: "text"; text: string }> = [];
  if (text) parts.push({ type: "text", text });
  const lines = formatAttachmentLines(
    resolveAttachmentNotices(agentId, attachments ?? []),
  );
  if (lines.length > 0) parts.push({ type: "text", text: lines.join("\n") });
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

class OpenCodeTracerSession implements BackendSession {
  private readonly events: NormalizedEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(
    private readonly sessionId: string,
    private readonly failAuth: boolean,
  ) {
    this.push({
      kind: "system_init",
      sessionId,
      model: OPENCODE_TRACER_MODEL,
    });
  }

  private push(event: NormalizedEvent): void {
    if (this.ended) return;
    this.events.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *stream(): AsyncIterable<NormalizedEvent> {
    while (true) {
      while (this.events.length > 0) yield this.events.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return null;
  }

  async getSubscriptionUsage(_options?: {
    forceRefresh?: boolean;
  }): Promise<SubscriptionUsageResult> {
    return { kind: "unavailable" };
  }

  async send(_text: string, _attachments?: AttachmentSpec[]): Promise<void> {
    if (this.failAuth) {
      this.push({
        kind: "turn_completed",
        status: "failed",
        error: OPENCODE_AUTH_FAILURE,
      });
      return;
    }
    this.push({
      kind: "assistant_text",
      text: "OpenCode tracer reply.",
    });
    this.push({ kind: "turn_completed", status: "completed" });
  }

  async approve(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    throw new Error(
      "OpenCode permissions are not available in the tracer backend.",
    );
  }

  async abort(): Promise<void> {}

  canAbortInPlace(): boolean {
    return false;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

export function createOpenCodeTracerBackend(
  options: TracerOptions = {},
): Backend {
  let nextSessionId = 0;
  return {
    capabilities: TRACER_CAPABILITIES,

    getModelOptions(): ModelOption[] {
      return TRACER_MODELS;
    },

    getPermissionModes(): PermissionModeOption[] {
      return PERMISSION_MODES;
    },

    async listModels(_opts: ListModelsOptions): Promise<BackendModel[]> {
      return [
        {
          id: OPENCODE_TRACER_MODEL,
          label: "OpenCode tracer",
          isDefault: true,
          supportedEfforts: [],
        },
      ];
    },

    createSession(_opts: CreateSessionOptions): BackendSession {
      return new OpenCodeTracerSession(
        `opencode-tracer-${++nextSessionId}`,
        options.failAuth ?? false,
      );
    },

    resumeSession(
      sessionId: string,
      _opts: CreateSessionOptions,
    ): BackendSession {
      return new OpenCodeTracerSession(sessionId, options.failAuth ?? false);
    },

    inspectStoredSession(
      _sessionId: string,
      _opts: { cwd: string; env?: Record<string, string | undefined> },
    ): StoredSessionState {
      return "durable";
    },

    checkSessionResumable(): string | null {
      return null;
    },

    async forkSessionBeforeMessage(): Promise<ForkSessionBeforeMessageResult> {
      return { kind: "fresh" };
    },

    async getSessionMessages(): Promise<NormalizedMessage[]> {
      return [];
    },

    async oneShotPrompt(
      _prompt: string,
      _opts: OneShotOptions,
    ): Promise<string> {
      throw new Error(
        "OpenCode one-shot prompts are not available in the tracer backend.",
      );
    },

    detectAuthError(text: string): boolean {
      return text.includes(OPENCODE_AUTH_FAILURE);
    },

    async getLoginInstructions() {
      return {
        kind: "login",
        cardEligible: false,
        text: AUTH_GUIDANCE,
      };
    },
  };
}

export function createOpenCodeBackend(
  options: OpenCodeBackendOptions = {},
): Backend {
  const safeErrorSink = options.safeErrorSink ?? logOpenCodeError;
  const streamSilenceSink =
    options.streamSilenceSink ?? logOpenCodeStreamSilence;
  const bindings = new Map<
    string,
    {
      cwd: string;
      supervisor: OpenCodeSupervisor;
      model: string;
      agent?: string;
    }
  >();
  const setBinding = (
    sessionId: string,
    binding: {
      cwd: string;
      supervisor: OpenCodeSupervisor;
      model: string;
      agent?: string;
    },
  ) => {
    bindings.set(sessionId, binding);
    options.bindingAgentSink?.(sessionId, binding.agent);
  };
  const supervisorFor = (
    opts: SessionEnvironmentOptions,
  ): OpenCodeSupervisor => {
    if (options.supervisor) return options.supervisor;
    if (!opts.environmentKey) {
      throw new Error("OpenCode session environment identity is required.");
    }
    return openCodeSupervisorForEnvironment(
      opts.environmentKey,
      opts.env,
      opts.environmentRevision,
      opts.mcpServers,
    );
  };
  const transportForSession = (sessionId: string): OpenCodeTransport => {
    const binding = bindings.get(sessionId);
    if (!binding) {
      throw new Error(
        "OpenCode session is not bound to this Isomux agent process.",
      );
    }
    return new OpenCodeTransport({
      cwd: binding.cwd,
      model: binding.model,
      agent: binding.agent,
      supervisor: binding.supervisor,
      sessionId,
      contractShapeSink: options.contractShapeSink,
      safeErrorSink,
    });
  };
  const bindSession = (
    sessionId: string,
    cwd: string,
    access: SessionAccessOptions | undefined,
  ): {
    cwd: string;
    supervisor: OpenCodeSupervisor;
    model: string;
    agent?: string;
  } => {
    const existing = bindings.get(sessionId);
    if (existing) return existing;
    if (!access) {
      throw new Error(
        "OpenCode session access requires its model and environment identity.",
      );
    }
    const agent = permissionAgent(access);
    const binding = {
      cwd,
      supervisor: supervisorFor(access),
      model: productionModel(access.modelFamily),
      ...(agent ? { agent } : {}),
    };
    setBinding(sessionId, binding);
    return binding;
  };
  return {
    capabilities: CAPABILITIES,
    getModelOptions: () => [],
    getPermissionModes: () => PERMISSION_MODES,
    updateSavedSettings: (opts) => {
      if (options.supervisor) return;
      updateOpenCodeSupervisorSettings(
        opts.environmentKey,
        opts.env,
        opts.environmentRevision,
        opts.mcpServers,
      );
    },
    async listModels(opts: ListModelsOptions): Promise<BackendModel[]> {
      const supervisor = supervisorFor(opts);
      const models = await discoverOpenCodeModels(supervisor, opts.cwd);
      return models.map(({ contextLimit: _contextLimit, ...entry }) => ({
        ...entry,
      }));
    },
    createSession(opts: CreateSessionOptions): BackendSession {
      const model = productionModel(opts.modelFamily);
      const supervisor = supervisorFor(opts);
      const agent = permissionAgent(opts);
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        undefined,
        options.contractShapeSink,
        safeErrorSink,
        (sessionId) =>
          setBinding(sessionId, { cwd: opts.cwd, supervisor, model, agent }),
        streamSilenceSink,
      );
    },
    resumeSession(
      sessionId: string,
      opts: CreateSessionOptions,
    ): BackendSession {
      const model = productionModel(opts.modelFamily);
      const supervisor = supervisorFor(opts);
      const agent = permissionAgent(opts);
      setBinding(sessionId, { cwd: opts.cwd, supervisor, model, agent });
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        sessionId,
        options.contractShapeSink,
        safeErrorSink,
        (resolvedSessionId) =>
          setBinding(resolvedSessionId, {
            cwd: opts.cwd,
            supervisor,
            model,
            agent,
          }),
        streamSilenceSink,
      );
    },
    inspectStoredSession(sessionId, opts): StoredSessionState {
      return inspectOpenCodeStoredSession(sessionId, opts.environmentKey);
    },
    checkSessionResumable(sessionId, opts): string | null {
      const state = inspectOpenCodeStoredSession(
        sessionId,
        opts.environmentKey,
      );
      if (state === "durable") return null;
      return state === "empty"
        ? `Cannot resume OpenCode session ${sessionId}: it has no stored messages.`
        : `Cannot resume OpenCode session ${sessionId}: it is missing from the selected OpenCode profile.`;
    },
    async forkSessionBeforeMessage(
      sessionId: string,
      targetMessageId: string | null,
      access?: SessionAccessOptions,
    ): Promise<ForkSessionBeforeMessageResult> {
      const parent = bindSession(sessionId, access?.cwd ?? "", access);
      const transport = transportForSession(sessionId);
      try {
        const childId = await transport.forkAtMessage(targetMessageId);
        setBinding(childId, parent);
        return {
          kind: "fork",
          sessionId: childId,
          forkedFromSessionId: sessionId,
        };
      } finally {
        transport.close();
      }
    },
    async getSessionMessages(
      sessionId: string,
      cwd: string,
      access?: SessionAccessOptions,
    ): Promise<NormalizedMessage[]> {
      bindSession(sessionId, cwd, access);
      const transport = transportForSession(sessionId);
      try {
        return await transport.getSessionMessages();
      } finally {
        transport.close();
      }
    },
    async oneShotPrompt(prompt: string, opts: OneShotOptions): Promise<string> {
      if (!options.supervisor && !opts.environmentKey) {
        throw new Error(
          "OpenCode one-shot prompt environment identity is required.",
        );
      }
      const supervisor = supervisorFor(opts);
      await getAgentHost().fs.mkdir(OPENCODE_ONE_SHOT_DIR, 0o777);
      const models = await discoverOpenCodeModels(
        supervisor,
        OPENCODE_ONE_SHOT_DIR,
      );
      // Topic text must use the same selection as a live session. Never pick
      // a default or another discovered model when that selection is missing.
      const selected = models.find((model) => model.id === opts.modelFamily);
      if (!selected) {
        throw new Error("OpenCode one-shot selected model is unavailable.");
      }
      const model = productionModel(selected.id);
      const session = new OpenCodeServerSession(
        {
          agentId: "isomux-opencode-one-shot",
          cwd: OPENCODE_ONE_SHOT_DIR,
          systemPrompt: opts.systemPrompt ?? "",
          modelFamily: model,
          effort: "high",
          permissionMode: "default",
          env: opts.env,
          environmentKey: opts.environmentKey,
          environmentRevision: opts.environmentRevision,
        },
        model,
        supervisor,
        undefined,
        options.contractShapeSink,
        safeErrorSink,
        undefined,
        streamSilenceSink,
      );
      const timeoutError = new Error("OpenCode one-shot prompt timed out.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const completion = (async () => {
          let text = "";
          for await (const event of session.stream()) {
            if (event.kind === "assistant_text") text += event.text;
            if (event.kind === "approval_request") {
              await session.approve(event.approvalId, {
                kind: "deny",
                reason: "One-shot prompts cannot run tools.",
              });
            }
            if (event.kind === "input_request") {
              void session.abort();
              throw new Error(
                "OpenCode one-shot prompt requested interactive input.",
              );
            }
            if (event.kind === "turn_completed") {
              if (event.status !== "completed") {
                throw new Error(
                  event.error ?? "OpenCode one-shot prompt failed.",
                );
              }
              return text;
            }
          }
          throw new Error("OpenCode one-shot prompt ended without completion.");
        })();
        const run = Promise.all([session.send(prompt), completion]).then(
          ([, text]) => text,
        );
        return await Promise.race([
          run,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              void session.abort();
              reject(timeoutError);
            }, options.oneShotTimeoutMs ?? ONE_SHOT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        await Promise.race([
          session.deleteStoredSession().catch(() => undefined),
          Bun.sleep(ONE_SHOT_CLEANUP_TIMEOUT_MS),
        ]);
        session.close();
      }
    },
    detectAuthError(text: string): boolean {
      return text.includes(OPENCODE_AUTH_FAILURE);
    },
    async getLoginInstructions() {
      return {
        kind: "login",
        cardEligible: false,
        text: AUTH_GUIDANCE,
      };
    },
  };
}

export const opencodeBackend = createOpenCodeBackend();
