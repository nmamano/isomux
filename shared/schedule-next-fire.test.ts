// The monthly schedule's next fire (task a0c26f59): the day of the month in
// the server's local time, clamped to the last day of a shorter month in that
// month only, and local-clock arithmetic across a DST change, as daily and
// weekly already do.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { nextScheduledFire } from "./schedule-next-fire.ts";
import type { Schedule } from "./types.ts";

// A zone with DST, so a month that crosses a clock change is not a fixed
// number of hours. Spain moves to summer time on 2026-03-29 at 02:00.
const ZONE = "Europe/Madrid";
let savedZone: string | undefined;
beforeAll(() => {
  savedZone = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

// A local wall-clock time in ZONE (month is 1-12).
const at = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();
const monthly = (day: number, hour = 9, minute = 0): Schedule => ({
  type: "monthly",
  day,
  hour,
  minute,
});
// Every schedule here has a clock, so a null is a failure.
function next(schedule: Schedule, now: number): number {
  const at = nextScheduledFire(schedule, now, now);
  if (at === null)
    throw new Error(`no next fire for ${JSON.stringify(schedule)}`);
  return at;
}

describe("nextScheduledFire: monthly", () => {
  it("runs in the zone the test set", () => {
    // The condition every case below depends on: Date reads ZONE.
    expect(new Date(at(2026, 1, 15)).getTimezoneOffset()).toBe(-60);
    expect(new Date(at(2026, 7, 15)).getTimezoneOffset()).toBe(-120);
  });

  it("runs later this month when the day is ahead, else next month; a slot equal to now is past", () => {
    expect(next(monthly(15), at(2026, 3, 10, 12))).toBe(at(2026, 3, 15, 9));
    expect(next(monthly(15), at(2026, 3, 15, 8, 59))).toBe(at(2026, 3, 15, 9));
    expect(next(monthly(15), at(2026, 3, 15, 9))).toBe(at(2026, 4, 15, 9));
    expect(next(monthly(15), at(2026, 3, 16))).toBe(at(2026, 4, 15, 9));
  });

  it("runs day 31 on the last day of each shorter month, and goes back to 31 after it", () => {
    // Each fire computes the next one from its own slot, as the scheduler does.
    const chain: number[] = [];
    let now = at(2026, 1, 1);
    for (let i = 0; i < 6; i++) {
      now = next(monthly(31), now);
      chain.push(now);
    }
    expect(chain).toEqual([
      at(2026, 1, 31, 9),
      at(2026, 2, 28, 9),
      at(2026, 3, 31, 9),
      at(2026, 4, 30, 9),
      at(2026, 5, 31, 9),
      at(2026, 6, 30, 9),
    ]);
  });

  it("clamps in the month it computes, before it compares with now", () => {
    // Day 31 in February is February's last day, not a day in March.
    expect(next(monthly(31), at(2026, 2, 28, 8))).toBe(at(2026, 2, 28, 9));
    expect(next(monthly(31), at(2026, 2, 28, 10))).toBe(at(2026, 3, 31, 9));
    expect(next(monthly(30), at(2026, 2, 1))).toBe(at(2026, 2, 28, 9));
  });

  it("uses February 29 in a leap year", () => {
    expect(next(monthly(31), at(2028, 2, 1))).toBe(at(2028, 2, 29, 9));
    expect(next(monthly(29), at(2028, 2, 1))).toBe(at(2028, 2, 29, 9));
    expect(next(monthly(29), at(2027, 2, 1))).toBe(at(2027, 2, 28, 9));
  });

  it("goes from December to January of the next year", () => {
    expect(next(monthly(31, 23, 59), at(2026, 12, 31, 23, 59))).toBe(
      at(2027, 1, 31, 23, 59),
    );
  });

  it("keeps the wall-clock time across a DST change", () => {
    // From a winter slot to a summer one: 09:00 local, not 09:00 plus a
    // fixed number of hours.
    const april = next(monthly(1), at(2026, 3, 1, 9));
    expect(april).toBe(at(2026, 4, 1, 9));
    expect(new Date(april).getHours()).toBe(9);
    // And back in October (summer time ends on 2026-10-25).
    const november = next(monthly(1), at(2026, 10, 1, 9));
    expect(new Date(november).getMonth()).toBe(10);
    expect(new Date(november).getHours()).toBe(9);
  });

  it("puts a time the DST change skips where the daily schedule puts it", () => {
    // 02:30 does not exist in Madrid on 2026-03-29.
    const monthlySlot = next(monthly(29, 2, 30), at(2026, 3, 20));
    const dailySlot = next(
      { type: "daily", hour: 2, minute: 30 },
      at(2026, 3, 28, 12),
    );
    expect(new Date(monthlySlot).getDate()).toBe(29);
    expect(monthlySlot).toBe(dailySlot);
  });
});
