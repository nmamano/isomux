// Test doubles for the Claude backend's SDK seam (SdkClient, SdkConversation),
// shared by the Claude backend tests.
import type {
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SdkClient,
  SdkConversation,
  SdkMcpRegistration,
  SdkOneShotOptions,
} from "../backends/claude.ts";
import type {
  ContextUsage,
  SubscriptionUsageResult,
} from "../backends/types.ts";

// ---------------------------------------------------------------------------
// FakeSdkConversation - test double for SdkConversation
// ---------------------------------------------------------------------------
// Pushable async iterable for messages; tracks sends and close calls; lets
// the test simulate SDK-side errors mid-stream.

export class FakeSdkConversation implements SdkConversation {
  sends: (string | SDKUserMessage)[] = [];
  closeCount = 0;
  contextUsage: ContextUsage | null = null;
  subscriptionUsage: SubscriptionUsageResult = { kind: "unknown" };

  private queue: SDKMessage[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private thrown: Error | null = null;

  async *messages(): AsyncIterable<SDKMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.thrown) {
        const err = this.thrown;
        this.thrown = null;
        throw err;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  send(msg: string | SDKUserMessage): Promise<void> {
    this.sends.push(msg);
    return Promise.resolve();
  }

  close(): void {
    this.closeCount++;
    this.done = true;
    this.wake();
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return this.contextUsage;
  }

  async getSubscriptionUsage(): Promise<SubscriptionUsageResult> {
    return this.subscriptionUsage;
  }

  permissionModeCalls: string[] = [];
  // Settles every setPermissionMode call; FakeSdkClient sets it before the
  // session constructor makes its first call.
  permissionModeResult: Promise<void> = Promise.resolve();
  setPermissionMode(mode: string): Promise<void> {
    this.permissionModeCalls.push(mode);
    return this.permissionModeResult;
  }

  // ----- Test driver helpers -----
  emit(msg: unknown): void {
    this.queue.push(msg as SDKMessage);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  throwNext(err: Error): void {
    this.thrown = err;
    this.wake();
  }

  private wake() {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }
}

// ---------------------------------------------------------------------------
// FakeSdkClient - test double for SdkClient
// ---------------------------------------------------------------------------

export class FakeSdkClient implements SdkClient {
  conversations: FakeSdkConversation[] = [];
  createCalls: {
    opts: Parameters<SdkClient["createSession"]>[0];
    mcp?: SdkMcpRegistration;
  }[] = [];
  resumeCalls: {
    sessionId: string;
    opts: Parameters<SdkClient["resumeSession"]>[1];
    mcp?: SdkMcpRegistration;
  }[] = [];
  oneShotCalls: SdkOneShotOptions[] = [];
  forkCalls: { sessionId: string; opts: { upToMessageId: string } }[] = [];
  getMessagesCalls: string[] = [];

  // Becomes permissionModeResult of the next conversation created.
  nextPermissionModeResult: Promise<void> | null = null;
  oneShotResult = "default-topic";
  forkResult: { sessionId: string } = { sessionId: "forked-1" };
  sessionMessagesResult: SessionMessage[] = [];

  createSession(
    opts: Parameters<SdkClient["createSession"]>[0],
    mcp?: SdkMcpRegistration,
  ): SdkConversation {
    this.createCalls.push({ opts, mcp });
    const conv = new FakeSdkConversation();
    if (this.nextPermissionModeResult)
      conv.permissionModeResult = this.nextPermissionModeResult;
    this.conversations.push(conv);
    return conv;
  }

  resumeSession(
    sessionId: string,
    opts: Parameters<SdkClient["resumeSession"]>[1],
    mcp?: SdkMcpRegistration,
  ): SdkConversation {
    this.resumeCalls.push({ sessionId, opts, mcp });
    const conv = new FakeSdkConversation();
    this.conversations.push(conv);
    return conv;
  }

  oneShotPrompt(opts: SdkOneShotOptions): Promise<string> {
    this.oneShotCalls.push(opts);
    return Promise.resolve(this.oneShotResult);
  }

  forkSession(
    sessionId: string,
    opts: { upToMessageId: string },
  ): Promise<{ sessionId: string }> {
    this.forkCalls.push({ sessionId, opts });
    return Promise.resolve(this.forkResult);
  }

  getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    this.getMessagesCalls.push(sessionId);
    return Promise.resolve(this.sessionMessagesResult);
  }
}
