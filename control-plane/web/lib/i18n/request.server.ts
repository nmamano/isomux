// The language a REQUEST reads in, for the pages that render on the server.
//
// Precedence, highest first (PM ruling, 2026-09-06): the cookie the language
// switch writes, then the browser's Accept-Language header, then English. An
// explicit choice a header could beat is not a choice. There is no stored
// customer language: this deployment sends no customer email, so nothing needs
// a language that outlives a browser (control-plane/README.md, "the control
// plane has no customer mailer"), and an unused column on a governed table is a
// schema we would then have to keep.
//
// Server-only, by the `.server.ts` convention this app already uses for
// `lib/services.server.ts`: `next/headers` throws in a client component, and
// the two prerendered pages resolve their language in the browser instead
// (`use-language.ts`).

import { cookies, headers } from "next/headers";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  languageFromAcceptLanguage,
  languageFromCookie,
  type SupportedLanguageCode,
} from "./languages";

export async function languageForRequest(): Promise<SupportedLanguageCode> {
  const chosen = languageFromCookie(
    (await cookies()).get(LANGUAGE_COOKIE)?.value,
  );
  if (chosen) return chosen;
  return languageFromAcceptLanguage(
    (await headers()).get("accept-language") ?? null,
  );
}

/** English, for the pages that are not translated (ops). Named so a reader of
 * a page sees a decision rather than a bare literal. */
export const OPS_LANGUAGE: SupportedLanguageCode = DEFAULT_LANGUAGE;
