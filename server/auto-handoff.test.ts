// The pure parts of the automatic handoff: the trigger and each engine's
// compaction point. The state machine is covered in
// test-support/auto-handoff.test.ts.

import { describe, it, expect } from "bun:test";
import {
  autoHandoffMeasureParams,
  autoHandoffTrigger,
  joinBriefChunks,
} from "./auto-handoff.ts";
import { openCodeAutoCompactTokens } from "./backends/opencode/adapter.ts";

describe("autoHandoffTrigger", () => {
  it("is 85% of a window under 588k", () => {
    expect(autoHandoffTrigger({ maxTokens: 200_000 })).toEqual({
      tokens: 170_000,
      measure: "percent",
      maxTokens: 200_000,
    });
  });

  it("is 500k tokens on a larger window", () => {
    expect(autoHandoffTrigger({ maxTokens: 1_000_000 })).toEqual({
      tokens: 500_000,
      measure: "tokens",
      maxTokens: 1_000_000,
    });
  });

  it("moves 5 points of the window ahead of an earlier compaction point", () => {
    expect(
      autoHandoffTrigger({ maxTokens: 200_000, compactAtTokens: 167_000 }),
    ).toMatchObject({ tokens: 157_000, measure: "compaction" });
  });

  it("ignores a compaction point past the other limits", () => {
    expect(
      autoHandoffTrigger({ maxTokens: 1_000_000, compactAtTokens: 967_000 }),
    ).toMatchObject({ tokens: 500_000, measure: "tokens" });
    expect(
      autoHandoffTrigger({ maxTokens: 200_000, compactAtTokens: 199_000 }),
    ).toMatchObject({ tokens: 170_000, measure: "percent" });
  });

  it("reports the earlier limit on a tie: tokens, then percent, then compaction", () => {
    // The guard ties the 500k limit on a 1M window.
    expect(
      autoHandoffTrigger({ maxTokens: 1_000_000, compactAtTokens: 550_000 }),
    ).toMatchObject({ tokens: 500_000, measure: "tokens" });
    // The guard ties the 85% limit on a 200k window.
    expect(
      autoHandoffTrigger({ maxTokens: 200_000, compactAtTokens: 180_000 }),
    ).toMatchObject({ tokens: 170_000, measure: "percent" });
  });

  it("names the limit that fired, not the measured value", () => {
    expect(
      autoHandoffMeasureParams(autoHandoffTrigger({ maxTokens: 1_000_000 })),
    ).toEqual({ thousands: 500, percent: 50 });
    expect(
      autoHandoffMeasureParams(
        autoHandoffTrigger({ maxTokens: 200_000, compactAtTokens: 160_000 }),
      ),
    ).toEqual({ thousands: 150, percent: 75 });
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

describe("joinBriefChunks", () => {
  it("joins OpenCode deltas with nothing and whole blocks with a blank line", () => {
    expect(joinBriefChunks("opencode", ["Fin", "ish step 4."])).toBe(
      "Finish step 4.",
    );
    expect(joinBriefChunks("claude", ["Goal.", "Next."])).toBe(
      "Goal.\n\nNext.",
    );
  });
});
