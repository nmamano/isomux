import { join } from "node:path";
import {
  logOpenCodeError,
  logOpenCodeStreamSilence,
  OpenCodeFreeLimitError,
} from "./errors.ts";
// OpenCode backend boundary. The production singleton uses the pinned OC1
// server transport.

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
  NormalizedEvent,
  NormalizedMessage,
  OneShotOptions,
  PermissionModeOption,
  SessionAccessOptions,
  SessionEnvironmentOptions,
  StoredSessionState,
  SubscriptionUsageResult,
} from "../types.ts";
import {
  msg,
  renderLogText,
  type LogMessage,
} from "../../../shared/i18n/log-message.ts";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import { OPENCODE_TRACER_MODEL } from "../../../shared/types.ts";
import {
  detectOpenCodeAuthError,
  discoverOpenCodeModels,
  OpenCodeTransport,
  splitModel,
  type OpenCodeContextBreakdown,
  type OpenCodePromptPart,
  type OpenCodeSafeErrorSink,
} from "./transport.ts";
import {
  OPENCODE_CRON_AGENT,
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  openCodeSupervisorForEnvironment,
  reloadOpenCodeServer,
  updateOpenCodeSupervisorSettings,
  awaitOpenCodeServerSettings,
  type OpenCodeSupervisor,
} from "./supervisor.ts";
import { inspectOpenCodeProfileSession } from "./storage.ts";
import {
  findOpenCodeSessionProfile,
  moveOpenCodeSession,
  moveOpenCodeSessionAcross,
} from "./session-transfer.ts";
import {
  belowStandard,
  stopHasFolder,
  stopHasPack,
  type AgentAccess,
} from "../../../shared/agent-access.ts";
import {
  OPENCODE_EMPTY_CWD_ROOT,
  OPENCODE_LIMITED_ONE_SHOT_DIR,
  openCodeBelowStandardRefusal,
  openCodeEmptyCwd,
  openCodeLaunchEnvFor,
  openCodeProfileKey,
  openCodeStopAgent,
  openCodeStopRules,
} from "./access.ts";
import { makeEmptyFolder } from "../empty-folder-host.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import type { OpenCodeLimitedSession } from "./transport.ts";
import { getAgentHost } from "../../agent-host.ts";
import { AGENT_ROOT } from "../../split/roots.ts";

// The folder topic labels run in. The agent's folder would apply its project
// config, plugins and AGENTS.md to a labelling call; Claude's one-shot uses a
// neutral cwd and no settings layers too. It is in agent space: in the default
// install that is the state root, which the office safety policy keeps agents
// from writing; in split mode the policy does not cover it.
export const OPENCODE_ONE_SHOT_DIR = join(AGENT_ROOT, "opencode", "one-shot");
import {
  copyAttachmentsInto,
  formatAttachmentLines,
  inlineImages,
  resolveAttachmentNotices,
  type AttachmentDelivery,
} from "../../attachment-prompt.ts";

function authGuidance(): LogMessage {
  return msg("systemEntries.loginInstructions.openCode");
}

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
  skills: true,
  canUseTool: true,
  // oneShotPrompt supports topic generation.
  topicGen: true,
  edit: true,
  mcp: false,
  autoHandoff: true,
  // No engine signal for a usage limit stop and its reset time.
  limitResume: false,
};
const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", label: "Ask" },
  { value: "bypassPermissions", label: "Bypass all permissions" },
];

function permissionAgent(
  opts: Pick<CreateSessionOptions, "permissionMode" | "interactive">,
): string | undefined {
  if (opts.permissionMode === "bypassPermissions") {
    return opts.interactive === true
      ? OPENCODE_INTERACTIVE_BYPASS_AGENT
      : OPENCODE_CRON_AGENT;
  }
  return undefined;
}

export interface OpenCodeBackendOptions {
  supervisor?: OpenCodeSupervisor;
  // The supervisor of a profile key, with the env, revision and MCP servers
  // a session start gives it (openCodeSupervisorForEnvironment). Wins over
  // `supervisor`. A test seam: the key says which server a session runs on.
  supervisorForEnvironment?: (
    environmentKey: string,
    env: Record<string, string | undefined> | undefined,
    environmentRevision: string | undefined,
    mcpServers: AgentMcpServer[] | undefined,
  ) => OpenCodeSupervisor;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: OpenCodeSafeErrorSink;
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

// Where and how a session runs, from its stop (task e77304b1). Below
// standard: the stop's agent and rules, the empty folder at chat and office,
// the session's own MCP servers, and how attachments reach it. prepare runs
// before the session is created or resumed.
interface OpenCodeSessionSetup {
  cwd: string;
  agent: string | undefined;
  limited?: OpenCodeLimitedSession;
  prepare?: () => Promise<void>;
  delivery?: AttachmentDelivery;
}

class OpenCodeServerSession implements BackendSession {
  private readonly events: NormalizedEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private readonly transport: OpenCodeTransport;
  private readonly agentId: string;
  private readonly delivery: AttachmentDelivery | undefined;
  private latestContextBreakdown: OpenCodeContextBreakdown | null = null;

  constructor(
    opts: CreateSessionOptions,
    model: string,
    supervisor: OpenCodeSupervisor,
    sessionId?: string,
    contractShapeSink?: (shape: string) => void,
    safeErrorSink?: OpenCodeSafeErrorSink,
    private readonly onSessionId?: (sessionId: string) => void,
    setup: OpenCodeSessionSetup = {
      cwd: opts.cwd,
      agent: permissionAgent(opts),
    },
  ) {
    this.agentId = opts.agentId;
    this.delivery = setup.delivery;
    this.transport = new OpenCodeTransport({
      cwd: setup.cwd,
      model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
      agentToken: opts.env?.ISOMUX_AGENT_TOKEN,
      agentId: opts.agentId,
      agent: setup.agent,
      supervisor,
      sessionId,
      limited: setup.limited,
      prepare: setup.prepare,
      // 1010dd4b: this conversation's shell commands get the member's env
      // as it was when the conversation started, as for Claude and Codex.
      toolEnvironment: supervisor.toolEnvironment(opts.env),
      contractShapeSink,
      safeErrorSink,
      streamSilenceSink: logOpenCodeStreamSilence,
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
      this.delivery
        ? limitedPromptParts(text, attachments, this.agentId, this.delivery)
        : buildOpenCodePromptParts(text, attachments, this.agentId),
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

// A file of a prompt below standard: an inline image at chat and office, as
// a data: URI. The prompt never carries another scheme: 2.1.4 reads a
// file: URI from the server's disk.
export interface OpenCodePromptFile {
  uri: string;
  mime: string;
  name: string;
}

// The files and notices a prompt below standard carries for `attachments`
// under `delivery`: inline-images, the images as data: URIs (every other
// file is left out); copy, no file, and the notices name the copies in the
// folder.
export function openCodePromptAttachments(
  agentId: string,
  attachments: AttachmentSpec[],
  delivery: AttachmentDelivery,
): { files: OpenCodePromptFile[]; text: string | null } {
  if (delivery.kind === "copy") {
    const lines = formatAttachmentLines(
      copyAttachmentsInto(agentId, attachments, delivery.folder),
    );
    return { files: [], text: lines.length > 0 ? lines.join("\n") : null };
  }
  const files: OpenCodePromptFile[] = [];
  for (const spec of attachments)
    for (const image of inlineImages(agentId, [spec]))
      files.push({
        uri: `data:${image.mediaType};base64,${image.data}`,
        mime: image.mediaType,
        name: spec.originalName,
      });
  return { files, text: null };
}

// The prompt parts of a session below standard: the text, the notices of
// the copies at folder and web, the inline images at chat and office.
function limitedPromptParts(
  text: string,
  attachments: AttachmentSpec[] | undefined,
  agentId: string,
  delivery: AttachmentDelivery,
): OpenCodePromptPart[] {
  const { files, text: notes } = openCodePromptAttachments(
    agentId,
    attachments ?? [],
    delivery,
  );
  return [
    { type: "text", text },
    ...(notes ? [{ type: "text" as const, text: notes }] : []),
    ...files.map((file) => ({ type: "file" as const, ...file })),
  ];
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

export function createOpenCodeBackend(
  options: OpenCodeBackendOptions = {},
): Backend {
  const safeErrorSink = options.safeErrorSink ?? logOpenCodeError;
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
  // The server of the session's stop: the member's own at standard, the
  // member's limited server below it (project config off, no MCP server in
  // the server's list: the office server carries one agent's token and goes
  // into that agent's folder only). Never one for the other.
  const supervisorFor = (
    opts: SessionEnvironmentOptions,
  ): OpenCodeSupervisor => {
    const below = opts.access !== undefined && belowStandard(opts.access);
    const env = below
      ? openCodeLaunchEnvFor(opts.env ?? {}, opts.access)
      : opts.env;
    const mcpServers = below ? [] : opts.mcpServers;
    if (options.supervisorForEnvironment) {
      if (!opts.environmentKey)
        throw new Error("OpenCode session environment identity is required.");
      return options.supervisorForEnvironment(
        openCodeProfileKey(opts.environmentKey, opts.access),
        env,
        opts.environmentRevision,
        mcpServers,
      );
    }
    if (options.supervisor) return options.supervisor;
    if (!opts.environmentKey) {
      throw new Error("OpenCode session environment identity is required.");
    }
    return openCodeSupervisorForEnvironment(
      openCodeProfileKey(opts.environmentKey, opts.access),
      env,
      opts.environmentRevision,
      mcpServers,
      opts.skillPaths,
    );
  };
  // The stop on the other side of the standard line.
  const otherSide = (access: AgentAccess | undefined): AgentAccess =>
    access !== undefined && belowStandard(access) ? "standard" : "chat";
  const sessionState = (
    sessionId: string,
    environmentKey: string,
    access: AgentAccess | undefined,
  ): StoredSessionState =>
    inspectOpenCodeProfileSession(
      openCodeProfilePaths(openCodeProfileKey(environmentKey, access))
        .profileDir,
      sessionId,
    );
  // A session is stored on the side of the stop it last ran at. At a start
  // or resume on this side, a copy on the other side is the latest: it moves
  // here first, and a failed move refuses the start.
  const moveHere = async (
    sessionId: string,
    opts: SessionEnvironmentOptions,
  ): Promise<void> => {
    if (!opts.environmentKey) return;
    const other = otherSide(opts.access);
    if (sessionState(sessionId, opts.environmentKey, other) === "missing")
      return;
    await moveOpenCodeSessionAcross({
      sessionId,
      from: supervisorFor({ ...opts, access: other, mcpServers: undefined }),
      to: supervisorFor(opts),
    });
  };
  // Where and how a session at the stop of `opts` runs.
  const setupFor = (
    opts: CreateSessionOptions,
    sessionId?: string,
  ): OpenCodeSessionSetup => {
    const access = opts.access;
    if (access === undefined || !belowStandard(access))
      return {
        cwd: opts.cwd,
        agent: permissionAgent(opts),
        ...(sessionId ? { prepare: () => moveHere(sessionId, opts) } : {}),
      };
    const folder = stopHasFolder(access);
    return {
      // Chat and office have no file tools: a folder Isomux makes, empty.
      cwd: folder ? opts.cwd : join(OPENCODE_EMPTY_CWD_ROOT, opts.agentId),
      // Plan and bypass agents never run below standard.
      agent: openCodeStopAgent(access) ?? undefined,
      limited: {
        rules: openCodeStopRules(
          access,
          stopHasPack(access) ? (opts.officeTools ?? []) : [],
        ),
        mcpServers: stopHasPack(access) ? (opts.mcpServers ?? []) : [],
      },
      prepare: async () => {
        const refusal = openCodeBelowStandardRefusal(access);
        if (refusal) throw new Error(refusal);
        if (!folder) await openCodeEmptyCwd(opts.agentId);
        if (sessionId) await moveHere(sessionId, opts);
      },
      delivery: folder
        ? { kind: "copy", folder: opts.cwd }
        : { kind: "inline-images" },
    };
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
    // A history read or fork goes to the side that holds the session.
    const onOtherSide =
      access.environmentKey !== undefined &&
      sessionState(sessionId, access.environmentKey, access.access) ===
        "missing" &&
      sessionState(
        sessionId,
        access.environmentKey,
        otherSide(access.access),
      ) !== "missing";
    const binding = {
      cwd,
      supervisor: supervisorFor(
        onOtherSide
          ? {
              ...access,
              access: otherSide(access.access),
              mcpServers: undefined,
            }
          : access,
      ),
      model: productionModel(access.modelFamily),
      ...(agent ? { agent } : {}),
    };
    setBinding(sessionId, binding);
    return binding;
  };
  const storedState = (
    sessionId: string,
    opts: SessionEnvironmentOptions,
  ): StoredSessionState => {
    if (!opts.environmentKey)
      throw new Error("OpenCode session environment identity is required.");
    const own = sessionState(sessionId, opts.environmentKey, opts.access);
    if (own === "durable") return own;
    return sessionState(
      sessionId,
      opts.environmentKey,
      otherSide(opts.access),
    ) === "durable"
      ? "durable"
      : own;
  };
  return {
    capabilities: CAPABILITIES,
    getModelOptions: () => [],
    getPermissionModes: () => PERMISSION_MODES,
    // A saved setting reaches both of the member's servers: the limited one
    // with its own env (project config off) and no MCP server in its list.
    updateSavedSettings: (opts) => {
      if (options.supervisor) return;
      updateOpenCodeSupervisorSettings(
        opts.environmentKey,
        opts.env,
        opts.environmentRevision,
        opts.mcpServers,
      );
      updateOpenCodeSupervisorSettings(
        openCodeProfileKey(opts.environmentKey, "chat"),
        openCodeLaunchEnvFor(opts.env ?? {}, "chat"),
        opts.environmentRevision,
        [],
      );
    },
    awaitCurrentServer: async (opts) => {
      if (options.supervisor) return;
      await Promise.all([
        awaitOpenCodeServerSettings(
          opts.environmentKey,
          opts.env,
          opts.environmentRevision,
          opts.mcpServers,
        ),
        awaitOpenCodeServerSettings(
          openCodeProfileKey(opts.environmentKey, "chat"),
          openCodeLaunchEnvFor(opts.env ?? {}, "chat"),
          opts.environmentRevision,
          [],
        ),
      ]);
    },
    reloadPlugins: async (opts) => {
      if (options.supervisor) return options.supervisor.requestReload();
      const results = await Promise.all([
        reloadOpenCodeServer(opts.environmentKey),
        reloadOpenCodeServer(openCodeProfileKey(opts.environmentKey, "chat")),
      ]);
      return results.includes("pending") ? "pending" : "reloaded";
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
      const setup = setupFor(opts);
      const { cwd, agent } = setup;
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        undefined,
        options.contractShapeSink,
        safeErrorSink,
        (sessionId) => setBinding(sessionId, { cwd, supervisor, model, agent }),
        setup,
      );
    },
    resumeSession(
      sessionId: string,
      opts: CreateSessionOptions,
    ): BackendSession {
      const model = productionModel(opts.modelFamily);
      const supervisor = supervisorFor(opts);
      const setup = setupFor(opts, sessionId);
      const { cwd, agent } = setup;
      setBinding(sessionId, { cwd, supervisor, model, agent });
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        sessionId,
        options.contractShapeSink,
        safeErrorSink,
        (resolvedSessionId) =>
          setBinding(resolvedSessionId, { cwd, supervisor, model, agent }),
        setup,
      );
    },
    // A session on either side of the standard line resumes: the start moves
    // it to the side of the agent's stop.
    inspectStoredSession(sessionId, opts): StoredSessionState {
      return storedState(sessionId, opts);
    },
    async recoverStoredSession(sessionId, opts): Promise<boolean> {
      if (!opts.environmentKey) return false;
      const fromProfileDir = findOpenCodeSessionProfile(
        sessionId,
        opts.environmentKey,
      );
      if (!fromProfileDir) return false;
      return (
        (await moveOpenCodeSession({
          sessionId,
          fromProfileDir,
          target: supervisorFor(opts),
          targetEnvironmentKey: opts.environmentKey,
        })) === "moved"
      );
    },
    checkSessionResumable(sessionId, opts): LogMessage | null {
      const state = storedState(sessionId, opts);
      if (state === "durable") return null;
      return msg(
        state === "empty"
          ? "systemEntries.openCodeSession.empty"
          : "systemEntries.openCodeSession.missing",
        { session: sessionId },
      );
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
      // Below standard the prompt holds the agent's conversation, strangers'
      // text included: the chat agent, with no tool and no MCP server, on
      // the limited server, in an empty folder.
      const below = opts.access !== undefined && belowStandard(opts.access);
      if (below) {
        const refusal = openCodeBelowStandardRefusal(opts.access!);
        if (refusal) throw new Error(refusal);
      }
      const supervisor = supervisorFor(opts);
      const dir = below ? OPENCODE_LIMITED_ONE_SHOT_DIR : OPENCODE_ONE_SHOT_DIR;
      if (below) await makeEmptyFolder(dir);
      else await getAgentHost().fs.mkdir(dir, 0o777);
      const models = await discoverOpenCodeModels(supervisor, dir);
      // Topic text must use the same selection as a live session. Never pick
      // a default or another discovered model when that selection is missing.
      const selected = models.find((model) => model.id === opts.modelFamily);
      if (!selected) {
        throw new Error("OpenCode one-shot selected model is unavailable.");
      }
      const model = productionModel(selected.id);
      const setup: OpenCodeSessionSetup | undefined = below
        ? {
            cwd: dir,
            agent: openCodeStopAgent("chat") ?? undefined,
            limited: { rules: openCodeStopRules("chat", []), mcpServers: [] },
            prepare: async () => {
              await makeEmptyFolder(dir);
            },
          }
        : undefined;
      const session = new OpenCodeServerSession(
        {
          agentId: "isomux-opencode-one-shot",
          cwd: dir,
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
        setup,
      );
      const timeoutError = new Error("OpenCode one-shot prompt timed out.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const completion = (async () => {
          let text = "";
          let freeLimit = false;
          for await (const event of session.stream()) {
            if (event.kind === "assistant_text") text += event.text;
            if (event.kind === "usage_limit_stop" && event.freeLimit)
              freeLimit = true;
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
                if (freeLimit) throw new OpenCodeFreeLimitError();
                throw new Error(
                  event.error === undefined
                    ? "OpenCode one-shot prompt failed."
                    : renderLogText(translatorFor("en"), event.error),
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
      return detectOpenCodeAuthError(text);
    },
    async getLoginInstructions() {
      return {
        kind: "login",
        cardEligible: false,
        text: authGuidance(),
      };
    },
  };
}

export const opencodeBackend = createOpenCodeBackend();
