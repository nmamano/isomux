// Pager delivery: sends pages to the target member's Discord through an
// incoming webhook, repeats an open page, and sends one "resolved" message
// (internal-docs/pager-design.md, "Delivery: Discord").
//
// Shape:
//   - The store hands over new pages (onRaised) and acks / resolves
//     (onTransitioned). A re-raise sends nothing at once: the next repeat
//     carries the new title and body. A resolve always owes one "resolved"
//     message; the store marks it pending in the resolve's own commit.
//   - One timer per open page, due at delivery.lastAttemptAt + the member's
//     repeat interval. start() arms them on boot from the saved
//     lastAttemptAt and re-queues pending "resolved" messages, so a restart
//     resumes the schedule.
//   - One send queue per member: all of a member's pages go to one webhook.
//     One send in flight at a time, at least PAGER_SEND_SPACING_MS apart, so
//     a boot with many overdue pages paces its catch-up. A 429 holds the
//     queue until Discord's retry_after; the hold is saved with the member's
//     settings, so a restart, a settings save and a test send wait too.
//   - Each job re-reads the page and the member's settings when it runs: an
//     ack or a resolve that landed while it waited cancels it.
//   - Every attempt lands on the page record: the state, the number of
//     successful sends, the time, and a failure class. Never the URL or the
//     response body. Log lines are fixed text: an error from fetch, the
//     settings store or the page store may quote the URL or a file, so no
//     error message is logged here, and no error leaves this module for the
//     store's hand-off wrapper to log.
//
// LEAF: the store, the settings, the translator, fetch, the clock and the
// timers are injected.

import type {
  PagerDelivery as PagerDeliveryRecord,
  PagerDeliveryFailure,
  PagerEntry,
} from "../shared/types.ts";
import type { PagerTestRes } from "../shared/contract-shapes.ts";
import type { Translator } from "../shared/i18n/translate.ts";
import type { PagerStore } from "./pager-store.ts";
import type { PagerMemberSettings } from "./pager-settings.ts";

export const PAGER_SEND_TIMEOUT_MS = 10_000;
// The least time between two sends to one member's webhook. Discord allows a
// few requests per second per webhook; this keeps a catch-up well under it.
export const PAGER_SEND_SPACING_MS = 2_000;
// A 429 without a readable retry_after.
const RETRY_AFTER_DEFAULT_MS = 5_000;
// setTimeout overflows above 2^31-1 ms; a longer wait re-arms in steps.
const TIMER_STEP_MAX_MS = 24 * 60 * 60_000;
// Discord's limit for the plain-text part of a message.
const DISCORD_CONTENT_MAX = 2000;
const EMBED_FOOTER_MAX = 2048;

type Handle = unknown;

export interface PagerDeliveryDeps {
  store: Pick<PagerStore, "list" | "get" | "recordDelivery">;
  // The target member's settings. May throw when the settings store is
  // unavailable; the send is then skipped.
  settings: (userId: string) => PagerMemberSettings;
  // Save the member's 429 hold. May throw.
  setHoldUntil: (userId: string, at: number) => void;
  // The member's language (server/i18n.ts translatorForUserId).
  translator: (userId: string) => Translator["t"];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  // Method syntax on purpose: the real setTimeout / clearTimeout pair is
  // overloaded, and only a method type accepts it.
  scheduler: {
    setTimeout(fn: () => void, ms: number): Handle;
    clearTimeout(handle: Handle): void;
  };
  // The office origin for the link back to the page.
  officeOrigin: () => string;
  // Live room name, or null when the room is gone.
  roomName: (roomId: string) => string | null;
}

export interface PagerDeliveryService {
  onRaised(entry: PagerEntry, kind: "created" | "reraised"): void;
  onTransitioned(entry: PagerEntry, to: "acked" | "resolved"): void;
  // Boot: arm the repeat of every open page from its saved lastAttemptAt and
  // queue every pending "resolved" message.
  start(): void;
  // The member changed their settings: re-arm their open pages.
  rescheduleMember(userId: string): void;
  // Throws when the settings store is unavailable.
  sendTest(userId: string): Promise<PagerTestRes>;
  // Drop every timer and queued job (tests, shutdown).
  stop(): void;
}

// The link from Discord back to the page. The pager view (P4) reads the
// `pager` query parameter and opens with that page selected.
export function pagerLink(origin: string, pageId: string): string {
  return `${origin}/?pager=${encodeURIComponent(pageId)}`;
}

type MessageKind = "page" | "repeat" | "resolved";

interface DiscordMessage {
  content: string;
  allowed_mentions: { parse: []; users?: string[] };
  embeds?: Array<{
    title: string;
    url: string;
    description?: string;
    footer?: { text: string };
  }>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// allowed_mentions names only the member: no @everyone, @here or role ping,
// whatever the title or body holds.
function mentions(discordUserId: string | undefined) {
  return discordUserId
    ? { parse: [] as [], users: [discordUserId] }
    : { parse: [] as [] };
}

// The text around the title is the member's language; the title, the body
// and the names are as the source wrote them.
export function buildPageMessage(
  entry: PagerEntry,
  kind: MessageKind,
  ctx: {
    t: Translator["t"];
    discordUserId?: string;
    origin: string;
    roomName: string | null;
  },
): DiscordMessage {
  const ping = ctx.discordUserId ? `<@${ctx.discordUserId}> ` : "";
  const title = entry.title;
  const content =
    kind === "page"
      ? `${ping}${title}`
      : kind === "repeat"
        ? `${ping}${ctx.t("pager.discord.stillOpen", { title })}`
        : ctx.t("pager.discord.resolved", { title });
  const footer = clip(
    `${ctx.roomName ?? entry.source.roomId} · ${entry.source.name}`,
    EMBED_FOOTER_MAX,
  );
  return {
    content: clip(content, DISCORD_CONTENT_MAX),
    // The resolved message pings nobody.
    allowed_mentions:
      kind === "resolved" ? { parse: [] } : mentions(ctx.discordUserId),
    embeds: [
      {
        title,
        url: pagerLink(ctx.origin, entry.id),
        ...(kind !== "resolved" && entry.body
          ? { description: entry.body }
          : {}),
        footer: { text: footer },
      },
    ],
  };
}

export function buildTestMessage(
  t: Translator["t"],
  discordUserId?: string,
): DiscordMessage {
  const ping = discordUserId ? `<@${discordUserId}> ` : "";
  return {
    content: `${ping}${t("pager.discord.test")}`,
    allowed_mentions: mentions(discordUserId),
  };
}

type SendResult =
  | { ok: true }
  | { ok: false; failure: "rate_limited"; retryAfterMs: number }
  | {
      ok: false;
      failure: Exclude<PagerDeliveryFailure, "rate_limited" | "no_webhook">;
      status?: number;
    };

// Discord sends retry_after in seconds (a float) in the JSON body; the
// Retry-After header is the fallback. The wait is honored in full: sending
// before it ends only earns another 429.
async function retryAfterMs(res: Response): Promise<number> {
  let seconds: number | null = null;
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    if (typeof body?.retry_after === "number") seconds = body.retry_after;
  } catch {
    // Not JSON: fall back to the header.
  }
  if (seconds === null && res.headers.has("retry-after")) {
    seconds = Number(res.headers.get("retry-after"));
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return RETRY_AFTER_DEFAULT_MS;
  }
  return Math.ceil(seconds * 1000);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to do: the body is never read.
  }
}

async function post(
  doFetch: PagerDeliveryDeps["fetch"],
  url: string,
  message: DiscordMessage,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      // A webhook URL never redirects; following one would send the page
      // to a host nobody checked. A redirect is a network failure.
      redirect: "error",
      signal: AbortSignal.timeout(PAGER_SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: "network" };
  }
  if (res.ok) {
    await discard(res);
    return { ok: true };
  }
  if (res.status === 429) {
    return {
      ok: false,
      failure: "rate_limited",
      retryAfterMs: await retryAfterMs(res),
    };
  }
  await discard(res);
  return {
    ok: false,
    failure: res.status >= 500 ? "http_5xx" : "http_4xx",
    status: res.status,
  };
}

type Job =
  | { kind: "page" | "resolved"; pageId: string }
  | { kind: "test"; done: (result: PagerTestRes) => void };

interface MemberQueue {
  jobs: Job[];
  // The job being sent, if any.
  running: Job | null;
  // When the last request to the webhook ended (0: none since boot).
  lastSentAt: number;
  // The 429 hold, kept here too in case saving it to the settings failed.
  holdUntil: number;
  // The timer that resumes the queue after a wait.
  wakeTimer: { handle: Handle } | null;
}

const samePage = (job: Job, pageId: string): boolean =>
  job.kind !== "test" && job.pageId === pageId;

export function createPagerDelivery(
  deps: PagerDeliveryDeps,
): PagerDeliveryService {
  const timers = new Map<string, Handle>();
  const queues = new Map<string, MemberQueue>();
  let stopped = false;

  // Fixed text only (see the header).
  const log = (what: string) => console.error(`[pager] ${what}`);

  const schedule = (fn: () => void, ms: number): Handle => {
    const handle = deps.scheduler.setTimeout(
      fn,
      Math.min(Math.max(0, ms), TIMER_STEP_MAX_MS),
    );
    // Never hold the process open for a repeat.
    (handle as { unref?: () => void } | null)?.unref?.();
    return handle;
  };

  const clearTimer = (pageId: string) => {
    if (!timers.has(pageId)) return;
    deps.scheduler.clearTimeout(timers.get(pageId));
    timers.delete(pageId);
  };

  const settingsFor = (userId: string): PagerMemberSettings | null => {
    try {
      return deps.settings(userId);
    } catch {
      log("cannot read the pager settings");
      return null;
    }
  };

  const getPage = (pageId: string): PagerEntry | null => {
    try {
      return deps.store.get(pageId);
    } catch {
      log(`page ${pageId}: cannot read the page`);
      return null;
    }
  };

  const record = (pageId: string, next: PagerDeliveryRecord) => {
    try {
      deps.store.recordDelivery(pageId, next);
    } catch {
      log(`page ${pageId}: cannot record the delivery`);
    }
  };

  const queueFor = (userId: string): MemberQueue => {
    let q = queues.get(userId);
    if (!q) {
      q = {
        jobs: [],
        running: null,
        lastSentAt: 0,
        holdUntil: 0,
        wakeTimer: null,
      };
      queues.set(userId, q);
    }
    return q;
  };

  const enqueue = (userId: string, job: Job, front = false) => {
    if (stopped) return;
    const q = queueFor(userId);
    if (
      job.kind !== "test" &&
      q.jobs.some((j) => j.kind === job.kind && samePage(j, job.pageId))
    ) {
      return;
    }
    if (front) q.jobs.unshift(job);
    else q.jobs.push(job);
    void pump(userId);
  };

  // The earliest time the next request may go to this member's webhook.
  const nextAllowedAt = (q: MemberQueue, s: PagerMemberSettings | null) =>
    Math.max(
      q.lastSentAt > 0 ? q.lastSentAt + PAGER_SEND_SPACING_MS : 0,
      q.holdUntil,
      s?.holdUntil ?? 0,
    );

  const hold = (userId: string, q: MemberQueue, ms: number) => {
    const until = deps.now() + ms;
    q.holdUntil = Math.max(q.holdUntil, until);
    try {
      deps.setHoldUntil(userId, until);
    } catch {
      log("cannot save the rate-limit wait");
    }
  };

  // Arm the repeat of one open page at lastAttemptAt + interval. A page that
  // was never attempted is due now. With "never", only a page that was never
  // attempted is sent. A member with no webhook gets no repeats: a settings
  // save re-arms their pages (rescheduleMember). `attemptedAt` is the attempt
  // just made: it counts even when recording it failed, so a store that
  // cannot save never turns the repeat into a retry loop.
  const arm = (entry: PagerEntry, attemptedAt?: number) => {
    clearTimer(entry.id);
    if (stopped || entry.state !== "open") return;
    const userId = entry.targetUserId;
    const saved = entry.delivery.lastAttemptAt;
    const last =
      attemptedAt === undefined
        ? saved
        : Math.max(saved ?? attemptedAt, attemptedAt);
    // The first delivery is owed, whatever the repeat setting, until it goes
    // out: a page never attempted, or (on boot or a settings save) one whose
    // first attempt hit a 429. pump holds it until the saved 429 wait ends.
    const owedFirst =
      entry.delivery.sends === 0 &&
      (last === undefined ||
        (attemptedAt === undefined &&
          entry.delivery.lastFailure === "rate_limited"));
    if (owedFirst) {
      enqueue(userId, { kind: "page", pageId: entry.id });
      return;
    }
    if (last === undefined) return;
    const settings = settingsFor(userId);
    if (!settings?.webhookUrl || settings.repeatMinutes === null) return;
    const due = last + settings.repeatMinutes * 60_000;
    const fire = () => {
      timers.delete(entry.id);
      if (deps.now() < due) {
        timers.set(entry.id, schedule(fire, due - deps.now()));
        return;
      }
      enqueue(userId, { kind: "page", pageId: entry.id });
    };
    timers.set(entry.id, schedule(fire, due - deps.now()));
  };

  const failed = (
    d: PagerDeliveryRecord,
    at: number,
    failure: PagerDeliveryFailure,
  ): PagerDeliveryRecord => ({
    ...d,
    state: d.sends > 0 ? "failed" : "not_delivered",
    lastAttemptAt: at,
    lastFailure: failure,
  });

  // One page or resolved send. Returns true when Discord rate-limited it, so
  // the queue puts the job back.
  const runPageJob = async (
    job: { kind: "page" | "resolved"; pageId: string },
    q: MemberQueue,
  ): Promise<boolean> => {
    const entry = getPage(job.pageId);
    if (!entry) return false;
    if (job.kind === "page" && entry.state !== "open") return false;
    if (
      job.kind === "resolved" &&
      (entry.state !== "resolved" ||
        entry.delivery.resolvedNotice !== "pending")
    ) {
      return false;
    }
    const userId = entry.targetUserId;
    const settings = settingsFor(userId);
    // A pending resolved message stays pending and is retried after a restart.
    if (!settings) return false;
    // A repeat (the member already got the page) is re-checked against the
    // CURRENT settings: the member may have chosen "never" or a longer
    // interval while it waited in the queue.
    if (job.kind === "page" && entry.delivery.sends > 0) {
      if (settings.repeatMinutes === null) return false;
      const due =
        (entry.delivery.lastAttemptAt ?? 0) + settings.repeatMinutes * 60_000;
      if (deps.now() < due) {
        arm(entry);
        return false;
      }
    }
    const at = deps.now();
    const notice =
      job.kind === "resolved" ? { resolvedNotice: "done" as const } : {};
    if (!settings.webhookUrl) {
      record(entry.id, {
        ...failed(entry.delivery, at, "no_webhook"),
        ...notice,
      });
    } else {
      const kind: MessageKind =
        job.kind === "resolved"
          ? "resolved"
          : entry.delivery.sends > 0
            ? "repeat"
            : "page";
      const message = buildPageMessage(entry, kind, {
        t: deps.translator(userId),
        discordUserId: settings.discordUserId,
        origin: deps.officeOrigin(),
        roomName: deps.roomName(entry.source.roomId),
      });
      const result = await post(deps.fetch, settings.webhookUrl, message);
      q.lastSentAt = deps.now();
      // Write over the LATEST record: a resolve during the send marked a
      // resolved message pending, and that mark must survive this write.
      const latest = getPage(entry.id)?.delivery ?? entry.delivery;
      if (result.ok) {
        const next: PagerDeliveryRecord = {
          ...latest,
          state: "delivered",
          sends: latest.sends + 1,
          lastAttemptAt: at,
          ...notice,
        };
        delete next.lastFailure;
        record(entry.id, next);
      } else if (result.failure === "rate_limited") {
        record(entry.id, failed(latest, at, "rate_limited"));
        log(`page ${entry.id}: send failed: rate_limited`);
        hold(userId, q, result.retryAfterMs);
        return true;
      } else {
        record(entry.id, { ...failed(latest, at, result.failure), ...notice });
        log(
          `page ${entry.id}: send failed: ${result.failure}` +
            (result.status ? ` (HTTP ${result.status})` : ""),
        );
      }
    }
    if (job.kind === "page") {
      const after = getPage(entry.id);
      if (after) arm(after, at);
    }
    return false;
  };

  const runTestJob = async (
    userId: string,
    q: MemberQueue,
  ): Promise<PagerTestRes> => {
    const settings = settingsFor(userId);
    if (!settings) return { delivered: false, failure: "network" };
    if (!settings.webhookUrl) {
      return { delivered: false, failure: "no_webhook" };
    }
    const result = await post(
      deps.fetch,
      settings.webhookUrl,
      buildTestMessage(deps.translator(userId), settings.discordUserId),
    );
    q.lastSentAt = deps.now();
    if (result.ok) return { delivered: true };
    if (result.failure === "rate_limited") {
      hold(userId, q, result.retryAfterMs);
    }
    return { delivered: false, failure: result.failure };
  };

  const pump = async (userId: string): Promise<void> => {
    const q = queues.get(userId);
    if (!q || q.running || stopped) return;
    if (q.jobs.length === 0) {
      // Keep the queue while it still remembers a spacing or a hold.
      if (q.wakeTimer === null && nextAllowedAt(q, null) <= deps.now()) {
        queues.delete(userId);
      }
      return;
    }
    // Pacing and the 429 hold apply to requests only; with no webhook a job
    // only records no_webhook, so it does not wait.
    const settings = settingsFor(userId);
    const wait = settings?.webhookUrl
      ? nextAllowedAt(q, settings) - deps.now()
      : 0;
    if (wait > 0) {
      if (q.wakeTimer === null) {
        q.wakeTimer = {
          handle: schedule(() => {
            q.wakeTimer = null;
            void pump(userId);
          }, wait),
        };
      }
      return;
    }
    const job = q.jobs.shift()!;
    q.running = job;
    try {
      if (job.kind === "test") {
        job.done(await runTestJob(userId, q));
      } else if (await runPageJob(job, q)) {
        q.jobs.unshift(job);
      }
    } catch {
      log("a send failed unexpectedly");
      if (job.kind === "test") {
        job.done({ delivered: false, failure: "network" });
      }
    } finally {
      q.running = null;
    }
    await pump(userId);
  };

  const pages = (filter: (e: PagerEntry) => boolean): PagerEntry[] => {
    try {
      return deps.store.list().filter(filter);
    } catch {
      log("cannot list pages");
      return [];
    }
  };

  // The store's hand-off wrappers log what a listener throws; nothing here
  // throws into them.
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      log("a delivery hand-off failed");
    }
  };

  return {
    onRaised(entry, kind) {
      guard(() => {
        if (kind === "created") {
          enqueue(entry.targetUserId, { kind: "page", pageId: entry.id });
        }
      });
    },

    onTransitioned(entry, to) {
      guard(() => {
        clearTimer(entry.id);
        const q = queues.get(entry.targetUserId);
        if (q) q.jobs = q.jobs.filter((j) => !samePage(j, entry.id));
        if (to === "resolved") {
          enqueue(entry.targetUserId, { kind: "resolved", pageId: entry.id });
        }
      });
    },

    start() {
      guard(() => {
        for (const entry of pages((e) => e.state === "open")) arm(entry);
        const owed = pages(
          (e) =>
            e.state === "resolved" && e.delivery.resolvedNotice === "pending",
        );
        for (const entry of owed) {
          enqueue(entry.targetUserId, { kind: "resolved", pageId: entry.id });
        }
      });
    },

    // A page the member never received goes out now (they may have just
    // added or fixed the webhook); the others keep their schedule under the
    // new interval.
    rescheduleMember(userId) {
      guard(() => {
        const open = pages(
          (e) => e.state === "open" && e.targetUserId === userId,
        );
        for (const entry of open) {
          // A page already waiting in the queue or being sent keeps its place.
          const q = queues.get(userId);
          if (
            (q?.running && samePage(q.running, entry.id)) ||
            q?.jobs.some((j) => samePage(j, entry.id))
          ) {
            continue;
          }
          if (entry.delivery.sends === 0) {
            clearTimer(entry.id);
            enqueue(userId, { kind: "page", pageId: entry.id });
          } else {
            arm(entry);
          }
        }
      });
    },

    // Goes to the front of the member's queue, so it obeys the spacing and
    // the 429 hold like every other send. Under a hold it answers
    // rate_limited at once instead of waiting.
    async sendTest(userId) {
      const settings = deps.settings(userId);
      if (!settings.webhookUrl) {
        return { delivered: false, failure: "no_webhook" };
      }
      const q = queues.get(userId);
      const heldUntil = Math.max(q?.holdUntil ?? 0, settings.holdUntil ?? 0);
      if (stopped) return { delivered: false, failure: "network" };
      if (heldUntil > deps.now()) {
        return { delivered: false, failure: "rate_limited" };
      }
      return new Promise<PagerTestRes>((done) => {
        enqueue(userId, { kind: "test", done }, true);
      });
    },

    stop() {
      stopped = true;
      for (const id of [...timers.keys()]) clearTimer(id);
      for (const q of queues.values()) {
        if (q.wakeTimer !== null) {
          deps.scheduler.clearTimeout(q.wakeTimer.handle);
        }
        q.wakeTimer = null;
        for (const j of q.jobs) {
          if (j.kind === "test") {
            j.done({ delivered: false, failure: "network" });
          }
        }
        q.jobs = [];
      }
    },
  };
}
