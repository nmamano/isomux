// Relative and absolute time in the reader's language (internal-docs/i18n-loop.md,
// ruling 12), on Intl.RelativeTimeFormat and Intl.DateTimeFormat. Introduced in
// S3 for the access panes; S6 reuses it for the rest of the UI rather than
// adding a second one.
//
// Pure and React-free, like translate.ts: the language always arrives as an
// argument and nothing here reads a global.
//
// No words live here (ruling 7: the catalogs are the one source of truth).
// Where a case has no Intl output worth showing - an age under a minute, a
// deadline under an hour off or already past - the helper returns a
// discriminated result and the CALLER renders the word through t().
// The thresholds are the ones the hand-built formatters in access-shared.tsx
// used, kept so the tables read the same at the same ages; only the rendering
// moved to Intl.

import type { SupportedLanguageCode } from "../languages.ts";

// "narrow" because these sit in compact tables, and numeric "always" so no
// language slips an idiomatic phrase into a column: "auto" turns the zero and
// the two-day cases into "this minute", "this hour", "anteayer" and
// "abans-d'ahir" (ruling 17). The two cases that then have no useful number -
// under a minute ago, under an hour left - never reach Intl at all; they come
// back as their own kinds below and the caller words them from the catalog.
const RELATIVE_OPTIONS: Intl.RelativeTimeFormatOptions = {
  style: "narrow",
  numeric: "always",
};
/**
 * The date and time shapes the office renders, each named for what it shows
 * rather than for the surface that first wanted it. S6 moved every hand-built
 * toLocale* call onto this set; the OPTIONS are the ones those call sites
 * passed, so each surface reads the same way it did, in the reader's language
 * instead of the browser's.
 */
export type DateShape =
  | "clock"
  | "monthDay"
  | "monthDayTime"
  | "date"
  | "dateTime"
  | "dateTimeSeconds"
  | "fullDate";

const SHAPE_OPTIONS: Record<DateShape, Intl.DateTimeFormatOptions> = {
  clock: { hour: "2-digit", minute: "2-digit" },
  monthDay: { month: "short", day: "numeric" },
  monthDayTime: {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
  date: { year: "numeric", month: "numeric", day: "numeric" },
  dateTime: { dateStyle: "short", timeStyle: "short" },
  dateTimeSeconds: {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  },
  fullDate: { year: "numeric", month: "short", day: "numeric" },
};

// Intl formatters are expensive to build and hold no per-call state, so one
// per language lives for the life of the page, as the translators do.
const relativeFormatters = new Map<
  SupportedLanguageCode,
  Intl.RelativeTimeFormat
>();
// Keyed by language AND shape: one formatter per pair, built once.
const absoluteFormatters = new Map<string, Intl.DateTimeFormat>();

function relativeFormatter(
  language: SupportedLanguageCode,
): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(language);
  if (cached) return cached;
  const made = new Intl.RelativeTimeFormat(language, RELATIVE_OPTIONS);
  relativeFormatters.set(language, made);
  return made;
}

function absoluteFormatter(
  language: SupportedLanguageCode,
  shape: DateShape,
): Intl.DateTimeFormat {
  const cacheKey = `${language}|${shape}`;
  const cached = absoluteFormatters.get(cacheKey);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(language, SHAPE_OPTIONS[shape]);
  absoluteFormatters.set(cacheKey, made);
  return made;
}

/**
 * An age under a minute has no useful Intl rendering under numeric "always"
 * ("0m ago"), so it comes back as its own kind and the caller supplies the
 * word from the catalog.
 */
export type TimeSince = { kind: "now" } | { kind: "formatted"; text: string };

/**
 * A deadline that has passed has no Intl rendering, and one under an hour off
 * would read "in 0h", so both come back as their own kinds and the caller
 * supplies the words from the catalog.
 */
export type TimeUntil =
  | { kind: "expired" }
  | { kind: "underHour" }
  | { kind: "formatted"; text: string };

/**
 * How long ago `ts` was: minutes under an hour, hours under two days, then
 * days. Rounded at every step, as the hand-built version was, so the same
 * instant still lands in the same bucket. Under a minute is "now" - the one
 * case with no number worth printing.
 */
export function timeSince(
  language: SupportedLanguageCode,
  ts: number,
  now: number = Date.now(),
): TimeSince {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return { kind: "now" };
  const format = relativeFormatter(language);
  if (minutes < 60)
    return { kind: "formatted", text: format.format(-minutes, "minute") };
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return { kind: "formatted", text: format.format(-hours, "hour") };
  return {
    kind: "formatted",
    text: format.format(-Math.round(hours / 24), "day"),
  };
}

/**
 * How long is left until `ts`: hours under two days, then days. A deadline at
 * or before `now` is "expired", and one less than half an hour off rounds to
 * zero hours; neither has a form worth taking from Intl.
 */
export function timeUntil(
  language: SupportedLanguageCode,
  ts: number,
  now: number = Date.now(),
): TimeUntil {
  const remaining = ts - now;
  if (remaining <= 0) return { kind: "expired" };
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 1) return { kind: "underHour" };
  const format = relativeFormatter(language);
  if (hours < 48)
    return { kind: "formatted", text: format.format(hours, "hour") };
  return {
    kind: "formatted",
    text: format.format(Math.round(hours / 24), "day"),
  };
}

/**
 * How long is left until `ts`, to the MINUTE: minutes under an hour, then
 * hours, then days. timeUntil above is the coarse one, built for an expiry
 * table where hours are the smallest reading that matters; a countdown to the
 * next scheduled run has to say 45 minutes rather than round it away. Both are
 * kept because the choice belongs to the surface, not to the formatter.
 */
export function timeUntilFine(
  language: SupportedLanguageCode,
  ts: number,
  now: number = Date.now(),
): TimeUntil {
  const remaining = ts - now;
  if (remaining <= 0) return { kind: "expired" };
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 1) return { kind: "underHour" };
  const format = relativeFormatter(language);
  if (minutes < 60)
    return { kind: "formatted", text: format.format(minutes, "minute") };
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return { kind: "formatted", text: format.format(hours, "hour") };
  return {
    kind: "formatted",
    text: format.format(Math.round(hours / 24), "day"),
  };
}

/** `ts` in the shape asked for, in the reader's locale and the machine's zone. */
export function formatDateTime(
  language: SupportedLanguageCode,
  ts: number,
  shape: DateShape,
): string {
  return absoluteFormatter(language, shape).format(new Date(ts));
}

/**
 * `ts` as a short date and time. The name S3 gave the shape its access tables
 * use, kept so those call sites read as they did.
 */
export function absoluteTime(
  language: SupportedLanguageCode,
  ts: number,
): string {
  return formatDateTime(language, ts, "dateTime");
}
