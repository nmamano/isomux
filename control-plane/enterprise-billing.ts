// The enterprise contract calendar and price quotes, in one pure module: the
// storefront page, the seats route and the Stripe billing all call it, and
// nothing else does date math on a contract.
//
// Nil's billing rules (task 71718489, 2026-11-06): adding or removing members
// never changes the bill; only the seat count N does. Monthly: one invoice at
// the end of each contract month for the highest N of that month. Yearly: N x
// $240 at the start of the contract year; a seat added during the year is
// charged $20 per month from the month it was added in to the end of the
// contract year, invoiced at the end of that contract quarter; N goes down
// only at renewal.
//
// Every date is UTC epoch ms. A contract month starts on the start's day of
// the month, clamped to the month's last day (start Jan 31 -> Feb 28 or 29).

export type EnterprisePlan = "monthly" | "yearly";

export const MONTHLY_SEAT_USD = 25;
export const YEARLY_SEAT_USD = 240;
export const ADDED_SEAT_MONTH_USD = 20;

const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 1) - DAY_MS).getUTCDate();
}

/** `start` moved by `months` contract months, the day clamped. Always from the
 * start, never chained: Jan 31 + 1 is Feb 28, and Jan 31 + 2 is Mar 31. */
export function addContractMonths(start: number, months: number): number {
  const d = new Date(start);
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(
    year,
    month,
    day,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** The 0-based contract month `now` falls in (month 0 starts at `start`). */
export function contractMonthIndex(start: number, now: number): number {
  if (now <= start) return 0;
  const a = new Date(start);
  const b = new Date(now);
  let k =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  // The calendar estimate is off by at most one, from the day of the month.
  while (k > 0 && addContractMonths(start, k) > now) k--;
  while (addContractMonths(start, k + 1) <= now) k++;
  return k;
}

/** Contract months left in the current contract year, the current one
 * counted: 12 in the first month, 1 in the last. */
export function monthsLeftInYear(start: number, now: number): number {
  return 12 - (contractMonthIndex(start, now) % 12);
}

/** When the contract quarter `now` falls in ends (the next quarter's start). */
export function contractQuarterEnd(start: number, now: number): number {
  const quarter = Math.floor(contractMonthIndex(start, now) / 3);
  return addContractMonths(start, (quarter + 1) * 3);
}

/** When the contract year `now` falls in ends (the next renewal). */
export function renewalDate(start: number, now: number): number {
  const year = Math.floor(contractMonthIndex(start, now) / 12);
  return addContractMonths(start, (year + 1) * 12);
}

/** The price of N seats for one period of the plan (a month or a year). */
export function periodTotalUsd(plan: EnterprisePlan, seats: number): number {
  return seats * (plan === "monthly" ? MONTHLY_SEAT_USD : YEARLY_SEAT_USD);
}

/** What a seat change costs, shown before it commits. */
export type SeatQuote =
  | {
      plan: "monthly";
      from: number;
      to: number;
      /** to x $25: the invoice of a month whose highest N is `to`. */
      monthTotalUsd: number;
      /** to < from: this month's invoice still counts the highest N. */
      lowering: boolean;
    }
  | {
      plan: "yearly";
      from: number;
      to: number;
      added: number;
      monthsLeft: number;
      /** added x $20 x monthsLeft. */
      amountUsd: number;
      /** End of the current contract quarter: when it is invoiced. */
      invoicedAt: number;
    };

/** The quote for a change from `from` to `to` seats at `now`. Yearly
 * lowering is refused by the caller before it asks. */
export function quoteSeatChange(
  plan: EnterprisePlan,
  start: number,
  now: number,
  from: number,
  to: number,
): SeatQuote {
  if (plan === "monthly") {
    return {
      plan,
      from,
      to,
      monthTotalUsd: to * MONTHLY_SEAT_USD,
      lowering: to < from,
    };
  }
  const added = Math.max(0, to - from);
  // In the free month, an added seat is in year 0's invoice at the trial's
  // end, for the 11 paid months.
  const trial = contractMonthIndex(start, now) === 0;
  const monthsLeft = trial ? 11 : monthsLeftInYear(start, now);
  return {
    plan,
    from,
    to,
    added,
    monthsLeft,
    amountUsd: added * ADDED_SEAT_MONTH_USD * monthsLeft,
    invoicedAt: trial
      ? addContractMonths(start, 1)
      : contractQuarterEnd(start, now),
  };
}

// ------------------------------------------------------------- invoices (S4)
//
// The billing calendar the invoice pass (enterprise-invoices.ts) and the
// account page both read. Contract month 0 is the free trial on both plans.
// Monthly: period mK (K >= 1) is contract month K, invoiced at its end for the
// highest N during it. Yearly: y0, at the end of the trial, bills N then for the
// 11 paid months of year 0; yY (Y >= 1), at the year's start, bills N then for
// the year; yYqQ, at the end of quarter Q of year Y, bills each seat added in
// that quarter from the month it was added to the end of the year.
//
// N at t is the to_seats of the last change at or before t. A change at
// exactly a period edge belongs to the period that starts there; a yearly
// increase at exactly the trial end or a year start is billed by y0 / yY, not
// by a quarter.

/** One change of N (enterprise_seat_changes). */
export interface SeatChange {
  at: number;
  from: number;
  to: number;
}

export interface BillingPeriod {
  /** "m5", "y0", "y1", "y1q2": the ledger key. */
  id: string;
  /** The window the amount covers: [start, end). */
  start: number;
  end: number;
  /** When it is invoiced. */
  issuedAt: number;
}

export interface PeriodCharge {
  amountCents: number;
  /** One line per charge, for the invoice description and the ledger. */
  lines: string[];
}

/** Stripe's largest USD amount for a payment method other than a card
 * (8 digits, docs.stripe.com/currencies, 2026-11-07). An invoice paid by
 * bank transfer cannot be larger. */
export const MAX_INVOICE_CENTS = 99_999_999;

/** A period is invoiced this long after it ends, so a seat change whose
 * transaction started before the edge has committed. */
export const INVOICE_GRACE_MS = 10 * 60_000;

/** N in effect at `t`. */
export function seatsAt(history: readonly SeatChange[], t: number): number {
  let last = -Infinity;
  for (const c of history) if (c.at <= t && c.at > last) last = c.at;
  const tied = history.filter((c) => c.at === last);
  if (tied.length === 0) return 0;
  // Changes in one millisecond (a change and a raise under one row lock) are
  // a chain: N is the `to` that no other change starts from.
  const ends = tied.filter(
    (c) => !tied.some((d) => d !== c && d.from === c.to),
  );
  return (ends.length === 1 ? ends[0] : tied[tied.length - 1]).to;
}

/** Every period issued at or before `until`, oldest first. */
function periodsUntil(
  plan: EnterprisePlan,
  start: number,
  until: number,
): BillingPeriod[] {
  const M = (k: number) => addContractMonths(start, k);
  const out: BillingPeriod[] = [];
  if (plan === "monthly") {
    for (let k = 1; M(k + 1) <= until; k++) {
      out.push({ id: `m${k}`, start: M(k), end: M(k + 1), issuedAt: M(k + 1) });
    }
    return out;
  }
  for (let y = 0; ; y++) {
    const yearIssued = y === 0 ? M(1) : M(12 * y);
    if (yearIssued > until) break;
    out.push({
      id: `y${y}`,
      start: y === 0 ? M(1) : M(12 * y),
      end: M(12 * y + 12),
      issuedAt: yearIssued,
    });
    for (let q = 0; q < 4; q++) {
      const end = M(12 * y + 3 * q + 3);
      if (end > until) break;
      out.push({
        id: `y${y}q${q}`,
        start: M(12 * y + 3 * q),
        end,
        issuedAt: end,
      });
    }
  }
  // A quarter's end can be the next year's start: the older window first.
  return out.sort((a, b) => a.issuedAt - b.issuedAt || a.start - b.start);
}

/** The periods issued by `now - INVOICE_GRACE_MS`, oldest first, from the
 * contract start on, whether or not they carry an amount. */
export function billingPeriodsDue(
  plan: EnterprisePlan,
  start: number,
  now: number,
): BillingPeriod[] {
  return periodsUntil(plan, start, now - INVOICE_GRACE_MS);
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function seatWord(n: number): string {
  return n === 1 ? "1 seat" : `${n} seats`;
}

function monthWord(n: number): string {
  return n === 1 ? "1 month" : `${n} months`;
}

/** What a period bills, or null when it bills nothing (a quarter with no
 * increase). */
export function periodCharge(
  plan: EnterprisePlan,
  start: number,
  history: readonly SeatChange[],
  period: BillingPeriod,
): PeriodCharge | null {
  const window = `${day(period.start)} to ${day(period.end)}`;
  if (plan === "monthly") {
    let highest = seatsAt(history, period.start);
    for (const c of history) {
      if (c.at > period.start && c.at < period.end && c.to > highest)
        highest = c.to;
    }
    return {
      amountCents: highest * MONTHLY_SEAT_USD * 100,
      lines: [
        `${seatWord(highest)} x $${MONTHLY_SEAT_USD}, highest seat count of ${window}`,
      ],
    };
  }
  const quarter = /^y(\d+)q\d$/.exec(period.id);
  if (!quarter) {
    const n = seatsAt(history, period.start);
    if (period.id === "y0") {
      const paid = 11;
      return {
        amountCents: n * ADDED_SEAT_MONTH_USD * paid * 100,
        lines: [
          `${seatWord(n)} x $${ADDED_SEAT_MONTH_USD} x ${monthWord(paid)}, ${window} (the first month was free)`,
        ],
      };
    }
    return {
      amountCents: n * YEARLY_SEAT_USD * 100,
      lines: [`${seatWord(n)} x $${YEARLY_SEAT_USD}, ${window}`],
    };
  }
  // Seats added in the quarter. y0 and yY bill N at their own start, so a
  // change at or before it is not the quarter's.
  const year = Number(quarter[1]);
  const billedUpTo =
    year === 0
      ? addContractMonths(start, 1)
      : addContractMonths(start, 12 * year);
  let cents = 0;
  const lines: string[] = [];
  for (const c of [...history].sort((a, b) => a.at - b.at)) {
    if (c.at < period.start || c.at >= period.end || c.at <= billedUpTo)
      continue;
    const added = c.to - c.from;
    if (added <= 0) continue;
    const months = monthsLeftInYear(start, c.at);
    cents += added * ADDED_SEAT_MONTH_USD * months * 100;
    lines.push(
      `${seatWord(added)} added on ${day(c.at)} x $${ADDED_SEAT_MONTH_USD} x ${monthWord(months)}`,
    );
  }
  return cents > 0 ? { amountCents: cents, lines } : null;
}

/** The next invoice for the account page: when, and what it bills so far
 * (null amount when nothing is due yet, a quarter with no increase). The
 * periods issued at the same moment (a quarter's end and the next year's
 * start) add up. */
export function nextInvoice(
  plan: EnterprisePlan,
  start: number,
  history: readonly SeatChange[],
  now: number,
): { period: BillingPeriod; amountCents: number | null } {
  const sofar = history.filter((c) => c.at <= now);
  const upcoming = periodsUntil(
    plan,
    start,
    addContractMonths(Math.max(now, start), 13),
  ).filter((p) => p.issuedAt > now);
  const first = upcoming[0];
  const same = upcoming.filter((p) => p.issuedAt === first.issuedAt);
  let amountCents: number | null = null;
  for (const p of same) {
    const c = periodCharge(plan, start, sofar, p);
    if (c) amountCents = (amountCents ?? 0) + c.amountCents;
  }
  return { period: first, amountCents };
}
