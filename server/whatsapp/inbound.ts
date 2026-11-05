// WhatsApp messages from routed chats to agents (task d03a61d8, slice 2).
//
// A message is dropped when its chat has no live row, its id was delivered
// before, it is older than the link or than WHATSAPP_MAX_AGE_MS, or it is an
// agent's own send, also one whose id the bridge reports after the message
// itself (it is dropped at the delivery). The member's own phone text, unless
// the row has ownMessages, and in a group with trigger "mention" every other
// message that neither mentions the linked account nor answers an agent's
// message, is context: it goes with the next delivery, never alone. Messages
// that count, in one chat, make one delivery WHATSAPP_BURST_QUIET_MS after
// the last, or WHATSAPP_BURST_MAX_MS after the first. A message id is marked
// seen when it is delivered.

import { formatMessagingSenderPrefix } from "../../shared/identity.ts";
import {
  WHATSAPP_APP,
  type WhatsAppRoute,
  type WhatsAppRouteDead,
} from "../../shared/whatsapp.ts";
import {
  WHATSAPP_UNKNOWN_SENDER,
  buildWhatsAppBlock,
  type WhatsAppBlockLine,
} from "./block.ts";
import type { BridgeMessage } from "./protocol.ts";
import type { IdRing } from "./routes-store.ts";
import type { WhatsAppClock } from "./supervisor.ts";

export const WHATSAPP_BURST_QUIET_MS = 5_000;
export const WHATSAPP_BURST_MAX_MS = 30_000;
export const WHATSAPP_CONTEXT_MAX = 10;
export const WHATSAPP_MAX_AGE_MS = 24 * 60 * 60_000;

export interface WhatsAppInboundDeps {
  clock: WhatsAppClock;
  // The member's live row for a chat, or null.
  route(userId: string, chat: string): WhatsAppRoute | null;
  // When the member's current link was accepted, or null when not linked.
  linkedAt(userId: string): number | null;
  seen(userId: string): IdRing;
  sent(userId: string): IdRing;
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

interface PendingLine {
  id: string;
  ts: number;
  line: WhatsAppBlockLine;
}

// One chat's lines since its last delivery, in arrival order.
interface Pending {
  userId: string;
  chat: string;
  lines: PendingLine[];
  // Set from the first line that counts until the delivery.
  firstAt: number | null;
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
    p.quietTimer = null;
    p.maxTimer = null;
  }

  function flush(key: string): void {
    const p = pending.get(key);
    if (!p || p.firstAt === null) return;
    clearTimers(p);
    pending.delete(key);
    try {
      // An agent's own send whose id came after the message: never delivered.
      const sent = deps.sent(p.userId);
      p.lines = p.lines.filter((l) => !sent.has(l.id));
      if (!p.lines.some((l) => !l.line.context)) {
        // Nothing counts: the context waits for the next line that does.
        p.firstAt = null;
        if (p.lines.length > 0) pending.set(key, p);
        return;
      }
      const route = deps.route(p.userId, p.chat);
      if (!route || deps.check(p.userId, route) !== null) return;
      const now = clock.now();
      // Context older than the age limit goes; the cap keeps the newest.
      let lines = p.lines.filter(
        (l) => !l.line.context || now - l.ts <= WHATSAPP_MAX_AGE_MS,
      );
      const context = lines.filter((l) => l.line.context);
      if (context.length > WHATSAPP_CONTEXT_MAX) {
        const drop = new Set(
          context.slice(0, context.length - WHATSAPP_CONTEXT_MAX),
        );
        lines = lines.filter((l) => !drop.has(l));
      }
      const text = buildWhatsAppBlock({
        routeId: route.id,
        routeName: route.name,
        memberName: deps.memberName(p.userId),
        direct: route.sendDirect === true,
        lines: lines.map((l) => l.line),
        reservedChars:
          formatMessagingSenderPrefix(WHATSAPP_APP, route.name).length + 1,
      });
      if (!deps.deliver(p.userId, route, text)) {
        console.warn("[whatsapp] an agent did not take a WhatsApp delivery");
        return;
      }
      const seen = deps.seen(p.userId);
      for (const l of lines) seen.add(l.id);
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
      if (now - msg.ts > WHATSAPP_MAX_AGE_MS) return;
      if (deps.seen(userId).has(msg.id) || deps.sent(userId).has(msg.id))
        return;
      const key = keyOf(userId, msg.chat);
      let p = pending.get(key);
      if (!p) {
        p = {
          userId,
          chat: msg.chat,
          lines: [],
          firstAt: null,
          quietTimer: null,
          maxTimer: null,
        };
        pending.set(key, p);
      }
      // A redelivery of a line already waiting.
      if (p.lines.some((l) => l.id === msg.id)) return;
      const counted = counts(userId, route, msg);
      const line: WhatsAppBlockLine = {
        from: senderOf(userId, route, msg),
        text: msg.text,
        ...(counted ? {} : { context: true as const }),
      };
      p.lines.push({ id: msg.id, ts: msg.ts, line });
      if (!counted) {
        // Context alone waits for the next line that counts; the cap keeps
        // memory bounded meanwhile.
        const context = p.lines.filter((l) => l.line.context);
        if (context.length > WHATSAPP_CONTEXT_MAX)
          p.lines.splice(p.lines.indexOf(context[0]), 1);
        return;
      }
      const target = p;
      if (target.firstAt === null) {
        target.firstAt = now;
        target.maxTimer = clock.setTimeout(
          () => flush(key),
          WHATSAPP_BURST_MAX_MS,
        );
      }
      clock.clearTimeout(target.quietTimer);
      target.quietTimer = clock.setTimeout(
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
