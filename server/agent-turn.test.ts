// Tests for the strip-side of the outbound envelope wrap. The wrap itself is
// applied in `runAgentTurn` (see agent-turn.ts); these tests anchor
// the inverse operation so edit-message matching stays in sync with the
// wrap format if it ever changes.
//
// Regression for: a turn that carried a built-in context-fullness notice
// (task 50392514) got
// recorded into the SDK transcript as
// `--- begin isomux: <id> ---\n...\n--- end isomux: <id> ---\n\nUser message:\n<sdkText>`,
// but the isomux log entry only carried `<sdkText>`; agent-manager's editMessage
// matcher used strict equality and therefore failed every edit on such a turn
// with "Cannot edit: could not locate message in backend session."

import { describe, expect, it } from "bun:test";

import {
  MEMORY_NOTICE_FILL_RATIO,
  formatContextNotice,
  formatMemoryNotice,
  markContextThresholdFired,
  pickContextThreshold,
  stripOutboundEnvelope,
} from "./agent-turn.ts";
import type { ManagedAgent } from "./internal-types.ts";
import type { ContextUsageSnapshot } from "./internal-types.ts";

describe("stripOutboundEnvelope", () => {
  it("returns text unchanged when no envelope wrap is present", () => {
    expect(stripOutboundEnvelope("[Nil] hello world")).toBe(
      "[Nil] hello world",
    );
    expect(stripOutboundEnvelope("")).toBe("");
  });

  it("strips a built-in-only (isomux context-check) wrap", () => {
    // A turn where the context-fullness notice fired.
    const sdkText = "[Nil] keep going";
    const wrapped =
      "--- begin isomux: context-check ---\n" +
      "[context check: 87% full - 174,000 / 200,000 tokens. Wrap up: finish or hand off current work; tell the boss a /clear is advisable.]\n" +
      "--- end isomux: context-check ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripOutboundEnvelope(wrapped)).toBe(sdkText);
  });

  it("strips multiple built-in blocks joined by a blank line", () => {
    const sdkText = "[Nil] proceed";
    const wrapped =
      "--- begin isomux: wake-notice ---\n" +
      "The previous session ended unexpectedly.\n" +
      "--- end isomux: wake-notice ---\n\n" +
      "--- begin isomux: context-check ---\n" +
      "[context check: 68% full - 136,000 / 200,000 tokens. Budget accordingly.]\n" +
      "--- end isomux: context-check ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripOutboundEnvelope(wrapped)).toBe(sdkText);
  });

  it("does not split on a literal '\\n\\nUser message:\\n' that appears inside the user's own text", () => {
    // User text itself contains the separator AFTER a non-`---` line.
    // The strip must anchor on the structural `--- end isomux: <id> ---`
    // boundary, not just any occurrence of the separator.
    const sdkText =
      "[Nil] I want to talk about\n\nUser message:\nthis literal block";
    const wrapped =
      "--- begin isomux: context-check ---\nfact\n--- end isomux: context-check ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripOutboundEnvelope(wrapped)).toBe(sdkText);
  });

  it("does not split when a block body ends with '---' but isn't a real closing line", () => {
    // A block body that ends with
    // `---` and is followed by `\n\nUser message:\n` shouldn't fool the
    // matcher - only the real `--- end isomux: <id> ---` line counts.
    const sdkText = "[Nil] real payload";
    const wrapped =
      "--- begin isomux: context-check ---\n" +
      // Prefix body whose last line is exactly `---` (three dashes).
      "ascii art divider:\n---\n" +
      // The real closing line.
      "--- end isomux: context-check ---\n\n" +
      "User message:\n" +
      sdkText;
    expect(stripOutboundEnvelope(wrapped)).toBe(sdkText);
  });

  it("returns text unchanged when it starts with the wrap marker but lacks the separator", () => {
    // Defensive: a corrupt or partial wrap should not silently truncate.
    const malformedBuiltin =
      "--- begin isomux: context-check ---\nbody\n--- end isomux: context-check ---";
    expect(stripOutboundEnvelope(malformedBuiltin)).toBe(malformedBuiltin);
  });

  it("does not strip when text doesn't start with an envelope marker, even if separator appears inside", () => {
    // A regular user message that happens to contain the separator pattern
    // is not a wrap. The startsWith guard prevents false-positive stripping.
    const sneaky =
      "[Nil] my code prints `--- end isomux: context-check ---\n\nUser message:\nbar`";
    expect(stripOutboundEnvelope(sneaky)).toBe(sneaky);
  });
});

// ---------------------------------------------------------------------------
// Context-fullness notice logic (task 50392514)
// ---------------------------------------------------------------------------

function snap(percentage: number, maxTokens = 200000): ContextUsageSnapshot {
  return {
    model: "claude-x",
    totalTokens: Math.round((percentage / 100) * maxTokens),
    maxTokens,
    percentage,
    sampledAtMs: 0,
    source: "turn_completed",
  };
}

// A window large enough for every band, including the size-gated 50 one
// (task 73a23f7c: bands with minWindowTokens skip smaller windows).
const LARGE_WINDOW = 1_000_000;

// The functions under test only read contextUsage + firedAgentThresholds; a
// minimal shim keeps the test from constructing a whole ManagedAgent.
function fakeManaged(
  contextUsage: ContextUsageSnapshot | null,
  fired: number[] = [],
): ManagedAgent {
  return {
    contextUsage,
    firedAgentThresholds: new Set(fired),
  } as unknown as ManagedAgent;
}

describe("pickContextThreshold", () => {
  it("returns null with no snapshot", () => {
    expect(pickContextThreshold(fakeManaged(null))).toBeNull();
  });

  it("returns null below the lowest threshold", () => {
    expect(
      pickContextThreshold(fakeManaged(snap(49.9, LARGE_WINDOW))),
    ).toBeNull();
  });

  it("returns 50 in the 50–74 band on a large window", () => {
    expect(pickContextThreshold(fakeManaged(snap(50, LARGE_WINDOW)))).toBe(50);
    expect(pickContextThreshold(fakeManaged(snap(74.9, LARGE_WINDOW)))).toBe(
      50,
    );
  });

  it("returns the HIGHEST newly-reached band when a first sample clears several", () => {
    // Lands at 90% with nothing fired yet - only the 75 notice should emit.
    expect(pickContextThreshold(fakeManaged(snap(90, LARGE_WINDOW)))).toBe(75);
  });

  it("returns 75 once 50 has already fired", () => {
    expect(
      pickContextThreshold(fakeManaged(snap(90, LARGE_WINDOW), [50])),
    ).toBe(75);
  });

  it("returns null once every reached band has fired", () => {
    expect(
      pickContextThreshold(fakeManaged(snap(90, LARGE_WINDOW), [50, 75])),
    ).toBeNull();
    expect(
      pickContextThreshold(fakeManaged(snap(70, LARGE_WINDOW), [50])),
    ).toBeNull();
  });

  // Task 73a23f7c: the 50 band is size-gated - a small window (e.g. Codex's
  // ~250k, Sonnet's 200k) skips the early warning but keeps the 75 wrap-up.
  describe("small windows skip the size-gated 50 band", () => {
    it("returns null in the 50–74 band on a small window", () => {
      expect(pickContextThreshold(fakeManaged(snap(55, 250_000)))).toBeNull();
      expect(pickContextThreshold(fakeManaged(snap(74.9, 250_000)))).toBeNull();
    });

    it("still returns 75 on a small window", () => {
      expect(pickContextThreshold(fakeManaged(snap(75, 250_000)))).toBe(75);
      expect(pickContextThreshold(fakeManaged(snap(90, 250_000)))).toBe(75);
    });

    it("applies the gate at exactly minWindowTokens (inclusive)", () => {
      expect(pickContextThreshold(fakeManaged(snap(55, 500_000)))).toBe(50);
      expect(pickContextThreshold(fakeManaged(snap(55, 499_999)))).toBeNull();
    });
  });
});

describe("markContextThresholdFired", () => {
  it("marks the given threshold and every lower one", () => {
    const m = fakeManaged(snap(90));
    markContextThresholdFired(m, 75);
    // Both 50 and 75 are consumed so neither re-fires on a later turn.
    expect(m.firedAgentThresholds.has(50)).toBe(true);
    expect(m.firedAgentThresholds.has(75)).toBe(true);
    expect(pickContextThreshold(m)).toBeNull();
  });

  it("marking 50 leaves 75 available", () => {
    const m = fakeManaged(snap(90));
    markContextThresholdFired(m, 50);
    expect(m.firedAgentThresholds.has(50)).toBe(true);
    expect(m.firedAgentThresholds.has(75)).toBe(false);
    expect(pickContextThreshold(m)).toBe(75);
  });
});

describe("formatContextNotice", () => {
  it("formats the 50 band with a plain hyphen, comma grouping, and rounded pct", () => {
    // 68% of 200k = 136,000. No em dash (Nil's prose rule); spaced hyphen.
    const line = formatContextNotice(50, snap(68));
    expect(line).toBe(
      "[context check: 68% full - 136,000 / 200,000 tokens. Budget accordingly.]",
    );
    expect(line).not.toContain("—"); // em dash
  });

  it("formats the 75 band with wrap-up advice", () => {
    const line = formatContextNotice(75, snap(87));
    expect(line).toBe(
      "[context check: 87% full - 174,000 / 200,000 tokens. Wrap up: finish or hand off current work; tell the boss a /clear is advisable.]",
    );
  });

  it("rounds the displayed percentage from the raw float", () => {
    expect(formatContextNotice(50, snap(50.4))).toContain("50% full");
    expect(formatContextNotice(75, snap(75.6))).toContain("76% full");
  });
});

describe("formatMemoryNotice (task f1a08f05)", () => {
  const scope = (label: string, fill: number) => ({
    label,
    contentChars: Math.round(3500 * fill),
    cap: 3500,
  });

  it("says nothing when every scope is under the ratio", () => {
    expect(formatMemoryNotice([])).toBeNull();
    expect(
      formatMemoryNotice([
        scope("Office-wide", 0.5),
        scope("Your agent", 0.79),
      ]),
    ).toBeNull();
  });

  it("fires exactly at the ratio", () => {
    expect(
      formatMemoryNotice([scope("Office-wide", MEMORY_NOTICE_FILL_RATIO)]),
    ).toBe(
      "[memory check: auto-loaded memory is close to its size cap - Office-wide at 80% of its cap. " +
        "Caps are hard: a save that would put a scope over its cap is refused. " +
        "Offer the boss specific trims, applying them through the memory READ + PUT API after approval. " +
        "Let the boss know they can also edit memory in Settings.]",
    );
  });

  it("names only the over-ratio scopes, fullest first", () => {
    const line = formatMemoryNotice([
      scope("Office-wide", 0.2),
      scope('Room "Isomux Dev"', 0.9),
      scope('Boss "Nil"', 1.18),
      scope("Your agent", 0.4),
    ])!;
    expect(line).toContain(
      'Boss "Nil" at 118% (at or over its cap; saves to it fail until it is trimmed), Room "Isomux Dev" at 90% of its cap.',
    );
    expect(line).not.toContain("Office-wide");
    expect(line).not.toContain("Your agent");
  });

  it("uses a spaced hyphen, never an em dash (Nil's prose rule)", () => {
    expect(formatMemoryNotice([scope("Office-wide", 1.5)])).not.toContain(
      "\u2014",
    );
  });
});
