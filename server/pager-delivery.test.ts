// Pager delivery: first send, repeat, ack and resolve, the resolved message,
// 429 retry_after and its saved hold, pacing, failure classes, no webhook,
// restart resume, the races between a send and an ack or resolve, the
// member's language, and the leak checks. A real store over an in-memory
// persistence; fetch, the clock and the timers are fakes. No test sends to
// Discord.

import { describe, it, expect, afterEach } from "bun:test";
import { createPagerStore, type PagerStore } from "./pager-store.ts";
import {
  buildPageMessage,
  createPagerDelivery,
  pagerLink,
  PAGER_SEND_SPACING_MS,
  type PagerDeliveryService,
} from "./pager-delivery.ts";
import {
  PAGER_DEFAULT_REPEAT_MINUTES,
  type PagerMemberSettings,
} from "./pager-settings.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import type { PagerEntry, PagerSource } from "../shared/types.ts";

const MIN = 60_000;
const GAP = PAGER_SEND_SPACING_MS;
const TOKEN = "SeCrEtWeBhOoKtOkEn_abcd";
const URL_ = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const DISCORD_ID = "112233445566778899";
const ORIGIN = "https://office.example.com";
const SECRET_BODY = "response-body-marker";
const en = translatorFor("en").t;
const es = translatorFor("es").t;

const source: PagerSource = {
  kind: "agent",
  agentId: "agent-1",
  name: "Bot",
  roomId: "room-a",
};

// Manual clock and timers: advance() fires due timers in order.
function fakeTime(start = 1_000_000) {
  let t = start;
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
    pending: () => timers.size,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await settle();
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
    },
  };
}

// Let queued sends run to completion.
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Call {
  url: string;
  at: number;
  init: RequestInit;
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

// Responds from a script, then 204. hold() parks every request until the
// returned release() runs, for the in-flight races.
function fakeFetch(now: () => number) {
  const calls: Call[] = [];
  const script: Array<() => Response | Promise<Response>> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let gate: Promise<void> | null = null;
  return {
    calls,
    script,
    get maxInFlight() {
      return maxInFlight;
    },
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        at: now(),
        init,
        body: JSON.parse(init.body as string),
      });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gate) await gate;
        const next = script.shift();
        return next ? await next() : new Response(null, { status: 204 });
      } finally {
        inFlight--;
      }
    },
  };
}

function memPersistence(initial: PagerEntry[] | null = null) {
  return {
    saved: initial,
    load() {
      return initial
        ? ({ kind: "data", value: structuredClone(initial) } as const)
        : ({ kind: "missing" } as const);
    },
    save(entries: PagerEntry[]) {
      this.saved = structuredClone(entries);
    },
    quarantine: () => true,
  };
}

const services: PagerDeliveryService[] = [];
let restoreConsole: (() => void) | null = null;
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  restoreConsole?.();
  restoreConsole = null;
});

// Capture every console line for the leak checks.
function captureConsole(): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) {
    console[k] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  }
  restoreConsole = () => Object.assign(console, orig);
  return lines;
}

const WITH_WEBHOOK: PagerMemberSettings = {
  repeatMinutes: PAGER_DEFAULT_REPEAT_MINUTES,
  webhookUrl: URL_,
  discordUserId: DISCORD_ID,
};
const NO_WEBHOOK: PagerMemberSettings = { repeatMinutes: 5 };

function setup(
  opts: {
    settings?: Partial<PagerMemberSettings>;
    noWebhook?: boolean;
    pages?: PagerEntry[];
    language?: "en" | "es";
    time?: ReturnType<typeof fakeTime>;
  } = {},
) {
  const time = opts.time ?? fakeTime();
  const net = fakeFetch(time.now);
  const events: PagerEntry[] = [];
  const holds: number[] = [];
  const state = {
    settings: opts.noWebhook
      ? { ...NO_WEBHOOK }
      : { ...WITH_WEBHOOK, ...(opts.settings ?? {}) },
    settingsError: null as Error | null,
  };
  const persistence = memPersistence(opts.pages ?? null);
  let svc: PagerDeliveryService;
  const store: PagerStore = createPagerStore({
    persistence,
    now: time.now,
    onChange: (e) => events.push(e),
    onRaised: (e, k) => svc.onRaised(e, k),
    onTransitioned: (e, to) => svc.onTransitioned(e, to),
  });
  const boot = () => {
    const next = createPagerDelivery({
      store,
      settings: () => {
        if (state.settingsError) throw state.settingsError;
        return state.settings;
      },
      setHoldUntil: (_userId, at) => {
        holds.push(at);
        state.settings = { ...state.settings, holdUntil: at };
      },
      translator: () => (opts.language === "es" ? es : en),
      fetch: net.fetch,
      now: time.now,
      scheduler: time.scheduler,
      officeOrigin: () => ORIGIN,
      roomName: (id) => (id === "room-a" ? "Ops" : null),
    });
    services.push(next);
    return next;
  };
  svc = boot();
  const raise = (
    title = "Disk full",
    extra: { body?: string; key?: string } = {},
  ) => {
    const r = store.raise({
      source,
      targetUserId: "u1",
      fields: { title, ...extra },
    });
    if (r.outcome === "too_many") throw new Error("too many");
    return r.entry;
  };
  return {
    time,
    net,
    store,
    get svc() {
      return svc;
    },
    events,
    holds,
    state,
    persistence,
    raise,
    // A restart: the old service stops, a new one boots over the same store.
    restart() {
      svc.stop();
      svc = boot();
      svc.start();
    },
  };
}

describe("pager delivery: first send", () => {
  it("a new page reaches the webhook once, with the mention and the link", async () => {
    const s = setup();
    const page = s.raise("Disk full", { body: "90% used" });
    await settle();
    expect(s.net.calls).toHaveLength(1);
    const call = s.net.calls[0];
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.body.content).toBe(`<@${DISCORD_ID}> Disk full`);
    expect(call.body.allowed_mentions).toEqual({
      parse: [],
      users: [DISCORD_ID],
    });
    const embed = call.body.embeds![0];
    expect(embed.url).toBe(`${ORIGIN}/?pager=${page.id}`);
    expect(embed.description).toBe("90% used");
    expect(embed.footer!.text).toContain("Ops");
    expect(embed.footer!.text).toContain("Bot");
    expect(s.store.get(page.id)!.delivery).toEqual({
      state: "delivered",
      sends: 1,
      lastAttemptAt: s.time.now(),
    });
    // The delivery change reached the event stream.
    expect(s.events.at(-1)!.delivery.state).toBe("delivered");
  });

  it("allowed_mentions names only the member, whatever the title holds", async () => {
    const s = setup();
    s.raise("@everyone @here <@&999> <@555555555555555555>");
    await settle();
    expect(s.net.calls[0].body.allowed_mentions).toEqual({
      parse: [],
      users: [DISCORD_ID],
    });
  });

  it("without a Discord user ID there is no mention at all", async () => {
    const s = setup({ settings: { discordUserId: undefined } });
    s.raise("@everyone look");
    await settle();
    expect(s.net.calls[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(s.net.calls[0].body.content).not.toContain("<@");
  });

  it("a re-raise sends nothing at once; the next repeat carries the new text", async () => {
    const s = setup();
    s.raise("v1", { key: "k" });
    await settle();
    s.raise("v2", { key: "k", body: "new body" });
    await settle();
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(5 * MIN);
    expect(s.net.calls).toHaveLength(2);
    expect(s.net.calls[1].body.content).toContain("v2");
    expect(s.net.calls[1].body.embeds![0].description).toBe("new body");
  });

  it("a re-raise of an acked page sends nothing and does not restart repeats", async () => {
    const s = setup();
    const page = s.raise("v1", { key: "k" });
    await settle();
    s.store.ack(page.id, "Boss");
    s.raise("v2", { key: "k" });
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(1);
  });
});

describe("pager delivery: the member's language", () => {
  it("the words around the title follow the member; title and body do not", async () => {
    const s = setup({ language: "es" });
    const page = s.raise("Disk full", { body: "90% used" });
    await settle();
    await s.time.advance(5 * MIN);
    const repeat = s.net.calls[1].body;
    expect(repeat.content).toBe(
      `<@${DISCORD_ID}> ${es("pager.discord.stillOpen", { title: "Disk full" })}`,
    );
    expect(repeat.content).not.toBe(
      `<@${DISCORD_ID}> ${en("pager.discord.stillOpen", { title: "Disk full" })}`,
    );
    expect(repeat.embeds![0].title).toBe("Disk full");
    expect(repeat.embeds![0].description).toBe("90% used");
    s.store.resolve(page.id, "Bot");
    await s.time.advance(GAP);
    expect(s.net.calls[2].body.content).toBe(
      es("pager.discord.resolved", { title: "Disk full" }),
    );
    const test = s.svc.sendTest("u1");
    await s.time.advance(GAP);
    expect(await test).toEqual({ delivered: true });
    expect(s.net.calls[3].body.content).toBe(
      `<@${DISCORD_ID}> ${es("pager.discord.test")}`,
    );
  });
});

describe("pager delivery: repeat", () => {
  it("an open page repeats at the interval and stops on ack", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    await s.time.advance(5 * MIN - 1);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
    expect(s.net.calls[1].body.content).toBe(
      `<@${DISCORD_ID}> ${en("pager.discord.stillOpen", { title: "Disk full" })}`,
    );
    await s.time.advance(5 * MIN);
    expect(s.net.calls).toHaveLength(3);
    s.store.ack(page.id, "Boss");
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(3);
    expect(s.time.pending()).toBe(0);
    expect(s.store.get(page.id)!.delivery.sends).toBe(3);
  });

  it("follows the member's interval", async () => {
    const s = setup({ settings: { repeatMinutes: 15 } });
    s.raise();
    await settle();
    await s.time.advance(14 * MIN);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1 * MIN);
    expect(s.net.calls).toHaveLength(2);
  });

  it("never: one send and no repeats", async () => {
    const s = setup({ settings: { repeatMinutes: null } });
    s.raise();
    await settle();
    await s.time.advance(24 * 60 * MIN);
    expect(s.net.calls).toHaveLength(1);
    expect(s.time.pending()).toBe(0);
  });
});

describe("pager delivery: resolve", () => {
  it("resolve stops the repeat and sends one resolved message without a ping", async () => {
    const s = setup();
    const page = s.raise("Disk full");
    await settle();
    s.store.resolve(page.id, "Bot");
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(2);
    const resolved = s.net.calls[1].body;
    expect(resolved.content).toBe(
      en("pager.discord.resolved", { title: "Disk full" }),
    );
    expect(resolved.allowed_mentions).toEqual({ parse: [] });
    expect(resolved.embeds![0].url).toBe(pagerLink(ORIGIN, page.id));
    expect(s.store.get(page.id)!.delivery.resolvedNotice).toBe("done");
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(2);
    expect(s.time.pending()).toBe(0);
  });

  it("resolve after ack still sends the resolved message", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    s.store.ack(page.id, "Boss");
    s.store.resolve(page.id, "Boss");
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(2);
  });

  it("a page whose first send failed still gets the resolved message", async () => {
    const s = setup();
    s.net.script.push(() => new Response(null, { status: 500 }));
    const page = s.raise();
    await settle();
    expect(s.store.get(page.id)!.delivery.sends).toBe(0);
    s.store.resolve(page.id, "Bot");
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(2);
    expect(s.net.calls[1].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("with no webhook, resolve records no_webhook and sends nothing", async () => {
    const s = setup({ noWebhook: true });
    const page = s.raise();
    await settle();
    s.store.resolve(page.id, "Bot");
    await settle();
    expect(s.net.calls).toHaveLength(0);
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      lastFailure: "no_webhook",
      resolvedNotice: "done",
    });
  });

  it("a resolved message refused by Discord is not retried", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    s.net.script.push(() => new Response(null, { status: 404 }));
    s.store.resolve(page.id, "Bot");
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(2);
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      state: "failed",
      lastFailure: "http_4xx",
      resolvedNotice: "done",
    });
  });
});

describe("pager delivery: races with a send in flight", () => {
  it("a resolve during the first send: the send records over the latest state, then the resolved message goes", async () => {
    const s = setup();
    const release = s.net.hold();
    const page = s.raise();
    await settle();
    expect(s.net.calls).toHaveLength(1);
    s.store.resolve(page.id, "Bot");
    release();
    await settle();
    // The page send kept the pending mark the resolve wrote meanwhile.
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      state: "delivered",
      sends: 1,
      resolvedNotice: "pending",
    });
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(2);
    expect(s.net.calls[1].body.allowed_mentions).toEqual({ parse: [] });
    expect(s.store.get(page.id)!.delivery.resolvedNotice).toBe("done");
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(2);
  });

  it("an ack during a repeat send stops the repeats after it lands", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    const release = s.net.hold();
    await s.time.advance(5 * MIN);
    expect(s.net.calls).toHaveLength(2);
    s.store.ack(page.id, "Boss");
    release();
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(2);
    expect(s.time.pending()).toBe(0);
    expect(s.store.get(page.id)!.state).toBe("acked");
  });

  it("an ack cancels a send still waiting in the queue", async () => {
    const s = setup();
    const release = s.net.hold();
    s.raise("one");
    const two = s.raise("two");
    await settle();
    expect(s.net.calls).toHaveLength(1);
    s.store.ack(two.id, "Boss");
    release();
    await s.time.advance(60 * MIN);
    expect(s.net.calls.map((c) => c.body.content)).not.toContainEqual(
      expect.stringContaining("two"),
    );
  });
});

describe("pager delivery: pacing and 429", () => {
  it("a 429 waits Discord's retry_after, then sends", async () => {
    const s = setup();
    s.net.script.push(() =>
      Response.json({ retry_after: 2.5, global: false }, { status: 429 }),
    );
    const page = s.raise();
    await settle();
    expect(s.net.calls).toHaveLength(1);
    expect(s.store.get(page.id)!.delivery.lastFailure).toBe("rate_limited");
    await s.time.advance(2499);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      state: "delivered",
      sends: 1,
    });
    expect(s.store.get(page.id)!.delivery.lastFailure).toBeUndefined();
  });

  it("a long retry_after is honored in full, not cut short", async () => {
    const s = setup();
    s.net.script.push(() =>
      Response.json({ retry_after: 7200 }, { status: 429 }),
    );
    s.raise();
    await settle();
    await s.time.advance(7200_000 - 1);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
  });

  it("falls back to the Retry-After header", async () => {
    const s = setup();
    s.net.script.push(
      () =>
        new Response("not json", {
          status: 429,
          headers: { "retry-after": "3" },
        }),
    );
    s.raise();
    await settle();
    await s.time.advance(2999);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
  });

  it("the hold is saved and covers new pages, a settings save, the resolved message and a restart", async () => {
    const s = setup();
    s.net.script.push(() =>
      Response.json({ retry_after: 600 }, { status: 429 }),
    );
    const first = s.raise("first");
    await settle();
    expect(s.holds).toEqual([s.time.now() + 600_000]);
    s.raise("second");
    s.svc.rescheduleMember("u1");
    await s.time.advance(60_000);
    expect(s.net.calls).toHaveLength(1);
    s.restart();
    s.store.resolve(first.id, "Bot");
    await s.time.advance(600_000 - 60_000 - 1);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
  });

  it("under a hold the test send answers rate_limited at once and sends nothing", async () => {
    const s = setup();
    s.net.script.push(() =>
      Response.json({ retry_after: 600 }, { status: 429 }),
    );
    s.raise();
    await settle();
    let result: unknown = "unsettled";
    void s.svc.sendTest("u1").then((r) => (result = r));
    await settle();
    expect(result).toEqual({ delivered: false, failure: "rate_limited" });
    expect(s.net.calls).toHaveLength(1);
  });

  it("sends to one member stay PAGER_SEND_SPACING_MS apart, one at a time", async () => {
    const s = setup();
    s.raise("one");
    s.raise("two");
    s.raise("three");
    await settle();
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(GAP - 1);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(3);
    expect(s.net.maxInFlight).toBe(1);
  });

  it("the test send waits its turn behind the spacing", async () => {
    const s = setup();
    s.raise();
    await settle();
    let result: unknown = null;
    void s.svc.sendTest("u1").then((r) => (result = r));
    await settle();
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(GAP);
    expect(s.net.calls).toHaveLength(2);
    expect(result).toEqual({ delivered: true });
  });
});

describe("pager delivery: failures", () => {
  for (const [label, respond, failure] of [
    ["a 404", () => new Response(SECRET_BODY, { status: 404 }), "http_4xx"],
    ["a 500", () => new Response(SECRET_BODY, { status: 500 }), "http_5xx"],
    [
      "a network error that quotes the URL",
      () => {
        throw new Error(`Unable to connect to ${URL_}`);
      },
      "network",
    ],
    [
      "a redirect refused by redirect: error",
      () => {
        throw new TypeError(`fetch failed: redirect from ${URL_}`);
      },
      "network",
    ],
  ] as const) {
    it(`${label} lands on the record as ${failure}, without the URL or the response body`, async () => {
      const lines = captureConsole();
      const s = setup();
      s.net.script.push(respond);
      const page = s.raise();
      await settle();
      expect(s.store.get(page.id)!.delivery).toEqual({
        state: "not_delivered",
        sends: 0,
        lastAttemptAt: s.time.now(),
        lastFailure: failure,
      });
      const everything = [
        JSON.stringify(s.persistence.saved),
        JSON.stringify(s.events),
        ...lines,
      ].join("\n");
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain(SECRET_BODY);
      expect(lines.length).toBeGreaterThan(0);
      // The page was not lost: the next repeat retries.
      await s.time.advance(5 * MIN);
      expect(s.net.calls).toHaveLength(2);
      expect(s.store.get(page.id)!.delivery.state).toBe("delivered");
    });
  }

  it("a settings or record error that quotes the URL is never logged", async () => {
    const lines = captureConsole();
    const s = setup();
    const page = s.raise();
    await settle();
    s.state.settingsError = new Error(`cannot load ${URL_}`);
    await s.time.advance(5 * MIN);
    expect(() => s.svc.rescheduleMember("u1")).not.toThrow();
    s.state.settingsError = null;
    const realRecord = s.store.recordDelivery.bind(s.store);
    s.store.recordDelivery = () => {
      throw new Error(`EACCES writing ${URL_}`);
    };
    s.svc.rescheduleMember("u1");
    await s.time.advance(5 * MIN);
    s.store.recordDelivery = realRecord;
    s.store.resolve(page.id, "Bot");
    await s.time.advance(GAP);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("a page store that cannot save does not turn the repeat into a retry loop", async () => {
    captureConsole();
    for (const noWebhook of [false, true]) {
      const s = setup({ noWebhook });
      const realRecord = s.store.recordDelivery.bind(s.store);
      s.store.recordDelivery = () => {
        throw new Error("EACCES");
      };
      s.raise();
      await s.time.advance(5 * MIN);
      s.store.recordDelivery = realRecord;
      // One first send, and at most the one repeat that was due.
      expect(s.net.calls.length).toBeLessThanOrEqual(noWebhook ? 0 : 2);
    }
  });

  it("a failure after a successful send marks the page failed", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    s.net.script.push(() => new Response(null, { status: 404 }));
    await s.time.advance(5 * MIN);
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      state: "failed",
      sends: 1,
      lastFailure: "http_4xx",
    });
  });

  it("a member with no webhook gets no_webhook and nothing is sent", async () => {
    const s = setup({ noWebhook: true });
    const page = s.raise();
    await settle();
    expect(s.net.calls).toHaveLength(0);
    expect(s.store.get(page.id)!.delivery).toEqual({
      state: "not_delivered",
      sends: 0,
      lastAttemptAt: s.time.now(),
      lastFailure: "no_webhook",
    });
    // No repeat ticks for a member who has nowhere to send.
    expect(s.time.pending()).toBe(0);
  });

  it("adding a webhook later sends the open pages the member never got", async () => {
    const s = setup({ noWebhook: true });
    const page = s.raise();
    await settle();
    s.state.settings = { ...WITH_WEBHOOK };
    s.svc.rescheduleMember("u1");
    await settle();
    expect(s.net.calls).toHaveLength(1);
    expect(s.store.get(page.id)!.delivery.state).toBe("delivered");
  });
});

describe("pager delivery: repeat setting changes and the owed first send", () => {
  it("with repeats off, a first send that hit a 429 is still owed after a restart", async () => {
    const s = setup({ settings: { repeatMinutes: null } });
    s.net.script.push(() =>
      Response.json({ retry_after: 30 }, { status: 429 }),
    );
    const page = s.raise();
    await settle();
    expect(s.store.get(page.id)!.delivery.lastFailure).toBe("rate_limited");
    s.restart();
    await s.time.advance(29_999);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
    expect(s.store.get(page.id)!.delivery).toMatchObject({
      state: "delivered",
      sends: 1,
    });
    await s.time.advance(24 * 60 * MIN);
    expect(s.net.calls).toHaveLength(2);
  });

  it("turning repeats off cancels a repeat already waiting in the queue", async () => {
    const s = setup();
    const page = s.raise();
    await settle();
    await s.time.advance(GAP);
    s.net.script.push(() =>
      Response.json({ retry_after: 600 }, { status: 429 }),
    );
    expect(await s.svc.sendTest("u1")).toMatchObject({
      failure: "rate_limited",
    });
    // The repeat comes due and waits behind the hold.
    await s.time.advance(5 * MIN);
    expect(s.net.calls).toHaveLength(2);
    s.state.settings = { ...s.state.settings, repeatMinutes: null };
    s.svc.rescheduleMember("u1");
    await s.time.advance(10 * MIN);
    expect(s.net.calls).toHaveLength(2);
    expect(s.store.get(page.id)!.delivery.sends).toBe(1);
  });

  it("a longer interval chosen while a repeat waits pushes that repeat out", async () => {
    const s = setup();
    s.raise();
    await settle();
    await s.time.advance(GAP);
    s.net.script.push(() =>
      Response.json({ retry_after: 600 }, { status: 429 }),
    );
    await s.svc.sendTest("u1");
    await s.time.advance(5 * MIN);
    s.state.settings = { ...s.state.settings, repeatMinutes: 30 };
    s.svc.rescheduleMember("u1");
    await s.time.advance(30 * MIN - 5 * MIN - GAP - 1);
    expect(s.net.calls).toHaveLength(2);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(3);
  });
});

describe("pager delivery: restart", () => {
  function savedPage(over: Partial<PagerEntry>): PagerEntry {
    return {
      id: "p1",
      createdAt: 0,
      lastRaisedAt: 0,
      raiseCount: 1,
      source,
      targetUserId: "u1",
      title: "Saved",
      state: "open",
      delivery: { state: "delivered", sends: 1 },
      ...over,
    };
  }

  it("resumes the schedule from lastAttemptAt without an immediate send", async () => {
    const time = fakeTime();
    const s = setup({
      time,
      pages: [
        savedPage({
          delivery: {
            state: "delivered",
            sends: 1,
            lastAttemptAt: time.now() - 2 * MIN,
          },
        }),
      ],
    });
    s.svc.start();
    await settle();
    expect(s.net.calls).toHaveLength(0);
    await s.time.advance(3 * MIN - 1);
    expect(s.net.calls).toHaveLength(0);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(1);
  });

  it("overdue pages catch up one per PAGER_SEND_SPACING_MS, not in a burst", async () => {
    const time = fakeTime();
    const pages = ["a", "b", "c", "d"].map((id) =>
      savedPage({
        id,
        title: id,
        delivery: {
          state: "delivered",
          sends: 1,
          lastAttemptAt: time.now() - 3 * 60 * MIN,
        },
      }),
    );
    const s = setup({ time, pages });
    const t0 = time.now();
    s.svc.start();
    await s.time.advance(3 * GAP);
    expect(s.net.calls.map((c) => c.at - t0)).toEqual([
      0,
      GAP,
      2 * GAP,
      3 * GAP,
    ]);
    expect(s.net.maxInFlight).toBe(1);
  });

  it("a resolved message pending at shutdown goes out after the restart, once", async () => {
    const s = setup({
      pages: [
        savedPage({
          state: "resolved",
          resolved: { by: "Bot", at: 0 },
          delivery: { state: "delivered", sends: 1, resolvedNotice: "pending" },
        }),
        savedPage({
          id: "old",
          state: "resolved",
          resolved: { by: "Bot", at: 0 },
        }),
      ],
    });
    s.svc.start();
    await settle();
    expect(s.net.calls).toHaveLength(1);
    expect(s.net.calls[0].body.content).toBe(
      en("pager.discord.resolved", { title: "Saved" }),
    );
    expect(s.store.get("p1")!.delivery.resolvedNotice).toBe("done");
    s.restart();
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(1);
  });

  it("acked pages do not resume", async () => {
    const s = setup({
      pages: [
        savedPage({ id: "a", state: "acked", acked: { by: "x", at: 0 } }),
      ],
    });
    s.svc.start();
    await s.time.advance(60 * MIN);
    expect(s.net.calls).toHaveLength(0);
  });
});

describe("pager delivery: test page", () => {
  it("sends one message and reports the outcome", async () => {
    const s = setup();
    expect(await s.svc.sendTest("u1")).toEqual({ delivered: true });
    expect(s.net.calls).toHaveLength(1);
    expect(s.net.calls[0].body.content).toBe(
      `<@${DISCORD_ID}> ${en("pager.discord.test")}`,
    );
    expect(s.net.calls[0].body.allowed_mentions).toEqual({
      parse: [],
      users: [DISCORD_ID],
    });
    s.net.script.push(() => new Response(null, { status: 404 }));
    const second = s.svc.sendTest("u1");
    await s.time.advance(GAP);
    expect(await second).toEqual({ delivered: false, failure: "http_4xx" });
  });

  it("a 429 on the test send holds the member's queue", async () => {
    const s = setup();
    s.net.script.push(() =>
      Response.json({ retry_after: 30 }, { status: 429 }),
    );
    expect(await s.svc.sendTest("u1")).toEqual({
      delivered: false,
      failure: "rate_limited",
    });
    s.raise();
    await s.time.advance(30_000 - 1);
    expect(s.net.calls).toHaveLength(1);
    await s.time.advance(1);
    expect(s.net.calls).toHaveLength(2);
  });

  it("reports no_webhook without a send", async () => {
    const s = setup({ noWebhook: true });
    expect(await s.svc.sendTest("u1")).toEqual({
      delivered: false,
      failure: "no_webhook",
    });
    expect(s.net.calls).toHaveLength(0);
  });
});

describe("pager delivery: message", () => {
  it("falls back to the room id when the room is gone", () => {
    const entry: PagerEntry = {
      id: "p1",
      createdAt: 0,
      lastRaisedAt: 0,
      raiseCount: 1,
      source,
      targetUserId: "u1",
      title: "t",
      state: "open",
      delivery: { state: "not_delivered", sends: 0 },
    };
    const msg = buildPageMessage(entry, "page", {
      t: en,
      origin: ORIGIN,
      roomName: null,
    });
    expect(msg.embeds![0].footer!.text).toContain("room-a");
  });

  it("an app page with no room shows only the app name", () => {
    const entry: PagerEntry = {
      id: "p1",
      createdAt: 0,
      lastRaisedAt: 0,
      raiseCount: 1,
      source: {
        kind: "app",
        appName: "uptime",
        registrationGen: 1,
        name: "uptime",
        roomId: null,
      },
      targetUserId: "u1",
      title: "t",
      state: "open",
      delivery: { state: "not_delivered", sends: 0 },
    };
    const msg = buildPageMessage(entry, "page", {
      t: en,
      origin: ORIGIN,
      roomName: null,
    });
    expect(msg.embeds![0].footer!.text).toBe("uptime");
  });
});
