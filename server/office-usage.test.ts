import { describe, expect, it } from "bun:test";
import {
  claudeOfficeProbe,
  createOfficeUsageReader,
  FALLBACK_MS,
  FRESH_MS,
  parseClaudeWeekly,
  parseCodexWeekly,
  WEEK_MS,
  type OfficeUsageProbe,
  type ProbeResult,
} from "./office-usage.ts";
import type { GetAccountRateLimitsResponse } from "./backends/codex/_generated/v2/GetAccountRateLimitsResponse.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function claudeRaw(weekly: unknown, available: unknown = true): unknown {
  return {
    rate_limits_available: available,
    rate_limits: {
      five_hour: { utilization: 99, resets_at: "2026-10-02T14:00:00Z" },
      seven_day: weekly,
    },
  };
}

describe("parseClaudeWeekly", () => {
  it("reads the seven_day window, not the 5-hour one", () => {
    expect(
      parseClaudeWeekly(
        claudeRaw({ utilization: 12, resets_at: "2026-10-03T23:59:59Z" }),
      ),
    ).toEqual({
      kind: "weekly",
      usedPercent: 12,
      resetsAtMs: Date.parse("2026-10-03T23:59:59Z"),
    });
  });

  it("treats the provider's own no-limit answer as the only exemption", () => {
    expect(parseClaudeWeekly(claudeRaw(undefined, false))).toEqual({
      kind: "no_limit",
    });
  });

  it("fails on anything it cannot read as a weekly window", () => {
    for (const raw of [
      null,
      { rate_limits: {} },
      claudeRaw(undefined),
      claudeRaw({ utilization: null, resets_at: "2026-10-03T00:00:00Z" }),
      claudeRaw({ utilization: 120, resets_at: "2026-10-03T00:00:00Z" }),
      claudeRaw({ utilization: -1, resets_at: "2026-10-03T00:00:00Z" }),
      claudeRaw({ utilization: 10 }),
      claudeRaw({ utilization: 10, resets_at: "soon" }),
    ]) {
      expect(parseClaudeWeekly(raw)).toEqual({ kind: "failed" });
    }
  });
});

function codexLimits(
  windows: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  }[],
): GetAccountRateLimitsResponse {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: windows[0] ?? null,
      secondary: windows[1] ?? null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "pro",
      rateLimitReachedType: null,
      normalModelSlug: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
    ordinaryUsageAllowed: null,
  };
}

const chatgpt = { type: "chatgpt", email: null, planType: "pro" } as const;

describe("parseCodexWeekly", () => {
  it("finds the 10080-minute window in either slot", () => {
    const resetsAt = Math.floor(NOW / 1000) + 3600;
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([{ usedPercent: 11, windowDurationMins: 10080, resetsAt }]),
      ),
    ).toEqual({ kind: "weekly", usedPercent: 11, resetsAtMs: resetsAt * 1000 });
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([
          { usedPercent: 90, windowDurationMins: 300, resetsAt },
          { usedPercent: 20, windowDurationMins: 10080, resetsAt },
        ]),
      ),
    ).toEqual({ kind: "weekly", usedPercent: 20, resetsAtMs: resetsAt * 1000 });
  });

  it("exempts only API-key and Bedrock billing", () => {
    expect(parseCodexWeekly({ type: "apiKey" }, null)).toEqual({
      kind: "no_limit",
    });
    expect(
      parseCodexWeekly(
        { type: "amazonBedrock", usesCodexManagedCredentials: false },
        null,
      ),
    ).toEqual({ kind: "no_limit" });
    expect(parseCodexWeekly(null, null)).toEqual({ kind: "signed_out" });
  });

  it("fails for a plan with no weekly window or a missing reset", () => {
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([{ usedPercent: 5, windowDurationMins: 300, resetsAt: 1 }]),
      ),
    ).toEqual({ kind: "failed" });
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([
          { usedPercent: 5, windowDurationMins: 10080, resetsAt: null },
        ]),
      ),
    ).toEqual({ kind: "failed" });
  });
});

// A reader over scripted probe answers and a hand-driven clock.
function harness(answers: (ProbeResult | Error)[]) {
  let now = NOW;
  let dir = "/office/claude";
  let env: Record<string, string> = {};
  let reads = 0;
  let created = 0;
  let closed = 0;
  const pending: (() => void)[] = [];
  let hold = false;
  const reader = createOfficeUsageReader({
    officeTarget: () => ({ dir, env }),
    now: () => now,
    setTimer: () => () => {},
    createProbe: (): OfficeUsageProbe => {
      created++;
      return {
        async read() {
          reads++;
          if (hold) await new Promise<void>((r) => pending.push(r));
          const next = answers.shift() ?? { kind: "failed" };
          if (next instanceof Error) throw next;
          return next;
        },
        close() {
          closed++;
        },
      };
    },
  });
  return {
    reader,
    advance: (ms: number) => (now += ms),
    setDir: (next: string) => (dir = next),
    setEnv: (next: Record<string, string>) => (env = next),
    hold: (on: boolean) => (hold = on),
    release: () => pending.splice(0).forEach((r) => r()),
    get reads() {
      return reads;
    },
    get created() {
      return created;
    },
    get closed() {
      return closed;
    },
  };
}

const weekly = (usedPercent: number): ProbeResult => ({
  kind: "weekly",
  usedPercent,
  resetsAtMs: NOW + 2 * DAY_MS,
});

describe("claudeOfficeProbe", () => {
  it("launches the CLI with vendor telemetry and error reporting off", () => {
    const env = { DISABLE_TELEMETRY: "", KEEP_ME: "yes" };
    let received: unknown;
    const probe = claudeOfficeProbe(env, (params) => {
      received = params;
      return {};
    });
    expect(received).toMatchObject({
      options: {
        settings: {
          autoMemoryEnabled: false,
          env: { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
        },
        env,
      },
    });
    probe.close();
  });
});

describe("createOfficeUsageReader", () => {
  it("reuses a reading for FRESH_MS and probes again after", async () => {
    const h = harness([weekly(10), weekly(20)]);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    h.advance(FRESH_MS);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    expect(h.reads).toBe(1);
    h.advance(1);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 20 });
    expect(h.reads).toBe(2);
    // The warm process served both reads.
    expect(h.created).toBe(1);
  });

  it("shares one probe between concurrent callers", async () => {
    const h = harness([weekly(30)]);
    h.hold(true);
    const a = h.reader.read("claude");
    const b = h.reader.read("claude");
    h.release();
    expect(await a).toEqual(await b);
    expect(h.reads).toBe(1);
  });

  it("answers a failed probe with the last good reading, as observed, and probes again next time", async () => {
    const h = harness([
      weekly(10),
      new Error("rpc died"),
      { kind: "failed" },
      weekly(40),
    ]);
    await h.reader.read("claude");
    h.advance(FRESH_MS + 1);
    const lastGood = { kind: "weekly", usedPercent: 10, observedAtMs: NOW };
    expect(await h.reader.read("claude")).toMatchObject(lastGood);
    // The failed process is dropped and the next read probes a new one.
    expect(h.closed).toBe(1);
    // The fallback is not cached and keeps its own age.
    expect(await h.reader.read("claude")).toMatchObject(lastGood);
    expect(h.reads).toBe(3);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 40 });
    expect(h.created).toBe(3);
  });

  it("falls back only while the last good reading is under an hour old", async () => {
    const h = harness([weekly(10), { kind: "failed" }, { kind: "failed" }]);
    await h.reader.read("claude");
    h.advance(FALLBACK_MS - 1);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    h.advance(1);
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
  });

  it("does not fall back on a weekly reading whose reset has passed", async () => {
    const h = harness([
      { kind: "weekly", usedPercent: 70, resetsAtMs: NOW + 30 * 60_000 },
      { kind: "failed" },
      { kind: "failed" },
    ]);
    await h.reader.read("claude");
    h.advance(30 * 60_000 - 1);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 70 });
    h.advance(1);
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
  });

  it("falls back on a no-limit reading", async () => {
    const h = harness([{ kind: "no_limit" }, { kind: "failed" }]);
    await h.reader.read("claude");
    h.advance(FRESH_MS + 1);
    expect(await h.reader.read("claude")).toEqual({
      kind: "no_limit",
      observedAtMs: NOW,
    });
  });

  it("forgets the last good reading on invalidation, on a directory move, and from a probe an invalidation overtook", async () => {
    const h = harness([
      weekly(10),
      { kind: "failed" },
      weekly(20),
      { kind: "failed" },
      weekly(30),
      { kind: "failed" },
    ]);
    await h.reader.read("claude");
    h.reader.invalidate("claude");
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });

    await h.reader.read("claude");
    h.setDir("/office/other");
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });

    // weekly(30) lands after an invalidation: it is not kept, and the
    // caller's next probe fails with nothing to fall back on.
    h.hold(true);
    const pending = h.reader.read("claude");
    await Promise.resolve();
    h.reader.invalidate("claude");
    h.hold(false);
    h.release();
    expect(await pending).toEqual({ kind: "failed" });
  });

  it("rejects a reset in the past or more than a week and an hour away", async () => {
    const h = harness([
      { kind: "weekly", usedPercent: 5, resetsAtMs: NOW - 1 },
      {
        kind: "weekly",
        usedPercent: 5,
        resetsAtMs: NOW + WEEK_MS + 2 * 3600_000,
      },
      { kind: "weekly", usedPercent: 5, resetsAtMs: NOW + WEEK_MS },
    ]);
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
    expect(await h.reader.read("claude")).toMatchObject({ kind: "weekly" });
  });

  it("probes again once a cached reading's reset has passed", async () => {
    const h = harness([
      { kind: "weekly", usedPercent: 70, resetsAtMs: NOW + 1000 },
      weekly(1),
    ]);
    await h.reader.read("claude");
    h.advance(1000);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 1 });
    expect(h.reads).toBe(2);
  });

  it("drops the reading when the office directory moves or is invalidated", async () => {
    const h = harness([weekly(10), weekly(20), weekly(30)]);
    await h.reader.read("claude");
    h.setDir("/office/other");
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 20 });
    h.reader.invalidate("claude");
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 30 });
    expect(h.reads).toBe(3);
  });

  it("never hands a caller an answer an invalidation overtook", async () => {
    const h = harness([weekly(5), weekly(80)]);
    h.hold(true);
    const pending = h.reader.read("claude");
    await Promise.resolve();
    h.reader.invalidate("claude");
    h.hold(false);
    h.release();
    expect(await pending).toMatchObject({ usedPercent: 80 });
    expect(h.reads).toBe(2);
  });

  it("treats a changed office env in the same directory as another account", async () => {
    const h = harness([{ kind: "no_limit" }, weekly(70), weekly(71)]);
    expect(await h.reader.read("claude")).toMatchObject({ kind: "no_limit" });
    h.setEnv({ ANTHROPIC_API_KEY: "" });
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 70 });
    expect(h.created).toBe(2);
    // And an env change during a read sends the caller round again.
    h.advance(FRESH_MS + 1);
    h.hold(true);
    const pending = h.reader.read("claude");
    await Promise.resolve();
    h.setEnv({ CLAUDE_CODE_USE_BEDROCK: "1" });
    h.hold(false);
    h.release();
    expect(await pending).toMatchObject({ kind: "failed" });
  });

  it("reads as failed when the reader process cannot be built", async () => {
    const reader = createOfficeUsageReader({
      officeTarget: () => ({ dir: "/office", env: {} }),
      createProbe: () => {
        throw new Error("spawn failed");
      },
      setTimer: () => () => {},
    });
    expect(await reader.read("claude")).toEqual({ kind: "failed" });
  });

  it("fails closed when the office target cannot be resolved", async () => {
    const reader = createOfficeUsageReader({
      officeTarget: () => {
        throw new Error("office env does not parse");
      },
    });
    expect(await reader.read("codex")).toEqual({ kind: "failed" });
  });
});
