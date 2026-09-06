// Where isomux.com serves each language.
//
// The public site is six static pages: the landing and the hosted page, each
// in English, Spanish and Catalan. English sits at the root; the other two sit
// under a language directory. This module is the one place that says so, so
// the office (ui/office/Floor.tsx, which sends a boss to the site) and the
// page checker (scripts/site-i18n-check.test.ts) cannot drift apart.
//
// Like time.ts and number.ts it holds no catalog words: it turns a language
// into a value. Callers take the language from the translator they already
// have (ruling 8: no second resolver).

import type { SupportedLanguageCode } from "../languages.ts";

export const SITE_ORIGIN = "https://isomux.com";

/**
 * The path prefix each language's copy of a page lives under. English is the
 * empty string: its pages keep the URLs they have always had, so no existing
 * link, canonical or sitemap entry moves, and landingUrl("en") is the exact
 * string the office already opened.
 */
export const SITE_LANGUAGE_PATH: Record<SupportedLanguageCode, string> = {
  en: "",
  es: "/es",
  ca: "/ca",
};

/** The landing page in `language`, absolute. */
export function landingUrl(language: SupportedLanguageCode): string {
  return SITE_ORIGIN + SITE_LANGUAGE_PATH[language];
}

/** The hosted page in `language`, absolute. */
export function hostedUrl(language: SupportedLanguageCode): string {
  return `${SITE_ORIGIN + SITE_LANGUAGE_PATH[language]}/hosted`;
}
