// Language negotiation for the storefront: the header on the server, the
// browser's own ordered preferences on the two prerendered pages, and the
// cookie that beats both.

import { expect, test } from "bun:test";
import {
  languageFromAcceptLanguage,
  languageFromCookie,
  languageFromNavigator,
} from "./languages";
import { languageCookieValue } from "./use-language";

test("Accept-Language picks the highest-quality supported language", () => {
  expect(languageFromAcceptLanguage("es-ES")).toBe("es");
  expect(languageFromAcceptLanguage("ca")).toBe("ca");
  expect(languageFromAcceptLanguage("en-GB")).toBe("en");
  // Quality decides, not header order.
  expect(languageFromAcceptLanguage("es;q=0.8, ca;q=0.9")).toBe("ca");
  expect(languageFromAcceptLanguage("ca;q=0.4, es;q=0.9")).toBe("es");
  // Equal quality keeps the header's own order.
  expect(languageFromAcceptLanguage("ca, es")).toBe("ca");
});

test("Accept-Language falls back to English on anything it cannot use", () => {
  expect(languageFromAcceptLanguage("fr")).toBe("en");
  expect(languageFromAcceptLanguage("")).toBe("en");
  expect(languageFromAcceptLanguage("   ")).toBe("en");
  expect(languageFromAcceptLanguage("*")).toBe("en");
  expect(languageFromAcceptLanguage("!!!;;;")).toBe("en");
  expect(languageFromAcceptLanguage(null)).toBe("en");
  expect(languageFromAcceptLanguage(undefined)).toBe("en");
  // q=0 is "not acceptable", so a Spanish entry at zero is not a match.
  expect(languageFromAcceptLanguage("es;q=0")).toBe("en");
  // A malformed q drops its whole entry rather than becoming a prefix number.
  expect(languageFromAcceptLanguage("es;q=0.9abc")).toBe("en");
  expect(languageFromAcceptLanguage("es;q=0.9abc, ca")).toBe("ca");
  // An underscore is not a language range.
  expect(languageFromAcceptLanguage("es_ES")).toBe("en");
});

test("the browser's list is read in preference order, not first entry only", () => {
  // THE CASE THE SINGLE VALUE HIDES: an unsupported first preference must not
  // shadow a supported second one.
  expect(languageFromNavigator(["fr-FR", "ca", "en"], "fr-FR")).toBe("ca");
  expect(languageFromNavigator(["ca-ES", "es"], "ca-ES")).toBe("ca");
  expect(languageFromNavigator(["es-419"], "es-419")).toBe("es");
  expect(languageFromNavigator(["de", "fr"], "de")).toBe("en");
  // No list: the single value is the fallback.
  expect(languageFromNavigator(undefined, "es-MX")).toBe("es");
  expect(languageFromNavigator([], "ca")).toBe("ca");
  expect(languageFromNavigator(null, null)).toBe("en");
});

test("the cookie is read only when it names a language we serve", () => {
  expect(languageFromCookie("es")).toBe("es");
  expect(languageFromCookie("ca")).toBe("ca");
  expect(languageFromCookie("en")).toBe("en");
  expect(languageFromCookie("fr")).toBeNull();
  expect(languageFromCookie("")).toBeNull();
  expect(languageFromCookie(undefined)).toBeNull();
});

test("the cookie is found among other cookies, and only by its own name", () => {
  expect(languageCookieValue("isomux_lang=ca")).toBe("ca");
  expect(languageCookieValue("a=1; isomux_lang=es; b=2")).toBe("es");
  expect(languageCookieValue(" isomux_lang = ca ")).toBe("ca");
  expect(languageCookieValue("other_isomux_lang=ca")).toBeNull();
  expect(languageCookieValue("isomux_lang=fr")).toBeNull();
  expect(languageCookieValue("")).toBeNull();
});
