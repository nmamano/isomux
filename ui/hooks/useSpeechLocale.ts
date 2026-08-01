// The locale the browser speech APIs should use for the signed-in user
// (task e80c39c4). Both APIs need an explicit tag - SpeechRecognition has no
// auto-detect at all, and SpeechSynthesis picks a system default that is
// usually the OS language rather than the one the user asked us for.
//
// An explicit language preference wins; otherwise we pass the browser's own
// language through, which is right for the languages we don't (yet) offer as a
// preference.

import { useSelfUser } from "./useSelfUser.ts";
import { speechLocaleFor } from "../../shared/languages.ts";

export function useSpeechLocale(): string {
  const self = useSelfUser();
  return speechLocaleFor(
    self?.language ?? null,
    typeof navigator === "undefined" ? null : navigator.language,
  );
}
