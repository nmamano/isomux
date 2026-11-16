// The pure parts of the automatic handoff: the trigger and OpenCode's
// compaction point. The state machine, the brief capture and the limit the
// member's lines name are covered in test-support/auto-handoff.test.ts.

import { describe, it, expect } from "bun:test";
import { autoHandoffTrigger } from "./auto-handoff.ts";
import { openCodeAutoCompactTokens } from "./backends/opencode/adapter.ts";

describe("autoHandoffTrigger", () => {
  const M = 1_000_000;
  const K200 = 200_000;
  // [case, window and compaction point, the agent's own token value, trigger]
  it.each([
    [
      "is 85% of a window under 588k",
      { maxTokens: K200 },
      undefined,
      { tokens: 170_000, measure: "percent" },
    ],
    [
      "is 500k tokens on a larger window",
      { maxTokens: M },
      undefined,
      { tokens: 500_000, measure: "tokens" },
    ],
    // The compaction guard: compactAt less a margin of 5 points of the
    // window or 40k, whichever is larger, capped at half of compactAt.
    // 40k: Claude on a 200k window compacts at about 167k.
    [
      "moves 40k ahead of the compaction point on a 200k window",
      { maxTokens: K200, compactAtTokens: 167_000 },
      undefined,
      { tokens: 127_000, measure: "compaction" },
    ],
    // 40k: OpenCode on a 128k window with a 32k output limit.
    [
      "moves 40k ahead of the compaction point on a 128k window",
      { maxTokens: 128_000, compactAtTokens: 96_000 },
      undefined,
      { tokens: 56_000, measure: "compaction" },
    ],
    // 5 points of a 1M window (50k) is larger than 40k.
    [
      "moves 5 points of a large window ahead of the compaction point",
      { maxTokens: M, compactAtTokens: 300_000 },
      undefined,
      { tokens: 250_000, measure: "compaction" },
    ],
    // 40k is more than half of 32k: the cap keeps the trigger above zero.
    [
      "caps the margin at half the compaction point on a small window",
      { maxTokens: 64_000, compactAtTokens: 32_000 },
      undefined,
      { tokens: 16_000, measure: "compaction" },
    ],
    // The cap applies to 5 points too: 50k is more than half of 60k.
    [
      "caps 5 points of a large window at half the compaction point",
      { maxTokens: M, compactAtTokens: 60_000 },
      undefined,
      { tokens: 30_000, measure: "compaction" },
    ],
    // Strict comparisons: on a tie the earlier limit is reported, in the
    // order tokens, then percent, then compaction.
    [
      "reports tokens when the compaction guard ties 500k",
      { maxTokens: M, compactAtTokens: 550_000 },
      undefined,
      { tokens: 500_000, measure: "tokens" },
    ],
    // 900k less 5 points (50k) is 850k, 85% of 1M.
    [
      "reports percent when the compaction guard ties 85%",
      { maxTokens: M, compactAtTokens: 900_000 },
      900_000,
      { tokens: 850_000, measure: "percent" },
    ],
    [
      "reports tokens when the agent's own value ties 85%",
      { maxTokens: K200 },
      170_000,
      { tokens: 170_000, measure: "tokens" },
    ],
    [
      "takes the agent's own value in place of 500k",
      { maxTokens: M },
      300_000,
      { tokens: 300_000, measure: "tokens" },
    ],
    [
      "takes the agent's own value above 500k, still under 85%",
      { maxTokens: M },
      700_000,
      { tokens: 700_000, measure: "tokens" },
    ],
    [
      "keeps 85% when the agent's own value is past it",
      { maxTokens: K200 },
      300_000,
      { tokens: 170_000, measure: "percent" },
    ],
    [
      "keeps the compaction guard when the agent's own value is past it",
      { maxTokens: M, compactAtTokens: 400_000 },
      450_000,
      { tokens: 350_000, measure: "compaction" },
    ],
  ] as const)("%s", (_case, snap, own, expected) => {
    expect(autoHandoffTrigger(snap, own)).toEqual({
      ...expected,
      maxTokens: snap.maxTokens,
    });
  });
});

describe("OpenCode compaction point", () => {
  it("OpenCode: the context limit less the capped output limit", () => {
    expect(
      openCodeAutoCompactTokens({ context: 200_000, output: 10_000 }),
    ).toBe(190_000);
    // Output limits cap at 32k; a missing one counts as 32k.
    expect(
      openCodeAutoCompactTokens({ context: 200_000, output: 64_000 }),
    ).toBe(168_000);
    expect(openCodeAutoCompactTokens({ context: 200_000 })).toBe(168_000);
  });

  it("OpenCode: an input limit less a buffer of at most 20k", () => {
    expect(
      openCodeAutoCompactTokens({
        context: 400_000,
        input: 272_000,
        output: 128_000,
      }),
    ).toBe(252_000);
    expect(
      openCodeAutoCompactTokens({
        context: 400_000,
        input: 272_000,
        output: 8_000,
      }),
    ).toBe(264_000);
  });
});
