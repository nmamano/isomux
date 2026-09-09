// Members chat resource handlers (opIds membersChat.*). The humans-only stream
// on the Lobby tab: a cookie user, that user's API token, and that user's
// privileged agents may read and write it; the chat:members capability on the
// route table keeps every other identity out before a handler runs.
//
// Attribution is TOKEN-derived, never from the body: the author snapshot
// (kind, userId, userName, device) comes from deps.authorFor(identity). The body
// may only add the browser's device label, and only for a cookie user - an API
// token's device is its own name, an agent has none.
//
// Ownership is a live check against the stored author: edit your own message;
// delete your own, or any message as an office owner. "Own" is by userId, so a
// person, their API token and their privileged agents share one identity here,
// the same reach the rest of the API gives them.
//
// The handler emits through the injected seam (there is no manager event for
// this resource): the mutation's response is the caller's own outcome and the
// all-audience event is what every other socket sees (double-signal, like
// tasks). markRead reaches only the caller's own sockets.
//
// LEAF over the executor + shared types. No manager/auth/store imports beyond
// the injected MembersChatDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  file,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { Attachment, MembersChatMessage } from "../../../shared/types.ts";
import type {
  MembersChatPostReq,
  MembersChatEditReq,
  MembersChatThumbsUpReq,
  MembersChatReadReq,
} from "../../../shared/contract-shapes.ts";
import {
  MembersChatError,
  type MembersChatPage,
  type PostInput,
} from "../../members-chat.ts";

// Same limits as agents.upload.
const MAX_FILES = 5;
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL = 400 * 1024 * 1024;
const MAX_DEVICE_CHARS = 64;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export type MembersChatAuthor = Omit<
  PostInput,
  "content" | "attachments" | "device"
> & { kind: MembersChatMessage["kind"]; device?: string };

export interface MembersChatDeps {
  page(opts: { before?: string; limit?: number }): MembersChatPage;
  post(input: PostInput): MembersChatMessage;
  edit(id: string, content: string): MembersChatMessage | null;
  setThumbsUp(
    id: string,
    reactor: MembersChatAuthor,
    active: boolean,
  ): MembersChatMessage | null;
  delete(id: string): MembersChatMessage | null;
  get(id: string): MembersChatMessage | null;
  getReadPointer(userId: string): string | null;
  setReadPointer(userId: string, lastReadId: string): string | null;
  unreadCount(userId: string): number;
  saveAttachment(
    data: Buffer,
    mediaType: string,
    originalName: string,
  ): Attachment | null;
  attachmentPath(filename: string): string | null;
  contentTypeFor(filename: string): string;
  // The author snapshot for this identity, or null when it cannot be resolved
  // (a user record that vanished, an agent that is gone) - rendered as 403.
  authorFor(identity: Identity): MembersChatAuthor | null;
  isOwner(userId: string): boolean;
  emitMessage(message: MembersChatMessage, updateOnly?: boolean): void;
  emitDeleted(id: string): void;
  emitRead(userId: string, readPointer: string | null, unread: number): void;
}

function isAttachmentShape(v: unknown): v is Attachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.filename === "string" &&
    typeof a.originalName === "string" &&
    typeof a.mediaType === "string" &&
    typeof a.size === "number"
  );
}

function storeError(err: unknown) {
  if (err instanceof MembersChatError) {
    return fail(
      400,
      err.code === "too_long" ? "too_long" : "empty",
      err.message,
    );
  }
  throw err;
}

export function membersChatHandlers(
  deps: MembersChatDeps,
): Record<string, RouteHandler> {
  const requireUser = (identity: Identity): string | null =>
    identity.userId ?? null;

  return {
    "membersChat.page": (ctx) => {
      const userId = requireUser(ctx.identity);
      if (!userId) return fail(403, "forbidden");
      const before = ctx.query.get("before") ?? undefined;
      const rawLimit = ctx.query.get("limit");
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      const page = deps.page({
        before,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return ok({
        ...page,
        readPointer: deps.getReadPointer(userId),
        unread: deps.unreadCount(userId),
      });
    },

    "membersChat.post": (ctx) => {
      const author = deps.authorFor(ctx.identity);
      if (!author) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatPostReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_request", "text must be a string");
      }
      let attachments: Attachment[] = [];
      if (body.attachments !== undefined) {
        if (
          !Array.isArray(body.attachments) ||
          !body.attachments.every(isAttachmentShape)
        ) {
          return fail(400, "invalid_request", "attachments must be a list");
        }
        for (const a of body.attachments) {
          // Only a file this chat already holds may be attached: the name is
          // the whole reference the card renders, so an unknown one would be a
          // broken chip at best and a probe of another store at worst.
          if (!deps.attachmentPath(a.filename)) {
            return fail(
              400,
              "unknown_attachment",
              `no such file: ${a.filename}`,
            );
          }
        }
        attachments = body.attachments.map((a) => ({
          filename: a.filename,
          originalName: a.originalName,
          mediaType: a.mediaType,
          size: a.size,
        }));
      }
      let device = author.device;
      if (author.kind === "user" && typeof body.device === "string") {
        const trimmed = body.device.trim().slice(0, MAX_DEVICE_CHARS);
        if (trimmed) device = trimmed;
      }
      let message: MembersChatMessage;
      try {
        message = deps.post({
          kind: author.kind,
          userId: author.userId,
          userName: author.userName,
          ...(device ? { device } : {}),
          content: body.text,
          attachments,
        });
      } catch (err) {
        return storeError(err);
      }
      deps.emitMessage(message);
      return created(message);
    },

    "membersChat.edit": (ctx) => {
      const userId = requireUser(ctx.identity);
      if (!userId) return fail(403, "forbidden");
      const existing = deps.get(ctx.params.id);
      if (!existing) return fail(404, "not_found");
      if (existing.userId !== userId) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatEditReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_request", "text must be a string");
      }
      let message: MembersChatMessage | null;
      try {
        message = deps.edit(existing.id, body.text);
      } catch (err) {
        return storeError(err);
      }
      if (!message) return fail(404, "not_found");
      deps.emitMessage(message, true);
      return ok(message);
    },

    "membersChat.thumbsUp": (ctx) => {
      const reactor = deps.authorFor(ctx.identity);
      if (!reactor) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatThumbsUpReq>;
      if (typeof body.active !== "boolean")
        return fail(400, "invalid_request", "active must be a boolean");
      const message = deps.setThumbsUp(ctx.params.id, reactor, body.active);
      if (!message) return fail(404, "not_found");
      deps.emitMessage(message, true);
      return ok(message);
    },

    "membersChat.delete": (ctx) => {
      const userId = requireUser(ctx.identity);
      if (!userId) return fail(403, "forbidden");
      const existing = deps.get(ctx.params.id);
      if (!existing) return fail(404, "not_found");
      if (existing.userId !== userId && !deps.isOwner(userId)) {
        return fail(403, "forbidden");
      }
      if (!deps.delete(existing.id)) return fail(404, "not_found");
      deps.emitDeleted(existing.id);
      return noContent();
    },

    "membersChat.markRead": (ctx) => {
      const userId = requireUser(ctx.identity);
      if (!userId) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatReadReq>;
      if (typeof body.lastReadId !== "string") {
        return fail(400, "invalid_request", "lastReadId must be a string");
      }
      const readPointer = deps.setReadPointer(userId, body.lastReadId);
      const unread = deps.unreadCount(userId);
      deps.emitRead(userId, readPointer, unread);
      return ok({ readPointer, unread });
    },

    "membersChat.upload": async (ctx) => {
      let formData: FormData;
      try {
        formData = await ctx.req.formData();
      } catch {
        return fail(400, "invalid_request", "expected multipart/form-data");
      }
      const attachments: Attachment[] = [];
      let fileCount = 0;
      let totalSize = 0;
      for (const [, value] of formData) {
        if (!(value instanceof File)) continue;
        fileCount++;
        if (fileCount > MAX_FILES) {
          return fail(
            400,
            "too_many_files",
            `Maximum ${MAX_FILES} files per upload`,
          );
        }
        if (value.size > MAX_FILE_SIZE) {
          return fail(
            400,
            "file_too_large",
            `File "${value.name}" exceeds 200MB limit`,
          );
        }
        totalSize += value.size;
        if (totalSize > MAX_TOTAL) {
          return fail(400, "upload_too_large", "Total upload exceeds 400MB");
        }
        const data = Buffer.from(await value.arrayBuffer());
        const saved = deps.saveAttachment(
          data,
          value.type || "application/octet-stream",
          value.name,
        );
        if (!saved) return fail(500, "save_failed", "Failed to save file");
        attachments.push(saved);
      }
      return ok({ attachments });
    },

    "membersChat.getFile": (ctx) => {
      const filePath = deps.attachmentPath(ctx.params.filename);
      if (!filePath) return fail(404, "not_found");
      return file(filePath, deps.contentTypeFor(ctx.params.filename), {
        "Cache-Control": IMMUTABLE_CACHE,
      });
    },
  };
}
