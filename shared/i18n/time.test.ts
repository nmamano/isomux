// The Intl time helper of ruling 12, on the three offered languages and at
// every threshold the helper actually branches on.
//
// The buckets are decided AFTER Math.round, so a whole-unit sample either side
// of a nominal boundary proves nothing: 47h and 48h are both far from the
// predicate that separates them. Every boundary here is pinned as the pair of
// millisecond values that straddle the rounded transition, one on each side.
//
// The expectations are literal strings, for the same reason the DOM tests use
// them (ruling 14): an expectation computed from Intl.RelativeTimeFormat would
// pass whatever the helper did with it, including picking the wrong unit. What
// this file pins is the bucket each age lands in - the thresholds carried over
// from the hand-built formatters access-shared.tsx used - and the fact that
// Catalan and Spanish get their own words rather than English ones.
//
// `now` is passed in everywhere, so nothing here depends on the clock. The
// absolute case builds its Date from local components and expects the local
// rendering, so it does not depend on the machine's time zone either.

import { describe, expect, it } from "bun:test";
import {
  absoluteTime,
  formatDateTime,
  timeSince,
  timeUntil,
  timeUntilFine,
} from "./time.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Language = "en" | "es" | "ca";

const since = (language: Language, ago: number) =>
  timeSince(language, NOW - ago, NOW);
const until = (language: Language, left: number) =>
  timeUntil(language, NOW + left, NOW);

describe("timeSince", () => {
  // minutes = round(ms / 60000), and the "now" case holds while that is 0, so
  // the switch is at half a minute rather than at one minute. The word for it
  // is the caller's (ruling 17); what the helper owes is the kind.
  it("leaves the now case at 30 s, where the rounded minute becomes 1", () => {
    expect(since("en", 29_999)).toEqual({ kind: "now" });
    expect(since("ca", 29_999)).toEqual({ kind: "now" });
    expect(since("en", 30_000)).toEqual({ kind: "formatted", text: "1m ago" });
  });

  // Minutes hold while round(ms / 60000) < 60, so 59m30s is already 60.
  it("leaves minutes for hours at 59m30s", () => {
    expect(since("en", 59 * MINUTE + 29_999)).toEqual({
      kind: "formatted",
      text: "59m ago",
    });
    expect(since("en", 59 * MINUTE + 30_000)).toEqual({
      kind: "formatted",
      text: "1h ago",
    });
  });

  // Hours are rounded from the ALREADY rounded minutes, so the transition sits
  // at 47h29m30s, not at 48h. Crossing it skips both a 48h and a 1d reading:
  // the hour bucket ends at 47h and the day bucket opens at 2d, which is what
  // the hand-built formatter did and what this pins.
  it("leaves hours for days at 47h29m30s, with no 48h or 1d reading in between", () => {
    expect(since("en", 47 * HOUR + 29 * MINUTE + 29_999)).toEqual({
      kind: "formatted",
      text: "47h ago",
    });
    expect(since("en", 47 * HOUR + 29 * MINUTE + 30_000)).toEqual({
      kind: "formatted",
      text: "2d ago",
    });
  });

  const text = (language: Language, ago: number) => {
    const result = since(language, ago);
    return result.kind === "formatted" ? result.text : result.kind;
  };

  it("reads Spanish on es", () => {
    expect(text("es", 30_000)).toBe("hace 1 min");
    expect(text("es", 59 * MINUTE)).toBe("hace 59 min");
    expect(text("es", 60 * MINUTE)).toBe("hace 1 h");
    expect(text("es", 47 * HOUR)).toBe("hace 47 h");
    expect(text("es", 96 * HOUR)).toBe("hace 4 d");
  });

  it("reads Catalan on ca", () => {
    expect(text("ca", 30_000)).toBe("fa 1 min");
    expect(text("ca", 59 * MINUTE)).toBe("fa 59 min");
    expect(text("ca", 60 * MINUTE)).toBe("fa 1 h");
    expect(text("ca", 47 * HOUR)).toBe("fa 47 h");
    expect(text("ca", 96 * HOUR)).toBe("fa 4 dies");
  });

  // numeric "always" (ruling 17) is what keeps a phrase out of a column: under
  // "auto" these two read "anteayer" and "abans-d’ahir", which say nothing
  // about a session two days old sitting in a table of numbers. Pinned so the
  // choice is visible if anyone changes the option back.
  it("counts the days instead of naming them", () => {
    expect(text("es", 48 * HOUR)).toBe("hace 2 d");
    expect(text("ca", 48 * HOUR)).toBe("fa 2 dies");
    expect(text("en", 48 * HOUR)).toBe("2d ago");
  });
});

describe("timeUntil", () => {
  // A deadline exactly at `now` has already passed; one millisecond of life
  // left is still a deadline, and Intl has a phrase for it.
  it("is expired at the deadline and formatted one millisecond before it", () => {
    expect(until("en", 0)).toEqual({ kind: "expired" });
    expect(until("en", -1)).toEqual({ kind: "expired" });
    expect(until("ca", -HOUR)).toEqual({ kind: "expired" });
    expect(until("en", 1)).toEqual({ kind: "underHour" });
  });

  // hours = round(ms / 3600000), so anything under half an hour is 0. Intl
  // would say "in 0h"; the caller says what the hand-built formatter said
  // (ruling 17), so this bucket is a kind and not a text.
  it("leaves the under-an-hour case at 30m", () => {
    expect(until("en", 29 * MINUTE + 59_999)).toEqual({ kind: "underHour" });
    expect(until("ca", 29 * MINUTE + 59_999)).toEqual({ kind: "underHour" });
    expect(until("en", 30 * MINUTE)).toEqual({
      kind: "formatted",
      text: "in 1h",
    });
  });

  // Hours here are rounded straight from milliseconds, not through minutes as
  // timeSince does, so this transition is at 47h30m and not at 47h29m30s.
  it("leaves hours for days at 47h30m", () => {
    expect(until("en", 47 * HOUR + 29 * MINUTE + 59_999)).toEqual({
      kind: "formatted",
      text: "in 47h",
    });
    expect(until("en", 47 * HOUR + 30 * MINUTE)).toEqual({
      kind: "formatted",
      text: "in 2d",
    });
  });

  it("reads Spanish and Catalan", () => {
    expect(until("es", 12 * HOUR)).toEqual({
      kind: "formatted",
      text: "dentro de 12 h",
    });
    expect(until("es", 72 * HOUR)).toEqual({
      kind: "formatted",
      text: "dentro de 3 d",
    });
    expect(until("ca", 12 * HOUR)).toEqual({
      kind: "formatted",
      text: "d‘aquí a 12 h",
    });
    expect(until("ca", 72 * HOUR)).toEqual({
      kind: "formatted",
      text: "d’aquí a 3 dies",
    });
  });
});

describe("absoluteTime", () => {
  // Built from local components and read back in the local zone, so this holds
  // wherever the machine is.
  const stamp = new Date(2026, 0, 2, 15, 4).getTime();

  it("orders the date the way each language does", () => {
    expect(absoluteTime("en", stamp)).toBe("1/2/26, 3:04 PM");
    expect(absoluteTime("es", stamp)).toBe("2/1/26, 15:04");
    expect(absoluteTime("ca", stamp)).toBe("2/1/26 15:04");
  });
});

// The shapes S6 moved the hand-built toLocale* call sites onto. English is
// pinned against what those call sites printed before, so the move is provably
// a language change and not a shape change (ruling 6); Spanish and Catalan
// prove the language reaches the formatter at all.
describe("formatDateTime", () => {
  const stamp = new Date(2026, 0, 2, 15, 4, 5).getTime();

  it("keeps the English each shape printed before it moved here", () => {
    expect(formatDateTime("en", stamp, "clock")).toBe("03:04 PM");
    expect(formatDateTime("en", stamp, "monthDay")).toBe("Jan 2");
    expect(formatDateTime("en", stamp, "monthDayTime")).toBe("Jan 2, 03:04 PM");
    expect(formatDateTime("en", stamp, "date")).toBe("1/2/2026");
    expect(formatDateTime("en", stamp, "dateTimeSeconds")).toBe(
      "1/2/2026, 3:04:05 PM",
    );
    expect(formatDateTime("en", stamp, "fullDate")).toBe("Jan 2, 2026");
  });

  it("reads Spanish and Catalan, which order and word the date their own way", () => {
    expect(formatDateTime("es", stamp, "clock")).toBe("15:04");
    expect(formatDateTime("es", stamp, "monthDay")).toBe("2 ene");
    expect(formatDateTime("es", stamp, "fullDate")).toBe("2 ene 2026");
    expect(formatDateTime("es", stamp, "dateTimeSeconds")).toBe(
      "2/1/2026, 15:04:05",
    );
    expect(formatDateTime("ca", stamp, "monthDay")).toBe("2 de gen.");
    expect(formatDateTime("ca", stamp, "fullDate")).toBe("2 de gen. del 2026");
    expect(formatDateTime("ca", stamp, "dateTimeSeconds")).toBe(
      "2/1/2026 15:04:05",
    );
  });

  it("is the same formatter absoluteTime names", () => {
    expect(formatDateTime("en", stamp, "dateTime")).toBe(
      absoluteTime("en", stamp),
    );
  });
});

// The fine countdown S6 needs for the next scheduled run. Same kinds as
// timeUntil, one bucket more: minutes survive instead of rounding to an hour.
describe("timeUntilFine", () => {
  const untilFine = (language: Language, left: number) =>
    timeUntilFine(language, NOW + left, NOW);

  it("keeps minutes where timeUntil rounds them away", () => {
    expect(untilFine("en", 45 * MINUTE)).toEqual({
      kind: "formatted",
      text: "in 45m",
    });
    expect(until("en", 45 * MINUTE)).toEqual({
      kind: "formatted",
      text: "in 1h",
    });
    expect(untilFine("es", 45 * MINUTE)).toEqual({
      kind: "formatted",
      text: "dentro de 45 min",
    });
  });

  it("has the same expired and under-a-minute kinds as timeUntil", () => {
    expect(untilFine("en", 0)).toEqual({ kind: "expired" });
    expect(untilFine("en", -1)).toEqual({ kind: "expired" });
    expect(untilFine("en", 29_999)).toEqual({ kind: "underHour" });
    expect(untilFine("en", 30_000)).toEqual({
      kind: "formatted",
      text: "in 1m",
    });
  });

  it("leaves minutes for hours at 59m30s and hours for days at 47h29m30s", () => {
    expect(untilFine("en", 59 * MINUTE + 29_999)).toEqual({
      kind: "formatted",
      text: "in 59m",
    });
    expect(untilFine("en", 59 * MINUTE + 30_000)).toEqual({
      kind: "formatted",
      text: "in 1h",
    });
    expect(untilFine("en", 47 * HOUR + 29 * MINUTE + 30_000)).toEqual({
      kind: "formatted",
      text: "in 2d",
    });
    // The hour form takes U+2018 and the day form U+2019, as the timeUntil
    // block above already pins; the difference is Intl's, not a typo here.
    expect(untilFine("ca", 3 * HOUR)).toEqual({
      kind: "formatted",
      text: "d‘aquí a 3 h",
    });
  });
});
