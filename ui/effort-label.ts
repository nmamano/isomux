// Reasoning effort as a person reads it, for the UI.
//
// A thin delegate: the id-to-key mapping and the lookup both live in
// shared/types.ts beside EFFORT_LEVELS, because the server's /effort renders
// the same levels and two mappings would drift
// (internal-docs/i18n-loop.md, S7). This file exists so the dialogs keep
// importing effort words from ui/, and so the UI passes a whole Translator
// where the shared helper takes just `t`.
//
// Pure module: the translator arrives as the first argument (ruling 18).

import { effortDisplayLabel } from "../shared/types.ts";
import type { Translator } from "../shared/i18n/translate.ts";

export { EFFORT_KEYS } from "../shared/types.ts";

/** The catalog's words for `level`, or the id itself if the table lacks it. */
export function effortLabel(i18n: Translator, level: string): string {
  return effortDisplayLabel(i18n.t, level);
}
