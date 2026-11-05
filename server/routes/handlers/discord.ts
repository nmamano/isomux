// Discord handlers (task 7fd44c30). The caller's own bots and routes only:
// the route table passes the member by cookie, or their privileged agent
// acting for them (task c92d60f4; discord.connect stays the member's), never
// an API token or an owner acting for a member.
//
//   discord.list          GET    /api/discord                   -> DiscordBotListed[]
//   discord.connect       POST   /api/discord/bots              {token} -> DiscordBot
//   discord.disconnect    DELETE /api/discord/bots/:botId       -> 204
//   discord.guilds        GET    /api/discord/bots/:botId/guilds -> DiscordGuildSeen[]
//   discordRoutes.list    GET    /api/discord/routes            -> DiscordRoute[]
//   discordRoutes.create  POST   /api/discord/routes            -> DiscordRoute
//   discordRoutes.update  PATCH  /api/discord/routes/:routeId   -> DiscordRoute
//   discordRoutes.delete  DELETE /api/discord/routes/:routeId   -> 204
//
// LEAF over the executor, the supervisor and the routes.

import { fail, noContent, ok, type RouteHandler } from "../executor.ts";
import {
  discordInviteUrl,
  type DiscordRouteCreateReq,
  type DiscordRouteUpdateReq,
} from "../../../shared/discord.ts";
import type {
  DiscordRouteResult,
  DiscordRoutes,
} from "../../discord/routes.ts";
import type { DiscordSupervisor } from "../../discord/supervisor.ts";

export interface DiscordDeps {
  supervisor: Pick<
    DiscordSupervisor,
    "list" | "connect" | "disconnect" | "guilds"
  >;
  routes: DiscordRoutes;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ROUTE_ERROR_CODES = {
  400: "invalid_request",
  404: "not_found",
  409: "conflict",
} as const;

function routeResult(res: DiscordRouteResult) {
  return res.ok
    ? ok(res.route)
    : fail(res.status, ROUTE_ERROR_CODES[res.status], res.error);
}

// The fields a route may carry, passed on as they came: the routes check
// their types.
const SETTINGS = [
  "name",
  "agentId",
  "trigger",
  "replyMode",
  "prefix",
  "includeBots",
  "react",
] as const;

function pick(body: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

export function discordHandlers(
  deps: DiscordDeps,
): Record<string, RouteHandler> {
  return {
    "discord.list": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return ok(
        deps.supervisor
          .list(userId)
          .map((bot) => ({ ...bot, inviteUrl: discordInviteUrl(bot.id) })),
      );
    },

    "discord.connect": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const token = isObject(ctx.body) ? ctx.body.token : undefined;
      if (typeof token !== "string" || token.trim() === "")
        return fail(400, "invalid_request", 'send {"token": "<bot token>"}');
      const res = await deps.supervisor.connect(userId, token);
      if (!res.ok) return fail(res.status, res.code, res.error);
      return ok(res.bot);
    },

    "discord.disconnect": async (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return (await deps.supervisor.disconnect(userId, ctx.params.botId))
        ? noContent()
        : fail(404, "not_found", "no such bot");
    },

    "discord.guilds": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const guilds = deps.supervisor.guilds(userId, ctx.params.botId);
      return guilds
        ? ok(guilds)
        : fail(404, "not_found", "no such bot, or it is not connected yet");
    },

    "discordRoutes.list": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return ok(deps.routes.list(userId));
    },

    "discordRoutes.create": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      if (!isObject(ctx.body))
        return fail(400, "invalid_request", "send a route as JSON");
      const req = pick(ctx.body, [
        "botId",
        "guildId",
        "scope",
        "targetId",
        ...SETTINGS,
      ]) as unknown as DiscordRouteCreateReq;
      return routeResult(deps.routes.create(userId, req));
    },

    // The bot and the place are not fields of an update.
    "discordRoutes.update": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      const body = isObject(ctx.body) ? ctx.body : {};
      const req = pick(body, SETTINGS) as DiscordRouteUpdateReq;
      return routeResult(deps.routes.update(userId, ctx.params.routeId, req));
    },

    "discordRoutes.delete": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(403, "forbidden");
      return deps.routes.remove(userId, ctx.params.routeId)
        ? noContent()
        : fail(404, "not_found", "no such route");
    },
  };
}
