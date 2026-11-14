import type { Text } from "@codemirror/state";
import { shortenCwd } from "../cwd-display.ts";
import { appendBlockToDraft } from "./draft-append.ts";
import { dollarMath } from "./Markdown.tsx";

// The block the composer inserts when a member cites selected chat text, or
// selected editor text (then with the file path, home shortened to ~, and
// the line range). Dollars stay as typed; insertCite escapes them only when
// they would render as math.
export type CiteSource = { path: string; fromLine: number; toLine: number };

export function citationBlock(text: string, source?: CiteSource): string {
  const lines = source
    ? source.fromLine === source.toLine
      ? `line ${source.fromLine}`
      : `lines ${source.fromLine}-${source.toLine}`
    : "";
  const from = source ? ` from ${shortenCwd(source.path)} (${lines})` : "";
  return `Cited text${from}:\n"""\n${text}\n"""\n`;
}

// Put a block into a composer draft: at the selection `at` in the draft
// (replacing it, one newline on each side), or appended after a blank line
// when `at` is absent. Returns the new draft and the caret after the block.
//
// The block goes in as typed, unless its dollars take part in math in the
// new draft: then every dollar in it is escaped. Without this, a cite with
// two dollars ("$HOME/$USER"), or a cite next to another one, renders the
// text between them as KaTeX (Nil, 2026-09-16). Escaping every cite instead
// shows a backslash before each price (Nil, 2026-10-24). A dollar the member
// types after the insert can still pair with a cited one; a rule that
// prevents that has to escape every "$9", which is the second problem.
export function insertCite(
  draft: string,
  block: string,
  at?: { start: number; end: number },
): { draft: string; caret: number } {
  const place = (text: string) => {
    if (!at) {
      const next = appendBlockToDraft(draft, text);
      return { draft: next, caret: next.length };
    }
    const before = draft.slice(0, at.start);
    const after = draft.slice(at.end);
    const leadSep = before === "" || before.endsWith("\n") ? "" : "\n";
    const trailSep = after === "" || after.startsWith("\n") ? "" : "\n";
    const insertion = leadSep + text + trailSep;
    return {
      draft: before + insertion + after,
      caret: before.length + insertion.length,
    };
  };
  const raw = place(block);
  const escaped = place(block.replace(/\$/g, "\\$"));
  const same =
    JSON.stringify(dollarMath(raw.draft)) ===
    JSON.stringify(dollarMath(escaped.draft));
  return same ? raw : escaped;
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
