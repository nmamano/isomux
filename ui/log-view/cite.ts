// The block the composer inserts when a member cites selected chat text.
//
// Dollars are escaped: a cited sentence with two of them ("$PORT ... $TOKEN")
// is otherwise read by the Markdown renderer as inline math between them and
// comes out as KaTeX, one glyph per line (Nil, 2026-09-16). A backslash escape
// renders as the literal dollar and the agent reads it as one too.
export function citationBlock(text: string): string {
  return `Cited text:\n"""\n${text.replace(/\$/g, "\\$")}\n"""\n`;
}
