// The schedule sentence of ruling 12, on the three offered languages and on
// every shape a Schedule can take.
//
// Two things are pinned at once. The English must be what
// shared/types.ts's humanizeSchedule prints for the same schedule, because the
// UI moved from that function to this one and ruling 6 freezes the wording; the
// last block asserts that against humanizeSchedule itself rather than against a
// copy of its output, so the two cannot drift apart unnoticed. Spanish and
// Catalan are literal strings (ruling 14): an expectation read back through the
// translator would pass for any translation.

import { describe, expect, it } from "bun:test";
import { scheduleText, weekdayName } from "./schedule.ts";
import { translatorFor } from "./translate.ts";
import { humanizeSchedule, type Schedule } from "../types.ts";

type Language = "en" | "es" | "ca";

const say = (language: Language, schedule: Schedule) =>
  scheduleText(language, translatorFor(language).t, schedule);

const DAILY: Schedule = { type: "daily", hour: 9, minute: 0 };
const WEEKLY: Schedule = { type: "weekly", weekday: 1, hour: 17, minute: 30 };
const EVERY_MINUTES: Schedule = { type: "interval", minutes: 45 };
const EVERY_HOURS: Schedule = { type: "interval", minutes: 180 };
const EVERY_MIXED: Schedule = { type: "interval", minutes: 150 };

describe("weekdayName", () => {
  // The anchor date decides which name each index gets, so a wrong anchor puts
  // the whole week one day out. Both ends pin it.
  it("names Sunday at 0 and Saturday at 6, in each language", () => {
    expect(weekdayName("en", 0)).toBe("Sun");
    expect(weekdayName("en", 6)).toBe("Sat");
    expect(weekdayName("es", 0)).toBe("dom");
    expect(weekdayName("es", 1)).toBe("lun");
    expect(weekdayName("ca", 0)).toBe("dg.");
    expect(weekdayName("ca", 1)).toBe("dl.");
  });
});

describe("scheduleText", () => {
  it("says a daily schedule", () => {
    expect(say("en", DAILY)).toBe("Daily at 09:00");
    expect(say("es", DAILY)).toBe("Cada día a las 09:00");
    expect(say("ca", DAILY)).toBe("Cada dia a les 09:00");
  });

  it("says a weekly schedule, with the weekday in the reader's language", () => {
    expect(say("en", WEEKLY)).toBe("Weekly Mon at 17:30");
    expect(say("es", WEEKLY)).toBe("Cada semana, lun a las 17:30");
    expect(say("ca", WEEKLY)).toBe("Cada setmana, dl. a les 17:30");
  });

  it("says each of the three interval shapes", () => {
    expect(say("en", EVERY_MINUTES)).toBe("Every 45m");
    expect(say("es", EVERY_MINUTES)).toBe("Cada 45m");
    expect(say("en", EVERY_HOURS)).toBe("Every 3h");
    expect(say("ca", EVERY_HOURS)).toBe("Cada 3h");
    expect(say("en", EVERY_MIXED)).toBe("Every 2h30m");
    expect(say("es", EVERY_MIXED)).toBe("Cada 2h30m");
  });

  // The clock is two numbers, not an instant: Intl would make the English read
  // "9:00 AM", which ruling 6 does not allow.
  it("keeps a zero-padded 24-hour clock in every language", () => {
    const early: Schedule = { type: "daily", hour: 7, minute: 5 };
    for (const language of ["en", "es", "ca"] as const)
      expect(say(language, early), language).toContain("07:05");
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
