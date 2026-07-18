// The context battery's color band is computed from the RAW float percentage
// and MUST match the server-injected [context check] notice thresholds
// (50 / 75, per Nil 2026-07-18) — the icon and the notices have to agree.
// This freezes the boundary behavior; the popover/DOM lifecycle isn't covered
// because the UI has no React render harness (no jsdom/testing-library).
import { describe, it, expect } from "bun:test";
import { bandColor } from "./ContextBattery.tsx";

describe("ContextBattery bandColor", () => {
  it("dim below 50, orange in [50,75), red at/above 75 (boundaries on the raw float)", () => {
    expect(bandColor(0)).toBe("var(--text-muted)");
    expect(bandColor(49.9)).toBe("var(--text-muted)");
    expect(bandColor(50)).toBe("var(--orange)");
    expect(bandColor(74.9)).toBe("var(--orange)");
    expect(bandColor(75)).toBe("var(--red)");
    expect(bandColor(100)).toBe("var(--red)");
  });
});
