import { savedFileAudit } from "../audit.ts";
// Room chat resource handlers (task 5b055cf3): opIds roomChat.* by :roomId,
// and membersChat.* for the old /api/members-chat routes, which are the
// lobby's chat. people and agents are native users. The chat:room capability
// on the route table keeps cron runs and apps out; roomChatReach decides the
// room, at each request.
//
// Attribution is TOKEN-derived, never from the body: the author snapshot
// (kind, userId, agentId, userName, device, limited) comes from
// deps.authorFor(identity). The body may only add the browser's device label,
// and only for a cookie user - an API token's device is its own name, an agent
// has none.
//
// Ownership is a live check against the stored author. A person, their API
// token and their privileged agents share one identity (userId): they edit
// those posts, and delete them or, with office-owner reach, any post. Any
// other agent edits and deletes only its own posts (agentId), and has no
// owner reach, even when its manager is an office owner.
//
// The handler emits through the injected seam (there is no manager event for
// this resource): the mutation's response is the caller's own outcome and the
// room-scoped event is what every other socket that reaches the room sees
// (double-signal, like tasks). markRead reaches only the caller's own sockets.
//
// LEAF over the executor + shared types. No manager/auth/store imports beyond
// the injected RoomChatDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  file,
  type HandlerResult,
  type RouteHandler,
  type RouteHandlerContext,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  Attachment,
  MembersChatMessage,
  MembersChatReactor,
} from "../../../shared/types.ts";
import { MAX_UPLOAD_BYTES } from "../../../shared/types.ts";
import { downloadHeader } from "../../mime-types.ts";
import type {
  MembersChatPostReq,
  MembersChatEditReq,
  MembersChatThumbsUpReq,
  MembersChatPinReq,
  MembersChatReadReq,
} from "../../../shared/contract-shapes.ts";
import {
  MembersChatError,
  type MembersChatStore,
  type PostInput,
} from "../../members-chat.ts";
import { agentAccessOf } from "../../../shared/agent-access.ts";
import { LOBBY_ROOM_ID } from "../../../shared/types.ts";

// Same limits as agents.upload.
const MAX_FILES = 5;
const MAX_TOTAL = 400 * 1024 * 1024;
const MAX_DEVICE_CHARS = 64;

export type MembersChatAuthor = Omit<
  PostInput,
  "content" | "attachments" | "device" | "replyTo"
> & { kind: MembersChatMessage["kind"]; device?: string };

// The store calls a room chat handler makes (server/members-chat.ts).
type RoomChatStore = Pick<
  MembersChatStore,
  | "setPinned"
  | "page"
  | "post"
  | "edit"
  | "setThumbsUp"
  | "delete"
  | "get"
  | "getReadPointer"
  | "setReadPointer"
  | "unreadCount"
  | "saveAttachment"
  | "attachmentPath"
>;

// The reaction snapshot of an author: who, never the limited marker.
export function reactorOf(author: MembersChatAuthor): MembersChatReactor {
  return {
    kind: author.kind,
    userId: author.userId,
    ...(author.agentId ? { agentId: author.agentId } : {}),
    userName: author.userName,
    ...(author.device ? { device: author.device } : {}),
  };
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

// The attachments a post names, each one a file the chat already holds, or the
// 400 to answer. attachmentPath is the chat's own lookup.
export function postAttachments(
  body: Partial<MembersChatPostReq>,
  attachmentPath: (filename: string) => string | null,
): Attachment[] | HandlerResult {
  if (body.attachments === undefined) return [];
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
    if (!attachmentPath(a.filename)) {
      return fail(400, "unknown_attachment", `no such file: ${a.filename}`);
    }
  }
  return body.attachments.map((a) => ({
    filename: a.filename,
    originalName: a.originalName,
    mediaType: a.mediaType,
    size: a.size,
  }));
}

// The device label for the author line: the browser's own, for a cookie user
// only; an API token's device is its name, an agent has none.
export function postDevice(
  author: MembersChatAuthor,
  body: Partial<MembersChatPostReq>,
): string | undefined {
  if (author.kind === "user" && typeof body.device === "string") {
    const trimmed = body.device.trim().slice(0, MAX_DEVICE_CHARS);
    if (trimmed) return trimmed;
  }
  return author.device;
}

// A multipart upload into a chat's files, with the agents.upload limits.
// save returns null when the file could not be kept. auditPrefix names the
// chat in the audit record.
export async function uploadFiles(
  ctx: RouteHandlerContext,
  auditPrefix: string,
  save: (
    data: Buffer,
    mediaType: string,
    originalName: string,
  ) => Attachment | null,
): Promise<HandlerResult> {
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
    if (value.size > MAX_UPLOAD_BYTES) {
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
    const saved = save(
      data,
      value.type || "application/octet-stream",
      value.name,
    );
    if (!saved) return fail(500, "save_failed", "Failed to save file");
    savedFileAudit(`${auditPrefix}/${saved.filename}`);
    attachments.push(saved);
  }
  return ok({ attachments });
}

export function storeError(err: unknown) {
  if (err instanceof MembersChatError) {
    if (err.code === "reply_not_found") return fail(404, err.code);
    return fail(
      400,
      err.code === "too_long" ? "too_long" : "empty",
      err.message,
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Room chats (task 5b055cf3). The members chat handlers above serve the
// lobby's chat through the /api/members-chat aliases; the roomChat.* handlers
// serve any room by :roomId.

// What the reach check reads of the live office.
export interface RoomChatReachDeps {
  // Whether roomId names a live room (the lobby included); false for an
  // unknown or closed one.
  roomOpen(roomId: string): boolean;
  isLobby(roomId: string): boolean;
  // The guard's room access: the identity's user reaches the room, and a
  // room-limited token lists it.
  hasRoomAccess(identity: Identity, roomId: string): boolean;
  // A live agent's current room, or null.
  agentRoomId(agentId: string): string | null;
}

export type RoomChatReach = { ok: true } | { ok: false; status: 403 | 404 };

// Whether an agent identity is at the privileged stop: the stop its token
// was minted with, or for a token from before the slider, its privileged
// set. Never chat:room, which every agent stop holds.
export function isPrivilegedAgent(identity: Identity): boolean {
  if (identity.scope !== "agent") return false;
  if (identity.agentAccess) return identity.agentAccess === "privileged";
  return (
    agentAccessOf({
      privileged: identity.capabilities.includes("chat:members"),
    }) === "privileged"
  );
}

// An agent that is not privileged: it reaches only its live room, edits only
// its own posts and has no read pointer of its own.
function isRoomBoundAgent(identity: Identity): boolean {
  return identity.scope === "agent" && !isPrivilegedAgent(identity);
}

// Whether identity reaches roomId's chat. An unknown or closed room is 404 for
// everyone, owners too. People, API tokens and privileged agents: the lobby
// always, other rooms by room access. Any other agent: only its live room,
// while its manager reaches it (the lobby always passes). An agent with no
// manager reaches the lobby only.
export function roomChatReach(
  identity: Identity,
  roomId: string,
  deps: RoomChatReachDeps,
): RoomChatReach {
  if (!deps.roomOpen(roomId)) return { ok: false, status: 404 };
  const lobby = deps.isLobby(roomId);
  if (isRoomBoundAgent(identity)) {
    if (!identity.agentId || deps.agentRoomId(identity.agentId) !== roomId)
      return { ok: false, status: 403 };
  }
  if (lobby || deps.hasRoomAccess(identity, roomId)) return { ok: true };
  return { ok: false, status: 403 };
}

export interface RoomChatDeps extends RoomChatReachDeps {
  // The chat of a live room (the lobby's is the old members chat).
  store(roomId: string): RoomChatStore;
  contentTypeFor(filename: string): string;
  // Sandbox and private-cache headers: an opened file must not run as office
  // content, and a shared cache must not store it.
  untrustedFileHeaders(): Record<string, string>;
  // The author snapshot for this identity, or null when it cannot be resolved
  // (a user record that vanished, an agent that is gone) - rendered as 403.
  authorFor(identity: Identity): MembersChatAuthor | null;
  // An office owner's reach (hasOfficeOwnerReach): deletes any post. A
  // room-limited API token does not have it; an agent that is not privileged
  // never uses it.
  isOwner(identity: Identity): boolean;
  emitMessage(
    roomId: string,
    message: MembersChatMessage,
    updateOnly?: boolean,
  ): void;
  emitDeleted(roomId: string, id: string): void;
  emitRead(
    roomId: string,
    userId: string,
    readPointer: string | null,
    unread: number,
  ): void;
}

// Whether identity wrote `message` in the ownership sense of the header.
function ownsPost(identity: Identity, message: MembersChatMessage): boolean {
  if (isRoomBoundAgent(identity))
    return !!identity.agentId && message.agentId === identity.agentId;
  return !!identity.userId && message.userId === identity.userId;
}

const OP_SUFFIXES = [
  "page",
  "post",
  "pin",
  "thumbsUp",
  "edit",
  "delete",
  "markRead",
  "upload",
  "getFile",
] as const;

export const ROOM_CHAT_OP_IDS = OP_SUFFIXES.map((op) => `roomChat.${op}`);

export function roomChatHandlers(
  deps: RoomChatDeps,
): Record<string, RouteHandler> {
  // The room of a request, its store, or the refusal to answer.
  const open = (
    ctx: RouteHandlerContext,
    roomId: string,
  ): { roomId: string; store: RoomChatStore } | HandlerResult => {
    const reach = roomChatReach(ctx.identity, roomId, deps);
    if (!reach.ok)
      return reach.status === 404
        ? fail(404, "not_found")
        : fail(403, "forbidden");
    return { roomId, store: deps.store(roomId) };
  };
  const isOpen = (
    r: { roomId: string; store: RoomChatStore } | HandlerResult,
  ): r is { roomId: string; store: RoomChatStore } => "store" in r;

  const handlers = (
    roomOf: (ctx: RouteHandlerContext) => string,
  ): Record<(typeof OP_SUFFIXES)[number], RouteHandler> => ({
    page: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const before = ctx.query.get("before") ?? undefined;
      const rawLimit = ctx.query.get("limit");
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      const page = r.store.page({
        before,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      // An agent that is not privileged has no pointer: its manager's is the
      // manager's own.
      const reader = isRoomBoundAgent(ctx.identity)
        ? null
        : ctx.identity.userId;
      return ok({
        ...page,
        readPointer: reader ? r.store.getReadPointer(reader) : null,
        unread: reader ? r.store.unreadCount(reader) : 0,
      });
    },

    post: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const author = deps.authorFor(ctx.identity);
      if (!author) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatPostReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_request", "text must be a string");
      }
      if (body.replyTo !== undefined && typeof body.replyTo !== "string")
        return fail(400, "invalid_request", "replyTo must be a message id");
      const attachments = postAttachments(body, (name) =>
        r.store.attachmentPath(name),
      );
      if (!Array.isArray(attachments)) return attachments;
      const device = postDevice(author, body);
      let message: MembersChatMessage;
      try {
        message = r.store.post({
          kind: author.kind,
          userId: author.userId,
          ...(author.agentId ? { agentId: author.agentId } : {}),
          ...(author.limited ? { limited: true as const } : {}),
          userName: author.userName,
          ...(device ? { device } : {}),
          content: body.text,
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
          attachments,
        });
      } catch (err) {
        return storeError(err);
      }
      deps.emitMessage(r.roomId, message);
      return created(message);
    },

    edit: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const existing = r.store.get(ctx.params.id);
      if (!existing) return fail(404, "not_found");
      if (!ownsPost(ctx.identity, existing)) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatEditReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_request", "text must be a string");
      }
      let message: MembersChatMessage | null;
      try {
        message = r.store.edit(existing.id, body.text);
      } catch (err) {
        return storeError(err);
      }
      if (!message) return fail(404, "not_found");
      deps.emitMessage(r.roomId, message, true);
      return ok(message);
    },

    pin: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      if (!deps.authorFor(ctx.identity)) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatPinReq>;
      if (typeof body.active !== "boolean")
        return fail(400, "invalid_request", "active must be a boolean");
      const message = r.store.setPinned(ctx.params.id, body.active);
      if (!message) return fail(404, "not_found");
      deps.emitMessage(r.roomId, message, true);
      return ok(message);
    },

    thumbsUp: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const author = deps.authorFor(ctx.identity);
      if (!author) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatThumbsUpReq>;
      if (typeof body.active !== "boolean")
        return fail(400, "invalid_request", "active must be a boolean");
      const message = r.store.setThumbsUp(
        ctx.params.id,
        reactorOf(author),
        body.active,
      );
      if (!message) return fail(404, "not_found");
      deps.emitMessage(r.roomId, message, true);
      return ok(message);
    },

    delete: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const existing = r.store.get(ctx.params.id);
      if (!existing) return fail(404, "not_found");
      const ownerReach =
        !isRoomBoundAgent(ctx.identity) && deps.isOwner(ctx.identity);
      if (!ownsPost(ctx.identity, existing) && !ownerReach)
        return fail(403, "forbidden");
      if (!r.store.delete(existing.id)) return fail(404, "not_found");
      deps.emitDeleted(r.roomId, existing.id);
      return noContent();
    },

    markRead: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const userId = ctx.identity.userId;
      // An agent that is not privileged would move its manager's pointer.
      if (!userId || isRoomBoundAgent(ctx.identity))
        return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatReadReq>;
      if (typeof body.lastReadId !== "string") {
        return fail(400, "invalid_request", "lastReadId must be a string");
      }
      const readPointer = r.store.setReadPointer(userId, body.lastReadId);
      const unread = r.store.unreadCount(userId);
      deps.emitRead(r.roomId, userId, readPointer, unread);
      return ok({ readPointer, unread });
    },

    upload: async (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      return uploadFiles(
        ctx,
        deps.isLobby(r.roomId) ? "members-chat" : `room-chats/${r.roomId}`,
        (data, type, name) => r.store.saveAttachment(data, type, name),
      );
    },

    getFile: (ctx) => {
      const r = open(ctx, roomOf(ctx));
      if (!isOpen(r)) return r;
      const filePath = r.store.attachmentPath(ctx.params.filename);
      if (!filePath) return fail(404, "not_found");
      return file(filePath, deps.contentTypeFor(ctx.params.filename), {
        ...deps.untrustedFileHeaders(),
        ...downloadHeader(ctx.query, ctx.params.filename),
      });
    },
  });

  const byRoom = handlers((ctx) => ctx.params.roomId);
  const lobby = handlers(() => LOBBY_ROOM_ID);
  return Object.fromEntries(
    OP_SUFFIXES.flatMap((op) => [
      [`roomChat.${op}`, byRoom[op]],
      [`membersChat.${op}`, lobby[op]],
    ]),
  );
}
