// Web Push delivery (server/web-push-delivery.ts).
//
// Pins: a new page goes to every device of the target member, encrypted for
// each device (decrypted here with the device's private key) and signed with
// VAPID; every page goes, whatever the member's notification rooms (only the
// turn-end push follows them); an open page repeats on the member's interval and
// stops on ack; a resolve sends one replacing "Resolved" message; a boot
// arms repeats one interval out without sending; 404/410 drop the device,
// other failures stay on it.
//
// Seam: injected fetch, clock and timers; the real store on a temp file.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createWebPushDelivery,
  encodePayload,
  type PushPayload,
  type WebPushDeliveryService,
} from "./web-push-delivery.ts";
import {
  createWebPushFilePersistence,
  createWebPushStore,
  type WebPushStore,
} from "./web-push-store.ts";
import { pagerLink } from "./pager-delivery.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { base64UrlDecode, base64UrlEncode } from "../shared/web-push.ts";
import {
  LOBBY_ROOM_ID,
  type PagerEntry,
  type PagerSource,
} from "../shared/types.ts";

const MIN = 60_000;
const ORIGIN = "https://office.example.com";
const en = translatorFor("en").t;

const agentSource: PagerSource = {
  kind: "agent",
  agentId: "agent-1",
  name: "Bot",
  roomId: "room-a",
};

function page(over: Partial<PagerEntry> = {}): PagerEntry {
  return {
    id: "aaaabbbbccccdddd",
    createdAt: 0,
    lastRaisedAt: 0,
    raiseCount: 1,
    source: agentSource,
    targetUserId: "u-morgan",
    title: "Disk full",
    body: "The data disk is at 99%.",
    state: "open",
    delivery: { state: "not_delivered", sends: 0 },
    ...over,
  };
}

function fakeTime(start = 1_000_000) {
  let t = start;
  // Waits for the sends a timer started (set by setup).
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
    pending: () => timers.size,
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

// A browser's side of a subscription: its key pair and auth secret.
async function browserDevice(n: number) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw: raw,
    auth,
    input: {
      endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
      p256dh: base64UrlEncode(raw),
      auth: base64UrlEncode(auth),
      label: `Device ${n}`,
    },
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bytes * 8,
    ),
  );
}

// The receiver's half of RFC 8291, as a browser runs it.
async function decrypt(
  body: Uint8Array<ArrayBuffer>,
  dev: Awaited<ReturnType<typeof browserDevice>>,
): Promise<PushPayload> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      dev.privateKey,
      256,
    ),
  );
  const enc = new TextEncoder();
  const info = new Uint8Array([
    ...enc.encode("WebPush: info\0"),
    ...dev.publicRaw,
    ...asPublic,
  ]);
  const ikm = await hkdf(dev.auth, ecdh, info, 32);
  const cek = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    enc.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

let dirs: string[] = [];
let services: WebPushDeliveryService[] = [];
afterEach(() => {
  for (const s of services) s.stop();
  services = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function setup(
  opts: {
    status?: (url: string) => number;
    notifRooms?: Record<string, string[] | null>;
    repeatMinutes?: number | null;
    // Read on every call, so a test can change it.
    interval?: { minutes: number | null };
    // Each member's turn-end push rooms (null: the member is gone), and who
    // can see each room.
    pushRooms?: Record<string, string[] | null>;
    audience?: Record<string, string[]>;
    pages?: PagerEntry[];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "web-push-delivery-"));
  dirs.push(dir);
  const store: WebPushStore = createWebPushStore(
    createWebPushFilePersistence(join(dir, "web-push.json")),
  );
  const time = fakeTime();
  const calls: Call[] = [];
  const pages = new Map((opts.pages ?? []).map((p) => [p.id, p]));
  const notifRooms = opts.notifRooms ?? { "u-morgan": ["room-a"] };
  const interval = opts.interval ?? {
    minutes: opts.repeatMinutes === undefined ? 5 : opts.repeatMinutes,
  };
  const service = createWebPushDelivery({
    store,
    pages: {
      list: () => [...pages.values()],
      get: (id) => pages.get(id) ?? null,
    },
    repeatMinutes: () => interval.minutes,
    pushRooms: (userId) => opts.pushRooms?.[userId] ?? null,
    roomAudience: (roomId) => opts.audience?.[roomId] ?? [],
    isLobby: (roomId) => roomId === LOBBY_ROOM_ID,
    notifRooms: (userId) =>
      Object.hasOwn(notifRooms, userId) ? notifRooms[userId] : null,
    translator: () => en,
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as Uint8Array<ArrayBuffer>,
      });
      return new Response(null, { status: opts.status?.(url) ?? 201 });
    },
    now: time.now,
    scheduler: time.scheduler,
    officeOrigin: () => ORIGIN,
    roomName: (id) => (id === "room-a" ? "Ops" : null),
  });
  services.push(service);
  time.setDrain(() => service.flush());
  return { store, time, calls, pages, service };
}

describe("web push delivery: a new page", () => {
  it("goes to each of the member's devices, encrypted and signed", async () => {
    const { store, calls, service, time } = await setup();
    const d1 = await browserDevice(1);
    const d2 = await browserDevice(2);
    const other = await browserDevice(3);
    await store.upsert("u-morgan", d1.input);
    await store.upsert("u-morgan", d2.input);
    await store.upsert("u-other", other.input);

    service.onRaised(page(), "created");
    await time.advance(0);

    expect(calls.map((c) => c.url).sort()).toEqual(
      [d1.input.endpoint, d2.input.endpoint].sort(),
    );
    const keys = await store.vapid();
    for (const call of calls) {
      expect(call.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(Number(call.headers.TTL)).toBeGreaterThan(0);
      expect(call.headers.Authorization).toStartWith("vapid t=");
      expect(call.headers.Authorization).toEndWith(`, k=${keys.publicKey}`);
    }
    const dev = calls[0].url === d1.input.endpoint ? d1 : d2;
    const payload = await decrypt(calls[0].body, dev);
    expect(payload.title).toBe("Disk full");
    expect(payload.body).toContain("The data disk is at 99%.");
    expect(payload.body).toContain("Ops");
    expect(payload.body).toContain("Bot");
    expect(payload.tag).toBe(page().id);
    // A path: the service worker opens it on its own origin.
    expect(payload.url).toBe(pagerLink("", page().id));
    expect(payload.renotify).toBe(true);
  });

  it("goes for every page, whatever the member's notification rooms (PM ruling, 2026-10-16)", async () => {
    const { store, calls, service, time } = await setup({
      notifRooms: { "u-morgan": ["room-b"] },
    });
    const d1 = await browserDevice(1);
    await store.upsert("u-morgan", d1.input);

    // The page's room is not among the member's notification rooms.
    service.onRaised(page(), "created");
    await time.advance(0);
    expect(calls).toHaveLength(1);
    calls.length = 0;

    service.onRaised(
      page({
        id: "1111222233334444",
        source: {
          kind: "app",
          appName: "health",
          registrationGen: 1,
          name: "health",
          roomId: null,
        },
      }),
      "created",
    );
    await time.advance(0);
    expect(calls).toHaveLength(1);
    const payload = await decrypt(calls[0].body, d1);
    expect(payload.body).toContain("health");
  });

  it("goes for a lobby page, whose room is in nobody's notification rooms", async () => {
    const { store, calls, service, time } = await setup({
      notifRooms: { "u-morgan": [] },
    });
    await store.upsert("u-morgan", (await browserDevice(1)).input);
    service.onRaised(
      page({ source: { ...agentSource, roomId: LOBBY_ROOM_ID } }),
      "created",
    );
    await time.advance(0);
    expect(calls).toHaveLength(1);
  });

  it("sends nothing for a re-raise or a member who is gone", async () => {
    const { store, calls, service, time } = await setup({ notifRooms: {} });
    const d1 = await browserDevice(1);
    await store.upsert("u-morgan", d1.input);
    service.onRaised(page(), "created");
    service.onRaised(page(), "reraised");
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });
});

describe("web push delivery: repeat and resolve", () => {
  it("repeats an open page on the interval and stops on ack", async () => {
    const entry = page();
    const { store, calls, service, time, pages } = await setup({
      pages: [entry],
    });
    const d1 = await browserDevice(1);
    await store.upsert("u-morgan", d1.input);
    service.onRaised(entry, "created");
    await time.advance(0);
    expect(calls).toHaveLength(1);

    await time.advance(5 * MIN - 1);
    expect(calls).toHaveLength(1);
    await time.advance(1);
    expect(calls).toHaveLength(2);
    const repeat = await decrypt(calls[1].body, d1);
    expect(repeat.title).toBe(
      en("pager.discord.stillOpen", { title: "Disk full" }),
    );
    expect(repeat.tag).toBe(entry.id);

    pages.set(entry.id, { ...entry, state: "acked" });
    service.onTransitioned(pages.get(entry.id)!, "acked");
    await time.advance(30 * MIN);
    expect(calls).toHaveLength(2);
  });

  it("moves the repeat when the member changes the interval", async () => {
    const entry = page();
    const interval = { minutes: 5 as number | null };
    const { store, calls, service, time } = await setup({
      pages: [entry],
      interval,
    });
    await store.upsert("u-morgan", (await browserDevice(1)).input);
    service.onRaised(entry, "created");
    await time.advance(MIN);
    expect(calls).toHaveLength(1);

    interval.minutes = 20;
    service.rescheduleMember("u-morgan");
    // Not at the old 5 minutes; at 20 after the first push.
    await time.advance(19 * MIN - 1);
    expect(calls).toHaveLength(1);
    await time.advance(1);
    expect(calls).toHaveLength(2);
  });

  it("does not repeat when the member chose never", async () => {
    const entry = page();
    const { store, calls, service, time } = await setup({
      pages: [entry],
      repeatMinutes: null,
    });
    await store.upsert("u-morgan", (await browserDevice(1)).input);
    service.onRaised(entry, "created");
    await time.advance(60 * MIN);
    expect(calls).toHaveLength(1);
    expect(time.pending()).toBe(0);
  });

  it("sends one replacing, silent Resolved message", async () => {
    const entry = page();
    const { store, calls, service, time, pages } = await setup({
      pages: [entry],
    });
    const d1 = await browserDevice(1);
    await store.upsert("u-morgan", d1.input);
    service.onRaised(entry, "created");
    await time.advance(0);
    pages.set(entry.id, { ...entry, state: "resolved" });
    service.onTransitioned(pages.get(entry.id)!, "resolved");
    await time.advance(30 * MIN);
    expect(calls).toHaveLength(2);
    const resolved = await decrypt(calls[1].body, d1);
    expect(resolved.title).toBe(
      en("pager.discord.resolved", { title: "Disk full" }),
    );
    expect(resolved.tag).toBe(entry.id);
    expect(resolved.renotify).toBe(false);
    expect(resolved.body).not.toContain("99%");
  });

  it("on boot, arms open pages one interval out and sends nothing at once", async () => {
    const entry = page();
    const { store, calls, service, time } = await setup({ pages: [entry] });
    await store.upsert("u-morgan", (await browserDevice(1)).input);
    service.start();
    await time.advance(5 * MIN - 1);
    expect(calls).toHaveLength(0);
    await time.advance(1);
    expect(calls).toHaveLength(1);
  });
});

describe("web push delivery: turn ends", () => {
  const bot = { id: "agent-1", name: "Bot", roomId: "room-a" };
  const audience = { "room-a": ["u-morgan"], [LOBBY_ROOM_ID]: ["u-morgan"] };
  // The one member: can see room-a and has it in their push rooms. Each
  // skip case below changes exactly one of these.
  const base = {
    pushRooms: { "u-morgan": ["room-a"] } as Record<string, string[] | null>,
    audience,
  };

  async function oneDevice(opts: Parameters<typeof setup>[0]) {
    const ctx = await setup(opts);
    const dev = await browserDevice(1);
    await ctx.store.upsert("u-morgan", dev.input);
    return { ...ctx, dev };
  }

  it("goes to a member who can see the room and has it in their push rooms", async () => {
    const { calls, service, time, dev } = await oneDevice(base);
    service.onTurnEnd(bot);
    await time.advance(0);
    expect(calls.map((c) => c.url)).toEqual([dev.input.endpoint]);
    const payload = await decrypt(calls[0].body, dev);
    expect(payload.title).toBe(en("push.turnEnd.title", { agent: "Bot" }));
    expect(payload.body).toBe("Ops");
    expect(payload.tag).toBe("turn-end:agent-1");
    expect(payload.url).toBe("/");
    expect(payload.renotify).toBe(true);
  });

  it("skips a room out of the member's push rooms", async () => {
    const { calls, service, time } = await oneDevice({
      ...base,
      pushRooms: { "u-morgan": ["room-b"] },
    });
    service.onTurnEnd(bot);
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });

  it("does not read the sound's notification rooms", async () => {
    const { calls, service, time, dev } = await oneDevice({
      ...base,
      notifRooms: { "u-morgan": [] },
    });
    service.onTurnEnd(bot);
    await time.advance(0);
    expect(calls.map((c) => c.url)).toEqual([dev.input.endpoint]);
  });

  it("skips a member who cannot see the room", async () => {
    const { calls, service, time } = await oneDevice({
      ...base,
      audience: { "room-a": [] },
    });
    service.onTurnEnd(bot);
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });

  it("skips a member who is gone", async () => {
    const { calls, service, time } = await oneDevice({
      ...base,
      pushRooms: { "u-morgan": null },
    });
    service.onTurnEnd(bot);
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });

  it("skips an agent with no room", async () => {
    const { calls, service, time } = await oneDevice(base);
    service.onTurnEnd({ ...bot, roomId: null });
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });

  it("sends nothing for the lobby (Lead ruling), even with it in the push rooms", async () => {
    const { calls, service, time } = await oneDevice({
      ...base,
      pushRooms: { "u-morgan": ["room-a", LOBBY_ROOM_ID] },
    });
    service.onTurnEnd({ ...bot, roomId: LOBBY_ROOM_ID });
    await time.advance(0);
    expect(calls).toHaveLength(0);
  });
});

describe("web push delivery: failures", () => {
  it("drops a device the push service no longer knows; keeps others with the failure", async () => {
    const devs = await Promise.all([1, 2, 3, 4, 5, 6].map(browserDevice));
    const status: Record<string, number> = {
      [devs[0].input.endpoint]: 410,
      [devs[1].input.endpoint]: 404,
      [devs[2].input.endpoint]: 503,
      [devs[3].input.endpoint]: 400,
      [devs[4].input.endpoint]: 401,
      [devs[5].input.endpoint]: 403,
    };
    const { store, service, time } = await setup({
      status: (url) => status[url],
    });
    const recs = [];
    for (const d of devs) recs.push(await store.upsert("u-morgan", d.input));
    service.onRaised(page(), "created");
    await time.advance(0);
    expect(store.get(recs[0].id)).toBeNull();
    expect(store.get(recs[1].id)).toBeNull();
    expect(store.get(recs[2].id)?.lastFailure).toBe("unreachable");
    expect(store.get(recs[3].id)?.lastFailure).toBe("rejected");
    // 401 and 403: the push service refuses the subscription (Lead ruling).
    expect(store.get(recs[4].id)).toBeNull();
    expect(store.get(recs[5].id)).toBeNull();

    // A later success clears the failure.
    status[devs[2].input.endpoint] = 201;
    expect(await service.sendTest("u-morgan", recs[2].id)).toEqual({
      delivered: true,
    });
    expect(store.get(recs[2].id)?.lastFailure).toBeUndefined();
  });

  it("a test goes only to the member's own device", async () => {
    const { store, calls, service } = await setup();
    const d1 = await browserDevice(1);
    const rec = await store.upsert("u-morgan", d1.input);
    expect(await service.sendTest("u-other", rec.id)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await service.sendTest("u-morgan", rec.id)).toEqual({
      delivered: true,
    });
    const payload = await decrypt(calls[0].body, d1);
    expect(payload.title).toBe(en("push.test"));
  });
});

describe("encodePayload", () => {
  it("ends for any input, also when the rest of the payload is too large", () => {
    const bytes = encodePayload({
      title: "t",
      body: "b",
      url: "/" + "a".repeat(3100),
      renotify: true,
    });
    expect(bytes.length).toBeLessThanOrEqual(3000);
    expect(JSON.parse(new TextDecoder().decode(bytes)).url).toBe("/");
  });

  it("never splits a surrogate pair", () => {
    const bytes = encodePayload({
      title: "t",
      body: "😀".repeat(2000),
      url: "/",
      renotify: true,
    });
    const body: string = JSON.parse(new TextDecoder().decode(bytes)).body;
    expect(body).not.toContain("\uFFFD");
    expect(body.replace(/…$/, "")).toMatch(/^(😀)+$/u);
  });

  it("shortens a long body so the payload fits one record", () => {
    const bytes = encodePayload({
      title: "t",
      body: "界".repeat(5000),
      url: ORIGIN,
      renotify: true,
    });
    expect(bytes.length).toBeLessThanOrEqual(3000);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.title).toBe("t");
    expect(parsed.body.length).toBeGreaterThan(0);
  });
});

// base64UrlDecode round-trips what base64UrlEncode writes.
describe("base64url", () => {
  it("round-trips", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });
});
