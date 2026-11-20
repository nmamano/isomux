import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  officeAgentHost,
  localAgentHost,
  setOfficeAgentHost,
  type AgentHost,
} from "./agent-host.ts";
import { prepareCodexSafetyHookArtifact } from "./backends/codex/safety-hook-install.ts";
import {
  fakeCodexGroupEnv,
  groupAlive,
  killGroup,
  waitFor,
  waitForFakeGroup,
  writeFakeCodexGroup,
} from "./test-support/fake-codex-group.ts";
import {
  claudeAccountProbe,
  claudeAccountProbeResult,
  claudeOfficeProbe,
  codexAccountProbeResult,
  codexOfficeProbe,
  createAccountUsageReader,
  createOfficeUsageReader,
  FALLBACK_MS,
  FRESH_MS,
  parseClaudeWeekly,
  parseCodexWeekly,
  REFRESH_FLOOR_MS,
  WEEK_MS,
  type AccountProbeResult,
  type AccountReading,
  type AccountUsageProbe,
  type AccountUsageTarget,
  type OfficeUsageProbe,
  type ProbeResult,
} from "./office-usage.ts";
import { normalizeClaudeSubscriptionUsage } from "./backends/claude.ts";
import {
  CODEX_PREFERRED_LIMIT_ID,
  normalizeCodexSubscriptionUsage,
} from "./backends/codex/adapter.ts";
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

const chatgpt = {
  type: "chatgpt",
  email: null,
  planType: "pro",
  workspaceName: null,
} as const;

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

  it("exempts only API-key, Bedrock and Vertex billing", () => {
    expect(parseCodexWeekly({ type: "apiKey" }, null)).toEqual({
      kind: "no_limit",
    });
    expect(
      parseCodexWeekly(
        { type: "amazonBedrock", usesCodexManagedCredentials: false },
        null,
      ),
    ).toEqual({ kind: "no_limit" });
    expect(parseCodexWeekly({ type: "gcp" }, null)).toEqual({
      kind: "no_limit",
    });
    expect(parseCodexWeekly(null, null)).toEqual({ kind: "signed_out" });
  });

  it("reads an account type it does not know by its rate limits", () => {
    // A later Codex can add a plan with a weekly limit: it must not read as
    // no limit.
    const unknown = { type: "chatgptTeams" } as unknown as Parameters<
      typeof parseCodexWeekly
    >[0];
    const resetsAt = Math.floor(NOW / 1000) + 3600;
    expect(
      parseCodexWeekly(
        unknown,
        codexLimits([{ usedPercent: 30, windowDurationMins: 10080, resetsAt }]),
      ),
    ).toEqual({ kind: "weekly", usedPercent: 30, resetsAtMs: resetsAt * 1000 });
    expect(parseCodexWeekly(unknown, null)).toEqual({ kind: "failed" });
  });

  it("reads a plan whose windows are all other than a week as no limit", () => {
    // The free plan (office sign-in, 2026-10-26): one 30-day window.
    const free = {
      type: "chatgpt",
      email: null,
      planType: "free",
      workspaceName: null,
    } as const;
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

// Task faf036ad: by default the SDK usage call also scans every local
// transcript of the last 7 days to fill its `behaviors` section, which
// nothing reads. On a sign-in with 3 GB of transcripts the call took 15-24 s
// and ran into the reader's timeout: the row read "Usage could not be read."
describe("claudeAccountProbe", () => {
  it("asks for the plan limits only, without the transcript scan, on every read of a warm probe", async () => {
    const usageArgs: unknown[][] = [];
    const probe = claudeAccountProbe({}, () => ({
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
        ...args: unknown[]
      ) {
        usageArgs.push(args);
        return claudeRaw({
          utilization: 31,
          resets_at: "2026-10-05T00:00:00Z",
        });
      },
      async accountInfo() {
        return { email: "owner@example.test" };
      },
      close() {},
    }));
    const first = await probe.read();
    const second = await probe.read();
    probe.close();
    expect([first.reading.kind, second.reading.kind]).toEqual([
      "usage",
      "usage",
    ]);
    expect(usageArgs).toEqual([
      [{ skipBehaviors: true }],
      [{ skipBehaviors: true }],
    ]);
  });
});

// Task 14e12aa8: the reader ends a Codex probe with close(), also while the
// probe is still starting (a probe timeout). No app-server group may outlive
// that close. The host runs a fake app-server group in place of the bundled
// launcher; it never answers, so a read waits until close() ends it.
describe("codexOfficeProbe", () => {
  async function closeProbe(when: "before the spawn" | "after the spawn") {
    await prepareCodexSafetyHookArtifact();
    const dir = mkdtempSync(join(tmpdir(), "codex-office-probe-"));
    const pidFile = join(dir, "pids");
    const fake = writeFakeCodexGroup(dir);
    const argvs: string[][] = [];
    const leaders: number[] = [];
    const host: AgentHost = {
      ...localAgentHost,
      spawnChild: (argv, options) => {
        argvs.push(argv);
        const child = localAgentHost.spawnChild([fake], options);
        if (child.pid !== undefined) leaders.push(child.pid);
        return child;
      },
    };
    const previous = officeAgentHost();
    setOfficeAgentHost(host);
    try {
      const probe = codexOfficeProbe({
        ...process.env,
        CODEX_HOME: join(dir, "codex-home"),
        ...fakeCodexGroupEnv(pidFile, join(dir, "writes")),
      });
      const read = probe.read().then(
        () => "answered",
        () => "rejected",
      );
      // The group has its second process (the writer) before close().
      if (when === "after the spawn")
        await waitForFakeGroup(pidFile, join(dir, "writes"));
      const spawnedAtClose = argvs.length;
      probe.close();
      const outcome = await Promise.race([
        read,
        Bun.sleep(3000).then(() => "still waiting"),
      ]);
      const allDead = await waitFor(
        () => leaders.every((pgid) => !groupAlive(pgid)),
        3000,
      );
      return {
        spawnedAtClose,
        launchedAppServer: argvs.every((argv) => argv.includes("app-server")),
        outcome,
        spawned: argvs.length,
        allDead,
      };
    } finally {
      for (const pgid of leaders) killGroup(pgid);
      setOfficeAgentHost(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("starts no app-server when close() comes before the spawn", async () => {
    expect(await closeProbe("before the spawn")).toEqual({
      spawnedAtClose: 0,
      launchedAppServer: true,
      outcome: "rejected",
      spawned: 0,
      allDead: true,
    });
  }, 15_000);

  it("ends the app-server's whole process group when close() comes after the spawn", async () => {
    expect(await closeProbe("after the spawn")).toEqual({
      spawnedAtClose: 1,
      launchedAppServer: true,
      outcome: "rejected",
      spawned: 1,
      allDead: true,
    });
  }, 15_000);
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

  // Task 14e12aa8: a probe is a process (a Codex app-server pair is ~120 MB),
  // so each one the reader starts must be closed, once, whatever path takes
  // it out of the slot. The warm one stays open until then.
  it("closes each probe once, when a timeout, a failed read, an invalidation, an office change, the idle timer or close() drops it", async () => {
    let now = NOW;
    let dir = "/office/codex";
    const probes: {
      closes: number;
      answers: ((result: ProbeResult) => void)[];
    }[] = [];
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const reader = createOfficeUsageReader({
      officeTarget: () => ({ dir, env: {} }),
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return () => (timer.live = false);
      },
      createProbe: () => {
        const probe = {
          closes: 0,
          answers: [] as ((result: ProbeResult) => void)[],
        };
        probes.push(probe);
        return {
          read: () =>
            new Promise<ProbeResult>((resolve) => probe.answers.push(resolve)),
          close: () => probe.closes++,
        };
      },
    });
    // The probe timeout is the shorter of the two timers the reader arms,
    // the idle close the longer.
    const fire = (which: "timeout" | "idle") => {
      const live = timers.filter((t) => t.live).sort((a, b) => a.ms - b.ms);
      const timer = which === "timeout" ? live[0] : live[live.length - 1];
      if (!timer) throw new Error(`no live timer for ${which}`);
      timer.live = false;
      timer.fn();
    };
    // Answer the newest probe's pending read, and let the reader take it.
    const answer = async (result: ProbeResult) => {
      const pending = probes[probes.length - 1]?.answers.shift();
      if (!pending) throw new Error("no probe read is pending");
      pending(result);
      await settled();
    };
    const state = (step: string) => ({
      step,
      created: probes.length,
      closes: probes.map((p) => p.closes),
    });
    const steps: ReturnType<typeof state>[] = [];

    // A good read leaves the probe warm; the idle timer closes it.
    let read = reader.read("codex");
    await answer(weekly(10));
    await read;
    steps.push(state("good read"));
    fire("idle");
    steps.push(state("idle timer"));

    // A read that times out: the caller gets the kept reading at once, the
    // probe is closed, and its late answer does not bring it back.
    now += FRESH_MS + 1;
    await reader.read("codex");
    fire("timeout");
    await settled();
    await answer(weekly(11));
    steps.push(state("timeout"));

    // An invalidation during a read.
    now += FRESH_MS + 1;
    await reader.read("codex");
    reader.invalidate("codex");
    await answer(weekly(12));
    steps.push(state("invalidated mid-read"));

    // A warm probe, then the office account moves.
    read = reader.read("codex");
    await answer(weekly(13));
    await read;
    dir = "/office/other";
    read = reader.read("codex");
    await answer(weekly(14));
    await read;
    steps.push(state("office change"));

    // A failed read, then a warm probe that close() ends.
    now += FRESH_MS + 1;
    await reader.read("codex");
    await answer({ kind: "failed" });
    steps.push(state("failed read"));
    now += FRESH_MS + 1;
    read = reader.read("codex");
    await answer(weekly(15));
    await read;
    reader.close();
    steps.push(state("close()"));

    expect(steps).toEqual([
      { step: "good read", created: 1, closes: [0] },
      { step: "idle timer", created: 1, closes: [1] },
      { step: "timeout", created: 2, closes: [1, 1] },
      { step: "invalidated mid-read", created: 3, closes: [1, 1, 1] },
      { step: "office change", created: 5, closes: [1, 1, 1, 1, 0] },
      { step: "failed read", created: 5, closes: [1, 1, 1, 1, 1] },
      { step: "close()", created: 6, closes: [1, 1, 1, 1, 1, 1] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 3e70b6d4: one reader for every provider account. The office slot of a
// provider is the cap's slot (one warm process); a member slot is one-shot.

describe("claudeAccountProbeResult", () => {
  const raw = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 64, resets_at: "2026-10-02T14:00:00Z" },
      seven_day: { utilization: 31, resets_at: "2026-10-05T00:00:00Z" },
      model_scoped: [
        {
          display_name: "Fable",
          utilization: 77,
          resets_at: "2026-10-05T00:00:00Z",
        },
      ],
    },
  };

  it("keeps every window of the answer, the cap's weekly projection of the same answer, and the account email", () => {
    const result = claudeAccountProbeResult(raw, {
      email: "owner@example.test",
      tokenSource: "claude.ai",
      apiProvider: "firstParty",
    });
    expect(result.weekly).toEqual(parseClaudeWeekly(raw));
    const normalized = normalizeClaudeSubscriptionUsage(raw);
    if (normalized.kind !== "usage") throw new Error("fixture is not usage");
    expect(result.reading).toEqual({ kind: "usage", ...normalized.usage });
    // The per-model window comes with its model family, the 5-hour one too.
    if (result.reading.kind !== "usage") throw new Error("not usage");
    expect(
      result.reading.windows.map((w) => [w.usedPercent, w.modelFamily]),
    ).toEqual([
      [31, undefined],
      [64, undefined],
      [77, "fable"],
    ]);
    expect(result.identity).toBe("owner@example.test");
  });

  it("reads the provider's no-limit answer as no limit, an unreadable answer as failed, and no email as no identity", () => {
    const noLimit = claudeAccountProbeResult(
      { rate_limits_available: false },
      { email: "api@example.test" },
    );
    expect([noLimit.weekly.kind, noLimit.reading.kind]).toEqual([
      "no_limit",
      "no_limit",
    ]);
    const unreadable = claudeAccountProbeResult(null, {});
    expect([
      unreadable.weekly.kind,
      unreadable.reading.kind,
      unreadable.identity,
    ]).toEqual(["failed", "failed", null]);
    expect(claudeAccountProbeResult(raw, null).identity).toBeNull();
  });
});

describe("codexAccountProbeResult", () => {
  const resetsAt = Math.floor(NOW / 1000) + 3600;
  const account = {
    type: "chatgpt",
    email: "coder@example.test",
    planType: "pro",
    workspaceName: null,
  } as const;

  it("keeps both windows, the cap's projection and the account email", () => {
    const limits = codexLimits([
      { usedPercent: 40, windowDurationMins: 300, resetsAt },
      { usedPercent: 12, windowDurationMins: 10080, resetsAt },
    ]);
    const result = codexAccountProbeResult(account, limits);
    expect(result.weekly).toEqual(parseCodexWeekly(account, limits));
    const normalized = normalizeCodexSubscriptionUsage(limits.rateLimits);
    if (normalized.kind !== "usage") throw new Error("fixture is not usage");
    expect(result.reading).toEqual({ kind: "usage", ...normalized.usage });
    expect(result.identity).toBe("coder@example.test");
  });

  it("reads the same snapshot as the cap: the preferred limit id before the legacy one", () => {
    const preferred = codexLimits([
      { usedPercent: 55, windowDurationMins: 10080, resetsAt },
    ]).rateLimits;
    const limits = {
      ...codexLimits([{ usedPercent: 5, windowDurationMins: 10080, resetsAt }]),
      rateLimitsByLimitId: { [CODEX_PREFERRED_LIMIT_ID]: preferred },
    };
    const result = codexAccountProbeResult(account, limits);
    expect(result.weekly).toMatchObject({ usedPercent: 55 });
    if (result.reading.kind !== "usage") throw new Error("not usage");
    expect(result.reading.windows.map((w) => w.usedPercent)).toEqual([55]);
  });

  it("reads no sign-in as signed out, API-key billing as no limit, and missing limits as failed", () => {
    expect(codexAccountProbeResult(null, null)).toEqual({
      weekly: { kind: "signed_out" },
      reading: { kind: "signed_out" },
      identity: null,
    });
    const apiKey = codexAccountProbeResult({ type: "apiKey" }, null);
    expect([apiKey.weekly.kind, apiKey.reading.kind]).toEqual([
      "no_limit",
      "no_limit",
    ]);
    const noLimits = codexAccountProbeResult(account, null);
    expect([noLimits.weekly.kind, noLimits.reading.kind]).toEqual([
      "failed",
      "failed",
    ]);
  });
});

const usageReading = (weeklyUsed: number): AccountReading => ({
  kind: "usage",
  plan: "max",
  windows: [
    {
      label: "Weekly",
      shortLabel: "WK",
      usedPercent: weeklyUsed,
      resetsAtMs: NOW + 2 * DAY_MS,
    },
  ],
});
const accountResult = (
  weeklyUsed: number,
  identity: string | null = "who@example.test",
): AccountProbeResult => ({
  weekly: weekly(weeklyUsed),
  reading: usageReading(weeklyUsed),
  identity,
});
const failedResult: AccountProbeResult = {
  weekly: { kind: "failed" },
  reading: { kind: "failed" },
  identity: null,
};

// A reader whose probes each wait for the test to answer them, keyed by the
// env's ACCOUNT variable, on a hand-driven clock and hand-fired timers.
function accountHarness(opts: { maxMemberProbes?: number } = {}) {
  let now = NOW;
  const probes: {
    account: string;
    closes: number;
    reads: number;
    pending: ((r: AccountProbeResult) => void)[];
  }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const officeEnv = { ACCOUNT: "office" };
  const reader = createAccountUsageReader({
    officeTarget: () => ({ dir: "/office/claude", env: officeEnv }),
    keyOf: (provider, env) => `${provider}:${env.ACCOUNT}`,
    ...(opts.maxMemberProbes === undefined
      ? {}
      : { maxMemberProbes: opts.maxMemberProbes }),
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
    createProbe: (_provider, env): AccountUsageProbe => {
      const probe = {
        account: String(env.ACCOUNT),
        closes: 0,
        reads: 0,
        pending: [] as ((r: AccountProbeResult) => void)[],
      };
      probes.push(probe);
      return {
        read: () => {
          probe.reads++;
          return new Promise((resolve) => probe.pending.push(resolve));
        },
        close: () => probe.closes++,
      };
    },
  });
  const member = (account: string): AccountUsageTarget => ({
    key: `claude:${account}`,
    provider: "claude",
    env: { ACCOUNT: account },
    warm: false,
  });
  const office: AccountUsageTarget = {
    key: "claude:office",
    provider: "claude",
    env: officeEnv,
    warm: true,
  };
  // Answer the oldest pending read of `account`'s newest probe.
  const answer = async (account: string, result: AccountProbeResult) => {
    const probe = probes.filter((p) => p.account === account).at(-1);
    const pending = probe?.pending.shift();
    if (!pending) throw new Error(`no read of ${account} is pending`);
    pending(result);
    await settled();
  };
  const created = (account: string) =>
    probes.filter((p) => p.account === account).length;
  return {
    reader,
    member,
    office,
    answer,
    created,
    probes,
    timers,
    advance: (ms: number) => (now += ms),
  };
}

describe("createAccountUsageReader", () => {
  it("serves the cap and the card from the office slot's one warm process", async () => {
    const h = accountHarness();
    const cap = h.reader.read("claude");
    await settled();
    await h.answer("office", accountResult(20, "office@example.test"));
    expect(await cap).toMatchObject({ kind: "weekly", usedPercent: 20 });
    // The card's read of the office key takes the cap's answer: no process.
    expect(await h.reader.readAccount(h.office)).toEqual({
      reading: usageReading(20),
      identity: "office@example.test",
      observedAtMs: NOW,
    });
    expect([h.created("office"), h.probes[0]!.closes]).toEqual([1, 0]);

    // And the other way round: the cap takes the card's fresh answer.
    h.advance(FRESH_MS + 1);
    const card = h.reader.readAccount(h.office);
    await settled();
    await h.answer("office", accountResult(25));
    await card;
    expect(await h.reader.read("claude")).toMatchObject({ usedPercent: 25 });
    expect([h.created("office"), h.probes[0]!.reads]).toEqual([1, 2]);
  });

  it("closes a member's process after its answer and reuses the answer for FRESH_MS", async () => {
    const h = accountHarness();
    const first = h.reader.readAccount(h.member("ana"));
    await settled();
    expect(h.reader.peek("claude:ana").reading).toBe(true);
    await h.answer("ana", accountResult(10));
    expect((await first).reading).toEqual(usageReading(10));
    expect(h.probes.map((p) => p.closes)).toEqual([1]);
    expect(h.reader.peek("claude:ana")).toEqual({
      answer: {
        reading: usageReading(10),
        identity: "who@example.test",
        observedAtMs: NOW,
      },
      reading: false,
    });

    h.advance(FRESH_MS - 1);
    await h.reader.readAccount(h.member("ana"));
    expect(h.created("ana")).toBe(1);
    h.advance(1);
    const again = h.reader.readAccount(h.member("ana"));
    await settled();
    await h.answer("ana", accountResult(11));
    expect((await again).reading).toEqual(usageReading(11));
    expect(h.probes.map((p) => p.closes)).toEqual([1, 1]);
  });

  it("shares one read between concurrent callers of a key, and a refresh reads again only after REFRESH_FLOOR_MS", async () => {
    const h = accountHarness();
    const a = h.reader.readAccount(h.member("ana"));
    const b = h.reader.readAccount(h.member("ana"), { refresh: true });
    await settled();
    await h.answer("ana", accountResult(10));
    expect([(await a).reading, (await b).reading]).toEqual([
      usageReading(10),
      usageReading(10),
    ]);
    expect(h.created("ana")).toBe(1);

    h.advance(REFRESH_FLOOR_MS - 1);
    await h.reader.readAccount(h.member("ana"), { refresh: true });
    expect(h.created("ana")).toBe(1);
    h.advance(1);
    const refreshed = h.reader.readAccount(h.member("ana"), { refresh: true });
    await settled();
    await h.answer("ana", accountResult(12));
    expect((await refreshed).reading).toEqual(usageReading(12));
    expect(h.created("ana")).toBe(2);
  });

  it("answers a failed read with the last good reading under FALLBACK_MS, as observed, and with failed after", async () => {
    const h = accountHarness();
    const good = h.reader.readAccount(h.member("ana"));
    await settled();
    await h.answer("ana", accountResult(30, "ana@example.test"));
    await good;

    h.advance(FRESH_MS + 1);
    const failed = h.reader.readAccount(h.member("ana"));
    await settled();
    await h.answer("ana", failedResult);
    expect(await failed).toEqual({
      reading: usageReading(30),
      identity: "ana@example.test",
      observedAtMs: NOW,
    });

    h.advance(FALLBACK_MS);
    const late = h.reader.readAccount(h.member("ana"));
    await settled();
    await h.answer("ana", failedResult);
    expect((await late).reading).toEqual({ kind: "failed" });
  });

  it("runs at most maxMemberProbes member reads at once, and never queues an office read behind them", async () => {
    const h = accountHarness({ maxMemberProbes: 2 });
    const reads = ["ana", "ben", "cy"].map((name) =>
      h.reader.readAccount(h.member(name)),
    );
    await settled();
    expect(h.probes.map((p) => p.account)).toEqual(["ana", "ben"]);

    // The member lane is full; the cap's office read starts at once.
    const cap = h.reader.read("claude");
    await settled();
    expect(h.created("office")).toBe(1);
    await h.answer("office", accountResult(40));
    expect(await cap).toMatchObject({ usedPercent: 40 });

    // A member read that ends lets the queued one start.
    await h.answer("ana", accountResult(1));
    expect(h.created("cy")).toBe(1);
    await h.answer("ben", accountResult(2));
    await h.answer("cy", accountResult(3));
    expect((await Promise.all(reads)).map((r) => r.reading)).toEqual([
      usageReading(1),
      usageReading(2),
      usageReading(3),
    ]);
  });

  it("closes a member probe that does not answer within the timeout and reads as failed", async () => {
    const h = accountHarness();
    const read = h.reader.readAccount(h.member("ana"));
    await settled();
    const timeout = h.timers
      .filter((t) => t.live)
      .sort((a, b) => a.ms - b.ms)[0];
    if (!timeout) throw new Error("no probe timeout armed");
    timeout.live = false;
    timeout.fn();
    expect((await read).reading).toEqual({ kind: "failed" });
    expect(h.probes.map((p) => p.closes)).toEqual([1]);
    // Its late answer does not land.
    await h.answer("ana", accountResult(9));
    expect(h.reader.peek("claude:ana").answer?.reading).toEqual({
      kind: "failed",
    });
  });

  it("drops the member slots retain does not keep, with a read in flight, and never the office slot", async () => {
    const h = accountHarness();
    for (const target of [h.member("ana"), h.member("ben"), h.office]) {
      const read = h.reader.readAccount(target);
      await settled();
      await h.answer(target.env.ACCOUNT!, accountResult(10));
      await read;
    }
    h.advance(FRESH_MS + 1);
    const inFlight = h.reader.readAccount(h.member("cy"));
    await settled();

    h.reader.retain(new Set(["claude:ben"]));
    await h.answer("cy", accountResult(50));
    await inFlight;
    expect(
      ["ana", "ben", "cy", "office"].map(
        (name) => h.reader.peek(`claude:${name}`).answer !== null,
      ),
    ).toEqual([false, true, false, true]);
    // The dropped probe was closed once, like every member probe.
    expect(h.probes.map((p) => [p.account, p.closes])).toEqual([
      ["ana", 1],
      ["ben", 1],
      ["office", 0],
      ["cy", 1],
    ]);
  });
});

// Task faf036ad: a failed read logged nothing, so a row that said "Usage
// could not be read." left no trace of why. Each failed read logs one line:
// the provider, the office or a member's account, the cause and how long the
// read took. Never the usage key or the sign-in directory.
describe("createAccountUsageReader: the failed-read log", () => {
  const OFFICE_DIR = "/office-dir-q9x/claude";
  const MEMBER = "acct-zq7w";

  function logHarness(
    read: (
      account: string,
      advance: (ms: number) => void,
    ) => Promise<AccountProbeResult>,
  ) {
    let now = NOW;
    const timers: { fn: () => void; live: boolean }[] = [];
    const officeEnv = { ACCOUNT: "office" };
    const reader = createAccountUsageReader({
      officeTarget: () => ({ dir: OFFICE_DIR, env: officeEnv }),
      keyOf: (provider, env) => `${provider}:${OFFICE_DIR}:${env.ACCOUNT}`,
      now: () => now,
      setTimer: (fn) => {
        const timer = { fn, live: true };
        timers.push(timer);
        return () => (timer.live = false);
      },
      createProbe: (_provider, env) => ({
        read: () => read(String(env.ACCOUNT), (ms) => (now += ms)),
        close() {},
      }),
    });
    const target = (
      provider: "claude" | "codex",
      account: string,
    ): AccountUsageTarget => ({
      key: `${provider}:${OFFICE_DIR}:${account}`,
      provider,
      env: account === "office" ? officeEnv : { ACCOUNT: account },
      warm: account === "office",
    });
    return {
      reader,
      target,
      timers,
      advance: (ms: number) => (now += ms),
    };
  }

  // The lines console.warn got while `run` ran, each as one string.
  async function warnLines(run: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  const noSecrets = (line: string) => {
    expect(line).not.toContain(OFFICE_DIR);
    expect(line).not.toContain("q9x");
    expect(line).not.toContain(MEMBER);
    expect(line).not.toContain("@example.test");
  };

  it("logs nothing for a good read", async () => {
    const h = logHarness(async () => accountResult(30));
    let answer: unknown;
    const lines = await warnLines(async () => {
      answer = await h.reader.readAccount(h.target("claude", MEMBER));
    });
    expect(answer).toMatchObject({ reading: { kind: "usage" } });
    expect(lines).toEqual([]);
  });

  it("logs one line for a read that times out, with its provider and how long it ran", async () => {
    const h = logHarness(() => new Promise<AccountProbeResult>(() => {}));
    let answer: unknown;
    const lines = await warnLines(async () => {
      const read = h.reader.readAccount(h.target("claude", MEMBER));
      await settled();
      const live = h.timers.filter((t) => t.live);
      expect(live).toHaveLength(1);
      h.advance(20_000);
      live[0]!.live = false;
      live[0]!.fn();
      answer = await read;
    });
    expect(answer).toMatchObject({ reading: { kind: "failed" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.toLowerCase()).toContain("claude");
    expect(lines[0]).toContain("20000");
    noSecrets(lines[0]!);
  });

  it("logs one line for a read that throws, with the error on one short line and how long it ran", async () => {
    const marker = "probe-boom-k3";
    const h = logHarness(async (_account, advance) => {
      advance(1234);
      throw new Error(`${marker}\n${"x".repeat(2000)}`);
    });
    let answer: unknown;
    const lines = await warnLines(async () => {
      answer = await h.reader.readAccount(h.target("codex", MEMBER));
    });
    expect(answer).toMatchObject({ reading: { kind: "failed" } });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.toLowerCase()).toContain("codex");
    expect(line.toLowerCase()).not.toContain("claude");
    expect(line).toContain(marker);
    expect(line).toContain("1234");
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(400);
    noSecrets(line);
  });

  it("logs one line for an answer it could not read, and tells the office's account from a member's and each cause from the others", async () => {
    const h = logHarness(async (account) => {
      if (account === "throws") throw new Error("rpc died");
      if (account === "slow") return new Promise<AccountProbeResult>(() => {});
      return failedResult;
    });
    const lines = await warnLines(async () => {
      const office = await h.reader.readAccount(h.target("claude", "office"));
      const member = await h.reader.readAccount(h.target("claude", MEMBER));
      const thrown = await h.reader.readAccount(h.target("claude", "throws"));
      const slow = h.reader.readAccount(h.target("claude", "slow"));
      await settled();
      // The slow read's timeout: a failed read leaves no idle timer.
      const live = h.timers.filter((t) => t.live);
      expect(live).toHaveLength(1);
      live[0]!.live = false;
      live[0]!.fn();
      const timedOut = await slow;
      expect(
        [office, member, thrown, timedOut].map((a) => a.reading.kind),
      ).toEqual(["failed", "failed", "failed", "failed"]);
    });
    expect(lines).toHaveLength(4);
    const [office, member, thrown, timedOut] = lines as [
      string,
      string,
      string,
      string,
    ];
    // Same provider, same cause, no time passed: only the slot tells them
    // apart.
    expect(office).not.toBe(member);
    // A member's account read three ways, no time passed: only the cause
    // tells them apart.
    expect(new Set([member, thrown, timedOut]).size).toBe(3);
    for (const line of lines) noSecrets(line);
  });
});
