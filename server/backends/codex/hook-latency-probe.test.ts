import { describe, expect, it } from "bun:test";
import { distribution } from "./hook-latency-probe.ts";

describe("Codex hook latency fixture (no coverage claim)", () => {
  it("reports nearest-rank percentiles", () => {
    expect(distribution([5, 1, 4, 2, 3], 2)).toEqual({
      n: 5,
      concurrency: 2,
      p50Ms: 3,
      p95Ms: 5,
      p99Ms: 5,
      maxMs: 5,
    });
  });
});
