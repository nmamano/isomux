// Language negotiation for the storefront: the header on the server, the
// browser's own ordered preferences on the two prerendered pages, and the
// cookie that beats both.

import { expect, test } from "bun:test";
import {
  languageFromAcceptLanguage,
  languageFromCookie,
  languageFromNavigator,
} from "./languages";

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

test("a region subtag reads as its language; with no list the single value decides", () => {
  // The list order itself is held through its caller, resolveInBrowser
  // (use-language.test.ts).
  expect(languageFromNavigator(["ca-ES", "es"], "ca-ES")).toBe("ca");
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

test("Chinese is supported in headers, browser lists and the cookie value", () => {
  expect(languageFromAcceptLanguage("zh-CN, en;q=0.8")).toBe("zh");
  expect(languageFromNavigator(["fr", "zh-Hans-CN"], "fr")).toBe("zh");
  expect(languageFromCookie("zh")).toBe("zh");
});
