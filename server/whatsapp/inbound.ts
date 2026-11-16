// WhatsApp messages from routed chats to agents (task d03a61d8, slice 2).
//
// A message is dropped when its chat has no live row, its id was delivered
// before, or it is older than the link. Every other text message goes in the
// chat's log (chat-log.ts, task 682fd65a), an agent's own send too, marked as
// the agent's (also one whose id the bridge reports after the message
// itself: the delivery marks it). A message counts, and wakes the agent,
// unless it is the member's own phone text on a row without ownMessages, a
// message in a group with trigger "mention" that neither mentions the linked
// account nor answers an agent's message, or a message over
// WHATSAPP_MAX_AGE_MS old when it arrives. Messages that count, in one chat,
// make one delivery WHATSAPP_BURST_QUIET_MS after the last, or
// WHATSAPP_BURST_MAX_MS after the first. A delivery carries every logged
// line not yet delivered and not the agent's; the lines that did not count
// in this burst go as context. The log is on disk, so the context survives a
// restart, and a line that counted in a burst a crash cut goes as context
// with the next delivery. A delivered line is marked in the log and in the
// seen ring.

import { formatMessagingSenderPrefix } from "../../shared/identity.ts";
import {
  WHATSAPP_APP,
  type WhatsAppRoute,
  type WhatsAppRouteDead,
} from "../../shared/whatsapp.ts";
import { WHATSAPP_UNKNOWN_SENDER, buildWhatsAppBlock } from "./block.ts";
import type { ChatLog } from "./chat-log.ts";
import type { BridgeMessage } from "./protocol.ts";
import type { IdRing } from "./routes-store.ts";
import type { WhatsAppClock } from "./supervisor.ts";

export const WHATSAPP_BURST_QUIET_MS = 5_000;
export const WHATSAPP_BURST_MAX_MS = 30_000;
export const WHATSAPP_MAX_AGE_MS = 24 * 60 * 60_000;

export interface WhatsAppInboundDeps {
  clock: WhatsAppClock;
  // The member's live row for a chat, or null.
  route(userId: string, chat: string): WhatsAppRoute | null;
  // When the member's current link was accepted, or null when not linked.
  linkedAt(userId: string): number | null;
  seen(userId: string): IdRing;
  sent(userId: string): IdRing;
  // The chat's log (chat-log.ts).
  chatLog(userId: string, chat: string): ChatLog;
  // Re-reads the row's agent; a reason marks the row dead and delivers
  // nothing.
  check(userId: string, route: WhatsAppRoute): WhatsAppRouteDead | null;
  memberName(userId: string): string;
  // Queues the text to the row's agent; false when the agent refused it.
  deliver(userId: string, route: WhatsAppRoute, text: string): boolean;
}

export interface WhatsAppInbound {
  onMessage(userId: string, msg: BridgeMessage): void;
  // The office stops: every pending burst is delivered now.
  flushAll(): void;
  // The member's link is gone: their pending bursts are dropped.
  dropMember(userId: string): void;
}

// One chat's burst: the ids that counted since its last delivery.
interface Pending {
  userId: string;
  chat: string;
  counted: Set<string>;
  quietTimer: unknown;
  maxTimer: unknown;
}

export function createWhatsAppInbound(
  deps: WhatsAppInboundDeps,
): WhatsAppInbound {
  const { clock } = deps;
  const pending = new Map<string, Pending>();
  const keyOf = (userId: string, chat: string) => `${userId}\n${chat}`;

  function senderOf(
    userId: string,
    route: WhatsAppRoute,
    msg: BridgeMessage,
  ): string {
    if (msg.fromMe) return deps.memberName(userId);
    if (!msg.group) return route.name;
    // Never the contact's own WhatsApp name, and never a LID as a number.
    if (msg.senderName) return msg.senderName;
    return msg.senderPhone ? `+${msg.senderPhone}` : WHATSAPP_UNKNOWN_SENDER;
  }

  function counts(
    userId: string,
    route: WhatsAppRoute,
    msg: BridgeMessage,
  ): boolean {
    // The member opted in per row: the group trigger is for the others.
    if (msg.fromMe) return route.ownMessages === true;
    if (!msg.group || route.trigger === "all") return true;
    return (
      msg.mentionsMe ||
      (msg.quotedId !== null && deps.sent(userId).has(msg.quotedId))
    );
  }

  function clearTimers(p: Pending): void {
    clock.clearTimeout(p.quietTimer);
    clock.clearTimeout(p.maxTimer);
  }

  function flush(key: string): void {
    const p = pending.get(key);
    if (!p) return;
    clearTimers(p);
    pending.delete(key);
    try {
      const log = deps.chatLog(p.userId, p.chat);
      // An agent's own send whose id came after the message: never delivered.
      const sent = deps.sent(p.userId);
      const all = log.lines().filter((l) => !l.delivered && !l.agent);
      const echoes = all.filter((l) => sent.has(l.id)).map((l) => l.id);
      if (echoes.length > 0) log.mark(echoes, "agent");
      const lines = all.filter((l) => !sent.has(l.id));
      // Nothing counts: the context waits for the next line that does.
      if (!lines.some((l) => p.counted.has(l.id))) return;
      const route = deps.route(p.userId, p.chat);
      if (!route || deps.check(p.userId, route) !== null) return;
      const text = buildWhatsAppBlock({
        routeId: route.id,
        routeName: route.name,
        memberName: deps.memberName(p.userId),
        direct: route.sendDirect === true,
        lines: lines.map((l) => ({
          from: l.from,
          text: l.text,
          ...(p.counted.has(l.id) ? {} : { context: true as const }),
        })),
        reservedChars:
          formatMessagingSenderPrefix(WHATSAPP_APP, route.name).length + 1,
      });
      if (!deps.deliver(p.userId, route, text)) {
        console.warn("[whatsapp] an agent did not take a WhatsApp delivery");
        return;
      }
      // The lines the block left out for space are delivered too: the agent
      // reads them with messaging_read.
      const ids = lines.map((l) => l.id);
      log.mark(ids, "delivered");
      const seen = deps.seen(p.userId);
      for (const id of ids) seen.add(id);
    } catch {
      console.error("[whatsapp] a WhatsApp delivery failed");
    }
  }

  return {
    onMessage(userId, msg) {
      const route = deps.route(userId, msg.chat);
      if (!route) return;
      const linkedAt = deps.linkedAt(userId);
      const now = clock.now();
      if (linkedAt === null || msg.ts < linkedAt) return;
      if (deps.seen(userId).has(msg.id)) return;
      const log = deps.chatLog(userId, msg.chat);
      const line = {
        id: msg.id,
        ts: msg.ts,
        from: senderOf(userId, route, msg),
        fromMe: msg.fromMe,
        text: msg.text,
      };
      if (deps.sent(userId).has(msg.id)) {
        // An agent's own send: logged as the agent's, never delivered.
        if (!log.append({ ...line, agent: true })) log.mark([msg.id], "agent");
        return;
      }
      // A redelivery of a line already logged.
      if (!log.append(line)) return;
      // A message over the age limit rides along as context only.
      if (now - msg.ts > WHATSAPP_MAX_AGE_MS || !counts(userId, route, msg))
        return;
      const key = keyOf(userId, msg.chat);
      let p = pending.get(key);
      if (!p) {
        p = {
          userId,
          chat: msg.chat,
          counted: new Set(),
          quietTimer: null,
          maxTimer: clock.setTimeout(() => flush(key), WHATSAPP_BURST_MAX_MS),
        };
        pending.set(key, p);
      }
      p.counted.add(msg.id);
      clock.clearTimeout(p.quietTimer);
      p.quietTimer = clock.setTimeout(
        () => flush(key),
        WHATSAPP_BURST_QUIET_MS,
      );
    },

    flushAll() {
      for (const key of [...pending.keys()]) flush(key);
    },

    dropMember(userId) {
      for (const [key, p] of pending)
        if (p.userId === userId) {
          clearTimers(p);
          pending.delete(key);
        }
    },
  };
}
