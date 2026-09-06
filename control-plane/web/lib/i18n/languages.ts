// The languages the hosted storefront speaks, and how a request picks one.
//
// A DELIBERATE COPY of `shared/languages.ts`, not an import. This app may not
// reach outside `control-plane/web` for runtime code: `control-plane/
// web-boundary.test.ts` walks every file here and refuses any `../..` import
// outside a fixed allow list, because the storefront's module graph is a blast
// radius rather than a convenience. The office's own copy stays the source of
// truth for the office; when a language is added there, it is added here too.
//
// Only what a storefront needs came across. The office's speech locales and
// voice fallbacks did not: nothing here listens or speaks.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "ca", label: "Català" },
] as const;

export type SupportedLanguageCode =
  (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: SupportedLanguageCode = "en";

/** The cookie the language switch writes. Read on the server and the client. */
export const LANGUAGE_COOKIE = "isomux_lang";

export function isSupportedLanguage(
  value: unknown,
): value is SupportedLanguageCode {
  return (
    typeof value === "string" &&
    SUPPORTED_LANGUAGES.some((l) => l.code === value)
  );
}

/** A supported code from a stored cookie value, or null. */
export function languageFromCookie(
  value: string | null | undefined,
): SupportedLanguageCode | null {
  return isSupportedLanguage(value) ? value : null;
}

// Negotiate a language from an Accept-Language header. Copied from
// `shared/languages.ts` (S9), including its strictness: a quality value is read
// only when it is RFC 7231 shaped, `q=0` means "not acceptable" and is skipped,
// a wildcard names no language and is skipped, and equal quality keeps the
// header's own order. Nothing supported, absent or unparseable reads English.
export function languageFromAcceptLanguage(
  header: string | null | undefined,
): SupportedLanguageCode {
  if (typeof header !== "string") return DEFAULT_LANGUAGE;
  let best: { code: SupportedLanguageCode; q: number } | null = null;
  for (const element of header.split(",")) {
    const [rawTag, ...params] = element.split(";");
    const tag = (rawTag ?? "").trim().toLowerCase();
    // Language-range grammar (RFC 4647 basic): alphabetic primary subtag,
    // alphanumeric subtags. "*" and "es_ES" fail it and are skipped.
    if (!/^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(tag)) continue;
    const quality = qualityOf(params);
    if (quality === null || quality === 0) continue;
    const primary = tag.split("-")[0];
    const match = SUPPORTED_LANGUAGES.find((l) => l.code === primary);
    if (!match) continue;
    // Strict >: the first element of a tie wins, so header order is preserved.
    if (!best || quality > best.q) best = { code: match.code, q: quality };
  }
  return best?.code ?? DEFAULT_LANGUAGE;
}

// The q of one header element: 1 when it carries none, the value when it is
// well formed, and null when it is not - a malformed parameter list is a
// malformed element, so its caller drops the whole entry.
function qualityOf(params: string[]): number | null {
  let quality: number | null = null;
  for (const param of params) {
    const [rawName, ...rest] = param.split("=");
    const name = (rawName ?? "").trim().toLowerCase();
    if (name !== "q") continue; // an extension parameter, not our business
    if (quality !== null) return null; // two q values: malformed
    const value = rest.join("=").trim();
    if (!/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(value)) return null;
    quality = Number(value);
  }
  return quality ?? 1;
}

/**
 * The language a BROWSER asks for, in the browser's own preference order.
 *
 * `navigator.languages` and not `navigator.language`: the first entry is only
 * the top preference, and a visitor whose list is ["fr-FR", "ca", "en"] reads
 * Catalan rather than English. `navigator.language` alone would answer French,
 * find nothing, and hide the supported second preference. The single value is
 * the fallback for a browser that reports no list at all.
 *
 * This is the client-side twin of languageFromAcceptLanguage, for the two
 * prerendered pages, which have no request to read a header from. It carries no
 * quality values because the DOM API has none: the order IS the preference.
 */
export function languageFromNavigator(
  languages: readonly string[] | null | undefined,
  single?: string | null,
): SupportedLanguageCode {
  const ordered =
    languages && languages.length > 0 ? languages : single ? [single] : [];
  for (const tag of ordered) {
    if (typeof tag !== "string") continue;
    const primary = tag.split("-")[0]?.toLowerCase();
    const match = SUPPORTED_LANGUAGES.find((l) => l.code === primary);
    if (match) return match.code;
  }
  return DEFAULT_LANGUAGE;
}
