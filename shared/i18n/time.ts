// Relative and absolute time in the reader's language (internal-docs/i18n-loop.md,
// ruling 12), on Intl.RelativeTimeFormat and Intl.DateTimeFormat. Introduced in
// S3 for the access panes; S6 reuses it for the rest of the UI rather than
// adding a second one.
//
// Pure and React-free, like translate.ts: the language always arrives as an
// argument and nothing here reads a global.
//
// No words live here (ruling 7: the catalogs are the one source of truth).
// Where a case has no Intl output at all - a deadline already past - the helper
// returns a discriminated result and the CALLER renders the word through t().
// The thresholds are the ones the hand-built formatters in access-shared.tsx
// used, kept so the tables read the same at the same ages; only the rendering
// moved to Intl.

import type { SupportedLanguageCode } from "../languages.ts";

// "narrow" because these sit in compact tables, and numeric "auto" so the
// zero-minutes case reads as a phrase ("this minute") rather than "in 0m".
const RELATIVE_OPTIONS: Intl.RelativeTimeFormatOptions = {
  style: "narrow",
  numeric: "auto",
};
const ABSOLUTE_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "short",
  timeStyle: "short",
};

// Intl formatters are expensive to build and hold no per-call state, so one
// per language lives for the life of the page, as the translators do.
const relativeFormatters = new Map<
  SupportedLanguageCode,
  Intl.RelativeTimeFormat
>();
const absoluteFormatters = new Map<
  SupportedLanguageCode,
  Intl.DateTimeFormat
>();

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
): Intl.DateTimeFormat {
  const cached = absoluteFormatters.get(language);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(language, ABSOLUTE_OPTIONS);
  absoluteFormatters.set(language, made);
  return made;
}

/**
 * A deadline that has passed has no Intl rendering, so it comes back as its own
 * kind and the caller supplies the word from the catalog.
 */
export type TimeUntil =
  | { kind: "expired" }
  | { kind: "formatted"; text: string };

/**
 * How long ago `ts` was: minutes under an hour, hours under two days, then
 * days. Rounded at every step, as the hand-built version was, so the same
 * instant still lands in the same bucket.
 */
export function timeSince(
  language: SupportedLanguageCode,
  ts: number,
  now: number = Date.now(),
): string {
  const format = relativeFormatter(language);
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return format.format(0, "minute");
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

/**
 * How long is left until `ts`: hours under two days, then days. A deadline at
 * or before `now` is "expired" - the one case with no Intl form.
 */
export function timeUntil(
  language: SupportedLanguageCode,
  ts: number,
  now: number = Date.now(),
): TimeUntil {
  const remaining = ts - now;
  if (remaining <= 0) return { kind: "expired" };
  const format = relativeFormatter(language);
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 48)
    return { kind: "formatted", text: format.format(hours, "hour") };
  return {
    kind: "formatted",
    text: format.format(Math.round(hours / 24), "day"),
  };
}

/** `ts` as a date and time in the reader's locale, in the machine's zone. */
export function absoluteTime(
  language: SupportedLanguageCode,
  ts: number,
): string {
  return absoluteFormatter(language).format(new Date(ts));
}
