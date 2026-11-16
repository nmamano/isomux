// The routes of the messaging apps (opIds messaging.reply and
// messaging.read): an agent answers on its own route, in WhatsApp or Discord,
// and reads a WhatsApp route's chat (server/messaging/replies.ts dispatches
// by app).
//
// LEAF over the executor and the replies.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { MessagingRoutesApi } from "../../messaging/replies.ts";

export interface MessagingDeps {
  replies: Pick<MessagingRoutesApi, "reply" | "read" | "routes">;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function messagingHandlers(
  deps: MessagingDeps,
): Record<string, RouteHandler> {
  return {
    // The agent's own live routes, in every app.
    "messaging.routes": (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId)
        return fail(403, "forbidden");
      return ok({ routes: deps.replies.routes(agentId) });
    },

    // The last messages of the agent's own route (WhatsApp only).
    "messaging.read": (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId)
        return fail(403, "forbidden");
      const res = deps.replies.read(
        agentId,
        ctx.params.routeId,
        ctx.query.get("limit") ?? undefined,
      );
      if (!res.ok) return fail(res.status, res.code, res.error);
      return ok({ messages: res.messages });
    },

    // A draft that waits for the member (202), or the message sent (200).
    "messaging.reply": async (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId)
        return fail(403, "forbidden");
      const body = isObject(ctx.body) ? ctx.body : {};
      // A draft waits for the route's member only (task 9461c464).
      if (Array.isArray(body.member) || body.room !== undefined)
        return fail(
          422,
          "invalid_members",
          "a reply draft is for the route's member only",
        );
      const res = await deps.replies.reply(agentId, ctx.params.routeId, {
        text: body.text,
        channelId: body.channelId,
        replyTo: body.replyTo,
      });
      if (!res.ok) return fail(res.status, res.code, res.error);
      if ("sent" in res)
        return ok({
          status: "sent",
          ...(res.messageId ? { messageId: res.messageId } : {}),
        });
      return ok({ askId: res.askId, status: "waiting_for_member" }, 202);
    },
  };
}
