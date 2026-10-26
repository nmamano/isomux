import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
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
  ClaudeSession,
  createClaudeBackend,
  oneShotQueryOptions,
  sessionOptsToV1,
  type SdkClient,
  type SdkConversation,
  type SdkMcpRegistration,
  type SdkOneShotOptions,
} from "./claude";
import type {
  CommandRow,
  ContextUsage,
  NormalizedEvent,
  SessionPluginReload,
  SubscriptionUsageResult,
} from "./types";
import { msg } from "../../shared/i18n/log-message.ts";
import { FAMILY_TO_MODEL } from "../../shared/types.ts";
import { removeStateDir } from "../test-support/temp-state.ts";

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
    const started = (await nextEvent(it)) as { label: string };
    expect(started).toMatchObject({
      kind: "task_lifecycle",
      phase: "started",
      taskId: "b1",
    });
    expect(started.label).toContain("Sleep in background");

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

  for (const [message, events] of [
    ["transport boom", [{ kind: "error", message: "transport boom" }]],
    [
      "401 Unauthorized",
      [{ kind: "auth_needed" }, { kind: "error", message: "401 Unauthorized" }],
    ],
  ] as const) {
    it(`emits ${events.map((e) => e.kind).join(" + ")} when the conversation throws mid-stream`, async () => {
      const fake = new FakeSdkClient();
      const { session, conv } = makeSession(fake);
      const it = session.stream()[Symbol.asyncIterator]();
      conv.throwNext(new Error(message));
      for (const event of events) expect(await nextEvent(it)).toEqual(event);
      expect((await it.next()).done).toBe(true);
    });
  }

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
  // Attachments follow the shared path-notice convention
  // (server/attachment-prompt.ts owns the line format, skip and order): one
  // notice block after the text, never inlined; the SDK rejects empty content.
  const FILES_DIR = join(STATE_ROOT, "logs", "test-agent", "files");
  const att = (filename: string, mediaType: string) => ({
    filename,
    originalName: filename,
    mediaType,
    size: 1,
  });
  afterAll(() => removeStateDir(join(STATE_ROOT, "logs", "test-agent")));

  it("sends text alone as a string, and text with attachments as one notice block after it", async () => {
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(join(FILES_DIR, "shot.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(FILES_DIR, "notes.md"), "SECRET CONTENTS\n");
    const fake = new FakeSdkClient();
    const { session, conv } = makeSession(fake);
    await session.send("hello");
    await session.send("see attached", [
      att("shot.png", "image/png"),
      att("missing.txt", "text/plain"),
      att("notes.md", "text/markdown"),
    ]);
    await session.send("", [att("missing.txt", "text/plain")]);
    await session.send("", [att("shot.png", "image/png")]);
    expect(conv.sends[0]).toBe("hello");
    const blocks = conv.sends.slice(1).map(
      (sent) =>
        (sent as SDKUserMessage).message.content as {
          type: string;
          text: string;
        }[],
    );
    expect(blocks[0].map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0][0].text).toBe("see attached");
    const lines = blocks[0][1].text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(join(FILES_DIR, "shot.png"));
    expect(lines[1]).toContain(join(FILES_DIR, "notes.md"));
    expect(blocks[0][1].text).not.toContain("SECRET CONTENTS");
    expect(blocks[1]).toEqual([{ type: "text", text: "" }]);
    expect(blocks[2]).toHaveLength(1);
    expect(blocks[2][0].text).toContain(join(FILES_DIR, "shot.png"));
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
    // An audit line naming the tool, with the secret redacted.
    const audit = (await nextEvent(stream)) as { kind: string; text: string };
    expect(audit.kind).toBe("system_text");
    expect(audit.text).toContain("Bash");
    expect(audit.text).toContain("API_TOKEN=[REDACTED]");
    expect(audit.text).not.toContain("very-secret-value");
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
      allowPersistentLabel: expect.any(String),
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
    const ev = (await nextEvent(it)) as { title: string; description: string };
    expect(ev.title).toContain("Read");
    expect(ev.description).toBe("outside allow list");
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

  it("deny resolves the SDK promise with behavior:deny and reason", async () => {
    const fake = new FakeSdkClient();
    const { session, canUseTool } = makeSession(fake);
    const it = session.stream()[Symbol.asyncIterator]();
    const decision = canUseTool("Bash", { cmd: "rm" }, fakeCallOpts("u5"));
    await nextEvent(it);
    await session.approve("u5", { kind: "deny", reason: "too risky" });
    const result = await decision;
    expect(result).toEqual({ behavior: "deny", message: "too risky" });
    // A second answer finds nothing to answer and does not throw.
    await session.approve("u5", { kind: "allow_once" });
    // Without a reason, the deny still carries a message.
    const unexplained = canUseTool("X", {}, fakeCallOpts("u6"));
    await nextEvent(it);
    await session.approve("u6", { kind: "deny" });
    const denied = (await unexplained) as { behavior: string; message: string };
    expect(denied.behavior).toBe("deny");
    expect(denied.message.length).toBeGreaterThan(0);
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
    expect(await decision).toMatchObject({ behavior: "deny" });
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
});

// ---------------------------------------------------------------------------
// ClaudeSession - abort / canAbortInPlace
// ---------------------------------------------------------------------------

describe("ClaudeSession abort", () => {
  // The orchestrator's hot-abort dispatch gates on canAbortInPlace().
  it("cannot abort in place: canAbortInPlace() is false and abort() rejects", async () => {
    const fake = new FakeSdkClient();
    const { session } = makeSession(fake);
    expect(session.canAbortInPlace()).toBe(false);
    await expectRejection(session.abort(), /unsupported/);
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

  it("forks at the predecessor message when target is mid-conversation", async () => {
    const fake = new FakeSdkClient();
    withMessages(fake, [
      { uuid: "u-0", type: "user" },
      { uuid: "a-0", type: "assistant" },
      { uuid: "u-target", type: "user" },
    ]);
    fake.forkResult = { sessionId: "forked-99" };
    const backend = createClaudeBackend(fake);
    const result = await backend.forkSessionBeforeMessage("s-1", "u-target", {
      cwd: "/work/agent",
      modelFamily: "opus",
      permissionMode: "default",
    });
    expect(fake.forkCalls).toMatchObject([
      {
        sessionId: "s-1",
        opts: {
          upToMessageId: "a-0",
          dir: "/work/agent",
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
  // Edit matching reads this text: text blocks join without a separator,
  // other blocks and a text block with no text are skipped.
  it("normalizes user/assistant/system messages and skips other types", async () => {
    const fake = new FakeSdkClient();
    fake.sessionMessagesResult = [
      { uuid: "u-1", type: "user", message: { content: "hi" } },
      {
        uuid: "a-1",
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hel" },
            { type: "tool_use", id: "x", name: "R", input: {} },
            { type: "text" },
            { type: "text", text: "lo" },
          ],
        },
      },
      { uuid: "s-1", type: "system", message: { content: "init" } },
      { uuid: "u-2", type: "user", message: { content: null } },
      { uuid: "r-1", type: "result", message: { content: "n/a" } },
    ] as unknown as SessionMessage[];
    const backend = createClaudeBackend(fake);
    const out = await backend.getSessionMessages("s-1", "/tmp");
    expect(out).toEqual([
      { uuid: "u-1", role: "user", text: "hi" },
      { uuid: "a-1", role: "assistant", text: "hello" },
      { uuid: "s-1", role: "system", text: "init" },
      { uuid: "u-2", role: "user", text: "" },
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
    // First party: the family resolves to its concrete model id.
    expect(call.model).toBe(FAMILY_TO_MODEL.haiku);
    expect(call.pathToClaudeCodeExecutable.length).toBeGreaterThan(0);
  });

  // Task c52bd005: with no strict MCP config the CLI loads the member's
  // claude.ai connectors as full tool schemas (tools: [] also removes
  // ToolSearch), about 36k input tokens on each topic or summary call.
  it("builds a one-shot query with no MCP servers, tools or setting sources", async () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    const env = { FOO: "bar" };
    await backend.oneShotPrompt("Summarize", {
      modelFamily: "haiku",
      systemPrompt: "sys",
      env,
    });
    const { prompt, ...call } = fake.oneShotCalls[0];
    expect(prompt).toBe("Summarize");
    expect(call.settings).toBeDefined();
    const options = oneShotQueryOptions(call);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toBeUndefined();
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options).toMatchObject({
      model: call.model,
      pathToClaudeCodeExecutable: call.pathToClaudeCodeExecutable,
      systemPrompt: "sys",
      settings: call.settings,
      env,
      thinking: { type: "disabled" },
      cwd: "/tmp",
    });
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

// The cloud sonnet and haiku aliases resolve to models that take no effort
// and no auto mode; "Claude cloud defaults at the SDK boundary" below holds
// the auto downgrade, and claude-install-check.test.ts which families are
// limited. A limited family never downgrades bypassPermissions.
describe("createClaudeBackend - limited families on Bedrock and Vertex", () => {
  it("keeps bypassPermissions for a limited family, with no effort", () => {
    const fake = new FakeSdkClient();
    const backend = createClaudeBackend(fake);
    const opts = {
      agentId: "cloud-agent",
      modelFamily: "haiku",
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      cwd: "/tmp",
      systemPrompt: "test",
      permissionMode: "bypassPermissions",
      effort: "high",
    };
    backend.createSession(opts).close();
    backend.resumeSession("cloud-session", opts).close();
    for (const call of [fake.createCalls[0].opts, fake.resumeCalls[0].opts]) {
      expect(call.effort).toBeUndefined();
      expect(call.permissionMode).toBe("bypassPermissions");
      expect(call.allowDangerouslySkipPermissions).toBe(true);
    }
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
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
    // Nor in the Options query() receives.
    for (const bag of [opts, sessionOptsToV1(opts)]) {
      expect(bag).not.toHaveProperty("executableArgs");
      expect(bag).not.toHaveProperty("extraArgs");
    }
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
    // A resumed agent keeps its approval prompts.
    expect(fake.resumeCalls[0].opts.canUseTool).toBeInstanceOf(Function);
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

// Backend-native memory off (task 3f6ff5e0) and vendor telemetry off: what
// isomux HANDS the SDK on every launch path. A top-level `autoMemoryEnabled`
// is not an SDK Option and would be dropped silently, so the assertion is on
// the nested settings object. Options.env replaces the child env, so an
// absent env stays absent. Whether the SDK honours the settings is the live
// probe's claim, not this test's.
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
  // The PostToolBatch hook the session hands the SDK for this callback.
  const run = (take: () => string | null, agentId?: string) => {
    const fake = new FakeSdkClient();
    createClaudeBackend(fake).createSession({
      agentId: "a",
      cwd: "/tmp",
      systemPrompt: "",
      modelFamily: "opus",
      effort: "high",
      permissionMode: "default",
      takeToolBoundaryMessage: take,
    });
    const hook = fake.createCalls[0].opts.hooks!.PostToolBatch![0].hooks[0];
    return hook(
      {
        hook_event_name: "PostToolBatch",
        session_id: "s-1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp",
        tool_calls: [],
        ...(agentId ? { agent_id: agentId } : {}),
      } as unknown as Parameters<typeof hook>[0],
      undefined,
      { signal: new AbortController().signal },
    );
  };

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
  // One region the defaults cover and one they do not; the region table is
  // claude-cloud-defaults.test.ts's.
  for (const env of [
    { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" },
    { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5" },
  ] as Record<string, string>[]) {
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
      const covered = env.AWS_REGION === "eu-west-1";
      const expected = covered ? "eu.anthropic.claude-sonnet-5-5" : undefined;
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
    // The plan reaches the chat just before its approval request.
    expect(await nextEvent(it)).toEqual({ kind: "assistant_text", text: PLAN });
    expect(await nextEvent(it)).toMatchObject({
      kind: "approval_request",
      approvalId: "exit-1",
      toolName: "ExitPlanMode",
    });
    await tick();
    expect(settled).toBe(false);
    await session.approve("exit-1", { kind: "deny" });
    expect((await result)?.behavior).toBe("deny");
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

// Usage-limit stops on Claude, for the resume after the reset
// (server/limit-resume.ts). Driven through ClaudeSession, so the test also
// pins where the stop event lands in the session's stream.
//
// Fixture sources:
// - LIMIT_TEXT is a real limit message from an isomux conversation log
//   (~/.isomux/logs/agent-1774982211503-c244/3c59f1e7-f0c7-436a-bbb2-abe0a1e71515.jsonl,
//   2026-07-11). isomux logs keep only its text; error "rate_limit" and
//   model "<synthetic>" are how the CLI bundled with SDK 0.3.293 sends it
//   (SDKAssistantMessage.error).
// - rateLimitEvent() is a real rate_limit_event, captured 2026-10-18 from a
//   one-shot SDK query on the office account. Its status was "allowed"; the
//   tests set the status they need, and only the status.

const LIMIT_TEXT =
  "You've hit your limit · resets Jul 11, 5pm (America/Los_Angeles)";
const RESETS_AT = 1792361400;

function rateLimitEvent(status: "allowed" | "rejected", resetsAt = RESETS_AT) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: 1792361400 },
        seven_day: { utilization: 0.11, resetsAt: 1792886400 },
      },
    },
    uuid: "979fd73c-dfee-4123-a6b2-051644707b6a",
    session_id: "s-1",
  };
}

function limitMessage(parentToolUseId: string | null = null) {
  return {
    type: "assistant",
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: LIMIT_TEXT }],
    },
    parent_tool_use_id: parentToolUseId,
    error: "rate_limit",
    uuid: "u-limit",
    session_id: "s-1",
  };
}

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: LIMIT_TEXT,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  total_cost_usd: 0,
};

function makeLimitSession() {
  const { session, conv } = makeSession(new FakeSdkClient());
  const events = session.stream()[Symbol.asyncIterator]();
  // The events up to and including the next turn_completed. Every case ends
  // its turn, so a stream that ends first fails here: an absence check cannot
  // pass on an early end.
  async function turn(msgs: unknown[]): Promise<NormalizedEvent[]> {
    for (const m of msgs) conv.emit(m);
    const out: NormalizedEvent[] = [];
    for (;;) {
      const r = await events.next();
      if (r.done)
        throw new Error(`stream ended before turn_completed: ${kindsOf(out)}`);
      out.push(r.value);
      if (r.value.kind === "turn_completed") return out;
    }
  }
  return { turn, close: () => session.close() };
}

const kindsOf = (evs: NormalizedEvent[]) => evs.map((e) => e.kind).join(", ");

const kinds = (evs: NormalizedEvent[]) => evs.map((e) => e.kind);
const stops = (evs: NormalizedEvent[]) =>
  evs.filter((e) => e.kind === "usage_limit_stop");
// The CLI's limit sentence as the chat would get it.
const limitTexts = (evs: NormalizedEvent[]) =>
  evs.filter((e) => e.kind === "system_text" && e.text === LIMIT_TEXT);

describe("Claude usage-limit stop", () => {
  it("a rejected limit and the limit message report the reset, ahead of the turn's end", async () => {
    const s = makeLimitSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("rejected"),
        limitMessage(),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([
        { kind: "usage_limit_stop", resetsAtMs: RESETS_AT * 1000 },
      ]);
      // The stop replaces the CLI's sentence, which names the server's time
      // zone (task 9845e1da): Isomux words the reset for each reader. The
      // stop comes right before the turn ends.
      expect(limitTexts(evs)).toEqual([]);
      expect(kinds(evs).slice(-2)).toEqual([
        "usage_limit_stop",
        "turn_completed",
      ]);
    } finally {
      s.close();
    }
  });

  it("does not depend on the order of the event and the message", async () => {
    const s = makeLimitSession();
    try {
      const evs = await s.turn([
        limitMessage(),
        rateLimitEvent("rejected"),
        RESULT,
      ]);
      expect(stops(evs)).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("an error rate_limit with the limit allowed is not a usage limit (a plain 429)", async () => {
    const s = makeLimitSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("allowed"),
        limitMessage(),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([]);
      // No stop: the CLI's sentence is the only word on it, in its place.
      expect(limitTexts(evs)).toHaveLength(1);
      expect(kinds(evs).slice(-2)).toEqual(["system_text", "turn_completed"]);
    } finally {
      s.close();
    }
  });

  it("a rejected limit with no limit message did not stop the turn", async () => {
    const s = makeLimitSession();
    try {
      const evs = await s.turn([rateLimitEvent("rejected"), RESULT]);
      expect(stops(evs)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("a subagent's limit message alone is not the main thread's stop", async () => {
    const s = makeLimitSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("rejected"),
        limitMessage("toolu_parent"),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([]);
      expect(limitTexts(evs)).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("an unknown reset time reports no stop", async () => {
    const s = makeLimitSession();
    try {
      const event = rateLimitEvent("rejected") as {
        rate_limit_info: Record<string, unknown>;
      };
      delete event.rate_limit_info.resetsAt;
      const evs = await s.turn([event, limitMessage(), RESULT]);
      expect(stops(evs)).toEqual([]);
      expect(limitTexts(evs)).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  // The sentence waits for the result to learn whether a stop replaces it.
  // A stream that ends with no result still shows it, ahead of the error.
  it("a held limit sentence still reaches the chat when the stream throws before the result", async () => {
    const { session, conv } = makeSession(new FakeSdkClient());
    const it = session.stream()[Symbol.asyncIterator]();
    try {
      conv.emit(rateLimitEvent("rejected"));
      conv.emit(limitMessage());
      conv.throwNext(new Error("transport boom"));
      expect(await nextEvent(it)).toEqual({
        kind: "system_text",
        text: LIMIT_TEXT,
      });
      expect(await nextEvent(it)).toEqual({
        kind: "error",
        message: "transport boom",
      });
      expect((await it.next()).done).toBe(true);
    } finally {
      session.close();
    }
  });

  it("a held limit sentence still reaches the chat when the stream ends before the result", async () => {
    const { session, conv } = makeSession(new FakeSdkClient());
    const it = session.stream()[Symbol.asyncIterator]();
    try {
      conv.emit(rateLimitEvent("rejected"));
      conv.emit(limitMessage());
      conv.finish();
      expect(await nextEvent(it)).toEqual({
        kind: "system_text",
        text: LIMIT_TEXT,
      });
      expect((await it.next()).done).toBe(true);
    } finally {
      session.close();
    }
  });

  it("keeps the session's latest info: a later stop with no new event reports it again, and only that turn", async () => {
    const s = makeLimitSession();
    try {
      await s.turn([rateLimitEvent("rejected"), limitMessage(), RESULT]);
      // The CLI emits rate_limit_event only when the info changes.
      expect(stops(await s.turn([limitMessage(), RESULT]))).toEqual([
        { kind: "usage_limit_stop", resetsAtMs: RESETS_AT * 1000 },
      ]);
      // A turn with no limit message reports nothing.
      expect(
        stops(
          await s.turn([
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "ok" }] },
            },
            RESULT,
          ]),
        ),
      ).toEqual([]);
    } finally {
      s.close();
    }
  });
});
