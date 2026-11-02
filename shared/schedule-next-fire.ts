import { MIN_INTERVAL_MINUTES, type Schedule } from "./types.ts";

// The next time a schedule fires after `now`, in the server's local time, or
// null for a job that never fires on the clock. `anchor` is the last fire (or
// the creation time) and matters only to an interval. The scheduler and the
// demo both use it.
export function nextScheduledFire(
  schedule: Schedule,
  anchor: number,
  now: number,
): number | null {
  if (schedule.type === "none") return null;
  if (schedule.type === "interval") {
    const intervalMs =
      Math.max(MIN_INTERVAL_MINUTES, schedule.minutes) * 60_000;
    if (now <= anchor) return anchor + intervalMs;
    const elapsed = now - anchor;
    // floor + 1 (not ceil): when elapsed lands exactly on a period boundary,
    // ceil(N) = N gives nextFireAt == now and the scheduler fires immediately.
    // floor(N) + 1 always returns the *next* future period.
    const periods = Math.floor(elapsed / intervalMs) + 1;
    return anchor + periods * intervalMs;
  }
  if (schedule.type === "daily") {
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (schedule.type === "weekly") {
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    const currentDay = next.getDay();
    let daysAhead = (schedule.weekday - currentDay + 7) % 7;
    if (daysAhead === 0 && next.getTime() <= now) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
    return next.getTime();
  }
  if (schedule.type === "monthly") {
    // The day is clamped in each month on its own, so day 31 runs on Feb 28
    // and then on Mar 31 again.
    const slot = (year: number, month: number) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return new Date(
        year,
        month,
        Math.min(schedule.day, lastDay),
        schedule.hour,
        schedule.minute,
      ).getTime();
    };
    const today = new Date(now);
    const thisMonth = slot(today.getFullYear(), today.getMonth());
    if (thisMonth > now) return thisMonth;
    return slot(today.getFullYear(), today.getMonth() + 1);
  }
  return null;
}
