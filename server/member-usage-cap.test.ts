import { describe, expect, it } from "bun:test";
import {
  billingAccountFor,
  createMemberUsageCap,
  evaluateLine,
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

const DAY_MS = WEEK_MS / 7;

describe("evaluateLine", () => {
  // A week that started at NOW: day d starts at NOW + (d - 1) days.
  const resetsAt = NOW + WEEK_MS;
  const dayStart = (day: number) => NOW + (day - 1) * DAY_MS;

  it("steps a 70% share through 10, 20, ... 70 and stops members at the line", () => {
    for (let day = 1; day <= 7; day++) {
      const at = dayStart(day);
      expect(evaluateLine(0, resetsAt, at, 70).linePercent).toBe(10 * day);
      expect(evaluateLine(10 * day - 1, resetsAt, at, 70).allowed).toBe(true);
      expect(evaluateLine(10 * day, resetsAt, at, 70).allowed).toBe(false);
    }
  });

  it("opens a whole day's allowance at the start of that day", () => {
    expect(evaluateLine(15, resetsAt, dayStart(2) - 1, 70).allowed).toBe(false);
    expect(evaluateLine(15, resetsAt, dayStart(2), 70).allowed).toBe(true);
    // The last moment of the week is still day 7.
    expect(evaluateLine(0, resetsAt, resetsAt - 1, 70).linePercent).toBe(70);
  });

  it("scales the line by the share", () => {
    expect(evaluateLine(0, resetsAt, NOW, 80).linePercent).toBeCloseTo(80 / 7);
    expect(evaluateLine(0, resetsAt, dayStart(7), 100).linePercent).toBe(100);
  });

  it("retries at the first later day whose line is strictly above the use", () => {
    // Day 1 at 20% used: day 2's line is 20, not above; day 3's is 30.
    expect(evaluateLine(20, resetsAt, NOW, 70).retryAtMs).toBe(dayStart(3));
    expect(evaluateLine(10, resetsAt, NOW, 70).retryAtMs).toBe(dayStart(2));
  });

  it("waits for the reset when no later day's line is above the use", () => {
    expect(evaluateLine(70, resetsAt, dayStart(2), 70).retryAtMs).toBe(
      resetsAt,
    );
    expect(evaluateLine(65, resetsAt, dayStart(7), 70).retryAtMs).toBe(
      resetsAt,
    );
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
  const savedShares: number[] = [];
  const c = createMemberUsageCap({
    reader: r.reader,
    officeDir: () => "/office/claude",
    load: () => true,
    save: (enabled) => saved.push(enabled),
    saveShare: (share) => savedShares.push(share),
    now: () => now,
  });
  return {
    cap: c,
    r,
    saved,
    savedShares,
    advance: (ms: number) => (now += ms),
  };
}

// Mid-week is day 4: with the default 80% share the line is 80 x 4 / 7, about
// 45.7%.
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

  it("refuses at or above today's line and admits below it", async () => {
    const t = cap([over, under]);
    expect(await t.cap.admit(OFFICE)).toEqual({
      kind: "refused",
      // Day 5 (line about 57.1%) is not above 60%; day 6 (68.6%) is.
      retryAtMs: NOW + WEEK_MS / 2 - 2 * DAY_MS,
    });
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
  });

  it("follows the owner's share, saves it, and drops answers given on the old line", async () => {
    const t = cap([over, over]);
    expect(t.cap.share()).toBe(80);
    expect(await t.cap.admit(OFFICE)).toMatchObject({ kind: "refused" });
    expect(t.cap.peek(OFFICE)).toMatchObject({ kind: "refused" });
    // A 100% share puts day 4's line at about 57.1%: still under 60%.
    t.cap.setShare(100);
    expect(t.savedShares).toEqual([100]);
    expect(t.cap.peek(OFFICE)).toBeNull();
    expect(await t.cap.admit(OFFICE)).toMatchObject({ kind: "refused" });
    t.cap.setShare(10);
    t.r.reader.read = async () => ({ ...under, usedPercent: 5 });
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
  });

  it("exempts a provider-reported no-limit account and admits when it cannot read", async () => {
    const t = cap([
      { kind: "no_limit", observedAtMs: NOW },
      { kind: "failed" },
      { kind: "signed_out" },
    ]);
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "exempt" });
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
    expect(await t.cap.admit(OFFICE)).toEqual({ kind: "admitted" });
  });

  it("admits when the office directory cannot be resolved", async () => {
    const r = fakeReader([over]);
    const c = createMemberUsageCap({
      reader: r.reader,
      officeDir: () => {
        throw new Error("office env does not parse");
      },
      load: () => true,
      now: () => NOW,
    });
    expect(await c.admit(OFFICE)).toEqual({ kind: "admitted" });
    expect(c.peek(OFFICE)).toEqual({ kind: "admitted" });
    expect(r.reads).toBe(0);
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

  it("stops peeking a refusal once its retry time comes", async () => {
    // 45% used, a moment before day 4 opens: day 4's line is about 45.7%.
    const dayFourAt = NOW + 3 * DAY_MS;
    const t = cap(
      [
        {
          kind: "weekly",
          usedPercent: 45,
          resetsAtMs: NOW + WEEK_MS,
          observedAtMs: dayFourAt - 1000,
        },
      ],
      dayFourAt - 1000,
    );
    expect(await t.cap.admit(OFFICE)).toEqual({
      kind: "refused",
      retryAtMs: dayFourAt,
    });
    t.advance(999);
    expect(t.cap.peek(OFFICE)).toMatchObject({ kind: "refused" });
    t.advance(1);
    expect(t.cap.peek(OFFICE)).toBeNull();
  });

  it("reports one status line per provider with an office sign-in", async () => {
    const t = cap([under, { kind: "signed_out" }]);
    const rows = await t.cap.status();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      state: "weekly",
      usedPercent: 40,
      linePercent: (80 * 4) / 7,
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
    expect(await pending).toMatchObject({ kind: "refused" });
  });

  it("admits when every read is overtaken", async () => {
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
    expect(await c.admit(OFFICE)).toEqual({ kind: "admitted" });
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
    expect(await pending).toMatchObject({ kind: "refused" });
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
  it("names the wait until members resume", () => {
    const text = usageCapText(english, { retryAtMs: NOW + 3 * 3600_000 }, NOW);
    expect(text).toContain("3");
    expect(text).not.toContain("{");
  });
});
