import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "../../shared/languages.ts";
import {
  translatorFor,
  type MessageKey,
  type ParamsFor,
  type Translator,
} from "../../shared/i18n/translate.ts";

export const SHIPPED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map(
  ({ code }) => code,
);

export function translationsFor<K extends MessageKey>(
  key: K,
  ...params: ParamsFor<K>
): Record<SupportedLanguageCode, string> {
  return Object.fromEntries(
    SHIPPED_LANGUAGE_CODES.map((code) => [
      code,
      translatorFor(code).t(key, ...params),
    ]),
  ) as Record<SupportedLanguageCode, string>;
}

export function translationsFrom(
  resolve: (translator: Translator) => string,
): Record<SupportedLanguageCode, string> {
  return Object.fromEntries(
    SHIPPED_LANGUAGE_CODES.map((code) => [code, resolve(translatorFor(code))]),
  ) as Record<SupportedLanguageCode, string>;
}
