// Pure language-preference helpers (task e80c39c4). No browser, no server -
// detectBrowserLanguage takes navigator.language as an argument precisely so
// it can be tested like this.

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  detectBrowserLanguage,
  languageFromAcceptLanguage,
  isSupportedLanguage,
  languageOption,
  speechLocaleFor,
  languageLabelFor,
  type SupportedLanguageCode,
} from "./languages.ts";

describe("isSupportedLanguage", () => {
  it("accepts exactly the offered codes", () => {
    for (const l of SUPPORTED_LANGUAGES)
      expect(isSupportedLanguage(l.code)).toBe(true);
    expect(isSupportedLanguage("fr")).toBe(false);
    expect(isSupportedLanguage("EN")).toBe(false); // codes are stored lowercase
    expect(isSupportedLanguage("")).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
    expect(isSupportedLanguage(7)).toBe(false);
  });

  it("the default language is one we offer", () => {
    expect(isSupportedLanguage(DEFAULT_LANGUAGE)).toBe(true);
  });

  it("offers English, Spanish and Catalan, in that order, each under its own name", () => {
    // The picker's contract: the order is the order shown, and the label is
    // the language's name in itself, not in English.
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toEqual(["en", "es", "ca"]);
    expect(SUPPORTED_LANGUAGES.map((l) => l.label)).toEqual([
      "English",
      "Español",
      "Català",
    ]);
  });
});

describe("detectBrowserLanguage", () => {
  it("matches on the primary subtag, case-insensitively", () => {
    expect(detectBrowserLanguage("es")).toBe("es");
    expect(detectBrowserLanguage("es-ES")).toBe("es");
    expect(detectBrowserLanguage("es-419")).toBe("es");
    expect(detectBrowserLanguage("ES-mx")).toBe("es");
    expect(detectBrowserLanguage("en-GB")).toBe("en");
    expect(detectBrowserLanguage("ca-ES")).toBe("ca");
    expect(detectBrowserLanguage("ca")).toBe("ca");
  });

  it("returns null for a language we don't offer or a missing value", () => {
    expect(detectBrowserLanguage("fr-FR")).toBe(null);
    expect(detectBrowserLanguage("")).toBe(null);
    expect(detectBrowserLanguage(null)).toBe(null);
    expect(detectBrowserLanguage(undefined)).toBe(null);
  });
});

describe("languageOption", () => {
  it("resolves a code, and null for absent or unknown", () => {
    expect(languageOption("es")?.englishName).toBe("Spanish");
    expect(languageOption("ca")?.englishName).toBe("Catalan");
    expect(languageOption(null)).toBe(null);
    // A hand-edited users.json can hold a code the type system says is
    // impossible; the runtime guard still has to answer.
    expect(languageOption("fr" as SupportedLanguageCode)).toBe(null);
  });
});

describe("languageLabelFor", () => {
  it("names an offered language in English, and passes anything else through", () => {
    expect(languageLabelFor("es-ES")).toBe("Spanish");
    expect(languageLabelFor("es")).toBe("Spanish");
    expect(languageLabelFor("en-GB")).toBe("English");
    expect(languageLabelFor("ca-ES")).toBe("Catalan");
    // Reachable through the navigator fallback, so it must not render as
    // "undefined" or crash.
    expect(languageLabelFor("fr-FR")).toBe("fr-FR");
  });
});

describe("speechLocaleFor", () => {
  it("an explicit preference wins over the browser", () => {
    expect(speechLocaleFor("es", "en-US")).toBe("es-ES");
    expect(speechLocaleFor("en", "es-ES")).toBe("en-US");
    expect(speechLocaleFor("ca", "en-US")).toBe("ca-ES");
  });

  it("with no preference it follows the browser verbatim", () => {
    // Deliberately NOT collapsed to en-US: a French browser should dictate in
    // French even though French isn't an offered preference.
    expect(speechLocaleFor(null, "fr-FR")).toBe("fr-FR");
    expect(speechLocaleFor(null, "en-GB")).toBe("en-GB");
  });

  it("falls back to en-US only when the browser reports nothing usable", () => {
    expect(speechLocaleFor(null, null)).toBe("en-US");
    expect(speechLocaleFor(null, "")).toBe("en-US");
    expect(speechLocaleFor(null, "   ")).toBe("en-US");
  });

  it("an unknown stored code degrades to the browser value", () => {
    expect(speechLocaleFor("klingon" as SupportedLanguageCode, "es-ES")).toBe(
      "es-ES",
    );
  });
});

// The pre-sign-in pages have no stored preference to read, so the header is
// the whole input (internal-docs/i18n-loop.md, S9).
describe("languageFromAcceptLanguage", () => {
  it("takes the primary subtag of a language we offer", () => {
    expect(languageFromAcceptLanguage("es-ES")).toBe("es");
    expect(languageFromAcceptLanguage("ca")).toBe("ca");
    expect(languageFromAcceptLanguage("en-GB")).toBe("en");
    expect(languageFromAcceptLanguage("ES-es")).toBe("es");
  });

  it("prefers the highest quality value", () => {
    expect(languageFromAcceptLanguage("es;q=0.8, ca;q=0.9")).toBe("ca");
    expect(languageFromAcceptLanguage("ca;q=0.1, es;q=0.7")).toBe("es");
    expect(languageFromAcceptLanguage(" es ; q=0.9 , ca ")).toBe("ca");
  });

  it("keeps the header's own order when the quality ties", () => {
    // Two languages a browser wants equally: the one it named first wins,
    // which is what every other Accept-* negotiation does.
    expect(languageFromAcceptLanguage("es, ca")).toBe("es");
    expect(languageFromAcceptLanguage("ca, es")).toBe("ca");
    expect(languageFromAcceptLanguage("ca;q=0.5, es;q=0.5")).toBe("ca");
  });

  it("skips what it cannot use and keeps looking", () => {
    expect(languageFromAcceptLanguage("fr, de;q=0.9, ca;q=0.1")).toBe("ca");
    expect(languageFromAcceptLanguage("*;q=0.1, es;q=0.2")).toBe("es");
    // q=0 is "not acceptable", not "least preferred". The first two cases
    // have no other supported language to fall on, so only a rejected ca can
    // produce English; the third proves the search carries on past it.
    expect(languageFromAcceptLanguage("ca;q=0")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("ca;q=0, fr")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("ca;q=0, es")).toBe("es");
  });

  it("drops an element whose quality is not a quality value", () => {
    // parseFloat("0.9abc") is 0.9; a prefix is not a q, so the element goes.
    expect(languageFromAcceptLanguage("ca;q=0.9abc, es;q=0.1")).toBe("es");
    expect(languageFromAcceptLanguage("ca;q=2, es;q=0.1")).toBe("es");
    expect(languageFromAcceptLanguage("ca;q=, es;q=0.1")).toBe("es");
    expect(languageFromAcceptLanguage("ca;q=0.5;q=0.6, es;q=0.1")).toBe("es");
    // An extension parameter is not our business and does not spoil the entry.
    expect(languageFromAcceptLanguage("ca;level=1, es;q=0.9")).toBe("ca");
  });

  it("reads English when the header offers nothing we have", () => {
    expect(languageFromAcceptLanguage("fr")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("*")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("   ")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage(",,;;")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("es_ES")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage("\u{1f4a5}")).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(languageFromAcceptLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
  });
});
