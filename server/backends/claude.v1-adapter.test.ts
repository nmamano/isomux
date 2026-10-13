import { describe, expect, it, spyOn } from "bun:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  makePushableInput,
  normalizeClaudeSubscriptionUsage,
  sessionOptsToV1,
  registerMcpServers,
  wrapV1Query,
  type PushableInput,
  type V1QueryLike,
} from "./claude";

// ---------------------------------------------------------------------------
// makePushableInput - pushable async iterable for query()'s prompt arg
// ---------------------------------------------------------------------------

describe("makePushableInput", () => {
  async function collect<T>(p: PushableInput<T>, n: number): Promise<T[]> {
    const out: T[] = [];
    const it = p.iterable[Symbol.asyncIterator]();
    for (let i = 0; i < n; i++) {
      const r = await it.next();
      if (r.done) break;
      out.push(r.value);
    }
    return out;
  }

  it("push-then-iterate drains pushed items in order", async () => {
    const p = makePushableInput<number>();
    p.push(1);
    p.push(2);
    p.push(3);
    expect(await collect(p, 3)).toEqual([1, 2, 3]);
  });

  it("iterate-then-push unblocks the parked waiter", async () => {
    const p = makePushableInput<string>();
    const it = p.iterable[Symbol.asyncIterator]();
    const next = it.next();
    p.push("hello");
    const result = await next;
    expect(result).toEqual({ value: "hello", done: false });
  });

  it("end() resolves a parked waiter with done:true", async () => {
    const p = makePushableInput<string>();
    const it = p.iterable[Symbol.asyncIterator]();
    const next = it.next();
    p.end();
    const result = await next;
    expect(result.done).toBe(true);
  });

  it("end() then subsequent next() returns done:true immediately", async () => {
    const p = makePushableInput<string>();
    p.end();
    const it = p.iterable[Symbol.asyncIterator]();
    const result = await it.next();
    expect(result.done).toBe(true);
  });

  it("push after end() is a no-op", async () => {
    const p = makePushableInput<string>();
    p.end();
    p.push("ignored");
    const it = p.iterable[Symbol.asyncIterator]();
    const result = await it.next();
    expect(result.done).toBe(true);
  });

  it("end() is idempotent", async () => {
    const p = makePushableInput<string>();
    p.end();
    p.end();
    const it = p.iterable[Symbol.asyncIterator]();
    const result = await it.next();
    expect(result.done).toBe(true);
  });

  it("queued items are drained before end is observed", async () => {
    const p = makePushableInput<number>();
    p.push(1);
    p.push(2);
    p.end();
    expect(await collect(p, 3)).toEqual([1, 2]);
    const it = p.iterable[Symbol.asyncIterator]();
    // start a fresh iterator: queue is shared, so it sees done immediately
    expect((await it.next()).done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrapV1Query - adapter shape over a Query-like object
// ---------------------------------------------------------------------------

// Minimal Query stand-in: yields a controlled sequence + records interrupt
// and getContextUsage calls.
class FakeQuery implements V1QueryLike {
  interruptCount = 0;
  contextUsageResult: unknown = null;
  contextUsageError: Error | null = null;
  usageResult: unknown = null;
  usageError: Error | null = null;
  usageCalls = 0;
  usageDelayMs = 0;
  holdUsage = false;
  private usageParked = false;
  private releaseHeldUsage: (() => void) | null = null;

  private queue: SDKMessage[] = [];
  private waiter: (() => void) | null = null;
  private finished = false;

  push(msg: unknown): void {
    this.queue.push(msg as SDKMessage);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  finish(): void {
    this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  interrupt(): Promise<void> {
    this.interruptCount++;
    return Promise.resolve();
  }

  getContextUsage(): Promise<unknown> {
    if (this.contextUsageError) {
      return Promise.reject(this.contextUsageError);
    }
    return Promise.resolve(this.contextUsageResult);
  }

  usageIsParked(): boolean {
    return this.usageParked;
  }

  releaseUsage(): void {
    this.releaseHeldUsage?.();
    this.releaseHeldUsage = null;
  }

  // Declared as an own property so a test can delete it, standing in for an
  // SDK release that renames or drops the experimental method.
  mcpServerStatus?: () => Promise<unknown>;
  setMcpServers?: V1QueryLike["setMcpServers"];

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> =
    async () => {
      this.usageCalls++;
      if (this.usageDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.usageDelayMs));
      }
      if (this.holdUsage) {
        this.usageParked = true;
        await new Promise<void>((resolve) => {
          this.releaseHeldUsage = resolve;
        });
        this.usageParked = false;
      }
      if (this.usageError) throw this.usageError;
      return this.usageResult;
    };
}

describe("wrapV1Query", () => {
  it("getMcpServers() reads the session's MCP status, origin under source", async () => {
    const q = new FakeQuery();
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    // No status method: an SDK without it reads as unavailable.
    expect(await conv.getMcpServers?.()).toBeNull();
    q.mcpServerStatus = async () => [
      { name: "claude.ai Gmail", status: "connected", scope: "claudeai" },
      { name: "local", status: "failed" },
    ];
    expect(await conv.getMcpServers?.()).toEqual([
      { name: "claude.ai Gmail", status: "connected", source: "claudeai" },
      { name: "local", status: "failed" },
    ]);
    q.mcpServerStatus = async () => {
      throw new Error("control request failed");
    };
    expect(await conv.getMcpServers?.()).toBeNull();
  });

  it("messages() yields the underlying query", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    q.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    q.finish();
    const out: SDKMessage[] = [];
    for await (const msg of conv.messages()) out.push(msg);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("assistant");
  });

  it("send(string) wraps into an SDKUserMessage and pushes into input", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    await conv.send("hello");
    const it = input.iterable[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(false);
    expect(r.value).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
    });
  });

  it("send(SDKUserMessage) passes the object through unchanged", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "raw" }] },
      parent_tool_use_id: null,
    };
    await conv.send(msg);
    const it = input.iterable[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.value).toBe(msg);
  });

  it("close() ends the input iterable and calls interrupt", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    conv.close();
    // input iterable returns done
    const it = input.iterable[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(true);
    // interrupt was called
    expect(q.interruptCount).toBe(1);
  });

  it("close() is idempotent", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    conv.close();
    conv.close();
    expect(q.interruptCount).toBe(1);
  });

  it("close() aborts the AbortController so the SDK subprocess is torn down", () => {
    // input.end() + interrupt() unwind a healthy turn, but a mid-turn child can
    // hang in its read loop and leak ~165MB. abortController is the SDK's
    // documented cancel lever; close() must fire it.
    const q = new FakeQuery();
    const ac = new AbortController();
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>(), ac);
    expect(ac.signal.aborted).toBe(false);
    conv.close();
    expect(ac.signal.aborted).toBe(true);
  });

  it("close() without an AbortController still works (optional arg)", () => {
    const q = new FakeQuery();
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(() => conv.close()).not.toThrow();
    expect(q.interruptCount).toBe(1);
  });

  it("send after close is a no-op (does not push)", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input);
    conv.close();
    await conv.send("late");
    // Iterator should have ended after close; no late items leak through.
    const it = input.iterable[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(true);
  });

  it("close swallows interrupt() rejections", async () => {
    const q = new FakeQuery();
    const input = makePushableInput<SDKUserMessage>();
    // Override interrupt to reject - close() must still complete.
    q.interrupt = () => Promise.reject(new Error("ignored"));
    const conv = wrapV1Query(q, input);
    expect(() => conv.close()).not.toThrow();
  });

  it("close swallows a synchronous throw from interrupt()", () => {
    // SDK's Promise<void> contract doesn't preclude a sync throw before the
    // promise is constructed; SdkConversation.close()'s "never throws"
    // contract is stronger than that, so wrap the call defensively.
    const q = new FakeQuery();
    q.interrupt = () => {
      throw new Error("sync boom");
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(() => conv.close()).not.toThrow();
  });

  it("getContextUsage delegates to query's method", async () => {
    const q = new FakeQuery();
    q.contextUsageResult = {
      model: "x",
      totalTokens: 1,
      maxTokens: 10,
      percentage: 0.1,
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getContextUsage()).toEqual({
      model: "x",
      totalTokens: 1,
      maxTokens: 10,
      percentage: 0.1,
    });
  });

  it("getContextUsage passes the SDK's window through untouched", async () => {
    // isomux used to override maxTokens here from a hand-maintained table
    // (task c6085ddf), which went wrong once the SDK knew the models: it
    // rewrote sonnet-4.6's correct 200k to 1M and under-reported fullness.
    // The bundled CLI reports the window the session actually gets, so the
    // adapter must not second-guess it (task 89925a7c).
    const q = new FakeQuery();
    q.contextUsageResult = {
      model: "claude-sonnet-4-6",
      totalTokens: 190_000,
      maxTokens: 200_000,
      percentage: 95,
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    const ctx = (await conv.getContextUsage())!;
    expect(ctx.maxTokens).toBe(200_000);
    expect(ctx.percentage).toBe(95);
  });

  it("getContextUsage returns null when the query method throws", async () => {
    const q = new FakeQuery();
    q.contextUsageError = new Error("not ready");
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getContextUsage()).toBeNull();
  });

  // The subscription pill rides an SDK method whose own name says it may
  // change or vanish without notice, so the adapter's job is to make every
  // failure mode look like "no reading" (which hides the pill).
  it("getSubscriptionUsage reports 'unavailable' when the SDK has no such method", async () => {
    // The pill can never learn a number from this SDK, so clearing beats
    // freezing whatever it last showed.
    const q = new FakeQuery();
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = undefined;
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getSubscriptionUsage()).toEqual({ kind: "unavailable" });
  });

  it("getSubscriptionUsage reports 'unknown' when the SDK method rejects", async () => {
    // A transient failure must not blank a valid reading.
    const q = new FakeQuery();
    q.usageError = new Error("boom");
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getSubscriptionUsage()).toEqual({ kind: "unknown" });
  });

  it("getSubscriptionUsage serves a cached answer inside the throttle window", async () => {
    // The orchestrator asks on every cumulative-usage event; only the first
    // one within a minute may reach the CLI.
    const q = new FakeQuery();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 10, resets_at: null } },
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    const first = await conv.getSubscriptionUsage();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 99, resets_at: null } },
    };
    const second = await conv.getSubscriptionUsage();
    expect(q.usageCalls).toBe(1);
    expect(second).toEqual({
      kind: "usage",
      observedAtMs:
        first.kind === "usage" ? first.observedAtMs : expect.any(Number),
      usage: {
        plan: "max",
        windows: [{ label: "Weekly", usedPercent: 10, resetsAtMs: null }],
      },
    });
  });

  it("getSubscriptionUsage bypasses the throttle for a forced refresh", async () => {
    const q = new FakeQuery();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 10, resets_at: null } },
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    await conv.getSubscriptionUsage();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 99, resets_at: null } },
    };
    const forced = await conv.getSubscriptionUsage({ forceRefresh: true });
    expect(q.usageCalls).toBe(2);
    expect(forced).toMatchObject({
      kind: "usage",
      usage: { windows: [{ usedPercent: 99 }] },
    });
  });

  it("dates a forced call that joins an in-flight provider read at receipt", async () => {
    const q = new FakeQuery();
    q.holdUsage = true;
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 10, resets_at: null } },
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    const periodic = conv.getSubscriptionUsage();
    for (let i = 0; i < 200 && !q.usageIsParked(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(q.usageIsParked()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const forcedStartedAtMs = Date.now();
    const forced = conv.getSubscriptionUsage({ forceRefresh: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    q.releaseUsage();
    await periodic;
    const forcedResult = await forced;
    expect(q.usageCalls).toBe(1);
    expect(forcedResult.kind).toBe("usage");
    if (forcedResult.kind === "usage") {
      expect(forcedResult.observedAtMs).toBeGreaterThan(forcedStartedAtMs);
      expect(forcedResult.refreshed).toBe(true);
    }
  });

  it("getSubscriptionUsage single-flights concurrent callers onto one RPC", async () => {
    const q = new FakeQuery();
    q.usageDelayMs = 20;
    q.usageResult = {
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 5, resets_at: null } },
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    const [a, b] = await Promise.all([
      conv.getSubscriptionUsage(),
      conv.getSubscriptionUsage(),
    ]);
    expect(q.usageCalls).toBe(1);
    expect(a).toEqual(b);
  });

  it("getSubscriptionUsage does not cache a failure - the next event retries", async () => {
    const q = new FakeQuery();
    q.usageError = new Error("transient");
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getSubscriptionUsage()).toEqual({ kind: "unknown" });
    q.usageError = null;
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 8, resets_at: null } },
    };
    expect(await conv.getSubscriptionUsage()).toEqual({
      kind: "usage",
      observedAtMs: expect.any(Number),
      usage: {
        plan: "max",
        windows: [{ label: "Weekly", usedPercent: 8, resetsAtMs: null }],
      },
    });
    expect(q.usageCalls).toBe(2);
  });

  it("getSubscriptionUsage normalizes a live-looking /usage response", async () => {
    const q = new FakeQuery();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12, resets_at: "2026-07-31T20:00:00Z" },
        seven_day: { utilization: 34.5, resets_at: "2026-08-03T09:00:00Z" },
      },
    };
    const conv = wrapV1Query(q, makePushableInput<SDKUserMessage>());
    expect(await conv.getSubscriptionUsage()).toEqual({
      kind: "usage",
      observedAtMs: expect.any(Number),
      usage: {
        plan: "max",
        windows: [
          {
            label: "Weekly",
            usedPercent: 34.5,
            resetsAtMs: Date.parse("2026-08-03T09:00:00Z"),
          },
          {
            label: "5-hour",
            usedPercent: 12,
            resetsAtMs: Date.parse("2026-07-31T20:00:00Z"),
          },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeClaudeSubscriptionUsage - defensive shaping of an unstable API
// ---------------------------------------------------------------------------

describe("normalizeClaudeSubscriptionUsage", () => {
  function usageOf(raw: unknown) {
    const r = normalizeClaudeSubscriptionUsage(raw);
    if (r.kind !== "usage") throw new Error(`expected usage, got ${r.kind}`);
    return r.usage;
  }

  it("is AUTHORITATIVELY unavailable when plan limits do not apply", () => {
    // API key / Bedrock / Vertex. The answer arrived and says there is no
    // allowance, so the pill should clear, not keep a stale number.
    expect(
      normalizeClaudeSubscriptionUsage({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toEqual({ kind: "unavailable" });
    // Subscriber whose response carried no usable number: same call.
    expect(
      normalizeClaudeSubscriptionUsage({
        rate_limits_available: true,
        rate_limits: {},
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      normalizeClaudeSubscriptionUsage({
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: null, resets_at: null } },
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("is 'unknown' for a response it cannot read at all", () => {
    // Nothing was learned - whatever the pill shows stays.
    expect(normalizeClaudeSubscriptionUsage(null)).toEqual({ kind: "unknown" });
    expect(normalizeClaudeSubscriptionUsage("nope")).toEqual({
      kind: "unknown",
    });
    expect(normalizeClaudeSubscriptionUsage({})).toEqual({ kind: "unknown" });
  });

  it("orders windows weekly-first and keeps the raw float", () => {
    const out = usageOf({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 80, resets_at: null },
        seven_day: { utilization: 9.75, resets_at: null },
        seven_day_opus: { utilization: 51, resets_at: null },
      },
    });
    expect(out.plan).toBe("pro");
    expect(out.windows.map((w) => w.label)).toEqual([
      "Weekly",
      "5-hour",
      "Weekly (Opus)",
    ]);
    expect(out.windows[0].usedPercent).toBe(9.75);
  });

  it("includes the server's per-model weekly windows, which also gate a session", () => {
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 20, resets_at: null },
        model_scoped: [
          { display_name: "Fable", utilization: 88, resets_at: null },
          { display_name: "", utilization: 5, resets_at: null },
          { utilization: 5, resets_at: null },
        ],
      },
    });
    expect(out.windows.map((w) => w.label)).toEqual([
      "Weekly",
      "Weekly (Fable)",
    ]);
  });

  it("falls back to a valid weekly_scoped limits row when model_scoped is null or empty", () => {
    for (const modelScoped of [null, []]) {
      const out = usageOf({
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 16, resets_at: null },
          five_hour: { utilization: 8, resets_at: null },
          model_scoped: modelScoped,
          limits: [
            {
              kind: "session",
              percent: 8,
              resets_at: null,
              scope: null,
            },
            {
              kind: "weekly_all",
              percent: 16,
              resets_at: null,
              scope: null,
            },
            {
              kind: "weekly_scoped",
              percent: 64,
              resets_at: "2026-09-19T19:00:00Z",
              scope: { model: { display_name: "Fable" } },
            },
            {
              kind: "weekly_all",
              percent: 99,
              resets_at: null,
              scope: { model: { display_name: "Wrong kind" } },
            },
            null,
            {
              kind: "weekly_scoped",
              percent: NaN,
              scope: { model: { display_name: "Invalid percent" } },
            },
            { kind: "weekly_scoped", percent: 50, scope: null },
            {
              kind: "weekly_scoped",
              percent: 50,
              scope: { model: null, surface: "other" },
            },
            {
              kind: "weekly_scoped",
              percent: 50,
              scope: { model: { display_name: "" } },
            },
          ],
        },
      });
      expect(out.windows).toEqual([
        { label: "Weekly", usedPercent: 16, resetsAtMs: null },
        { label: "5-hour", usedPercent: 8, resetsAtMs: null },
        {
          label: "Weekly (Fable)",
          usedPercent: 64,
          resetsAtMs: Date.parse("2026-09-19T19:00:00Z"),
        },
      ]);
    }
  });

  it("prefers model_scoped over a duplicate model in limits", () => {
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: {
        model_scoped: [
          { display_name: "Fable", utilization: 43, resets_at: null },
        ],
        limits: [
          {
            kind: "weekly_scoped",
            percent: 64,
            resets_at: "2026-09-19T19:00:00Z",
            scope: { model: { display_name: "Fable" } },
          },
          {
            kind: "weekly_scoped",
            percent: 12,
            resets_at: null,
            scope: { model: { display_name: "Sonnet" } },
          },
        ],
      },
    });
    expect(out.windows).toEqual([
      { label: "Weekly (Fable)", usedPercent: 43, resetsAtMs: null },
      { label: "Weekly (Sonnet)", usedPercent: 12, resetsAtMs: null },
    ]);
  });

  it("keeps the first of duplicate model rows in limits", () => {
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: {
        model_scoped: null,
        limits: [
          {
            kind: "weekly_scoped",
            percent: 64,
            resets_at: null,
            scope: { model: { display_name: "Fable" } },
          },
          {
            kind: "weekly_scoped",
            percent: 12,
            resets_at: null,
            scope: { model: { display_name: "Fable" } },
          },
        ],
      },
    });
    expect(out.windows).toEqual([
      { label: "Weekly (Fable)", usedPercent: 64, resetsAtMs: null },
    ]);
  });

  it("keeps the model_scoped Fable window and its pin-stable wire label", () => {
    const out = usageOf({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 17, resets_at: null },
        seven_day: { utilization: 29, resets_at: null },
        seven_day_opus: null,
        seven_day_sonnet: null,
        model_scoped: [
          { display_name: "Fable", utilization: 43, resets_at: null },
        ],
      },
    });
    // These labels are wire identity, not only copy: the pill stores a pin's
    // label in localStorage and uses it to resolve that pin after reordering.
    // A label edit silently drops an existing pin back to Auto.
    expect(out.windows).toEqual([
      { label: "Weekly", usedPercent: 29, resetsAtMs: null },
      { label: "5-hour", usedPercent: 17, resetsAtMs: null },
      { label: "Weekly (Fable)", usedPercent: 43, resetsAtMs: null },
    ]);
  });

  it("ignores seven_day_oauth_apps, which meters a different surface", () => {
    // The SDK's live gating signal (SDKRateLimitInfo.rateLimitType) never
    // names it, so it can't explain anything an agent runs into here.
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 20, resets_at: null },
        seven_day_oauth_apps: { utilization: 99, resets_at: null },
      },
    });
    expect(out.windows.map((w) => w.label)).toEqual(["Weekly"]);
  });

  it("clamps out-of-range utilization and drops unparseable reset times", () => {
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 140, resets_at: "junk" },
        five_hour: { utilization: -3, resets_at: 12345 },
      },
    });
    expect(out.windows).toEqual([
      { label: "Weekly", usedPercent: 100, resetsAtMs: null },
      { label: "5-hour", usedPercent: 0, resetsAtMs: null },
    ]);
  });

  it("keeps whatever windows are reported when seven_day is absent", () => {
    const out = usageOf({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 40, resets_at: null } },
    });
    expect(out.plan).toBeNull();
    expect(out.windows).toEqual([
      { label: "5-hour", usedPercent: 40, resetsAtMs: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// sessionOptsToV1 - verbatim passthrough, add resume when set
// ---------------------------------------------------------------------------

describe("sessionOptsToV1", () => {
  const base = {
    model: "claude-opus-4-8",
    pathToClaudeCodeExecutable: "/bin/echo",
    cwd: "/tmp",
    permissionMode: "default" as const,
  };

  it("passes typed systemPrompt/effort through untouched - the prompt must ride the typed option (stdin), never extraArgs/argv (task e6a0387a)", () => {
    const v1 = sessionOptsToV1({
      ...base,
      systemPrompt: { type: "preset", preset: "claude_code", append: "sys" },
      effort: "high",
    });
    expect(v1.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "sys",
    });
    expect(v1.effort).toBe("high");
    // Regression guard: nothing may reintroduce the argv path for the prompt.
    expect(v1).not.toHaveProperty("extraArgs");
    expect(v1).not.toHaveProperty("executableArgs");
  });

  it("adds resume when resumeSessionId is provided", () => {
    const v1 = sessionOptsToV1(base, "session-uuid-1");
    expect(v1.resume).toBe("session-uuid-1");
  });

  it("omits resume when resumeSessionId is undefined", () => {
    const v1 = sessionOptsToV1(base);
    expect(v1).not.toHaveProperty("resume");
  });

  it("preserves all other fields unchanged", () => {
    const v1 = sessionOptsToV1({
      ...base,
      env: { FOO: "bar" },
      hooks: {},
      disallowedTools: ["AskUserQuestion"],
      settings: { autoMemoryEnabled: false },
    });
    expect(v1.settings).toEqual({ autoMemoryEnabled: false });
    expect(v1.model).toBe("claude-opus-4-8");
    expect(v1.pathToClaudeCodeExecutable).toBe("/bin/echo");
    expect(v1.cwd).toBe("/tmp");
    expect(v1.permissionMode).toBe("default");
    expect(v1.env).toEqual({ FOO: "bar" });
    expect(v1.disallowedTools).toEqual(["AskUserQuestion"]);
  });
});

describe("registerMcpServers", () => {
  const mcp = {
    agentId: "agent-mcp",
    servers: {
      "isomux-docs": {
        type: "http" as const,
        url: "https://docs.example.com/secret-path/mcp",
        headers: { Authorization: "Bearer fake-mcp-value-0000" },
      },
    },
  };

  function captureWarnings() {
    const lines: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("holds every message until setMcpServers settles, in the order sent", async () => {
    const q = new FakeQuery();
    let settle!: (value: unknown) => void;
    const calls: unknown[] = [];
    q.setMcpServers = (servers) => {
      calls.push(servers);
      return new Promise((resolve) => (settle = resolve));
    };
    const input = makePushableInput<SDKUserMessage>();
    const conv = wrapV1Query(q, input, undefined, registerMcpServers(q, mcp));
    expect(calls).toEqual([mcp.servers]);
    const sent = [conv.send("first"), conv.send("second")];
    const it = input.iterable[Symbol.asyncIterator]();
    let pushed = false;
    const next = it.next().then((r) => {
      pushed = true;
      return r;
    });
    await Bun.sleep(5);
    expect(pushed).toBe(false);
    settle({ added: ["isomux-docs"], removed: [], errors: {} });
    await Promise.all(sent);
    expect(((await next).value as SDKUserMessage).message.content).toBe(
      "first",
    );
    expect(((await it.next()).value as SDKUserMessage).message.content).toBe(
      "second",
    );
  });

  it("logs failed servers by name, never the SDK's error text", async () => {
    const q = new FakeQuery();
    q.setMcpServers = async () => ({
      added: [],
      removed: [],
      errors: {
        "isomux-docs": "connect to https://docs.example.com/secret-path failed",
      },
    });
    const warn = captureWarnings();
    try {
      await registerMcpServers(q, mcp);
      q.setMcpServers = async () => {
        throw new Error("https://docs.example.com/secret-path refused");
      };
      await registerMcpServers(q, mcp);
    } finally {
      warn.restore();
    }
    expect(warn.lines).toHaveLength(2);
    expect(warn.lines[0]).toContain("isomux-docs");
    expect(warn.lines.join("\n")).not.toContain("secret-path");
    expect(warn.lines.join("\n")).not.toContain("fake-mcp-value");
  });

  it("stops waiting after its time limit, so a message is never held for good", async () => {
    const q = new FakeQuery();
    q.setMcpServers = () => new Promise(() => {});
    const warn = captureWarnings();
    try {
      const ready = registerMcpServers(q, mcp, 20);
      const input = makePushableInput<SDKUserMessage>();
      const conv = wrapV1Query(q, input, undefined, ready);
      await conv.send("hello");
      const r = await input.iterable[Symbol.asyncIterator]().next();
      expect((r.value as SDKUserMessage).message.content).toBe("hello");
    } finally {
      warn.restore();
    }
    expect(warn.lines.join("\n")).toContain("did not answer in time");
  });

  it("logs the status of the servers it set once the session answers, names and statuses only", async () => {
    const q = new FakeQuery();
    q.setMcpServers = async () => ({
      added: ["isomux-docs"],
      removed: [],
      errors: {},
    });
    q.mcpServerStatus = async () => [
      {
        name: "isomux-docs",
        status: "connected",
        scope: "dynamic",
        config: { url: "https://docs.example.com/secret-path/mcp" },
      },
      { name: "user-notes", status: "failed", scope: "user" },
    ];
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      await registerMcpServers(q, mcp);
      // The status line is not waited for: it lands a moment later.
      await Bun.sleep(5);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(["[mcp] agent-mcp status: isomux-docs=connected"]);
  });

  it("does nothing with no servers", () => {
    const q = new FakeQuery();
    let called = false;
    q.setMcpServers = async () => {
      called = true;
    };
    expect(registerMcpServers(q, undefined)).toBe(null);
    expect(registerMcpServers(q, { agentId: "a", servers: {} })).toBe(null);
    expect(called).toBe(false);
  });
});
