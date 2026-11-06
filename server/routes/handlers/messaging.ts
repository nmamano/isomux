// The reply route of the messaging apps (opId messaging.reply): an agent
// answers on its own route, in WhatsApp or Discord (server/messaging/
// replies.ts dispatches by app).
//
// LEAF over the executor and the replies.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { MessagingAppReplies } from "../../messaging/replies.ts";

export interface MessagingDeps {
  replies: Pick<MessagingAppReplies, "reply">;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function messagingHandlers(
  deps: MessagingDeps,
): Record<string, RouteHandler> {
  return {
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
