// The members chat store: one office-wide stream for humans and their proxies
// (cookie users, API tokens, privileged agents), never an ordinary agent. It
// lives on the Lobby tab. Access is the route layer's job (server/routes); this
// module only knows how to keep and page the stream.
//
// WHY MONTH FILES. A chat between people has no natural end, so it cannot be
// cut into sessions the way an agent conversation is, and a year of history
// must not be the price of opening the panel. Each month is its own append-only
// JSONL file, <dir>/YYYY-MM.jsonl, and a page is read from the newest month
// backward, opening an older month only when the page is still short. A message
// id carries its month ("202609-1a2b3c4d"), so an edit or a delete is appended
// to the file that holds the target and folds correctly when that month is
// read - no rewrite of an existing file, ever, which keeps every file tar-safe
// for the backup the way the agent logs are.
//
// A folded month is cached in memory and dropped by its own append; the newest
// month is what every page and every unread count touches, so the cache is
// small and hot.
//
// Ordering is FILE ORDER, not timestamp order: a post is appended when it is
// accepted, so file order is the order the office saw, and a clock that moves
// backward cannot reorder history. The cursor of a page is a message id, and it
// still resolves after that message is deleted, because the fold keeps the
// position of every post it has seen.

import { membersChatExcerpt, recentMembersChatPins } from "../shared/members-chat.ts";
import { join } from "path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import {
  MEMBERS_CHAT_MAX_CHARS,
  type Attachment,
  type MembersChatMessage,
  type MembersChatReactor,
} from "../shared/types.ts";
import { atomicWriteFileSync, sanitizeFilename } from "./persistence.ts";

// The content cap lives in shared/types.ts so the composer counts the same
// characters the server measures.
export { MEMBERS_CHAT_MAX_CHARS };
export const MEMBERS_CHAT_DEFAULT_PAGE = 100;
export const MEMBERS_CHAT_MAX_PAGE = 200;
// Unread counting stops here; the UI label shows this number at the cap.
export const MEMBERS_CHAT_UNREAD_CAP = 100;
// Same backstop as persistence.ts saveFile.
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const ID_SHAPE = /^(\d{4})(\d{2})-[0-9a-f]{8}$/;

export type MembersChatErrorCode = "empty" | "too_long" | "reply_not_found";

export class MembersChatError extends Error {
  constructor(
    public readonly code: MembersChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MembersChatError";
  }
}

type Line =
  | {
      op: "post";
      replyTo?: MembersChatMessage["replyTo"];
      id: string;
      kind?: MembersChatMessage["kind"];
      userId: string;
      userName: string;
      device?: string;
      timestamp: number;
      content: string;
      attachments: Attachment[];
    }
  | { op: "edit"; id: string; timestamp: number; content: string }
  | { op: "delete"; id: string; timestamp: number }
  | { op: "pin"; id: string; timestamp: number; active: boolean }
  | {
      op: "react";
      id: string;
      timestamp: number;
      reactor: MembersChatReactor;
      active: boolean;
    };

interface FoldedMonth {
  // Every post id this month ever held, in file order - deleted ones included,
  // so a cursor keeps resolving after its message is gone.
  order: string[];
  // Live messages only.
  byId: Map<string, MembersChatMessage>;
}

export interface MembersChatPage {
  pinned: MembersChatMessage[];
  // Chronological (oldest first) - the order the panel renders.
  messages: MembersChatMessage[];
  hasMore: boolean;
}

export interface PostInput {
  replyTo?: string;
  kind?: MembersChatMessage["kind"];
  userId: string;
  userName: string;
  device?: string;
  content: string;
  attachments?: Attachment[];
}

export interface MembersChatStore {
  setPinned(id: string, active: boolean): MembersChatMessage | null;
  post(input: PostInput): MembersChatMessage;
  // null when the id is malformed, unknown, or already deleted.
  edit(id: string, content: string): MembersChatMessage | null;
  setThumbsUp(
    id: string,
    reactor: MembersChatReactor,
    active: boolean,
  ): MembersChatMessage | null;
  // The message as it was before deletion, or null when there was nothing to
  // delete. The caller needs the author for its ownership decision.
  delete(id: string): MembersChatMessage | null;
  get(id: string): MembersChatMessage | null;
  page(opts?: { before?: string; limit?: number }): MembersChatPage;
  getReadPointer(userId: string): string | null;
  // Advances only: a stale device cannot move a fresher pointer back.
  // Returns the pointer now on disk.
  setReadPointer(userId: string, lastReadId: string): string | null;
  unreadCount(userId: string): number;
  saveAttachment(
    data: Buffer,
    mediaType: string,
    originalName: string,
  ): Attachment | null;
  // Absolute path for an existing attachment, or null (unknown or unsafe name).
  attachmentPath(filename: string): string | null;
}

export function monthKey(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// "YYYY-MM" for a well-formed id, else null.
export function monthOfId(id: string): string | null {
  const m = ID_SHAPE.exec(id);
  return m ? `${m[1]}-${m[2]}` : null;
}

function validateContent(content: string, attachments: Attachment[]): string {
  if (typeof content !== "string") {
    throw new MembersChatError("empty", "text must be a string");
  }
  if (content.length > MEMBERS_CHAT_MAX_CHARS) {
    throw new MembersChatError(
      "too_long",
      `text must be at most ${MEMBERS_CHAT_MAX_CHARS} characters`,
    );
  }
  if (content.trim() === "" && attachments.length === 0) {
    throw new MembersChatError("empty", "a message needs text or a file");
  }
  return content;
}

function randomHex8(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createMembersChatStore(
  dir: string,
  opts: { now?: () => number } = {},
): MembersChatStore {
  const now = opts.now ?? (() => Date.now());
  const filesDir = join(dir, "files");
  const readsFile = join(dir, "reads.json");
  const cache = new Map<string, FoldedMonth>();
  // First use folds history once. Later pages use this derived index; the
  // append path keeps edits, reactions, unpins and deletions in step with it.
  let pinIndex: Map<string, MembersChatMessage> | null = null;

  const monthFile = (month: string) => join(dir, `${month}.jsonl`);

  // Ascending list of the months that exist on disk. Read fresh each time: a
  // month appears when its first post lands, and a restore can bring old ones.
  function listMonths(): string[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => MONTH_FILE.test(n))
      .map((n) => n.slice(0, -".jsonl".length))
      .sort();
  }

  function fold(month: string): FoldedMonth {
    const cached = cache.get(month);
    if (cached) return cached;
    const folded: FoldedMonth = { order: [], byId: new Map() };
    let text = "";
    try {
      text = readFileSync(monthFile(month), "utf-8");
    } catch {
      cache.set(month, folded);
      return folded;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        // A torn last line (the process died mid-append) is the only way a
        // bad line gets here; skipping it loses at most that one write.
        continue;
      }
      if (line.op === "post") {
        if (folded.byId.has(line.id) || folded.order.includes(line.id)) {
          continue;
        }
        folded.order.push(line.id);
        folded.byId.set(line.id, {
          id: line.id,
          kind: line.kind ?? "user",
          userId: line.userId,
          userName: line.userName,
          ...(line.device ? { device: line.device } : {}),
          timestamp: line.timestamp,
          content: line.content,
          attachments: Array.isArray(line.attachments) ? line.attachments : [],
          ...(line.replyTo ? { replyTo: line.replyTo } : {}),
        });
      } else if (line.op === "edit") {
        const m = folded.byId.get(line.id);
        if (m) {
          folded.byId.set(line.id, {
            ...m,
            content: line.content,
            editedAt: line.timestamp,
          });
        }
      } else if (line.op === "react") {
        const m = folded.byId.get(line.id);
        if (!m) continue;
        const thumbsUp = (m.thumbsUp ?? []).filter(
          (r) => r.userId !== line.reactor.userId,
        );
        if (line.active) thumbsUp.push(line.reactor);
        folded.byId.set(line.id, { ...m, thumbsUp });
      } else if (line.op === "pin") {
        const message = folded.byId.get(line.id);
        if (message) {
          const { pinnedAt: _previous, ...rest } = message;
          folded.byId.set(line.id, line.active ? { ...rest, pinnedAt: line.timestamp } : rest);
        }
      } else if (line.op === "delete") {
        folded.byId.delete(line.id);
      }
    }
    cache.set(month, folded);
    return folded;
  }

  function append(month: string, line: Line): void {
    mkdirSync(dir, { recursive: true });
    appendFileSync(monthFile(month), JSON.stringify(line) + "\n");
    cache.delete(month);
    if (pinIndex && (line.op === "pin" || pinIndex.has(line.id))) {
      const message = get(line.id);
      if (message?.pinnedAt !== undefined) pinIndex.set(line.id, message);
      else pinIndex.delete(line.id);
    }
  }

  function pinnedMessages(): MembersChatMessage[] {
    if (!pinIndex) {
      const index = new Map<string, MembersChatMessage>();
      for (const month of listMonths()) {
        const wasCached = cache.has(month);
        for (const message of fold(month).byId.values())
          if (message.pinnedAt !== undefined) index.set(message.id, message);
        // Keep the page cache small after this one-time history scan.
        if (!wasCached) cache.delete(month);
      }
      pinIndex = index;
    }
    return recentMembersChatPins(pinIndex.values());
  }

  function setPinned(id: string, active: boolean): MembersChatMessage | null {
    const existing = get(id);
    if (!existing) return null;
    if ((existing.pinnedAt !== undefined) === active) return existing;
    append(monthOfId(id)!, { op: "pin", id, timestamp: now(), active });
    return get(id);
  }

  function get(id: string): MembersChatMessage | null {
    const month = monthOfId(id);
    if (!month) return null;
    return fold(month).byId.get(id) ?? null;
  }

  // (month, index) of a post id, live or deleted; null when never seen.
  function positionOf(id: string): { month: string; index: number } | null {
    const month = monthOfId(id);
    if (!month) return null;
    const index = fold(month).order.indexOf(id);
    return index === -1 ? null : { month, index };
  }

  function post(input: PostInput): MembersChatMessage {
    const attachments = input.attachments ?? [];
    const content = validateContent(input.content, attachments);
    const target = input.replyTo === undefined ? null : get(input.replyTo);
    if (input.replyTo !== undefined && !target)
      throw new MembersChatError("reply_not_found", "reply target not found");
    const replyTo = target ? {
      id: target.id,
      userName: target.userName,
      excerpt: membersChatExcerpt(target.content, target.attachments),
    } : undefined;
    const timestamp = now();
    const month = monthKey(timestamp);
    const folded = fold(month);
    let id: string;
    do {
      id = `${month.replace("-", "")}-${randomHex8()}`;
    } while (folded.order.includes(id));
    const line: Line = {
      op: "post",
      ...(replyTo ? { replyTo } : {}),
      id,
      kind: input.kind ?? "user",
      userId: input.userId,
      userName: input.userName,
      ...(input.device ? { device: input.device } : {}),
      timestamp,
      content,
      attachments,
    };
    append(month, line);
    return get(id)!;
  }

  function edit(id: string, content: string): MembersChatMessage | null {
    const existing = get(id);
    if (!existing) return null;
    validateContent(content, existing.attachments);
    append(monthOfId(id)!, { op: "edit", id, timestamp: now(), content });
    return get(id);
  }

  function setThumbsUp(
    id: string,
    reactor: MembersChatReactor,
    active: boolean,
  ): MembersChatMessage | null {
    const existing = get(id);
    if (!existing) return null;
    if (
      (existing.thumbsUp ?? []).some((r) => r.userId === reactor.userId) ===
      active
    )
      return existing;
    // Fold the desired state in the target's file, including across month boundaries.
    append(monthOfId(id)!, {
      op: "react",
      id,
      timestamp: now(),
      reactor,
      active,
    });
    return get(id);
  }

  function del(id: string): MembersChatMessage | null {
    const existing = get(id);
    if (!existing) return null;
    append(monthOfId(id)!, { op: "delete", id, timestamp: now() });
    return existing;
  }

  function page(
    opts: { before?: string; limit?: number } = {},
  ): MembersChatPage {
    const limit = Math.max(
      1,
      Math.min(MEMBERS_CHAT_MAX_PAGE, opts.limit ?? MEMBERS_CHAT_DEFAULT_PAGE),
    );
    const months = listMonths().reverse(); // newest first
    const cursor = opts.before ? positionOf(opts.before) : null;
    // An unknown cursor pages from the top, which is what a client that lost
    // track deserves: a full newest page, never an empty one.
    const newestFirst: MembersChatMessage[] = [];
    let hasMore = false;
    for (const month of months) {
      if (cursor && month > cursor.month) continue;
      const folded = fold(month);
      let start = folded.order.length - 1;
      if (cursor && month === cursor.month) start = cursor.index - 1;
      for (let i = start; i >= 0; i--) {
        const m = folded.byId.get(folded.order[i]);
        if (!m) continue;
        if (newestFirst.length === limit) {
          hasMore = true;
          break;
        }
        newestFirst.push(m);
      }
      if (hasMore) break;
    }
    return { messages: newestFirst.reverse(), hasMore, pinned: pinnedMessages() };
  }

  function readReads(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(readsFile, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
    } catch {}
    return {};
  }

  function getReadPointer(userId: string): string | null {
    return readReads()[userId] ?? null;
  }

  function isNewer(
    a: { month: string; index: number },
    b: { month: string; index: number },
  ): boolean {
    return a.month > b.month || (a.month === b.month && a.index > b.index);
  }

  function setReadPointer(userId: string, lastReadId: string): string | null {
    const next = positionOf(lastReadId);
    if (!next) return getReadPointer(userId);
    const reads = readReads();
    const current = reads[userId] ? positionOf(reads[userId]) : null;
    if (current && !isNewer(next, current)) return reads[userId];
    reads[userId] = lastReadId;
    atomicWriteFileSync(readsFile, JSON.stringify(reads, null, 2) + "\n");
    return lastReadId;
  }

  function unreadCount(userId: string): number {
    const pointer = getReadPointer(userId);
    const pos = pointer ? positionOf(pointer) : null;
    let count = 0;
    for (const month of listMonths()) {
      if (pos && month < pos.month) continue;
      const folded = fold(month);
      const start = pos && month === pos.month ? pos.index + 1 : 0;
      for (let i = start; i < folded.order.length; i++) {
        if (!folded.byId.has(folded.order[i])) continue;
        count++;
        if (count >= MEMBERS_CHAT_UNREAD_CAP) return MEMBERS_CHAT_UNREAD_CAP;
      }
    }
    return count;
  }

  function saveAttachment(
    data: Buffer,
    mediaType: string,
    originalName: string,
  ): Attachment | null {
    try {
      if (data.length > MAX_ATTACHMENT_BYTES) return null;
      mkdirSync(filesDir, { recursive: true });
      let filename = sanitizeFilename(originalName);
      let filepath = join(filesDir, filename);
      if (existsSync(filepath)) {
        const existingHash = createHash("sha256")
          .update(readFileSync(filepath))
          .digest("hex");
        const newHash = createHash("sha256").update(data).digest("hex");
        if (existingHash === newHash) {
          return { filename, originalName, mediaType, size: data.length };
        }
        const dot = filename.lastIndexOf(".");
        const stem = dot > 0 ? filename.slice(0, dot) : filename;
        const ext = dot > 0 ? filename.slice(dot) : "";
        let i = 2;
        while (existsSync(filepath)) {
          filename = `${stem}_${i}${ext}`;
          filepath = join(filesDir, filename);
          i++;
        }
      }
      writeFileSync(filepath, data);
      return { filename, originalName, mediaType, size: data.length };
    } catch (err) {
      console.error("[members-chat] failed to save attachment:", err);
      return null;
    }
  }

  function attachmentPath(filename: string): string | null {
    if (/[/\\]/.test(filename) || filename === "." || filename === "..") {
      return null;
    }
    const p = join(filesDir, filename);
    return existsSync(p) ? p : null;
  }

  return {
    setPinned,
    post,
    edit,
    setThumbsUp,
    delete: del,
    get,
    page,
    getReadPointer,
    setReadPointer,
    unreadCount,
    saveAttachment,
    attachmentPath,
  };
}
