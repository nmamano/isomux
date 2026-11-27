// Action steps on the member's messaging routes: a Discord route, a
// WhatsApp row, and a change to either. One family of
// server/step-asks.ts (STEP_FAMILY in server/step-asks-common.ts).

import type { ActionStepRequest, AskStep } from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import {
  WHATSAPP_PREFIX_MAX,
  WHATSAPP_ROUTE_NAME_MAX,
  normaliseWhatsAppPhone,
  normaliseWhatsAppPrefix,
  normaliseWhatsAppRouteName,
  whatsappChatMatches,
  whatsappPhoneChat,
  type WhatsAppChatSeen,
  type WhatsAppRoute,
} from "../shared/whatsapp.ts";
import { replySettings } from "./whatsapp/routes.ts";
import { discordRouteSettings } from "./discord/routes.ts";
import {
  discordPlacesMatching,
  normaliseDiscordPrefix,
  normaliseDiscordRouteName,
  type DiscordPlace,
  type DiscordReplyMode,
  type DiscordRoute,
  type DiscordRouteTrigger,
} from "../shared/discord.ts";
import type {
  StepAskDeps,
  StepFailure,
  StepRoute,
  StepRun,
  StepRunDeps,
} from "./step-asks.ts";
import {
  allSet,
  firstRoute,
  invalid,
  isObject,
  notAllowed,
  unknownRoute,
  type CompleteInput,
  type FamilyStep,
  type StepFamily,
} from "./step-asks-common.ts";

type S = FamilyStep<"messaging">;

type WhatsAppRouteStep = Extract<AskStep, { kind: "whatsapp-route" }>;

// Whether a row's chat matches the step: by the row's name, by the name the
// bridge saw for its chat, or by the step's number.
function rowMatches(
  row: WhatsAppRoute,
  step: WhatsAppRouteStep,
  seen: readonly WhatsAppChatSeen[],
): boolean {
  return (
    whatsappChatMatches(row, step) ||
    seen.some((c) => c.chat === row.chat && whatsappChatMatches(c, step))
  );
}

// The row settings a whatsapp-route step sets, every one explicit: an omitted
// one is the default (drafts, own messages off, no prefix, mention). A
// trigger only for a group.
function stepRowSettings(
  step: WhatsAppRouteStep,
  group: boolean,
): {
  sendDirect: boolean;
  ownMessages: boolean;
  prefix: string;
  trigger?: "mention" | "all";
} {
  return {
    sendDirect: step.sendDirect === true,
    ownMessages: step.ownMessages === true,
    prefix: step.prefix ?? "",
    ...(group ? { trigger: step.trigger ?? "mention" } : {}),
  };
}

// Whether a row is what the step asks for: its agent and all its settings.
function rowIsStep(row: WhatsAppRoute, step: WhatsAppRouteStep): boolean {
  const want = stepRowSettings(step, row.group);
  return (
    row.agentId === step.agentId &&
    (row.sendDirect === true) === want.sendDirect &&
    (row.ownMessages === true) === want.ownMessages &&
    (row.prefix ?? "") === want.prefix &&
    (!row.group || (row.trigger ?? "mention") === want.trigger)
  );
}

// The name a new row takes: the chat's name as the bridge saw it, cut to the
// row name's length, else the name the agent gave.
function newRowName(
  chat: string,
  seenName: string | undefined,
  chatName: string,
): string {
  // A contact with no saved name is seen as its bare number: the agent's
  // name for it says more.
  if (seenName === undefined || chat === whatsappPhoneChat(seenName))
    return chatName;
  return cutRouteName(seenName) ?? chatName;
}

type DiscordRouteStep = Extract<AskStep, { kind: "discord-route" }>;

// The route settings a discord-route step sets, every one explicit: an
// omitted one is the default (mention, replies wait for Send, no prefix, bot
// posts and react off).
function stepRouteSettings(step: DiscordRouteStep): {
  trigger: DiscordRouteTrigger;
  replyMode: DiscordReplyMode;
  prefix: string;
  includeBots: boolean;
  react: boolean;
} {
  return {
    trigger: step.trigger ?? "mention",
    replyMode: step.replyMode ?? "ask",
    prefix: step.prefix ?? "",
    includeBots: step.includeBots === true,
    react: step.react === true,
  };
}

// Whether a route is what the step asks for: its agent and all its settings.
function routeIsStep(route: DiscordRoute, step: DiscordRouteStep): boolean {
  const want = stepRouteSettings(step);
  return (
    route.agentId === step.agentId &&
    route.trigger === want.trigger &&
    route.replyMode === want.replyMode &&
    (route.prefix ?? "") === want.prefix &&
    (route.includeBots === true) === want.includeBots &&
    (route.react === true) === want.react
  );
}

// Whether a route listens at the place: the same bot, scope and target.
const samePlace = (
  place: { botId: string; scope: string; targetId: string },
  route: { botId: string; scope: string; targetId: string },
) =>
  place.botId === route.botId &&
  place.scope === route.scope &&
  place.targetId === route.targetId;

// The places of the member's bots that match the step, over the servers each
// bot is in now (a bot that has not connected has none).
function discordPlaces(
  dc: StepRunDeps["discord"],
  step: DiscordRouteStep,
  memberUserId: string,
): DiscordPlace[] {
  return discordPlacesMatching(
    step.placeName,
    step.scope,
    dc.bots(memberUserId).map((bot) => ({
      botId: bot.id,
      guilds: dc.guilds(memberUserId, bot.id) ?? [],
    })),
  );
}

// The name a new row or route takes: the place's own name cut to the name's
// length, else the name the agent gave.
function cutRouteName(name: string): string | null {
  const cut = [...name.trim()].slice(0, WHATSAPP_ROUTE_NAME_MAX).join("");
  return normaliseWhatsAppRouteName(cut);
}

// The keys a messaging-route step may set: the keys of the app's PATCH.
const ROUTE_SET_KEYS: Record<"discord" | "whatsapp", readonly string[]> = {
  discord: [
    "name",
    "agentId",
    "trigger",
    "replyMode",
    "prefix",
    "includeBots",
    "react",
  ],
  whatsapp: [
    "name",
    "agentId",
    "trigger",
    "sendDirect",
    "prefix",
    "ownMessages",
  ],
};

type MessagingRouteStep = Extract<AskStep, { kind: "messaging-route" }>;

// One route of a member, of either app.
type FoundRoute =
  | { app: "discord"; route: DiscordRoute }
  | { app: "whatsapp"; route: WhatsAppRoute };

// The member's route with this id, in the app given, else in either: the
// ids differ by prefix (d_ for Discord, r_ for WhatsApp), so at most one
// matches. Null when the member has none.
function findRoute(
  runs: StepRunDeps,
  memberUserId: string,
  routeId: string,
  app?: "discord" | "whatsapp",
): FoundRoute | null {
  if (app !== "whatsapp") {
    const route = runs.discord
      .routes(memberUserId)
      .find((r) => r.id === routeId);
    if (route) return { app: "discord", route };
  }
  if (app !== "discord") {
    const route = runs.whatsapp
      .rows(memberUserId)
      .find((r) => r.id === routeId);
    if (route) return { app: "whatsapp", route };
  }
  return null;
}

// The route's settings as a step compares them: a key the route does not
// store has its default (off, no prefix, mention on a group).
function routeValues(found: FoundRoute): Record<string, unknown> {
  const common = {
    name: found.route.name,
    agentId: found.route.agentId,
    prefix: found.route.prefix ?? "",
  };
  return found.app === "discord"
    ? {
        ...common,
        trigger: found.route.trigger,
        replyMode: found.route.replyMode,
        includeBots: found.route.includeBots === true,
        react: found.route.react === true,
      }
    : {
        ...common,
        trigger: found.route.group
          ? (found.route.trigger ?? "mention")
          : undefined,
        sendDirect: found.route.sendDirect === true,
        ownMessages: found.route.ownMessages === true,
      };
}

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: S, target: string): LogMessage {
  switch (step.kind) {
    // The name the agent gave, never the place's: the agent learns no
    // Discord name it did not give.
    case "discord-route":
      return msg("systemEntries.stepAsk.discordRouted", {
        place: step.placeName,
        agent: target,
      });
    // The name the agent gave, never the picked chat's: the agent learns no
    // chat name it did not give.
    case "whatsapp-route":
      return msg("systemEntries.stepAsk.whatsappRouted", {
        chat: step.chatName,
        agent: target,
      });
    // The id the agent gave, never the route's name: the agent learns no
    // name it did not give.
    case "messaging-route":
      return msg("systemEntries.stepAsk.messagingRouteSet", {
        route: step.routeId,
      });
  }
}

export function createMessagingSteps(deps: StepAskDeps): StepFamily<S> {
  // The run of a whatsapp-route step on the picked chat: a chat that matches
  // the step's name or number, seen by the bridge or already a row, or the
  // chat of the step's number. A chat with a row
  // moves to the agent with the step's settings (the row keeps its name); a
  // chat with none gets a row.
  function whatsappRouteRun(
    step: WhatsAppRouteStep,
    memberUserId: string,
    pick: unknown,
  ): StepRun {
    const wa = deps.runs?.whatsapp;
    if (!wa) return invalid("this office runs no action steps");
    const chat =
      isObject(pick) && typeof pick.chat === "string" ? pick.chat : null;
    if (!chat) return invalid("send {chat}: the chat the member picked");
    const seen = wa.chatsSeen(memberUserId);
    const seenChat = seen.find((c) => c.chat === chat);
    const row = wa.rows(memberUserId).find((r) => r.chat === chat);
    // The step's number routes even when no chat for it was seen.
    const matches =
      (!!seenChat && whatsappChatMatches(seenChat, step)) ||
      (!!row && rowMatches(row, step, seen)) ||
      (step.phone !== undefined && chat === whatsappPhoneChat(step.phone));
    if (!matches)
      return {
        ok: false,
        status: 409,
        code: "chat_not_matching",
        message: "this chat does not match the name the ask gives",
      };
    const settings = stepRowSettings(step, chat.endsWith("@g.us"));
    return {
      ok: true,
      routes: [
        row
          ? {
              method: "PATCH",
              path: `/api/whatsapp/routes/${encodeURIComponent(row.id)}`,
              body: { agentId: step.agentId, ...settings },
            }
          : {
              method: "POST",
              path: "/api/whatsapp/routes",
              body: {
                chat,
                name: newRowName(chat, seenChat?.name, step.chatName),
                agentId: step.agentId,
                ...settings,
              },
            },
      ],
    };
  }

  // The run of a discord-route step on the picked place: one of the places
  // of the member's bots that match the step now. A place with a route moves
  // to the agent with the step's settings (the route keeps its name); a
  // place with none gets a route, named by the place.
  function discordRouteRun(
    step: DiscordRouteStep,
    memberUserId: string,
    pick: unknown,
  ): StepRun {
    const dc = deps.runs?.discord;
    if (!dc) return invalid("this office runs no action steps");
    const scopes: readonly unknown[] = ["channel", "category", "server"];
    if (
      !isObject(pick) ||
      typeof pick.botId !== "string" ||
      typeof pick.guildId !== "string" ||
      typeof pick.targetId !== "string" ||
      !scopes.includes(pick.scope)
    )
      return invalid(
        "send {botId, guildId, scope, targetId}: the place the member picked",
      );
    const picked = {
      botId: pick.botId,
      guildId: pick.guildId,
      scope: pick.scope as string,
      targetId: pick.targetId,
    };
    const place = discordPlaces(dc, step, memberUserId).find(
      (p) => samePlace(p, picked) && p.guildId === picked.guildId,
    );
    if (!place)
      return {
        ok: false,
        status: 409,
        code: "place_not_matching",
        message: "this place does not match the name the ask gives",
      };
    const route = dc.routes(memberUserId).find((r) => samePlace(place, r));
    const settings = stepRouteSettings(step);
    return {
      ok: true,
      routes: [
        route
          ? {
              method: "PATCH",
              path: `/api/discord/routes/${encodeURIComponent(route.id)}`,
              body: { agentId: step.agentId, ...settings },
            }
          : {
              method: "POST",
              path: "/api/discord/routes",
              body: {
                botId: place.botId,
                guildId: place.guildId,
                scope: place.scope,
                targetId: place.targetId,
                name: cutRouteName(place.name) ?? step.placeName,
                agentId: step.agentId,
                ...settings,
              },
            },
      ],
    };
  }

  // A messaging-route step as the agent sent it, with the route's app, and
  // `set` checked by the app's own route checks and kept as the PATCH
  // stores it (name and prefix normalised). An id the member has no route
  // for, another member's included, is refused with one answer that names
  // nothing of the route.
  function completeMessagingRoute(
    body: Record<string, unknown>,
    memberUserId: string,
  ): { ok: true; step: AskStep } | StepFailure {
    const { routeId, set } = body;
    if (typeof routeId !== "string" || routeId === "")
      return invalid("step.routeId is the id of one of the member's routes");
    if (!isObject(set) || Object.keys(set).length === 0)
      return invalid("step.set is an object of the settings to change");
    if (!deps.runs) return invalid("this office runs no action steps");
    const found = findRoute(deps.runs, memberUserId, routeId);
    if (!found) return unknownRoute();
    const keys = ROUTE_SET_KEYS[found.app];
    if (!Object.keys(set).every((key) => keys.includes(key)))
      return invalid(`step.set takes only ${keys.join(", ")} for this route`);
    const out: Record<string, unknown> = { ...set };
    if (
      set.agentId !== undefined &&
      (typeof set.agentId !== "string" || set.agentId === "")
    )
      return invalid("step.set.agentId is an agent id");
    if (set.name !== undefined) {
      const name =
        typeof set.name !== "string"
          ? null
          : found.app === "discord"
            ? normaliseDiscordRouteName(set.name)
            : normaliseWhatsAppRouteName(set.name);
      if (name === null)
        return invalid(
          `step.set.name is 1 to ${WHATSAPP_ROUTE_NAME_MAX} characters on one line`,
        );
      out.name = name;
    }
    if (found.app === "whatsapp" && set.trigger !== undefined) {
      if (set.trigger !== "mention" && set.trigger !== "all")
        return invalid("step.set.trigger is mention or all");
      // As the row's PATCH says.
      if (!found.route.group)
        return invalid("step.set.trigger is for a group chat only");
    }
    const settings =
      found.app === "discord" ? discordRouteSettings(set) : replySettings(set);
    if (!settings.ok) return invalid(`step.set: ${settings.error}`);
    if (typeof set.prefix === "string")
      out.prefix =
        (found.app === "discord"
          ? normaliseDiscordPrefix(set.prefix)
          : normaliseWhatsAppPrefix(set.prefix)) ?? "";
    return {
      ok: true,
      step: {
        kind: "messaging-route",
        app: found.app,
        routeId,
        set: out,
      } as MessagingRouteStep,
    };
  }

  // Why the member could not apply a messaging-route step, or null: the
  // route's PATCH as the member, then the agent the route has after the
  // change (set.agentId, else the route's own) by the routes' own rule, so
  // Apply does not fail on it.
  function messagingRouteRefusal(
    step: MessagingRouteStep,
    askingAgentId: string | undefined,
    memberUserId: string,
  ): StepFailure | null {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    const unknownAgent: StepFailure = {
      ok: false,
      status: 422,
      code: "unknown_agent",
      message: "no agent with this id in a room you can reach",
    };
    const found = findRoute(runs, memberUserId, step.routeId, step.app);
    if (!found) return unknownRoute();
    if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
      return notAllowed("this member cannot change this route");
    const agentId = step.set.agentId ?? found.route.agentId;
    if (
      step.set.agentId !== undefined &&
      (!askingAgentId ||
        !runs.agent(agentId) ||
        !runs.agentReaches(askingAgentId, agentId))
    )
      return unknownAgent;
    const problem =
      found.app === "discord"
        ? runs.discord.agentProblem(memberUserId, agentId)
        : runs.whatsapp.agentProblem(memberUserId, agentId);
    switch (problem) {
      case "agent_gone":
        return unknownAgent;
      case "agent_not_yours":
        return notAllowed(
          "this member can route only to an agent they manage; an office owner can route to any agent",
        );
      case "agent_chat_only":
        return {
          ok: false,
          status: 422,
          code: "agent_chat_only",
          message: "an agent at Chat stop cannot reply",
        };
      default:
        return null;
    }
  }

  // Whether the step is done now, for the member the ask is for (isDone in
  // server/step-asks.ts).
  async function isDone(
    step: S,
    memberUserId: string,
    _since: number | null,
  ): Promise<boolean> {
    switch (step.kind) {
      // A live route of a matching place to the agent, with the step's
      // settings. Reads only: reconcile runs this from the routes' own
      // change hook.
      case "discord-route": {
        const dc = deps.runs?.discord;
        if (!dc) return false;
        const places = discordPlaces(dc, step, memberUserId);
        return dc
          .routes(memberUserId)
          .some(
            (route) =>
              !route.dead &&
              routeIsStep(route, step) &&
              places.some((p) => samePlace(p, route)) &&
              dc.agentProblem(memberUserId, route.agentId) === null,
          );
      }
      // A live row of a matching chat to the agent, with the step's
      // settings. Reads only: reconcile runs this from the rows' own change
      // hook.
      case "whatsapp-route": {
        const wa = deps.runs?.whatsapp;
        if (!wa) return false;
        const seen = wa.chatsSeen(memberUserId);
        return wa
          .rows(memberUserId)
          .some(
            (row) =>
              !row.dead &&
              rowIsStep(row, step) &&
              rowMatches(row, step, seen) &&
              wa.agentProblem(memberUserId, row.agentId) === null,
          );
      }
      // The route live (its agent fit, and not marked dead: only a PATCH
      // makes a dead route live again), and each key of `set` at its value.
      case "messaging-route": {
        const runs = deps.runs;
        if (!runs) return false;
        const found = findRoute(runs, memberUserId, step.routeId, step.app);
        if (!found || found.route.dead) return false;
        const problem =
          found.app === "discord"
            ? runs.discord.agentProblem(memberUserId, found.route.agentId)
            : runs.whatsapp.agentProblem(memberUserId, found.route.agentId);
        return problem === null && allSet(step.set, routeValues(found));
      }
    }
  }

  // The step as the agent sent it, completed, or why it is refused. The
  // core checked its kind, its keys and its scope.
  function complete(
    body: Record<string, unknown>,
    kind: S["kind"],
    input: CompleteInput,
  ): { ok: true; step: AskStep } | StepFailure {
    const { memberUserId } = input;
    switch (kind) {
      // The settings as the route stores them: false and a blank prefix
      // are the default, so they are left out.
      case "discord-route": {
        const placeName =
          typeof body.placeName === "string"
            ? normaliseDiscordRouteName(body.placeName)
            : null;
        if (placeName === null)
          return invalid(
            "step.placeName is a part of the place's name: 1 to 60 characters on one line",
          );
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        const scope = body.scope;
        if (
          scope !== undefined &&
          scope !== "channel" &&
          scope !== "category" &&
          scope !== "server"
        )
          return invalid("step.scope is channel, category or server");
        const trigger = body.trigger;
        if (trigger !== undefined && trigger !== "mention" && trigger !== "all")
          return invalid("step.trigger is mention or all");
        const replyMode = body.replyMode;
        if (
          replyMode !== undefined &&
          replyMode !== "bot" &&
          replyMode !== "read" &&
          replyMode !== "ask"
        )
          return invalid("step.replyMode is bot, read or ask");
        const flags: { includeBots?: true; react?: true } = {};
        for (const key of ["includeBots", "react"] as const) {
          const v = body[key];
          if (v === undefined) continue;
          if (typeof v !== "boolean")
            return invalid(`step.${key} is true or false`);
          if (v) flags[key] = true;
        }
        let prefix: string | undefined;
        if (body.prefix !== undefined) {
          const p =
            typeof body.prefix === "string"
              ? normaliseDiscordPrefix(body.prefix)
              : null;
          if (p === null)
            return invalid(
              `step.prefix is at most ${WHATSAPP_PREFIX_MAX} characters on one line`,
            );
          if (p) prefix = p;
        }
        return {
          ok: true,
          step: {
            kind,
            placeName,
            agentId: body.agentId,
            ...(scope === undefined ? {} : { scope }),
            ...(trigger === undefined ? {} : { trigger }),
            ...(replyMode === undefined ? {} : { replyMode }),
            ...(prefix === undefined ? {} : { prefix }),
            ...flags,
          },
        };
      }
      // The settings as the row stores them: false and a blank prefix are
      // the default, so they are left out.
      case "whatsapp-route": {
        const chatName =
          typeof body.chatName === "string"
            ? normaliseWhatsAppRouteName(body.chatName)
            : null;
        if (chatName === null)
          return invalid(
            "step.chatName is a part of the chat's name: 1 to 60 characters on one line",
          );
        const phone =
          body.phone === undefined
            ? undefined
            : typeof body.phone === "string"
              ? normaliseWhatsAppPhone(body.phone)
              : null;
        if (phone === null)
          return invalid(
            "step.phone is the contact's full number with the country code",
          );
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        const trigger = body.trigger;
        if (trigger !== undefined && trigger !== "mention" && trigger !== "all")
          return invalid("step.trigger is mention or all");
        const settings = replySettings(body);
        if (!settings.ok) return invalid(`step.${settings.error}`);
        return {
          ok: true,
          step: {
            kind,
            chatName,
            ...(phone === undefined ? {} : { phone }),
            agentId: body.agentId,
            ...(trigger === undefined ? {} : { trigger }),
            ...settings.set,
          },
        };
      }
      case "messaging-route":
        return completeMessagingRoute(body, memberUserId);
    }
  }

  // The route an action step runs now (routeOf in server/step-asks.ts).
  function routeOf(
    step: S,
    memberUserId: string,
    _callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null {
    switch (step.kind) {
      case "discord-route":
        return discordRouteRun(step, memberUserId, pick);
      case "whatsapp-route":
        return whatsappRouteRun(step, memberUserId, pick);
      // One PATCH of the route: the keys `set` leaves out keep their values.
      // A route deleted since the create answers 404 on the card.
      case "messaging-route":
        return {
          ok: true,
          routes: [
            {
              method: "PATCH",
              path: `/api/${step.app}/routes/${encodeURIComponent(step.routeId)}`,
              body: step.set,
            },
          ],
        };
    }
  }

  // Why the member could not run an action step, or null (actionRefusal
  // in server/step-asks.ts).
  function actionRefusal(
    step: Extract<ActionStepRequest, S>,
    askingAgentId: string | undefined,
    memberUserId: string,
    runs: StepRunDeps,
  ): StepFailure | null {
    switch (step.kind) {
      // The place is picked on the card, so the create judges the member
      // on the add route, and the agent by the routes' own rule.
      case "discord-route": {
        const unknownAgent: StepFailure = {
          ok: false,
          status: 422,
          code: "unknown_agent",
          message: "no agent with this id in a room you can reach",
        };
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return unknownAgent;
        if (
          runs.authorizeAs(memberUserId, {
            method: "POST",
            path: "/api/discord/routes",
          })
        )
          return notAllowed("this member cannot route Discord places");
        if (runs.discord.bots(memberUserId).length === 0)
          return {
            ok: false,
            status: 409,
            code: "discord_not_connected",
            message:
              "this member has not connected a Discord bot: they connect one in Integrations, Messaging",
          };
        switch (runs.discord.agentProblem(memberUserId, step.agentId)) {
          case "agent_gone":
            return unknownAgent;
          case "agent_not_yours":
            return notAllowed(
              "this member can route a place only to an agent they manage; an office owner can route to any agent",
            );
          case "agent_chat_only":
            return {
              ok: false,
              status: 422,
              code: "agent_chat_only",
              message: "an agent at Chat stop cannot reply",
            };
          default:
            return null;
        }
      }
      // The chat is picked on the card, so the create judges the member on
      // the add route, and the agent by the rows' own rule.
      case "whatsapp-route": {
        const unknownAgent: StepFailure = {
          ok: false,
          status: 422,
          code: "unknown_agent",
          message: "no agent with this id in a room you can reach",
        };
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return unknownAgent;
        if (
          runs.authorizeAs(memberUserId, {
            method: "POST",
            path: "/api/whatsapp/routes",
          })
        )
          return notAllowed("this member cannot route WhatsApp chats");
        if (!runs.whatsapp.linked(memberUserId))
          return {
            ok: false,
            status: 409,
            code: "whatsapp_not_linked",
            message:
              "this member has not linked WhatsApp: they link it in Integrations, Messaging",
          };
        switch (runs.whatsapp.agentProblem(memberUserId, step.agentId)) {
          case "agent_gone":
            return unknownAgent;
          case "agent_not_yours":
            return notAllowed(
              "this member can route a chat only to an agent they manage; an office owner can route to any agent",
            );
          case "agent_chat_only":
            return {
              ok: false,
              status: 422,
              code: "agent_chat_only",
              message: "an agent at Chat stop cannot reply",
            };
          default:
            return null;
        }
      }
      case "messaging-route":
        return messagingRouteRefusal(step, askingAgentId, memberUserId);
    }
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: S): string {
    switch (step.kind) {
      case "whatsapp-route":
      case "discord-route":
        return deps.runs?.agent(step.agentId)?.name ?? step.agentId;
      default:
        return "";
    }
  }

  const runRoute = (
    step: Extract<ActionStepRequest, S>,
    memberUserId: string,
  ): StepRoute => firstRoute(routeOf, step, memberUserId);

  return { doneLine, isDone, complete, routeOf, actionRefusal, targetName };
}
