import { describe, expect, test } from "bun:test";
import { DriveWake, driveTicks } from "./drive-loop.ts";
import type { Store, WorkSchedule } from "./store.ts";
import type { TickSummary } from "./tick.ts";

const summary = (live: number): TickSummary => ({
  leased: 0,
  acted: 0,
  completed: 0,
  flagged: 0,
  live,
});

const idle = (patch: Partial<WorkSchedule> = {}): WorkSchedule => ({
  tickDue: false,
  cadenceDue: false,
  livenessDue: false,
  nextDueAt: null,
  ...patch,
});

const capabilities = {
  providerConfigured: true,
  provisioningConfigured: true,
  checkoutConfigured: true,
  staleProvisioningMs: 30 * 60_000,
  staleProvisioningReason: "stalled",
};

function scheduledStore(
  schedules: WorkSchedule[],
  reads: { count: number } = { count: 0 },
): Store {
  return {
    workSchedule: async () => {
      const schedule = schedules[Math.min(reads.count, schedules.length - 1)];
      reads.count++;
      return schedule;
    },
    allOpenReasons: async () => [],
  } as unknown as Store;
}

describe("the provisioner's combined cadence", () => {
  test("the operation pass completes before a due lifecycle pass starts", async () => {
    const events: string[] = [];
    await driveTicks(
      scheduledStore([idle({ cadenceDue: true })]),
      {
        once: async () => {
          events.push("operation:start", "operation:end");
          return summary(0);
        },
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
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
      "healthy",
      "operation:start",
      "operation:end",
      "lifecycle:start",
      "lifecycle:end",
    ]);
  });

  test("a failed lifecycle class is visible and retried while schedule health stays current", async () => {
    let ticks = 0;
    let lifecyclePasses = 0;
    let healthyPasses = 0;
    let consecutiveCadenceFailures = 0;
    const cadenceFailureCounts: number[] = [];
    const problems: string[] = [];
    await driveTicks(
      scheduledStore([idle({ cadenceDue: true, tickDue: true })]),
      { once: async () => summary(++ticks === 4 ? 0 : 1) },
      {
        forever: false,
        reporter: { line: () => {}, problem: (line) => problems.push(line) },
        capabilities,
        cadence: {
          failureLabel: "lifecycle pass failed",
          run: async () => {
            if (++lifecyclePasses <= 3) throw new Error("denied");
          },
        },
        onTick: () => healthyPasses++,
        onCadenceResult: (succeeded) => {
          consecutiveCadenceFailures = succeeded
            ? 0
            : consecutiveCadenceFailures + 1;
          cadenceFailureCounts.push(consecutiveCadenceFailures);
        },
        sleep: async () => {},
      },
    );
    expect(lifecyclePasses).toBe(4);
    expect(healthyPasses).toBe(4);
    expect(cadenceFailureCounts).toEqual([1, 2, 3, 0]);
    expect(problems).toEqual([
      "lifecycle pass failed: denied",
      "lifecycle pass failed: denied",
      "lifecycle pass failed: denied",
    ]);
  });

  test("each scheduling class runs alone", async () => {
    const events: string[] = [];
    let ticks = 0;
    await driveTicks(
      scheduledStore([idle({ livenessDue: true }), idle({ tickDue: true })]),
      {
        once: async () => {
          events.push("tick");
          return summary(++ticks === 1 ? 1 : 0);
        },
      },
      {
        forever: false,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        watch: async () => {
          events.push("liveness");
        },
        cadence: {
          failureLabel: "cadence",
          run: async () => {
            events.push("cadence");
          },
        },
        sleep: async () => {},
      },
    );
    // The first tick is the established forever:false drain pass. Liveness can
    // then run without dragging cadence or another operation pass with it.
    expect(events).toEqual(["tick", "cadence", "liveness", "tick"]);
  });

  test("each idle interval is one schedule read that refreshes health", async () => {
    const reads = { count: 0 };
    const sleeps: number[] = [];
    let stopped = false;
    let healthy = 0;
    let now = 0;
    await driveTicks(
      scheduledStore([idle()], reads),
      { once: async () => summary(0) },
      {
        forever: true,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        onTick: () => healthy++,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
          if (sleeps.length === 3) stopped = true;
        },
        shouldStop: () => stopped,
      },
    );
    expect(reads.count).toBe(3);
    expect(healthy).toBe(3);
    expect(sleeps).toEqual([5_000, 60_000, 60_000]);
  });

  test("wake bypasses the timer and a wake during a pass re-arms it", async () => {
    const wake = new DriveWake();
    let ticks = 0;
    let stopped = false;
    await driveTicks(
      scheduledStore([idle(), idle(), idle()]),
      {
        once: async () => {
          ticks++;
          if (ticks === 2) wake.signal();
          if (ticks === 3) stopped = true;
          return summary(1);
        },
      },
      {
        forever: true,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        wake,
        sleep: async () => {
          wake.signal();
        },
        shouldStop: () => stopped,
      },
    );
    expect(ticks).toBe(3);
  });

  test("a stale due timestamp is still bounded by the five-second floor", async () => {
    const sleeps: number[] = [];
    let stopped = false;
    await driveTicks(
      scheduledStore([idle({ nextDueAt: -1 }), idle({ nextDueAt: -1 })]),
      { once: async () => summary(0) },
      {
        forever: true,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        now: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
          stopped = true;
        },
        shouldStop: () => stopped,
      },
    );
    expect(sleeps).toEqual([5_000]);
  });

  test("a due class that cannot clear itself still waits five seconds", async () => {
    let now = 0;
    let stopped = false;
    const cadenceStartedAt: number[] = [];
    await driveTicks(
      scheduledStore([idle({ cadenceDue: true, nextDueAt: -1 })]),
      { once: async () => summary(1) },
      {
        forever: true,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        now: () => now,
        cadence: {
          failureLabel: "cadence",
          run: async () => {
            cadenceStartedAt.push(now);
            if (cadenceStartedAt.length === 3) stopped = true;
          },
        },
        sleep: async (ms) => {
          now += ms;
        },
        shouldStop: () => stopped,
      },
    );
    expect(cadenceStartedAt).toEqual([0, 5_000, 10_000]);
  });
});
