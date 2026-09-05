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
import { absoluteTime, timeSince, timeUntil } from "./time.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Language = "en" | "es" | "ca";

const since = (language: Language, ago: number) =>
  timeSince(language, NOW - ago, NOW);
const until = (language: Language, left: number) =>
  timeUntil(language, NOW + left, NOW);

describe("timeSince", () => {
  // minutes = round(ms / 60000), and the phrase applies while that is 0, so
  // the switch is at half a minute rather than at one minute.
  it("leaves the under-a-minute phrase at 30 s, where the rounded minute becomes 1", () => {
    expect(since("en", 29_999)).toBe("this minute");
    expect(since("en", 30_000)).toBe("1m ago");
  });

  // Minutes hold while round(ms / 60000) < 60, so 59m30s is already 60.
  it("leaves minutes for hours at 59m30s", () => {
    expect(since("en", 59 * MINUTE + 29_999)).toBe("59m ago");
    expect(since("en", 59 * MINUTE + 30_000)).toBe("1h ago");
  });

  // Hours are rounded from the ALREADY rounded minutes, so the transition sits
  // at 47h29m30s, not at 48h. Crossing it skips both a 48h and a 1d reading:
  // the hour bucket ends at 47h and the day bucket opens at 2d, which is what
  // the hand-built formatter did and what this pins.
  it("leaves hours for days at 47h29m30s, with no 48h or 1d reading in between", () => {
    expect(since("en", 47 * HOUR + 29 * MINUTE + 29_999)).toBe("47h ago");
    expect(since("en", 47 * HOUR + 29 * MINUTE + 30_000)).toBe("2d ago");
  });

  it("reads Spanish on es", () => {
    expect(since("es", 0)).toBe("este minuto");
    expect(since("es", 30_000)).toBe("hace 1 min");
    expect(since("es", 59 * MINUTE)).toBe("hace 59 min");
    expect(since("es", 60 * MINUTE)).toBe("hace 1 h");
    expect(since("es", 47 * HOUR)).toBe("hace 47 h");
    expect(since("es", 96 * HOUR)).toBe("hace 4 d");
  });

  it("reads Catalan on ca", () => {
    expect(since("ca", 0)).toBe("aquest minut");
    expect(since("ca", 30_000)).toBe("fa 1 min");
    expect(since("ca", 59 * MINUTE)).toBe("fa 59 min");
    expect(since("ca", 60 * MINUTE)).toBe("fa 1 h");
    expect(since("ca", 47 * HOUR)).toBe("fa 47 h");
    expect(since("ca", 96 * HOUR)).toBe("fa 4 dies");
  });

  // numeric "auto" is what makes the under-a-minute case a phrase instead of
  // "in 0m", and the same setting names the day before yesterday in Spanish
  // and Catalan. Pinned so the choice is visible if anyone changes the option.
  it("uses the idiomatic phrase where the language has one", () => {
    expect(since("es", 48 * HOUR)).toBe("anteayer");
    expect(since("ca", 48 * HOUR)).toBe("abans-d’ahir");
  });
});

describe("timeUntil", () => {
  // A deadline exactly at `now` has already passed; one millisecond of life
  // left is still a deadline, and Intl has a phrase for it.
  it("is expired at the deadline and formatted one millisecond before it", () => {
    expect(until("en", 0)).toEqual({ kind: "expired" });
    expect(until("en", -1)).toEqual({ kind: "expired" });
    expect(until("ca", -HOUR)).toEqual({ kind: "expired" });
    expect(until("en", 1)).toEqual({ kind: "formatted", text: "this hour" });
  });

  // hours = round(ms / 3600000), so anything under half an hour is 0 and gets
  // the phrase. This bucket is new: the hand-built formatter printed "0h".
  it("leaves the under-an-hour phrase at 30m", () => {
    expect(until("en", 29 * MINUTE + 59_999)).toEqual({
      kind: "formatted",
      text: "this hour",
    });
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
    expect(until("es", 1)).toEqual({ kind: "formatted", text: "esta hora" });
    expect(until("ca", 1)).toEqual({ kind: "formatted", text: "aquesta hora" });
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
