// Codex backend — T2 adapter-contract tier.
//
// Freezes the Codex App Server -> NormalizedEvent translation by driving the
// REAL CodexSession with curated JSON-RPC provider events through a fake
// transport (CodexTransport, injected via CodexSessionInitOpts.client). Zero
// subprocess, zero LLM: plain `bun test` runs these always. The live
// end-to-end smoke lives in server/backends/live-smoke.test.ts (T3, opt-in).
//
// Fixtures are deliberately minimal — the smallest event stream that exercises
// each translation branch. They are expected to break on Codex SDK/protocol
// bumps; keeping them small keeps a refresh cheap (see
// internal-docs/generic-runtime-refactor.md, Testing strategy -> test tiers).
// Observation is always through the public CodexSession.stream(); we never call
// the private handlers directly, so these exercise the same callback wiring
// production uses (transport.onNotification / onServerRequest / onStderr /
// onExit -> handle* -> enqueue -> stream).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { STATE_ROOT } from "../../config.ts";
import { expectRejection } from "../../test-support/expect-rejection.ts";
import {
  buildCodexUserInput,
  CodexSession,
  type CodexSessionInitOpts,
  type CodexTransport,
} from "./adapter.ts";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  NotificationHandler,
  ServerRequestHandler,
} from "./client.ts";
import type { InitializeParams } from "./_generated/InitializeParams.ts";
import type { InitializeResponse } from "./_generated/InitializeResponse.ts";
import type { NormalizedEvent } from "../types.ts";

const FIXTURE_THREAD_ID = "thread-fixture-1";

// ---------------------------------------------------------------------------
// FakeCodexTransport — curated-event driver for the real adapter.
//
// Implements ONLY the production CodexTransport surface. The fire* / record
// helpers below are test-only and intentionally kept off the interface so the
// production contract stays clean.
// ---------------------------------------------------------------------------
class FakeCodexTransport implements CodexTransport {
  started = false;
  closed = false;
  threadId = FIXTURE_THREAD_ID;
  // When set, request("thread/start") rejects so we can exercise the
  // bootstrap-failure deferral path.
  bootstrapError: Error | null = null;
  readonly requests: { method: string; params?: unknown }[] = [];
  readonly errorResponses: {
    id: JsonRpcId;
    code: number;
    message: string;
  }[] = [];

  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private stderrHandler: ((chunk: string) => void) | null = null;
  private exitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;

  // ----- CodexTransport (production surface) -----
  start(): void {
    this.started = true;
  }

  initialize(_params: InitializeParams): Promise<InitializeResponse> {
    return Promise.resolve({
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "linux",
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      if (this.bootstrapError) return Promise.reject(this.bootstrapError);
      return Promise.resolve({ thread: { id: this.threadId } } as T);
    }
    // turn/start, turn/interrupt, etc.: resolve with an empty payload.
    return Promise.resolve({} as T);
  }

  respondWithError(id: JsonRpcId, code: number, message: string): void {
    this.errorResponses.push({ id, code, message });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandler = handler;
    return () => {
      this.notificationHandler = null;
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandler = handler;
    return () => {
      this.serverRequestHandler = null;
    };
  }

  onStderr(handler: (chunk: string) => void): () => void {
    this.stderrHandler = handler;
    return () => {
      this.stderrHandler = null;
    };
  }

  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void {
    this.exitHandler = handler;
    return () => {
      this.exitHandler = null;
    };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  // ----- test drivers (NOT part of CodexTransport) -----
  fireNotification(method: string, params?: unknown): void {
    if (!this.notificationHandler) throw new Error("no notification handler");
    const n: JsonRpcNotification = {
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.notificationHandler(n);
  }

  fireServerRequest(req: JsonRpcRequest): Promise<unknown> {
    if (!this.serverRequestHandler)
      throw new Error("no server-request handler");
    return this.serverRequestHandler(req);
  }

  fireStderr(chunk: string): void {
    if (!this.stderrHandler) throw new Error("no stderr handler");
    this.stderrHandler(chunk);
  }

  fireExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (!this.exitHandler) throw new Error("no exit handler");
    this.exitHandler(code, signal);
  }

  interruptCount(): number {
    return this.requests.filter((r) => r.method === "turn/interrupt").length;
  }
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
const DEFAULT_OPTS = {
  agentId: "test-agent",
  cwd: "/tmp",
  systemPrompt: "",
  modelFamily: "gpt-5.5",
  effort: "",
  permissionMode: "on-request",
};

// Sessions are closed in afterAll so their stream() generators unblock; temp
// source dirs (image fixtures) are removed there too.
const liveSessions: CodexSession[] = [];
const tempDirs: string[] = [];
afterAll(() => {
  for (const s of liveSessions) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function start(
  fake: FakeCodexTransport = new FakeCodexTransport(),
  overrides: Partial<CodexSessionInitOpts> = {},
): {
  session: CodexSession;
  fake: FakeCodexTransport;
  it: AsyncIterator<NormalizedEvent>;
} {
  const session = new CodexSession({
    ...DEFAULT_OPTS,
    ...overrides,
    client: fake,
  });
  liveSessions.push(session);
  return { session, fake, it: session.stream() };
}

// Advance past bootstrap (consume system_init) and return the live iterator.
async function bootstrapped(
  fake?: FakeCodexTransport,
  overrides?: Partial<CodexSessionInitOpts>,
): Promise<{
  session: CodexSession;
  fake: FakeCodexTransport;
  it: AsyncIterator<NormalizedEvent>;
}> {
  const ctx = start(fake, overrides);
  expectKind(await nextEvent(ctx.it, "system_init"), "system_init");
  return ctx;
}

// Fire an `item/completed` notification carrying a ThreadItem (the most common
// fixture). `threadId` exercises the per-thread filter when set.
function fireItem(
  fake: FakeCodexTransport,
  item: Record<string, unknown>,
  threadId?: string,
): void {
  fake.fireNotification(
    "item/completed",
    threadId !== undefined ? { item, threadId } : { item },
  );
}

// Read the next event with a timeout so a missing event fails fast and legibly
// instead of hanging the suite. Everything the fake fires is synchronous, so
// real events arrive within microtasks; the 2s budget is pure safety margin.
async function nextEvent(
  it: AsyncIterator<NormalizedEvent>,
  label: string,
): Promise<NormalizedEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      2000,
    );
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    if (r.done) throw new Error(`stream ended while waiting for ${label}`);
    return r.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Assert the discriminant and narrow in one step.
function expectKind<K extends NormalizedEvent["kind"]>(
  ev: NormalizedEvent,
  kind: K,
): Extract<NormalizedEvent, { kind: K }> {
  expect(ev.kind).toBe(kind);
  return ev as Extract<NormalizedEvent, { kind: K }>;
}

// ---------------------------------------------------------------------------
// Bootstrap / system_init
// ---------------------------------------------------------------------------
describe("CodexSession bootstrap", () => {
  it("fresh start: initialize + thread/start, emits system_init with thread id", async () => {
    const { fake, it } = start();
    const init = expectKind(await nextEvent(it, "system_init"), "system_init");
    expect(init.sessionId).toBe(FIXTURE_THREAD_ID);
    expect(init.model).toBe("gpt-5.5");
    expect(init.slashCommands).toEqual([]);
    expect(fake.started).toBe(true);
    expect(fake.requests.map((r) => r.method)).toEqual(["thread/start"]);
  });

  it("resume: uses thread/resume and surfaces the resumed thread id", async () => {
    const fake = new FakeCodexTransport();
    fake.threadId = "resumed-thread-9";
    const { it } = start(fake, { resumeThreadId: "resumed-thread-9" });
    const init = expectKind(await nextEvent(it, "system_init"), "system_init");
    expect(init.sessionId).toBe("resumed-thread-9");
    expect(fake.requests.map((r) => r.method)).toEqual(["thread/resume"]);
  });

  it("bootstrap failure defers: system_init with empty id, send() rejects with the captured error", async () => {
    const fake = new FakeCodexTransport();
    fake.bootstrapError = new Error("401 Unauthorized: please log in");
    const { session, it } = start(fake);
    // The agent still looks idle from spawn: system_init lands (empty id), so
    // the orchestrator transitions to idle rather than pre-init.
    const init = expectKind(await nextEvent(it, "system_init"), "system_init");
    expect(init.sessionId).toBe("");
    // The actionable error surfaces on the first send, not at spawn.
    await expectRejection(session.send("hi"), /401 Unauthorized/);
  });
});

// ---------------------------------------------------------------------------
// Assistant text / reasoning
// ---------------------------------------------------------------------------
describe("CodexSession item translation — text & thinking", () => {
  it("agentMessage -> assistant_text; empty text is dropped", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, { type: "agentMessage", text: "" });
    fireItem(fake, { type: "agentMessage", text: "Hello there" });
    // The empty one produced nothing, so the next event is the real message.
    const ev = expectKind(
      await nextEvent(it, "assistant_text"),
      "assistant_text",
    );
    expect(ev.text).toBe("Hello there");
  });

  it("reasoning -> thinking (summary + content joined)", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "reasoning",
      summary: ["short summary"],
      content: ["the body"],
    });
    const ev = expectKind(await nextEvent(it, "thinking"), "thinking");
    expect(ev.text).toBe("short summary\n\nthe body");
  });

  it("plan item -> thinking", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, { type: "plan", text: "1. do the thing" });
    const ev = expectKind(await nextEvent(it, "thinking"), "thinking");
    expect(ev.text).toBe("1. do the thing");
  });
});

// ---------------------------------------------------------------------------
// Tool calls (each emits a tool_call then a tool_result)
// ---------------------------------------------------------------------------
describe("CodexSession item translation — tool calls", () => {
  it("commandExecution -> Bash tool_call + tool_result, exit 0 not an error", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "commandExecution",
      id: "cmd-1",
      command: "ls -la",
      cwd: "/work",
      aggregatedOutput: "total 0\n",
      exitCode: 0,
      durationMs: 7,
    });
    const call = expectKind(await nextEvent(it, "tool_call"), "tool_call");
    expect(call.toolUseId).toBe("cmd-1");
    expect(call.name).toBe("Bash");
    expect(call.input).toEqual({ command: "ls -la", cwd: "/work" });
    const result = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(result.toolUseId).toBe("cmd-1");
    expect(result.content).toBe("total 0\n\n(exit code 0)");
    expect(result.durationMs).toBe(7);
    expect(result.isError).toBe(false);
  });

  it("commandExecution with nonzero exit -> tool_result isError", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "commandExecution",
      id: "cmd-2",
      command: "false",
      cwd: "/work",
      aggregatedOutput: "",
      exitCode: 2,
    });
    expectKind(await nextEvent(it, "tool_call"), "tool_call");
    const result = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(result.content).toBe("\n(exit code 2)");
    expect(result.isError).toBe(true);
  });

  it("fileChange -> Edit tool_call + tool_result; non-applied status is an error", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "fileChange",
      id: "fc-1",
      changes: [{ path: "src/a.ts", kind: { type: "update" } }],
      status: "completed",
    });
    const call = expectKind(await nextEvent(it, "tool_call"), "tool_call");
    expect(call.toolUseId).toBe("fc-1");
    expect(call.name).toBe("Edit");
    const okResult = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(okResult.content).toContain("src/a.ts");
    expect(okResult.content).toContain("status: completed");
    expect(okResult.isError).toBe(false);

    fireItem(fake, {
      type: "fileChange",
      id: "fc-2",
      changes: [{ path: "src/b.ts", kind: { type: "update" } }],
      status: "rejected",
    });
    expectKind(await nextEvent(it, "tool_call"), "tool_call");
    const badResult = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(badResult.isError).toBe(true);
  });

  it("mcpToolCall -> mcp__server__tool tool_call + JSON result", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "memory",
      tool: "search",
      arguments: { query: "x" },
      result: { content: [{ type: "text", text: "3 hits" }] },
      durationMs: 4,
    });
    const call = expectKind(await nextEvent(it, "tool_call"), "tool_call");
    expect(call.name).toBe("mcp__memory__search");
    expect(call.input).toEqual({ query: "x" });
    const result = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(result.content).toBe(
      JSON.stringify({ content: [{ type: "text", text: "3 hits" }] }),
    );
    expect(result.isError).toBe(false);

    fireItem(fake, {
      type: "mcpToolCall",
      id: "mcp-2",
      server: "memory",
      tool: "search",
      error: { message: "boom" },
    });
    expectKind(await nextEvent(it, "tool_call"), "tool_call");
    const errResult = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(errResult.content).toContain("Error:");
    expect(errResult.isError).toBe(true);
  });

  it("webSearch -> WebSearch tool_call + formatted action summary", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, {
      type: "webSearch",
      id: "ws-1",
      query: "isomux",
      action: { type: "search", query: "isomux" },
    });
    const call = expectKind(await nextEvent(it, "tool_call"), "tool_call");
    expect(call.name).toBe("WebSearch");
    expect(call.input).toEqual({ query: "isomux" });
    const result = expectKind(
      await nextEvent(it, "tool_result"),
      "tool_result",
    );
    expect(result.content).toBe("search: isomux");
    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------
describe("CodexSession turn lifecycle", () => {
  it("turn/completed completed -> turn_completed completed", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("turn/completed", { turn: { status: "completed" } });
    const ev = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(ev.status).toBe("completed");
    expect(ev.error).toBeUndefined();
    expect(ev.causedByAuth).toBeUndefined();
  });

  it("turn/completed interrupted -> turn_completed interrupted", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("turn/completed", {
      turn: { status: "interrupted" },
    });
    const ev = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(ev.status).toBe("interrupted");
  });

  it("turn/completed failed -> turn_completed failed with the turn error", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("turn/completed", {
      turn: { status: "failed", error: { message: "model exploded" } },
    });
    const ev = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(ev.status).toBe("failed");
    expect(ev.error).toBe("model exploded");
  });

  it("missing/unknown status defaults to failed", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("turn/completed", { turn: {} });
    const ev = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(ev.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Token usage: cumulative -> delta, and the /context snapshot (last breakdown)
// ---------------------------------------------------------------------------
describe("CodexSession token usage", () => {
  it("emits usage_update deltas against the running cumulative", async () => {
    const { session, fake, it } = await bootstrapped();
    fake.fireNotification("thread/tokenUsage/updated", {
      threadId: FIXTURE_THREAD_ID,
      turnId: "t1",
      tokenUsage: {
        total: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 130,
          inputTokens: 90,
          cachedInputTokens: 15,
          outputTokens: 40,
          reasoningOutputTokens: 5,
        },
        modelContextWindow: 200000,
      },
    });
    const u1 = expectKind(await nextEvent(it, "usage_update"), "usage_update");
    expect(u1.tokenUsage).toEqual({
      inputTokens: 80, // 100 - 20 cached
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 0,
    });

    // /context snapshot uses `last` (current context fullness), not `total`.
    const ctx = await session.getContextUsage();
    expect(ctx).not.toBeNull();
    expect(ctx!.totalTokens).toBe(130); // last.input(90) + last.output(40)
    expect(ctx!.maxTokens).toBe(200000);
    expect(ctx!.categories?.length).toBe(4);

    // Second cumulative -> delta against the first.
    fake.fireNotification("thread/tokenUsage/updated", {
      threadId: FIXTURE_THREAD_ID,
      turnId: "t2",
      tokenUsage: {
        total: {
          totalTokens: 500,
          inputTokens: 300,
          cachedInputTokens: 50,
          outputTokens: 120,
          reasoningOutputTokens: 30,
        },
        last: {
          totalTokens: 250,
          inputTokens: 180,
          cachedInputTokens: 25,
          outputTokens: 70,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 200000,
      },
    });
    const u2 = expectKind(await nextEvent(it, "usage_update"), "usage_update");
    expect(u2.tokenUsage).toEqual({
      inputTokens: 170, // (300-50) - 80
      outputTokens: 70, // 120 - 50
      cacheReadInputTokens: 30, // 50 - 20
      cacheCreationInputTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Compaction / errors / warnings / per-thread filter
// ---------------------------------------------------------------------------
describe("CodexSession misc notifications", () => {
  // The wire type (ContextCompactedNotification) is { threadId, turnId } — there
  // is no `summary` field, so the adapter emits the bare compacted marker (the
  // dead params.summary read was removed, 9fc5d488); summary stays undefined.
  it("thread/compacted -> compacted (no summary on the wire)", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("thread/compacted", {
      threadId: FIXTURE_THREAD_ID,
      turnId: "t1",
    });
    const ev = expectKind(await nextEvent(it, "compacted"), "compacted");
    expect(ev.summary).toBeUndefined();
  });

  it("contextCompaction item -> compacted", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, { type: "contextCompaction" });
    expectKind(await nextEvent(it, "compacted"), "compacted");
  });

  // ErrorNotification carries its text at params.error.message (TurnError), not
  // params.message. The adapter now reads the correct field (both the streaming
  // arm and the one-shot path), so a real error notification surfaces as an
  // `error` event instead of being silently swallowed.
  it("error notification (real wire shape) -> error event from params.error.message", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("error", {
      error: { message: "stream broke" },
      willRetry: false,
      threadId: FIXTURE_THREAD_ID,
      turnId: "t1",
    });
    const ev = expectKind(await nextEvent(it, "error"), "error");
    expect(ev.message).toBe("stream broke");
  });

  it("warning-family notification -> tagged system_text", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("warning", { message: "heads up" });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toBe("[warning] heads up");
  });

  it("model/rerouted -> system_text built from fromModel/toModel/reason (5acf4941)", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("model/rerouted", {
      threadId: FIXTURE_THREAD_ID,
      turnId: "t1",
      fromModel: "gpt-5-codex",
      toModel: "gpt-5",
      reason: "highRiskCyberActivity",
    });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toBe(
      "[model/rerouted] model rerouted from gpt-5-codex to gpt-5 (highRiskCyberActivity)",
    );
  });

  it("deprecationNotice -> system_text from summary (+ details)", async () => {
    const { fake, it } = await bootstrapped();
    fake.fireNotification("deprecationNotice", {
      summary: "tool foo is deprecated",
      details: "use bar instead",
    });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toBe(
      "[deprecationNotice] tool foo is deprecated (use bar instead)",
    );
  });

  it("configWarning -> system_text; an auth-shaped one still surfaces (NOT via the auth funnel)", async () => {
    const { fake, it } = await bootstrapped();
    // The summary carries auth-shaped tokens (openai_api_key + 401). If this
    // were routed through enqueueAuthAwareSystemText, the per-turn auth gate
    // (authSignalsAllowedThisTurn=false outside a turn) would DROP it. A plain
    // enqueue must surface it as a normal advisory.
    fake.fireNotification("configWarning", {
      summary: "openai_api_key in config is malformed (401)",
      details: null,
    });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toBe(
      "[configWarning] openai_api_key in config is malformed (401)",
    );
  });

  it("notification for a foreign thread id is ignored", async () => {
    const { fake, it } = await bootstrapped();
    // A foreign-thread message would corrupt this session's stream if the
    // per-thread filter didn't drop it.
    fireItem(
      fake,
      { type: "agentMessage", text: "from another thread" },
      "other-thread",
    );
    fireItem(fake, { type: "agentMessage", text: "ours" });
    const ev = expectKind(
      await nextEvent(it, "assistant_text"),
      "assistant_text",
    );
    expect(ev.text).toBe("ours");
  });
});

// ---------------------------------------------------------------------------
// Approvals (server-initiated requests). Response enums differ between the
// legacy exec/patch methods and the v2 item/* methods, so cover one of each.
// ---------------------------------------------------------------------------
describe("CodexSession approvals", () => {
  it("execCommandApproval -> approval_request, approve/deny use the legacy enum", async () => {
    const { session, fake, it } = await bootstrapped();
    const allowResp = fake.fireServerRequest({
      id: "appr-1",
      method: "execCommandApproval",
      params: { command: ["echo", "hi"], cwd: "/work", reason: "demo" },
    });
    const ev = expectKind(
      await nextEvent(it, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("appr-1");
    expect(ev.toolName).toBe("Bash");
    expect(ev.input).toEqual({
      command: "echo hi",
      cwd: "/work",
      reason: "demo",
    });
    expect(ev.title).toContain("echo hi");
    expect(ev.description).toBe("demo");
    await session.approve("appr-1", { kind: "allow_once" });
    expect(await allowResp).toEqual({ decision: "approved" });

    const denyResp = fake.fireServerRequest({
      id: "appr-1b",
      method: "execCommandApproval",
      params: { command: ["rm", "-rf", "/"], reason: "nope" },
    });
    expectKind(await nextEvent(it, "approval_request"), "approval_request");
    await session.approve("appr-1b", { kind: "deny", reason: "too risky" });
    expect(await denyResp).toEqual({ decision: "denied" });
  });

  it("item/fileChange/requestApproval -> approval_request, approve/deny use the v2 enum", async () => {
    const { session, fake, it } = await bootstrapped();
    const allowResp = fake.fireServerRequest({
      id: "appr-2",
      method: "item/fileChange/requestApproval",
      params: { itemId: "fc-1", reason: "apply patch" },
    });
    const ev = expectKind(
      await nextEvent(it, "approval_request"),
      "approval_request",
    );
    expect(ev.toolName).toBe("Edit");
    expect(ev.input).toEqual({ itemId: "fc-1", reason: "apply patch" });
    await session.approve("appr-2", { kind: "allow_once" });
    expect(await allowResp).toEqual({ decision: "accept" });

    const denyResp = fake.fireServerRequest({
      id: "appr-2b",
      method: "item/fileChange/requestApproval",
      params: { itemId: "fc-2" },
    });
    expectKind(await nextEvent(it, "approval_request"), "approval_request");
    await session.approve("appr-2b", { kind: "deny" });
    expect(await denyResp).toEqual({ decision: "decline" });
  });
});

// ---------------------------------------------------------------------------
// Auto-declined server requests. v1 can't service these, so each emits a
// breadcrumb and responds with the protocol-correct shape (a wrong response
// shape would break codex's wire). elicitation is the one that returns a value
// rather than a JSON-RPC error, so its response shape is worth freezing.
// ---------------------------------------------------------------------------
describe("CodexSession auto-declined server requests", () => {
  it("mcpServer/elicitation/request -> system_text breadcrumb + decline response", async () => {
    const { fake, it } = await bootstrapped();
    const resp = fake.fireServerRequest({
      id: "elic-1",
      method: "mcpServer/elicitation/request",
      params: {},
    });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toContain("elicitation");
    expect(await resp).toEqual({ action: "decline" });
  });
});

// ---------------------------------------------------------------------------
// Auth coalescing — the representative case (per design review). After
// turn/started, an auth-shaped stderr burst produces exactly ONE system_text,
// triggers exactly ONE best-effort turn/interrupt, and the resulting
// turn_completed is failed + causedByAuth with a non-auth-shaped summary so the
// orchestrator's auth-detect regex does not re-fire.
// ---------------------------------------------------------------------------
describe("CodexSession auth coalescing", () => {
  it("collapses an auth-error stderr burst into one signal + one interrupt + a failed/causedByAuth turn", async () => {
    const { session, fake, it } = await bootstrapped();
    await session.send("do the thing");
    fake.fireNotification("turn/started", { turn: { id: "turn-1" } });

    // First auth-shaped stderr: one system_text + one self-interrupt.
    fake.fireStderr("ERROR: 401 Unauthorized while connecting to OpenAI");
    const sysText = expectKind(
      await nextEvent(it, "auth system_text"),
      "system_text",
    );
    expect(sysText.text).toContain("401");
    expect(fake.interruptCount()).toBe(1);

    // Second auth-shaped stderr in the SAME turn: coalesced, no new system_text.
    fake.fireStderr("ERROR: 401 Unauthorized (retry 2)");

    // The interrupt lands as turn/completed interrupted; the adapter remaps it
    // to failed + causedByAuth. The next stream event being turn_completed (not
    // a second system_text) proves the retry was coalesced.
    fake.fireNotification("turn/completed", {
      turn: { status: "interrupted", error: null },
    });
    const done = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(done.status).toBe("failed");
    expect(done.causedByAuth).toBe(true);
    expect(done.error).toContain("after an auth error");
    // The rewritten summary is NOT auth-shaped, so it won't re-trigger detection.
    expect(done.error).not.toMatch(/401|unauthorized/i);
    expect(fake.interruptCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Subprocess death mid-turn synthesizes a failed turn_completed (invariant: the
// orchestrator's pendingTurn must always unblock).
// ---------------------------------------------------------------------------
describe("CodexSession subprocess exit", () => {
  it("exit mid-turn -> synthesized failed turn_completed", async () => {
    const { session, fake, it } = await bootstrapped();
    await session.send("hi");
    fake.fireNotification("turn/started", { turn: { id: "turn-1" } });
    fake.fireExit(1, null);
    const ev = expectKind(
      await nextEvent(it, "turn_completed"),
      "turn_completed",
    );
    expect(ev.status).toBe("failed");
    expect(ev.error).toContain("exited");
  });
});

// ---------------------------------------------------------------------------
// file_view (imageView). Uses a temp source file (cleaned in afterAll); the
// attachment copy lands under the test's temp STATE_ROOT (preload-managed).
// ---------------------------------------------------------------------------
describe("CodexSession image view", () => {
  it("imageView with a readable file -> file_view attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "isomux-codex-img-"));
    tempDirs.push(dir);
    const imgPath = join(dir, "shot.png");
    // Minimal PNG signature bytes — enough for statSync/readFileSync to succeed.
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

    const { fake, it } = await bootstrapped();
    fireItem(fake, { type: "imageView", path: imgPath });
    const ev = expectKind(await nextEvent(it, "file_view"), "file_view");
    expect(ev.title).toBe("shot.png");
    expect(ev.attachments).toHaveLength(1);
    expect(ev.attachments[0].originalName).toBe("shot.png");
    expect(ev.attachments[0].mediaType).toContain("image/");
  });

  it("imageView with an unreadable path -> system_text fallback", async () => {
    const { fake, it } = await bootstrapped();
    fireItem(fake, { type: "imageView", path: "/no/such/file/nope.png" });
    const ev = expectKind(await nextEvent(it, "system_text"), "system_text");
    expect(ev.text).toContain("could not display");
  });
});

// ---------------------------------------------------------------------------
// buildCodexUserInput — inbound attachments follow the shared path-notice
// convention (server/attachment-prompt.ts): no localImage, no inlined
// contents, one text item joining one line per resolved attachment. Fixture
// files live under the preload-managed temp STATE_ROOT.
// ---------------------------------------------------------------------------
describe("buildCodexUserInput", () => {
  const AGENT_ID = `test-codex-input-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const FILES_DIR = join(STATE_ROOT, "logs", AGENT_ID, "files");

  function fixture(filename: string, contents: Buffer | string) {
    mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(join(FILES_DIR, filename), contents);
  }

  function att(filename: string, mediaType: string, size = 1) {
    return { filename, originalName: filename, mediaType, size };
  }

  afterAll(() => {
    try {
      rmSync(join(STATE_ROOT, "logs", AGENT_ID), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  it("text only -> single text input", () => {
    expect(buildCodexUserInput("hi", undefined, AGENT_ID)).toEqual([
      { type: "text", text: "hi", text_elements: [] },
    ]);
  });

  it("image attachment -> path-notice text item, NOT localImage", () => {
    fixture("shot.png", Buffer.from([0x89, 0x50]));
    const inputs = buildCodexUserInput(
      "look",
      [att("shot.png", "image/png", 2)],
      AGENT_ID,
    );
    expect(inputs).toHaveLength(2);
    expect(inputs.every((i) => i.type === "text")).toBe(true);
    const notice = inputs[1] as { type: "text"; text: string };
    expect(notice.text).toContain('[Attachment: "shot.png" (image/png,');
    expect(notice.text).toContain(join(FILES_DIR, "shot.png"));
  });

  it("text-file attachment is not inlined; contents stay out", () => {
    fixture("notes.md", "SECRET CONTENTS\n");
    const inputs = buildCodexUserInput(
      "",
      [att("notes.md", "text/markdown", 16)],
      AGENT_ID,
    );
    expect(inputs).toHaveLength(1);
    const notice = inputs[0] as { type: "text"; text: string };
    expect(notice.text).toContain('"notes.md"');
    expect(notice.text).not.toContain("SECRET CONTENTS");
  });

  it("mixed present/missing attachments -> one line each in order, no placeholders", () => {
    fixture("a.pdf", Buffer.from("%PDF"));
    fixture("b.bin", Buffer.from([0]));
    const inputs = buildCodexUserInput(
      "",
      [
        att("a.pdf", "application/pdf"),
        att("missing.txt", "text/plain"),
        att("b.bin", "application/octet-stream"),
      ],
      AGENT_ID,
    );
    expect(inputs).toHaveLength(1);
    const lines = (inputs[0] as { text: string }).text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"a.pdf"');
    expect(lines[1]).toContain('"b.bin"');
  });

  it("empty text and no resolvable attachments -> single empty text input", () => {
    const inputs = buildCodexUserInput(
      "",
      [att("gone.png", "image/png")],
      AGENT_ID,
    );
    expect(inputs).toEqual([{ type: "text", text: "", text_elements: [] }]);
  });
});
