// A Translator["t"] that records each call and returns a marker naming the
// key. Text a caller rendered through the words it was given is a marker;
// text it built some other way (an English literal) is not. Task beb6089b.
import {
  translatorFor,
  type Params,
  type Translator,
} from "../../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";

export type WordsCall = { key: string; params?: Params; out: string };

export function spyWords(): { t: Translator["t"]; calls: WordsCall[] } {
  const calls: WordsCall[] = [];
  const t = (key: string, params?: Params) => {
    const out = `<<${key}>>`;
    calls.push({ key, params, out });
    return out;
  };
  return { t, calls };
}

/** The recorded call that produced `text`, or undefined. */
export function callFor(
  calls: WordsCall[],
  text: string,
): WordsCall | undefined {
  return calls.find((call) => call.out === text);
}

/** A recorded call rendered by the real catalog of `language`. */
export function render(
  language: SupportedLanguageCode,
  call: WordsCall,
): string {
  const t = translatorFor(language).t as unknown as (
    key: string,
    params?: Params,
  ) => string;
  return t(call.key, call.params);
}
