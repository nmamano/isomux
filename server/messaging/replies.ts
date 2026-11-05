// An agent's reply to a messaging route (POST
// /api/messaging/routes/:routeId/messages), dispatched by app (task
// 7fd44c30, slice 2). The route id names a WhatsApp row (r_...) or a Discord
// route (d_...) of the agent's member. A route that is not the caller's, in
// either app, is the same 404, and every field check comes after that one.

import { DISCORD_APP } from "../../shared/discord.ts";
import type { AskEntry } from "../../shared/types.ts";

export type MessagingReplyFailure = {
  ok: false;
  status: 400 | 404 | 409 | 429 | 502 | 504;
  code: string;
  error: string;
};

// A draft that waits for the member (askId), or a message that went out
// (messageId on Discord).
export type MessagingReplyResult =
  | { ok: true; askId: string }
  | { ok: true; sent: true; messageId?: string }
  | MessagingReplyFailure;

// What the asks handler does with a member's answer to a draft.
//   deliver: tell the agent `text` and close the ask with `outcome`;
//     `refusal`, when present, is what the member gets back (nothing went
//     out).
//   fail: nothing is delivered and the ask stays open.
export type MessagingAnswerResult =
  | {
      kind: "deliver";
      text: string;
      outcome: "replied" | "dismissed";
      refusal?: { status: 409; code: string; error: string };
    }
  | { kind: "fail"; status: 409 | 502 | 504; code: string; error: string };

// The body of a reply: text, and on Discord the channel and the message it
// answers. Unchecked: each app checks its own fields.
export interface MessagingReplyBody {
  text?: unknown;
  channelId?: unknown;
  replyTo?: unknown;
}

export interface MessagingAppReplies {
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

export interface MessagingRepliesDeps {
  whatsapp: MessagingAppReplies;
  discord: MessagingAppReplies;
  // The app of the route when it is the agent's own (same member, the
  // route's agent), else null.
  routeApp(agentId: string, routeId: string): "whatsapp" | "discord" | null;
}

export function createMessagingReplies(
  deps: MessagingRepliesDeps,
): MessagingAppReplies {
  // One answer for every route that is not the caller's: no agent learns
  // which routes exist, in either app.
  const notFound: MessagingReplyFailure = {
    ok: false,
    status: 404,
    code: "not_found",
    error: "no such route",
  };
  return {
    async reply(agentId, routeId, body) {
      const app = deps.routeApp(agentId, routeId);
      if (app === null) return notFound;
      if (app === "discord") return deps.discord.reply(agentId, routeId, body);
      if (body.channelId !== undefined || body.replyTo !== undefined)
        return {
          ok: false,
          status: 400,
          code: "invalid_field",
          error: "channelId and replyTo are for Discord routes only",
        };
      return deps.whatsapp.reply(agentId, routeId, body);
    },

    // A draft of an app this release does not know goes to WhatsApp, which
    // answers it messaging_app_unknown.
    answer: (entry, input) =>
      entry.messaging?.app === DISCORD_APP
        ? deps.discord.answer(entry, input)
        : deps.whatsapp.answer(entry, input),
  };
}
