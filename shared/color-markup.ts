// The names of the ask colour markup, `:green[text]` (the card draws it in
// ui/members-chat/color-markup.ts), and its plain-text form for the places
// that cannot draw colour: a Discord message and a push banner.

// The names the card draws in colour.
export const MARKUP_COLOR_NAMES = ["green", "orange", "red", "purple"] as const;

// Names older asks may hold. Blue was the link colour, so its text looked
// like a link. The card draws their text plain.
export const RETIRED_MARKUP_COLORS: ReadonlySet<string> = new Set(["blue"]);

const NAMES: ReadonlySet<string> = new Set([
  ...MARKUP_COLOR_NAMES,
  ...RETIRED_MARKUP_COLORS,
]);

// The card's rule: one line, no unescaped "]", and the colon opens markup
// only at the start or after a character that is not an ASCII letter, digit
// or underscore.
const COLOR_RE = /(?<![A-Za-z0-9_]):([a-z]+)\[((?:\\[^\n]|[^\\\]\n])+)\]/g;

// The text with each known colour name's markup replaced by its text. Any
// other name stays as typed, as the card draws it.
export function stripColorMarkup(text: string): string {
  return text.replace(COLOR_RE, (whole, name: string, inner: string) =>
    NAMES.has(name) ? inner : whole,
  );
}
