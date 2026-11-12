// 1:1 chat resource handlers (opIds memberDms.*, task 019e4d7c). The route
// table's chat:members capability lets a person, their API token and their
// privileged agents in; every handler here then checks the PAIR before it
// touches anything: the caller (identity.userId) and the peer named by
// :username (a live user id, a live name, or a removed member's id). Only the
// two members reach a chat. There is no owner override: this factory takes no
// owner check at all.
//
// A removed peer: the caller still reads, marks read, edits and deletes their
// own messages; a post, an upload or a thumbs-up is 409 peer_removed until an
// owner restores the peer (a restore keeps the id). Once the removed record
// expired, the peer still resolves BY ID inside a chat the caller is in, with
// the name its meta.json kept, so the history stays readable.
//
// Each message or deletion is emitted once to each member, with peerId naming
// the other one; markRead reaches the reader only.
//
// LEAF over the executor + shared types, like members-chat.ts.

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
import type { MembersChatMessage } from "../../../shared/types.ts";
import type {
  MembersChatPostReq,
  MembersChatEditReq,
  MembersChatThumbsUpReq,
  MembersChatReadReq,
} from "../../../shared/contract-shapes.ts";
import { downloadHeader } from "../../mime-types.ts";
import type { MemberDmsStore, MemberNameOf } from "../../member-dms.ts";
import { validateContent, type MembersChatStore } from "../../members-chat.ts";
import {
  postAttachments,
  postDevice,
  storeError,
  uploadFiles,
  type MembersChatAuthor,
} from "./members-chat.ts";

export interface DmPeer {
  id: string;
  name: string;
  removed: boolean;
}

export interface MemberDmDeps {
  dms: MemberDmsStore;
  // :username as a live user id, then a live name, then a removed member's
  // id (never a removed name: two removed members may share one). Null when
  // none matches.
  resolvePeer(param: string): DmPeer | null;
  nameOf: MemberNameOf;
  authorFor(identity: Identity): MembersChatAuthor | null;
  contentTypeFor(filename: string): string;
  untrustedFileHeaders(): Record<string, string>;
  // To one member's sockets: peerId is the other member of the pair.
  emitMessage(
    toUserId: string,
    peerId: string,
    message: MembersChatMessage,
    updateOnly?: boolean,
  ): void;
  emitDeleted(toUserId: string, peerId: string, id: string): void;
  emitRead(
    toUserId: string,
    peerId: string,
    readPointer: string | null,
    unread: number,
  ): void;
  // A web push to the recipient's devices for a new message.
  notify(recipientId: string, message: MembersChatMessage): void;
}

interface Pair {
  me: { id: string; name: string };
  peer: DmPeer;
}

const peerRemoved = () =>
  fail(
    409,
    "peer_removed",
    "this member was removed; an office owner can restore them",
  );

export function memberDmHandlers(
  deps: MemberDmDeps,
): Record<string, RouteHandler> {
  // The caller and the peer, or the refusal. Every handler starts here.
  function pairOf(ctx: RouteHandlerContext): Pair | HandlerResult {
    const myId = ctx.identity.userId;
    const me = myId ? deps.nameOf(myId) : null;
    if (!myId || !me || me.removed) return fail(403, "forbidden");
    const param = ctx.params.username;
    let peer = deps.resolvePeer(param);
    if (!peer) {
      const kept = deps.dms.storedName(myId, param);
      if (kept !== null) peer = { id: param, name: kept, removed: true };
    }
    if (!peer) return fail(404, "not_found");
    if (peer.id === myId)
      return fail(400, "invalid_request", "you cannot chat with yourself");
    return { me: { id: myId, name: me.name }, peer };
  }

  const isPair = (p: Pair | HandlerResult): p is Pair => "peer" in p;

  const existing = (p: Pair): MembersChatStore | null =>
    deps.dms.existing(p.me.id, p.peer.id);

  // Each member's copy names the other one.
  function emitBoth(p: Pair, message: MembersChatMessage, updateOnly = false) {
    deps.emitMessage(p.me.id, p.peer.id, message, updateOnly);
    deps.emitMessage(p.peer.id, p.me.id, message, updateOnly);
  }

  return {
    "memberDms.list": (ctx) => {
      const myId = ctx.identity.userId;
      if (!myId) return fail(403, "forbidden");
      return ok({ chats: deps.dms.conversationsOf(myId, deps.nameOf) });
    },

    "memberDms.page": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      const store = existing(p);
      if (!store)
        return ok({
          messages: [],
          hasMore: false,
          readPointer: null,
          unread: 0,
        });
      const rawLimit = ctx.query.get("limit");
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
      const { messages, hasMore } = store.page({
        before: ctx.query.get("before") ?? undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return ok({ messages, hasMore, ...store.summary(p.me.id) });
    },

    "memberDms.post": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      if (p.peer.removed) return peerRemoved();
      const author = deps.authorFor(ctx.identity);
      if (!author) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatPostReq>;
      if (typeof body.text !== "string")
        return fail(400, "invalid_request", "text must be a string");
      if (body.replyTo !== undefined && typeof body.replyTo !== "string")
        return fail(400, "invalid_request", "replyTo must be a message id");
      // Everything is checked against the pair's own chat, before the first
      // post makes it: a refused post leaves no chat behind.
      const held = existing(p);
      const attachments = postAttachments(
        body,
        (name) => held?.attachmentPath(name) ?? null,
      );
      if (!Array.isArray(attachments)) return attachments;
      try {
        validateContent(body.text, attachments);
      } catch (err) {
        return storeError(err);
      }
      if (body.replyTo !== undefined && !held?.get(body.replyTo))
        return fail(404, "reply_not_found");
      const device = postDevice(author, body);
      let message: MembersChatMessage;
      try {
        message = deps.dms.open(p.me, p.peer).post({
          kind: author.kind,
          userId: author.userId,
          userName: author.userName,
          ...(device ? { device } : {}),
          content: body.text,
          ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
          attachments,
        });
      } catch (err) {
        return storeError(err);
      }
      emitBoth(p, message);
      deps.notify(p.peer.id, message);
      return created(message);
    },

    "memberDms.edit": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      const store = existing(p);
      const target = store?.get(ctx.params.id);
      if (!store || !target) return fail(404, "not_found");
      if (target.userId !== p.me.id) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatEditReq>;
      if (typeof body.text !== "string")
        return fail(400, "invalid_request", "text must be a string");
      let message: MembersChatMessage | null;
      try {
        message = store.edit(target.id, body.text);
      } catch (err) {
        return storeError(err);
      }
      if (!message) return fail(404, "not_found");
      emitBoth(p, message, true);
      return ok(message);
    },

    "memberDms.thumbsUp": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      if (p.peer.removed) return peerRemoved();
      const reactor = deps.authorFor(ctx.identity);
      if (!reactor) return fail(403, "forbidden");
      const body = (ctx.body ?? {}) as Partial<MembersChatThumbsUpReq>;
      if (typeof body.active !== "boolean")
        return fail(400, "invalid_request", "active must be a boolean");
      const message =
        existing(p)?.setThumbsUp(ctx.params.id, reactor, body.active) ?? null;
      if (!message) return fail(404, "not_found");
      emitBoth(p, message, true);
      return ok(message);
    },

    "memberDms.delete": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      const store = existing(p);
      const target = store?.get(ctx.params.id);
      if (!store || !target) return fail(404, "not_found");
      if (target.userId !== p.me.id) return fail(403, "forbidden");
      if (!store.delete(target.id)) return fail(404, "not_found");
      deps.emitDeleted(p.me.id, p.peer.id, target.id);
      deps.emitDeleted(p.peer.id, p.me.id, target.id);
      return noContent();
    },

    "memberDms.markRead": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      const body = (ctx.body ?? {}) as Partial<MembersChatReadReq>;
      if (typeof body.lastReadId !== "string")
        return fail(400, "invalid_request", "lastReadId must be a string");
      const store = existing(p);
      // No chat, nothing to mark: the read never makes one.
      if (!store) return ok({ readPointer: null, unread: 0 });
      const readPointer = store.setReadPointer(p.me.id, body.lastReadId);
      const unread = store.unreadCount(p.me.id);
      deps.emitRead(p.me.id, p.peer.id, readPointer, unread);
      return ok({ readPointer, unread });
    },

    "memberDms.upload": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      if (p.peer.removed) return peerRemoved();
      // The first file makes the chat; an upload with none makes nothing.
      return uploadFiles(ctx, "member-dms", (data, type, name) =>
        deps.dms.open(p.me, p.peer).saveAttachment(data, type, name),
      );
    },

    "memberDms.getFile": (ctx) => {
      const p = pairOf(ctx);
      if (!isPair(p)) return p;
      const filePath = existing(p)?.attachmentPath(ctx.params.filename) ?? null;
      if (!filePath) return fail(404, "not_found");
      return file(filePath, deps.contentTypeFor(ctx.params.filename), {
        ...deps.untrustedFileHeaders(),
        ...downloadHeader(ctx.query, ctx.params.filename),
      });
    },
  };
}
