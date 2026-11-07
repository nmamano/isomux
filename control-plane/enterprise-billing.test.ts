// The enterprise contract calendar and the seat change quotes (Nil's billing
// rules, task 71718489): contract months clamp to the month's last day, the
// month a seat is added in counts, a quarter and a year roll over from the
// contract start. S4: the billing periods, what each one bills, and the next
// invoice the page shows. Pure: no database.
//
// The account's rules that call these (who may change N, and when) are in
// enterprise.test.ts.

import { describe, expect, test } from "bun:test";
import {
  addContractMonths,
  billingPeriodsDue,
  contractMonthIndex,
  contractQuarterEnd,
  INVOICE_GRACE_MS,
  monthsLeftInYear,
  nextInvoice,
  periodCharge,
  periodTotalUsd,
  quoteSeatChange,
  renewalDate,
  seatsAt,
  type BillingPeriod,
  type EnterprisePlan,
  type SeatChange,
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

// ------------------------------------------------------------------ S4

const DAY_MS = 86_400_000;
/** Contract month k of the END contract: M(1) is the end of the free trial. */
const M = (k: number) => addContractMonths(END, k);
const cents = (usd: number) => usd * 100;

function history(...changes: [number, number, number][]): SeatChange[] {
  return changes.map(([t, from, to]) => ({ at: t, from, to }));
}

/** Set up the day before the contract starts, with N = 50. */
const SET_UP = history([END - DAY_MS, 0, 50]);

function periodOf(
  plan: EnterprisePlan,
  id: string,
  now = M(40),
): BillingPeriod {
  const found = billingPeriodsDue(plan, END, now).find((p) => p.id === id);
  if (!found) throw new Error(`no period ${id}`);
  return found;
}

function charge(
  plan: EnterprisePlan,
  h: SeatChange[],
  id: string,
): number | null {
  return periodCharge(plan, END, h, periodOf(plan, id))?.amountCents ?? null;
}

describe("N over time", () => {
  test("N at t is the last change at or before t; before any change it is 0", () => {
    const h = history([END - DAY_MS, 0, 50], [M(1), 50, 60], [M(2), 60, 40]);
    expect(
      [END - 2 * DAY_MS, END, M(1) - 1, M(1), M(2) - 1, M(2), M(9)].map((t) =>
        seatsAt(h, t),
      ),
    ).toEqual([0, 50, 50, 60, 60, 40, 40]);
  });
});

test("two changes in the same millisecond: N is the end of the chain, whatever their order", () => {
  const t = M(1) + DAY_MS;
  const a = { at: t, from: 50, to: 60 };
  const b = { at: t, from: 60, to: 70 };
  for (const order of [
    [...SET_UP, a, b],
    [...SET_UP, b, a],
  ]) {
    expect(seatsAt(order, t)).toBe(70);
    expect(
      periodCharge("monthly", END, order, periodOf("monthly", "m2"))
        ?.amountCents,
    ).toBe(cents(70 * 25));
  }
});

describe("the billing periods", () => {
  test("monthly: month 0 is free; month K is invoiced at its end, after the grace", () => {
    expect(billingPeriodsDue("monthly", END, M(1) + DAY_MS)).toEqual([]);
    expect(
      billingPeriodsDue("monthly", END, M(2) + INVOICE_GRACE_MS - 1),
    ).toEqual([]);
    expect(billingPeriodsDue("monthly", END, M(2) + INVOICE_GRACE_MS)).toEqual([
      { id: "m1", start: M(1), end: M(2), issuedAt: M(2) },
    ]);
    expect(
      billingPeriodsDue("monthly", END, M(4) + INVOICE_GRACE_MS).map((p) => [
        p.id,
        p.start,
        p.end,
        p.issuedAt,
      ]),
    ).toEqual([
      ["m1", M(1), M(2), M(2)],
      ["m2", M(2), M(3), M(3)],
      ["m3", M(3), M(4), M(4)],
    ]);
  });

  test("yearly: year 0 at the end of the trial, each quarter at its end, each later year at its start", () => {
    expect(billingPeriodsDue("yearly", END, M(1) - 1)).toEqual([]);
    expect(billingPeriodsDue("yearly", END, M(1) + INVOICE_GRACE_MS)).toEqual([
      { id: "y0", start: M(1), end: M(12), issuedAt: M(1) },
    ]);
    const due = billingPeriodsDue("yearly", END, M(15) + INVOICE_GRACE_MS);
    // Oldest first: issuedAt never goes down.
    const issued = due.map((p) => p.issuedAt);
    expect(issued).toEqual([...issued].sort((a, b) => a - b));
    expect(
      Object.fromEntries(due.map((p) => [p.id, [p.start, p.end, p.issuedAt]])),
    ).toEqual({
      y0: [M(1), M(12), M(1)],
      y0q0: [M(0), M(3), M(3)],
      y0q1: [M(3), M(6), M(6)],
      y0q2: [M(6), M(9), M(9)],
      y0q3: [M(9), M(12), M(12)],
      y1: [M(12), M(24), M(12)],
      y1q0: [M(12), M(15), M(15)],
    });
    expect(due).toHaveLength(7);
  });
});

describe("what a period bills", () => {
  test("monthly: the highest N during the month, at $25; the month after starts from N then", () => {
    const h = history(
      [END - DAY_MS, 0, 50],
      // In the free month: only N at the end of it carries into month 1.
      [END + DAY_MS, 50, 120],
      [END + 2 * DAY_MS, 120, 70],
      [M(1) + DAY_MS, 70, 80],
      [M(1) + 2 * DAY_MS, 80, 60],
    );
    const m1 = periodCharge("monthly", END, h, periodOf("monthly", "m1"));
    expect(m1?.amountCents).toBe(cents(80 * 25));
    expect(m1?.lines.length).toBeGreaterThan(0);
    expect(charge("monthly", h, "m2")).toBe(cents(60 * 25));
  });

  test("monthly: a change at exactly a month's edge counts in the month that starts there only", () => {
    const h = history([END - DAY_MS, 0, 50], [M(2), 50, 90]);
    expect(charge("monthly", h, "m1")).toBe(cents(50 * 25));
    expect(charge("monthly", h, "m2")).toBe(cents(90 * 25));
    // A raise at exactly the trial's end is month 1's N.
    const atTrialEnd = history([END - DAY_MS, 0, 50], [M(1), 50, 70]);
    expect(charge("monthly", atTrialEnd, "m1")).toBe(cents(70 * 25));
  });

  test("yearly year 0: N at the trial's end for the 11 paid months; seats added in the trial are in it, not in a quarter", () => {
    const h = history([END - DAY_MS, 0, 50], [END + DAY_MS, 50, 70]);
    expect(charge("yearly", h, "y0")).toBe(cents(70 * 20 * 11));
    expect(charge("yearly", h, "y0q0")).toBeNull();
    // A raise at exactly the trial's end: y0 bills it, quarter 0 does not.
    const edge = history([END - DAY_MS, 0, 50], [M(1), 50, 72]);
    expect(charge("yearly", edge, "y0")).toBe(cents(72 * 20 * 11));
    expect(charge("yearly", edge, "y0q0")).toBeNull();
  });

  test("yearly quarters: each added seat from its month to the year's end at $20; no increase, no charge", () => {
    const h = history(
      [END - DAY_MS, 0, 50],
      // Month 1 (11 months left) and month 2 (10 left), both in quarter 0.
      [M(1) + DAY_MS, 50, 55],
      [M(2) + DAY_MS, 55, 58],
      // Exactly at quarter 1's start: quarter 1, month 3, 9 months left.
      [M(3), 58, 62],
      // Month 11, the last of year 0: 1 month left.
      [M(11) + DAY_MS, 62, 63],
    );
    expect(charge("yearly", h, "y0")).toBe(cents(50 * 20 * 11));
    expect(charge("yearly", h, "y0q0")).toBe(cents(5 * 20 * 11 + 3 * 20 * 10));
    expect(
      periodCharge("yearly", END, h, periodOf("yearly", "y0q0"))?.lines,
    ).toHaveLength(2);
    expect(charge("yearly", h, "y0q1")).toBe(cents(4 * 20 * 9));
    expect(charge("yearly", h, "y0q2")).toBeNull();
    expect(charge("yearly", h, "y0q3")).toBe(cents(1 * 20 * 1));
    expect(charge("yearly", h, "y1")).toBe(cents(63 * 240));
  });

  test("yearly: an increase at exactly a year's start is in that year's invoice, not in a quarter", () => {
    const h = history([END - DAY_MS, 0, 50], [M(12), 50, 56]);
    expect(charge("yearly", h, "y0q3")).toBeNull();
    expect(charge("yearly", h, "y1")).toBe(cents(56 * 240));
    expect(charge("yearly", h, "y1q0")).toBeNull();
    const later = history([END - DAY_MS, 0, 50], [M(13) + DAY_MS, 50, 53]);
    expect(charge("yearly", later, "y1q0")).toBe(cents(3 * 20 * 11));
  });
});

describe("the next invoice the page shows", () => {
  test("yearly: when a quarter and the next year are invoiced the same day, it shows both together", () => {
    const h = history([END - DAY_MS, 0, 50], [M(10) + DAY_MS, 50, 53]);
    const next = nextInvoice("yearly", END, h, M(11) + DAY_MS);
    expect({
      issuedAt: next.period.issuedAt,
      amountCents: next.amountCents,
    }).toEqual({
      issuedAt: M(12),
      amountCents: cents(3 * 20 * 2) + cents(53 * 240),
    });
  });

  test("monthly: during the trial, month 1 at the current N; in a month, its highest N so far", () => {
    expect(nextInvoice("monthly", END, SET_UP, END + DAY_MS)).toEqual({
      period: { id: "m1", start: M(1), end: M(2), issuedAt: M(2) },
      amountCents: cents(50 * 25),
    });
    const h = history(
      [END - DAY_MS, 0, 50],
      [M(1) + DAY_MS, 50, 80],
      [M(1) + 2 * DAY_MS, 80, 60],
    );
    const next = nextInvoice("monthly", END, h, M(1) + 3 * DAY_MS);
    expect({ id: next.period.id, amountCents: next.amountCents }).toEqual({
      id: "m1",
      amountCents: cents(80 * 25),
    });
  });

  test("yearly: year 0 during the trial; then the quarter, with no amount while nothing was added", () => {
    const trial = nextInvoice("yearly", END, SET_UP, END + DAY_MS);
    expect({ id: trial.period.id, amountCents: trial.amountCents }).toEqual({
      id: "y0",
      amountCents: cents(50 * 20 * 11),
    });
    const quiet = nextInvoice("yearly", END, SET_UP, M(4) + DAY_MS);
    expect({
      id: quiet.period.id,
      issuedAt: quiet.period.issuedAt,
      amountCents: quiet.amountCents,
    }).toEqual({ id: "y0q1", issuedAt: M(6), amountCents: null });
    const added = history([END - DAY_MS, 0, 50], [M(4) + DAY_MS, 50, 52]);
    expect(
      nextInvoice("yearly", END, added, M(4) + 2 * DAY_MS).amountCents,
    ).toBe(cents(2 * 20 * 8));
  });
});
