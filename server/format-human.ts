// Formatting helpers for text a person reads: sizes, timestamps, and markdown
// escaping. Shared by every surface that renders a report.
//
// A LEAF on purpose (imports nothing). formatSize and formatRelativeTime used
// to live in the modules that first needed them - attachment-prompt.ts and
// usage-report.ts - which meant the /isomux-storage report could not reuse them
// without dragging in the persistence layer and the agent SDK behind them.
// Formatting is not the property of any one report.

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
