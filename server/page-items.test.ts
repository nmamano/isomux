// Paged asks through the pager delivery engines (task 74e8fc07): the page
// items the source builds (one per recipient of a paged ask, one per page),
// and what Discord and Web Push send for a paged ask: the first send to each
// recipient on their own settings, the link to the ask, repeats per
// recipient, an ack that stops them, a lost room that stops one recipient's,
// and the one "resolved" message at the close, also when the agent is
// already gone or the close lands during the first send.
//
// Seam: the real ask store, pager store, page item source and both engines;
// fetch, the clock and the timers are fakes. The onPage wiring here mirrors
// server/office-managers.ts; the server test
// (server/test-support/paged-asks.test.ts) runs the real one.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AskEntry, PagerDelivery, PagerEntry } from "../shared/types.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import {
  createAskStore,
  type AskAudienceDeps,
  type AskPersistence,
} from "./asks.ts";
import {
  createPageItemSource,
  type PageItem,
  type PageItemSource,
} from "./page-items.ts";
import {
  createPagerDelivery,
  pagerLink,
  type PagerDeliveryService,
} from "./pager-delivery.ts";
import type { PagerPersistence } from "./pager-store.ts";
import type { PagerMemberSettings } from "./pager-settings.ts";
import {
  createWebPushDelivery,
  type WebPushDeliveryService,
} from "./web-push-delivery.ts";
import {
  createWebPushFilePersistence,
  createWebPushStore,
} from "./web-push-store.ts";
import { createTestPagerStore } from "./test-support/pager-memory-archive.ts";
import { browserDevice, decrypt } from "./test-support/web-push-receiver.ts";

const MIN = 60_000;
const ORIGIN = "https://office.example.com";
const HOOK = {
  u1: "https://discord.com/api/webhooks/111111111111111111/tokenOne",
  u2: "https://discord.com/api/webhooks/222222222222222222/tokenTwo",
} as const;
const en = translatorFor("en").t;
const NONE: PagerDelivery = { state: "not_delivered", sends: 0 };

// Manual clock and timers: advance() fires due timers in order, and waits
// for the sends they started.
function fakeTime(start = 1_000_000) {
  let t = start;
  let drain: () => Promise<void> = async () => {};
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    scheduler: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        timers.set(id, { at: t + ms, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        timers.delete(id as number);
      },
    },
    setDrain(fn: () => Promise<void>) {
      drain = fn;
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await settle();
        await drain();
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
      await settle();
      await drain();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

interface DiscordCall {
  url: string;
  body: {
    content: string;
    allowed_mentions: { parse: string[]; users?: string[] };
    embeds?: Array<{
      title: string;
      url: string;
      description?: string;
      footer?: { text: string };
    }>;
  };
}

const memAsks = (): AskPersistence => ({
  load: () => ({ kind: "missing" }),
  save: () => {},
  quarantine: () => true,
});
const memPages = (): PagerPersistence => ({
  load: () => ({ kind: "missing" }),
  save: () => {},
  quarantine: () => true,
});

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Agent Bot ("a1") in room Ops ("room-a"). Members u1 and u2 reach it; u1
// repeats every 5 minutes, u2 every 30, each on their own webhook. u3 reaches
// it too and is never a recipient.
function world() {
  const dir = mkdtempSync(join(tmpdir(), "page-items-"));
  dirs.push(dir);
  const time = fakeTime();
  const access = new Map<string, Set<string>>([
    ["u1", new Set(["room-a"])],
    ["u2", new Set(["room-a"])],
    ["u3", new Set(["room-a"])],
  ]);
  const agentRooms = new Map([["a1", "room-a"]]);
  const agentNames = new Map([["a1", "Bot"]]);
  const audience: AskAudienceDeps = {
    isOfficeOwner: () => false,
    agentRoomId: (id) => agentRooms.get(id) ?? null,
    canSeeRoom: (userId, roomId) => access.get(userId)?.has(roomId) ?? false,
    roomHidden: () => false,
    roomMemberIds: (roomId) =>
      [...access].filter(([, rooms]) => rooms.has(roomId)).map(([u]) => u),
  };
  const settings: Record<string, PagerMemberSettings> = {
    u1: { webhookUrl: HOOK.u1, discordUserId: "111", repeatMinutes: 5 },
    u2: { webhookUrl: HOOK.u2, discordUserId: "222", repeatMinutes: 30 },
  };
  const discordCalls: DiscordCall[] = [];
  const pushCalls: { url: string; body: Uint8Array<ArrayBuffer> }[] = [];
  // hold() parks every Discord request until release() runs.
  let gate: Promise<void> | null = null;
  const hold = () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    return () => {
      gate = null;
      release();
    };
  };

  let source: PageItemSource | null = null;
  let discord: PagerDeliveryService | null = null;
  let push: WebPushDeliveryService | null = null;
  // As office-managers hands a paged ask's events to both engines.
  const onPage = (entry: AskEntry, event: "created" | "acked" | "closed") => {
    for (const item of source!.askItems(entry, event)) {
      if (event === "created") {
        discord!.onRaised(item, "created");
        push!.onRaised(item, "created");
      } else {
        const to = event === "acked" ? "acked" : "resolved";
        discord!.onTransitioned(item, to);
        push!.onTransitioned(item, to);
      }
    }
  };
  const asks = createAskStore({
    persistence: memAsks(),
    now: time.now,
    onPage,
  });
  const pager = createTestPagerStore({
    persistence: memPages(),
    now: time.now,
  });
  source = createPageItemSource({
    pager,
    asks,
    audience,
    agentName: (id) => agentNames.get(id) ?? null,
  });
  const roomName = (id: string) => (id === "room-a" ? "Ops" : null);
  discord = createPagerDelivery({
    store: source,
    settings: (userId) => settings[userId] ?? { repeatMinutes: null },
    setHoldUntil: () => {},
    translator: () => en,
    fetch: async (url, init) => {
      discordCalls.push({ url, body: JSON.parse(init.body as string) });
      if (gate) await gate;
      return new Response(null, { status: 204 });
    },
    now: time.now,
    scheduler: time.scheduler,
    officeOrigin: () => ORIGIN,
    roomName,
  });
  const pushStore = createWebPushStore(
    createWebPushFilePersistence(join(dir, "web-push.json")),
  );
  push = createWebPushDelivery({
    store: pushStore,
    pages: source,
    repeatMinutes: (userId) => settings[userId]?.repeatMinutes ?? null,
    pushRooms: () => [],
    roomAudience: () => [],
    isLobby: () => false,
    notifRooms: () => [],
    translator: () => en,
    fetch: async (url, init) => {
      pushCalls.push({ url, body: init.body as Uint8Array<ArrayBuffer> });
      return new Response(null, { status: 201 });
    },
    now: time.now,
    scheduler: time.scheduler,
    officeOrigin: () => ORIGIN,
    roomName,
  });
  stops.push(
    () => discord!.stop(),
    () => push!.stop(),
  );
  time.setDrain(() => push!.flush());

  // A paged ask from Bot for u1 and u2.
  const open = (over: Partial<Parameters<typeof asks.create>[0]> = {}) => {
    const made = asks.create({
      agentId: "a1",
      memberUserId: "u1",
      otherMemberUserIds: ["u2"],
      prompt: "Restart the box?\nThe disk is full.",
      page: { recipients: ["u1", "u2"] },
      ...over,
    });
    if (!made.ok) throw new Error(`create failed: ${made.code}`);
    return made.entry;
  };
  const itemsOf = (askId: string): PageItem[] =>
    source!
      .list()
      .filter((i) => i.path === `/inbox/asks/${askId}`)
      .sort((a, b) => a.targetUserId.localeCompare(b.targetUserId));
  const callsTo = (userId: "u1" | "u2") =>
    discordCalls.filter((c) => c.url === HOOK[userId]);
  return {
    time,
    access,
    agentRooms,
    agentNames,
    asks,
    pager,
    source,
    pushStore,
    discordCalls,
    pushCalls,
    hold,
    open,
    itemsOf,
    callsTo,
  };
}
type World = ReturnType<typeof world>;

// The ask's link as Discord carries it.
const askLink = (askId: string) => `${ORIGIN}/inbox/asks/${askId}`;
// A Discord "resolved" message for this title: it pings nobody.
const isResolved = (call: DiscordCall, title: string) =>
  call.body.content === en("pager.discord.resolved", { title }) &&
  call.body.allowed_mentions.users === undefined;

describe("the page items of a paged ask", () => {
  it("one item per recipient, linking to the ask, with its agent and room; a page keeps its own item", () => {
    const w = world();
    const raised = w.pager.raise({
      source: { kind: "agent", agentId: "a1", name: "Bot", roomId: "room-a" },
      targetUserId: "u1",
      fields: { title: "Disk full" },
    });
    if (raised.outcome === "too_many") throw new Error("raise failed");
    const page: PagerEntry = raised.entry;
    const plain = w.asks.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    expect(plain.ok).toBe(true);
    const ask = w.open();

    const items = w.source.list();
    expect(items.find((i) => i.id === page.id)).toMatchObject({
      targetUserId: "u1",
      title: "Disk full",
      state: "open",
      sourceName: "Bot",
      roomId: "room-a",
      path: pagerLink("", page.id),
    });
    const mine = w.itemsOf(ask.id);
    expect(
      mine.map((i) => [i.targetUserId, i.state, i.sourceName, i.roomId]),
    ).toEqual([
      ["u1", "open", "Bot", "room-a"],
      ["u2", "open", "Bot", "room-a"],
    ]);
    for (const item of mine) {
      expect(item.delivery).toEqual(NONE);
      expect(item.id).not.toBe(page.id);
      expect(w.source.get(item.id)).toEqual(item);
    }
    expect(new Set(mine.map((i) => i.id)).size).toBe(2);
    // Every item is the page or the paged ask's: the plain ask has none.
    expect(items).toHaveLength(3);
  });

  it("the title is the first line with text, without colour markup; the body is the rest", () => {
    const w = world();
    const ask = w.open({
      prompt:
        "\n  \n:red[**Decide**] Restart :pink[the] box?\nThe disk is :orange[full].\n\nIt fills at 2 GB/h.",
    });
    const [item] = w.itemsOf(ask.id);
    // A name that is not a colour stays as typed, as the card draws it.
    expect(item.title).toBe("**Decide** Restart :pink[the] box?");
    expect(item.body?.trim()).toBe("The disk is full.\n\nIt fills at 2 GB/h.");

    const oneLine = w.open({ prompt: "Restart the box?" });
    expect(w.itemsOf(oneLine.id)[0].body ?? "").toBe("");

    const long = w.open({
      prompt: `${"t".repeat(300)}\n${"b".repeat(3000)}`,
    });
    const [clipped] = w.itemsOf(long.id);
    expect(clipped.title.length).toBeLessThanOrEqual(200);
    expect(clipped.title.startsWith("t".repeat(150))).toBe(true);
    expect(clipped.body!.length).toBeLessThanOrEqual(2000);
    expect(clipped.body!.startsWith("b".repeat(1500))).toBe(true);
  });

  it("an app's paged ask is named for the app", () => {
    const w = world();
    const ask = w.open({ app: { name: "uptime", createdAt: 7 } });
    expect(w.itemsOf(ask.id).map((i) => i.sourceName)).toEqual([
      "uptime",
      "uptime",
    ]);
  });

  it("an acked paged ask's items are acked", () => {
    const w = world();
    const ask = w.open();
    w.asks.ack(ask.id, "u2");
    expect(w.itemsOf(ask.id).map((i) => i.state)).toEqual(["acked", "acked"]);
  });

  it("a recipient who no longer reaches the room has no item", () => {
    const w = world();
    const ask = w.open();
    const u2Item = w.itemsOf(ask.id)[1];
    expect(u2Item.targetUserId).toBe("u2");
    w.access.get("u2")!.delete("room-a");
    expect(w.itemsOf(ask.id).map((i) => i.targetUserId)).toEqual(["u1"]);
    expect(w.source.get(u2Item.id)).toBeNull();
  });
});

describe("Discord delivery of a paged ask", () => {
  async function opened(w: World) {
    const ask = w.open();
    await w.time.advance(0);
    expect([w.callsTo("u1").length, w.callsTo("u2").length]).toEqual([1, 1]);
    return ask;
  }

  it("goes to each recipient's own webhook, links to the ask, and repeats on each one's interval", async () => {
    const w = world();
    const ask = await opened(w);
    expect(w.discordCalls).toHaveLength(2);
    for (const call of w.discordCalls) {
      const embed = call.body.embeds?.[0];
      expect(embed?.url).toBe(askLink(ask.id));
      expect(embed?.title).toBe("Restart the box?");
      expect(embed?.description).toBe("The disk is full.");
      expect(embed?.footer?.text).toContain("Bot");
      expect(embed?.footer?.text).toContain("Ops");
    }
    // Each recipient's ping names only them.
    expect(w.callsTo("u1")[0].body.allowed_mentions.users).toEqual(["111"]);
    expect(w.callsTo("u2")[0].body.allowed_mentions.users).toEqual(["222"]);
    // The sends are recorded on the ask, per recipient.
    const delivery = w.asks.get(ask.id)!.page!.delivery;
    expect([delivery.u1.sends, delivery.u2.sends]).toEqual([1, 1]);

    await w.time.advance(5 * MIN);
    expect([w.callsTo("u1").length, w.callsTo("u2").length]).toEqual([2, 1]);
    await w.time.advance(25 * MIN);
    expect(w.callsTo("u1").length).toBe(7);
    expect(w.callsTo("u2").length).toBe(2);
    // A repeat links to the ask too.
    expect(w.callsTo("u2")[1].body.embeds?.[0].url).toBe(askLink(ask.id));
  });

  it("an ack stops every recipient's repeats and sends no resolved message; the ask stays open", async () => {
    const w = world();
    const ask = await opened(w);
    w.asks.ack(ask.id, "u1");
    await w.time.advance(90 * MIN);
    expect(w.discordCalls).toHaveLength(2);
    expect(w.asks.get(ask.id)?.page?.state).toBe("acked");
  });

  it("a recipient who loses the room gets no repeat; the other still does", async () => {
    const w = world();
    await opened(w);
    w.access.get("u2")!.delete("room-a");
    await w.time.advance(60 * MIN);
    expect(w.callsTo("u2")).toHaveLength(1);
    expect(w.callsTo("u1").length).toBeGreaterThan(10);
  });

  it("a reply sends one resolved message to each recipient, then nothing", async () => {
    const w = world();
    const ask = await opened(w);
    const items = w.itemsOf(ask.id);
    w.asks.remove(ask.id, { outcome: "replied", byUserId: "u1" });
    await w.time.advance(MIN);
    for (const userId of ["u1", "u2"] as const) {
      const calls = w.callsTo(userId);
      expect(calls).toHaveLength(2);
      expect(isResolved(calls[1], "Restart the box?")).toBe(true);
      expect(calls[1].body.embeds?.[0].url).toBe(askLink(ask.id));
    }
    // The source forgets the closed ask once its notices are sent.
    for (const item of items) expect(w.source.get(item.id)).toBeNull();
    expect(w.source.list()).toEqual([]);
    await w.time.advance(90 * MIN);
    expect(w.discordCalls).toHaveLength(4);
  });

  it("a reply sends no resolved message to a recipient who lost the room: the title does not reach them again", async () => {
    const w = world();
    const ask = await opened(w);
    w.access.get("u2")!.delete("room-a");
    w.asks.remove(ask.id, { outcome: "replied", byUserId: "u1" });
    await w.time.advance(MIN);
    expect(w.callsTo("u2")).toHaveLength(1);
    expect(w.callsTo("u1")).toHaveLength(2);
    expect(isResolved(w.callsTo("u1")[1], "Restart the box?")).toBe(true);
    expect(w.source.list()).toEqual([]);
  });

  it("an ask closed by its agent's removal, after the agent left the office, still sends the resolved message with the agent's name", async () => {
    const w = world();
    await opened(w);
    // The office removes the agent's asks after the agent is gone
    // (server/office-event-fanout.ts, agent_removed).
    w.agentRooms.delete("a1");
    w.agentNames.delete("a1");
    expect(w.asks.removeAgent("a1")).toBe(1);
    await w.time.advance(MIN);
    for (const userId of ["u1", "u2"] as const) {
      const calls = w.callsTo(userId);
      expect(calls).toHaveLength(2);
      expect(isResolved(calls[1], "Restart the box?")).toBe(true);
      expect(calls[1].body.embeds?.[0].footer?.text).toContain("Bot");
    }
  });

  it("a close during the first send still sends the resolved message", async () => {
    const w = world();
    const release = w.hold();
    const ask = w.open();
    await settle();
    // Both first sends are on the wire.
    expect(w.discordCalls).toHaveLength(2);
    w.asks.remove(ask.id, { outcome: "dismissed", byUserId: "u2" });
    release();
    await w.time.advance(MIN);
    for (const userId of ["u1", "u2"] as const) {
      const calls = w.callsTo(userId);
      expect(calls).toHaveLength(2);
      expect(isResolved(calls[1], "Restart the box?")).toBe(true);
    }
    await w.time.advance(90 * MIN);
    expect(w.discordCalls).toHaveLength(4);
  });
});

describe("Web Push delivery of a paged ask", () => {
  // u1 and u2 have one device each; u3, who is no recipient, has one too.
  async function devices(w: World) {
    const out: Record<string, Awaited<ReturnType<typeof browserDevice>>> = {};
    for (const [n, userId] of [
      [1, "u1"],
      [2, "u2"],
      [3, "u3"],
    ] as const) {
      out[userId] = await browserDevice(n);
      await w.pushStore.upsert(userId, out[userId].input);
    }
    return out;
  }
  const pushesTo = (w: World, dev: Awaited<ReturnType<typeof browserDevice>>) =>
    w.pushCalls.filter((c) => c.url === dev.input.endpoint);

  it("goes to each recipient's devices only, opening the ask, with the plain title", async () => {
    const w = world();
    const dev = await devices(w);
    const ask = w.open({ prompt: ":red[**Decide**] Restart?\nThe disk." });
    await w.time.advance(0);
    expect(pushesTo(w, dev.u3)).toHaveLength(0);
    for (const userId of ["u1", "u2"] as const) {
      const [call] = pushesTo(w, dev[userId]);
      const payload = await decrypt(call.body, dev[userId]);
      expect(payload.url).toBe(`/inbox/asks/${ask.id}`);
      expect(payload.title).toBe("**Decide** Restart?");
      expect(payload.renotify).toBe(true);
    }
  });

  it("repeats on each recipient's interval until an ack, and the reply sends one resolved push to each", async () => {
    const w = world();
    const dev = await devices(w);
    const ask = w.open();
    await w.time.advance(5 * MIN);
    expect([pushesTo(w, dev.u1).length, pushesTo(w, dev.u2).length]).toEqual([
      2, 1,
    ]);
    w.asks.ack(ask.id, "u2");
    await w.time.advance(90 * MIN);
    expect([pushesTo(w, dev.u1).length, pushesTo(w, dev.u2).length]).toEqual([
      2, 1,
    ]);
    w.asks.remove(ask.id, { outcome: "replied", byUserId: "u1" });
    await w.time.advance(0);
    for (const userId of ["u1", "u2"] as const) {
      const calls = pushesTo(w, dev[userId]);
      const first = await decrypt(calls[0].body, dev[userId]);
      const last = await decrypt(calls[calls.length - 1].body, dev[userId]);
      expect(last.renotify).toBe(false);
      // It replaces the page's notification.
      expect(last.tag).toBe(first.tag);
    }
    expect(pushesTo(w, dev.u3)).toHaveLength(0);
  });

  it("a recipient who loses the room gets no repeat push", async () => {
    const w = world();
    const dev = await devices(w);
    w.open();
    await w.time.advance(0);
    w.access.get("u2")!.delete("room-a");
    await w.time.advance(60 * MIN);
    expect(pushesTo(w, dev.u2)).toHaveLength(1);
    expect(pushesTo(w, dev.u1).length).toBeGreaterThan(10);
  });

  it("an ask closed by its agent's removal sends the resolved push with the agent's name", async () => {
    const w = world();
    const dev = await devices(w);
    w.open();
    await w.time.advance(0);
    w.agentRooms.delete("a1");
    w.agentNames.delete("a1");
    w.asks.removeAgent("a1");
    await w.time.advance(0);
    for (const userId of ["u1", "u2"] as const) {
      const calls = pushesTo(w, dev[userId]);
      expect(calls).toHaveLength(2);
      const last = await decrypt(calls[1].body, dev[userId]);
      expect(last.renotify).toBe(false);
      expect(last.body).toContain("Bot");
    }
  });
});
