import { describe, expect, it } from "bun:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  makePushableInput,
  normalizeClaudeSubscriptionUsage,
  sessionOptsToV1,
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

  // Declared as an own property so a test can delete it, standing in for an
  // SDK release that renames or drops the experimental method.
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> =
    async () => {
      this.usageCalls++;
      if (this.usageDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.usageDelayMs));
      }
      if (this.usageError) throw this.usageError;
      return this.usageResult;
    };
}

describe("wrapV1Query", () => {
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
    await conv.getSubscriptionUsage();
    q.usageResult = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 99, resets_at: null } },
    };
    const second = await conv.getSubscriptionUsage();
    expect(q.usageCalls).toBe(1);
    expect(second).toEqual({
      kind: "usage",
      usage: {
        plan: "max",
        windows: [{ label: "Weekly", usedPercent: 10, resetsAtMs: null }],
      },
    });
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
