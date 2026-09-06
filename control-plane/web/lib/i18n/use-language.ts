"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  languageFromCookie,
  languageFromNavigator,
  type SupportedLanguageCode,
} from "./languages";

/**
 * The language for the two PRERENDERED pages, resolved in the browser.
 *
 * `/` and `/signin` are prerendered under `dynamic = "error"` so a CDN can hold
 * their shell, which means they never see a request and cannot read a cookie or
 * a header while they render. This is the client-side twin of
 * `languageForRequest`, and it keeps the same precedence: the switch's cookie,
 * then what the browser asks for, then English.
 *
 * IT RETURNS ENGLISH ON THE FIRST RENDER, always. That is not a limitation to
 * work around: the prerendered bytes are English, so any other first render
 * would be a hydration mismatch. The effect then moves the page to the
 * visitor's language, and DocumentLanguage moves the root `lang` attribute in
 * the same commit, so the attribute never disagrees with the text. A visitor on
 * Spanish or Catalan therefore reads one frame of English first.
 */
export function useLanguage(): SupportedLanguageCode {
  const [language, setLanguage] =
    useState<SupportedLanguageCode>(DEFAULT_LANGUAGE);
  useEffect(() => {
    // The cookie and the browser's language list ARE an external system, and
    // reading them is the whole job of this hook. It runs once, and the first
    // render is English on purpose: see the note above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanguage(resolveInBrowser());
  }, []);
  return language;
}

/**
 * The cookie's value, or null when it is absent or names nothing we serve.
 *
 * NOT decoded. The only values we ever write are `en`, `es` and `ca`, which
 * percent-encoding cannot change, and `decodeURIComponent` THROWS on a
 * malformed sequence - so decoding an attacker-supplied or merely corrupt
 * `isomux_lang=%` would throw out of the hydration effect and take the page's
 * language resolution with it. A value we do not serve is null here, the same
 * answer the server resolver gives.
 */
export function languageCookieValue(
  cookieString: string,
): SupportedLanguageCode | null {
  for (const part of cookieString.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name.trim() !== LANGUAGE_COOKIE) continue;
    return languageFromCookie(rest.join("=").trim());
  }
  return null;
}

/**
 * Remember a chosen language for a year.
 *
 * OUT HERE rather than in the switch's click handler: writing `document.cookie`
 * inside a component is an assignment to something outside it, which the React
 * lint rules refuse, and a plain function is testable besides. `Secure` only
 * over HTTPS, so a local `next start` over http still remembers.
 */
export function writeLanguageCookie(code: SupportedLanguageCode): void {
  const maxAge = 365 * 24 * 60 * 60;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LANGUAGE_COOKIE}=${code}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

/** Cookie, then the browser's ordered preferences, then English. Exported for
 * its unit test and for the language switch, which marks the active choice. */
export function resolveInBrowser(): SupportedLanguageCode {
  if (typeof document === "undefined") return DEFAULT_LANGUAGE;
  const chosen = languageCookieValue(document.cookie);
  if (chosen) return chosen;
  return languageFromNavigator(navigator.languages, navigator.language);
}
