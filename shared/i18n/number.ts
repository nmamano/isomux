// Numbers, money and byte sizes in the reader's language (internal-docs/i18n-loop.md,
// ruling 12), on Intl.NumberFormat. Introduced in S6 for the office pages, the
// storage panel and the context battery.
//
// Pure and React-free, like translate.ts and time.ts: the language always
// arrives as an argument and nothing here reads a global.
//
// No words live here (ruling 7). The one case with nothing to render - a size
// that is not a size - comes back as null and the CALLER words it through t().
// The unit SYMBOLS are not words: B, KB, MB and GB are symbols and stay as
// they are in every language (ruling 11). Intl's own style:"unit" is not used
// for them because it renders the DECIMAL units ("1.4 kB"), which would both
// change the English bytes and misname a binary measurement.

import type { SupportedLanguageCode } from "../languages.ts";

// One formatter per language and precision for the life of the page, as the
// translators and the time formatters are: they are expensive to build and
// hold no per-call state.
const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(
  language: SupportedLanguageCode,
  fractionDigits: number | null,
): Intl.NumberFormat {
  const cacheKey = `${language}|${fractionDigits ?? "auto"}`;
  const cached = numberFormatters.get(cacheKey);
  if (cached) return cached;
  const made = new Intl.NumberFormat(
    language,
    fractionDigits === null
      ? undefined
      : {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        },
  );
  numberFormatters.set(cacheKey, made);
  return made;
}

/** `value` with the grouping and decimal marks of the reader's language. */
export function formatNumber(
  language: SupportedLanguageCode,
  value: number,
): string {
  return numberFormatter(language, null).format(value);
}

/**
 * `value` to exactly `fractionDigits` places, in the reader's marks. What
 * toFixed used to do for a compact count, which printed an English decimal
 * point in every language.
 */
export function formatDecimal(
  language: SupportedLanguageCode,
  value: number,
  fractionDigits: number,
): string {
  return numberFormatter(language, fractionDigits).format(value);
}

// Money is a THIRD formatter shape: the currency symbol, its side of the
// number and the space between them all belong to the language, which is why
// the symbol cannot be a literal the way B/KB/MB/GB are. Isomux reports its
// spend in US dollars whoever is reading, so the currency is fixed and only
// its rendering moves: "$12.34" in English, "12,34 US$" in Spanish.
const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** `value` as an amount in US dollars, to exactly `fractionDigits` places. */
export function formatMoneyUSD(
  language: SupportedLanguageCode,
  value: number,
  fractionDigits: number,
): string {
  const cacheKey = `${language}|${fractionDigits}`;
  const cached = moneyFormatters.get(cacheKey);
  if (cached) return cached.format(value);
  const made = new Intl.NumberFormat(language, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  moneyFormatters.set(cacheKey, made);
  return made.format(value);
}

// Binary units, as shared/format-human.ts has always measured them: the panel
// and the /isomux-storage report read the same bytes, so they divide by the
// same 1024.
const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/**
 * `bytes` as a size a person reads: binary units, exactly one decimal above
 * the byte branch, the symbol appended as itself. null when the input is not
 * a size at all - the caller supplies that word from the catalog.
 */
export function formatBytes(
  language: SupportedLanguageCode,
  bytes: number,
): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < KB) return `${formatNumber(language, bytes)} B`;
  const one = numberFormatter(language, 1);
  if (bytes < MB) return `${one.format(bytes / KB)} KB`;
  if (bytes < GB) return `${one.format(bytes / MB)} MB`;
  return `${one.format(bytes / GB)} GB`;
}
