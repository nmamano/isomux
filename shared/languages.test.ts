// Pure language-preference helpers (task e80c39c4). No browser, no server -
// detectBrowserLanguage takes navigator.language as an argument precisely so
// it can be tested like this.

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  detectBrowserLanguage,
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
