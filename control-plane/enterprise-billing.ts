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
  const monthsLeft = monthsLeftInYear(start, now);
  return {
    plan,
    from,
    to,
    added,
    monthsLeft,
    amountUsd: added * ADDED_SEAT_MONTH_USD * monthsLeft,
    invoicedAt: contractQuarterEnd(start, now),
  };
}
