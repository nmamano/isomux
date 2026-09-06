// The BROWSER's half of the resolver: what `/` and `/signin` decide after they
// hydrate. `languages.test.ts` covers the pure helpers; this covers the thing
// that calls them, which is where the precedence and the browser's preference
// ORDER actually live.

import { afterEach, describe, expect, test } from "bun:test";
import { resolveInBrowser, writeLanguageCookie } from "./use-language";

const realDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

function put(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

/** A browser with this cookie string and these language preferences. */
function browser(cookie: string, languages: string[]): void {
  put("document", { cookie, documentElement: { lang: "en" } });
  put("navigator", { languages, language: languages[0] ?? "en" });
}

afterEach(() => {
  restore("document", realDocument);
  restore("navigator", realNavigator);
  restore("location", realLocation);
});

describe("resolveInBrowser", () => {
  test("the cookie wins over the browser's own languages", () => {
    browser("isomux_lang=es", ["ca-ES", "ca"]);
    expect(resolveInBrowser()).toBe("es");
    browser("a=1; isomux_lang=en; b=2", ["ca"]);
    expect(resolveInBrowser()).toBe("en");
  });

  test("without a cookie it reads the whole preference list, in order", () => {
    // THE CASE A SINGLE `navigator.language` HIDES: the top preference is one we
    // do not serve, and the second one is.
    browser("", ["fr-FR", "ca", "en"]);
    expect(resolveInBrowser()).toBe("ca");
    browser("", ["es-419"]);
    expect(resolveInBrowser()).toBe("es");
    browser("", ["de", "fr"]);
    expect(resolveInBrowser()).toBe("en");
  });

  test("a cookie naming a language we do not serve is ignored, not obeyed", () => {
    browser("isomux_lang=fr", ["ca"]);
    expect(resolveInBrowser()).toBe("ca");
  });

  test("a malformed cookie value falls back instead of throwing", () => {
    // `decodeURIComponent("%")` throws a URIError, and this runs inside the
    // hydration effect: a throw here would take the page's whole language
    // resolution with it. The three values we write need no decoding at all.
    browser("isomux_lang=%", ["ca"]);
    expect(() => resolveInBrowser()).not.toThrow();
    expect(resolveInBrowser()).toBe("ca");
    browser("isomux_lang=%E4%", ["de"]);
    expect(resolveInBrowser()).toBe("en");
  });

  test("no document at all is English, not a crash", () => {
    restore("document", undefined);
    expect(resolveInBrowser()).toBe("en");
  });
});

describe("writeLanguageCookie", () => {
  test("writes a year-long, path-wide, SameSite=Lax cookie", () => {
    const jar = { cookie: "", documentElement: { lang: "en" } };
    put("document", jar);
    put("location", { protocol: "http:" });
    writeLanguageCookie("ca");
    expect(jar.cookie).toBe(
      "isomux_lang=ca; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  test("adds Secure over HTTPS only, so a local http run still remembers", () => {
    const jar = { cookie: "", documentElement: { lang: "en" } };
    put("document", jar);
    put("location", { protocol: "https:" });
    writeLanguageCookie("es");
    expect(jar.cookie).toBe(
      "isomux_lang=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });
});
