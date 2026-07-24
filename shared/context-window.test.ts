// Authoritative context-window table and the correction applied to every
// backend fullness reading (task c6085ddf). Pure functions, zero I/O.
//
// What this freezes:
//   - a model we know overrides the backend's window AND recomputes the
//     percentage against it (keeping the backend's percentage was the bug:
//     it was derived from the stale 200k)
//   - a model we don't know passes through untouched, so a future model
//     degrades to backend behavior rather than to a wrong number
//   - every model a family can be pointed at has a table entry -- the guard
//     that would have caught the original regression at build time

import { describe, it, expect } from "bun:test";
import {
  MODEL_CONTEXT_WINDOW,
  correctContextWindow,
} from "./context-window.ts";
import { FAMILY_TO_MODEL } from "./types.ts";

// The reading Opus 5 produced on the pinned SDK: a real 260k-token
// conversation measured against the SDK's stale 200k default.
const staleOpus5 = {
  model: "claude-opus-5",
  totalTokens: 260_854,
  maxTokens: 200_000,
  percentage: 130.427,
};

describe("correctContextWindow", () => {
  it("overrides a known model's window with the authoritative value", () => {
    expect(correctContextWindow(staleOpus5).maxTokens).toBe(1_000_000);
  });

  it("recomputes the percentage against the corrected window", () => {
    // 260,854 / 1M -- not the backend's 130.427, which was measured against
    // the stale maximum.
    expect(correctContextWindow(staleOpus5).percentage).toBeCloseTo(26.0854, 4);
  });

  it("turns an over-100% reading into a sane one", () => {
    expect(correctContextWindow(staleOpus5).percentage).toBeLessThan(100);
  });

  it("leaves totalTokens and model alone", () => {
    const out = correctContextWindow(staleOpus5);
    expect(out.totalTokens).toBe(260_854);
    expect(out.model).toBe("claude-opus-5");
  });

  it("preserves unrelated fields of the caller's shape", () => {
    const out = correctContextWindow({
      ...staleOpus5,
      categories: [{ name: "Messages", tokens: 260_854 }],
      autoCompactThreshold: 184_000,
    });
    expect(out.categories).toEqual([{ name: "Messages", tokens: 260_854 }]);
    expect(out.autoCompactThreshold).toBe(184_000);
  });

  it("passes an unknown model through untouched, same object", () => {
    const unknown = {
      model: "claude-opus-9",
      totalTokens: 100_000,
      maxTokens: 200_000,
      percentage: 50,
    };
    expect(correctContextWindow(unknown)).toBe(unknown);
  });

  it("passes Codex-style display labels through untouched", () => {
    const codex = {
      model: "GPT-5.6 Sol",
      totalTokens: 90_000,
      maxTokens: 272_000,
      percentage: 33.08,
    };
    expect(correctContextWindow(codex)).toBe(codex);
  });

  it("is a no-op when the backend already agrees", () => {
    const agreed = {
      model: "claude-haiku-4-5-20251001",
      totalTokens: 50_000,
      maxTokens: 200_000,
      percentage: 25,
    };
    expect(correctContextWindow(agreed)).toBe(agreed);
  });

  it("corrects downward too, not just upward", () => {
    // A backend over-reporting the window is the same class of bug; the
    // correction is "use ours", not "use the larger one".
    const inflated = {
      model: "claude-haiku-4-5",
      totalTokens: 100_000,
      maxTokens: 1_000_000,
      percentage: 10,
    };
    const out = correctContextWindow(inflated);
    expect(out.maxTokens).toBe(200_000);
    expect(out.percentage).toBeCloseTo(50, 6);
  });
});

describe("MODEL_CONTEXT_WINDOW", () => {
  // The regression guard: repointing a family at a model the table doesn't
  // know is exactly how the readings broke, and it is invisible at runtime
  // (the reading silently falls back to the backend's stale number).
  it("covers every model a family can be pointed at", () => {
    for (const [family, model] of Object.entries(FAMILY_TO_MODEL)) {
      expect(
        `${family}:${model}:${MODEL_CONTEXT_WINDOW[model] ?? "MISSING"}`,
      ).not.toContain("MISSING");
    }
  });

  it("holds only positive windows", () => {
    for (const [model, window] of Object.entries(MODEL_CONTEXT_WINDOW)) {
      expect(`${model}:${window !== undefined && window > 0}`).toBe(
        `${model}:true`,
      );
    }
  });
});
