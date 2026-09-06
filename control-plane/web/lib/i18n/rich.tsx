// The rich-text helper of ruling 16: a sentence with an inline link, code span
// or emphasis is ONE catalog entry, never split into before/after keys, because
// word order differs per language.
//
// The wrapped span is written as a named tag pair in the catalog
// ("review the <terms>Terms of Service</terms>") and the values as the usual
// {placeholders}. The caller supplies a wrap function per tag and a node per
// placeholder; the types derive both sets from the English text, so a missing
// part is a compile error at the call site. t() never sees a tag: a tagged
// entry is only ever read through rich().
//
// The same shape as `ui/i18n.tsx`, minus its React context - this app resolves
// the language per page rather than once per document.

import { createElement, Fragment, type ReactNode } from "react";
import { DEFAULT_LANGUAGE, type SupportedLanguageCode } from "./languages";
import {
  CATALOGS,
  lookupIn,
  translatorFor,
  type EnglishText,
  type MessageKey,
  type Placeholders,
  type Translator,
} from "./translate";

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

export interface WebTranslator extends Translator {
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
 * parts.name, and `<tag>...</tag>` becomes parts.tag(inner) with the inner
 * placeholders filled first. Exported for its unit test; callers use
 * webTranslatorFor(language).rich.
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

// One translator per language, over translatorFor's own cached object, so a
// component that re-renders on the same language gets the same identity.
const webTranslators = new Map<SupportedLanguageCode, WebTranslator>();

export function webTranslatorFor(
  language: SupportedLanguageCode,
): WebTranslator {
  const cached = webTranslators.get(language);
  if (cached) return cached;
  const catalog = CATALOGS[language];
  const fallback = CATALOGS[DEFAULT_LANGUAGE];
  const translator: WebTranslator = {
    ...translatorFor(language),
    rich: (key, ...rest) =>
      renderRich(
        lookupIn(catalog, fallback, key),
        (rest as [RichParts?])[0] ?? {},
      ),
  };
  webTranslators.set(language, translator);
  return translator;
}
