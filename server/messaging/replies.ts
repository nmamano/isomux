// An agent's reply to a messaging route (POST
// /api/messaging/routes/:routeId/messages), and its read of one (GET, WhatsApp
// only, task 682fd65a), dispatched by app (task
// 7fd44c30, slice 2). The route id names a WhatsApp row (r_...) or a Discord
// route (d_...) of the agent's member. A route that is not the caller's, in
// either app, is the same 404, and every field check comes after that one.

import { DISCORD_APP } from "../../shared/discord.ts";
import type {
  MessagingReadResult,
  MessagingRouteListed,
} from "../../shared/messaging.ts";
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

// An agent's read of its route: WhatsApp only.
export type MessagingReadOutcome =
  ({ ok: true } & MessagingReadResult) | MessagingReplyFailure;

export interface MessagingRoutesApi extends MessagingAppReplies {
  // The agent's own live routes in every app, WhatsApp first.
  routes(agentId: string): MessagingRouteListed[];
  // limit is the raw query value, undefined when absent.
  read(agentId: string, routeId: string, limit: unknown): MessagingReadOutcome;
}

export interface MessagingRepliesDeps {
  whatsapp: MessagingAppReplies & {
    read(
      agentId: string,
      routeId: string,
      limit: unknown,
    ): MessagingReadOutcome;
  };
  discord: MessagingAppReplies;
  // The app of the route when it is the agent's own (same member, the
  // route's agent), else null.
  routeApp(agentId: string, routeId: string): "whatsapp" | "discord" | null;
  // Each app's live routes to the agent (WhatsAppRoutes and DiscordRoutes
  // routesOf).
  routesOf: Record<
    "whatsapp" | "discord",
    (agentId: string) => { id: string; name: string }[]
  >;
}

export function createMessagingReplies(
  deps: MessagingRepliesDeps,
): MessagingRoutesApi {
  // One answer for every route that is not the caller's: no agent learns
  // which routes exist, in either app.
  const notFound: MessagingReplyFailure = {
    ok: false,
    status: 404,
    code: "not_found",
    error: "no such route",
  };
  return {
    routes(agentId) {
      const apps = ["whatsapp", "discord"] as const;
      return apps.flatMap((app) =>
        deps.routesOf[app](agentId).map((r) => ({
          id: r.id,
          app,
          name: r.name,
        })),
      );
    },

    read(agentId, routeId, limit) {
      const app = deps.routeApp(agentId, routeId);
      if (app === null) return notFound;
      if (app === "discord")
        return {
          ok: false,
          status: 400,
          code: "messaging_read_unsupported",
          error: "only a WhatsApp route can be read",
        };
      return deps.whatsapp.read(agentId, routeId, limit);
    },

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
