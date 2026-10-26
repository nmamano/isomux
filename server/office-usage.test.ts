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

  it("reads an answer whose weekly window is null as no limit (a team plan)", () => {
    // The shape of a team-plan answer (office sign-in, 2026-10-26): only the
    // 5-hour window and per-model weekly rows, which do not count.
    const team = {
      subscription_type: "team",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 70, resets_at: "2026-10-02T14:00:00Z" },
        seven_day: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: [
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 0,
            resets_at: "2026-10-02T15:00:00Z",
            is_active: false,
            scope: { model: { display_name: "Model", id: null } },
          },
        ],
        model_scoped: [
          {
            display_name: "Model",
            utilization: 0,
            resets_at: "2026-10-02T15:00:00Z",
          },
        ],
      },
    };
    expect(parseClaudeWeekly(team)).toEqual({ kind: "no_limit" });
  });

  it("fails on anything it cannot read as a weekly window", () => {
    for (const raw of [
      null,
      { rate_limits: {} },
      // No seven_day key at all is a shape we do not know, not "no limit".
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 1, resets_at: "2026-10-02T14:00:00Z" },
        },
      },
      { rate_limits_available: true, rate_limits: null },
      { rate_limits_available: true },
      { rate_limits: { seven_day: null } },
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
    // A window of unknown length beside it does not hide the weekly one.
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([
          { usedPercent: 20, windowDurationMins: 10080, resetsAt },
          { usedPercent: 90, windowDurationMins: null, resetsAt },
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

  it("reads a plan whose windows are all other than a week as no limit", () => {
    // The free plan (office sign-in, 2026-10-26): one 30-day window.
    const free = { type: "chatgpt", email: null, planType: "free" } as const;
    expect(
      parseCodexWeekly(
        free,
        codexLimits([
          { usedPercent: 10, windowDurationMins: 43200, resetsAt: 1 },
        ]),
      ),
    ).toEqual({ kind: "no_limit" });
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([
          { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 },
          { usedPercent: 5, windowDurationMins: 43200, resetsAt: 1 },
        ]),
      ),
    ).toEqual({ kind: "no_limit" });
  });

  it("fails when a window could be the weekly one or no window is reported", () => {
    // A window of unknown length could be the weekly one.
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([
          { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 },
          { usedPercent: 5, windowDurationMins: null, resetsAt: 1 },
        ]),
      ),
    ).toEqual({ kind: "failed" });
    expect(
      parseCodexWeekly(
        chatgpt,
        codexLimits([{ usedPercent: 5, windowDurationMins: NaN, resetsAt: 1 }]),
      ),
    ).toEqual({ kind: "failed" });
    // A snapshot with no window says nothing about the plan.
    expect(parseCodexWeekly(chatgpt, codexLimits([]))).toEqual({
      kind: "failed",
    });
  });

  it("fails for a weekly window with a missing reset", () => {
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
  it("launches the CLI with vendor telemetry, error reporting and MCP servers off", () => {
    const env = { DISABLE_TELEMETRY: "", KEEP_ME: "yes" };
    let received: unknown;
    const probe = claudeOfficeProbe(env, (params) => {
      received = params;
      return {};
    });
    // Task c52bd005: a probe sends no prompt, so a claude.ai connector it
    // starts is network and OAuth work for nothing.
    expect(received).toMatchObject({
      options: {
        strictMcpConfig: true,
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

// Lets a probe that is not held land, so the reader stores its answer.
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The read's answer, or WAITED when it still waits for a probe after every
// pending microtask has run.
const WAITED = "waited for the probe" as const;
function quick<T>(read: Promise<T>): Promise<T | typeof WAITED> {
  return Promise.race([read, settled().then(() => WAITED)]);
}

describe("createOfficeUsageReader", () => {
  it("reuses a reading for FRESH_MS, then answers with it at once while one shared probe reads a new one", async () => {
    const h = harness([weekly(10), weekly(20)]);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    h.advance(FRESH_MS);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    expect(h.reads).toBe(1);
    h.advance(1);
    h.hold(true);
    expect(await quick(h.reader.read("claude"))).toEqual(
      expect.objectContaining({
        usedPercent: 10,
      }),
    );
    expect(await quick(h.reader.read("claude"))).toEqual(
      expect.objectContaining({
        usedPercent: 10,
      }),
    );
    expect(h.reads).toBe(2);
    h.release();
    await settled();
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 20 });
    expect(h.reads).toBe(2);
    // The warm process served both reads.
    expect(h.created).toBe(1);
  });

  it("answers with a reading under FALLBACK_MS old without waiting, and waits for an older one", async () => {
    const h = harness([weekly(10), weekly(20), weekly(30)]);
    await h.reader.read("claude");
    h.advance(FALLBACK_MS - 1);
    h.hold(true);
    expect(await quick(h.reader.read("claude"))).toEqual(
      expect.objectContaining({
        usedPercent: 10,
      }),
    );
    h.release();
    await settled();
    h.advance(FALLBACK_MS + 1);
    const late = h.reader.read("claude");
    expect(await quick(late)).toBe(WAITED);
    h.release();
    expect(await late).toMatchObject({ usedPercent: 30 });
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

  it("keeps a team-plan answer as no limit, like a good reading", async () => {
    let usageCalls = 0;
    const reader = createOfficeUsageReader({
      officeTarget: () => ({ dir: "/office/claude", env: {} }),
      now: () => NOW,
      setTimer: () => () => {},
      createProbe: (_provider, env) =>
        claudeOfficeProbe(env, () => ({
          async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
            usageCalls++;
            return claudeRaw(null);
          },
          close() {},
        })),
    });
    const noLimit = { kind: "no_limit", observedAtMs: NOW } as const;
    expect(await reader.read("claude")).toEqual(noLimit);
    expect(await reader.read("claude")).toEqual(noLimit);
    expect(usageCalls).toBe(1);
    reader.close();
  });

  it("does not probe again within FRESH_MS after a failed or signed-out read", async () => {
    const answers = [{ kind: "failed" }, { kind: "signed_out" }] as const;
    for (const answer of answers) {
      const h = harness([answer, weekly(40)]);
      expect(await h.reader.read("claude")).toEqual(answer);
      h.advance(FRESH_MS - 1);
      expect(await h.reader.read("claude")).toEqual(answer);
      expect(h.reads).toBe(1);
      // Older: the same answer at once, and a probe for the next read.
      h.advance(2);
      expect(await quick(h.reader.read("claude"))).toEqual(answer);
      await settled();
      expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 40 });
      expect(h.reads).toBe(2);
    }
  });

  it("answers a failed probe with the last good reading, as observed, for as long as it keeps the failed answer", async () => {
    const h = harness([weekly(10), new Error("rpc died"), weekly(40)]);
    await h.reader.read("claude");
    h.advance(FRESH_MS + 1);
    const lastGood = { kind: "weekly", usedPercent: 10, observedAtMs: NOW };
    expect(await h.reader.read("claude")).toMatchObject(lastGood);
    await settled();
    // The failed process is dropped.
    expect(h.closed).toBe(1);
    expect(await h.reader.read("claude")).toMatchObject(lastGood);
    expect(h.reads).toBe(2);
    h.advance(FRESH_MS + 1);
    expect(await quick(h.reader.read("claude"))).toEqual(
      expect.objectContaining(lastGood),
    );
    await settled();
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 40 });
    // The next probe ran in a new process.
    expect(h.created).toBe(2);
  });

  it("falls back only while the last good reading is under an hour old", async () => {
    const h = harness([weekly(10), { kind: "failed" }]);
    await h.reader.read("claude");
    h.advance(FALLBACK_MS - 1);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 10 });
    await settled();
    h.advance(1);
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
    expect(h.reads).toBe(2);
  });

  it("does not fall back on a weekly reading whose reset has passed", async () => {
    const h = harness([
      { kind: "weekly", usedPercent: 70, resetsAtMs: NOW + 30 * 60_000 },
      { kind: "failed" },
    ]);
    await h.reader.read("claude");
    h.advance(30 * 60_000 - 1);
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 70 });
    await settled();
    h.advance(1);
    expect(await h.reader.read("claude")).toEqual({ kind: "failed" });
    expect(h.reads).toBe(2);
  });

  it("falls back on a no-limit reading", async () => {
    const h = harness([{ kind: "no_limit" }, { kind: "failed" }]);
    await h.reader.read("claude");
    h.advance(FRESH_MS + 1);
    await h.reader.read("claude");
    await settled();
    expect(await h.reader.read("claude")).toEqual({
      kind: "no_limit",
      observedAtMs: NOW,
    });
    expect(h.reads).toBe(2);
  });

  it("forgets the old and the last good reading on invalidation, on a directory move, and from a probe an invalidation overtook", async () => {
    // Invalidation: no old answer to give at once, and none to fall back on.
    const a = harness([weekly(10), { kind: "failed" }]);
    await a.reader.read("claude");
    a.advance(FRESH_MS + 1);
    a.reader.invalidate("claude");
    a.hold(true);
    const afterInvalidate = a.reader.read("claude");
    expect(await quick(afterInvalidate)).toBe(WAITED);
    a.release();
    expect(await afterInvalidate).toEqual({ kind: "failed" });

    const b = harness([weekly(20), { kind: "failed" }]);
    await b.reader.read("claude");
    b.setDir("/office/other");
    expect(await b.reader.read("claude")).toEqual({ kind: "failed" });

    // weekly(30) lands after an invalidation: it is not kept, and the
    // caller's next probe fails with nothing to fall back on.
    const c = harness([weekly(30), { kind: "failed" }]);
    c.hold(true);
    const overtaken = c.reader.read("claude");
    await Promise.resolve();
    c.reader.invalidate("claude");
    c.hold(false);
    c.release();
    expect(await overtaken).toEqual({ kind: "failed" });
  });

  it("rejects a reset in the past or more than a week and an hour away", async () => {
    for (const { resetsAtMs, kind } of [
      { resetsAtMs: NOW - 1, kind: "failed" },
      { resetsAtMs: NOW + WEEK_MS + 2 * 3600_000, kind: "failed" },
      { resetsAtMs: NOW + WEEK_MS, kind: "weekly" },
    ] as const) {
      const h = harness([{ kind: "weekly", usedPercent: 5, resetsAtMs }]);
      expect({
        resetsAtMs,
        kind: (await h.reader.read("claude")).kind,
      }).toEqual({ resetsAtMs, kind });
    }
  });

  it("waits for a probe once a kept reading's reset has passed", async () => {
    for (const resetIn of [1000, 5 * 60_000]) {
      const h = harness([
        { kind: "weekly", usedPercent: 70, resetsAtMs: NOW + resetIn },
        weekly(1),
      ]);
      await h.reader.read("claude");
      h.advance(resetIn);
      h.hold(true);
      const pending = h.reader.read("claude");
      expect({ resetIn, answer: await quick(pending) }).toEqual({
        resetIn,
        answer: WAITED,
      });
      h.release();
      expect(await pending).toMatchObject({ usedPercent: 1 });
      expect(h.reads).toBe(2);
    }
  });

  it("treats a changed office env in the same directory as another account", async () => {
    const h = harness([{ kind: "no_limit" }, weekly(70), weekly(71)]);
    expect(await h.reader.read("claude")).toMatchObject({ kind: "no_limit" });
    h.setEnv({ ANTHROPIC_API_KEY: "" });
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 70 });
    expect(h.created).toBe(2);
    // And an env change during a read sends the caller round again.
    h.advance(FALLBACK_MS + 1);
    h.hold(true);
    const pending = h.reader.read("claude");
    await Promise.resolve();
    h.setEnv({ CLAUDE_CODE_USE_BEDROCK: "1" });
    h.hold(false);
    h.release();
    expect(await pending).toMatchObject({ kind: "failed" });
  });

  it("reads as failed when the reader process cannot be built or the office target cannot be resolved", async () => {
    const noProcess = createOfficeUsageReader({
      officeTarget: () => ({ dir: "/office", env: {} }),
      createProbe: () => {
        throw new Error("spawn failed");
      },
      setTimer: () => () => {},
    });
    expect(await noProcess.read("claude")).toEqual({ kind: "failed" });
    const noTarget = createOfficeUsageReader({
      officeTarget: () => {
        throw new Error("office env does not parse");
      },
    });
    expect(await noTarget.read("codex")).toEqual({ kind: "failed" });
  });
});
