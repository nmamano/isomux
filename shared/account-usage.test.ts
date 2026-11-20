// Task 3e70b6d4: the card's week-passed tick and its row order.

import { describe, expect, it } from "bun:test";
import { accountUsageOrder, weekElapsedPercent } from "./account-usage.ts";
import type { AccountUsageRowWire } from "./contract-shapes.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("weekElapsedPercent", () => {
  it("is the share of the week before the reset that has passed, clamped, and null with no reset", () => {
    expect(
      [
        NOW + 7 * DAY,
        NOW + 3.5 * DAY,
        NOW + 0.7 * DAY,
        NOW,
        NOW - DAY,
        NOW + 8 * DAY,
        null,
      ].map((reset) => weekElapsedPercent(reset, NOW)),
    ).toEqual([0, 50, 90, 100, 100, 0, null]);
  });
});

function row(
  id: string,
  weeklyUsed: number | null,
  state: AccountUsageRowWire["state"] = "usage",
): AccountUsageRowWire {
  // Half the week has passed for every weekly window: headroom = 50 - used.
  const windows =
    weeklyUsed === null
      ? []
      : [
          { label: "5h", usedPercent: 99, resetsAtMs: NOW + 3600_000 },
          { label: "wk", usedPercent: weeklyUsed, resetsAtMs: NOW + 3.5 * DAY },
        ];
  return {
    id,
    provider: "claude",
    owners: [{ kind: "office" }],
    accountLabel: null,
    identity: null,
    members: [],
    state,
    plan: null,
    windows,
    weeklyIndex: weeklyUsed === null ? null : 1,
    observedAtMs: weeklyUsed === null ? null : NOW,
  };
}

describe("accountUsageOrder", () => {
  it("sorts by weekly headroom from the weekly window, puts rows with no weekly window last in their order, and leaves loading rows out", () => {
    const rows = [
      row("failed", null, "failed"),
      row("tight", 60),
      row("loading", null, "loading"),
      // A team plan: usage, but no account-wide weekly window.
      { ...row("team", null), windows: [row("x", 5).windows[0]!] },
      row("roomy", 10),
      row("none", null, "no_limit"),
      row("mid", 40),
    ];
    expect(accountUsageOrder([], rows, NOW)).toEqual([
      "roomy",
      "mid",
      "tight",
      "failed",
      "team",
      "none",
    ]);
  });

  it("keeps placed rows where they are and puts each new row in by headroom", () => {
    // mid goes between the placed rows by its headroom.
    expect(
      accountUsageOrder(
        ["roomy", "tight", "failed"],
        [
          row("roomy", 10),
          row("tight", 60),
          row("failed", null, "failed"),
          row("mid", 40),
        ],
        NOW,
      ),
    ).toEqual(["roomy", "mid", "tight", "failed"]);
    // tight was placed above roomy (its reading changed since): it stays,
    // and a new row with no weekly window goes last.
    expect(
      accountUsageOrder(
        ["tight", "roomy"],
        [row("roomy", 10), row("tight", 60), row("none", null, "no_limit")],
        NOW,
      ),
    ).toEqual(["tight", "roomy", "none"]);
    // A row placed before that is gone or loading again drops out; the
    // others keep their order.
    expect(
      accountUsageOrder(
        ["mid", "gone", "roomy"],
        [row("roomy", 10), row("mid", 40), row("new", 0)],
        NOW,
      ).filter((id) => id !== "new"),
    ).toEqual(["mid", "roomy"]);
  });
});
