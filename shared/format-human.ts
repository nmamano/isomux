// Formatting helpers for text a person reads: sizes, timestamps, and markdown
// escaping. Shared by every surface that renders a report.
//
// A LEAF on purpose (imports nothing). formatSize used to live in the module
// that first needed it - attachment-prompt.ts - which meant a report could not
// reuse it without dragging the agent SDK behind it. Formatting is not the
// property of any one report.
//
// What is left here is AGENT-FACING or structural. Every human-facing size,
// count and timestamp moved to shared/i18n/number.ts and shared/i18n/time.ts,
// which render in the reader's language; formatSize stays because
// server/attachment-prompt.ts writes for an agent, which always reads English
// (internal-docs/i18n-loop.md, S7). formatRelativeTime left with its last
// caller, the /isomux-storage report.

// Deterministic human-readable size. Binary units, one decimal above bytes.
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Render an untrusted string as a markdown INLINE CODE SPAN, safely.
//
// Backslash escapes don't work inside code spans, so the usual trick is no
// help here: the only thing that ends a span is a run of backticks at least as
// long as the one that opened it. So we open with one backtick more than the
// longest run in the content, which no content can close early. Content that
// starts or ends with a backtick gets one space of padding, which CommonMark
// strips back off when both sides have it.
//
// Control characters collapse to spaces for the same reason as the table-cell
// escaper below: a newline ends an inline span outright and no escape can tame
// it. Paths with newlines in them are pathological, but "pathological" is
// exactly what a display helper has to survive.
export function markdownInlineCode(text: string): string {
  let body = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    body += code < 0x20 || code === 0x7f ? " " : ch;
  }
  let longestRun = 0;
  let run = 0;
  for (const ch of body) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longestRun) longestRun = run;
  }
  const fence = "`".repeat(longestRun + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

// Every ASCII punctuation character CommonMark lets a backslash escape. The
// whole class is escapable and each one renders as itself, so escaping all of
// them is both exhaustive and visually lossless - no need to reason about
// which subset the chat renderer happens to treat as markup.
const MARKDOWN_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// Render an untrusted string as LITERAL TEXT inside a markdown table cell.
//
// Two separate hazards, both closed here. Structurally, a raw pipe ends the
// cell and a newline ends the row, so a name could forge extra columns or push
// text out of the table entirely. Semantically, `_`, `*`, backticks, brackets
// and angle brackets are inline markup, so a name could render as italics, a
// link, or raw HTML - including a convincing copy of an annotation the report
// adds itself. Escaping the full punctuation class covers both, and control
// characters (CR and LF among them) collapse to spaces since no backslash can
// tame those.
//
// Callers append their OWN trusted markup after calling this, never before.
export function escapeMarkdownTableCellText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else if (MARKDOWN_PUNCTUATION.includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}
