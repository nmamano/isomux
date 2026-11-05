// A member's WhatsApp contact rows (task d03a61d8, slice 2): the rules for
// adding, changing and removing a row, and the live checks on its agent.
// A row's agent is one the member manages, not at Chat stop (it could not
// reply). The chat cannot change: delete the row and add another.

import type { AgentAccess } from "../../shared/agent-access.ts";
import {
  WHATSAPP_PREFIX_MAX,
  WHATSAPP_ROUTES_MAX,
  normaliseWhatsAppPhone,
  normaliseWhatsAppPrefix,
  normaliseWhatsAppRouteName,
  type WhatsAppRoute,
  type WhatsAppRouteCreateReq,
  type WhatsAppRouteDead,
  type WhatsAppRouteTrigger,
  type WhatsAppRouteUpdateReq,
} from "../../shared/whatsapp.ts";
import { readRoutes, writeRoutes, type RoutesFile } from "./routes-store.ts";

export interface WhatsAppRoutesDeps {
  stateRoot: string;
  now(): number;
  newId(): string;
  agent(
    agentId: string,
  ): { userId: string | null; access: AgentAccess; name: string } | null;
  // The linked phone, or null when the member is not linked.
  linkedPhone(userId: string): string | null;
  // The rows changed: the bridge gets the new allowlist.
  onChange(userId: string): void;
}

export type WhatsAppRouteResult =
  | { ok: true; route: WhatsAppRoute }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface WhatsAppRoutes {
  list(userId: string): WhatsAppRoute[];
  create(userId: string, req: WhatsAppRouteCreateReq): WhatsAppRouteResult;
  update(
    userId: string,
    routeId: string,
    req: WhatsAppRouteUpdateReq,
  ): WhatsAppRouteResult;
  remove(userId: string, routeId: string): boolean;
  get(userId: string, routeId: string): WhatsAppRoute | null;
  // The live row for a chat (a dead row delivers nothing).
  forChat(userId: string, chat: string): WhatsAppRoute | null;
  // The chats of the live rows: the bridge's allowlist.
  allowlist(userId: string): string[];
  // Re-reads the row's agent; marks the row dead and returns the reason.
  check(userId: string, route: WhatsAppRoute): WhatsAppRouteDead | null;
  // A link was accepted: rows made for another phone are dropped.
  onLinked(userId: string, phone: string): void;
}

// A contact (<digits>@s.whatsapp.net or <digits>@lid) or a group (@g.us).
const CHAT_RE = /^(?:[0-9]{5,20}@(?:s\.whatsapp\.net|lid)|[0-9-]{5,40}@g\.us)$/;

const isTrigger = (v: unknown): v is WhatsAppRouteTrigger =>
  v === "mention" || v === "all";

type Refusal = { ok: false; status: 400 | 404 | 409; error: string };

const refuse = (status: 400 | 404 | 409, error: string): Refusal => ({
  ok: false,
  status,
  error,
});

// The reply settings of a create or an update, checked: the keys to set and
// the keys to delete (false and a blank prefix are the default, stored as no
// key), or a refusal.
function replySettings(req: { sendDirect?: unknown; prefix?: unknown }):
  | {
      ok: true;
      set: Partial<WhatsAppRoute>;
      clear: ("sendDirect" | "prefix")[];
    }
  | Refusal {
  const set: Partial<WhatsAppRoute> = {};
  const clear: ("sendDirect" | "prefix")[] = [];
  if (req.sendDirect !== undefined) {
    if (typeof req.sendDirect !== "boolean")
      return refuse(400, "sendDirect must be true or false");
    if (req.sendDirect) set.sendDirect = true;
    else clear.push("sendDirect");
  }
  if (req.prefix !== undefined) {
    const prefix =
      typeof req.prefix === "string"
        ? normaliseWhatsAppPrefix(req.prefix)
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

// The rows are read from disk at each call: the files are small, and an
// unlink deletes the directory under any cache.
export function createWhatsAppRoutes(deps: WhatsAppRoutesDeps): WhatsAppRoutes {
  const read = (userId: string): RoutesFile =>
    readRoutes(deps.stateRoot, userId);
  const write = (userId: string, file: RoutesFile) =>
    writeRoutes(deps.stateRoot, userId, file);

  // Why this agent cannot be a row's agent for this member, or null.
  function agentProblem(
    userId: string,
    agentId: string,
  ): WhatsAppRouteDead | null {
    const agent = deps.agent(agentId);
    if (!agent) return "agent_gone";
    if (agent.userId !== userId) return "agent_not_yours";
    if (agent.access === "chat") return "agent_chat_only";
    return null;
  }

  const AGENT_ERRORS: Record<WhatsAppRouteDead, string> = {
    agent_gone: "no such agent",
    agent_not_yours: "the agent must be one you manage",
    agent_chat_only: "an agent at Chat stop cannot reply",
  };

  const routes: WhatsAppRoutes = {
    // Each row's agent is checked again, so a dead row shows as dead.
    list(userId) {
      for (const route of read(userId).routes) routes.check(userId, route);
      return read(userId).routes;
    },

    create(userId, req) {
      const phone = deps.linkedPhone(userId);
      if (phone === null) return refuse(400, "link WhatsApp first");
      const name =
        typeof req.name === "string"
          ? normaliseWhatsAppRouteName(req.name)
          : null;
      if (name === null)
        return refuse(400, "name must be 1 to 60 characters on one line");
      let chat: string;
      if ("phone" in req) {
        const digits =
          typeof req.phone === "string"
            ? normaliseWhatsAppPhone(req.phone)
            : null;
        if (digits === null)
          return refuse(
            400,
            "phone must be the full number with the country code",
          );
        chat = `${digits}@s.whatsapp.net`;
      } else {
        if (typeof req.chat !== "string" || !CHAT_RE.test(req.chat))
          return refuse(400, "not a WhatsApp chat");
        chat = req.chat;
      }
      const group = chat.endsWith("@g.us");
      const trigger = "trigger" in req ? req.trigger : undefined;
      if (trigger !== undefined && (!group || !isTrigger(trigger)))
        return refuse(400, "a trigger is for a group only: mention or all");
      const settings = replySettings(req);
      if (!settings.ok) return settings;
      const problem = agentProblem(userId, req.agentId);
      if (problem) return refuse(400, AGENT_ERRORS[problem]);
      const file = read(userId);
      if (file.routes.some((r) => r.chat === chat))
        return refuse(409, "this chat already has a row");
      if (file.routes.length >= WHATSAPP_ROUTES_MAX)
        return refuse(409, `at most ${WHATSAPP_ROUTES_MAX} rows`);
      const route: WhatsAppRoute = {
        id: deps.newId(),
        chat,
        group,
        name,
        agentId: req.agentId,
        ...(group ? { trigger: trigger ?? "mention" } : {}),
        createdAt: deps.now(),
        ...settings.set,
      };
      write(userId, { phone, routes: [...file.routes, route] });
      deps.onChange(userId);
      return { ok: true, route };
    },

    update(userId, routeId, req) {
      const file = read(userId);
      const index = file.routes.findIndex((r) => r.id === routeId);
      if (index < 0) return refuse(404, "no such row");
      const next: WhatsAppRoute = { ...file.routes[index] };
      if (req.name !== undefined) {
        const name =
          typeof req.name === "string"
            ? normaliseWhatsAppRouteName(req.name)
            : null;
        if (name === null)
          return refuse(400, "name must be 1 to 60 characters on one line");
        next.name = name;
      }
      if (req.trigger !== undefined) {
        if (!next.group || !isTrigger(req.trigger))
          return refuse(400, "a trigger is for a group only: mention or all");
        next.trigger = req.trigger;
      }
      if (req.agentId !== undefined) {
        if (typeof req.agentId !== "string")
          return refuse(400, "no such agent");
        next.agentId = req.agentId;
      }
      const settings = replySettings(req);
      if (!settings.ok) return settings;
      Object.assign(next, settings.set);
      for (const key of settings.clear) delete next[key];
      const problem = agentProblem(userId, next.agentId);
      if (problem) return refuse(400, AGENT_ERRORS[problem]);
      // A row that passes the checks again is live again.
      delete next.dead;
      file.routes[index] = next;
      write(userId, file);
      deps.onChange(userId);
      return { ok: true, route: next };
    },

    remove(userId, routeId) {
      const file = read(userId);
      const routes = file.routes.filter((r) => r.id !== routeId);
      if (routes.length === file.routes.length) return false;
      write(userId, { ...file, routes });
      deps.onChange(userId);
      return true;
    },

    get: (userId, routeId) =>
      read(userId).routes.find((r) => r.id === routeId) ?? null,

    forChat: (userId, chat) =>
      read(userId).routes.find((r) => r.chat === chat && !r.dead) ?? null,

    allowlist: (userId) =>
      read(userId)
        .routes.filter((r) => !r.dead)
        .map((r) => r.chat),

    check(userId, route) {
      const problem = agentProblem(userId, route.agentId);
      if (!problem) return null;
      const file = read(userId);
      const stored = file.routes.find((r) => r.id === route.id);
      if (stored && stored.dead !== problem) {
        stored.dead = problem;
        write(userId, file);
        deps.onChange(userId);
      }
      return problem;
    },

    onLinked(userId, phone) {
      const file = read(userId);
      if (file.phone === phone) return;
      const dropped = file.phone !== null && file.routes.length > 0;
      write(userId, { phone, routes: file.phone === null ? file.routes : [] });
      if (dropped) deps.onChange(userId);
    },
  };
  return routes;
}
