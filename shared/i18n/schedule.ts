// A cronjob's schedule as a sentence a person reads, in the reader's language
// (internal-docs/i18n-loop.md, ruling 12; ruled into S6 by the PM on Reviewer
// 2's escalation, 2026-09-06).
//
// The English is the English shared/types.ts's humanizeSchedule has always
// produced, key for key, so moving a surface onto this helper changes the
// language and not the wording (ruling 6). humanizeSchedule itself is NOT
// touched: server/cronjob-manager.ts still calls it, and S7 decides whether the
// server adopts this helper per user.
//
// The weekday comes from Intl.DateTimeFormat rather than a hand-written table
// (ruling 12). The hand-written one in humanizeSchedule is the reason this
// module exists.
//
// The clock is NOT an Intl time: an hour and a minute of a schedule are two
// numbers, not an instant, and Intl would turn "09:00" into "09:00 AM" in
// English. A zero-padded 24-hour clock reads the same in all three languages
// and keeps the English frozen.
//
// Unlike its neighbours here, this module DOES take a translator: its output is
// a catalog sentence, not a formatted number. The language still arrives first,
// and nothing here reads a global (ruling 18).

import type { Schedule } from "../types.ts";
import type { SupportedLanguageCode } from "../languages.ts";
import type { Translator } from "./translate.ts";

// 2024-01-07 was a Sunday in UTC, so weekday 0..6 lands on 7..13 January. Read
// back in UTC as well, or a machine west of Greenwich names the day before.
const WEEKDAY_ANCHOR_DAY = 7;

const weekdayFormatters = new Map<
  SupportedLanguageCode,
  Intl.DateTimeFormat
>();

function weekdayFormatter(
  language: SupportedLanguageCode,
): Intl.DateTimeFormat {
  const cached = weekdayFormatters.get(language);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(language, {
    weekday: "short",
    timeZone: "UTC",
  });
  weekdayFormatters.set(language, made);
  return made;
}

/** The short name of weekday `index` (0 = Sunday) in the reader's language. */
export function weekdayName(
  language: SupportedLanguageCode,
  index: number,
): string {
  const day = new Date(Date.UTC(2024, 0, WEEKDAY_ANCHOR_DAY + index));
  return weekdayFormatter(language).format(day);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** `schedule` as a sentence, in the reader's language. */
export function scheduleText(
  language: SupportedLanguageCode,
  t: Translator["t"],
  schedule: Schedule,
): string {
  if (schedule.type === "daily")
    return t("schedules.human.daily", {
      time: `${pad(schedule.hour)}:${pad(schedule.minute)}`,
    });
  if (schedule.type === "weekly")
    return t("schedules.human.weekly", {
      weekday: weekdayName(language, schedule.weekday),
      time: `${pad(schedule.hour)}:${pad(schedule.minute)}`,
    });
  const { minutes } = schedule;
  if (minutes < 60) return t("schedules.human.everyMinutes", { minutes });
  if (minutes % 60 === 0)
    return t("schedules.human.everyHours", { hours: minutes / 60 });
  return t("schedules.human.everyHoursMinutes", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}
