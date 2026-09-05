// The one language context of the UI (internal-docs/i18n-loop.md, ruling 8).
//
// The language is whatever ui/preference-form.ts says is in effect for the
// signed-in user - their explicit preference, else the browser's language, else
// English - which is the same answer the Preferences picker shows. There is no
// second resolver: this provider only asks displayLanguage and hands the
// matching translator down.
//
// Composed in ui/index.tsx and ui/demo-entry.tsx, inside StoreProvider and
// directly around the app, because the self user lives in the store. A tree
// with no provider gets the English translator from the context default; the
// DOM tests that mount App bare rely on that, and
// ui/test-support/language-fixture.tsx is how a test puts a user on a language.
//
// Components call `const { t, tn, rich } = useI18n()`. A pure module that
// builds strings takes `t` or the language as an argument and never reads a
// global.
//
// rich() is the rich-text helper of ruling 16: a sentence with an inline code
// span, link or emphasis is ONE catalog entry, with the wrapped span written
// as a named tag pair ("Keeping {retention} in <code>{destDir}</code>.") and
// the values as the usual {placeholders}. Tags are one level deep and never
// nested; catalog.test.ts holds every language to the English tag multiset.
// The caller supplies a wrap function per tag and a node per placeholder, and
// the types derive both sets from the English text, so a missing part is a
// compile error at the call site. t() never sees a tag: a tagged entry is
// only ever read through rich().

import {
  createContext,
  createElement,
  Fragment,
  useContext,
  type ReactNode,
} from "react";
import {
  DEFAULT_LANGUAGE,
  type SupportedLanguageCode,
} from "../shared/languages.ts";
import {
  CATALOGS,
  lookupIn,
  translatorFor,
  type EnglishText,
  type MessageKey,
  type Placeholders,
  type Translator,
} from "../shared/i18n/translate.ts";
import { displayLanguage } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";

// "<code>x</code> and <strong>y</strong>" -> "code" | "strong". Closing tags
// are skipped, so a pair contributes its name once.
type Tags<S extends string> = S extends `${string}<${infer T}>${infer Rest}`
  ? (T extends `/${string}` ? never : T) | Tags<Rest>
  : never;

/** Renders the (already interpolated) text between a tag pair. */
export type Wrap = (chunk: ReactNode) => ReactNode;

/**
 * The trailing argument list of rich() for one key: nothing when the English
 * text has neither placeholder nor tag, else one object with a node per
 * placeholder and a wrap function per tag.
 */
export type RichPartsFor<K extends MessageKey> = [
  Placeholders<EnglishText<K>> | Tags<EnglishText<K>>,
] extends [never]
  ? []
  : [
      Record<Placeholders<EnglishText<K>>, ReactNode> &
        Record<Tags<EnglishText<K>>, Wrap>,
    ];

export interface UiTranslator extends Translator {
  /** The message for `key` as React nodes, its tags wrapped and placeholders filled. */
  rich: <K extends MessageKey>(key: K, ...parts: RichPartsFor<K>) => ReactNode;
}

type RichParts = Record<string, ReactNode | Wrap>;

// One tag pair (never nested: the body stops at the first matching close) or
// one placeholder.
const RICH_TOKEN = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;

function fillPlaceholders(text: string, parts: RichParts): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const value = parts[m[1]];
    // A placeholder with no value stays as written, like interpolate().
    out.push(typeof value === "function" || value === undefined ? m[0] : value);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function keyed(nodes: ReactNode[]): ReactNode {
  return createElement(
    Fragment,
    null,
    ...nodes.map((node, i) => createElement(Fragment, { key: i }, node)),
  );
}

/**
 * The rich renderer over a plain template: text stays text, `{name}` becomes
 * parts.name, and `<tag>…</tag>` becomes parts.tag(inner) with the inner
 * placeholders filled first. Exported for its unit test; components use
 * useI18n().rich.
 */
export function renderRich(template: string, parts: RichParts): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of template.matchAll(RICH_TOKEN)) {
    if (m.index > last) out.push(template.slice(last, m.index));
    if (m[1] !== undefined) {
      const wrap = parts[m[1]];
      const inner = keyed(fillPlaceholders(m[2], parts));
      out.push(typeof wrap === "function" ? wrap(inner) : inner);
    } else {
      out.push(...fillPlaceholders(m[0], parts));
    }
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return keyed(out);
}

// One UI translator per language, over translatorFor's own cached object, so
// the context value keeps one identity per language and consumers re-render
// only when the language changes.
const uiTranslators = new Map<SupportedLanguageCode, UiTranslator>();

export function uiTranslatorFor(language: SupportedLanguageCode): UiTranslator {
  const cached = uiTranslators.get(language);
  if (cached) return cached;
  const catalog = CATALOGS[language];
  const fallback = CATALOGS[DEFAULT_LANGUAGE];
  const translator: UiTranslator = {
    ...translatorFor(language),
    rich: (key, ...rest) =>
      renderRich(
        lookupIn(catalog, fallback, key),
        (rest as [RichParts?])[0] ?? {},
      ),
  };
  uiTranslators.set(language, translator);
  return translator;
}

const I18nCtx = createContext<UiTranslator>(uiTranslatorFor(DEFAULT_LANGUAGE));

export function LanguageProvider({ children }: { children: ReactNode }) {
  const self = useSelfUser();
  const language = displayLanguage(
    self,
    typeof navigator === "undefined" ? null : navigator.language,
  );
  return (
    <I18nCtx.Provider value={uiTranslatorFor(language)}>
      {children}
    </I18nCtx.Provider>
  );
}

export function useI18n(): UiTranslator {
  return useContext(I18nCtx);
}
