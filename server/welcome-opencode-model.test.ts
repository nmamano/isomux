import { describe, expect, it } from "bun:test";
import {
  resolveWelcomeOpenCodeModel,
  retryWelcomeOpenCodeModel,
  WELCOME_MODEL_RETRY_WINDOW_CLOSED,
  type WelcomeModelRetryClock,
} from "./welcome-opencode-model.ts";
import type { BackendModelWire } from "../shared/types.ts";

describe("welcome OpenCode model resolution", () => {
  const preferred = "opencode/preferred-free";

  it("selects a free replacement when the preferred id is gone", async () => {
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          { id: "paid/default", label: "Paid", supportedEfforts: [] },
          {
            id: "opencode/replacement-free",
            label: "Free",
            isFree: true,
            supportedEfforts: [],
          },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "selected", model: "opencode/replacement-free" });
  });

  it("picks only from the preferred model's provider", async () => {
    const goFree: BackendModelWire = {
      id: "opencode-go/sorts-first-free",
      label: "Go",
      isFree: true,
      supportedEfforts: [],
    };
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          goFree,
          {
            id: "opencode/replacement-free",
            label: "Free",
            isFree: true,
            supportedEfforts: [],
          },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "selected", model: "opencode/replacement-free" });
    expect(
      await resolveWelcomeOpenCodeModel(async () => [goFree], preferred, 100),
    ).toEqual({ kind: "no_free_model" });
  });

  it("distinguishes a successful discovery with no free model", async () => {
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          { id: "paid/default", label: "Paid", supportedEfforts: [] },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "no_free_model" });
  });

  it("bounds discovery and reports failure", async () => {
    const result = await resolveWelcomeOpenCodeModel(
      () => new Promise(() => undefined),
      preferred,
      5,
    );
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed") {
      expect(String(result.error)).toContain("timed out");
    }
  });
});

describe("welcome OpenCode model retry", () => {
  const preferred = "opencode/preferred-free";
  const timing = { delayMs: 100, windowMs: 1_000 };
  const free: BackendModelWire = {
    id: "opencode/replacement-free",
    label: "Free",
    isFree: true,
    supportedEfforts: [],
  };

  // Sleeping moves the clock forward, so a test covers the window at once.
  function fakeClock(): WelcomeModelRetryClock & { sleeps: number[] } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    };
  }

  it("waits between failed attempts and returns the first success", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        if (calls < 3) throw new Error("not ready");
        return [free];
      },
      preferred,
      timing,
      clock,
    );
    expect(result).toEqual({ kind: "selected", model: free.id });
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([timing.delayMs, timing.delayMs]);
  });

  it("stops at the end of the window and reports the failure", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        throw new Error("offline");
      },
      preferred,
      timing,
      clock,
    );
    expect(result.kind).toBe("discovery_failed");
    expect(clock.now()).toBeLessThanOrEqual(timing.windowMs);
    expect(calls).toBe(clock.sleeps.length + 1);
    expect(calls).toBeGreaterThan(1);
  });

  it("never starts a request while the previous one is pending", async () => {
    const clock = fakeClock();
    let calls = 0;
    void retryWelcomeOpenCodeModel(
      () => {
        calls++;
        return new Promise<BackendModelWire[]>(() => undefined);
      },
      preferred,
      timing,
      clock,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("ignores a result that arrives after the window", async () => {
    const clock = fakeClock();
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        await clock.sleep(timing.windowMs + 1);
        return [free];
      },
      preferred,
      timing,
      clock,
    );
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed")
      expect(String(result.error)).toContain(WELCOME_MODEL_RETRY_WINDOW_CLOSED);
  });

  it("starts no request when a delayed wake-up lands after the window", async () => {
    let now = 0;
    const starts: number[] = [];
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        starts.push(now);
        throw new Error("offline");
      },
      preferred,
      { delayMs: 1, windowMs: 10 },
      { now: () => now, sleep: async () => void (now = 11) },
    );
    expect(starts).toEqual([0]);
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed")
      expect(String(result.error)).toContain(WELCOME_MODEL_RETRY_WINDOW_CLOSED);
  });

  it("does not retry after a discovery with no free model", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        return [{ id: "paid/default", label: "Paid", supportedEfforts: [] }];
      },
      preferred,
      timing,
      clock,
    );
    expect(result).toEqual({ kind: "no_free_model" });
    expect(calls).toBe(1);
  });
});
