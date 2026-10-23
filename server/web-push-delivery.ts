// Web Push delivery: sends pages to the devices where the target member
// turned on notifications. Same events as the Discord delivery
// (server/pager-delivery.ts): a new page, a repeat while it stays open on the
// member's repeat interval, and one "resolved" message. The two channels are
// independent: a member with no Discord webhook still gets pushes.
//
// No room filter for pages: a page has one target member and is rare, so it
// goes to that member's devices whatever their room notification settings,
// as the Discord delivery does (PM ruling on Nil's delegation, 2026-10-16).
//
// Repeat timers are in memory. On boot, each open page is due one interval
// after the boot: no catch-up burst. A restart between a resolve and its
// send loses that "Resolved" push (Discord's is saved as pending).
//
// A rotated endpoint is not re-posted on its own: the device shows Off in
// the settings and the member turns it on again.
//
// Turn ends (onTurnEnd): a member also gets a push when an agent they can see
// ends a turn that member started, in a room on the member's pushRooms (read
// at each send; the Devices column in the room settings, independent of the
// sound's notifRooms). These are the turn ends that sound the browser's
// turn-end sound (shared/turn-end.ts). Not for the lobby: any
// member or guest talks to the receptionist, and a push reaches every
// phone. One tag per agent, so the next turn end of that agent replaces the
// last one.
//
// A push service that answers 401, 403, 404 or 410 refuses or no longer
// knows the subscription, so the device is removed. Any other failure stays on the device record for
// the settings list. Log lines are fixed text: an error may quote the
// endpoint.
//
// LEAF: the stores, the settings, the translator, fetch, the clock and the
// timers are injected.

import type { PagerEntry } from "../shared/types.ts";
import type {
  PushDeviceFailure,
  PushTestRes,
} from "../shared/contract-shapes.ts";
import type { Translator } from "../shared/i18n/translate.ts";
import type { PagerStore } from "./pager-store.ts";
import type { PushDeviceRecord, WebPushStore } from "./web-push-store.ts";
import { pagerLink } from "./pager-delivery.ts";
import { encryptPushPayload, vapidAuthorization } from "./web-push-crypto.ts";

const WEB_PUSH_SEND_TIMEOUT_MS = 10_000;
// How long a push service keeps a message for a device that is offline.
const TTL_SECONDS = 24 * 60 * 60;
// The payload must fit one 4096-byte record (server/web-push-crypto.ts).
const PAYLOAD_MAX_BYTES = 3000;
// setTimeout overflows above 2^31-1 ms; a longer wait re-arms in steps.
const TIMER_STEP_MAX_MS = 24 * 60 * 60_000;
// The VAPID contact when the office origin is not https.
const FALLBACK_SUBJECT = "https://github.com/nmamano/isomux";

type Handle = unknown;

export interface WebPushDeliveryDeps {
  store: WebPushStore;
  pages: Pick<PagerStore, "list" | "get">;
  // Minutes between repeats of an open page, or null for never. May throw.
  repeatMinutes: (userId: string) => number | null;
  // The rooms whose turn ends push to the member, or null when the member
  // is gone. May throw.
  pushRooms: (userId: string) => readonly string[] | null;
  // The members who can see a room (its access rule), for turn ends.
  roomAudience: (roomId: string) => readonly string[];
  // The receptionist's lobby: its turn ends push nobody (Lead ruling).
  isLobby: (roomId: string) => boolean;
  // The member's notification rooms, or null when the member is gone.
  notifRooms: (userId: string) => readonly string[] | null;
  translator: (userId: string) => Translator["t"];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  scheduler: {
    setTimeout(fn: () => void, ms: number): Handle;
    clearTimeout(handle: Handle): void;
  };
  // The VAPID contact, when it is https.
  officeOrigin: () => string;
  roomName: (roomId: string) => string | null;
}

export interface WebPushDeliveryService {
  onRaised(entry: PagerEntry, kind: "created" | "reraised"): void;
  onTransitioned(entry: PagerEntry, to: "acked" | "resolved"): void;
  // An agent ended a turn that the members in memberIds started.
  onTurnEnd(agent: {
    id: string;
    name: string;
    roomId: string | null;
    memberIds: readonly string[];
  }): void;
  start(): void;
  // The member changed their repeat interval: re-arm their open pages.
  rescheduleMember(userId: string): void;
  // Null when the member has no device with this id.
  sendTest(userId: string, deviceId: string): Promise<PushTestRes | null>;
  // Resolves when every send started so far has ended (tests).
  flush(): Promise<void>;
  stop(): void;
}

// What the service worker (ui/sw.js) shows.
export interface PushPayload {
  title: string;
  body: string;
  // Notifications with one tag replace each other.
  tag?: string;
  // A path: the service worker opens it on its own origin, which may differ
  // from the configured public origin (a tailnet name, a LAN address).
  url: string;
  // Alert again when replacing a notification with the same tag.
  renotify: boolean;
}

type MessageKind = "page" | "repeat" | "resolved";

// About half the text, by code points so no surrogate pair splits, with an
// ellipsis. Always shorter, and "" from one code point.
function halve(text: string): string {
  const points = Array.from(text);
  if (points.length <= 1) return "";
  return `${points.slice(0, Math.ceil(points.length / 2) - 1).join("")}…`;
}

const encoder = new TextEncoder();

// Shorten the body, then the title, until the JSON fits. Every step makes a
// field shorter, so the loop ends; with both empty and still too large, only
// the office root remains.
export function encodePayload(p: PushPayload): Uint8Array<ArrayBuffer> {
  let next = p;
  for (;;) {
    const bytes = encoder.encode(JSON.stringify(next));
    if (bytes.length <= PAYLOAD_MAX_BYTES) return bytes;
    if (next.body !== "") next = { ...next, body: halve(next.body) };
    else if (next.title !== "") next = { ...next, title: halve(next.title) };
    else {
      return encoder.encode(
        JSON.stringify({
          title: "",
          body: "",
          url: "/",
          renotify: next.renotify,
        }),
      );
    }
  }
}

function buildPagePayload(
  entry: PagerEntry,
  kind: MessageKind,
  ctx: { t: Translator["t"]; roomName: string | null },
): PushPayload {
  const title =
    kind === "page"
      ? entry.title
      : kind === "repeat"
        ? ctx.t("pager.discord.stillOpen", { title: entry.title })
        : ctx.t("pager.discord.resolved", { title: entry.title });
  // An app page with no room shows only the source.
  const room = ctx.roomName ?? entry.source.roomId;
  const footer =
    room === null ? entry.source.name : `${room} · ${entry.source.name}`;
  const body =
    kind !== "resolved" && entry.body ? `${entry.body}\n${footer}` : footer;
  return {
    title,
    body,
    tag: entry.id,
    url: pagerLink("", entry.id),
    renotify: kind !== "resolved",
  };
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to do: the body is never read.
  }
}

export function createWebPushDelivery(
  deps: WebPushDeliveryDeps,
): WebPushDeliveryService {
  const timers = new Map<string, Handle>();
  // When each open page last went out (or, after a boot, the boot).
  const lastPushAt = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  const log = (what: string) => console.error(`[web-push] ${what}`);

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      log("a delivery hand-off failed");
    }
  };

  const subject = () => {
    const origin = deps.officeOrigin();
    return origin.startsWith("https://") ? origin : FALLBACK_SUBJECT;
  };

  const sendTo = async (
    device: PushDeviceRecord,
    payload: Uint8Array<ArrayBuffer>,
  ): Promise<PushDeviceFailure | null> => {
    let res: Response;
    try {
      const keys = await deps.store.vapid();
      const body = await encryptPushPayload(payload, device);
      res = await deps.fetch(device.endpoint, {
        method: "POST",
        headers: {
          TTL: String(TTL_SECONDS),
          Urgency: "high",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          Authorization: await vapidAuthorization(
            device.endpoint,
            keys,
            subject(),
            deps.now(),
          ),
        },
        body,
        // An endpoint never redirects; following one would send to a host
        // nobody checked.
        redirect: "error",
        signal: AbortSignal.timeout(WEB_PUSH_SEND_TIMEOUT_MS),
      });
    } catch {
      return "unreachable";
    }
    await discard(res);
    if (res.ok) return null;
    if ([401, 403, 404, 410].includes(res.status)) return "gone";
    return res.status >= 500 ? "unreachable" : "rejected";
  };

  // Send to one device and keep its record current.
  const deliver = async (
    device: PushDeviceRecord,
    payload: Uint8Array<ArrayBuffer>,
  ): Promise<PushDeviceFailure | null> => {
    const failure = await sendTo(device, payload);
    try {
      if (failure === "gone") deps.store.drop(device.id);
      else deps.store.setFailure(device.id, failure);
    } catch {
      log("cannot record a push result");
    }
    if (failure) log(`device ${device.id}: send failed: ${failure}`);
    return failure;
  };

  const sendPage = async (entry: PagerEntry, kind: MessageKind) => {
    const userId = entry.targetUserId;
    // A gone member has no settings; a page ignores the room filter.
    if (deps.notifRooms(userId) === null) return;
    const devices = deps.store.list(userId);
    if (devices.length === 0) return;
    const payload = encodePayload(
      buildPagePayload(entry, kind, {
        t: deps.translator(userId),
        roomName:
          entry.source.roomId === null
            ? null
            : deps.roomName(entry.source.roomId),
      }),
    );
    await Promise.all(devices.map((d) => deliver(d, payload)));
  };

  const track = (work: Promise<void>) => {
    const run: Promise<void> = work
      .catch(() => log("a send failed unexpectedly"))
      .finally(() => inflight.delete(run));
    inflight.add(run);
  };

  const send = (entry: PagerEntry, kind: MessageKind) => {
    track(sendPage(entry, kind));
  };

  const turnEndOn = (userId: string, roomId: string): boolean => {
    try {
      return deps.pushRooms(userId)?.includes(roomId) === true;
    } catch {
      log("cannot read the turn-end setting");
      return false;
    }
  };

  const sendTurnEnd = async (
    userId: string,
    agent: { id: string; name: string },
    roomId: string,
  ) => {
    const devices = deps.store.list(userId);
    if (devices.length === 0) return;
    const payload = encodePayload({
      title: deps.translator(userId)("push.turnEnd.title", {
        agent: agent.name,
      }),
      body: deps.roomName(roomId) ?? "",
      tag: `turn-end:${agent.id}`,
      url: "/",
      renotify: true,
    });
    await Promise.all(devices.map((d) => deliver(d, payload)));
  };

  const clearTimer = (pageId: string) => {
    if (!timers.has(pageId)) return;
    deps.scheduler.clearTimeout(timers.get(pageId));
    timers.delete(pageId);
  };

  const schedule = (fn: () => void, ms: number): Handle => {
    const handle = deps.scheduler.setTimeout(
      fn,
      Math.min(Math.max(0, ms), TIMER_STEP_MAX_MS),
    );
    (handle as { unref?: () => void } | null)?.unref?.();
    return handle;
  };

  const repeatMinutes = (userId: string): number | null => {
    try {
      return deps.repeatMinutes(userId);
    } catch {
      log("cannot read the repeat interval");
      return null;
    }
  };

  // Arm the next repeat of an open page, one interval after `from`.
  const arm = (entry: PagerEntry, from: number) => {
    clearTimer(entry.id);
    lastPushAt.set(entry.id, from);
    if (stopped || entry.state !== "open") return;
    const minutes = repeatMinutes(entry.targetUserId);
    if (minutes === null) return;
    const due = from + minutes * 60_000;
    const fire = () => {
      timers.delete(entry.id);
      if (deps.now() < due) {
        timers.set(entry.id, schedule(fire, due - deps.now()));
        return;
      }
      guard(() => {
        const current = deps.pages.get(entry.id);
        if (!current || current.state !== "open") {
          lastPushAt.delete(entry.id);
          return;
        }
        send(current, "repeat");
        arm(current, deps.now());
      });
    };
    timers.set(entry.id, schedule(fire, due - deps.now()));
  };

  return {
    onRaised(entry, kind) {
      guard(() => {
        if (stopped || kind !== "created") return;
        send(entry, "page");
        arm(entry, deps.now());
      });
    },

    onTurnEnd(agent) {
      guard(() => {
        const roomId = agent.roomId;
        if (stopped || roomId === null) return;
        if (deps.isLobby(roomId)) return;
        const audience = deps.roomAudience(roomId);
        for (const userId of agent.memberIds) {
          if (!audience.includes(userId) || !turnEndOn(userId, roomId))
            continue;
          track(sendTurnEnd(userId, agent, roomId));
        }
      });
    },

    onTransitioned(entry, to) {
      guard(() => {
        clearTimer(entry.id);
        lastPushAt.delete(entry.id);
        if (!stopped && to === "resolved") send(entry, "resolved");
      });
    },

    start() {
      guard(() => {
        const at = deps.now();
        for (const entry of deps.pages.list()) {
          if (entry.state === "open") arm(entry, at);
        }
      });
    },

    rescheduleMember(userId) {
      guard(() => {
        for (const entry of deps.pages.list()) {
          if (entry.state !== "open" || entry.targetUserId !== userId) continue;
          arm(entry, lastPushAt.get(entry.id) ?? deps.now());
        }
      });
    },

    async sendTest(userId, deviceId) {
      const device = deps.store.get(deviceId);
      if (!device || device.userId !== userId) return null;
      if (stopped) return { delivered: false, failure: "unreachable" };
      const payload = encodePayload({
        title: deps.translator(userId)("push.test"),
        body: "",
        url: "/",
        renotify: true,
      });
      const failure = await deliver(device, payload);
      return failure ? { delivered: false, failure } : { delivered: true };
    },

    async flush() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },

    stop() {
      stopped = true;
      for (const id of [...timers.keys()]) clearTimer(id);
      lastPushAt.clear();
    },
  };
}
