// Slice 1A tracer for the OpenCode backend boundary.
//
// This module deliberately starts no process and reads no OpenCode profile.
// It proves that a third backend can cross Isomux's spawn, queue, persistence,
// normalized-event, and UI contracts. Slice 1B replaces this transport with
// the pinned OC1 server while keeping the Backend surface below unchanged.

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
  StoredSessionState,
  SubscriptionUsageResult,
} from "../types.ts";
import { OPENCODE_TRACER_MODEL } from "../../../shared/types.ts";

const AUTH_FAILURE = "OpenCode authentication is not configured.";

const CAPABILITIES: BackendCapabilities = {
  fork: false,
  hooks: false,
  skills: false,
  oneShot: false,
  canUseTool: false,
  topicGen: false,
  edit: false,
  mcp: false,
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
    capabilities: CAPABILITIES,

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

    getLoginInstructions(): { text: string } {
      return {
        text: "OpenCode is not configured. Login instructions are not available in this slice.",
      };
    },
  };
}

export const opencodeBackend = createOpenCodeTracerBackend();
