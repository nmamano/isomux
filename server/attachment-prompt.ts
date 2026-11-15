// Attachment prompt notices - the ONE shared convention for how member-uploaded
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

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "fs";
import { basename, join } from "path";
import { getFilePath } from "./persistence.ts";
import type { AgentHost } from "./agent-host.ts";
import { agentShare, copyToMemberShare } from "./member-share-files.ts";
import { INLINE_IMAGE_TYPES } from "../shared/agent-access.ts";
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
  const share = agentShare(agentId);
  for (const spec of specs) {
    let path = getFilePath(agentId, spec.filename);
    if (!path) continue;
    // A member's agent cannot read LOGS_DIR: the notice names the copy in
    // their share (member-share-files.ts). A failed copy is left out.
    if (share) {
      const source = path;
      path = memberShareCopy(share, agentId, spec.filename, source);
      if (!path) continue;
    }
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
function quoteOneLine(s: string): string {
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

// How attachments reach an agent below standard (task e77304b1), which has no
// way to open a file in the office state. inline-images: the chat and office
// stops have no file tools, so an image goes into the message itself and any
// other file is left out. copy: the folder and web stops copy each file into
// <folder>/attachments/ and the notice names the copy.
// member-copy: a member's agent at folder and web, whose folder the office
// cannot write: prepareDelivery makes the copies through their runner before
// the message is built, and gives "copied" with their notices.
export type AttachmentDelivery =
  | { kind: "inline-images" }
  | { kind: "copy"; folder: string }
  // `host` is asked at each message: during a move the member's host
  // refuses, and a host that was not ready at the start may be by now.
  | { kind: "member-copy"; folder: string; host: () => AgentHost }
  | { kind: "copied"; notices: AttachmentNotice[] };

// The delivery at folder and web: the office copies, or for a member's
// agent (`host().member` set) their runner does.
export function folderDelivery(
  folder: string,
  host: () => AgentHost,
): AttachmentDelivery {
  return host().member !== undefined
    ? { kind: "member-copy", folder, host }
    : { kind: "copy", folder };
}

// The delivery for one message: member-copy becomes "copied" (async, through
// the runner); every other kind is returned as it is.
export async function prepareDelivery(
  agentId: string,
  specs: AttachmentSpec[],
  delivery: AttachmentDelivery,
): Promise<AttachmentDelivery> {
  if (delivery.kind !== "member-copy") return delivery;
  return {
    kind: "copied",
    notices: await prepareMemberCopies(
      agentId,
      specs,
      delivery.folder,
      delivery.host(),
    ),
  };
}

// The notices of one message: none inline (inline-images), the copies, or,
// with no delivery (at standard), the stored files. A member-copy that was
// not prepared throws: its notices would name files the agent cannot read.
export function deliveredNotices(
  agentId: string,
  specs: AttachmentSpec[],
  delivery: AttachmentDelivery | undefined,
): AttachmentNotice[] {
  switch (delivery?.kind) {
    case undefined:
      return resolveAttachmentNotices(agentId, specs);
    case "inline-images":
      return [];
    case "copy":
      return copyAttachmentsInto(agentId, specs, delivery.folder);
    case "copied":
      return delivery.notices;
    case "member-copy":
      throw new Error("a member's copies must be prepared before the message");
  }
}

// The share copy of one upload, or null (logged) when it fails.
function memberShareCopy(
  share: string,
  agentId: string,
  name: string,
  source: string,
): string | null {
  try {
    return copyToMemberShare(share, agentId, name, source);
  } catch (error) {
    console.error(
      `[attachments] ${agentId}: cannot copy ${name} to the member's share: ${(error as Error).message}`,
    );
    return null;
  }
}

// The copies in <folder>/attachments/ for a member's agent at folder and
// web: the office copies each upload to the member's share, and their runner
// copies it from there into the folder, as the member (the attachment-copy
// entry), so no file bytes cross the runner's socket. A file that cannot be
// copied is left out, with a log line.
export async function prepareMemberCopies(
  agentId: string,
  specs: AttachmentSpec[],
  folder: string,
  host: AgentHost,
): Promise<AttachmentNotice[]> {
  const share = agentShare(agentId);
  const notices: AttachmentNotice[] = [];
  for (const spec of specs) {
    const source = getFilePath(agentId, spec.filename);
    if (!source || !share) {
      console.error(
        `[attachments] ${agentId}: ${spec.filename} left out: ${source ? "no member share" : "no file"}`,
      );
      continue;
    }
    const shared = memberShareCopy(share, agentId, spec.filename, source);
    if (!shared) continue;
    let path: unknown;
    try {
      const reply = await host.runEntry("attachment-copy", {
        source: shared,
        folder,
        name: spec.filename,
      });
      path = (reply as { path?: unknown } | null)?.path;
    } catch (error) {
      console.error(
        `[attachments] ${agentId}: cannot copy ${spec.filename} into the folder: ${(error as Error).message}`,
      );
      continue;
    }
    if (typeof path !== "string") {
      console.error(
        `[attachments] ${agentId}: the runner's copy of ${spec.filename} gave no path`,
      );
      continue;
    }
    notices.push({
      originalName: spec.originalName,
      mediaType: spec.mediaType,
      size: spec.size,
      path,
    });
  }
  return notices;
}

// Keeps the sends of one session in order when some must wait for an async
// step first (prepareMemberCopies): each send's step starts after the
// previous send was handed to the engine.
export function createSendOrder(): <T>(
  prepare: () => Promise<T>,
  deliver: (prepared: T) => Promise<void>,
) => Promise<void> {
  let last: Promise<unknown> = Promise.resolve();
  return (prepare, deliver) => {
    const prepared = last.then(prepare);
    const sent = prepared.then(deliver);
    // The next prepare waits until this deliver was called, not until it
    // resolved: a deliver that waits for the turn must not hold the next
    // message back.
    last = prepared.catch(() => {});
    return sent;
  };
}

// The Claude API refuses a larger inline image.
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface InlineImage {
  mediaType: string;
  data: string; // base64
}

// The images among `specs`, read for inline delivery. Every other file, and
// a file that is gone or too large, is left out.
export function inlineImages(
  agentId: string,
  specs: AttachmentSpec[],
): InlineImage[] {
  const images: InlineImage[] = [];
  for (const spec of specs) {
    if (!INLINE_IMAGE_TYPES.has(spec.mediaType)) continue;
    const path = getFilePath(agentId, spec.filename);
    if (!path) continue;
    try {
      const bytes = readFileSync(path);
      if (bytes.length > INLINE_IMAGE_MAX_BYTES) continue;
      images.push({
        mediaType: spec.mediaType,
        data: bytes.toString("base64"),
      });
    } catch {}
  }
  return images;
}

// Copies each attachment into <folder>/attachments/ and returns the notices
// for the copies. The copy follows the folder write rule: the attachments
// directory must be a real directory (created when absent), the file is
// created without following a symlink, and a file that cannot be copied that
// way is left out.
export function copyAttachmentsInto(
  agentId: string,
  specs: AttachmentSpec[],
  folder: string,
): AttachmentNotice[] {
  const dir = join(folder, "attachments");
  let realDir: string;
  try {
    const realFolder = realpathSync(folder);
    realDir = join(realFolder, "attachments");
    let stat = lstatSyncOrNull(realDir);
    if (!stat) {
      mkdirSync(realDir, { mode: 0o700 });
      stat = lstatSync(realDir);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const notices: AttachmentNotice[] = [];
  for (const spec of specs) {
    if (spec.filename !== basename(spec.filename) || spec.filename === "..")
      continue;
    const source = getFilePath(agentId, spec.filename);
    if (!source) continue;
    const target = join(realDir, spec.filename);
    try {
      const existing = lstatSyncOrNull(target);
      if (existing && !existing.isFile()) continue;
      if (existing) unlinkSync(target);
      const fd = openSync(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, readFileSync(source));
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    notices.push({
      originalName: spec.originalName,
      mediaType: spec.mediaType,
      size: spec.size,
      path: join(dir, spec.filename),
    });
  }
  return notices;
}

function lstatSyncOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
