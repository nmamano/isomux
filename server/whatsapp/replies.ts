// WhatsApp replies (task d03a61d8, slice 2b): an agent drafts a reply to a
// contact row, the draft is an ask to the row's member, and only the member's
// Send answer sends it. Nothing goes out without that tap.

import type { AskEntry } from "../../shared/types.ts";
import { WHATSAPP_APP } from "../../shared/whatsapp.ts";
import type { AskStore } from "../asks.ts";
import type { IdRing } from "./routes-store.ts";
import type { WhatsAppRoutes } from "./routes.ts";
import type { WhatsAppSupervisor } from "./supervisor.ts";

export const WHATSAPP_REPLY_MAX_CHARS = 4000;
// Open drafts per row: a sixth gets 429 until the member answers one.
export const WHATSAPP_DRAFTS_PER_ROUTE_MAX = 5;
export const WHATSAPP_SEND_OPTION = "Send";
export const WHATSAPP_DONT_SEND_OPTION = "Don't send";

export interface WhatsAppRepliesDeps {
  routes: Pick<WhatsAppRoutes, "get" | "check">;
  // The agent as it is now, or null when it is gone.
  agent(agentId: string): { userId: string | null; name: string } | null;
  asks: Pick<AskStore, "create" | "listForAgent">;
  supervisor: Pick<WhatsAppSupervisor, "send">;
  // The ids the agents sent, per member (the own-send filter and the quote
  // trigger of inbound.ts).
  sent(userId: string): IdRing;
}

export type WhatsAppDraftResult =
  | { ok: true; askId: string }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429;
      code: string;
      error: string;
    };

// What the asks handler does with a member's answer to a draft.
//   deliver: tell the agent `text` as the answer and close the ask with
//     `outcome`. `refusal`, when present, is what the member gets back (the
//     row was gone at Send time, so nothing went out).
//   fail: nothing is delivered and the ask stays open (a send failure, or
//     no answer from WhatsApp in time).
export type WhatsAppAnswerResult =
  | {
      kind: "deliver";
      text: string;
      outcome: "replied" | "dismissed";
      refusal?: { status: 409; code: string; error: string };
    }
  | { kind: "fail"; status: 409 | 502 | 504; code: string; error: string };

export interface WhatsAppReplies {
  // POST /api/messaging/routes/:routeId/messages by agent `agentId`. The
  // route id space is shared by every messaging app of a member: today it
  // holds WhatsApp rows only, so the id names a WhatsApp row. A second app
  // either keeps its ids unique per member or the path gains the app.
  draft(agentId: string, routeId: string, text: unknown): WhatsAppDraftResult;
  // The row's member answered the draft `entry` (entry.messaging is set).
  answer(
    entry: AskEntry,
    input: { dismissed: boolean; text: string | undefined },
  ): Promise<WhatsAppAnswerResult>;
}

// A2: the first line of the answer, trimmed, is "Send" in any case. A prefix
// does not count.
export function isWhatsAppSendAnswer(text: string): boolean {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.trim().toLowerCase() === WHATSAPP_SEND_OPTION.toLowerCase();
}

// A6: the message as it goes out: the agent's name in bold on its own line,
// then the text. The name loses * _ ~ and line breaks.
export function whatsappOutgoingText(agentName: string, text: string): string {
  return `*${agentName.replace(/[*_~\r\n]/g, "")}*\n${text}`;
}

// The draft as the member reads it: the text in a code block, so the card
// shows the marks WhatsApp will read, not their Markdown rendering.
function draftPrompt(routeName: string, text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `WhatsApp reply to ${JSON.stringify(routeName)}:\n\n${fence}\n${text}\n${fence}`;
}

// The words after the answer's first line: a note the member added to Send.
const noteAfterFirstLine = (text: string) =>
  text.split(/\r?\n/).slice(1).join("\n").trim();

// The key in the sent ring that records an ask whose reply went out, so a
// later Send (after a refused notice, or a restart) sends nothing more.
const sentAskKey = (askId: string) => `ask:${askId}`;

export function createWhatsAppReplies(
  deps: WhatsAppRepliesDeps,
): WhatsAppReplies {
  // One answer for every agent that is not the row's: no agent learns which
  // rows exist.
  const notFound = {
    ok: false as const,
    status: 404 as const,
    code: "not_found",
    error: "no such row",
  };

  return {
    draft(agentId, routeId, text) {
      const agent = deps.agent(agentId);
      const userId = agent?.userId ?? null;
      const route = userId ? deps.routes.get(userId, routeId) : null;
      if (!userId || !route || route.agentId !== agentId) return notFound;
      if (
        typeof text !== "string" ||
        text.trim() === "" ||
        text.length > WHATSAPP_REPLY_MAX_CHARS
      )
        return {
          ok: false,
          status: 400,
          code: "invalid_text",
          error: `text must be 1 to ${WHATSAPP_REPLY_MAX_CHARS} characters`,
        };
      if (route.dead || deps.routes.check(userId, route))
        return {
          ok: false,
          status: 409,
          code: "messaging_route_dead",
          error:
            "this row no longer delivers; the member must fix it on the Integrations page",
        };
      const open = deps.asks
        .listForAgent(agentId)
        .filter(
          (e) =>
            e.messaging?.app === WHATSAPP_APP &&
            e.messaging.routeId === routeId,
        ).length;
      if (open >= WHATSAPP_DRAFTS_PER_ROUTE_MAX)
        return {
          ok: false,
          status: 429,
          code: "too_many_drafts",
          error: `at most ${WHATSAPP_DRAFTS_PER_ROUTE_MAX} replies to one row wait for the member`,
        };
      const made = deps.asks.create({
        agentId,
        memberUserId: userId,
        prompt: draftPrompt(route.name, text),
        options: [WHATSAPP_SEND_OPTION, WHATSAPP_DONT_SEND_OPTION],
        messaging: { app: WHATSAPP_APP, routeId, text },
      });
      if (!made.ok)
        return {
          ok: false,
          status: 429,
          code: "too_many_asks",
          error: "you have too many open asks",
        };
      return { ok: true, askId: made.entry.id };
    },

    async answer(entry, input) {
      const draft = entry.messaging;
      const userId = entry.memberUserId;
      if (!draft || !userId) throw new Error("not a messaging reply draft");
      // A draft that a later release made for another app: its route id is
      // not a WhatsApp row, and this release cannot send it.
      const known = draft.app === WHATSAPP_APP;
      const route = known ? deps.routes.get(userId, draft.routeId) : null;
      const label = JSON.stringify(route?.name ?? "the contact");
      const words = input.text?.trim() ?? "";

      if (input.dismissed || !isWhatsAppSendAnswer(input.text ?? ""))
        return {
          kind: "deliver",
          outcome: input.dismissed ? "dismissed" : "replied",
          text:
            `Not sent: the member did not send your WhatsApp reply to ${label}.` +
            (words ? ` Their words: ${words}` : ""),
        };

      if (!known)
        return {
          kind: "fail",
          status: 409,
          code: "messaging_app_unknown",
          error:
            "This version of Isomux cannot send this reply. Update Isomux, or answer Don't send.",
        };

      const note = noteAfterFirstLine(input.text ?? "");
      const sentText =
        `Sent: your WhatsApp reply to ${label} went out.` +
        (note ? ` The member added: ${note}` : "");
      const ring = deps.sent(userId);
      // A5 does not apply to a reply that went out already: say so again.
      if (ring.has(sentAskKey(entry.id)))
        return { kind: "deliver", outcome: "replied", text: sentText };

      // A5: the row as it is now decides.
      const agent = deps.agent(entry.agentId);
      if (
        !route ||
        route.agentId !== entry.agentId ||
        route.dead ||
        deps.routes.check(userId, route) ||
        !agent
      )
        return {
          kind: "deliver",
          outcome: "replied",
          text: `Not sent: your WhatsApp reply to ${label} cannot go out, because that row no longer reaches you.`,
          refusal: {
            status: 409,
            code: "messaging_route_gone",
            error:
              "Not sent: this chat no longer goes to the agent that wrote the reply.",
          },
        };

      // A4: the ask id is the request id, so the bridge sends a retry once.
      const result = await deps.supervisor.send(userId, {
        requestId: entry.id,
        chat: route.chat,
        text: whatsappOutgoingText(agent.name, draft.text),
      });
      if (!result.ok) {
        if (result.reason === "unknown")
          return {
            kind: "fail",
            status: 504,
            code: "messaging_send_unknown",
            error:
              "WhatsApp did not answer in time, so the reply may have gone out. Check your phone before you send it again.",
          };
        return {
          kind: "fail",
          status: 502,
          code:
            result.reason === "not_linked"
              ? "messaging_not_linked"
              : "messaging_send_failed",
          error:
            result.reason === "not_linked"
              ? "WhatsApp is not connected. Check Integrations › Messaging, then send again."
              : "WhatsApp did not send the reply. Try again.",
        };
      }
      // The ask key first: it is the guard against a second send. The
      // message id feeds the own-send filter and the quote trigger (A7).
      ring.add(sentAskKey(entry.id));
      ring.add(result.id);
      return { kind: "deliver", outcome: "replied", text: sentText };
    },
  };
}
