// pickPrimaryWindow (task 965cc1e8): the pill's headline window is the one
// closest to its limit among the windows that limit the agent's own model.
// A per-model window (modelFamily set) is a candidate only for an agent of
// that family; a window with no modelFamily limits every model.

import { describe, it, expect } from "bun:test";
import { pickPrimaryWindow } from "./usage-readings.ts";
import type { SubscriptionWindowWire } from "../shared/types.ts";

function win(
  usedPercent: number,
  modelFamily?: string,
): SubscriptionWindowWire {
  return {
    label: modelFamily ? `Weekly (${modelFamily})` : "Weekly",
    shortLabel: "WK",
    usedPercent,
    resetsAtMs: null,
    ...(modelFamily ? { modelFamily } : {}),
  };
}

describe("pickPrimaryWindow", () => {
  // Weekly 20, 5-hour 10, Fable 88, Opus 30.
  const claude = [win(20), win(10), win(88, "fable"), win(30, "opus")];

  it("skips another model's window, and takes the agent's own model window", () => {
    // Opus: Fable (88) is out; Opus (30) beats Weekly (20).
    expect(pickPrimaryWindow(claude, "opus")).toBe(3);
    expect(pickPrimaryWindow(claude, "fable")).toBe(2);
    // No per-model window for Sonnet: the account windows only.
    expect(pickPrimaryWindow(claude, "sonnet")).toBe(0);
  });

  it("keeps ties on the earlier applicable window", () => {
    // Fable 50 sits between two tied windows and does not apply to opus.
    const tied = [win(10), win(50, "fable"), win(40), win(40, "opus")];
    expect(pickPrimaryWindow(tied, "opus")).toBe(2);
  });

  it("is the plain argmax when no window names a model", () => {
    // Codex windows have no modelFamily; its modelFamily is a model id.
    const codex = [win(12), win(64), win(64)];
    expect(pickPrimaryWindow(codex, "gpt-6.1-sol")).toBe(1);
  });

  it("falls back to the argmax over all when no window applies", () => {
    // Degenerate: every window is for another model.
    const others = [win(30, "fable"), win(70, "sonnet")];
    expect(pickPrimaryWindow(others, "opus")).toBe(1);
  });
});
