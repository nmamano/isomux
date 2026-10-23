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
  const block = (id: string, body: string) =>
    `--- begin isomux: ${id} ---\n${body}\n--- end isomux: ${id} ---`;

  // [case, recorded text, the sdkText it must give back]
  it.each([
    [
      "a built-in-only (context-check) wrap",
      `${block("context-check", "[context check: 87% full]")}\n\nUser message:\n[Nil] keep going`,
      "[Nil] keep going",
    ],
    [
      "several built-in blocks joined by a blank line",
      `${block("wake-notice", "ended unexpectedly")}\n\n${block("context-check", "fact")}\n\nUser message:\n[Nil] proceed`,
      "[Nil] proceed",
    ],
    // The strip anchors on the structural `--- end isomux: <id> ---` line, not
    // on any occurrence of the separator in the user's own text.
    [
      "user text that itself contains the separator",
      `${block("context-check", "fact")}\n\nUser message:\n[Nil] I want to talk about\n\nUser message:\nthis literal block`,
      "[Nil] I want to talk about\n\nUser message:\nthis literal block",
    ],
    // Only the real closing line counts, not a body line of three dashes.
    [
      "a block body whose last line is ---",
      `${block("context-check", "ascii art divider:\n---")}\n\nUser message:\n[Nil] real payload`,
      "[Nil] real payload",
    ],
  ])("strips %s", (_case, recorded, sdkText) => {
    expect(stripOutboundEnvelope(recorded)).toBe(sdkText);
  });

  it.each([
    ["plain text", "[Nil] hello world"],
    ["empty text", ""],
    // A corrupt or partial wrap must not silently truncate.
    ["a wrap with no separator", block("context-check", "body")],
    // The startsWith guard: a separator inside a regular message is not a wrap.
    [
      "a message that only contains a wrap",
      "[Nil] my code prints `--- end isomux: context-check ---\n\nUser message:\nbar`",
    ],
  ])("returns %s unchanged", (_case, text) => {
    expect(stripOutboundEnvelope(text)).toBe(text);
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
  // [case, percentage, window, already fired, expected band]
  it.each([
    ["below the lowest band", 49.9, LARGE_WINDOW, [], null],
    ["at the bottom of the 50 band", 50, LARGE_WINDOW, [], 50],
    ["at the top of the 50 band", 74.9, LARGE_WINDOW, [], 50],
    // A first sample that clears several bands emits only the highest.
    ["past both bands with none fired", 90, LARGE_WINDOW, [], 75],
    ["past both bands with 50 fired", 90, LARGE_WINDOW, [50], 75],
    ["past both bands with both fired", 90, LARGE_WINDOW, [50, 75], null],
    ["in the 50 band with 50 fired", 70, LARGE_WINDOW, [50], null],
    // Task 73a23f7c: the 50 band is size-gated - a small window (e.g. Codex's
    // ~250k) skips the early warning but keeps the 75 wrap-up.
    ["in the 50 band on a small window", 74.9, 250_000, [], null],
    ["past 75 on a small window", 90, 250_000, [], 75],
    ["in the 50 band at exactly minWindowTokens", 55, 500_000, [], 50],
    ["in the 50 band one token under minWindowTokens", 55, 499_999, [], null],
  ] as const)("%s", (_case, pct, window, fired, expected) => {
    const managed = fakeManaged(snap(pct, window), [...fired]);
    expect(pickContextThreshold(managed)).toBe(expected);
  });
});

describe("markContextThresholdFired", () => {
  it("marks the given band and every lower one, never a higher one", () => {
    const low = fakeManaged(snap(90, LARGE_WINDOW));
    markContextThresholdFired(low, 50);
    expect([...low.firedAgentThresholds]).toEqual([50]);
    expect(pickContextThreshold(low)).toBe(75);
    // Both 50 and 75 are consumed so neither re-fires on a later turn.
    const high = fakeManaged(snap(90, LARGE_WINDOW));
    markContextThresholdFired(high, 75);
    expect([...high.firedAgentThresholds].sort()).toEqual([50, 75]);
    expect(pickContextThreshold(high)).toBeNull();
  });
});

describe("formatContextNotice", () => {
  it("states the rounded percentage and comma-grouped counts, with wrap-up advice only at 75", () => {
    // 68% of 200k = 136,000.
    const fifty = formatContextNotice(50, snap(68));
    expect(fifty).toContain("68%");
    expect(fifty).toContain("136,000");
    expect(fifty).toContain("200,000");
    expect(formatContextNotice(50, snap(50.4))).toContain("50%");
    expect(formatContextNotice(75, snap(75.6))).toContain("76%");
    // Same snapshot, other band: only the advice differs.
    expect(formatContextNotice(75, snap(68))).not.toBe(fifty);
    expect(formatContextNotice(75, snap(68))).toContain("136,000");
  });
});

describe("formatMemoryNotice (task f1a08f05)", () => {
  const scope = (label: string, fill: number) => ({
    label,
    contentChars: Math.round(3500 * fill),
    cap: 3500,
  });

  it("says nothing when every scope is under the ratio, and fires exactly at it", () => {
    expect(formatMemoryNotice([])).toBeNull();
    expect(
      formatMemoryNotice([
        scope("Office-wide", 0.5),
        scope("Your agent", 0.79),
      ]),
    ).toBeNull();
    const atRatio = formatMemoryNotice([
      scope("Office-wide", MEMORY_NOTICE_FILL_RATIO),
    ]);
    expect(atRatio).toContain("Office-wide");
    expect(atRatio).toContain("80%");
  });

  it("names only the over-ratio scopes, fullest first", () => {
    const line = formatMemoryNotice([
      scope("Office-wide", 0.2),
      scope('Room "Isomux Dev"', 0.9),
      scope('Member "Nil"', 1.18),
      scope("Your agent", 0.4),
    ])!;
    expect(line).toContain("118%");
    expect(line).toContain("90%");
    const member = line.indexOf('Member "Nil"');
    expect(member).toBeGreaterThan(-1);
    expect(line.indexOf('Room "Isomux Dev"')).toBeGreaterThan(member);
    expect(line).not.toContain("Office-wide");
    expect(line).not.toContain("Your agent");
  });
});
