// What to tell a person when browser speech recognition stops with an error.
//
// The words live in the catalog (internal-docs/i18n-loop.md, ruling 7); this
// module maps the browser's error code to a key. The translator arrives as the
// first argument, because this runs from an event handler and is not a
// component (ruling 18).

import type { PlainMessageKey, Translator } from "../shared/i18n/translate.ts";

const VOICE_INPUT_ERROR_KEYS: Record<string, PlainMessageKey> = {
  "not-allowed": "logView.voice.blocked",
  "service-not-allowed": "logView.voice.blocked",
  "audio-capture": "logView.voice.noMicrophone",
  network: "logView.voice.network",
};

export function voiceInputErrorMessage(
  i18n: Translator,
  code: string,
): string | null {
  if (code === "no-speech" || code === "aborted") return null;
  return i18n.t(VOICE_INPUT_ERROR_KEYS[code] ?? "logView.voice.failed");
}
