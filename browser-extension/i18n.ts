// The extension's translator. The build keeps only the browser.* catalog keys
// (extensionCatalogs in scripts/build-browser-extension.ts), so the key types
// here stop a key the extension build would not ship.
import { CATALOGS, translatorFor } from "../shared/i18n/translate";
import type {
  MessageKey,
  ParamsFor,
  PlainMessageKey,
} from "../shared/i18n/translate";
import type { SupportedLanguageCode } from "../shared/languages";

export type ExtensionKey = Extract<MessageKey, `browser.${string}`>;
export type ExtensionPlainKey = Extract<PlainMessageKey, `browser.${string}`>;

const code = navigator.language.split("-")[0];
export const language: SupportedLanguageCode =
  code in CATALOGS ? (code as SupportedLanguageCode) : "en";
export const t: <K extends ExtensionKey>(
  key: K,
  ...params: ParamsFor<K>
) => string = translatorFor(language).t;
