"use client";

import { useEffect } from "react";
import type { SupportedLanguageCode } from "./languages";

/**
 * Keeps the document's root `lang` on the language the PAGE is actually in.
 *
 * The root layout renders `<html lang="en">` and cannot do better: reading the
 * request there would make every route dynamic, and `/` and `/signin` are
 * prerendered under `dynamic = "error"` precisely so a CDN can hold them. So
 * each page declares its own language and this moves the attribute:
 *
 *   - `/` and `/signin` pass what `useLanguage()` resolved, so the attribute
 *     changes in the same commit as the text and the two never disagree.
 *   - `/signup` and `/office` pass the language the SERVER resolved, so the
 *     attribute matches the text the server already sent.
 *   - `/ops` passes English, which is what puts the attribute back after a
 *     client navigation away from a translated page.
 *
 * It renders nothing. The translated regions of the server-rendered pages also
 * carry their own `lang`, so a reader with no JavaScript still gets the
 * attribute on the text itself.
 */
export function DocumentLanguage({
  language,
}: {
  language: SupportedLanguageCode;
}): null {
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return null;
}
