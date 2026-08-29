import { describe, expect, it } from "bun:test";
import { runPolicyCurveProbe } from "./hook-policy-curve-probe.ts";

describe("Codex hook policy curve probe", () => {
  it("measures the live policy and a scratch ambiguity-removed arm", async () => {
    const result = await runPolicyCurveProbe();
    expect(result.controls.allow.decision).toBe("allow");
    expect(result.controls.deny.decision).toBe("deny");
    expect(result.alternativeMutation.replacements).toBe(14);
    expect(result.alternativeMutation.productionTreeChanged).toBe(false);
    expect(
      result.curve.every((reading) => reading.current.decision === "deny"),
    ).toBe(true);
    expect(
      result.curve.every(
        (reading) => reading.ambiguityRemoved.decision === "deny",
      ),
    ).toBe(true);
    expect(result.capCost.some((cost) => cost.denyToAllowCount > 0)).toBe(true);
  }, 30_000);
});
