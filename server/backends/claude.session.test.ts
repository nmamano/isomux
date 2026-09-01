import { describe, expect, it } from "bun:test";
import { expectRejection } from "../test-support/expect-rejection.ts";
import type {
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_MEMORY_OFF_SETTINGS,
  ClaudeSession,
  createClaudeBackend,
  type SdkClient,
  type SdkConversation,
  type SdkOneShotOptions,
} from "./claude";
import type { ContextUsage, SubscriptionUsageResult } from "./types";

// ---------------------------------------------------------------------------
// FakeSdkConversation - test double for SdkConversation
// ---------------------------------------------------------------------------
// Pushable async iterable for messages; tracks sends and close calls; lets
// the test simulate SDK-side errors mid-stream.

class FakeSdkConversation implements SdkConversation {
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

class FakeSdkClient implements SdkClient {
  conversations: FakeSdkConversation[] = [];
  createCalls: { opts: Parameters<SdkClient["createSession"]>[0] }[] = [];
  resumeCalls: {
    sessionId: string;
    opts: Parameters<SdkClient["resumeSession"]>[1];
  }[] = [];
  oneShotCalls: SdkOneShotOptions[] = [];
  forkCalls: { sessionId: string; opts: { upToMessageId: string } }[] = [];
  getMessagesCalls: string[] = [];

  oneShotResult = "default-topic";
  forkResult: { sessionId: string } = { sessionId: "forked-1" };
  sessionMessagesResult: SessionMessage[] = [];

  createSession(
    opts: Parameters<SdkClient["createSession"]>[0],
  ): SdkConversation {
    this.createCalls.push({ opts });
    const conv = new FakeSdkConversation();
    this.conversations.push(conv);
    return conv;
  }

  resumeSession(
    sessionId: string,
    opts: Parameters<SdkClient["resumeSession"]>[1],
  ): SdkConversation {
    this.resumeCalls.push({ sessionId, opts });
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function minimalSdkOpts() {
  return {
    model: "claude-opus-4-8",
    pathToClaudeCodeExecutable: "/bin/echo",
    cwd: "/tmp",
    permissionMode: "default" as const,
  };
}

function makeSession(
  fake: FakeSdkClient,
  resumeSessionId?: string,
): {
  session: ClaudeSession;
  conv: FakeSdkConversation;
  canUseTool: CanUseTool;
} {
  const session = new ClaudeSession(
    "test-agent",
    fake,
    minimalSdkOpts(),
    resumeSessionId,
  );
  const conv = fake.conversations.at(-1)!;
  const opts = resumeSessionId
    ? fake.resumeCalls.at(-1)!.opts
    : fake.createCalls.at(-1)!.opts;
  const canUseTool = opts.canUseTool!;
  return { session, conv, canUseTool };
}

function nextEvent<T extends { kind: string }>(
  it: AsyncIterator<T>,
): Promise<T | undefined> {
  return it.next().then((r) => (r.done ? undefined : r.value));
}

function fakeCallOpts(
  toolUseID: string,
  extras: {
    suggestions?: PermissionUpdate[];
    title?: string;
    description?: string;
    decisionReason?: string;
    signal?: AbortSignal;
  } = {},
): Parameters<CanUseTool>[2] {
  return {
    toolUseID,
    // Required since SDK 0.3.219: the control_request envelope's request_id.
    // Derived from toolUseID so the fixture stays deterministic and each
    // approval in a test gets a distinct value.
    requestId: `req-${toolUseID}`,
    signal: extras.signal ?? new AbortController().signal,
    suggestions: extras.suggestions,
    title: extras.title,
    description: extras.description,
    decisionReason: extras.decisionReason,
  };
}

// ---------------------------------------------------------------------------
// ClaudeSession - construction
// ---------------------------------------------------------------------------

describe("ClaudeSession construction", () => {
  it("fresh session calls sdkClient.createSession with canUseTool wired", () => {
    const fake = new FakeSdkClient();
    new ClaudeSession("agent-x", fake, minimalSdkOpts());
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.resumeCalls).toHaveLength(0);
    expect(fake.createCalls[0].opts.canUseTool).toBeDefined();
    expect(fake.createCalls[0].opts.model).toBe("claude-opus-4-8");
  });

  it("resume session calls sdkClient.resumeSession with session id", () => {
    const fake = new FakeSdkClient();
    new ClaudeSession("agent-x", fake, minimalSdkOpts(), "s-99");
    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.resumeCalls[0].sessionId).toBe("s-99");
    expect(fake.resumeCalls[0].opts.canUseTool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - stream pumping
// ---------------------------------------------------------------------------

describe("ClaudeSession stream", () => {
  it("yields translated events as the conversation emits SDK messages", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();

    conv.emit({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      slash_commands: ["help"],
      model: "claude-opus-4-8",
    });
    expect(await nextEvent(it)).toEqual({
      kind: "system_init",
      sessionId: "s-1",
      slashCommands: ["help"],
      model: "claude-opus-4-8",
    });

    conv.emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(await nextEvent(it)).toEqual({
      kind: "assistant_text",
      text: "hello",
    });

    conv.emit({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.01,
    });
    expect(await nextEvent(it)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
      cost: 0.01,
    });
  });

  it("ends iteration when the conversation iterable returns", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    conv.emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "x" }] },
    });
    expect(await nextEvent(it)).toMatchObject({ kind: "assistant_text" });
    conv.finish();
    const final = await it.next();
    expect(final.done).toBe(true);
  });

  // Regression pin for the TaskBreadcrumbTracker wiring in feedSDKMessages
  // (task b4cafa53 option C). The tracker itself is covered in
  // task-breadcrumbs.test.ts; this asserts the SESSION actually feeds it and
  // interleaves its task_lifecycle events at the right stream positions -
  // removing/reordering the observe() loop would leave the tracker tests
  // green while the feature silently disappears.
  it("interleaves task_lifecycle breadcrumbs for background tasks, none for foreground subagents", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();

    // Background Bash launch: tool_call translates first, then the later
    // task_started message becomes the breadcrumb.
    conv.emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Bash",
            input: { command: "sleep 60", run_in_background: true },
          },
        ],
      },
    });
    expect(await nextEvent(it)).toMatchObject({
      kind: "tool_call",
      toolUseId: "toolu_bg",
    });
    conv.emit({
      type: "system",
      subtype: "task_started",
      task_id: "b1",
      tool_use_id: "toolu_bg",
      description: "Sleep in background",
      task_type: "local_bash",
    });
    expect(await nextEvent(it)).toEqual({
      kind: "task_lifecycle",
      phase: "started",
      taskId: "b1",
      label: "Background task started: Sleep in background",
    });

    // Foreground subagent: same SDK message pair, but no breadcrumbs - the
    // next observable event must be the settle of the BACKGROUND task.
    conv.emit({
      type: "system",
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "toolu_fg",
      description: "Explore the codebase",
      task_type: "local_agent",
      subagent_type: "general-purpose",
    });
    conv.emit({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      tool_use_id: "toolu_fg",
      status: "completed",
      output_file: "",
      summary: "Explore the codebase",
    });
    conv.emit({
      type: "system",
      subtype: "task_notification",
      task_id: "b1",
      tool_use_id: "toolu_bg",
      status: "completed",
      output_file: "/tmp/b1.output",
      summary:
        'Background command "Sleep in background" completed (exit code 0)',
    });
    expect(await nextEvent(it)).toEqual({
      kind: "task_lifecycle",
      phase: "completed",
      taskId: "b1",
      label: 'Background command "Sleep in background" completed (exit code 0)',
    });

    conv.finish();
    const final = await it.next();
    expect(final.done).toBe(true);
    session.close();
  });

  it("emits a normalized error event when the conversation throws mid-stream", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    conv.throwNext(new Error("transport boom"));
    const ev = await nextEvent(it);
    expect(ev).toEqual({ kind: "error", message: "transport boom" });
    const done = await it.next();
    expect(done.done).toBe(true);
  });

  it("swallows mid-stream throw when the session was closed", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    // close BEFORE the throw - feedSDKMessages sees this.closed=true and
    // refrains from enqueueing an error event.
    session.close();
    conv.throwNext(new Error("closing race"));
    const done = await it.next();
    expect(done.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - send
// ---------------------------------------------------------------------------

describe("ClaudeSession send", () => {
  it("forwards plain text directly to the conversation", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    await session.send("hello");
    expect(conv.sends).toEqual(["hello"]);
  });

  it("wraps text+attachments into an SDKUserMessage before sending", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    await session.send("see attached", [
      {
        filename: "missing.png",
        originalName: "missing.png",
        mediaType: "image/png",
        size: 0,
      },
    ]);
    expect(conv.sends).toHaveLength(1);
    const sent = conv.sends[0];
    expect(typeof sent).toBe("object");
    expect((sent as SDKUserMessage).type).toBe("user");
    const content = (sent as SDKUserMessage).message.content as {
      type?: string;
      text?: string;
    }[];
    // missing file is silently skipped → only the text block remains
    expect(content).toEqual([{ type: "text", text: "see attached" }]);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - canUseTool / approve roundtrip
// ---------------------------------------------------------------------------

describe("ClaudeSession approval flow", () => {
  it("canUseTool emits approval_request and parks until approve()", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();

    const decision = canUseTool(
      "Bash",
      { cmd: "ls" },
      fakeCallOpts("u1", { title: "Bash ls", description: "list dir" }),
    );

    const ev = await nextEvent(it);
    expect(ev).toEqual({
      kind: "approval_request",
      approvalId: "u1",
      toolName: "Bash",
      input: { cmd: "ls" },
      title: "Bash ls",
      description: "list dir",
      allowPersistentLabel:
        "Allow - and don't ask again for similar calls this session",
    });

    await session.approve("u1", { kind: "allow_once" });
    const result = await decision;
    expect(result).toEqual({ behavior: "allow", updatedInput: { cmd: "ls" } });
  });

  it("approval_request defaults title/description when not provided", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();

    void canUseTool(
      "Read",
      { path: "/x" },
      fakeCallOpts("u2", { decisionReason: "outside allow list" }),
    );
    expect(await nextEvent(it)).toMatchObject({
      title: "Claude wants to use Read",
      description: "outside allow list",
    });
  });

  it("allow_persistent scopes suggested permissions to the session", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();

    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls" }],
        behavior: "allow",
        destination: "userSettings",
      },
    ];
    const decision = canUseTool(
      "Bash",
      { cmd: "ls" },
      fakeCallOpts("u3", { suggestions }),
    );
    await nextEvent(it);
    await session.approve("u3", { kind: "allow_persistent" });
    const result = (await decision) as Extract<
      PermissionResult,
      { behavior: "allow" }
    >;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toEqual({ cmd: "ls" });
    expect(result.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("allow_persistent with no suggestions yields undefined updatedPermissions", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const decision = canUseTool("X", {}, fakeCallOpts("u4"));
    await nextEvent(it);
    await session.approve("u4", { kind: "allow_persistent" });
    const result = (await decision) as Extract<
      PermissionResult,
      { behavior: "allow" }
    >;
    expect(result.updatedPermissions).toBeUndefined();
  });

  it("deny resolves the SDK promise with behavior:deny and reason", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const decision = canUseTool("Bash", { cmd: "rm" }, fakeCallOpts("u5"));
    await nextEvent(it);
    await session.approve("u5", { kind: "deny", reason: "too risky" });
    const result = await decision;
    expect(result).toEqual({ behavior: "deny", message: "too risky" });
  });

  it("deny without reason uses a default message", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const decision = canUseTool("X", {}, fakeCallOpts("u6"));
    await nextEvent(it);
    await session.approve("u6", { kind: "deny" });
    expect(await decision).toEqual({
      behavior: "deny",
      message: "User denied.",
    });
  });

  it("approve() with an unknown approvalId is a no-op", async () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    // Doesn't throw, doesn't affect anything observable
    await session.approve("never-asked", { kind: "allow_once" });
  });

  it("aborting the SDK signal denies the approval", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const ctrl = new AbortController();
    const decision = canUseTool(
      "X",
      {},
      fakeCallOpts("u7", { signal: ctrl.signal }),
    );
    await nextEvent(it);
    ctrl.abort();
    const result = await decision;
    expect(result).toEqual({
      behavior: "deny",
      message: "Request aborted.",
    });
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - close
// ---------------------------------------------------------------------------

describe("ClaudeSession close", () => {
  it("denies pending approvals and closes the conversation", async () => {
    const fake = new FakeSdkClient();
    const { session, conv, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const decision = canUseTool("X", {}, fakeCallOpts("u-pending"));
    await nextEvent(it);
    session.close();
    expect(await decision).toEqual({
      behavior: "deny",
      message: "Session closed.",
    });
    expect(conv.closeCount).toBe(1);
  });

  it("is idempotent - second close() does not double-call conversation.close", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    session.close();
    session.close();
    expect(conv.closeCount).toBe(1);
  });

  it("unblocks a parked stream() iterator", async () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    // it.next() parks because buffer is empty and nothing was emitted.
    const next = it.next();
    session.close();
    const final = await next;
    expect(final.done).toBe(true);
  });

  it("send after close does not throw", async () => {
    // Whether ClaudeSession.send() forwards to the closed conversation or
    // no-ops at this layer is a layering detail - V1's wrapV1Query.send()
    // already no-ops after close (covered by `wrapV1Query > send after
    // close is a no-op`). The behavior locked here is just "no throw / no
    // rejection at the BackendSession boundary".
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    session.close();
    await session.send("late");
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - abort / canAbortInPlace
// ---------------------------------------------------------------------------

describe("ClaudeSession abort", () => {
  it("abort() rejects - Claude has no in-place interrupt RPC", async () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    await expectRejection(session.abort(), /unsupported/);
  });

  it("canAbortInPlace() returns false", () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    expect(session.canAbortInPlace()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - context usage
// ---------------------------------------------------------------------------

describe("ClaudeSession getContextUsage", () => {
  it("delegates to conversation.getContextUsage", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    conv.contextUsage = {
      model: "m",
      totalTokens: 100,
      maxTokens: 200000,
      percentage: 0.05,
    };
    expect(await session.getContextUsage()).toEqual({
      model: "m",
      totalTokens: 100,
      maxTokens: 200000,
      percentage: 0.05,
    });
  });

  it("returns null when conversation has no usage data", async () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    expect(await session.getContextUsage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createClaudeBackend - module-level backend functions
// ---------------------------------------------------------------------------

describe("createClaudeBackend.forkSessionBeforeMessage", () => {
  // forkSessionBeforeMessage walks the transcript by sdkClient.getSessionMessages
  // and decides between a real fork (predecessor uuid) and a fresh session
  // when the target is the first user message.

  function withMessages(
    fake: FakeSdkClient,
    messages: Array<{ uuid: string; type: string }>,
  ) {
    fake.sessionMessagesResult = messages as unknown as SessionMessage[];
  }

  it("returns fresh when target is the first user message", async () => {
    const fake = new FakeSdkClient();
    withMessages(fake, [
      { uuid: "u-target", type: "user" },
      { uuid: "a-1", type: "assistant" },
    ]);
    const backend = createClaudeBackend(fake);
    const result = await backend.forkSessionBeforeMessage("s-1", "u-target");
    expect(result).toEqual({ kind: "fresh" });
    expect(fake.forkCalls).toHaveLength(0);
  });

  it("returns fresh even when target is at index 0", async () => {
    // Defends the firstUserIdx-before-target-match ordering invariant.
    const fake = new FakeSdkClient();
    withMessages(fake, [{ uuid: "u-target", type: "user" }]);
    const backend = createClaudeBackend(fake);
    const result = await backend.forkSessionBeforeMessage("s-1", "u-target");
    expect(result).toEqual({ kind: "fresh" });
  });

  it("forks at the predecessor message when target is mid-conversation", async () => {
    const fake = new FakeSdkClient();
    withMessages(fake, [
      { uuid: "u-0", type: "user" },
      { uuid: "a-0", type: "assistant" },
      { uuid: "u-target", type: "user" },
    ]);
    fake.forkResult = { sessionId: "forked-99" };
    const backend = createClaudeBackend(fake);
    const result = await backend.forkSessionBeforeMessage("s-1", "u-target");
    expect(fake.forkCalls).toEqual([
      { sessionId: "s-1", opts: { upToMessageId: "a-0" } },
    ]);
    expect(result).toEqual({
      kind: "fork",
      sessionId: "forked-99",
      forkedFromSessionId: "s-1",
    });
  });

  it("throws when target message is not in the transcript", async () => {
    const fake = new FakeSdkClient();
    withMessages(fake, [{ uuid: "u-0", type: "user" }]);
    const backend = createClaudeBackend(fake);
    await expectRejection(
      backend.forkSessionBeforeMessage("s-1", "u-missing"),
      /not found/,
    );
  });
});

describe("createClaudeBackend.getSessionMessages", () => {
  it("normalizes user/assistant/system messages and skips other types", async () => {
    const fake = new FakeSdkClient();
    fake.sessionMessagesResult = [
      { uuid: "u-1", type: "user", message: { content: "hi" } },
      {
        uuid: "a-1",
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      { uuid: "s-1", type: "system", message: { content: "init" } },
      { uuid: "r-1", type: "result", message: { content: "n/a" } },
    ] as unknown as SessionMessage[];
    const backend = createClaudeBackend(fake);
    const out = await backend.getSessionMessages("s-1", "/tmp");
    expect(out).toEqual([
      { uuid: "u-1", role: "user", text: "hi" },
      { uuid: "a-1", role: "assistant", text: "hello" },
      { uuid: "s-1", role: "system", text: "init" },
    ]);
  });
});

describe("createClaudeBackend.oneShotPrompt", () => {
  it("resolves modelFamily before delegating to sdkClient.oneShotPrompt", async () => {
    const fake = new FakeSdkClient();
    fake.oneShotResult = "topic-A";
    const backend = createClaudeBackend(fake);
    const result = await backend.oneShotPrompt("Summarize", {
      modelFamily: "haiku",
      cwd: "/tmp",
      systemPrompt: "sys",
      env: { FOO: "bar" },
    });
    expect(result).toBe("topic-A");
    expect(fake.oneShotCalls).toHaveLength(1);
    const call = fake.oneShotCalls[0];
    expect(call.prompt).toBe("Summarize");
    expect(call.systemPrompt).toBe("sys");
    expect(call.env).toEqual({ FOO: "bar" });
    // Family-to-model translation occurred (haiku → its concrete model id)
    expect(call.model).not.toBe("haiku");
    expect(call.model.length).toBeGreaterThan(0);
    expect(call.pathToClaudeCodeExecutable.length).toBeGreaterThan(0);
  });

  it("propagates errors from sdkClient.oneShotPrompt", async () => {
    const fake = new FakeSdkClient();
    fake.oneShotPrompt = () => Promise.reject(new Error("oneShot failed"));
    const backend = createClaudeBackend(fake);
    await expectRejection(
      backend.oneShotPrompt("x", { modelFamily: "opus" }),
      /oneShot failed/,
    );
  });
});

describe("createClaudeBackend.createSession/resumeSession - SDK option shape", () => {
  // Regression guard for task e6a0387a: the assembled system prompt must reach
  // the SDK as the typed `systemPrompt` option (preset + append, which travels
  // over the child's stdin), and must NEVER be routed through executableArgs/
  // extraArgs - both are rendered onto the child's argv, where the full prompt
  // leaks to `ps` / `systemctl status` / /proc/<pid>/cmdline.
  const createOpts = {
    agentId: "agent-x",
    cwd: "/tmp",
    systemPrompt: "THE ASSEMBLED PROMPT",
    modelFamily: "haiku",
    effort: "high",
    permissionMode: "default",
  };

  function assertTypedShape(opts: FakeSdkClient["createCalls"][0]["opts"]) {
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "THE ASSEMBLED PROMPT",
    });
    expect(opts.effort).toBe("high");
    expect(opts).not.toHaveProperty("executableArgs");
    expect(opts).not.toHaveProperty("extraArgs");
    // The prompt may appear nowhere else in the option bag (e.g. a future
    // argv-shaped field) - only inside the typed systemPrompt option.
    const { systemPrompt, ...rest } = opts;
    void systemPrompt;
    const restJson = JSON.stringify(rest, (_k, v) =>
      typeof v === "function" ? undefined : v,
    );
    expect(restJson).not.toContain("THE ASSEMBLED PROMPT");
  }

  it("createSession builds typed systemPrompt/effort, no argv-bound fields", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    backend.createSession(createOpts);
    expect(fake.createCalls).toHaveLength(1);
    assertTypedShape(fake.createCalls[0].opts);
  });

  it("resumeSession builds the same typed shape", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    backend.resumeSession("s-42", createOpts);
    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.resumeCalls[0].sessionId).toBe("s-42");
    assertTypedShape(fake.resumeCalls[0].opts);
  });
});

// ---------------------------------------------------------------------------
// Backend-native memory off (task 3f6ff5e0). These pin what isomux HANDS the
// SDK: `settings.autoMemoryEnabled === false` as an explicit value on every
// launch path. A top-level `autoMemoryEnabled` is not an SDK Option and would
// be dropped silently, so the assertion is on the nested settings object.
// Whether the SDK honours it is the live probe's claim, not this test's.
// ---------------------------------------------------------------------------

describe("createClaudeBackend - backend-native auto-memory is switched off", () => {
  const createOpts = {
    agentId: "agent-mem",
    cwd: "/tmp",
    systemPrompt: "sys",
    modelFamily: "opus",
    effort: "high",
    permissionMode: "default",
  };

  it("createSession carries settings.autoMemoryEnabled === false", () => {
    const fake = new FakeSdkClient();
    createClaudeBackend(fake).createSession(createOpts);
    const settings = fake.createCalls[0].opts.settings;
    expect(typeof settings).toBe("object");
    expect(
      (settings as { autoMemoryEnabled?: unknown }).autoMemoryEnabled,
    ).toBe(false);
    expect(fake.createCalls[0].opts).not.toHaveProperty("autoMemoryEnabled");
  });

  it("resumeSession carries settings.autoMemoryEnabled === false", () => {
    const fake = new FakeSdkClient();
    createClaudeBackend(fake).resumeSession("s-7", createOpts);
    const settings = fake.resumeCalls[0].opts.settings;
    expect(
      (settings as { autoMemoryEnabled?: unknown }).autoMemoryEnabled,
    ).toBe(false);
  });

  it("oneShotPrompt carries settings.autoMemoryEnabled === false", async () => {
    const fake = new FakeSdkClient();
    await createClaudeBackend(fake).oneShotPrompt("Summarize", {
      modelFamily: "haiku",
    });
    const settings = fake.oneShotCalls[0].settings;
    expect(
      (settings as { autoMemoryEnabled?: unknown }).autoMemoryEnabled,
    ).toBe(false);
  });

  it("the shared constant is the documented SDK switch, nothing else", () => {
    expect(CLAUDE_MEMORY_OFF_SETTINGS).toEqual({ autoMemoryEnabled: false });
  });
});

describe("createClaudeBackend default instance", () => {
  it("module export `claudeBackend` is constructed from the production V1 SDK client", async () => {
    // We can't make real SDK calls here, but we can verify capabilities are
    // set. The real exercise of the V1 adapter happens at runtime against
    // the SDK's `query()` (covered by the dev-server integration path).
    const { claudeBackend } = await import("./claude");
    expect(claudeBackend.capabilities.canUseTool).toBe(true);
    expect(claudeBackend.capabilities.fork).toBe(true);
  });
});
