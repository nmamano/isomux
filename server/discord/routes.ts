// A member's Discord routes (task 7fd44c30): the rules for adding, changing
// and removing a route, the live checks on its agent, and which route a
// message belongs to. A route's agent is one the member manages, not at Chat
// stop, as for a WhatsApp row. A route is added only for a server the bot is
// in now, and its target must be a channel of the right kind there.

import type { AgentAccess } from "../../shared/agent-access.ts";
import {
  DISCORD_ROUTES_MAX,
  normaliseDiscordPrefix,
  normaliseDiscordRouteName,
  type DiscordGuildSeen,
  type DiscordReplyMode,
  type DiscordRoute,
  type DiscordRouteCreateReq,
  type DiscordRouteDead,
  type DiscordRouteScope,
  type DiscordRouteTrigger,
  type DiscordRouteUpdateReq,
} from "../../shared/discord.ts";
import { WHATSAPP_PREFIX_MAX } from "../../shared/whatsapp.ts";
import { readDiscordRoutes, writeDiscordRoutes } from "./store.ts";

export interface DiscordRoutesDeps {
  stateRoot: string;
  now(): number;
  newId(): string;
  agent(
    agentId: string,
  ): { userId: string | null; access: AgentAccess; name: string } | null;
  // The member's own bot ids.
  botIds(userId: string): string[];
  // The servers the bot is in now; null when it has not connected yet.
  guilds(botId: string): DiscordGuildSeen[] | null;
}

export type DiscordRouteResult =
  | { ok: true; route: DiscordRoute }
  | { ok: false; status: 400 | 404 | 409; error: string };

// Where a message was posted. channelId is the channel itself for a thread
// or a forum post (the caller resolves the thread to its parent);
// categoryId is that channel's category, or null.
export interface DiscordMessagePlace {
  botId: string;
  guildId: string;
  channelId: string;
  categoryId: string | null;
}

export interface DiscordRoutes {
  list(userId: string): DiscordRoute[];
  create(userId: string, req: DiscordRouteCreateReq): DiscordRouteResult;
  update(
    userId: string,
    routeId: string,
    req: DiscordRouteUpdateReq,
  ): DiscordRouteResult;
  remove(userId: string, routeId: string): boolean;
  get(userId: string, routeId: string): DiscordRoute | null;
  // The live route of the same bot for a message: the channel route, else
  // the category route, else the server route. Null when none.
  forPlace(userId: string, place: DiscordMessagePlace): DiscordRoute | null;
  // The live routes of one bot.
  forBot(userId: string, botId: string): DiscordRoute[];
  // Re-reads the route's agent; marks the route dead and returns the reason.
  check(userId: string, route: DiscordRoute): DiscordRouteDead | null;
  // The bot was removed: its routes go.
  removeBot(userId: string, botId: string): void;
}

type Refusal = { ok: false; status: 400 | 404 | 409; error: string };

const refuse = (status: 400 | 404 | 409, error: string): Refusal => ({
  ok: false,
  status,
  error,
});

const isScope = (v: unknown): v is DiscordRouteScope =>
  v === "channel" || v === "category" || v === "server";
const isTrigger = (v: unknown): v is DiscordRouteTrigger =>
  v === "all" || v === "mention";
const isReplyMode = (v: unknown): v is DiscordReplyMode =>
  v === "bot" || v === "read" || v === "ask";

// A new route listens to mentions and replies only: a category or a whole
// server on "all" would wake the agent on every message there.
const DEFAULT_TRIGGER: DiscordRouteTrigger = "mention";
const DEFAULT_REPLY_MODE: DiscordReplyMode = "bot";

type SettingKey = "trigger" | "replyMode" | "prefix" | "includeBots" | "react";

// The settings of a create or an update, checked: the keys to set and the
// keys to delete (false and a blank prefix are the default, stored as no
// key), or a refusal.
function settingsOf(req: {
  trigger?: unknown;
  replyMode?: unknown;
  prefix?: unknown;
  includeBots?: unknown;
  react?: unknown;
}): { ok: true; set: Partial<DiscordRoute>; clear: SettingKey[] } | Refusal {
  const set: Partial<DiscordRoute> = {};
  const clear: SettingKey[] = [];
  if (req.trigger !== undefined) {
    if (!isTrigger(req.trigger))
      return refuse(400, "trigger must be all or mention");
    set.trigger = req.trigger;
  }
  if (req.replyMode !== undefined) {
    if (!isReplyMode(req.replyMode))
      return refuse(400, "replyMode must be bot, read or ask");
    set.replyMode = req.replyMode;
  }
  for (const key of ["includeBots", "react"] as const) {
    if (req[key] === undefined) continue;
    if (typeof req[key] !== "boolean")
      return refuse(400, `${key} must be true or false`);
    if (req[key]) set[key] = true;
    else clear.push(key);
  }
  if (req.prefix !== undefined) {
    const prefix =
      typeof req.prefix === "string"
        ? normaliseDiscordPrefix(req.prefix)
        : null;
    if (prefix === null)
      return refuse(
        400,
        `prefix must be at most ${WHATSAPP_PREFIX_MAX} characters on one line`,
      );
    if (prefix) set.prefix = prefix;
    else clear.push("prefix");
  }
  return { ok: true, set, clear };
}

// Why the target is not a place of the scope's kind in a server the bot
// sees, or null.
function targetProblem(
  guilds: DiscordGuildSeen[] | null,
  req: { guildId: unknown; scope: DiscordRouteScope; targetId: unknown },
): string | null {
  if (guilds === null) return "the bot is not connected yet";
  const guild = guilds.find((g) => g.id === req.guildId);
  if (!guild) return "the bot is not in this server";
  if (req.scope === "server")
    return req.targetId === guild.id ? null : "not this server";
  const channel = guild.channels.find((c) => c.id === req.targetId);
  if (!channel) return "the bot does not see this channel";
  if (req.scope === "category")
    return channel.kind === "category" ? null : "not a category";
  return channel.kind === "text" || channel.kind === "forum"
    ? null
    : "not a text or forum channel";
}

// Routes are read from disk at each call: the files are small.
export function createDiscordRoutes(deps: DiscordRoutesDeps): DiscordRoutes {
  const read = (userId: string) => readDiscordRoutes(deps.stateRoot, userId);
  const write = (userId: string, routes: DiscordRoute[]) =>
    writeDiscordRoutes(deps.stateRoot, userId, routes);

  function agentProblem(
    userId: string,
    agentId: unknown,
  ): DiscordRouteDead | null {
    const agent = typeof agentId === "string" ? deps.agent(agentId) : null;
    if (!agent) return "agent_gone";
    if (agent.userId !== userId) return "agent_not_yours";
    if (agent.access === "chat") return "agent_chat_only";
    return null;
  }

  const AGENT_ERRORS: Record<DiscordRouteDead, string> = {
    agent_gone: "no such agent",
    agent_not_yours: "the agent must be one you manage",
    agent_chat_only: "an agent at Chat stop cannot reply",
  };

  const live = (userId: string) => read(userId).filter((r) => !r.dead);

  const routes: DiscordRoutes = {
    // Each route's agent is checked again, so a dead route shows as dead.
    list(userId) {
      for (const route of read(userId)) routes.check(userId, route);
      return read(userId);
    },

    create(userId, req) {
      const name =
        typeof req.name === "string"
          ? normaliseDiscordRouteName(req.name)
          : null;
      if (name === null)
        return refuse(400, "name must be 1 to 60 characters on one line");
      if (!isScope(req.scope))
        return refuse(400, "scope must be channel, category or server");
      const settings = settingsOf(req);
      if (!settings.ok) return settings;
      const problem = agentProblem(userId, req.agentId);
      if (problem) return refuse(400, AGENT_ERRORS[problem]);
      if (
        typeof req.botId !== "string" ||
        !deps.botIds(userId).includes(req.botId)
      )
        return refuse(400, "no such bot");
      const where = targetProblem(deps.guilds(req.botId), req);
      if (where) return refuse(400, where);
      const file = read(userId);
      if (
        file.some(
          (r) =>
            r.botId === req.botId &&
            r.scope === req.scope &&
            r.targetId === req.targetId,
        )
      )
        return refuse(409, "this place already has a route");
      if (file.length >= DISCORD_ROUTES_MAX)
        return refuse(409, `at most ${DISCORD_ROUTES_MAX} routes`);
      const route: DiscordRoute = {
        id: deps.newId(),
        botId: req.botId,
        guildId: req.guildId,
        scope: req.scope,
        targetId: req.targetId,
        name,
        agentId: req.agentId,
        trigger: DEFAULT_TRIGGER,
        replyMode: DEFAULT_REPLY_MODE,
        createdAt: deps.now(),
        ...settings.set,
      };
      write(userId, [...file, route]);
      return { ok: true, route };
    },

    update(userId, routeId, req) {
      const file = read(userId);
      const index = file.findIndex((r) => r.id === routeId);
      if (index < 0) return refuse(404, "no such route");
      const next: DiscordRoute = { ...file[index] };
      if (req.name !== undefined) {
        const name =
          typeof req.name === "string"
            ? normaliseDiscordRouteName(req.name)
            : null;
        if (name === null)
          return refuse(400, "name must be 1 to 60 characters on one line");
        next.name = name;
      }
      if (req.agentId !== undefined) {
        if (typeof req.agentId !== "string")
          return refuse(400, "no such agent");
        next.agentId = req.agentId;
      }
      const settings = settingsOf(req);
      if (!settings.ok) return settings;
      Object.assign(next, settings.set);
      for (const key of settings.clear) delete next[key];
      const problem = agentProblem(userId, next.agentId);
      if (problem) return refuse(400, AGENT_ERRORS[problem]);
      // A route that passes the checks again is live again.
      delete next.dead;
      file[index] = next;
      write(userId, file);
      return { ok: true, route: next };
    },

    remove(userId, routeId) {
      const file = read(userId);
      const kept = file.filter((r) => r.id !== routeId);
      if (kept.length === file.length) return false;
      write(userId, kept);
      return true;
    },

    get: (userId, routeId) =>
      read(userId).find((r) => r.id === routeId) ?? null,

    forPlace(userId, place) {
      const mine = live(userId).filter(
        (r) => r.botId === place.botId && r.guildId === place.guildId,
      );
      return (
        mine.find(
          (r) => r.scope === "channel" && r.targetId === place.channelId,
        ) ??
        (place.categoryId === null
          ? undefined
          : mine.find(
              (r) => r.scope === "category" && r.targetId === place.categoryId,
            )) ??
        mine.find(
          (r) => r.scope === "server" && r.targetId === place.guildId,
        ) ??
        null
      );
    },

    forBot: (userId, botId) => live(userId).filter((r) => r.botId === botId),

    check(userId, route) {
      const problem = agentProblem(userId, route.agentId);
      if (!problem) return null;
      const file = read(userId);
      const stored = file.find((r) => r.id === route.id);
      if (stored && stored.dead !== problem) {
        stored.dead = problem;
        write(userId, file);
      }
      return problem;
    },

    removeBot(userId, botId) {
      const file = read(userId);
      const kept = file.filter((r) => r.botId !== botId);
      if (kept.length !== file.length) write(userId, kept);
    },
  };
  return routes;
}
