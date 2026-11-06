// Colour markup for ask text: `:green[text]` draws its text in a theme
// colour. The names are fixed, and each maps to a --*-text variable that
// themes.ts holds readable in every theme. A retired name draws its text
// plain; any other name not in the list stays as typed.

import { Marked, type Tokens } from "marked";

// A Map, so a prototype key such as "constructor" is not a name.
export const MARKUP_COLORS: ReadonlyMap<string, string> = new Map([
  ["green", "var(--green-text)"],
  ["orange", "var(--orange-text)"],
  ["red", "var(--red-text)"],
  ["purple", "var(--purple-text)"],
]);

// Names older asks may hold. Blue was the link colour, so its text looked
// like a link.
export const RETIRED_MARKUP_COLORS: ReadonlySet<string> = new Set(["blue"]);

export type ColorToken = Tokens.Generic & {
  type: "color";
  name: string;
  tokens: Tokens.Generic[];
};

// One line, no unescaped "]", so a link cannot sit inside.
const COLOR_RE = /^:([a-z]+)\[((?:\\[^\n]|[^\\\]\n])+)\]/;

// The lexer options with the markup on, for Lexer.lexInline. The colon opens
// markup only at the start of the text or after a character that is not an
// ASCII letter, digit or underscore, so "note:red[x]" stays prose while
// Chinese and Japanese, written without spaces, still get colour.
export const colorMarkupOptions = new Marked({
  extensions: [
    {
      name: "color",
      level: "inline",
      start: (src: string) => src.search(/:[a-z]+\[/),
      tokenizer(src: string, tokens: Tokens.Generic[]) {
        const match = COLOR_RE.exec(src);
        if (
          !match ||
          !(MARKUP_COLORS.has(match[1]) || RETIRED_MARKUP_COLORS.has(match[1]))
        )
          return;
        if (/[A-Za-z0-9_]$/.test(tokens.at(-1)?.raw ?? "")) return;
        return {
          type: "color",
          raw: match[0],
          name: match[1],
          tokens: this.lexer.inlineTokens(match[2]),
        };
      },
    },
  ],
}).defaults;
