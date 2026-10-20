// Assertions for a server-written line (task c37a7365): its stored text is
// English, whoever caused it and whoever owns the agent, and its message
// words it for each reader. Expected text comes from the catalog engine, and
// the Catalan expectation is first proved to differ from English, so a
// message that ignored the reader could not pass (testing guide, principle 15
// and its exception for catalog values).

import { expect } from "bun:test";
import {
  translatorFor,
  type MessageKey,
  type ParamsFor,
} from "../../shared/i18n/translate.ts";
import { localizeLogParts } from "../../shared/i18n/log-message.ts";

/** `english` is the stored text, and `parts` words `key` for each reader. */
export function expectWordedText<K extends MessageKey>(
  english: string | undefined,
  parts: unknown,
  key: K,
  ...params: ParamsFor<K>
): void {
  const en = translatorFor("en").t(key, ...params);
  expect(english).toBe(en);
  const catalan = translatorFor("ca").t(key, ...params);
  expect({ key, text: catalan }).not.toEqual({ key, text: en });
  expect(localizeLogParts(translatorFor("ca"), parts)).toBe(catalan);
  expect(localizeLogParts(translatorFor("es"), parts)).toBe(
    translatorFor("es").t(key, ...params),
  );
  expect(localizeLogParts(translatorFor("en"), parts)).toBe(en);
}

/** The same, for a log entry: `content` and `message`. */
export function expectWorded<K extends MessageKey>(
  entry: { content: string; message?: unknown } | undefined,
  key: K,
  ...params: ParamsFor<K>
): void {
  expect(entry).toBeDefined();
  expectWordedText(entry!.content, entry!.message, key, ...params);
}
