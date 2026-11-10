// Discord replies (task 7fd44c30, slice 2): an agent answers on its route,
// by the route's reply mode.
//   bot  - posts at once as the bot (DISCORD_SENDS_MAX per route in
//          DISCORD_SENDS_WINDOW_MS), and answers the message id
//   read - 409 messaging_read_only
//   ask  - an Inbox ask with Send and Don't send, as WhatsApp; the member's
//          Send re-checks the route, the bot and the channel, then posts
// Checks run in this order: the route is the caller's (else 404, as a
// miss), it is live (409 messaging_route_dead), then the fields (400). A
// channelId is a text channel or a thread the route covers; a channel route
// on a text channel defaults to it, every other route needs one (400
// messaging_channel_required). The text with the prefix is at most
// DISCORD_REPLY_MAX_CHARS UTF-16 units.

import { createHash } from "crypto";
import {
  DISCORD_APP,
  isSnowflake,
  type DiscordRoute,
} from "../../shared/discord.ts";
import type { AskEntry } from "../../shared/types.ts";
import type { AskStore } from "../asks.ts";
import type { IdRing } from "../whatsapp/routes-store.ts";
import type {
  MessagingAnswerResult,
  MessagingReplyFailure,
  MessagingAppReplies,
  MessagingReplyBody,
  MessagingReplyResult,
} from "../messaging/replies.ts";
import type { DiscordBotView } from "./inbound.ts";
import type { DiscordRest, DiscordWriteFailure } from "./rest.ts";
import type { DiscordRoutes } from "./routes.ts";

export const DISCORD_REPLY_MAX_CHARS = 2000;
export const DISCORD_DRAFTS_PER_ROUTE_MAX = 5;
export const DISCORD_SENDS_MAX = 20;
export const DISCORD_SENDS_WINDOW_MS = 10 * 60_000;
// Discord refuses a longer nonce.
export const DISCORD_NONCE_MAX = 25;
export const DISCORD_SEND_OPTION = "Send";
export const DISCORD_DONT_SEND_OPTION = "Don't send";

export interface DiscordRepliesDeps {
  routes: Pick<DiscordRoutes, "get" | "check" | "forPlace" | "rowMember">;
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): { userId: string | null; name: string } | null;
  // The bot's live view, or null when it is not connected.
  bot(userId: string, botId: string): DiscordBotView | null;
  rest: Pick<DiscordRest, "postMessage">;
  asks: Pick<AskStore, "create" | "listForAgent">;
  // The ask ids whose reply went out, per member.
  sent(userId: string): IdRing;
  // A 401 on a post: the supervisor marks the bot dead and pages once.
  tokenRefused(userId: string, botId: string): void;
  now(): number;
  // A random nonce of at most DISCORD_NONCE_MAX characters.
  newNonce(): string;
}

// The nonce of a Send, from the ask id: a second Send posts once.
export function nonceForAsk(askId: string): string {
  return createHash("sha256")
    .update(askId)
    .digest("hex")
    .slice(0, DISCORD_NONCE_MAX);
}

export interface DiscordReplies extends MessagingAppReplies {
  reply(
    agentId: string,
    routeId: string,
    body: MessagingReplyBody,
  ): Promise<MessagingReplyResult>;
  answer(
    entry: AskEntry,
    input: { dismissed: boolean; text: string | undefined },
  ): Promise<MessagingAnswerResult>;
}

// The first line of the answer, trimmed, is "Send" in any case.
function isSendAnswer(text: string): boolean {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.trim().toLowerCase() === DISCORD_SEND_OPTION.toLowerCase();
}

// The words after the answer's first line: a note the member added to Send.
const noteAfterFirstLine = (text: string) =>
  text.split(/\r?\n/).slice(1).join("\n").trim();

// The post as it goes out: the route's prefix, if any, then the text.
const outgoing = (route: DiscordRoute, text: string) =>
  route.prefix ? `${route.prefix} ${text}` : text;

// The draft as the member reads it: the text in a code block longer than
// any run of backticks in it, so the card shows the marks Discord will read.
function draftPrompt(routeName: string, channelName: string, text: string) {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `Discord reply to ${JSON.stringify(routeName)}, in #${channelName}:\n\n${fence}\n${text}\n${fence}`;
}

// The key in the sent ring that records an ask whose reply went out.
const sentAskKey = (askId: string) => `ask:${askId}`;

const fail = (
  status: MessagingReplyFailure["status"],
  code: string,
  error: string,
): MessagingReplyFailure => ({ ok: false, status, code, error });

// A failed post as the route answers it.
function postError(
  reason: DiscordWriteFailure["reason"] | "not_linked",
  what: "reply" | "message",
): { status: 502 | 504; code: string; error: string } {
  if (reason === "unknown")
    return {
      status: 504,
      code: "messaging_send_unknown",
      error:
        what === "reply"
          ? "Discord did not answer in time, so the reply may have gone out. Check the channel before you send it again."
          : "Discord did not answer in time, so the message may have gone out. Do not send it again.",
    };
  if (reason === "not_linked")
    return {
      status: 502,
      code: "messaging_not_linked",
      error:
        what === "reply"
          ? "The Discord bot is not connected. Check Integrations › Messaging, then send again."
          : "The Discord bot is not connected right now. Try again in a few minutes, and tell the member if it still fails.",
    };
  return {
    status: 502,
    code: "messaging_send_failed",
    error:
      what === "reply"
        ? `Discord did not post the reply (${reason}). Try again.`
        : `Discord did not post the message (${reason}). Try again.`,
  };
}

// Where a reply on `route` goes: the channelId when it is a text channel or
// a thread that the route covers now, else the route's own channel when the
// route is a channel route on a text channel. A refusal names why.
function placeOf(
  deps: DiscordRepliesDeps,
  userId: string,
  route: DiscordRoute,
  view: DiscordBotView,
  channelId: string | undefined,
):
  | { ok: true; channelId: string; channelName: string }
  | { ok: false; code: string; error: string } {
  if (channelId === undefined) {
    const own =
      route.scope === "channel" &&
      view.kindOf(route.guildId, route.targetId) === "text";
    if (!own)
      return {
        ok: false,
        code: "messaging_channel_required",
        error:
          "this route covers more than one channel: give channelId, the channelId of the message you answer",
      };
    channelId = route.targetId;
  }
  const refused = {
    ok: false as const,
    code: "invalid_channel",
    error: "channelId must be a text channel or a thread this route covers",
  };
  const where = view.place(route.guildId, channelId);
  if (!where) return refused;
  // A channel itself, not a thread under it, must be a text channel: a
  // forum takes posts only.
  if (
    where.channelId === channelId &&
    view.kindOf(route.guildId, channelId) !== "text"
  )
    return refused;
  const { channelName, ...place } = where;
  if (
    deps.routes.forPlace(userId, { ...place, botId: route.botId })?.id !==
    route.id
  )
    return refused;
  return { ok: true, channelId, channelName };
}

export function createDiscordReplies(deps: DiscordRepliesDeps): DiscordReplies {
  // One answer for every agent that is not the route's: no agent learns
  // which routes exist.
  const notFound = fail(404, "not_found", "no such route");
  // The times of each route's recent posts, by member and route id.
  const posts = new Map<string, number[]>();

  return {
    async reply(agentId, routeId, body) {
      const agent = deps.agent(agentId);
      // The route's member: the agent's manager, or an office owner who
      // routed a place to it (task 386ec4d6).
      const userId = deps.routes.rowMember(agentId, routeId);
      const route = userId ? deps.routes.get(userId, routeId) : null;
      if (!agent || !userId || !route || route.agentId !== agentId)
        return notFound;
      if (route.dead || deps.routes.check(userId, route))
        return fail(
          409,
          "messaging_route_dead",
          "this route no longer delivers; the member must fix it on the Integrations page",
        );
      if (route.replyMode === "read")
        return fail(
          409,
          "messaging_read_only",
          "this route is read only: you cannot answer in Discord",
        );
      const { text, channelId, replyTo } = body;
      const room =
        DISCORD_REPLY_MAX_CHARS - (route.prefix ? route.prefix.length + 1 : 0);
      if (typeof text !== "string" || text.trim() === "" || text.length > room)
        return fail(
          400,
          "invalid_text",
          `text must be 1 to ${room} characters`,
        );
      if (channelId !== undefined && !isSnowflake(channelId))
        return fail(400, "invalid_channel", "channelId must be a Discord id");
      if (replyTo !== undefined && !isSnowflake(replyTo))
        return fail(
          400,
          "invalid_reply_to",
          "replyTo must be a Discord message id",
        );
      const view = deps.bot(userId, route.botId);
      if (!view) return { ok: false, ...postError("not_linked", "message") };
      const where = placeOf(deps, userId, route, view, channelId);
      if (!where.ok) return fail(400, where.code, where.error);

      if (route.replyMode === "ask") {
        const open = deps.asks
          .listForAgent(agentId)
          .filter(
            (e) =>
              e.messaging?.app === DISCORD_APP &&
              e.messaging.routeId === routeId,
          ).length;
        if (open >= DISCORD_DRAFTS_PER_ROUTE_MAX)
          return fail(
            429,
            "too_many_drafts",
            `at most ${DISCORD_DRAFTS_PER_ROUTE_MAX} replies to one route wait for the member`,
          );
        const made = deps.asks.create({
          agentId,
          memberUserId: userId,
          prompt: draftPrompt(route.name, where.channelName, text),
          options: [DISCORD_SEND_OPTION, DISCORD_DONT_SEND_OPTION],
          messaging: {
            app: DISCORD_APP,
            routeId,
            text,
            ...(channelId !== undefined ? { channelId } : {}),
            ...(replyTo !== undefined ? { replyTo } : {}),
          },
        });
        if (!made.ok)
          return fail(429, "too_many_asks", "you have too many open asks");
        return { ok: true, askId: made.entry.id };
      }

      const key = `${userId}\n${routeId}`;
      const now = deps.now();
      const recent = (posts.get(key) ?? []).filter(
        (t) => now - t < DISCORD_SENDS_WINDOW_MS,
      );
      posts.set(key, recent);
      if (recent.length >= DISCORD_SENDS_MAX)
        return fail(
          429,
          "too_many_sends",
          `at most ${DISCORD_SENDS_MAX} messages to one route in ${DISCORD_SENDS_WINDOW_MS / 60_000} minutes; wait before you send again`,
        );
      // A try counts: one that failed may still have gone out.
      recent.push(now);
      const result = await deps.rest.postMessage(view.token, where.channelId, {
        content: outgoing(route, text),
        ...(replyTo !== undefined ? { replyTo } : {}),
        nonce: deps.newNonce(),
      });
      if (!result.ok) {
        if (result.reason === "unauthorized")
          deps.tokenRefused(userId, route.botId);
        return { ok: false, ...postError(result.reason, "message") };
      }
      return { ok: true, sent: true, messageId: result.id };
    },

    async answer(entry, input) {
      const draft = entry.messaging;
      const userId = entry.memberUserId;
      if (!draft || !userId) throw new Error("not a messaging reply draft");
      const route = deps.routes.get(userId, draft.routeId);
      const label = JSON.stringify(route?.name ?? "the route");
      const words = input.text?.trim() ?? "";

      if (input.dismissed || !isSendAnswer(input.text ?? ""))
        return {
          kind: "deliver",
          outcome: input.dismissed ? "dismissed" : "replied",
          text:
            `Not sent: the member did not send your Discord reply to ${label}.` +
            (words ? ` Their words: ${words}` : ""),
        };

      const note = noteAfterFirstLine(input.text ?? "");
      const sentText =
        `Sent: your Discord reply to ${label} went out.` +
        (note ? ` The member added: ${note}` : "");
      const ring = deps.sent(userId);
      // A reply that went out already: say so again.
      if (ring.has(sentAskKey(entry.id)))
        return { kind: "deliver", outcome: "replied", text: sentText };

      const gone = (why: string): MessagingAnswerResult => ({
        kind: "deliver",
        outcome: "replied",
        text: `Not sent: your Discord reply to ${label} cannot go out, because ${why}.`,
        refusal: {
          status: 409,
          code: "messaging_route_gone",
          error:
            "Not sent: this channel no longer goes to the agent that wrote the reply.",
        },
      });
      // The route, the agent and the channel as they are now decide.
      if (
        !route ||
        route.agentId !== entry.agentId ||
        route.dead ||
        deps.routes.check(userId, route) ||
        route.replyMode === "read" ||
        !deps.agent(entry.agentId)
      )
        return gone("that route no longer reaches you");
      const view = deps.bot(userId, route.botId);
      if (!view) return { kind: "fail", ...postError("not_linked", "reply") };
      const channelId =
        typeof draft.channelId === "string" ? draft.channelId : undefined;
      const where = placeOf(deps, userId, route, view, channelId);
      if (!where.ok) return gone("its channel no longer goes to that route");
      const content = outgoing(route, draft.text);
      if (content.length > DISCORD_REPLY_MAX_CHARS)
        return {
          kind: "deliver",
          outcome: "replied",
          text: `Not sent: with the route's prefix, your Discord reply to ${label} is over ${DISCORD_REPLY_MAX_CHARS} characters.`,
          refusal: {
            status: 409,
            code: "messaging_text_too_long",
            error: `Not sent: with the route's prefix, the reply is over ${DISCORD_REPLY_MAX_CHARS} characters.`,
          },
        };

      // The nonce comes from the ask id, so a retry posts once.
      const result = await deps.rest.postMessage(view.token, where.channelId, {
        content,
        ...(typeof draft.replyTo === "string"
          ? { replyTo: draft.replyTo }
          : {}),
        nonce: nonceForAsk(entry.id),
      });
      if (!result.ok) {
        if (result.reason === "unauthorized")
          deps.tokenRefused(userId, route.botId);
        return { kind: "fail", ...postError(result.reason, "reply") };
      }
      ring.add(sentAskKey(entry.id));
      return { kind: "deliver", outcome: "replied", text: sentText };
    },
  };
}
