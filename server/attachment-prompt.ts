// Attachment prompt notices — the ONE shared convention for how boss-uploaded
// attachments reach an agent, identical across every backend (Claude, Codex,
// future harnesses).
//
// No attachment content is ever inlined into the model prompt. Instead, every
// attachment (image, PDF of any size, text file, binary blob) becomes exactly
// one text line carrying its metadata and the exact saved path; the agent
// opens the file on demand with its own tools (Claude: Read renders images
// and PDFs; Codex: view_image for images, shell tools otherwise). The win is
// lazy inclusion: irrelevant files never enter model context, and relevant
// ones enter only after the model decides they matter.
//
// Scope is deliberately narrow: resolving persisted inbound files (via
// persistence.getFilePath) and formatting prompt notices. Upload handling,
// outbound file_view attachments, and on-disk persistence live elsewhere.
//
// Backends stay responsible only for the wire wrapper (Claude: SDK
// ContentBlockParam text blocks; Codex: UserInput text items). Both follow
// the same shape contract: [user text block][one joined notices block], and
// when the user text is empty and no attachment resolved, a single empty
// text block so the turn is never content-free (Codex rejects empty input;
// Claude's behavior on an empty content array is undefined).

import { getFilePath } from "./persistence.ts";
import type { AttachmentSpec } from "./backends/types.ts";

// A resolved inbound attachment: upload-time metadata plus the authoritative
// on-disk path. `size` is recorded at upload, not a fresh stat — attachment
// files are immutable once saved, so it doesn't verify current disk bytes.
export interface AttachmentNotice {
  originalName: string;
  mediaType: string;
  size: number;
  path: string;
}

/**
 * Resolve attachment specs to notices. Specs whose file is missing on disk
 * are silently skipped (no placeholder); order among resolved attachments is
 * preserved exactly. Never reads file contents — the only filesystem touch is
 * getFilePath's existence check.
 */
export function resolveAttachmentNotices(
  agentId: string,
  specs: AttachmentSpec[],
): AttachmentNotice[] {
  const notices: AttachmentNotice[] = [];
  for (const spec of specs) {
    const path = getFilePath(agentId, spec.filename);
    if (!path) continue;
    notices.push({
      originalName: spec.originalName,
      mediaType: spec.mediaType,
      size: spec.size,
      path,
    });
  }
  return notices;
}

/** One prompt line per notice, in order. */
export function formatAttachmentLines(notices: AttachmentNotice[]): string[] {
  return notices.map(
    (n) =>
      `[Attachment: ${quoteOneLine(n.originalName)} (${oneLine(n.mediaType)}, ${formatSize(n.size)}) saved at ${quoteOneLine(n.path)}. If your reply depends on it, open it before answering about its contents.]`,
  );
}

// JSON-quote a string for embedding in a notice line. originalName is
// preserved user input (only the on-disk filename is sanitized), so embedded
// quotes/backslashes/newlines/control chars must not break the one-line
// invariant or fake extra structure. JSON.stringify escapes `"`, `\`, and
// C0 controls but leaves U+2028/U+2029 (Unicode line separators) raw — escape
// those too so the result is one line under every line-break convention.
export function quoteOneLine(s: string): string {
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => {
    return "\\u" + c.charCodeAt(0).toString(16);
  });
}

// Unquoted variant for tokens that are normally plain (mediaType). Defends
// against malformed legacy/API metadata: any character that could break the
// line or confuse the delimiters is replaced.
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029()"\\]/g, "_");
}

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
