import type { Text } from "@codemirror/state";

// The block the composer inserts when a member cites selected chat text, or
// selected editor text (then with the file path and line range).
//
// Dollars are escaped: a cited sentence with two of them ("$PORT ... $TOKEN")
// is otherwise read by the Markdown renderer as inline math between them and
// comes out as KaTeX, one glyph per line (Nil, 2026-09-16). A backslash escape
// renders as the literal dollar and the agent reads it as one too.
export type CiteSource = { path: string; fromLine: number; toLine: number };

export function citationBlock(text: string, source?: CiteSource): string {
  const lines = source
    ? source.fromLine === source.toLine
      ? `line ${source.fromLine}`
      : `lines ${source.fromLine}-${source.toLine}`
    : "";
  const from = source ? ` from ${source.path} (${lines})` : "";
  return `Cited text${from}:\n"""\n${text}\n"""\n`.replace(/\$/g, "\\$");
}

/**
 * 1-based line range of the selection [from, to) in `doc`. A selection that
 * ends at the start of a line (a whole-line selection) does not count that
 * line.
 */
export function citedLines(
  doc: Text,
  from: number,
  to: number,
): { fromLine: number; toLine: number } {
  const fromLine = doc.lineAt(from).number;
  const end = to > from && doc.lineAt(to).from === to ? to - 1 : to;
  return { fromLine, toLine: Math.max(fromLine, doc.lineAt(end).number) };
}
