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
  SessionEnvironmentOptions,
  StoredSessionState,
  SubscriptionUsageResult,
} from "../types.ts";
import { OPENCODE_TRACER_MODEL } from "../../../shared/types.ts";
import { OpenCodeTransport, type SafeOpenCodeError } from "./transport.ts";
import {
  openCodeSupervisorForEnvironment,
  type OpenCodeSupervisor,
} from "./supervisor.ts";
import { ensureOpenCodeLoginWrapper, quoteShellWord } from "./login-wrapper.ts";

const AUTH_FAILURE = "OpenCode authentication is not configured.";

function loginInstructions(environmentKey: string | undefined): {
  text: string;
  commands: string[];
} {
  if (!environmentKey) {
    throw new Error("OpenCode session environment identity is required.");
  }
  const wrapper = ensureOpenCodeLoginWrapper(environmentKey);
  return {
    text:
      `OpenCode needs an OpenAI API key for this shared environment. Review and run ${wrapper}, ` +
      "complete the masked prompt, and then use /clear. Browser OAuth is not certified.",
    commands: [quoteShellWord(wrapper)],
  };
}

const CAPABILITIES: BackendCapabilities = {
  fork: true,
  hooks: false,
  skills: false,
  oneShot: false,
  canUseTool: true,
  topicGen: false,
  edit: true,
  mcp: false,
};
const TRACER_CAPABILITIES: BackendCapabilities = {
  ...CAPABILITIES,
  fork: false,
  edit: false,
  canUseTool: false,
};

const MODELS: ModelOption[] = [
  { value: OPENCODE_TRACER_MODEL, label: "OpenCode tracer" },
];

const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", label: "Ask" },
];

interface TracerOptions {
  failAuth?: boolean;
}

export interface OpenCodeBackendOptions {
  supervisor?: OpenCodeSupervisor;
  model?: string;
  contractShapeSink?: (shape: string) => void;
  safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void;
}

class OpenCodeServerSession implements BackendSession {
  private readonly events: NormalizedEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private readonly transport: OpenCodeTransport;

  constructor(
    opts: CreateSessionOptions,
    model: string,
    supervisor: OpenCodeSupervisor,
    sessionId?: string,
    contractShapeSink?: (shape: string) => void,
    safeErrorSink?: (error: Readonly<SafeOpenCodeError>) => void,
    private readonly onSessionId?: (sessionId: string) => void,
  ) {
    this.transport = new OpenCodeTransport({
      cwd: opts.cwd,
      model,
      supervisor,
      sessionId,
      contractShapeSink,
      safeErrorSink,
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
    return null;
  }

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    return { kind: "unavailable" };
  }

  async send(text: string, _attachments?: AttachmentSpec[]): Promise<void> {
    await this.transport.send(text, this.push);
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

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    return { kind: "unavailable" };
  }

  async send(_text: string, _attachments?: AttachmentSpec[]): Promise<void> {
    if (this.failAuth) {
      this.push({
        kind: "turn_completed",
        status: "failed",
        error: AUTH_FAILURE,
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
    throw new Error("OpenCode permissions are not available in this slice.");
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
      return MODELS;
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
      throw new Error("OpenCode one-shot prompts are not available in this slice.");
    },

    detectAuthError(text: string): boolean {
      return text.includes(AUTH_FAILURE);
    },

    getLoginInstructions(opts): { text: string; commands: string[] } {
      return loginInstructions(opts?.environmentKey);
    },
  };
}

export function createOpenCodeBackend(options: OpenCodeBackendOptions = {}): Backend {
  const model = options.model ?? OPENCODE_TRACER_MODEL;
  const bindings = new Map<
    string,
    { cwd: string; supervisor: OpenCodeSupervisor }
  >();
  const supervisorFor = (opts: CreateSessionOptions): OpenCodeSupervisor => {
    if (options.supervisor) return options.supervisor;
    if (!opts.environmentKey) {
      throw new Error("OpenCode session environment identity is required.");
    }
    return openCodeSupervisorForEnvironment(
      opts.environmentKey,
      opts.env,
      opts.environmentRevision,
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
      model,
      supervisor: binding.supervisor,
      sessionId,
      contractShapeSink: options.contractShapeSink,
      safeErrorSink: options.safeErrorSink,
    });
  };
  return {
    capabilities: CAPABILITIES,
    getModelOptions: () => MODELS,
    getPermissionModes: () => PERMISSION_MODES,
    async listModels(): Promise<BackendModel[]> {
      return [{ id: model, label: "OpenCode tracer", isDefault: true, supportedEfforts: [] }];
    },
    createSession(opts: CreateSessionOptions): BackendSession {
      const supervisor = supervisorFor(opts);
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        undefined,
        options.contractShapeSink,
        options.safeErrorSink,
        (sessionId) => bindings.set(sessionId, { cwd: opts.cwd, supervisor }),
      );
    },
    resumeSession(sessionId: string, opts: CreateSessionOptions): BackendSession {
      const supervisor = supervisorFor(opts);
      bindings.set(sessionId, { cwd: opts.cwd, supervisor });
      return new OpenCodeServerSession(
        opts,
        model,
        supervisor,
        sessionId,
        options.contractShapeSink,
        options.safeErrorSink,
        (resolvedSessionId) =>
          bindings.set(resolvedSessionId, { cwd: opts.cwd, supervisor }),
      );
    },
    inspectStoredSession(): StoredSessionState {
      return "durable";
    },
    checkSessionResumable(): string | null {
      return null;
    },
    async forkSessionBeforeMessage(
      sessionId: string,
      targetMessageId: string,
    ): Promise<ForkSessionBeforeMessageResult> {
      const parent = bindings.get(sessionId);
      if (!parent) {
        throw new Error(
          "OpenCode parent session is not bound to this Isomux process.",
        );
      }
      const transport = transportForSession(sessionId);
      try {
        const childId = await transport.forkAtMessage(targetMessageId);
        bindings.set(childId, parent);
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
      environment?: SessionEnvironmentOptions,
    ): Promise<NormalizedMessage[]> {
      if (!bindings.has(sessionId)) {
        const supervisor = supervisorFor({
          agentId: "opencode-session-access",
          cwd,
          systemPrompt: "",
          modelFamily: model,
          effort: "",
          permissionMode: "default",
          env: environment?.env,
          environmentKey: environment?.environmentKey,
          environmentRevision: environment?.environmentRevision,
        });
        bindings.set(sessionId, { cwd, supervisor });
      }
      const transport = transportForSession(sessionId);
      try {
        return await transport.getSessionMessages();
      } finally {
        transport.close();
      }
    },
    async oneShotPrompt(): Promise<string> {
      throw new Error("OpenCode one-shot prompts are not available in this slice.");
    },
    detectAuthError(text: string): boolean {
      return text.includes(AUTH_FAILURE);
    },
    getLoginInstructions(opts): { text: string; commands: string[] } {
      return loginInstructions(opts?.environmentKey);
    },
  };
}

export const opencodeBackend = createOpenCodeBackend();
