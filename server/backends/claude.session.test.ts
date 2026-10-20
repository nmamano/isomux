import { describe, expect, it } from "bun:test";
import { expectRejection } from "../test-support/expect-rejection.ts";
import {
  EXPECTED,
  SECRET_VALUE,
  secretAgentEnvironment,
} from "../test-support/secret-env-fixture.ts";
import {
  MCP_SECRET_VALUE,
  placeholderMcpServers,
} from "../test-support/mcp-placeholder-fixture.ts";
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
  sessionOptsToV1,
  toolBoundaryHooks,
  type SdkClient,
  type SdkConversation,
  type SdkMcpRegistration,
  type SdkOneShotOptions,
} from "./claude";
import type {
  CommandRow,
  ContextUsage,
  SessionPluginReload,
  SubscriptionUsageResult,
} from "./types";
import { msg } from "../../shared/i18n/log-message.ts";

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

class FakeSdkClient implements SdkClient {
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

  it("signals sign-in ahead of an auth-shaped conversation error", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    conv.throwNext(new Error("401 Unauthorized"));
    expect(await nextEvent(it)).toEqual({ kind: "auth_needed" });
    expect(await nextEvent(it)).toEqual({
      kind: "error",
      message: "401 Unauthorized",
    });
    expect((await it.next()).done).toBe(true);
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
  it("allows and records an unexpected canUseTool call in bypass mode", async () => {
    const fake = new FakeSdkClient();
    const session = new ClaudeSession("test-agent", fake, {
      ...minimalSdkOpts(),
      permissionMode: "bypassPermissions",
    });
    const canUseTool = fake.createCalls[0].opts.canUseTool!;
    const stream = session.stream()[Symbol.asyncIterator]();
    const result = canUseTool(
      "Bash",
      { command: "API_TOKEN=very-secret-value printf ok" },
      fakeCallOpts("bypass-1"),
    );
    expect(await nextEvent(stream)).toEqual({
      kind: "system_text",
      text: 'Isomux allowed an unexpected SDK permission request because this agent uses bypassPermissions. Tool: Bash. Input: {"command":"API_TOKEN=[REDACTED] printf ok"}.',
    });
    expect(await result).toEqual({
      behavior: "allow",
      updatedInput: { command: "API_TOKEN=very-secret-value printf ok" },
    });
  });

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
    // End the stream, so a missing withdrawal fails the assertion below
    // instead of waiting for an event that never comes.
    session.close();
    const rest: unknown[] = [];
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      rest.push(next.value);
    }
    // MUTANT: no withdrawal, so the orchestrator keeps a card for a request
    // that no answer can reach.
    expect(rest).toEqual([{ kind: "approval_withdrawn", approvalId: "u7" }]);
  });

  it("withdraws nothing when close() ends a pending approval", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const ctrl = new AbortController();
    void canUseTool("X", {}, fakeCallOpts("u8", { signal: ctrl.signal }));
    await nextEvent(it);
    session.close();
    // The SDK's cleanup aborts every request signal after close().
    ctrl.abort();
    const rest: unknown[] = [];
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toEqual([]);
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

describe("ClaudeSession plugin reload and command list", () => {
  it("reloads through the session's conversation", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const reload: SessionPluginReload = {
      plugins: [{ name: "p", path: "/plugins/p", source: "p@m" }],
      commands: [{ name: "p:s", description: "skill" }],
      toolsChanged: true,
      errorCount: 1,
    };
    let calls = 0;
    (conv as SdkConversation).reloadPlugins = async () => {
      calls++;
      return reload;
    };
    expect(await session.reloadPlugins()).toEqual(reload);
    expect(calls).toBe(1);
  });

  it("lists commands through the session's conversation", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const rows: CommandRow[] = [
      { name: "docx", description: "Docs", aliases: ["anthropic-skills:docx"] },
    ];
    (conv as SdkConversation).listCommands = async () => rows;
    expect(await session.listCommands()).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// createClaudeBackend - module-level backend functions
// ---------------------------------------------------------------------------

describe("createClaudeBackend.listModels", () => {
  it("lists the same effort levels for every family, haiku included", async () => {
    const backend = createClaudeBackend(new FakeSdkClient());
    const models = await backend.listModels({ cwd: "/tmp" });
    const efforts = (id: string) =>
      models
        .find((model) => model.id === id)
        ?.supportedEfforts.map((option) => option.level);
    expect(efforts("sonnet")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    for (const family of ["opus", "fable", "haiku"])
      expect(efforts(family)).toEqual(efforts("sonnet"));
  });
});

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
    expect(fake.forkCalls).toMatchObject([
      {
        sessionId: "s-1",
        opts: {
          upToMessageId: "a-0",
          dir: process.cwd(),
          sessionStore: {
            load: expect.any(Function),
            append: expect.any(Function),
          },
        },
      },
    ]);
    expect(result).toEqual({
      kind: "fork",
      sessionId: "forked-99",
      forkedFromSessionId: "s-1",
    });
  });

  it("copies the whole transcript for a null target", async () => {
    // null: the edited message never reached the transcript (Stop before
    // send), so the branch keeps everything.
    const fake = new FakeSdkClient();
    withMessages(fake, [
      { uuid: "u-0", type: "user" },
      { uuid: "a-0", type: "assistant" },
    ]);
    fake.forkResult = { sessionId: "forked-all" };
    const backend = createClaudeBackend(fake);
    const result = await backend.forkSessionBeforeMessage("s-1", null);
    expect(fake.forkCalls).toHaveLength(1);
    expect(fake.forkCalls[0].sessionId).toBe("s-1");
    expect(fake.forkCalls[0].opts).not.toHaveProperty("upToMessageId");
    expect(result).toEqual({
      kind: "fork",
      sessionId: "forked-all",
      forkedFromSessionId: "s-1",
    });
  });

  it("returns fresh for a null target on an empty transcript", async () => {
    const fake = new FakeSdkClient();
    withMessages(fake, []);
    const backend = createClaudeBackend(fake);
    expect(await backend.forkSessionBeforeMessage("s-1", null)).toEqual({
      kind: "fresh",
    });
    expect(fake.forkCalls).toHaveLength(0);
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
  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    for (const family of ["opus", "sonnet", "haiku", "fable"]) {
      it(`passes ${family} and its cloud pin through create, resume and one-shot for ${selector}`, async () => {
        const fake = new FakeSdkClient();
        const backend = createClaudeBackend(fake);
        const env = {
          [selector]: "1",
          [`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]:
            "provider-model-id",
          AWS_REGION: "us-east-1",
        };
        const opts = {
          agentId: "cloud-agent",
          modelFamily: family,
          env,
          cwd: "/tmp",
          systemPrompt: "test",
          permissionMode: "default",
          effort: "high",
        };
        const created = backend.createSession(opts);
        const resumed = backend.resumeSession("cloud-session", opts);
        await backend.oneShotPrompt("Topic", opts);
        // These are the options sent into query(), not persisted agent state.
        expect(sessionOptsToV1(fake.createCalls[0].opts)).toMatchObject({
          model: family,
          env,
        });
        expect(
          sessionOptsToV1(fake.resumeCalls[0].opts, "cloud-session"),
        ).toMatchObject({ model: family, env, resume: "cloud-session" });
        expect(fake.oneShotCalls[0]).toMatchObject({ model: family, env });
        created.close();
        resumed.close();
      });
    }
  }

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

// Task 2bd836d5: the session names the provider its env selects, on both
// start paths. The line is a message each reader words (task c37a7365).
describe("createClaudeBackend - provider refusal", () => {
  for (const path of ["createSession", "resumeSession"] as const)
    it(`${path} words a 403 with the env's provider`, async () => {
      const fake = new FakeSdkClient();
      const backend = createClaudeBackend(fake);
      const opts = {
        agentId: "refusal-agent",
        modelFamily: "opus",
        env: { CLAUDE_CODE_USE_VERTEX: "1" },
        cwd: "/tmp",
        systemPrompt: "test",
        permissionMode: "default",
        effort: "high",
      };
      const session =
        path === "createSession"
          ? backend.createSession(opts)
          : backend.resumeSession("refusal-session", opts);
      const it = session.stream()[Symbol.asyncIterator]();
      fake.conversations.at(-1)!.emit({
        type: "assistant",
        error: "authentication_failed",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "Failed to authenticate. API Error: 403 Request not allowed",
            },
          ],
        },
      });
      expect(await nextEvent(it)).toEqual({
        kind: "system_text",
        text: msg("systemEntries.providerRefused", {
          provider: "vertex",
          message: "403 Request not allowed",
        }),
      });
      session.close();
    });
});

describe("createClaudeBackend - limited families on Bedrock and Vertex", () => {
  // The cloud sonnet and haiku aliases resolve to Sonnet 4.5 and Haiku 4.5,
  // which take no effort and no auto mode: no effort goes out, and auto runs
  // as default, never bypassPermissions. A 5.x pin, first-party, and the
  // other families keep both.
  function launch(
    modelFamily: string,
    permissionMode: string,
    env: Record<string, string>,
  ) {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    const opts = {
      agentId: "cloud-agent",
      modelFamily,
      env,
      cwd: "/tmp",
      systemPrompt: "test",
      permissionMode,
      effort: "high",
    };
    backend.createSession(opts).close();
    backend.resumeSession("cloud-session", opts).close();
    return [fake.createCalls[0].opts, fake.resumeCalls[0].opts];
  }

  function expectLimited(opts: ReturnType<typeof launch>[number]) {
    expect(opts.effort).toBeUndefined();
    expect(opts.permissionMode).toBe("default");
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
  }

  function expectFull(opts: ReturnType<typeof launch>[number]) {
    expect(opts.effort).toBe("high");
    expect(opts.permissionMode).toBe("auto");
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
  }

  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    const cloud = { [selector]: "1" };

    for (const family of ["haiku", "sonnet"]) {
      it(`sends no effort and runs auto as default for ${family} on ${selector}`, () => {
        for (const opts of launch(family, "auto", cloud)) expectLimited(opts);
      });

      it(`keeps a non-auto ${family} mode on ${selector}`, () => {
        for (const opts of launch(family, "bypassPermissions", cloud)) {
          expect(opts.effort).toBeUndefined();
          expect(opts.permissionMode).toBe("bypassPermissions");
          expect(opts.allowDangerouslySkipPermissions).toBe(true);
        }
      });
    }

    it(`keeps effort and auto for a pinned Haiku 5.5 on ${selector}`, () => {
      const env = {
        ...cloud,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-5-5",
      };
      for (const opts of launch("haiku", "auto", env)) expectFull(opts);
    });

    it(`keeps effort and auto for a pinned Sonnet 5.x on ${selector}`, () => {
      const env = {
        ...cloud,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      };
      for (const opts of launch("sonnet", "auto", env)) expectFull(opts);
    });

    for (const family of ["opus", "fable"]) {
      it(`keeps effort and auto for ${family} on ${selector}`, () => {
        for (const opts of launch(family, "auto", cloud)) expectFull(opts);
      });
    }
  }

  for (const family of ["haiku", "sonnet"]) {
    it(`keeps effort and auto for first-party ${family}`, () => {
      for (const opts of launch(family, "auto", { FOO: "bar" }))
        expectFull(opts);
    });
  }
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
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
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

  it("opts bypass mode into the SDK and keeps dangerous commands denied by hooks", async () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    backend.createSession({
      ...createOpts,
      permissionMode: "bypassPermissions",
    });
    const sdkOpts = fake.createCalls[0].opts;
    expect(sdkOpts.allowDangerouslySkipPermissions).toBe(true);
    const bashMatcher = sdkOpts.hooks?.PreToolUse?.find(
      (matcher) => matcher.matcher === "Bash",
    );
    expect(bashMatcher?.hooks).toHaveLength(1);
    const hook = bashMatcher!.hooks[0];
    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        cwd: "/tmp",
      } as Parameters<typeof hook>[0],
      undefined,
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("the safety hooks refuse the login in the session's CODEX_HOME", async () => {
    // task be7f9436: a custom-named home is matched by the path the session
    // env names, so the env must reach the hooks.
    const codexHome = "/tmp/t-be7f9436-claude/my-codex";
    const readDecision = async (
      env: Record<string, string>,
      takeToolBoundaryMessage?: () => null,
    ) => {
      const fake = new FakeSdkClient();
      createClaudeBackend(fake).createSession({
        ...createOpts,
        env,
        ...(takeToolBoundaryMessage ? { takeToolBoundaryMessage } : {}),
      });
      const hook = fake.createCalls[0].opts.hooks!.PreToolUse!.find(
        (matcher) => matcher.matcher === "Read",
      )!.hooks[0];
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: `${codexHome}/auth.json` },
          cwd: "/tmp",
        } as Parameters<typeof hook>[0],
        undefined,
        { signal: new AbortController().signal },
      );
      return (
        (output as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision ?? "allow"
      );
    };
    // Both hook shapes buildSdkOpts builds: with and without the tool-boundary
    // callback the orchestrator passes.
    for (const take of [undefined, () => null]) {
      expect(await readDecision({ CODEX_HOME: codexHome }, take)).toBe("deny");
      expect(await readDecision({}, take)).toBe("allow");
    }
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

describe("Claude launch telemetry settings", () => {
  for (const env of [undefined, { DISABLE_TELEMETRY: "", KEEP_ME: "yes" }]) {
    it(`disables vendor telemetry on create, resume and one-shot (${env ? "explicit" : "inherited"} env)`, async () => {
      const fake = new FakeSdkClient();
      const backend = createClaudeBackend(fake);
      const opts = {
        agentId: "telemetry-test",
        effort: "low",
        cwd: "/tmp",
        systemPrompt: "sys",
        modelFamily: "haiku",
        permissionMode: "default",
        env,
      };
      backend.createSession(opts);
      backend.resumeSession("telemetry-session", opts);
      await backend.oneShotPrompt("hello", opts);
      for (const call of [
        fake.createCalls[0].opts,
        fake.resumeCalls[0].opts,
        fake.oneShotCalls[0],
      ]) {
        expect(call.settings).toMatchObject({
          autoMemoryEnabled: false,
          env: { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
        });
        expect(call.env).toEqual(env);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Tool-boundary delivery (tasks 0a248523, 7529b23b)
// ---------------------------------------------------------------------------

describe("tool-boundary delivery hook", () => {
  const batchInput = (agentId?: string) =>
    ({
      hook_event_name: "PostToolBatch",
      session_id: "s-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/tmp",
      tool_calls: [],
      ...(agentId ? { agent_id: agentId } : {}),
    }) as unknown as Parameters<
      ReturnType<typeof toolBoundaryHooks>[0]["hooks"][0]
    >[0];
  const run = (take: () => string | null, agentId?: string) =>
    toolBoundaryHooks(take)[0].hooks[0](batchInput(agentId), undefined, {
      signal: new AbortController().signal,
    });

  it("hands a main-thread batch the callback's text as additional context", async () => {
    expect(await run(() => "a message")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: "a message",
      },
    });
  });

  it("delivers nothing to a subagent batch and does not ask the callback", async () => {
    let asked = 0;
    const out = await run(() => {
      asked++;
      return "a message";
    }, "sub-1");
    expect(out).toEqual({});
    expect(asked).toBe(0);
  });

  it("delivers nothing when the callback has nothing or throws", async () => {
    expect(await run(() => null)).toEqual({});
    expect(
      await run(() => {
        throw new Error("boom");
      }),
    ).toEqual({});
  });

  it("is registered only when the orchestrator passes a callback", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    expect(backend.toolBoundaryDelivery).toBe(true);
    const base = {
      agentId: "a",
      cwd: "/tmp",
      systemPrompt: "",
      modelFamily: "opus",
      effort: "high",
      permissionMode: "default",
    };
    backend.createSession(base);
    backend.createSession({ ...base, takeToolBoundaryMessage: () => null });
    expect(fake.createCalls[0].opts.hooks?.PostToolBatch).toBeUndefined();
    expect(fake.createCalls[1].opts.hooks?.PostToolBatch).toHaveLength(1);
    // The safety hooks stay in place next to it: the same tools, each with
    // its hook. (Each session builds its own callbacks, so compare the shape.)
    const shape = (i: number) =>
      fake.createCalls[i].opts.hooks?.PreToolUse?.map((m) => [
        m.matcher,
        m.hooks.length,
      ]);
    expect(shape(0)?.length).toBeGreaterThan(0);
    expect(shape(1)).toEqual(shape(0));
  });
});

describe("Claude cloud defaults at the SDK boundary", () => {
  for (const env of [
    { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" },
    { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "ap-northeast-1" },
    { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "global" },
    { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" },
  ]) {
    it(`uses the same defaults for create, resume and titles in ${JSON.stringify(env)}`, async () => {
      const fake = new FakeSdkClient();
      const backend = createClaudeBackend(fake);
      const opts = {
        agentId: "cloud-defaults",
        cwd: "/tmp",
        systemPrompt: "test",
        modelFamily: "sonnet",
        permissionMode: "auto",
        effort: "high",
        env,
      };
      const created = backend.createSession(opts);
      const resumed = backend.resumeSession("cloud-defaults-session", opts);
      await backend.oneShotPrompt("Topic", opts);
      const covered =
        env.AWS_REGION === "eu-west-1" || env.CLOUD_ML_REGION === "global";
      const expected =
        env.AWS_REGION === "eu-west-1"
          ? "eu.anthropic.claude-sonnet-5-5"
          : covered
            ? "claude-sonnet-5-5"
            : undefined;
      for (const call of [
        fake.createCalls[0].opts,
        fake.resumeCalls[0].opts,
        fake.oneShotCalls[0],
      ]) {
        expect(call.model).toBe("sonnet");
        expect(call.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(expected);
        expect(call.env).toMatchObject(env);
      }
      for (const call of [fake.createCalls[0].opts, fake.resumeCalls[0].opts]) {
        expect(call.effort).toBe(covered ? "high" : undefined);
        expect(call.permissionMode).toBe(covered ? "auto" : "default");
      }
      created.close();
      resumed.close();
    });
  }

  it("uses the agent host base environment when the caller has no env", async () => {
    const { getAgentHost, setAgentHost } = await import("../agent-host.ts");
    const previous = getAgentHost();
    const env = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      RUNNER_ONLY: "kept",
    };
    setAgentHost({ ...previous, kind: "runner", baseEnv: () => env });
    try {
      const fake = new FakeSdkClient();
      const backend = createClaudeBackend(fake);
      const opts = {
        agentId: "runner-defaults",
        cwd: "/tmp",
        systemPrompt: "test",
        modelFamily: "sonnet",
        permissionMode: "auto",
        effort: "high",
      };
      const created = backend.createSession(opts);
      const resumed = backend.resumeSession("runner-defaults-session", opts);
      await backend.oneShotPrompt("Topic", opts);
      for (const call of [
        fake.createCalls[0].opts,
        fake.resumeCalls[0].opts,
        fake.oneShotCalls[0],
      ]) {
        expect(call.model).toBe("sonnet");
        expect(call.env).toEqual({
          ...env,
          ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-5-5",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-5-5",
        });
      }
      expect(env).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL");
      created.close();
      resumed.close();
    } finally {
      setAgentHost(previous);
    }
  });
});

// Remote MCP servers (integrations A2) reach the SDK client as their own
// argument, for setMcpServers. Never in the Options: the SDK puts its
// mcpServers option on the CLI's argv, headers included.
describe("ClaudeBackend remote MCP servers", () => {
  const value = "fake-claude-mcp-value-0000";
  const opts = {
    agentId: "agent-mcp",
    cwd: "/tmp",
    systemPrompt: "sys",
    modelFamily: "haiku",
    effort: "high",
    permissionMode: "default",
    mcpServers: [
      {
        name: "isomux-docs",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: `Bearer ${value}` },
      },
    ],
  };
  const expected: SdkMcpRegistration = {
    agentId: "agent-mcp",
    servers: {
      "isomux-docs": {
        type: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: `Bearer ${value}` },
      },
    },
  };

  it("hands them over on create and on resume, never inside the Options", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    backend.createSession(opts);
    backend.resumeSession("s-1", opts);
    expect(fake.createCalls[0].mcp).toEqual(expected);
    expect(fake.resumeCalls[0].mcp).toEqual(expected);
    for (const sdkOpts of [
      fake.createCalls[0].opts,
      fake.resumeCalls[0].opts,
    ]) {
      expect(sdkOpts).not.toHaveProperty("mcpServers");
      expect(sdkOpts).not.toHaveProperty("extraArgs");
      const v1 = sessionOptsToV1(sdkOpts, "s-1");
      expect(v1.mcpServers).toBeUndefined();
      expect(JSON.stringify(v1)).not.toContain(value);
      expect(JSON.stringify(v1.env ?? {})).not.toContain(value);
    }
  });

  it("hands over nothing when there are none", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    backend.createSession({ ...opts, mcpServers: [] });
    backend.createSession({ ...opts, mcpServers: undefined });
    expect(fake.createCalls.map((call) => call.mcp)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("an agent with secrets in scope (secrets design, section 2.3)", () => {
  it("the Claude process gets the placeholders and the proxy and CA variables, never the value", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    const env = secretAgentEnvironment();
    const session = backend.createSession({
      agentId: "secret-agent",
      modelFamily: "sonnet",
      env,
      cwd: "/tmp",
      systemPrompt: "test",
      permissionMode: "default",
      effort: "high",
    });
    const sent = sessionOptsToV1(fake.createCalls[0].opts).env as Record<
      string,
      string | undefined
    >;
    for (const [name, value] of Object.entries(EXPECTED))
      expect(sent[name], name).toBe(value);
    expect(JSON.stringify(sent)).not.toContain(SECRET_VALUE);
    session.close();
  });
});

describe("MCP servers with a secret (secrets B2)", () => {
  it("setMcpServers gets the placeholder in the header, never the value", () => {
    const { servers, placeholder } = placeholderMcpServers();
    expect(servers).toHaveLength(1);
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    const session = backend.createSession({
      agentId: "mcp-agent",
      cwd: "/tmp",
      systemPrompt: "sys",
      modelFamily: "haiku",
      effort: "high",
      permissionMode: "default",
      mcpServers: servers,
    });
    const text = JSON.stringify(fake.createCalls[0].mcp);
    session.close();
    expect(text).toContain(placeholder);
    expect(text).not.toContain(MCP_SECRET_VALUE);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession - native plan mode (permissionMode "plan")
// ---------------------------------------------------------------------------

describe("ClaudeSession plan mode", () => {
  const PLAN = "# Plan\n\n1. Write hello.txt";
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for ExitPlanMode under bypassPermissions instead of allowing it", async () => {
    const fake = new FakeSdkClient();
    // The member turned plan mode on (/plan).
    const session = new ClaudeSession(
      "test-agent",
      fake,
      { ...minimalSdkOpts(), permissionMode: "bypassPermissions" },
      undefined,
      undefined,
      true,
    );
    const canUseTool = fake.createCalls[0].opts.canUseTool!;
    const it = session.stream()[Symbol.asyncIterator]();
    let settled = false;
    const result = canUseTool(
      "ExitPlanMode",
      { plan: PLAN },
      fakeCallOpts("exit-1"),
    ).then((r) => {
      settled = true;
      return r;
    });
    expect((await nextEvent(it))?.kind).toBe("assistant_text");
    expect((await nextEvent(it))?.kind).toBe("approval_request");
    await tick();
    expect(settled).toBe(false);
    await session.approve("exit-1", { kind: "deny" });
    expect((await result)?.behavior).toBe("deny");
  });

  it("puts the plan into the chat just before its approval request", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    void canUseTool("ExitPlanMode", { plan: PLAN }, fakeCallOpts("exit-2"));
    expect(await nextEvent(it)).toEqual({ kind: "assistant_text", text: PLAN });
    expect(await nextEvent(it)).toMatchObject({
      kind: "approval_request",
      approvalId: "exit-2",
      toolName: "ExitPlanMode",
    });
  });

  it("planMode enters plan mode after launch, and the first send waits for it", async () => {
    const fake = new FakeSdkClient();
    let release!: () => void;
    fake.nextPermissionModeResult = new Promise<void>((r) => (release = r));
    const session = new ClaudeSession(
      "test-agent",
      fake,
      minimalSdkOpts(),
      undefined,
      undefined,
      true,
    );
    const conv = fake.conversations[0];
    // The launch keeps the configured mode, so an approved plan returns to it.
    expect(fake.createCalls[0].opts.permissionMode).toBe("default");
    expect(conv.permissionModeCalls).toEqual(["plan"]);
    const sent = session.send("go");
    await tick();
    expect(conv.sends).toEqual([]);
    release();
    await sent;
    expect(conv.sends).toEqual(["go"]);
  });

  it("a refused start-in-plan request reports plan mode off", async () => {
    const fake = new FakeSdkClient();
    fake.nextPermissionModeResult = Promise.reject(new Error("no plan mode"));
    const session = new ClaudeSession(
      "test-agent",
      fake,
      minimalSdkOpts(),
      undefined,
      undefined,
      true,
    );
    const it = session.stream()[Symbol.asyncIterator]();
    expect(await nextEvent(it)).toEqual({
      kind: "system_text",
      text: "no plan mode",
    });
    expect(await nextEvent(it)).toEqual({ kind: "plan_mode", on: false });
  });

  // Drains the stream until the conversation finishes.
  async function streamKinds(session: ClaudeSession): Promise<string[]> {
    const it = session.stream()[Symbol.asyncIterator]();
    const kinds: string[] = [];
    for (;;) {
      const ev = await nextEvent(it);
      if (!ev) return kinds;
      kinds.push(ev.kind === "plan_mode" ? `plan_mode:${ev.on}` : ev.kind);
    }
  }

  it("a plan the model entered under bypassPermissions keeps the bypass allow", async () => {
    const fake = new FakeSdkClient();
    const session = new ClaudeSession("test-agent", fake, {
      ...minimalSdkOpts(),
      permissionMode: "bypassPermissions",
    });
    const conv = fake.conversations[0];
    const canUseTool = fake.createCalls[0].opts.canUseTool!;
    const kinds = streamKinds(session);
    // EnterPlanMode: the CLI reports plan with no /plan from the member.
    conv.emit({ type: "system", subtype: "status", permissionMode: "plan" });
    await tick();
    let result: Awaited<ReturnType<CanUseTool>> | null = null;
    void canUseTool(
      "ExitPlanMode",
      { plan: PLAN },
      fakeCallOpts("exit-model"),
    ).then((r) => (result = r));
    await tick();
    // Settled with no member answer: nothing waits for an approval.
    expect(result).toMatchObject({ behavior: "allow" });
    conv.emit({
      type: "system",
      subtype: "status",
      permissionMode: "bypassPermissions",
    });
    conv.finish();
    expect(await kinds).toEqual(["system_text"]);
  });

  it("a plan the model entered is not reported as the member's plan mode", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    const kinds = streamKinds(session);
    conv.emit({ type: "system", subtype: "status", permissionMode: "plan" });
    conv.emit({ type: "system", subtype: "status", permissionMode: "default" });
    conv.finish();
    expect(await kinds).toEqual([]);
  });

  it("reports the plan state the CLI announces, once per change", async () => {
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    await session.setPlanMode(true);
    const it = session.stream()[Symbol.asyncIterator]();
    const modes: boolean[] = [];
    const drain = (async () => {
      for (;;) {
        const ev = await nextEvent(it);
        if (!ev) return;
        if (ev.kind === "plan_mode") modes.push(ev.on);
      }
    })();
    for (const [subtype, permissionMode] of [
      ["init", "default"],
      ["status", "plan"],
      ["init", "plan"],
      // Approving ExitPlanMode: the CLI returns to the mode before plan.
      ["status", "default"],
      // Later the model enters plan mode itself: not the member's plan.
      ["status", "plan"],
    ])
      conv.emit({ type: "system", subtype, permissionMode, session_id: "s" });
    conv.finish();
    await drain;
    expect(modes).toEqual([true, false]);
  });

  it("setPlanMode enters plan mode and leaves it to the configured mode", async () => {
    const fake = new FakeSdkClient();
    const session = new ClaudeSession("test-agent", fake, {
      ...minimalSdkOpts(),
      permissionMode: "acceptEdits",
    });
    await session.setPlanMode(true);
    await session.setPlanMode(false);
    expect(fake.conversations[0].permissionModeCalls).toEqual([
      "plan",
      "acceptEdits",
    ]);
  });

  it("the backend passes planMode to the session", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    expect(backend.planMode).toBe(true);
    const opts = {
      agentId: "agent-plan",
      cwd: "/tmp",
      systemPrompt: "sys",
      modelFamily: "opus",
      effort: "high",
      permissionMode: "default",
    };
    backend.createSession({ ...opts, planMode: true });
    backend.resumeSession("s-1", { ...opts, planMode: true });
    backend.createSession(opts);
    expect(fake.conversations.map((c) => c.permissionModeCalls)).toEqual([
      ["plan"],
      ["plan"],
      [],
    ]);
  });
});
