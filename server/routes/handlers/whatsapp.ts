// WhatsApp link handlers (opIds whatsapp.{status,link,unlink}, task d03a61d8).
// The caller's own link only: the route table passes a signed-in member
// (user:self), never an agent or an owner acting for a member.
//
// LEAF over the executor and the supervisor.

import { fail, noContent, ok, type RouteHandler } from "../executor.ts";
import type {
  WhatsAppLinkReq,
  WhatsAppRouteCreateReq,
  WhatsAppRouteTrigger,
  WhatsAppRouteUpdateReq,
} from "../../../shared/whatsapp.ts";
import type { WhatsAppSupervisor } from "../../whatsapp/supervisor.ts";
import type { WhatsAppReplies } from "../../whatsapp/replies.ts";
import type {
  WhatsAppRouteResult,
  WhatsAppRoutes,
} from "../../whatsapp/routes.ts";

export interface WhatsAppDeps {
  supervisor: WhatsAppSupervisor;
  routes: WhatsAppRoutes;
  replies: Pick<WhatsAppReplies, "reply">;
}

const ERROR_CODES = {
  400: "invalid_request",
  409: "whatsapp_busy",
  429: "too_many_codes",
} as const;

function parseLinkReq(body: unknown): WhatsAppLinkReq | null {
  if (typeof body !== "object" || body === null) return null;
  const { method, phone } = body as Record<string, unknown>;
  if (method === "qr") return { method };
  if (method === "code" && typeof phone === "string") return { method, phone };
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseCreateReq(body: unknown): WhatsAppRouteCreateReq | null {
  if (!isObject(body)) return null;
  const { chat, phone, name, agentId, trigger, sendDirect, prefix } = body;
  if (typeof name !== "string" || typeof agentId !== "string") return null;
  // Passed on as they came: the routes check their types.
  const settings = {
    ...(sendDirect !== undefined ? { sendDirect: sendDirect as boolean } : {}),
    ...(prefix !== undefined ? { prefix: prefix as string } : {}),
  };
  if (typeof phone === "string" && chat === undefined)
    return { phone, name, agentId, ...settings };
  if (typeof chat !== "string") return null;
  return {
    chat,
    name,
    agentId,
    ...(trigger !== undefined
      ? { trigger: trigger as WhatsAppRouteTrigger }
      : {}),
    ...settings,
  };
}

const ROUTE_ERROR_CODES = {
  400: "invalid_request",
  404: "not_found",
  409: "conflict",
} as const;

function routeResult(res: WhatsAppRouteResult) {
  return res.ok
    ? ok(res.route)
    : fail(res.status, ROUTE_ERROR_CODES[res.status], res.error);
}

export function whatsappHandlers(
  deps: WhatsAppDeps,
): Record<string, RouteHandler> {
  return {
    "whatsapp.status": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return ok(deps.supervisor.status(userId));
    },

    "whatsapp.link": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const req = parseLinkReq(ctx.body);
      if (!req)
        return fail(
          400,
          "invalid_request",
          'send {"method":"qr"} or {"method":"code","phone":...}',
        );
      const res = await deps.supervisor.link(userId, req);
      if (!res.ok) return fail(res.status, ERROR_CODES[res.status], res.error);
      return ok(res.status);
    },

    // The contact rows and the chats-seen picker (slice 2).
    "whatsapp.chats": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return ok(deps.supervisor.chatsSeen(userId));
    },
    "whatsappRoutes.list": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return ok(deps.routes.list(userId));
    },
    "whatsappRoutes.create": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const req = parseCreateReq(ctx.body);
      if (!req)
        return fail(
          400,
          "invalid_request",
          "send name, agentId, and chat or phone",
        );
      return routeResult(deps.routes.create(userId, req));
    },
    "whatsappRoutes.update": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const body = isObject(ctx.body) ? ctx.body : {};
      // The chat is not a field of an update.
      const req: WhatsAppRouteUpdateReq = {};
      if (body.name !== undefined) req.name = body.name as string;
      if (body.agentId !== undefined) req.agentId = body.agentId as string;
      if (body.trigger !== undefined)
        req.trigger = body.trigger as WhatsAppRouteTrigger;
      if (body.sendDirect !== undefined)
        req.sendDirect = body.sendDirect as boolean;
      if (body.prefix !== undefined) req.prefix = body.prefix as string;
      return routeResult(deps.routes.update(userId, ctx.params.routeId, req));
    },
    "whatsappRoutes.delete": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return deps.routes.remove(userId, ctx.params.routeId)
        ? noContent()
        : fail(404, "not_found", "no such row");
    },

    // An agent's reply to its row (slice 2b): an ask to the member, or, on a
    // row that sends at once, the message itself (task 70fae82c). The route
    // id names a WhatsApp row: see WhatsAppReplies.reply for the id space a
    // second messaging app shares.
    "messaging.reply": async (ctx) => {
      const agentId = ctx.identity.agentId;
      if (ctx.identity.scope !== "agent" || !agentId)
        return fail(403, "forbidden");
      const text = isObject(ctx.body) ? ctx.body.text : undefined;
      const res = await deps.replies.reply(agentId, ctx.params.routeId, text);
      if (!res.ok) return fail(res.status, res.code, res.error);
      if ("sent" in res) return ok({ status: "sent" });
      return ok({ askId: res.askId, status: "waiting_for_member" }, 202);
    },

    "whatsapp.unlink": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      await deps.supervisor.unlink(userId);
      return noContent();
    },
  };
}
