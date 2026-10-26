import { describe, expect, it } from "bun:test";
import {
  RESTART_WAKE_BATCH,
  RESTART_WAKE_BOOT_DELAY_MS,
  RESTART_WAKE_INTERVAL_MS,
  planRestartWakes,
  restartWakeDelayMs,
} from "./restart-wake.ts";

describe("planRestartWakes", () => {
  it("wakes each live, resumable, not yet woken agent, oldest turn first, and names why each other entry is dropped", () => {
    const plan = planRestartWakes(
      {
        late: { since: 300 },
        early: { since: 100 },
        middle: { since: 200 },
        gone: { since: 1 },
        woken: { since: 2, restartWake: true },
        blank: { since: 3 },
        notObject: "x",
        nullEntry: null,
        badSince: { since: "1" },
        nanSince: { since: Number.NaN },
      },
      {
        exists: (id) => id !== "gone",
        resumable: (id) => id !== "blank",
      },
    );
    expect(plan.wake).toEqual(["early", "middle", "late"]);
    const drop = [...plan.drop].sort((a, b) =>
      a.agentId.localeCompare(b.agentId),
    );
    expect(drop).toEqual([
      { agentId: "badSince", reason: "malformed" },
      { agentId: "blank", reason: "no conversation" },
      { agentId: "gone", reason: "agent gone" },
      { agentId: "nanSince", reason: "malformed" },
      { agentId: "notObject", reason: "malformed" },
      { agentId: "nullEntry", reason: "malformed" },
      { agentId: "woken", reason: "already woken" },
    ]);
  });

  it("an empty record plans nothing", () => {
    expect(
      planRestartWakes({}, { exists: () => true, resumable: () => true }),
    ).toEqual({ wake: [], drop: [] });
  });
});

describe("restartWakeDelayMs", () => {
  it("sends the wakes a batch at a time: the first batch after the boot delay, each next one an interval later", () => {
    const delays = Array.from({ length: 2 * RESTART_WAKE_BATCH + 1 }, (_, i) =>
      restartWakeDelayMs(i),
    );
    const batch = (n: number) =>
      Array<number>(RESTART_WAKE_BATCH).fill(
        RESTART_WAKE_BOOT_DELAY_MS + n * RESTART_WAKE_INTERVAL_MS,
      );
    expect(delays).toEqual([...batch(0), ...batch(1), batch(2)[0]]);
  });
});
