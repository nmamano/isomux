// The Preferences pane's decisions, as pure functions (task 49d4e2f6 / e80c39c4).
//
// This is the ONE place that answers "which language is in effect for this
// user", so the open product question - whether a browser-detected language
// should become the user's actual stored preference without them asking, or
// only be preselected in the picker - can be answered by changing this file,
// not by hunting through a component. Today it is preselect-only: nothing is
// written until the user presses Save, and `record.language === null` is what
// the SERVER reads, so agents keep their existing behavior until then.
//
// Pure and React-free so it can be tested without a DOM (this repo has no
// component-test harness).

import {
  DEFAULT_LANGUAGE,
  detectBrowserLanguage,
  type SupportedLanguageCode,
} from "../shared/languages.ts";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import type { UserRecord } from "../shared/types.ts";

/** What the user has TOUCHED in the form. null = "follow the record". */
export interface PreferenceEdits {
  language: SupportedLanguageCode | null;
  slideMode: boolean | null;
}

export const NO_EDITS: PreferenceEdits = { language: null, slideMode: null };

export interface PreferenceForm {
  /** What the picker shows. */
  language: SupportedLanguageCode;
  /** What the checkbox shows. */
  slideMode: boolean;
  /** Whether Save does anything useful. */
  canSave: boolean;
  /** The body Save would send. */
  request: PreferencesReq;
}

// The language a record is EFFECTIVELY on for display purposes: their explicit
// choice, else their browser's if we offer it, else English.
export function displayLanguage(
  record: Pick<UserRecord, "language"> | null,
  navigatorLanguage: string | null | undefined,
): SupportedLanguageCode {
  return (
    record?.language ??
    detectBrowserLanguage(navigatorLanguage) ??
    DEFAULT_LANGUAGE
  );
}

export function resolvePreferenceForm(
  record: Pick<UserRecord, "language" | "slideMode"> | null,
  navigatorLanguage: string | null | undefined,
  edits: PreferenceEdits,
): PreferenceForm {
  const shownLanguage = displayLanguage(record, navigatorLanguage);
  const storedSlideMode = record?.slideMode === true;
  const language = edits.language ?? shownLanguage;
  const slideMode = edits.slideMode ?? storedSlideMode;
  // Save stays available while the language has never been chosen, even though
  // the picker already SHOWS the browser's language: that value is not on the
  // server yet, and the server-side value is what agents read. Without this,
  // someone on a Spanish browser would see "Español" selected with Save greyed
  // out and no way to commit it.
  const neverChosen = record !== null && record.language === null;
  const canSave =
    neverChosen || language !== shownLanguage || slideMode !== storedSlideMode;
  return { language, slideMode, canSave, request: { language, slideMode } };
}
