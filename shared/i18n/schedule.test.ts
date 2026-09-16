// The schedule sentence of ruling 12, on every offered language and on
// every shape a Schedule can take.
//
// The English must be what
// shared/types.ts's humanizeSchedule prints for the same schedule, because the
// UI moved from that function to this one and ruling 6 freezes the wording; the
// last block asserts that against humanizeSchedule itself rather than against a
// copy of its output, so the two cannot drift apart unnoticed.

import { describe, expect, it } from "bun:test";
import { scheduleText, weekdayName } from "./schedule.ts";
import { translatorFor } from "./translate.ts";
import { humanizeSchedule, type Schedule } from "../types.ts";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "../languages.ts";

const say = (language: SupportedLanguageCode, schedule: Schedule) =>
  scheduleText(language, translatorFor(language).t, schedule);

const DAILY: Schedule = { type: "daily", hour: 9, minute: 0 };
const WEEKLY: Schedule = { type: "weekly", weekday: 1, hour: 17, minute: 30 };
const EVERY_MINUTES: Schedule = { type: "interval", minutes: 45 };
const EVERY_HOURS: Schedule = { type: "interval", minutes: 180 };
const EVERY_MIXED: Schedule = { type: "interval", minutes: 150 };

describe("weekdayName", () => {
  it("uses the known Sunday anchor and gives every day a label", () => {
    const sunday = new Date(Date.UTC(2024, 0, 7));
    for (const { code } of SUPPORTED_LANGUAGES) {
      const week = Array.from({ length: 7 }, (_, day) =>
        weekdayName(code, day),
      );
      const expectedSunday = new Intl.DateTimeFormat(code, {
        weekday: "short",
        timeZone: "UTC",
      }).format(sunday);
      expect(week[0], code).toBe(expectedSunday);
      expect(week.every(Boolean), code).toBe(true);
      expect(new Set(week).size, code).toBe(week.length);
    }
  });
});

describe("scheduleText", () => {
  it("keeps schedule data in a resolved sentence for every language", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      expect(say(code, DAILY)).toContain("09:00");
      expect(say(code, WEEKLY)).toContain("17:30");
      expect(say(code, EVERY_MINUTES)).toContain("45");
      expect(say(code, EVERY_HOURS)).toContain("3");
      const mixed = say(code, EVERY_MIXED);
      expect(mixed).toContain("2");
      expect(mixed).toContain("30");
    }
  });

  // The clock is two numbers, not an instant: Intl would make the English read
  // "9:00 AM", which ruling 6 does not allow.
  it("keeps a zero-padded 24-hour clock in every language", () => {
    const early: Schedule = { type: "daily", hour: 7, minute: 5 };
    for (const { code } of SUPPORTED_LANGUAGES)
      expect(say(code, early), code).toContain("07:05");
  });

  it("joins a Chinese weekday directly and separates numeric values", () => {
    const weekly = say("zh", WEEKLY);
    const weekday = weekdayName("zh", WEEKLY.weekday);
    expect(weekly).toContain(weekday);
    expect(weekly).not.toContain(` ${weekday}`);
    expect(weekly).not.toContain(`${weekday}  `);
    expect(weekly).toContain(`${weekday} 17:30`);
    expect(say("zh", EVERY_HOURS)).toContain(" 3 ");
    expect(say("zh", EVERY_MIXED)).toContain(" 2 ");
    expect(say("zh", EVERY_MIXED)).toContain(" 30 ");
  });
});

// shared/types.ts keeps humanizeSchedule for its server callers; the English
// here has to stay equal to it, or a reader on English and a reader of the
// /isomux chat report would see the same schedule two ways.
describe("the English and humanizeSchedule", () => {
  it("agree on every shape", () => {
    for (const schedule of [
      DAILY,
      WEEKLY,
      EVERY_MINUTES,
      EVERY_HOURS,
      EVERY_MIXED,
      { type: "weekly", weekday: 6, hour: 0, minute: 0 } as Schedule,
      { type: "interval", minutes: 1 } as Schedule,
    ])
      expect(say("en", schedule), JSON.stringify(schedule)).toBe(
        humanizeSchedule(schedule),
      );
  });
});
