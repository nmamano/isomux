// WhatsApp messages from routed chats to agents (task d03a61d8, slice 2):
// what is dropped, what is only context, how a burst makes one delivery, the
// sender names the agent sees, the dead-row check, and that a failing
// delivery never escapes a timer. Fake clock and fake delivery; the block is
// the real one, parsed back.

import { describe, expect, it } from "bun:test";
import {
  WHATSAPP_BURST_MAX_MS,
  WHATSAPP_BURST_QUIET_MS,
  WHATSAPP_CONTEXT_MAX,
  WHATSAPP_MAX_AGE_MS,
  createWhatsAppInbound,
} from "./inbound.ts";
import { WHATSAPP_UNKNOWN_SENDER } from "./block.ts";
import type { BridgeMessage } from "./protocol.ts";
import type { IdRing } from "./routes-store.ts";
import type {
  WhatsAppRoute,
  WhatsAppRouteDead,
} from "../../shared/whatsapp.ts";

const U = "u-alice";
const MOM = "447700900123@s.whatsapp.net";
const FAMILY = "120363000000000001@g.us";
const T0 = 1_800_000_000_000;
const LINKED_AT = T0 - 60 * 60_000;

// Synchronous timers: the inbound path has no promises.
class Clock {
  t = T0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers)
        if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
}

function ring(): IdRing & { ids: Set<string> } {
  const ids = new Set<string>();
  return { ids, has: (id) => ids.has(id), add: (id) => void ids.add(id) };
}

const ROUTES: Record<string, WhatsAppRoute> = {
  [MOM]: {
    id: "r-mom",
    chat: MOM,
    group: false,
    name: "Mom",
    agentId: "agent-a",
    createdAt: 1,
  },
  [FAMILY]: {
    id: "r-fam",
    chat: FAMILY,
    group: true,
    name: "Family",
    agentId: "agent-a",
    trigger: "mention",
    createdAt: 1,
  },
};

interface Line {
  from: string;
  text: string;
  context?: true;
}

function harness() {
  const clock = new Clock();
  const seen = ring();
  const sent = ring();
  const h = {
    clock,
    seen,
    sent,
    routes: { ...ROUTES } as Record<string, WhatsAppRoute>,
    dead: null as WhatsAppRouteDead | null,
    linkedAt: LINKED_AT as number | null,
    deliverThrows: false,
    deliveries: [] as { userId: string; routeId: string; lines: Line[] }[],
    checks: 0,
  };
  const inbound = createWhatsAppInbound({
    clock,
    route: (userId, chat) => (userId === U ? (h.routes[chat] ?? null) : null),
    linkedAt: () => h.linkedAt,
    seen: () => seen,
    sent: () => sent,
    check: () => {
      h.checks++;
      return h.dead;
    },
    memberName: () => "Morgan",
    deliver: (userId, route, text) => {
      if (h.deliverThrows) throw new Error("queue full");
      const json = text
        .split("<messaging-data>\n")[1]
        .split("\n</messaging-data>")[0];
      h.deliveries.push({
        userId,
        routeId: route.id,
        lines: (JSON.parse(json) as { messages: Line[] }).messages,
      });
      return true;
    },
  });
  let n = 0;
  const msg = (over: Partial<BridgeMessage> = {}): BridgeMessage => ({
    ev: "message",
    id: `m${++n}`,
    chat: MOM,
    group: false,
    ts: clock.now(),
    fromMe: false,
    sender: MOM,
    senderName: "Mom (saved)",
    senderPhone: "447700900123",
    text: `text ${n}`,
    mentionsMe: false,
    quotedId: null,
    ...over,
  });
  const groupMsg = (over: Partial<BridgeMessage> = {}) =>
    msg({
      chat: FAMILY,
      group: true,
      sender: "447700900456@s.whatsapp.net",
      senderName: "Aunt Jo",
      senderPhone: "447700900456",
      ...over,
    });
  const texts = () => h.deliveries.map((d) => d.lines.map((l) => l.text));
  return { h, inbound, msg, groupMsg, texts };
}

describe("whatsapp inbound: a contact", () => {
  it("one message is delivered once the chat is quiet, from the row's name, and marked seen then", () => {
    const { h, inbound, msg } = harness();
    inbound.onMessage(U, msg({ id: "m-a", text: "lunch on Sunday?" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS - 1);
    expect(h.deliveries).toEqual([]);
    expect(h.seen.has("m-a")).toBe(false);
    h.clock.advance(1);
    expect(h.deliveries).toEqual([
      {
        userId: U,
        routeId: "r-mom",
        // The row's name, not the contact's saved or WhatsApp name.
        lines: [{ from: "Mom", text: "lunch on Sunday?" }],
      },
    ]);
    expect(h.seen.has("m-a")).toBe(true);
  });

  it("a burst within the quiet time is one delivery; a longer gap makes two", () => {
    const { h, inbound, msg, texts } = harness();
    for (let i = 0; i < 3; i++) {
      inbound.onMessage(U, msg({ text: `a${i}` }));
      h.clock.advance(2_000);
    }
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    inbound.onMessage(U, msg({ text: "b0" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS + 1_000);
    inbound.onMessage(U, msg({ text: "c0" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(texts()).toEqual([["a0", "a1", "a2"], ["b0"], ["c0"]]);
  });

  it("a chat that never goes quiet is delivered at the longest wait after its first message", () => {
    const { h, inbound, msg } = harness();
    const step = WHATSAPP_BURST_QUIET_MS - 1_000;
    const start = h.clock.now();
    while (
      h.deliveries.length === 0 &&
      h.clock.now() - start < 2 * WHATSAPP_BURST_MAX_MS
    ) {
      inbound.onMessage(U, msg());
      h.clock.advance(step);
    }
    expect(h.deliveries).toHaveLength(1);
    const delivered = h.deliveries[0].lines.length;
    expect(delivered).toBe(Math.ceil(WHATSAPP_BURST_MAX_MS / step));
    expect(h.clock.now() - start).toBeLessThanOrEqual(
      WHATSAPP_BURST_MAX_MS + step,
    );
  });

  it("drops an unrouted chat, a seen id, a message from before the link or over a day old, and everything when not linked", () => {
    const { h, inbound, msg } = harness();
    h.seen.add("m-old");
    const dropped = (linkedAt: number | null, m: BridgeMessage, userId = U) => {
      h.linkedAt = linkedAt;
      inbound.onMessage(userId, m);
      h.clock.advance(WHATSAPP_BURST_MAX_MS);
      expect({ text: m.text, delivered: h.deliveries.length }).toEqual({
        text: m.text,
        delivered: 0,
      });
    };
    dropped(
      LINKED_AT,
      msg({ chat: "447700900999@s.whatsapp.net", text: "stranger" }),
    );
    dropped(LINKED_AT, msg({ text: "another member's chat" }), "u-bob");
    dropped(LINKED_AT, msg({ id: "m-old", text: "again" }));
    dropped(LINKED_AT, msg({ ts: LINKED_AT - 1, text: "before the link" }));
    dropped(
      h.clock.now() - 2 * WHATSAPP_MAX_AGE_MS,
      msg({ ts: h.clock.now() - WHATSAPP_MAX_AGE_MS - 1, text: "too old" }),
    );
    dropped(null, msg({ text: "not linked" }));
    expect([...h.seen.ids]).toEqual(["m-old"]);

    // The condition: the same harness does deliver a fresh routed message.
    h.linkedAt = LINKED_AT;
    inbound.onMessage(U, msg({ text: "fresh" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines.map((l) => l.text))).toEqual([
      ["fresh"],
    ]);
  });

  it("the member's own phone text is context for the next delivery, never one of its own; an agent's own send is dropped", () => {
    const { h, inbound, msg } = harness();
    h.sent.add("m-agent");
    inbound.onMessage(
      U,
      msg({ id: "m-agent", fromMe: true, text: "agent reply" }),
    );
    inbound.onMessage(U, msg({ fromMe: true, text: "I'll ask my agent" }));
    h.clock.advance(WHATSAPP_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);

    inbound.onMessage(U, msg({ text: "ok, ask it" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines)).toEqual([
      [
        { from: "Morgan", text: "I'll ask my agent", context: true },
        { from: "Mom", text: "ok, ask it" },
      ],
    ]);

    // Context goes once: the next delivery does not repeat it.
    inbound.onMessage(U, msg({ text: "thanks" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries[1].lines).toEqual([{ from: "Mom", text: "thanks" }]);
  });

  it("keeps the newest context lines up to the cap", () => {
    const { h, inbound, msg } = harness();
    for (let i = 0; i < WHATSAPP_CONTEXT_MAX + 3; i++)
      inbound.onMessage(U, msg({ fromMe: true, text: `own ${i}` }));
    inbound.onMessage(U, msg({ text: "go" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    const lines = h.deliveries[0].lines;
    expect(lines.filter((l) => l.context)).toHaveLength(WHATSAPP_CONTEXT_MAX);
    expect(lines[0].text).toBe("own 3");
    expect(lines.at(-1)).toEqual({ from: "Mom", text: "go" });
  });
});

describe("whatsapp inbound: a group", () => {
  it("with trigger mention: only a mention or a reply to an agent's message wakes the agent; the rest is context", () => {
    const { h, inbound, groupMsg } = harness();
    h.sent.add("m-agent-said");
    inbound.onMessage(U, groupMsg({ text: "who is cooking?" }));
    inbound.onMessage(
      U,
      groupMsg({ text: "a reply to someone else", quotedId: "m-other" }),
    );
    h.clock.advance(WHATSAPP_BURST_MAX_MS);
    expect(h.deliveries).toEqual([]);

    inbound.onMessage(
      U,
      groupMsg({ text: "@agent what do we need?", mentionsMe: true }),
    );
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines)).toEqual([
      [
        { from: "Aunt Jo", text: "who is cooking?", context: true },
        { from: "Aunt Jo", text: "a reply to someone else", context: true },
        { from: "Aunt Jo", text: "@agent what do we need?" },
      ],
    ]);

    inbound.onMessage(
      U,
      groupMsg({ text: "and wine", quotedId: "m-agent-said" }),
    );
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries[1].lines).toEqual([
      { from: "Aunt Jo", text: "and wine" },
    ]);
  });

  it("with trigger all: every message counts", () => {
    const { h, inbound, groupMsg } = harness();
    h.routes[FAMILY] = { ...ROUTES[FAMILY], trigger: "all" };
    inbound.onMessage(U, groupMsg({ text: "hello all" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines)).toEqual([
      [{ from: "Aunt Jo", text: "hello all" }],
    ]);
  });

  it("names a participant by the member's saved name, else the number, else a neutral name: never a LID as a number", () => {
    const { h, inbound, groupMsg } = harness();
    h.routes[FAMILY] = { ...ROUTES[FAMILY], trigger: "all" };
    inbound.onMessage(U, groupMsg({ text: "saved" }));
    inbound.onMessage(U, groupMsg({ senderName: null, text: "number" }));
    inbound.onMessage(
      U,
      groupMsg({
        sender: "98765432109876@lid",
        senderName: null,
        senderPhone: null,
        text: "lid only",
      }),
    );
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries[0].lines.map((l) => l.from)).toEqual([
      "Aunt Jo",
      "+447700900456",
      WHATSAPP_UNKNOWN_SENDER,
    ]);
    expect(JSON.stringify(h.deliveries)).not.toContain("98765432109876");
  });
});

describe("whatsapp inbound: the row and the office", () => {
  it("a row whose agent fails the check delivers nothing", () => {
    const { h, inbound, msg } = harness();
    h.dead = "agent_not_yours";
    inbound.onMessage(U, msg({ text: "hi" }));
    h.clock.advance(WHATSAPP_BURST_MAX_MS);
    expect(h.checks).toBeGreaterThan(0);
    expect(h.deliveries).toEqual([]);
  });

  it("the office stopping delivers every pending burst at once; a gone link drops them", () => {
    const { h, inbound, msg, groupMsg } = harness();
    inbound.onMessage(U, msg({ text: "pending" }));
    inbound.onMessage(U, groupMsg({ text: "@agent too", mentionsMe: true }));
    inbound.flushAll();
    expect(h.deliveries.map((d) => d.routeId).sort()).toEqual([
      "r-fam",
      "r-mom",
    ]);
    h.clock.advance(WHATSAPP_BURST_MAX_MS);
    expect(h.deliveries).toHaveLength(2);

    inbound.onMessage(U, msg({ text: "after unlink" }));
    inbound.dropMember(U);
    h.clock.advance(WHATSAPP_BURST_MAX_MS);
    expect(h.deliveries).toHaveLength(2);
  });

  it("a delivery that throws never escapes the timer, and the next one works", () => {
    const { h, inbound, msg } = harness();
    h.deliverThrows = true;
    inbound.onMessage(U, msg({ text: "lost" }));
    expect(() => h.clock.advance(WHATSAPP_BURST_QUIET_MS)).not.toThrow();
    h.deliverThrows = false;
    inbound.onMessage(U, msg({ text: "next" }));
    h.clock.advance(WHATSAPP_BURST_QUIET_MS);
    expect(h.deliveries.map((d) => d.lines.map((l) => l.text))).toEqual([
      ["next"],
    ]);
  });
});
