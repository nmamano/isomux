// The languages a user can pick in their per-user preferences (task e80c39c4).
//
// One preference drives three surfaces: the language agents write their replies
// in (a clause in buildSystemPrompt), the locale voice-to-text listens for, and
// the voice used for text-to-speech. The UI chrome itself is NOT translated -
// that was scoped out deliberately.
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
