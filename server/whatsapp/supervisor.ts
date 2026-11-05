// One WhatsApp bridge child per linked member (task d03a61d8). The supervisor
// starts the children, follows their events, restarts them with a backoff,
// and keeps each member's status for the Integrations card.
//
// Disconnects (statusCode of a `closed` event, protocol.ts DISCONNECT):
//   restartRequired - normal right after pairing: restart at once, no failure
//   loggedOut       - the phone removed the device: directory deleted, status
//                     unlinked (unlinked_by_phone), one page
//   connectionReplaced - another client uses the same session: dead
//                     (replaced), no restart, one page
//   timedOut while linking - nobody scanned: unlinked (link_expired), no page
//   anything else, or an exit - a failure: restart with a backoff; after
//                     WHATSAPP_MAX_FAILURES within WHATSAPP_FAILURE_WINDOW_MS,
//                     dead (crash_loop), one page. It keeps restarting the
//                     same session every WHATSAPP_BACKOFF_MAX_MS with no new
//                     page, so an outage never forces a new phone scan; an
//                     `open` heals it.
// A child above WHATSAPP_RSS_LIMIT is killed, which counts as a failure.
//
// It runs from timers and child exits in the office server, where a throw
// ends the server: a failed spawn counts as a failure, and a failed page or
// file removal is logged.

import {
  normaliseWhatsAppPhone,
  type WhatsAppLinkReq,
  type WhatsAppReason,
  type WhatsAppChatSeen,
  type WhatsAppStatus,
} from "../../shared/whatsapp.ts";
import {
  DISCONNECT,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeMessage,
} from "./protocol.ts";
import type { BridgeInstaller } from "./installer.ts";
import {
  ensureMemberDir,
  listMemberDirs,
  listMemberFiles,
  readLink,
  removeMemberDir,
  removeSession,
  writeLink,
  type WhatsAppLink,
} from "./store.ts";

export const WHATSAPP_RSS_LIMIT = 512 * 1024 * 1024;
export const WHATSAPP_RSS_SAMPLE_MS = 30_000;
export const WHATSAPP_MAX_FAILURES = 6;
export const WHATSAPP_FAILURE_WINDOW_MS = 30 * 60_000;
export const WHATSAPP_BACKOFF_FIRST_MS = 1_000;
export const WHATSAPP_BACKOFF_MAX_MS = 5 * 60_000;
export const WHATSAPP_PAIRING_COOLDOWN_MS = 60_000;
export const WHATSAPP_LOGOUT_WAIT_MS = 5_000;

export interface BridgeChild {
  readonly pid: number;
  send(cmd: BridgeCommand): void;
  kill(): void;
  onEvent(listener: (event: BridgeEvent) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

// What the supervisor asks the spawner to start. The env is minimal (PATH,
// HOME, TZ, LANG): the child runs third-party code and gets no office token,
// provider key or office variable.
export interface BridgeSpawnSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type BridgeSpawner = (spec: BridgeSpawnSpec) => BridgeChild;

export interface WhatsAppClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// A page to the member. The key is stable per (member, condition), so the
// pager store keeps one open page per condition.
export interface WhatsAppPager {
  raise(userId: string, key: string, title: string, body: string): void;
}

export interface WhatsAppSupervisorDeps {
  stateRoot: string;
  // The bridge entry (server/whatsapp/bridge.ts) and the runtime that runs it.
  bridgeEntry: string;
  bunPath: string;
  // The server's environment; the child gets only its allowed keys.
  baseEnv: Record<string, string | undefined>;
  spawner: BridgeSpawner;
  installer: BridgeInstaller;
  clock: WhatsAppClock;
  // Resident memory of a process in bytes, null when unknown.
  readRss(pid: number): number | null;
  pager: WhatsAppPager;
  renderQr(code: string): string;
  emitStatus(userId: string, status: WhatsAppStatus): void;
  // Slice 2: the contact rows and the inbound path. Absent, the bridge gets
  // an empty allowlist and messages go nowhere.
  hooks?: WhatsAppHooks;
}

// The cap of the chats-seen list per member (the Add picker).
export const WHATSAPP_CHATS_SEEN_MAX = 500;

export interface WhatsAppHooks {
  // The routed chats. Sent as the FIRST command at each spawn, before link,
  // so a linked bridge never connects without its allowlist.
  allowlist(userId: string): string[];
  onMessage(userId: string, msg: BridgeMessage): void;
  // A link was accepted with this phone.
  onLinked(userId: string, phone: string): void;
  // The link is gone (unlink, member removal, the phone unlinked it).
  onUnlinked(userId: string): void;
  // The office stops, before the children are stopped.
  onShutdown(): void;
}

// How long a send waits for the bridge's answer.
export const WHATSAPP_SEND_TIMEOUT_MS = 15_000;

// A send: the message id, or why there is none. "unknown": no answer in
// WHATSAPP_SEND_TIMEOUT_MS, so the message may have gone out.
export type WhatsAppSendResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_linked" | "failed" | "unknown" };

export type WhatsAppLinkResult =
  | { ok: true; status: WhatsAppStatus }
  | { ok: false; status: 400 | 409 | 429; error: string };

export interface WhatsAppSupervisor {
  // Sweeps member directories without link.json (a restart in the middle of a
  // link), then starts a child for each linked member.
  boot(): Promise<void>;
  status(userId: string): WhatsAppStatus;
  link(userId: string, req: WhatsAppLinkReq): Promise<WhatsAppLinkResult>;
  // Logs the device out (best effort, WHATSAPP_LOGOUT_WAIT_MS), stops the
  // child and deletes the member's directory. Also cancels a link in progress.
  unlink(userId: string): Promise<void>;
  // The member was deleted: the same as unlink.
  removeMember(userId: string): Promise<void>;
  shutdown(): Promise<void>;
  // Sends the member's current allowlist to their live bridge.
  setRoutes(userId: string): void;
  // The chats seen since the link (cleared on unlink), at most
  // WHATSAPP_CHATS_SEEN_MAX: newest message first, then the chats with no
  // message in the order seen.
  chatsSeen(userId: string): WhatsAppChatSeen[];
  // Sends text to a chat through the member's open bridge (slice 2b).
  send(
    userId: string,
    req: { requestId: string; chat: string; text: string },
  ): Promise<WhatsAppSendResult>;
}

// The only environment keys a bridge child gets.
const CHILD_ENV_KEYS = ["PATH", "HOME", "TZ", "LANG"] as const;

const INTEGRATIONS_HINT =
  "To link WhatsApp again, open Integrations › Messaging.";

interface ChildRecord {
  child: BridgeChild;
  // The status code of the child's `closed` event; undefined when it exited
  // without one (a crash or a kill).
  closeCode: number | null | undefined;
  exited: boolean;
  exitWaiters: (() => void)[];
  rssTimer: unknown;
  // The sends waiting for this child's answer, by request id.
  sends: Map<string, PendingSend>;
}

interface PendingSend {
  promise: Promise<WhatsAppSendResult>;
  settle(result: WhatsAppSendResult): void;
}

interface MemberRecord {
  userId: string;
  status: WhatsAppStatus;
  // The accepted link, kept while dead so a healed session shows it again.
  link: WhatsAppLink | null;
  child: ChildRecord | null;
  restartTimer: unknown;
  // Failure times within WHATSAPP_FAILURE_WINDOW_MS.
  failures: number[];
  lastCodeAt: number | null;
  // An unlink or a shutdown is ending the child: its exit is not a failure.
  stopping: boolean;
  // Bumped by unlink and shutdown, so a link waiting on the download stops.
  gen: number;
}

// The chat with the oldest time (the first on a tie).
function oldest(times: Iterable<[string, number]>): string | undefined {
  let pick: [string, number] | undefined;
  for (const t of times) if (!pick || t[1] < pick[1]) pick = t;
  return pick?.[0];
}

// The chat to drop from the chats seen at the cap: the first seen with no
// message. There is always one: the times are capped at the same max.
function leastRecent(
  seen: Map<string, WhatsAppChatSeen>,
  times: Map<string, number> = new Map(),
): string | undefined {
  for (const chat of seen.keys()) if (!times.has(chat)) return chat;
}

export function createWhatsAppSupervisor(
  deps: WhatsAppSupervisorDeps,
): WhatsAppSupervisor {
  const { clock } = deps;
  const members = new Map<string, MemberRecord>();
  // The chats each member's WhatsApp saw since the link (memory only).
  const chats = new Map<string, Map<string, WhatsAppChatSeen>>();
  // The time of each chat's newest message since the link, for the Add
  // picker's order (memory only). A time can come before the chat's name.
  const lastAt = new Map<string, Map<string, number>>();
  let runtimeDir: string | null = null;
  let shuttingDown = false;

  function memberOf(userId: string): MemberRecord {
    let m = members.get(userId);
    if (!m) {
      m = {
        userId,
        status: { state: "unlinked" },
        link: null,
        child: null,
        restartTimer: null,
        failures: [],
        lastCodeAt: null,
        stopping: false,
        gen: 0,
      };
      members.set(userId, m);
    }
    return m;
  }

  function setStatus(m: MemberRecord, status: WhatsAppStatus): void {
    m.status = status;
    deps.emitStatus(m.userId, status);
  }

  function phoneOf(m: MemberRecord): string | undefined {
    return m.link?.phone;
  }

  // A crash loop that keeps retrying its session.
  function retrying(m: MemberRecord): boolean {
    return m.status.state === "dead" && m.status.reason === "crash_loop";
  }

  function removeDir(userId: string): void {
    try {
      removeMemberDir(deps.stateRoot, userId);
    } catch {
      console.error("[whatsapp] a WhatsApp session directory was not removed");
    }
  }

  // The session goes and the contact rows stay (a link that did not finish,
  // a new link after a dead one). Throws when the session stays.
  function clearSession(userId: string): void {
    removeSession(deps.stateRoot, userId);
    if (listMemberFiles(deps.stateRoot, userId).length === 0)
      removeMemberDir(deps.stateRoot, userId);
  }

  function clearSessionOrLog(userId: string): void {
    try {
      clearSession(userId);
    } catch {
      console.error("[whatsapp] a WhatsApp session directory was not removed");
    }
  }

  // The hooks run in the office server: one that throws is logged.
  function hook(name: string, run: (hooks: WhatsAppHooks) => void): void {
    if (!deps.hooks) return;
    try {
      run(deps.hooks);
    } catch {
      console.error(`[whatsapp] the WhatsApp ${name} hook failed`);
    }
  }

  function unlinked(m: MemberRecord): void {
    chats.delete(m.userId);
    lastAt.delete(m.userId);
    hook("unlink", (h) => h.onUnlinked(m.userId));
  }

  function page(
    m: MemberRecord,
    condition: "dead" | "unlinked-by-phone",
    title: string,
    body: string,
  ): void {
    try {
      deps.pager.raise(
        m.userId,
        `whatsapp:${m.userId}:${condition}`,
        title,
        body,
      );
    } catch {
      console.error("[whatsapp] a WhatsApp page was not raised");
    }
  }

  function die(m: MemberRecord, reason: WhatsAppReason, body: string): void {
    const phone = phoneOf(m);
    setStatus(m, { state: "dead", reason, ...(phone ? { phone } : {}) });
    page(m, "dead", "WhatsApp stopped", `${body} ${INTEGRATIONS_HINT}`);
    if (reason === "crash_loop") spawnAfter(m, WHATSAPP_BACKOFF_MAX_MS);
  }

  function childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of CHILD_ENV_KEYS) {
      const value = deps.baseEnv[key];
      if (typeof value === "string") env[key] = value;
    }
    return env;
  }

  function cancelRestart(m: MemberRecord): void {
    if (m.restartTimer === null) return;
    clock.clearTimeout(m.restartTimer);
    m.restartTimer = null;
  }

  function sampleRss(rec: ChildRecord): void {
    rec.rssTimer = clock.setTimeout(() => {
      if (rec.exited) return;
      const rss = deps.readRss(rec.child.pid);
      if (rss !== null && rss > WHATSAPP_RSS_LIMIT) {
        console.warn("[whatsapp] a bridge went over its memory limit");
        rec.child.kill();
        return;
      }
      sampleRss(rec);
    }, WHATSAPP_RSS_SAMPLE_MS);
  }

  function spawn(m: MemberRecord): ChildRecord {
    if (runtimeDir === null) throw new Error("the WhatsApp package is missing");
    const dir = ensureMemberDir(deps.stateRoot, m.userId);
    const child = deps.spawner({
      argv: [deps.bunPath, deps.bridgeEntry, dir, runtimeDir],
      cwd: dir,
      env: childEnv(),
    });
    const rec: ChildRecord = {
      child,
      closeCode: undefined,
      exited: false,
      exitWaiters: [],
      rssTimer: null,
      sends: new Map(),
    };
    m.child = rec;
    // The allowlist first: a linked bridge connects only once it has it.
    let allow: string[] = [];
    hook("allowlist", (h) => {
      allow = h.allowlist(m.userId);
    });
    child.send({ op: "routes", chats: allow });
    child.onEvent((event) => {
      if (m.child !== rec || m.stopping) return;
      try {
        onEvent(m, rec, event);
      } catch {
        console.error("[whatsapp] a bridge event failed");
      }
    });
    child.onExit(() => {
      if (rec.exited) return;
      rec.exited = true;
      clock.clearTimeout(rec.rssTimer);
      for (const resolve of rec.exitWaiters.splice(0)) resolve();
      // A send the child took may have gone out before it ended.
      for (const pending of [...rec.sends.values()])
        pending.settle({ ok: false, reason: "unknown" });
      if (m.child !== rec) return;
      m.child = null;
      if (m.stopping || shuttingDown) return;
      try {
        onExit(m, rec);
      } catch {
        console.error("[whatsapp] a bridge exit failed");
      }
    });
    sampleRss(rec);
    return rec;
  }

  function spawnAfter(m: MemberRecord, ms: number): void {
    cancelRestart(m);
    m.restartTimer = clock.setTimeout(() => {
      m.restartTimer = null;
      const state = m.status.state;
      if (
        shuttingDown ||
        m.child ||
        (state !== "linked" && state !== "linking" && !retrying(m))
      )
        return;
      startOrFail(m);
    }, ms);
  }

  // A spawn that throws (the Bun binary moved, a full disk) is a failure.
  function startOrFail(m: MemberRecord): void {
    try {
      spawn(m);
    } catch {
      console.error("[whatsapp] a WhatsApp bridge did not start");
      failure(m);
    }
  }

  function onEvent(
    m: MemberRecord,
    rec: ChildRecord,
    event: BridgeEvent,
  ): void {
    const status = m.status;
    switch (event.ev) {
      case "qr":
        if (status.state === "linking" && status.method === "qr")
          setStatus(m, {
            state: "linking",
            method: "qr",
            qrSvg: deps.renderQr(event.code),
          });
        return;
      case "pairing-code":
        if (status.state === "linking" && status.method === "code")
          setStatus(m, {
            state: "linking",
            method: "code",
            pairingCode: event.code,
          });
        return;
      case "linked": {
        // The bridge repeats it at each connect; only a link in progress
        // saves it.
        if (status.state !== "linking") return;
        const linkedAt = clock.now();
        writeLink(deps.stateRoot, m.userId, { phone: event.phone, linkedAt });
        m.link = { phone: event.phone, linkedAt };
        hook("link", (h) => h.onLinked(m.userId, event.phone));
        setStatus(m, {
          state: "linked",
          phone: event.phone,
          linkedAt,
          connected: false,
        });
        return;
      }
      case "open":
        if (status.state === "linked" && !status.connected)
          setStatus(m, { ...status, connected: true });
        else if (retrying(m) && m.link) {
          m.failures = [];
          setStatus(m, { state: "linked", ...m.link, connected: true });
        }
        return;
      case "closed":
        rec.closeCode = event.statusCode;
        return;
      case "log":
        console.log(`[whatsapp] ${event.text}`);
        return;
      case "chat": {
        // Newest name per chat, the newest chats kept.
        let seen = chats.get(m.userId);
        if (!seen)
          chats.set(m.userId, (seen = new Map<string, WhatsAppChatSeen>()));
        seen.delete(event.chat);
        seen.set(event.chat, {
          chat: event.chat,
          name: event.name,
          group: event.group,
        });
        if (seen.size > WHATSAPP_CHATS_SEEN_MAX)
          seen.delete(leastRecent(seen, lastAt.get(m.userId)) as string);
        return;
      }
      case "activity": {
        let times = lastAt.get(m.userId);
        if (!times) lastAt.set(m.userId, (times = new Map<string, number>()));
        // The newest wins: an older message (offline catch-up) never moves
        // a chat down.
        if ((times.get(event.chat) ?? -Infinity) >= event.at) return;
        times.set(event.chat, event.at);
        if (times.size > WHATSAPP_CHATS_SEEN_MAX)
          times.delete(oldest(times) as string);
        return;
      }
      case "message":
        hook("message", (h) => h.onMessage(m.userId, event));
        return;
      case "sent":
        rec.sends.get(event.requestId)?.settle({ ok: true, id: event.id });
        return;
      case "send-failed":
        rec.sends.get(event.requestId)?.settle({ ok: false, reason: "failed" });
        return;
    }
  }

  function onExit(m: MemberRecord, rec: ChildRecord): void {
    const code = rec.closeCode;
    const status = m.status;
    if (code === DISCONNECT.restartRequired) {
      spawnAfter(m, 0);
      return;
    }
    if (status.state === "linking") {
      // Nobody scanned the QR or typed the code in time, or the link failed.
      clearSessionOrLog(m.userId);
      setStatus(m, { state: "unlinked", reason: "link_expired" });
      return;
    }
    if (status.state !== "linked" && !retrying(m)) return;
    if (code === DISCONNECT.loggedOut) {
      m.link = null;
      removeDir(m.userId);
      unlinked(m);
      setStatus(m, { state: "unlinked", reason: "unlinked_by_phone" });
      page(
        m,
        "unlinked-by-phone",
        "WhatsApp was unlinked",
        `Your phone unlinked Isomux. ${INTEGRATIONS_HINT}`,
      );
      return;
    }
    if (code === DISCONNECT.connectionReplaced) {
      die(m, "replaced", "Another connection took over this WhatsApp link.");
      return;
    }
    failure(m);
  }

  function failure(m: MemberRecord): void {
    if (retrying(m)) {
      spawnAfter(m, WHATSAPP_BACKOFF_MAX_MS);
      return;
    }
    const status = m.status;
    if (status.state === "linking") {
      clearSessionOrLog(m.userId);
      setStatus(m, { state: "unlinked", reason: "link_expired" });
      return;
    }
    if (status.state !== "linked") return;
    if (status.connected) setStatus(m, { ...status, connected: false });
    const now = clock.now();
    m.failures = m.failures.filter(
      (at) => now - at < WHATSAPP_FAILURE_WINDOW_MS,
    );
    m.failures.push(now);
    if (m.failures.length >= WHATSAPP_MAX_FAILURES) {
      die(m, "crash_loop", "The WhatsApp connection kept failing.");
      return;
    }
    spawnAfter(
      m,
      Math.min(
        WHATSAPP_BACKOFF_FIRST_MS * 2 ** (m.failures.length - 1),
        WHATSAPP_BACKOFF_MAX_MS,
      ),
    );
  }

  // Asks the child to end (logout or stop) and kills it when it has not
  // ended after WHATSAPP_LOGOUT_WAIT_MS.
  async function stopChild(
    m: MemberRecord,
    op: "logout" | "stop",
  ): Promise<void> {
    const rec = m.child;
    if (!rec || rec.exited) return;
    m.stopping = true;
    try {
      await new Promise<void>((resolve) => {
        const timer = clock.setTimeout(
          () => rec.child.kill(),
          WHATSAPP_LOGOUT_WAIT_MS,
        );
        rec.exitWaiters.push(() => {
          clock.clearTimeout(timer);
          resolve();
        });
        rec.child.send({ op });
      });
    } finally {
      m.stopping = false;
    }
  }

  async function unlink(userId: string): Promise<void> {
    const m = memberOf(userId);
    m.gen++;
    cancelRestart(m);
    await stopChild(m, "logout");
    removeMemberDir(deps.stateRoot, userId);
    m.link = null;
    m.failures = [];
    unlinked(m);
    setStatus(m, { state: "unlinked" });
  }

  return {
    async boot() {
      const dirs = listMemberDirs(deps.stateRoot);
      // A directory without link.json is a link a restart interrupted: its
      // session goes, its contact rows stay.
      for (const d of dirs) if (!d.hasLink) clearSessionOrLog(d.userId);
      const linked: MemberRecord[] = [];
      for (const d of dirs) {
        const link = d.hasLink ? readLink(deps.stateRoot, d.userId) : null;
        if (!link) continue;
        const m = memberOf(d.userId);
        m.link = link;
        setStatus(m, {
          state: "linked",
          phone: link.phone,
          linkedAt: link.linkedAt,
          connected: false,
        });
        linked.push(m);
      }
      if (linked.length === 0) return;
      const installed = await deps.installer.ensure();
      if (!installed.ok) {
        // No page: the next boot or a new link tries the download again.
        for (const m of linked) {
          const phone = phoneOf(m);
          if (phone !== undefined)
            setStatus(m, { state: "dead", reason: "install_failed", phone });
        }
        return;
      }
      runtimeDir = installed.runtimeDir;
      for (const m of linked)
        if (m.status.state === "linked" && !m.child && !shuttingDown)
          startOrFail(m);
    },

    status(userId) {
      return members.get(userId)?.status ?? { state: "unlinked" };
    },

    async link(userId, req) {
      let command: BridgeCommand;
      if (req.method === "code") {
        const phone = normaliseWhatsAppPhone(req.phone);
        if (!phone)
          return {
            ok: false,
            status: 400,
            error:
              "phone must be the full number with the country code, 8 to 15 digits",
          };
        command = { op: "link", method: "code", phone };
      } else if (req.method === "qr") {
        command = { op: "link", method: "qr" };
      } else {
        return { ok: false, status: 400, error: "unknown link method" };
      }
      if (shuttingDown)
        return { ok: false, status: 409, error: "the office is stopping" };
      const m = memberOf(userId);
      if (m.status.state === "linking" || m.status.state === "linked")
        return {
          ok: false,
          status: 409,
          error: "WhatsApp is already linked or linking",
        };
      if (req.method === "code") {
        // A code pushes a notification to the number: at most one a minute.
        const now = clock.now();
        if (
          m.lastCodeAt !== null &&
          now - m.lastCodeAt < WHATSAPP_PAIRING_COOLDOWN_MS
        )
          return {
            ok: false,
            status: 429,
            error: "Wait a minute before you ask for another code",
          };
        m.lastCodeAt = now;
      }
      // A dead link's session goes before a new one. A crash loop's retry
      // child stops first: it would write the old credentials into the new
      // link's directory. The linking status keeps a second link out
      // meanwhile.
      cancelRestart(m);
      m.failures = [];
      m.link = null;
      const gen = ++m.gen;
      setStatus(m, { state: "linking", method: req.method });
      await stopChild(m, "stop");
      if (m.gen !== gen) return { ok: true, status: m.status };
      try {
        clearSession(userId);
      } catch {
        // A new link must not start on the old credentials.
        console.error(
          "[whatsapp] a WhatsApp session directory was not removed",
        );
        setStatus(m, { state: "unlinked", reason: "link_expired" });
        return { ok: true, status: m.status };
      }
      const installed = await deps.installer.ensure();
      if (m.gen !== gen) return { ok: true, status: m.status };
      if (!installed.ok) {
        setStatus(m, { state: "unlinked", reason: "install_failed" });
        return { ok: true, status: m.status };
      }
      runtimeDir = installed.runtimeDir;
      try {
        spawn(m).child.send(command);
      } catch {
        console.error("[whatsapp] a WhatsApp bridge did not start");
        clearSessionOrLog(userId);
        setStatus(m, { state: "unlinked", reason: "link_expired" });
      }
      return { ok: true, status: m.status };
    },

    unlink,

    async removeMember(userId) {
      await unlink(userId);
      members.delete(userId);
    },

    setRoutes(userId) {
      const rec = members.get(userId)?.child;
      if (!rec || rec.exited) return;
      let allow: string[] = [];
      hook("allowlist", (h) => {
        allow = h.allowlist(userId);
      });
      rec.child.send({ op: "routes", chats: allow });
    },

    chatsSeen(userId) {
      // Newest message first; the chats with none follow in the order seen.
      const times = lastAt.get(userId);
      const timeOf = (c: WhatsAppChatSeen) => times?.get(c.chat) ?? -Infinity;
      return [...(chats.get(userId)?.values() ?? [])].sort(
        (a, b) => timeOf(b) - timeOf(a),
      );
    },
    send(userId, req) {
      const m = members.get(userId);
      const rec = m?.child;
      if (!m || !rec || rec.exited || m.stopping || m.status.state !== "linked")
        return Promise.resolve({ ok: false, reason: "not_linked" });
      // A retry while the first still waits shares its answer.
      const waiting = rec.sends.get(req.requestId);
      if (waiting) return waiting.promise;
      let resolve!: (result: WhatsAppSendResult) => void;
      const promise = new Promise<WhatsAppSendResult>((r) => (resolve = r));
      const timer = clock.setTimeout(
        () => pending.settle({ ok: false, reason: "unknown" }),
        WHATSAPP_SEND_TIMEOUT_MS,
      );
      const pending: PendingSend = {
        promise,
        settle(result) {
          if (rec.sends.get(req.requestId) !== pending) return;
          rec.sends.delete(req.requestId);
          clock.clearTimeout(timer);
          resolve(result);
        },
      };
      rec.sends.set(req.requestId, pending);
      try {
        rec.child.send({ op: "send", ...req });
      } catch {
        pending.settle({ ok: false, reason: "failed" });
      }
      return promise;
    },

    async shutdown() {
      // Pending bursts go to the agents while the bridges still run.
      hook("shutdown", (h) => h.onShutdown());
      shuttingDown = true;
      const all = [...members.values()];
      for (const m of all) {
        m.gen++;
        cancelRestart(m);
      }
      await Promise.all(all.map((m) => stopChild(m, "stop")));
    },
  };
}
