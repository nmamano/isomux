// Task 3e70b6d4: the card's week-passed tick and its row order. Task
// faf036ad: the held layout and the fold of one account's rows.

import { describe, expect, it } from "bun:test";
import {
  accountUsageOrder,
  accountUsageRowShape,
  foldAccountUsageRow,
  weekElapsedPercent,
} from "./account-usage.ts";
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

// Task faf036ad: a row is one line, so the held layout keeps only what moves
// the card's height: each row's section, its state, and whether it has an
// email line under the name.
describe("accountUsageRowShape", () => {
  it("is the row's state, whether it is an office row and whether it has an email; null while it loads", () => {
    const member: AccountUsageRowWire = {
      ...row("m", 20),
      owners: [{ kind: "member", username: "ana" }],
      accountLabel: "ana@example.test",
    };
    expect([
      accountUsageRowShape(row("o", 20), NOW),
      accountUsageRowShape(member, NOW),
      accountUsageRowShape(
        { ...member, accountLabel: null, state: "failed", windows: [] },
        NOW,
      ),
      accountUsageRowShape(row("l", null, "loading"), NOW),
    ]).toEqual([
      { state: "usage", office: true, email: false },
      { state: "usage", office: false, email: true },
      { state: "failed", office: false, email: false },
      null,
    ]);
  });
});

describe("foldAccountUsageRow", () => {
  // A member's sign-in on the office's account: the office row (no email for
  // a member) takes the member's row, which carries the email.
  it("keeps the host's place and id and takes the email from the row it folds in when the host has none", () => {
    const host: AccountUsageRowWire = { ...row("office", 20), identity: "t1" };
    const mine: AccountUsageRowWire = {
      ...row("mine", 20),
      identity: "t1",
      owners: [{ kind: "member", username: "ana" }],
      accountLabel: "shared@example.test",
      members: ["ana"],
    };
    const folded = foldAccountUsageRow(host, mine);
    expect({
      id: folded.id,
      accountLabel: folded.accountLabel,
      owners: folded.owners,
      members: folded.members,
    }).toEqual({
      id: "office",
      accountLabel: "shared@example.test",
      owners: [{ kind: "office" }, { kind: "member", username: "ana" }],
      members: ["ana"],
    });
    // A host with an email keeps it.
    expect(
      foldAccountUsageRow({ ...host, accountLabel: "host@example.test" }, mine)
        .accountLabel,
    ).toBe("host@example.test");
  });
});
