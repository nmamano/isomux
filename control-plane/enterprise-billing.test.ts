// The enterprise contract calendar and the seat change quotes (Nil's billing
// rules, task 71718489): contract months clamp to the month's last day, the
// month a seat is added in counts, a quarter and a year roll over from the
// contract start. Pure: no database.
//
// The account's rules that call these (who may change N, and when) are in
// enterprise.test.ts.

import { describe, expect, test } from "bun:test";
import {
  addContractMonths,
  contractMonthIndex,
  contractQuarterEnd,
  monthsLeftInYear,
  periodTotalUsd,
  quoteSeatChange,
  renewalDate,
} from "./enterprise-billing.ts";

const at = (iso: string) => Date.parse(iso);
/** A start on the 31st: every short month clamps, and 2028 is a leap year. */
const END = at("2027-01-31T10:00:00Z");
/** A start mid-month, for the cases where no clamp is involved. */
const MID = at("2027-01-15T00:00:00Z");

describe("contract months", () => {
  test("move by whole months from the start, the day clamped and the time kept", () => {
    expect(
      [0, 1, 2, 3, 12, 13].map((n) =>
        new Date(addContractMonths(END, n)).toISOString(),
      ),
    ).toEqual([
      "2027-01-31T10:00:00.000Z",
      "2027-02-28T10:00:00.000Z",
      // Clamped from the start, not from the clamped month before it.
      "2027-03-31T10:00:00.000Z",
      "2027-04-30T10:00:00.000Z",
      "2028-01-31T10:00:00.000Z",
      "2028-02-29T10:00:00.000Z",
    ]);
  });

  test("a month starts at its boundary, not a millisecond earlier", () => {
    const feb = at("2027-02-28T10:00:00Z");
    const renewal = at("2028-01-31T10:00:00Z");
    expect([
      contractMonthIndex(END, END),
      contractMonthIndex(END, feb - 1),
      contractMonthIndex(END, feb),
      contractMonthIndex(END, renewal - 1),
      contractMonthIndex(END, renewal),
    ]).toEqual([0, 0, 1, 11, 12]);
  });

  test("months left count the current month: 12 in the first, 1 in the last, 12 again after renewal", () => {
    expect([
      monthsLeftInYear(END, END),
      monthsLeftInYear(END, at("2027-05-01T00:00:00Z")),
      monthsLeftInYear(END, at("2028-01-31T09:59:59Z")),
      monthsLeftInYear(END, at("2028-01-31T10:00:00Z")),
    ]).toEqual([12, 9, 1, 12]);
  });

  test("a quarter ends three contract months after its start, in every contract year", () => {
    const iso = (now: string) =>
      new Date(contractQuarterEnd(END, at(now))).toISOString();
    expect([
      iso("2027-01-31T10:00:00Z"),
      iso("2027-04-30T09:59:59Z"),
      iso("2027-04-30T10:00:00Z"),
      iso("2027-12-01T00:00:00Z"),
      iso("2028-02-01T00:00:00Z"),
    ]).toEqual([
      "2027-04-30T10:00:00.000Z",
      "2027-04-30T10:00:00.000Z",
      "2027-07-31T10:00:00.000Z",
      // The last quarter ends at the renewal.
      "2028-01-31T10:00:00.000Z",
      "2028-04-30T10:00:00.000Z",
    ]);
  });

  test("the renewal is the end of the contract year now falls in", () => {
    const iso = (now: string) =>
      new Date(renewalDate(END, at(now))).toISOString();
    expect([
      iso("2027-01-31T10:00:00Z"),
      iso("2028-01-31T09:59:59Z"),
      iso("2028-01-31T10:00:00Z"),
    ]).toEqual([
      "2028-01-31T10:00:00.000Z",
      "2028-01-31T10:00:00.000Z",
      "2029-01-31T10:00:00.000Z",
    ]);
  });
});

describe("prices", () => {
  test("one period of N seats: $25 a month, $240 a year", () => {
    expect([
      periodTotalUsd("monthly", 50),
      periodTotalUsd("yearly", 50),
      periodTotalUsd("monthly", 1),
    ]).toEqual([1250, 12000, 25]);
  });

  test("monthly: the quote is the month at the new N, and a lowering is flagged", () => {
    const now = at("2027-03-03T00:00:00Z");
    expect(quoteSeatChange("monthly", MID, now, 50, 60)).toEqual({
      plan: "monthly",
      from: 50,
      to: 60,
      monthTotalUsd: 1500,
      lowering: false,
    });
    // This month's invoice still counts the highest N (50): no refund.
    expect(quoteSeatChange("monthly", MID, now, 50, 40)).toEqual({
      plan: "monthly",
      from: 50,
      to: 40,
      monthTotalUsd: 1000,
      lowering: true,
    });
  });

  test("yearly: added seats x $20 x months left, the month of the add counted, invoiced at the quarter's end", () => {
    // Contract month 3 (Apr 15 - May 15): 9 months left, quarter 2 ends Jul 15.
    expect(
      quoteSeatChange("yearly", MID, at("2027-04-20T00:00:00Z"), 50, 60),
    ).toEqual({
      plan: "yearly",
      from: 50,
      to: 60,
      added: 10,
      monthsLeft: 9,
      amountUsd: 1800,
      invoicedAt: at("2027-07-15T00:00:00Z"),
    });
    // The last contract month: one month, invoiced at the renewal.
    expect(
      quoteSeatChange("yearly", MID, at("2027-12-20T00:00:00Z"), 50, 51),
    ).toEqual({
      plan: "yearly",
      from: 50,
      to: 51,
      added: 1,
      monthsLeft: 1,
      amountUsd: 20,
      invoicedAt: at("2028-01-15T00:00:00Z"),
    });
  });
});
