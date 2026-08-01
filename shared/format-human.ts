// Formatting helpers for text a person reads: sizes, timestamps, and markdown
// escaping. Shared by every surface that renders a report.
//
// A LEAF on purpose (imports nothing). formatSize and formatRelativeTime used
// to live in the modules that first needed them - attachment-prompt.ts and
// usage-report.ts - which meant the /isomux-storage report could not reuse them
// without dragging in the persistence layer and the agent SDK behind them.
// Formatting is not the property of any one report.
//
// Lives in shared/ (moved from server/) for the same reason it left those two
// modules: the storage panel renders in the browser the SAME measurement
// /isomux-storage renders in chat, and ui/ imports nothing from server/. A size
// reading "1.4 GB" in chat and "1.37 GB" in the panel is exactly the drift this
// module exists to prevent.

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

// Coarse "how long ago" for report tables. Anything older than a week becomes
// an absolute date - "23d ago" is harder to place than "Jul 8".
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
