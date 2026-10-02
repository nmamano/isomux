import { describe, expect, it } from "bun:test";
import {
  billingAccountFor,
  createMemberUsageCap,
  evaluatePace,
  usageCapText,
} from "./member-usage-cap.ts";
import {
  createOfficeUsageReader,
  FRESH_MS,
  WEEK_MS,
  type OfficeUsageReader,
  type OfficeWeeklyOutcome,
} from "./office-usage.ts";
import { english } from "./i18n.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");

describe("evaluatePace", () => {
  it("stops members at 90% with 10% of the week left", () => {
    const resetsAt = NOW + WEEK_MS / 10;
    expect(evaluatePace(89, resetsAt, NOW).allowed).toBe(true);
    expect(evaluatePace(90, resetsAt, NOW).allowed).toBe(false);
  });

  it("lifts when the elapsed share of the week reaches today's use", () => {
    const resetsAt = NOW + WEEK_MS / 2;
    const pace = evaluatePace(75, resetsAt, NOW);
    expect(pace.allowed).toBe(false);
    expect(pace.retryAtMs).toBe(resetsAt - WEEK_MS / 4);
    expect(evaluatePace(75, resetsAt, pace.retryAtMs + 1).allowed).toBe(true);
  });

  it("waits for the reset when the week is used up", () => {
    const resetsAt = NOW + 1000;
    expect(evaluatePace(100, resetsAt, NOW).retryAtMs).toBe(resetsAt);
  });
});

function fakeReader(outcomes: OfficeWeeklyOutcome[]) {
  let reads = 0;
  const reader: OfficeUsageReader = {
    async read() {
      reads++;
      return outcomes.shift() ?? { kind: "failed" };
    },
    invalidate() {},
    close() {},
  };
  return {
    reader,
    get reads() {
      return reads;
    },
  };
}

const OFFICE = { provider: "claude" as const, dir: "/office/claude" };

function cap(outcomes: OfficeWeeklyOutcome[], start = NOW) {
  let now = start;
  const r = fakeReader(outcomes);
  const saved: boolean[] = [];
  const c = createMemberUsageCap({
    reader: r.reader,
    officeDir: () => "/office/claude",
    load: () => true,
    save: (enabled) => saved.push(enabled),
    now: () => now,
  });
  return { cap: c, r, saved, advance: (ms: number) => (now += ms) };
}

const over: OfficeWeeklyOutcome = {
  kind: "weekly",
  usedPercent: 60,
  resetsAtMs: NOW + WEEK_MS / 2,
  observedAtMs: NOW,
};
const under: OfficeWeeklyOutcome = { ...over, usedPercent: 40 };

describe("createMemberUsageCap", () => {
  it("admits everything without a read while switched off", async () => {
    const t = cap([over]);
    t.cap.setEnabled(false);
    expect(t.saved).toEqual([false]);
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
    expect(t.r.reads).toBe(0);
  });

  it("exempts a personal connection and a backend it does not cover", async () => {
    const t = cap([over]);
    expect(
      await t.cap.admit({ provider: "claude", dir: "/home/m/.claude" }),
    ).toEqual({ kind: "exempt" });
    expect(await t.cap.admit(null)).toEqual({ kind: "exempt" });
    expect(t.r.reads).toBe(0);
  });

  it("refuses ahead of pace and admits behind it", async () => {
    const t = cap([over, under]);
    expect(await t.cap.admit(OFFICE)).toMatchObject({
      kind: "refused",
      reason: "pace",
    });
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
  });

  it("exempts only a provider-reported no-limit account", async () => {
    const t = cap([
      { kind: "no_limit", observedAtMs: NOW },
      { kind: "failed" },
      { kind: "signed_out" },
    ]);
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "exempt" });
    expect(await t.cap.admit(OFFICE)).toEqual({
      kind: "refused",
      reason: "read_failed",
      retryAtMs: NOW + FRESH_MS,
    });
    expect(await t.cap.admit(OFFICE)).toMatchObject({
      reason: "read_failed",
    });
  });

  it("peeks the last answer for FRESH_MS and nothing after", async () => {
    const t = cap([over]);
    expect(t.cap.peek(OFFICE)).toBeNull();
    await t.cap.admit(OFFICE);
    expect(t.cap.peek(OFFICE)).toMatchObject({ kind: "refused" });
    t.advance(FRESH_MS + 1);
    expect(t.cap.peek(OFFICE)).toBeNull();
    // A personal account needs no reading.
    expect(t.cap.peek({ provider: "claude", dir: "/elsewhere" })).toEqual({
      kind: "exempt",
    });
  });

  it("reports one status line per provider with an office sign-in", async () => {
    const t = cap([under, { kind: "signed_out" }]);
    const rows = await t.cap.status();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      state: "weekly",
      usedPercent: 40,
      pacePercent: 50,
    });
  });
});

// Let pending promise chains run.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("createMemberUsageCap invalidation", () => {
  it("neither returns nor records an answer an invalidation overtook", async () => {
    const releases: ((o: OfficeWeeklyOutcome) => void)[] = [];
    const c = createMemberUsageCap({
      reader: {
        read: () =>
          new Promise<OfficeWeeklyOutcome>((resolve) => releases.push(resolve)),
        invalidate() {},
        close() {},
      },
      officeDir: () => "/office/claude",
      load: () => true,
      now: () => NOW,
    });
    const pending = c.admit(OFFICE);
    await Promise.resolve();
    c.invalidate("claude");
    releases[0](under);
    await flush();
    expect(c.peek(OFFICE)).toBeNull();
    // The overtaken answer sent the admission round again.
    expect(releases).toHaveLength(2);
    releases[1](over);
    expect(await pending).toMatchObject({ kind: "refused", reason: "pace" });
  });

  it("refuses when every read is overtaken", async () => {
    let c: ReturnType<typeof createMemberUsageCap> | null = null;
    c = createMemberUsageCap({
      reader: {
        read: async () => {
          c!.invalidate("claude");
          return under;
        },
        invalidate() {},
        close() {},
      },
      officeDir: () => "/office/claude",
      load: () => true,
      now: () => NOW,
    });
    expect(await c.admit(OFFICE)).toMatchObject({
      kind: "refused",
      reason: "read_failed",
    });
  });

  it("does not admit on a cached reading the office replaced during the admission", async () => {
    // The real reader hands back its warm cache before its first await, so
    // the invalidation lands while the admission is still pending.
    let used = 10;
    const c = createMemberUsageCap({
      reader: createOfficeUsageReader({
        officeTarget: () => ({ dir: "/office/claude", env: {} }),
        createProbe: () => ({
          read: async () => ({
            kind: "weekly",
            usedPercent: used,
            resetsAtMs: Date.now() + WEEK_MS / 2,
          }),
          close() {},
        }),
        setTimer: () => () => {},
      }),
      officeDir: () => "/office/claude",
      load: () => true,
    });
    expect(await c.admit(OFFICE)).toEqual({ kind: "admitted" });
    const pending = c.admit(OFFICE);
    used = 90;
    c.invalidate("claude");
    expect(await pending).toMatchObject({ kind: "refused", reason: "pace" });
    expect(c.peek(OFFICE)).toMatchObject({ kind: "refused" });
  });
});

describe("billingAccountFor", () => {
  it("names the account directory the session env selects", () => {
    expect(
      billingAccountFor("claude", { CLAUDE_CONFIG_DIR: "/acct/claude" }),
    ).toEqual({ provider: "claude", dir: "/acct/claude" });
    expect(billingAccountFor("opencode", {})).toBeNull();
  });
});

describe("usageCapText", () => {
  it("names the wait for a pace refusal and gives no time for a read failure", () => {
    const pace = usageCapText(
      english,
      { reason: "pace", retryAtMs: NOW + 3 * 3600_000 },
      NOW,
    );
    const failed = usageCapText(
      english,
      { reason: "read_failed", retryAtMs: NOW + FRESH_MS },
      NOW,
    );
    expect(pace).toContain("3");
    expect(pace).not.toBe(failed);
    expect(failed).not.toContain("{");
  });
});
