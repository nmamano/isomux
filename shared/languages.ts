// The languages a user can pick in their per-user preferences.
//
// One preference drives four surfaces: the language agents write their replies
// in (a clause in buildSystemPrompt), the locale voice-to-text listens for, the
// voice used for text-to-speech, and the language the office UI itself reads
// in (the catalogs under shared/i18n/, through the context in ui/i18n.tsx).
//
// `speechLocale` is a full BCP-47 tag because both browser speech APIs want a
// region ("es", alone, is not something SpeechRecognition accepts everywhere);
// `code` is the bare primary subtag, which is what we persist. `englishName`
// feeds the system-prompt clause, so adding a language needs no new prose.

// `as const` (not a LanguageOption[] annotation) so SupportedLanguageCode below
// can be DERIVED from this table: adding a language here widens the type
// everywhere, and a typo'd code becomes a compile error rather than a value
// that only fails at runtime.
export const SUPPORTED_LANGUAGES = [
  {
    code: "en",
    label: "English",
    englishName: "English",
    speechLocale: "en-US",
  },
  {
    code: "es",
    label: "Español",
    englishName: "Spanish",
    speechLocale: "es-ES",
  },
  {
    code: "ca",
    label: "Català",
    englishName: "Catalan",
    speechLocale: "ca-ES",
  },
] as const;

export type SupportedLanguageCode =
  (typeof SUPPORTED_LANGUAGES)[number]["code"];
export type LanguageOption = (typeof SUPPORTED_LANGUAGES)[number];

// The language agents already answer in with no clause at all, so a user on it
// gets no system-prompt clause and no behavior change.
export const DEFAULT_LANGUAGE: SupportedLanguageCode = "en";

export function isSupportedLanguage(
  value: unknown,
): value is SupportedLanguageCode {
  return (
    typeof value === "string" &&
    SUPPORTED_LANGUAGES.some((l) => l.code === value)
  );
}

export function languageOption(
  code: SupportedLanguageCode | null,
): LanguageOption | null {
  if (!code) return null;
  return SUPPORTED_LANGUAGES.find((l) => l.code === code) ?? null;
}

// Map a browser language tag ("es-419", "ES", "en-GB") onto a supported code,
// or null when we don't offer it. Pure so it can be unit-tested without a
// browser; the caller supplies navigator.language.
export function detectBrowserLanguage(
  navigatorLanguage: string | null | undefined,
): SupportedLanguageCode | null {
  if (typeof navigatorLanguage !== "string") return null;
  const primary = navigatorLanguage.split("-")[0]?.toLowerCase();
  if (!primary) return null;
  return SUPPORTED_LANGUAGES.find((l) => l.code === primary)?.code ?? null;
}

// A human-readable English name for a locale tag, for UI that has to explain
// what it can't do ("No Spanish voice is installed"). Falls back to the raw tag
// for locales we don't offer as a preference - a user whose browser is French
// can still reach the speech surfaces through the navigator fallback, and
// "No fr-FR voice" beats a wrong or missing name.
export function languageLabelFor(locale: string): string {
  const primary = locale.split("-")[0]?.toLowerCase();
  const match = SUPPORTED_LANGUAGES.find((l) => l.code === primary);
  return match ? match.englishName : locale;
}

// The locale the browser speech APIs should use for this user. An explicit
// preference wins; otherwise fall back to whatever the browser reports, which
// is closer to right than pinning everyone to en-US (what voice input did
// before this preference existed).
export function speechLocaleFor(
  language: SupportedLanguageCode | null,
  navigatorLanguage: string | null | undefined,
): string {
  const picked = languageOption(language);
  if (picked) return picked.speechLocale;
  if (typeof navigatorLanguage === "string" && navigatorLanguage.trim()) {
    return navigatorLanguage;
  }
  return "en-US";
}

// Negotiate a language from an Accept-Language header, for the pre-sign-in
// pages: a visitor with no identity has no stored preference, and the header is
// the only thing the request carries about what they read (S9).
//
// Deliberately strict where the header is malformed: a quality value is read
// only when it is RFC 7231 shaped (0-1, at most three decimals), so a
// "q=0.9abc" drops its entry instead of silently becoming 0.9 the way a
// parseFloat prefix would. `q=0` means "not acceptable" and is skipped, a
// wildcard (`*`) names no language and is skipped, and equal quality keeps the
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
