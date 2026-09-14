// Spoken punctuation for voice input: dictating "question mark" should put a
// "?" in the composer, not the words "question mark".
//
// There are two classes of command, because they collide with ordinary English
// very differently. Marks like "comma" and "question mark" convert wherever
// they turn up - saying one by accident mid-sentence is rare enough to ignore.
// Sentence-terminal commands ("period", "full stop", "new line", "new
// paragraph") are ordinary words far too often ("a period of time"), so they
// convert only when they END the recognizer fragment they arrived in. The cost
// of that gate: to get a period you have to pause right after saying it, which
// is what finishing a sentence sounds like anyway. Said mid-flow, they stay
// prose.
//
// The recognizer picks its own fragment boundaries, so the two passes run at
// different scopes: the terminal pass runs inside each fragment, while the
// unconditional pass runs over the joined stream, which is what lets a mark the
// recognizer split in two ("question", then "mark") still be recognized. A
// terminal command split that way is not - by design, since "ends the fragment"
// is the whole signal it relies on.
//
// The matcher is language-independent. Its command data follows the
// recognizer's locale; an unsupported locale leaves the transcript unchanged.

import {
  SPOKEN_COMMANDS,
  spokenCommandsFor,
  type SpokenCommandData,
} from "./spoken-command-data.ts";

// Longest phrase first, so "exclamation mark" wins over any shorter phrase that
// starts at the same spot. Interior spaces match any run of whitespace because
// the recognizer decides on its own where to break words up.
function alternation(
  entries: readonly (readonly [string, string])[],
): string {
  return entries
    .map(([phrase]) => phrase)
    .sort((a, b) => b.length - a.length)
    .map((phrase) =>
      phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
    )
    .join("|");
}

function edge(mode: SpokenCommandData["boundaries"], side: "left" | "right") {
  if (mode === "none") return "";
  return side === "left"
    ? "(?<![\\p{L}\\p{N}])"
    : "(?![\\p{L}\\p{N}])";
}

function commandRegex(
  entries: readonly (readonly [string, string])[],
  commands: SpokenCommandData,
  terminal: boolean,
): RegExp {
  return new RegExp(
    edge(commands.boundaries, "left") +
      "(" +
      alternation(entries) +
      ")" +
      edge(commands.boundaries, "right") +
      (terminal ? "\\s*$" : ""),
    terminal ? "iu" : "giu",
  );
}

const replacements = Object.values(SPOKEN_COMMANDS).flatMap((commands) =>
  [...commands.marks, ...commands.terminal].flatMap(([, replacement]) =>
    Array.from(replacement),
  ),
);
/** Punctuation emitted by command data that attaches to what precedes it. */
const HUGS_PREVIOUS = new Set(
  replacements.filter((character) => !/[\p{Ps}\p{Pi}]/u.test(character)),
);
/** Punctuation emitted by command data that takes no space after it. */
const HUGS_NEXT = new Set(
  replacements.filter((character) => /[\p{Ps}\p{Pi}]/u.test(character)),
);

function characterClass(characters: ReadonlySet<string>): string {
  return [...characters]
    .map((character) => character.replace(/[\\\]\-^]/g, "\\$&"))
    .join("");
}

const HUGS_PREVIOUS_RE = new RegExp(
  `[ \\t]+([${characterClass(HUGS_PREVIOUS)}])`,
  "gu",
);
const HUGS_NEXT_RE = new RegExp(
  `([${characterClass(HUGS_NEXT)}])[ \\t]+`,
  "gu",
);

function substitute(
  lookup: ReadonlyMap<string, string>,
  match: string,
): string {
  return lookup.get(match.trim().toLocaleLowerCase().replace(/\s+/g, " ")) ?? match;
}

/** Clean up the whitespace the replaced words left behind. */
function tidySpacing(text: string): string {
  return text
    .replace(HUGS_PREVIOUS_RE, "$1")
    .replace(HUGS_NEXT_RE, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n");
}

/** Convert a sentence-terminal command sitting at the end of one fragment. */
function resolveTerminal(
  fragment: string,
  commands: SpokenCommandData,
  lookup: ReadonlyMap<string, string>,
): string {
  return fragment.replace(commandRegex(commands.terminal, commands, true), (m) =>
    substitute(lookup, m),
  );
}

/** Convert a run of recognizer fragments into composer text. */
function spokenText(fragments: readonly string[], locale: string): string {
  const commands = spokenCommandsFor(locale);
  if (!commands) return fragments.reduce(joinSpoken, "");
  const lookup = new Map([...commands.marks, ...commands.terminal]);
  const joined = fragments
    .map((fragment) => resolveTerminal(fragment, commands, lookup))
    .reduce(joinSpoken, "");
  return tidySpacing(
    joined.replace(commandRegex(commands.marks, commands, false), (m) =>
      substitute(lookup, m),
    ),
  );
}

/**
 * Replace spoken punctuation in one transcribed speech fragment with the
 * characters it names.
 */
export function applySpokenPunctuation(
  fragment: string,
  locale = "en-US",
): string {
  return spokenText([fragment], locale);
}

/** Whether a finalized recognizer fragment is only a submit command. */
export function isSpokenSubmit(fragment: string, locale: string): boolean {
  const commands = spokenCommandsFor(locale);
  if (!commands) return false;
  const normalized = fragment.trim().toLocaleLowerCase();
  return commands.submit.some(
    (phrase) => phrase.toLocaleLowerCase() === normalized,
  );
}

/**
 * Join newly transcribed speech onto existing composer text, inserting a single
 * separating space when neither side already provides whitespace so dictated
 * words don't run into the prior text. Punctuation is the exception: it hugs
 * the text on the side it belongs to instead of getting a space.
 */
export function joinSpoken(base: string, addition: string): string {
  if (!base || !addition) return base + addition;
  if (HUGS_PREVIOUS.has(addition[0] ?? ""))
    return base.replace(/[ \t]+$/, "") + addition;
  if (HUGS_NEXT.has(base.at(-1) ?? "")) return base + addition;
  if (/\s$/.test(base) || /^\s/.test(addition)) return base + addition;
  return base + " " + addition;
}

/**
 * One dictation session: `base` is the composer text as it stood when the mic
 * opened, `fragments` is every transcript the recognizer has finalized since,
 * still raw and still separated, since the fragment boundaries are what the
 * sentence-terminal commands key off.
 */
export type Dictation = {
  base: string;
  fragments: readonly string[];
  locale: string;
};

/** A session for a composer that currently holds `base`. */
export function startDictation(base: string, locale = "en-US"): Dictation {
  return { base, fragments: [], locale };
}

/** Fold one finalized recognizer result into the session. */
export function addFinalized(d: Dictation, transcript: string): Dictation {
  return { ...d, fragments: [...d.fragments, transcript] };
}

/**
 * The composer text for a session plus the recognizer's current interim guess.
 *
 * The guess is passed in as one more fragment rather than stored, so revising
 * or abandoning it just recomputes this - including a terminal command that
 * stops being fragment-final as the guess grows. `base` is concatenated
 * afterwards and never substituted, so text the user typed by hand is left
 * exactly as they typed it.
 */
export function dictationText(d: Dictation, interimRaw: string): string {
  const spoken = spokenText(
    interimRaw ? [...d.fragments, interimRaw] : d.fragments,
    d.locale,
  );
  return joinSpoken(d.base, spoken);
}

// State held by LogView while one SpeechRecognition session is open. `display`
// is the exact draft produced by the last transition, including any revisable
// interim result. Keeping it beside the finalized fragments lets a composer
// edit be reconciled synchronously, at the edit's source, without depending on
// React committing the previous draft first.
export type DictationSession = {
  dictation: Dictation;
  display: string;
};

export function startDictationSession(
  base: string,
  locale = "en-US",
): DictationSession {
  return { dictation: startDictation(base, locale), display: base };
}

export function advanceDictationSession(
  session: DictationSession,
  finalized: readonly string[],
  interimRaw: string,
): DictationSession {
  let dictation = session.dictation;
  for (const transcript of finalized) {
    dictation = addFinalized(dictation, transcript);
  }
  return {
    dictation,
    display: dictationText(dictation, interimRaw),
  };
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  let i = 0;
  const limit = Math.min(a.length, b.length) - prefix;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i++;
  }
  return i;
}

/**
 * Record a non-STT composer change while dictation remains open.
 *
 * Only offsets inside the common prefix of the finalized display and the last
 * STT display are stable. An edit wholly inside that prefix transfers exactly;
 * an edit that starts there and reaches into recognizer-controlled text keeps
 * its stable start and removes the finalized tail. An edit wholly beyond the
 * prefix is discarded because the recognizer is free to revise that region.
 * Every case drops the pending interim result and makes the returned draft the
 * reference display for the next edit.
 */
export function reconcileDictationEdit(
  session: DictationSession,
  nextDraft: string,
): DictationSession {
  const displayed = session.display;
  if (displayed === nextDraft) return session;

  const finalized = dictationText(session.dictation, "");
  const stablePrefix = commonPrefixLength(finalized, displayed);
  const start = commonPrefixLength(displayed, nextDraft);
  const suffix = commonSuffixLength(displayed, nextDraft, start);
  const end = displayed.length - suffix;
  const inserted = nextDraft.slice(start, nextDraft.length - suffix);

  let rebased = finalized;
  if (end <= stablePrefix) {
    rebased = finalized.slice(0, start) + inserted + finalized.slice(end);
  } else if (start <= stablePrefix) {
    rebased = finalized.slice(0, start) + inserted;
  } else if (start === displayed.length && end === displayed.length) {
    // A pure append has an unambiguous home even beyond the stable prefix.
    // Preserve it after finalized speech; joinSpoken supplies word spacing but
    // still hugs punctuation. In-place edits remain recognizer-controlled.
    rebased = joinSpoken(finalized, inserted);
  }
  return startDictationSession(rebased, session.dictation.locale);
}
