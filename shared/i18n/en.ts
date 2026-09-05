// The English catalog: the typed source of truth for every string the office
// shows a person (internal-docs/i18n-loop.md, rulings 6 and 7).
//
// Keys name the surface and the meaning ("preferences.save"), never the English
// text, so a wording change never renames a key. English copy is frozen: moving
// a string in here never changes it. `as const` keeps every value a literal
// type, which is what lets translate.ts derive the {placeholder} names a key
// takes and check them at the call site.
//
// Plurals are explicit pairs, "<key>.one" and "<key>.other", picked with
// Intl.PluralRules; Spanish and Catalan need no other category.
//
// es.ts and ca.ts are typed as complete records over these keys: a key missing
// there is a compile error, and catalog.test.ts proves the rest (no empty
// value, the same placeholders as English).

export const en = {
  "nav.tasks": "Tasks",
  "nav.schedules": "Schedules",
  "nav.apps": "Apps",
  "nav.settings": "Settings",
  "nav.theme": "Theme",
  "nav.changeTheme": "Change theme",
  "nav.showAgentList": "Show agent list",
  "nav.showFloorView": "Show floor view",

  "preferences.title": "Preferences",
  "preferences.loading": "Loading…",
  "preferences.intro":
    "These follow you to every device you sign in from. Settings that are about this browser in particular live under My devices.",
  "preferences.language": "Language",
  "preferences.languageHint":
    "The language your agents write in, and the language your voice input and playback use. Agents pick it up on their next conversation. The rest of the interface stays in English for now.",
  "preferences.save": "Save",
  "preferences.saving": "Saving…",
  "preferences.saved": "Saved.",
  "preferences.saveFailed": "Could not save",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

/** A complete translation: every English key, each with a string. */
export type Catalog = Record<MessageKey, string>;
