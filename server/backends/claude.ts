// Claude backend implementation.
//
// Step 2a (current): a thin pass-through wrapper around the Claude SDK's V2
// session. The wrapper preserves the SDK's surface verbatim so the orchestrator
// in agent-manager keeps consuming SDKMessage and calling send/close/stream
// unchanged. The only behavioral effect is that `ManagedAgent.session` now has
// a stable type (`ClaudeBackendSession`) independent of `ReturnType<typeof
// unstable_v2_createSession>`.
//
// Step 2b will swap `stream()` to yield `NormalizedEvent` (translation at this
// boundary), and step 2c will move createSession + safety-hooks + canUseTool
// into this module so agent-manager has zero `@anthropic-ai/...` imports.

import type {
  SDKMessage,
  SDKSession,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export class ClaudeBackendSession {
  constructor(private readonly sdkSession: SDKSession) {}

  stream(): AsyncGenerator<SDKMessage, void> {
    return this.sdkSession.stream();
  }

  send(message: string | SDKUserMessage): Promise<void> {
    return this.sdkSession.send(message);
  }

  close(): void {
    this.sdkSession.close();
  }
}
