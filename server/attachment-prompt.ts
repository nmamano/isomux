// Attachment prompt notices - the ONE shared convention for how boss-uploaded
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
import { formatSize } from "../shared/format-human.ts";
import type { AttachmentSpec } from "./backends/types.ts";

// A resolved inbound attachment: upload-time metadata plus the authoritative
// on-disk path. `size` is recorded at upload, not a fresh stat - attachment
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
 * preserved exactly. Never reads file contents - the only filesystem touch is
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

// One notice line, anchored on its structure rather than its prose: quoted
// name, parenthesized metadata, quoted path, then whatever advisory tail the
// current format appends. Keeping the tail loose means a future wording change
// to formatAttachmentLines doesn't strand transcripts written under the old
// wording. The `[^\n...]` classes hold each notice to a single line, which
// quoteOneLine guarantees for the name and path.
const NOTICE_LINE =
  '\\[Attachment: "(?:[^"\\\\\\n]|\\\\.)*" \\([^\\n()]*\\) saved at "(?:[^"\\\\\\n]|\\\\.)*"[^\\n\\]]*\\]';

// The block as backends record it: notices joined by "\n", the whole run
// sitting at the very end of the flattened message text.
const TRAILING_NOTICE_BLOCK = new RegExp(
  `${NOTICE_LINE}(?:\\n${NOTICE_LINE})*$`,
);

/** Recover the user's own text from a backend-recorded user message that
 *  carried attachments.
 *
 *  Attachments ride as their own text block after the user's text block (see
 *  buildClaudeUserMessage / buildCodexUserInput), and all three backends'
 *  getSessionMessages flatten content blocks by concatenation with NO
 *  separator. So a transcript entry reads
 *  `[Nil] here's the screenshot[Attachment: "image.png" (image/png, 527.0 KB)
 *  saved at "/…/image_7.png". …]` while the isomux log entry only carries
 *  `here's the screenshot`. Edit-message matching compares the two by
 *  equality, so the notice block has to come back off first - the same role
 *  stripOutboundEnvelope plays for built-in notice blocks.
 *
 *  Returns the input unchanged when the text doesn't end in a notice block.
 *  The match is deliberately end-anchored and consumes no separator before the
 *  block, so a user message that ended in a newline keeps that newline.
 *
 *  The ambiguity is accepted, not solved: a user whose message genuinely ends
 *  with a line shaped like a notice gets over-stripped. Nothing in the recorded
 *  text distinguishes the two, and the alternative - reconstructing the
 *  expected block from the log entry's attachment list - is worse, because it
 *  breaks the moment a file is deleted from disk (the resolver skips missing
 *  files) or the notice wording changes. This is internal recovery for edit
 *  matching, never shown to anyone; the cost of a miss is one edit that
 *  reports the message as unlocatable, which is the pre-fix behavior. */
export function stripAttachmentNotices(text: string): string {
  return text.replace(TRAILING_NOTICE_BLOCK, "");
}

// JSON-quote a string for embedding in a notice line. originalName is
// preserved user input (only the on-disk filename is sanitized), so embedded
// quotes/backslashes/newlines/control chars must not break the one-line
// invariant or fake extra structure. JSON.stringify escapes `"`, `\`, and
// C0 controls but leaves U+2028/U+2029 (Unicode line separators) raw - escape
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
