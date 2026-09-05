// Lookup over the catalogs in this directory (internal-docs/i18n-loop.md,
// ruling 4): no library, a typed catalog per language, `{name}` interpolation,
// and explicit one/other plural pairs picked with Intl.PluralRules.
//
// Pure and React-free so both ui/ and server/ can use it: the UI reads a
// translator out of its language context (ui/i18n.tsx), the server builds one
// per request from the user's stored preference (S5). Nothing here reads a
// global; the language always arrives as an argument.
//
// Two layers. `translatorFor(language)` is the API: typed keys, typed
// placeholder parameters, English fallback. Below it, `lookupIn` and
// `pluralIn` are the engine over plain string records; they are exported so
// the plural mechanism can be tested on a fixture catalog before the real one
// carries any plural pair. Application code uses translatorFor.

import { DEFAULT_LANGUAGE, type SupportedLanguageCode } from "../languages.ts";
import { en, type Catalog, type MessageKey } from "./en.ts";
import { es } from "./es.ts";
import { ca } from "./ca.ts";

export type { Catalog, MessageKey };

export const CATALOGS: Record<SupportedLanguageCode, Catalog> = { en, es, ca };

/** Values for the `{name}` placeholders of one message. */
export type Params = Record<string, string | number>;

/** A catalog as the engine sees it: keys to strings, nothing typed. */
export type Messages = Readonly<Record<string, string | undefined>>;

// "{name} owes {count}" -> "name" | "count". Derived from the English text, so
// the parameters a key takes are checked where t() is called. Exported for
// ui/i18n.tsx, whose rich() derives its parts the same way.
export type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? P | Placeholders<Rest>
    : never;

export type EnglishText<K extends MessageKey> = (typeof en)[K];

/**
 * The trailing argument list of t() for one key: nothing when the English
 * text has no placeholder, else one required object naming every placeholder.
 */
export type ParamsFor<K extends MessageKey> = [
  Placeholders<EnglishText<K>>,
] extends [never]
  ? []
  : [Record<Placeholders<EnglishText<K>>, string | number>];

/**
 * The base of every plural pair in the catalog: "agents.count" when both
 * "agents.count.one" and "agents.count.other" exist. A ".one" without its
 * ".other" is not a pair, so it is not a plural key.
 */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends MessageKey
      ? Base
      : never
    : never;
}[MessageKey];

type PluralPlaceholders<K extends PluralKey> = Exclude<
  Placeholders<EnglishText<`${K}.other` & MessageKey>>,
  "count"
>;

/** Like ParamsFor, for tn(): `{count}` is supplied by tn itself. */
export type PluralParamsFor<K extends PluralKey> = [
  PluralPlaceholders<K>,
] extends [never]
  ? []
  : [Record<PluralPlaceholders<K>, string | number>];

// Function-typed properties, not methods: they read nothing off `this`, so
// `const { t } = useI18n()` is the intended way to hold one.
export interface Translator {
  language: SupportedLanguageCode;
  /** The message for `key`, with its placeholders filled. */
  t: <K extends MessageKey>(key: K, ...params: ParamsFor<K>) => string;
  /**
   * The one/other form of a plural pair for `count`, with `{count}` and the
   * other placeholders filled.
   */
  tn: <K extends PluralKey>(
    key: K,
    count: number,
    ...params: PluralParamsFor<K>
  ) => string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fill every `{name}` in `template` from `params`. Every occurrence is
 * replaced, so a translation may repeat a placeholder English uses once. A
 * placeholder with no value stays as written; catalog.test.ts makes that
 * unreachable for catalog text by holding every language to the English
 * placeholder set.
 */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Engine: the text for `key` in `catalog`, else in `fallback` (English), else
 * the key itself, interpolated. The types make a missing key impossible for
 * the real catalogs; the fallback chain is for the engine's plain-record
 * callers.
 */
export function lookupIn(
  catalog: Messages,
  fallback: Messages,
  key: string,
  params?: Params,
): string {
  return interpolate(catalog[key] ?? fallback[key] ?? key, params);
}

/**
 * Engine: the form of the pair at `key` for `count`. The category comes from
 * `rules` (one Intl.PluralRules per language); a category with no entry in
 * either catalog falls back to "other", which is why Spanish and Catalan,
 * whose rules also yield "many" at a million, need only the two entries.
 */
export function pluralIn(
  catalog: Messages,
  fallback: Messages,
  rules: Intl.PluralRules,
  key: string,
  count: number,
  params?: Params,
): string {
  const exact = `${key}.${rules.select(count)}`;
  const chosen =
    catalog[exact] !== undefined || fallback[exact] !== undefined
      ? exact
      : `${key}.other`;
  return lookupIn(catalog, fallback, chosen, { ...params, count });
}

// One translator per language for the life of the page. They hold no state
// beyond their Intl.PluralRules, so sharing is safe, and a stable identity is
// what lets the React context skip re-renders when the language is unchanged.
const translators = new Map<SupportedLanguageCode, Translator>();

export function translatorFor(language: SupportedLanguageCode): Translator {
  const cached = translators.get(language);
  if (cached) return cached;
  const catalog = CATALOGS[language];
  const fallback = CATALOGS[DEFAULT_LANGUAGE];
  const rules = new Intl.PluralRules(language);
  const translator: Translator = {
    language,
    t: (key, ...rest) =>
      lookupIn(catalog, fallback, key, (rest as [Params?])[0]),
    tn: (key, count, ...rest) =>
      pluralIn(catalog, fallback, rules, key, count, (rest as [Params?])[0]),
  };
  translators.set(language, translator);
  return translator;
}
