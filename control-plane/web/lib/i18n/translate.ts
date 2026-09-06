// Lookup over the catalogs beside this file: no library, a typed catalog per
// language, `{name}` interpolation, and explicit one/other plural pairs picked
// with Intl.PluralRules (internal-docs/i18n-loop.md, ruling 4).
//
// The same shape as `shared/i18n/translate.ts`, and deliberately the same
// names, so a reader moving between the office and the storefront is not
// re-learning anything. It is a copy rather than an import for the reason given
// in `languages.ts`: this app may not reach outside `control-plane/web`.
//
// Pure and React-free. A server component resolves the language from the
// request and passes it down as a prop; the two prerendered pages resolve it in
// the browser. Nothing here reads a global.

import { DEFAULT_LANGUAGE, type SupportedLanguageCode } from "./languages";
import { en, type Catalog, type MessageKey } from "./en";
import { es } from "./es";
import { ca } from "./ca";

export type { Catalog, MessageKey };

export const CATALOGS: Record<SupportedLanguageCode, Catalog> = { en, es, ca };

/** Values for the `{name}` placeholders of one message. */
export type Params = Record<string, string | number>;

/** A catalog as the engine sees it: keys to strings, nothing typed. */
export type Messages = Readonly<Record<string, string | undefined>>;

// "{name} owes {count}" -> "name" | "count". Derived from the English text, so
// the parameters a key takes are checked where t() is called.
export type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? P | Placeholders<Rest>
    : never;

export type EnglishText<K extends MessageKey> = (typeof en)[K];

/**
 * The keys whose English takes no {placeholder}. A table that maps an id to a
 * key - an operation kind, a liveness rung - is typed over THIS rather than
 * MessageKey: ParamsFor reads a union of keys as one set of placeholders, so a
 * single parameterized member would make every `t(TABLE[id])` call demand an
 * argument it has nothing to fill.
 */
export type PlainMessageKey = {
  [K in MessageKey]: [Placeholders<EnglishText<K>>] extends [never] ? K : never;
}[MessageKey];

/**
 * The trailing argument list of t() for one key: nothing when the English text
 * has no placeholder, else one required object naming every placeholder.
 */
export type ParamsFor<K extends MessageKey> = [
  Placeholders<EnglishText<K>>,
] extends [never]
  ? []
  : [Record<Placeholders<EnglishText<K>>, string | number>];

/**
 * The base of every plural pair: "office.duration.hours" when both
 * "office.duration.hours.one" and "office.duration.hours.other" exist.
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
// `const { t } = translatorFor(language)` is the intended way to hold one.
export interface Translator {
  language: SupportedLanguageCode;
  /** The message for `key`, with its placeholders filled. */
  t: <K extends MessageKey>(key: K, ...params: ParamsFor<K>) => string;
  /** The one/other form of a plural pair for `count`. */
  tn: <K extends PluralKey>(
    key: K,
    count: number,
    ...params: PluralParamsFor<K>
  ) => string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fill every `{name}` in `template` from `params`. Every occurrence is
 * replaced, so a sentence that names the same date twice needs one parameter.
 * A placeholder with no value stays as written; catalog.test.ts makes that
 * unreachable for catalog text.
 */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Engine: the text for `key` in `catalog`, else in `fallback` (English). */
export function lookupIn(
  catalog: Messages,
  fallback: Messages,
  key: string,
  params?: Params,
): string {
  return interpolate(catalog[key] ?? fallback[key] ?? key, params);
}

/** Engine: the form of the pair at `key` for `count`. */
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

/**
 * The catalog key an id-to-key TABLE holds for `id`, or undefined.
 *
 * Own properties only, and that is the whole point: the ids these tables are
 * indexed by arrive from the control plane - an operation kind, a liveness
 * rung, a billing period - so a plain `table[id]` answers "constructor" or
 * "__proto__" with something inherited from Object.prototype. Every dynamic
 * lookup into a key table goes through here.
 */
export function keyFrom<K extends MessageKey>(
  table: Readonly<Record<string, K>>,
  id: string,
): K | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

// One translator per language for the life of the process or the page. They
// hold no state beyond their Intl.PluralRules, so sharing is safe.
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
