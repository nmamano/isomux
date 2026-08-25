import { describe, expect, test } from "bun:test";
import { driveTicks } from "./drive-loop.ts";
import type { Store } from "./store.ts";
import type { TickSummary } from "./tick.ts";

const summary = (live: number): TickSummary => ({
  leased: 0,
  acted: 0,
  completed: 0,
  flagged: 0,
  live,
});

function emptyStore(): Store {
  return {
    listInstances: async () => [],
    openReasons: async () => [],
  } as unknown as Store;
}

describe("the provisioner's combined cadence", () => {
  test("the operation pass completes before the lifecycle pass starts", async () => {
    const events: string[] = [];
    await driveTicks(
      emptyStore(),
      {
        once: async () => {
          events.push("operation:start", "operation:end");
          return summary(0);
        },
        hasWork: async () => false,
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: () => {} },
        cadence: {
          failureLabel: "lifecycle pass failed",
          run: async () => {
            events.push("lifecycle:start", "lifecycle:end");
          },
        },
        onTick: () => events.push("healthy"),
      },
    );
    expect(events).toEqual([
      "operation:start",
      "operation:end",
      "lifecycle:start",
      "lifecycle:end",
      "healthy",
    ]);
  });

  test("a failed lifecycle pass is visible, retried, and not marked healthy", async () => {
    let ticks = 0;
    let lifecyclePasses = 0;
    let healthyPasses = 0;
    const problems: string[] = [];
    await driveTicks(
      emptyStore(),
      {
        once: async () => summary(++ticks === 1 ? 1 : 0),
        hasWork: async () => true,
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: (line) => problems.push(line) },
        cadence: {
          failureLabel: "lifecycle pass failed",
          run: async () => {
            if (++lifecyclePasses === 1) throw new Error("denied");
          },
        },
        onTick: () => healthyPasses++,
        sleep: async () => {},
      },
    );
    expect(lifecyclePasses).toBe(2);
    expect(healthyPasses).toBe(1);
    expect(problems).toEqual(["lifecycle pass failed: denied"]);
  });

  test("idle work wakes the full pass on the next five-second probe", async () => {
    const events: string[] = [];
    let ticks = 0;
    let probes = 0;
    let now = 0;
    await driveTicks(
      emptyStore(),
      {
        once: async () => {
          events.push(`tick:${now}`);
          return summary(++ticks === 1 ? 1 : 0);
        },
        hasWork: async () => {
          events.push(`probe:${now}`);
          return ++probes === 2;
        },
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: () => {} },
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(events).toEqual([
      "tick:0",
      "probe:5000",
      "probe:10000",
      "tick:10000",
    ]);
  });

  test("an empty probe returns completed work to minute maintenance", async () => {
    let ticks = 0;
    let probes = 0;
    let now = 0;
    await driveTicks(
      emptyStore(),
      {
        once: async () => summary(++ticks === 1 ? 1 : 0),
        hasWork: async () => {
          probes++;
          return false;
        },
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: () => {} },
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(ticks).toBe(2);
    expect(probes).toBe(12);
    expect(now).toBe(60_000);
  });
});
