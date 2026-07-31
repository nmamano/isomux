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
// English only, matching the recognizer's hardcoded "en-US" locale.

/** Marks that convert anywhere they appear. */
const UNCONDITIONAL: Array<[string, string]> = [
  ["comma", ","],
  ["question mark", "?"],
  ["exclamation mark", "!"],
  ["exclamation point", "!"],
  ["colon", ":"],
  ["semicolon", ";"],
  ["semi colon", ";"],
  ["ellipsis", "..."],
  ["open parenthesis", "("],
  ["open paren", "("],
  ["close parenthesis", ")"],
  ["close paren", ")"],
];

/** Commands that convert only at the end of the fragment they arrived in. */
const TERMINAL: Array<[string, string]> = [
  ["period", "."],
  ["full stop", "."],
  ["new line", "\n"],
  ["newline", "\n"],
  ["new paragraph", "\n\n"],
];

const LOOKUP = new Map([...UNCONDITIONAL, ...TERMINAL]);

// Longest phrase first, so "exclamation mark" wins over any shorter phrase that
// starts at the same spot. Interior spaces match any run of whitespace because
// the recognizer decides on its own where to break words up.
function alternation(entries: Array<[string, string]>): string {
  return entries
    .map(([phrase]) => phrase)
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/ /g, "\\s+"))
    .join("|");
}

const UNCONDITIONAL_RE = new RegExp(
  "\\b(" + alternation(UNCONDITIONAL) + ")\\b",
  "gi",
);
// Anchored at the end of the fragment. The trailing \s* both allows for the
// recognizer's own trailing space and stands in for a closing word boundary, so
// "new lines" and "periodic" don't match.
const TERMINAL_RE = new RegExp("\\b(" + alternation(TERMINAL) + ")\\s*$", "i");

/** Punctuation that attaches to whatever comes before it, with no space. */
const HUGS_PREVIOUS = /^[.,?!:;)\n]/;
/** Text ending in one of these takes no separating space after it. */
const HUGS_NEXT = /[(\n]$/;

function substitute(match: string): string {
  return LOOKUP.get(match.trim().toLowerCase().replace(/\s+/g, " ")) ?? match;
}

/** Clean up the whitespace the replaced words left behind. */
function tidySpacing(text: string): string {
  return text
    .replace(/[ \t]+([.,?!:;)])/g, "$1")
    .replace(/([(])[ \t]+/g, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n");
}

/** Convert a sentence-terminal command sitting at the end of one fragment. */
function resolveTerminal(fragment: string): string {
  return fragment.replace(TERMINAL_RE, substitute);
}

/** Convert a run of recognizer fragments into composer text. */
function spokenText(fragments: readonly string[]): string {
  const joined = fragments.map(resolveTerminal).reduce(joinSpoken, "");
  return tidySpacing(joined.replace(UNCONDITIONAL_RE, substitute));
}

/**
 * Replace spoken punctuation in one transcribed speech fragment with the
 * characters it names.
 */
export function applySpokenPunctuation(fragment: string): string {
  return spokenText([fragment]);
}

/**
 * Join newly transcribed speech onto existing composer text, inserting a single
 * separating space when neither side already provides whitespace so dictated
 * words don't run into the prior text. Punctuation is the exception: it hugs
 * the text on the side it belongs to instead of getting a space.
 */
export function joinSpoken(base: string, addition: string): string {
  if (!base || !addition) return base + addition;
  if (HUGS_PREVIOUS.test(addition))
    return base.replace(/[ \t]+$/, "") + addition;
  if (HUGS_NEXT.test(base)) return base + addition;
  if (/\s$/.test(base) || /^\s/.test(addition)) return base + addition;
  return base + " " + addition;
}

/**
 * One dictation session: `base` is the composer text as it stood when the mic
 * opened, `fragments` is every transcript the recognizer has finalized since,
 * still raw and still separated, since the fragment boundaries are what the
 * sentence-terminal commands key off.
 */
export type Dictation = { base: string; fragments: readonly string[] };

/** A session for a composer that currently holds `base`. */
export function startDictation(base: string): Dictation {
  return { base, fragments: [] };
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
  );
  return joinSpoken(d.base, spoken);
}
