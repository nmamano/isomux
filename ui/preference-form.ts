// The Preferences pane's decisions, as pure functions.
//
// This is the ONE place that answers "which language is in effect for this
// user". The browser's language takes effect WITHOUT
// a first Save - a user on a Spanish browser gets Spanish-speaking agents
// without ever opening an (English) settings pane. `languageSeed` decides
// when the app auto-commits the detected language to the server; English is
// never seeded, because a null record already behaves as English.
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
}

export const NO_EDITS: PreferenceEdits = { language: null };

export interface PreferenceForm {
  /** What the picker shows. */
  language: SupportedLanguageCode;
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

// The language the app should auto-commit for a record that has never chosen
// one, or null when there is nothing to seed: no record yet, already chosen,
// or the browser language is unsupported or just the default.
export function languageSeed(
  record: Pick<UserRecord, "language"> | null,
  navigatorLanguage: string | null | undefined,
): SupportedLanguageCode | null {
  if (!record || record.language !== null) return null;
  const detected = detectBrowserLanguage(navigatorLanguage);
  if (!detected || detected === DEFAULT_LANGUAGE) return null;
  return detected;
}

export function resolvePreferenceForm(
  record: Pick<UserRecord, "language"> | null,
  navigatorLanguage: string | null | undefined,
  edits: PreferenceEdits,
): PreferenceForm {
  const shownLanguage = displayLanguage(record, navigatorLanguage);
  const language = edits.language ?? shownLanguage;
  // Save stays available while the language has never been chosen, even though
  // the picker already SHOWS the browser's language: that value is not on the
  // server yet, and the server-side value is what agents read. Without this,
  // someone on a Spanish browser would see "Español" selected with Save greyed
  // out and no way to commit it.
  const neverChosen = record !== null && record.language === null;
  const canSave = neverChosen || language !== shownLanguage;
  return { language, canSave, request: { language } };
}
