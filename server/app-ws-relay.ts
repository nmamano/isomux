// The WebSocket relay behind app hostnames (slice 6b).
//
// Slice 6a built the upstream half - a frame codec and an in-house client over a
// raw TCP socket, with a queue that has a number on it - and wired it into
// nothing. This module is the wiring: it decides who may open a socket to an
// app, dials the app, and then carries frames between two legs that are entirely
// different animals.
//
// THE TWO LEGS ARE NOT SYMMETRIC, and most of what looks like duplication below
// is that asymmetry:
//
//   browser leg   Bun's own server WebSocket. Bun owns the queue; `send` returns
//                 a byte count, -1 when it enqueued, or 0 when it DROPPED the
//                 message past its own ~16MB ceiling (measured). We never see
//                 the frames, so the only lever is refusing to hand it more.
//   app leg       server/app-ws-upstream.ts. We own the queue, the masking, the
//                 close handshake and the ping answers, because Bun's client
//                 buffers browser-to-app writes without bound (measured in 6a).
//
// WHAT THIS OWNS THAT NEITHER LEG DOES: the order of the checks in front of the
// 101, one lifecycle with one exit, the two caps, and the close mapping - which
// is where a relay is most tempted to lie. An app that says goodbye must not
// reach the browser as a dropped connection, and a browser that vanished must
// not reach the app as a polite close.
//
// ORDERING, and it is the whole reason a dial can fail cleanly: the app is
// dialed BEFORE the browser is upgraded. Everything that can go wrong with the
// app - not running, not listening, not speaking WebSocket - is therefore still
// an ordinary HTTP refusal with a readable body, rather than a socket that opens
// and dies a millisecond later for reasons the browser cannot see. Measured on
// Bun 1.3.11: `server.upgrade()` still works after an `await` inside `fetch`,
// which is what makes that ordering available at all.

import type { AppRecord } from "../shared/types.ts";
import type { AppSupervisor } from "./app-supervisor.ts";
import type { ServerWebSocket } from "bun";
import {
  appRegistry as productionRegistry,
  appRegistrationGeneration,
} from "./app-registry.ts";
import type { AppRegistry } from "./app-registry.ts";
import { buildUpstreamHeaders, proveAppRunning } from "./app-proxy.ts";
import { readAppCookie, validateAppSession } from "./app-auth.ts";
import {
  APP_BUSY_BODY,
  AUTH_REQUIRED_BODY,
  APP_UNREACHABLE_BODY,
  APP_WS_BAD_ORIGIN_BODY,
  APP_WS_PROTOCOL_MISMATCH_BODY,
  APP_WS_UPGRADE_FAILED_BODY,
  BAD_REQUEST_BODY,
  neutral,
} from "./app-host-responses.ts";
import {
  dialAppUpstream,
  isSafeProtocolToken,
  type AppUpstream,
  type AppUpstreamLimits,
  type UpstreamCloseEvent,
} from "./app-ws-upstream.ts";
import { isTransmittableCloseCode, truncateCloseReason } from "./ws-frames.ts";
import { appRegistrationKey, watchAppRetirement } from "./app-lifecycle.ts";

// The socket caps: 64 concurrent relayed sockets
// office-wide, 32 for any one app. Their own pool, deliberately separate from
// the HTTP relay's permits in app-proxy.ts - the two resources are not alike. An
// HTTP request occupies a permit for as long as one response takes; a WebSocket
// holds one for as long as a browser tab stays open, so sharing a pool would let
// a chat app with thirty tabs starve the office's ordinary traffic.
export const APP_WS_MAX_SOCKETS_TOTAL = 64;
export const APP_WS_MAX_SOCKETS_PER_APP = 32;

// What the browser leg may have outstanding before this relay stops feeding it.
// Matched to slice 6a's upstream queue ceiling so the two directions cost the
// same, and far below Bun's own ~16MB limit so the number that governs is OURS.
//
// THE BOUND THIS BUYS IS HONEST BUT NOT TOTAL, and the difference matters:
// `getBufferedAmount()` reads 0 while the kernel is still absorbing writes
// (measured), so what this ceiling actually caps is Bun's queue, not the socket
// buffer underneath it. Per connection: slice 6a's ~3.5MB, plus this 512KB, plus
// whatever Bun and the kernel hold for a socket that has already accepted bytes
// - bounded by Bun's own backpressure limit and SO_SNDBUF, which are not ours to
// set. Overclaiming a tidier number would be the kind of memory statement that
// reads well and is wrong.
export const APP_WS_BROWSER_BUFFER_MAX_BYTES = 512 * 1024;

// How often a live socket re-proves it is still allowed to exist.
//
// A timer rather than a per-message check, deliberately: per-message would make
// an idle socket immortal (a revoked session on a quiet connection would never
// be noticed) and a busy one pay for the check thousands of times a second. The
// HTTP relay revalidates per request because a request IS the unit there; here
// the unit is a connection that can outlive any number of revocations.
export const APP_WS_SESSION_RECHECK_MS = 30_000;

// The largest `Sec-WebSocket-Protocol` offer this relay will parse.
//
// A bound is needed because the offer is FORWARDED: it becomes a header line in
// the upgrade request slice 6a writes, which has its own 16KB ceiling. Without a
// bound here, an absurd offer of syntactically valid tokens would pass every
// check, take a permit, prove the app is running, dial it, and only then be
// refused by that ceiling as a generic "did not respond" - work done and a
// connection opened on behalf of a request that was never going to succeed.
// 1KB sits far enough inside the 16KB ceiling that a legal offer can never be
// the thing that overflows the request, and far above any real subprotocol list.
export const APP_WS_MAX_PROTOCOL_HEADER_BYTES = 1024;

// Close codes this relay sends on its own behalf, as opposed to relaying
// someone else's. Named because a bare number in a close call is unreadable and
// because the report has to quote them.
// Backpressure: a queue ceiling was hit in one direction or the other.
//
// 1013 ("try again later") is the semantically perfect code and it is NOT USED,
// for a measured reason. Bun's server validates the close code a PEER sends and
// accepts only 1000-1011 and 4000-4999: a close carrying 1012, 1013, 1014 or
// anything in 3000-3999 reaches the app as 1006 with an empty reason. Since the
// relay is the client on the app leg, sending 1013 would mean the browser hears
// "try again later" while the app hears "the connection dropped" - the exact
// two-ends-disagree failure this module exists to avoid, and invisible unless a
// test watches the app's own close event.
//
// 1011 is in the accepted set on both legs, means "an unexpected condition
// prevented this from being fulfilled", and is what both ends actually hear.
// (Measured the other direction too: Bun TRANSMITS every code faithfully,
// including 1012-1014 and 3000-3999, so relaying an app's own close code to a
// browser is unaffected by any of this.)
const CLOSE_BACKPRESSURE = 1011;
const CLOSE_TOO_LARGE = 1009; // a message over the slice-6a cap
const CLOSE_REVOKED = 1008; // policy: the session or the app went away
const CLOSE_GOING_AWAY = 1001; // the office is shutting the socket down

// The offered list, parsed strictly, or `null` for "this request is malformed".
//
// Strict because of a measured Bun behavior: when the client offers
// subprotocols, `server.upgrade()` ANSWERS with one - the first offered - unless
// we set the header ourselves, and it reads the offer from the raw request, so
// deleting the header off the `Request` object changes nothing. Silently
// treating an unparseable list as "no offer" would therefore not mean "no
// subprotocol"; it would mean Bun picking one we never looked at. A list we
// cannot read is refused instead.
export function parseOfferedProtocols(header: string | null): string[] | null {
  if (header === null) return [];
  // Size before syntax: a megabyte of valid tokens is malformed for our purposes
  // whatever it says, and this is the cheapest check there is.
  if (Buffer.byteLength(header, "utf8") > APP_WS_MAX_PROTOCOL_HEADER_BYTES) {
    return null;
  }
  // Present-but-empty is a client asserting an empty offer, which is not a
  // thing: the header exists to name protocols.
  if (header.trim().length === 0) return null;
  const out: string[] = [];
  for (const part of header.split(",")) {
    const token = part.trim();
    if (!isSafeProtocolToken(token)) return null;
    // A repeated token is a list somebody built by hand; two different layers
    // could disagree about which occurrence won.
    if (out.includes(token)) return null;
    out.push(token);
  }
  return out;
}

// A browser always sends `Origin` on an upgrade, so ABSENT means a client that
// is not a browser - and a client that is not a browser has no ambient cookies
// to be abused. That is the whole argument for allowing it, and it is worth
// stating plainly what it does NOT say: absence is not authentication. The
// caller still has to hold the app session cookie, which is checked before this,
// and a hand-built client can only have one if its owner signed in.
//
// Present, on the other hand, has to be exactly this app's own origin. The app
// host is https by construction (the arm does not exist otherwise), so this is a
// string comparison against a value the office derived, never a header echo.
export function originAllowed(
  originHeader: string | null,
  appHost: string,
): boolean {
  if (originHeader === null) return true;
  return originHeader === `https://${appHost}`;
}

// Keyed by ISSUANCE - label plus generation - for the reason app-proxy.ts spells
// out: a name is reusable, an issuance is not, and a release from a dead app
// must never decrement a live one's bucket.
function permitKey(app: AppRecord): string {
  return appRegistrationKey(app);
}

const perApp = new Map<string, number>();
let totalOpen = 0;
const openRelays = new Map<string, Set<AppWsRelay>>();

export function recheckOpenAppSockets(): void {
  for (const relays of openRelays.values()) {
    for (const relay of relays) relay.recheck();
  }
}

function trackRelay(key: string, relay: AppWsRelay): void {
  const relays = openRelays.get(key) ?? new Set<AppWsRelay>();
  relays.add(relay);
  openRelays.set(key, relays);
}

function untrackRelay(key: string, relay: AppWsRelay): void {
  const relays = openRelays.get(key);
  if (!relays) return;
  relays.delete(relay);
  if (relays.size === 0) openRelays.delete(key);
}

interface SocketPermit {
  release(): void;
}

function acquireSocketPermit(
  key: string,
  limits: { perApp: number; total: number },
): SocketPermit | null {
  const forApp = perApp.get(key) ?? 0;
  if (forApp >= limits.perApp) return null;
  if (totalOpen >= limits.total) return null;
  perApp.set(key, forApp + 1);
  totalOpen++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      totalOpen--;
      const left = (perApp.get(key) ?? 1) - 1;
      if (left <= 0) perApp.delete(key);
      else perApp.set(key, left);
    },
  };
}

export function _testWsSocketsOpen(): { total: number; perApp: number } {
  let max = 0;
  for (const count of perApp.values()) max = Math.max(max, count);
  return { total: totalOpen, perApp: max };
}

export function _testResetWsRelay(): void {
  openRelays.clear();
  perApp.clear();
  totalOpen = 0;
}

export interface AppWsRelayContext {
  app: AppRecord;
  host: string;
  apps: readonly AppRecord[];
  supervisor: AppSupervisor;
  peer?: () => string | null | undefined;
  // Hands the request to the runtime, with the headers that must ride the 101.
  // A thunk rather than the Bun server itself, so this module cannot reach
  // anything else on it and a test can watch the call without a listener.
  //
  // The HEADERS argument is load-bearing rather than decorative: without it the
  // runtime answers the subprotocol negotiation on its own (with the first
  // protocol the client offered - measured), and the app's actual selection is
  // silently replaced by a guess.
  upgrade: (req: Request, data: AppRelayWsData, headers?: Headers) => boolean;
  registry?: AppRegistry;
  canAccess: (app: AppRecord, userId: string) => boolean;
  // Test seams. Same shape as the HTTP relay's: a cap provable in three sockets
  // rather than sixty-five, a revalidation observable in milliseconds.
  maxPerApp?: number;
  maxTotal?: number;
  bufferMaxBytes?: number;
  recheckMs?: number;
  upstreamLimits?: Partial<AppUpstreamLimits>;
}

// What rides on the Bun socket. `kind` is the discriminant the office's shared
// websocket handlers switch on: one Bun.serve serves the office and every app
// host, so its three callbacks have to be able to tell a browser talking to the
// office from a browser talking through the relay.
export interface AppRelayWsData {
  kind: "app";
  relay: AppWsRelay;
}

type Buffered =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer };

// How the browser leg should be ended, decided by whoever is finishing.
type BrowserEnding =
  | { kind: "close"; code: number; reason: string }
  // No close frame: the peer must see 1006, because that is what happened.
  | { kind: "terminate" };

// How BOTH legs should be ended, as one value.
//
// One object rather than two arguments, and this is not tidiness: when the relay
// itself decides to close - a queue ceiling, an oversized message, a revoked
// session - the two ends have to hear the SAME thing. An earlier version passed
// only the browser's ending and told the app a flat 1001 "going away" every time,
// so an app whose client had sent an oversized message learned that the office
// was shutting down rather than that its peer broke a rule. The two legs cannot
// drift apart if there is only one place to write them.
//
// `null` on either side means "nothing to say to that leg": it is already gone,
// was never upgraded, or has already been told (a browser-initiated close tells
// the app before finishing).
interface RelayEnding {
  browser: BrowserEnding | null;
  upstream: { code: number; reason: string } | null;
}

// A fault the RELAY diagnosed: both ends hear the same code and the same reason.
function fault(code: number, reason: string): RelayEnding {
  return {
    browser: { kind: "close", code, reason },
    upstream: { code, reason },
  };
}

// The office is done with this socket and the far end has not been told. Used
// where there is no diagnosis to share - the runtime refused the upgrade, or an
// app-side flood happened before a browser leg ever existed.
function goingAway(reason: string): RelayEnding {
  return {
    browser: null,
    upstream: { code: CLOSE_GOING_AWAY, reason },
  };
}

// One relayed socket, from the dial to whichever end dies first.
//
// THE STATE MACHINE IS THE POINT of this class. A relay that dials before it
// upgrades has a window - real, and measured in event-loop turns rather than
// nanoseconds - in which the app is connected and talking while the browser
// socket does not exist yet. Every subtle failure in this module lives in that
// window, so the states are named and each one says exactly what an upstream
// close means:
//
//   preOpen       dial resolved, `server.upgrade` not yet called. Messages are
//                 buffered and an upstream close is RECORDED, not fatal: the app
//                 already spoke WebSocket, so an app that greets and hangs up -
//                 or closes with 4001 "not authorized" - reaches the browser as
//                 a socket that opens and closes with the app's own code, which
//                 is what its bare port does. Only a dial that never succeeded
//                 is a 502.
//   awaitingOpen  the 101 went out, Bun's `open` has not fired. Same rule, same
//                 reason: the bytes the app already sent are owed to a leg that
//                 is about to exist, and finishing would drop them.
//   open          normal operation.
//   closed        idempotent.
//
// HOW OFTEN `awaitingOpen` IS ACTUALLY REACHED, measured rather than assumed:
// on Bun 1.3.11 `server.upgrade()` calls the `open` handler SYNCHRONOUSLY,
// before it returns - the observed event order for a client that completes the
// handshake and immediately drops TCP is `open -> upgrade() returns -> close
// (1006)`. So attachBrowser has usually run before `server.upgrade()` has even
// returned, and that state is the defensive path rather than the common one. It
// stays because the ordering is the runtime's choice, not a guarantee, and a
// future Bun that defers `open` by a turn would otherwise silently start
// dropping an app's first messages. The same measurement is what rules out a
// stranded permit: `open` fires even for a socket that is already gone, so the
// finalizer is always reached.
export class AppWsRelay {
  private state: "preOpen" | "awaitingOpen" | "open" | "closed" = "preOpen";
  private ws: ServerWebSocket<AppRelayWsData> | null = null;
  private buffer: Buffered[] = [];
  private bufferedBytes = 0;
  private recorded: UpstreamCloseEvent | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  // Shutdown has been INITIATED. Not the same thing as over: a close is a
  // handshake, and both legs can still be physically alive after this is set.
  private shuttingDown = false;
  // Which transports are still live. The permit is held until BOTH are gone,
  // because the cap counts SOCKETS, not relay objects that have been asked to
  // close. Releasing when shutdown starts would let a new relay take the slot
  // while the old sockets are still up - slice 6a gives the app leg up to
  // APP_WS_CLOSE_HANDSHAKE_MS to answer, and a browser can dawdle too - so a
  // repeated fault could hold more than 64 real sockets under a cap of 64.
  //
  // The failure direction is deliberate: a leg whose runtime never reports
  // closure holds its permit forever, so the cap can only ever be too STRICT.
  // Failing the other way would make it a cap in name only.
  private upstreamLive = true;
  private browserLive = false;

  constructor(
    private readonly upstream: AppUpstream,
    private readonly permit: SocketPermit,
    private readonly session: {
      // Held for the life of the socket so the revalidation timer can ask the
      // same question the gate asked. The browser holds this value too, and the
      // office already holds its hash; nothing new is exposed by keeping it.
      token: string | null;
      label: string;
      hostGen: number;
      registrationGen: number;
      registry: AppRegistry;
      canAccess: (app: AppRecord, userId: string) => boolean;
      userId: string;
      officeSessionHash: string;
    },
    private readonly bufferMaxBytes: number,
    private readonly recheckMs: number,
    private readonly onFinish: () => void = () => {},
  ) {}

  onUpstreamMessage(message: Buffered): void {
    if (this.shuttingDown) return;
    if (this.state === "open") {
      this.sendToBrowser(message);
      return;
    }
    // CHECK BEFORE RETAINING. Adding the message and then noticing would mean
    // holding one whole slice-6a message (up to 1MB) past the ceiling before
    // reacting, which is the ceiling being advisory rather than a bound.
    const size = sizeOf(message);
    if (this.bufferedBytes + size > this.bufferMaxBytes) {
      this.finish(
        fault(CLOSE_BACKPRESSURE, "app is too fast"),
        `app sent more than ${this.bufferMaxBytes} bytes before the socket opened`,
      );
      return;
    }
    this.buffer.push(message);
    this.bufferedBytes += size;
  }

  onUpstreamClose(event: UpstreamCloseEvent): void {
    // The app leg is gone, whatever else is true. Recorded FIRST so every path
    // below - including the ones that return early - leaves the accounting
    // right. Slice 6a promises this fires exactly once.
    this.upstreamLive = false;
    if (this.shuttingDown) {
      this.releaseIfBothLegsEnded();
      return;
    }
    if (this.state !== "open") {
      // Recorded, NOT finalized. There is no browser leg yet - either the
      // upgrade has not been called or its `open` has not fired - and finishing
      // here would drop both the app's last messages and its close CODE.
      //
      // THIS IS WHERE THE FIRST DESIGN WAS WRONG, and an ordinary app pattern
      // caught it: an app that greets and hangs up, or that accepts the socket
      // and closes it with 4001 "not authorized", had already spoken WebSocket.
      // Answering 502 "this app did not respond" would be false, and would throw
      // away the code the app closed with - the one thing it was trying to say.
      // Reaching the browser as a socket that opens and immediately closes with
      // the app's own code is also exactly what hitting the app's port directly
      // does. A dial that never succeeded is still a 502; this is not that.
      this.recorded = event;
      return;
    }
    // The app is already closing - it is the one that closed - so there is
    // nothing to send back up that leg.
    this.finish(
      { browser: endingFor(event), upstream: null },
      event.detail ?? "the app closed the socket",
    );
  }

  attachBrowser(ws: ServerWebSocket<AppRelayWsData>): void {
    if (this.shuttingDown) {
      // The relay died between the 101 and this callback. Nothing to relay to
      // and nothing to say - the close the finalizer wanted cannot have reached
      // a socket that did not exist, so it is sent here.
      try {
        ws.close(CLOSE_GOING_AWAY, "app closed");
      } catch {}
      return;
    }
    this.ws = ws;
    this.state = "open";
    // Idempotent restatement: beginUpgrade has already set this, and this
    // callback can run INSIDE server.upgrade(). Set here too so the invariant
    // holds even if a caller ever attaches without going through the entry
    // point.
    this.browserLive = true;
    // Flush IN ORDER first, then the ending. A close that overtook the app's
    // last message would lose it silently, and "the app greeted me and hung up"
    // is a real protocol.
    const pending = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    for (const message of pending) {
      if (this.shuttingDown) return;
      this.sendToBrowser(message);
    }
    if (this.recorded !== null) {
      const event = this.recorded;
      this.recorded = null;
      this.finish(
        { browser: endingFor(event), upstream: null },
        event.detail ?? "the app closed the socket",
      );
      return;
    }
    this.armRecheck();
  }

  browserMessage(data: string | Buffer): void {
    if (this.shuttingDown || this.state !== "open") return;
    const outcome =
      typeof data === "string"
        ? this.upstream.sendText(data)
        : this.upstream.sendBinary(Buffer.from(data));
    switch (outcome) {
      case "sent":
        return;
      case "queue_full":
        // The app has stopped reading. Slice 6a's contract is that the caller
        // ends the connection rather than letting the queue grow.
        this.finish(
          fault(CLOSE_BACKPRESSURE, "app stopped reading"),
          "upstream write queue is full",
        );
        return;
      case "too_large":
        this.finish(
          fault(CLOSE_TOO_LARGE, "message too large"),
          "browser sent a message over the relay's message cap",
        );
        return;
      case "closing":
        return;
    }
  }

  browserClosed(code: number, reason: string): void {
    // The browser leg is gone: nothing may be sent to it from here on, and the
    // permit accounting has to know before anything else runs.
    this.browserLive = false;
    this.ws = null;
    if (this.shuttingDown) {
      this.releaseIfBothLegsEnded();
      return;
    }
    if (code === 1006) {
      // The tab vanished, the network dropped, the process died. No close frame
      // was exchanged, so none is invented: slice 6a's terminate() ends the TCP
      // connection without one and the app sees 1006 - the same event, told the
      // same way it reached us.
      this.upstream.terminate("browser socket dropped");
    } else if (code === 1005) {
      // Closed cleanly with no status. Relayed as no status.
      this.upstream.sendClose(null, "", "browser closed without a status");
    } else {
      this.upstream.sendClose(code, reason, "browser closed the socket");
    }
    // Both legs are accounted for already: the browser is gone, and the line
    // above told the app in its own vocabulary.
    this.finish({ browser: null, upstream: null }, `browser closed (${code})`);
  }

  // Called IMMEDIATELY BEFORE the runtime is asked to take the socket, never
  // after it answers.
  //
  // The ordering is the whole point, and it comes straight out of the measured
  // Bun behavior: `server.upgrade()` runs the `open` callback SYNCHRONOUSLY,
  // inside the call. So by the time upgrade() returns, attachBrowser may already
  // have run, flushed a recorded close, and finished the relay. Marking the leg
  // live afterwards would mean that finish saw `browserLive === false`, released
  // the permit while the browser's close handshake was still physically live,
  // and only then had the flag set - a leg alive with no permit behind it, which
  // is the fail-open cap bug again on the greet-and-close path.
  //
  // From this call there is a browser leg as far as the accounting is concerned,
  // even if the runtime turns out to refuse the upgrade - see upgradeRejected,
  // which is the only thing allowed to take it back.
  beginUpgrade(): void {
    this.browserLive = true;
    if (this.state === "preOpen") this.state = "awaitingOpen";
  }

  // The runtime did NOT take the socket (returned false, or threw). There is no
  // browser leg and there never will be, so the attempt is taken back - and
  // nothing else may resurrect it, because a close callback that has already
  // cleared the flag must stay cleared.
  upgradeRejected(): void {
    this.browserLive = false;
  }

  isLive(): boolean {
    return !this.shuttingDown && this.state === "preOpen";
  }

  // The permit goes back when the LAST live transport has reported that it is
  // gone - not when the office decided they should go. Idempotent by the
  // permit's own flag as well as this one, so a stray extra callback cannot
  // double-release and let the cap drift open.
  private releaseIfBothLegsEnded(): void {
    if (!this.shuttingDown) return;
    if (this.upstreamLive || this.browserLive) return;
    this.permit.release();
  }

  private sendToBrowser(message: Buffered): void {
    const ws = this.ws;
    if (ws === null) return;
    const size = sizeOf(message);
    // BEFORE the send, not after: a post-hoc check lets one whole message past
    // the ceiling every time, and the ceiling is what the memory statement is
    // written in terms of.
    if (ws.getBufferedAmount() + size > this.bufferMaxBytes) {
      this.finish(
        fault(CLOSE_BACKPRESSURE, "browser stopped reading"),
        "browser leg is over its buffer ceiling",
      );
      return;
    }
    const written =
      message.kind === "text" ? ws.send(message.text) : ws.send(message.data);
    // Measured (Bun 1.3.11): a byte count when it took the message, -1 when it
    // enqueued it, 0 when it DROPPED it past its own backpressure limit. A
    // dropped frame is not a slow client, it is a hole in the stream, and a
    // relay that keeps going after one is lying to both ends. An empty message
    // also returns 0, which is not a drop - hence the size guard.
    if (size > 0 && written === 0) {
      this.finish(
        fault(CLOSE_BACKPRESSURE, "browser stopped reading"),
        "the runtime dropped a message on the browser leg",
      );
    }
  }

  private armRecheck(): void {
    if (this.recheckTimer !== null) return;
    const timer = setInterval(() => this.recheck(), this.recheckMs);
    // Nothing about a relayed socket should keep the office process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.recheckTimer = timer;
  }

  // Is this socket still allowed to exist? Asked of the same two authorities the
  // handshake asked: the app session (which fails the moment the office session
  // behind it is revoked, expires, or its user is deleted) and the registry
  // (which fails when the app is deleted or its name re-registered into a new
  // generation). Fail-closed on a registry that cannot be read.
  recheck(): void {
    if (this.shuttingDown) return;
    let liveApp: AppRecord | null = null;
    try {
      liveApp =
        this.session.registry
          .list()
          .find(
            (app) =>
              app.hostLabel === this.session.label &&
              app.hostGen === this.session.hostGen &&
              appRegistrationGeneration(app) === this.session.registrationGen,
          ) ?? null;
    } catch (err) {
      console.error("[app-ws-relay] registry unreadable; closing socket:", err);
      liveApp = null;
    }
    const stillSignedIn = validateAppSession(this.session.token, {
      label: this.session.label,
      hostGen: this.session.hostGen,
      registrationGen: this.session.registrationGen,
    });
    const stillAllowed =
      liveApp !== null &&
      stillSignedIn !== null &&
      this.session.canAccess(liveApp, stillSignedIn.userId);
    if (stillAllowed) return;
    this.finish(
      fault(CLOSE_REVOKED, "session ended"),
      liveApp ? "app session is no longer valid" : "app is gone",
    );
  }

  // THE one exit. Releases the permit, stops the timer, drops the buffer, and
  // ends both legs - once, from any state, whichever side got here first. A
  // relay whose permit can be released twice is a relay whose caps drift, so
  // "exactly once" is a property of this method rather than a rule each caller
  // remembers.
  //
  // `ending` carries BOTH legs, so a fault the relay diagnosed reaches the app
  // and the browser as the same code and the same reason. Either side may be
  // null: already gone, never upgraded, or already told.
  finish(ending: RelayEnding, detail: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.onFinish();
    this.state = "closed";
    if (this.recheckTimer !== null) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.recorded = null;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ending.browser !== null) {
      try {
        if (ending.browser.kind === "terminate") ws.terminate();
        else ws.close(ending.browser.code, ending.browser.reason);
      } catch {}
    }
    if (ending.upstream !== null && this.upstream.isOpen()) {
      this.upstream.sendClose(
        ending.upstream.code,
        ending.upstream.reason,
        detail,
      );
    }
    // Both closes are now IN FLIGHT. Neither leg is necessarily gone: the app
    // has up to slice 6a's close-handshake budget to answer, and the browser's
    // own close callback arrives on the runtime's schedule. The permit goes back
    // in those callbacks, not here - see releaseIfBothLegsEnded.
    //
    // Deliberately NOT consulting upstream.isOpen() as a shortcut: slice 6a
    // reports `closing` as not-open the moment a close frame is QUEUED, so that
    // test would mark the leg dead while its socket is still up and hand the
    // slot away - the exact bug this method exists to fix. Only onClose, which
    // slice 6a promises exactly once, ends the app leg.
    this.releaseIfBothLegsEnded();
  }
}

function sizeOf(message: Buffered): number {
  return message.kind === "text"
    ? Buffer.byteLength(message.text, "utf8")
    : message.data.length;
}

// How an upstream close reaches the browser.
//
// The distinction this preserves is the one that matters to client code:
// CLEAN versus DROPPED. A browser reconnect loop triggers on 1006, so reporting
// an app's deliberate goodbye as 1006 would turn a normal shutdown into a
// reconnect storm; reporting a genuinely dropped connection as 1000 would hide a
// failure. Hence: abnormal -> terminate (the browser sees 1006, which is what
// happened), clean -> the app's own code and reason.
//
// A clean close with NO status is the one place a code is invented, and it is
// unavoidable: measured on Bun 1.3.11, `ws.close()` with no arguments puts
// `88 02 03 e8` on the wire - a close frame carrying 1000. Bun's server API
// cannot emit the status-less form at all, so the choice is between 1000 (keeps
// the close in the CLEAN family, invents a status) and 1006 (keeps "no status",
// moves a deliberate goodbye into the FAILED family). 1000 is the smaller lie,
// and RFC 6455 7.1.5 already treats a status-less close as a normal one.
function endingFor(event: UpstreamCloseEvent): BrowserEnding {
  if (event.abnormal) return { kind: "terminate" };
  if (event.code === null) return { kind: "close", code: 1000, reason: "" };
  if (!isTransmittableCloseCode(event.code)) return { kind: "terminate" };
  return {
    kind: "close",
    code: event.code,
    // Bun truncates a too-long reason silently at 123 bytes and can cut a
    // character in half; slice 6a's helper cuts on a code-point boundary.
    reason: truncateCloseReason(event.reason),
  };
}

// An upgrade on an app host. Returns a Response for every refusal, and
// `undefined` exactly when the socket was handed to the runtime - which is what
// Bun's fetch handler wants back from an upgraded request.
//
// The order below is the security argument, and each step is placed where it is
// for a reason the comment gives. Nothing that can refuse cheaply happens after
// something expensive, and nothing that touches the app happens before the
// caller has proven they may.
export async function relayWsToApp(
  req: Request,
  ctx: AppWsRelayContext,
): Promise<Response | undefined> {
  // 1. Auth has already happened: the arm runs appHostWsAuthGate ahead of this,
  // in the same position the HTTP path runs its gate, and nothing reaches here
  // without a live app session. The cookie is read again for one reason - the
  // revalidation timer has to ask the same question every thirty seconds.
  const rawCookie = readAppCookie(req);
  const authenticated = validateAppSession(rawCookie, {
    label: ctx.app.hostLabel,
    hostGen: ctx.app.hostGen,
    registrationGen: appRegistrationGeneration(ctx.app),
  });
  if (authenticated === null) {
    return neutral(401, AUTH_REQUIRED_BODY);
  }
  if (!ctx.canAccess(ctx.app, authenticated.userId)) {
    return neutral(401, AUTH_REQUIRED_BODY);
  }

  // 2. Origin. Cheap, and it fails a cross-origin attempt before the app hears
  // about it at all.
  if (!originAllowed(req.headers.get("origin"), ctx.host)) {
    return neutral(403, APP_WS_BAD_ORIGIN_BODY);
  }

  // 3. The browser's subprotocol offer, parsed strictly - see
  // parseOfferedProtocols for why a malformed list cannot be treated as none.
  const offered = parseOfferedProtocols(
    req.headers.get("sec-websocket-protocol"),
  );
  if (offered === null) return neutral(400, BAD_REQUEST_BODY);

  let relay: AppWsRelay | null = null;
  const retirement = new AbortController();
  const stopWatchingRetirement = watchAppRetirement(ctx.app, () => {
    retirement.abort();
    relay?.finish(
      fault(CLOSE_REVOKED, "app registration retired"),
      "app registration retired",
    );
  });

  // 4. The app is running, proven the same way and in the same position as the
  // HTTP relay proves it - one helper, so the two cannot drift. No socket is
  // opened to a port whose app is not running, because that port is just a port.
  const running = proveAppRunning(ctx);
  if (!running.ok) {
    stopWatchingRetirement();
    return running.response;
  }

  // 5. A permit from the WebSocket pool, taken in this synchronous turn.
  const permit = acquireSocketPermit(permitKey(ctx.app), {
    perApp: ctx.maxPerApp ?? APP_WS_MAX_SOCKETS_PER_APP,
    total: ctx.maxTotal ?? APP_WS_MAX_SOCKETS_TOTAL,
  });
  if (permit === null) {
    stopWatchingRetirement();
    return neutral(429, APP_BUSY_BODY);
  }

  // 6. Dial the app. Everything below is `await`ed, which is exactly why the
  // permit is already held: the slot is occupied from the moment the dial starts
  // rather than from the moment it succeeds.
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  // ONE hygiene builder, shared with the HTTP relay: hop-by-hop headers and the
  // ones a `Connection` line nominates are dropped, the relay-owned
  // `X-Forwarded-*` are rewritten rather than passed through, `Host` is the
  // verified app host, and the Cookie header loses all three isomux credentials
  // (the app must never see what admits to it). Slice 6a then owns every header
  // that belongs to the handshake itself - key, version, Connection, Upgrade,
  // and the protocol offer - and drops any inbound duplicate of them.
  for (const [name, value] of buildUpstreamHeaders(
    req,
    ctx.host,
    peerAddress(ctx),
  )) {
    headers[name] = value;
  }

  // THE EARLIEST WINDOW, and it is narrower and sharper than the pre-open one
  // below. Slice 6a publishes the connection, settles the dial, and only THEN
  // parses the bytes that shared the handshake's last TCP read - so an app that
  // greets on connect can deliver its greeting, or its close, while this
  // function is still suspended on the `await` and no relay object exists yet.
  // Dropping those would lose the first message of every server that speaks
  // first, which for a greeting protocol is the only message that matters.
  const early: Buffered[] = [];
  let earlyBytes = 0;
  let earlyOverflow = false;
  let earlyClose: UpstreamCloseEvent | null = null;
  const bufferMaxBytes = ctx.bufferMaxBytes ?? APP_WS_BROWSER_BUFFER_MAX_BYTES;

  const dial = await dialAppUpstream({
    port: ctx.app.port,
    target: `${url.pathname}${url.search}`,
    host: ctx.host,
    headers,
    protocols: offered,
    limits: ctx.upstreamLimits,
    signal: retirement.signal,
    onMessage: (message) => {
      if (relay !== null) {
        relay.onUpstreamMessage(message);
        return;
      }
      // Same check-before-retain rule as the relay's own buffer, for the same
      // reason: the ceiling is a bound, not an observation made afterwards.
      const size = sizeOf(message);
      if (earlyOverflow || earlyBytes + size > bufferMaxBytes) {
        earlyOverflow = true;
        return;
      }
      early.push(message);
      earlyBytes += size;
    },
    onClose: (event) => {
      if (relay !== null) {
        relay.onUpstreamClose(event);
        return;
      }
      earlyClose = event;
    },
  });
  if (!dial.ok) {
    console.error(
      `[app-ws-relay] ${ctx.app.hostLabel}: upstream dial failed (${dial.failure}): ${dial.detail}`,
    );
    permit.release();
    stopWatchingRetirement();
    // One answer for every way an app can fail to be reached - refused the
    // connection, took too long, answered a page instead of an upgrade, got the
    // handshake wrong. The caller cannot act differently on the difference, and
    // the difference is a fact about a process on this box.
    //
    // EXCEPT the subprotocol one, which the caller CAN act on: their own client
    // asked for an application protocol this app did not agree to. That gets the
    // body that says so.
    return dial.failure === "handshake_protocol"
      ? neutral(502, APP_WS_PROTOCOL_MISMATCH_BODY)
      : neutral(502, APP_UNREACHABLE_BODY);
  }

  // 7. The subprotocol the app selected has to be what the browser is told.
  //
  // Bun answers with the FIRST protocol the client offered unless we set the
  // header ourselves (measured), so leaving this to the runtime would let the
  // two legs disagree about the application protocol - the browser framing one
  // way while the app speaks another.
  const responseHeaders = new Headers();
  if (dial.connection.protocol !== null) {
    responseHeaders.set("Sec-WebSocket-Protocol", dial.connection.protocol);
  } else if (offered.length > 0) {
    // The app selected NONE while the browser offered some. Bun cannot be told
    // to answer "none" - an empty header value emits two protocol lines, and the
    // offer is read from the raw request, so deleting it off the Request changes
    // nothing (all measured) - so the only alternative to refusing is letting
    // the runtime claim an agreement that never happened. Refused, per the
    // manager's ruling; app-host-responses.ts carries the reasoning with the
    // body. The socket to the app is ended here rather than left for the
    // finalizer, because no relay object exists yet to own it.
    dial.connection.terminate("no subprotocol agreed");
    permit.release();
    stopWatchingRetirement();
    return neutral(502, APP_WS_PROTOCOL_MISMATCH_BODY);
  }

  const relayKey = `${appRegistrationKey(ctx.app)}:${authenticated.userId}:${authenticated.officeSessionHash}`;
  relay = new AppWsRelay(
    dial.connection,
    permit,
    {
      token: rawCookie,
      label: ctx.app.hostLabel,
      hostGen: ctx.app.hostGen,
      registrationGen: appRegistrationGeneration(ctx.app),
      registry: ctx.registry ?? productionRegistry,
      canAccess: ctx.canAccess,
      userId: authenticated.userId,
      officeSessionHash: authenticated.officeSessionHash,
    },
    bufferMaxBytes,
    ctx.recheckMs ?? APP_WS_SESSION_RECHECK_MS,
    () => {
      if (relay) untrackRelay(relayKey, relay);
      stopWatchingRetirement();
    },
  );
  trackRelay(relayKey, relay);

  // Whatever arrived during the dial is handed over now, in order, before the
  // upgrade - so it lands in the relay's own pre-open buffer and reaches the
  // browser the moment there is one.
  if (earlyOverflow) {
    // The app blasted more than the whole browser-leg ceiling in the turn or two
    // before the socket could be upgraded. Those bytes are gone - there was
    // nowhere to put them - so there is nothing to deliver and no honest way to
    // open a socket that has already lost data. Refused as a capacity problem,
    // which is what it is, rather than as "did not respond", which it is not.
    relay.finish(
      // The app hears the backpressure code rather than a generic goodbye: it is
      // the one that overran the ceiling. No browser leg exists to tell.
      {
        browser: null,
        upstream: { code: CLOSE_BACKPRESSURE, reason: "app is too fast" },
      },
      "the app sent more than the buffer ceiling before the upgrade",
    );
    return neutral(503, APP_BUSY_BODY);
  }
  for (const message of early) relay.onUpstreamMessage(message);
  // A close that arrived during the dial is recorded, not acted on: the upgrade
  // still happens and the browser gets the app's messages and then its close
  // code. See onUpstreamClose for why that beats refusing.
  if (earlyClose !== null) relay.onUpstreamClose(earlyClose);

  // 8. THE SYNCHRONOUS RE-CHECK. Everything from the dial resolving to the
  // upgrade call is ONE synchronous block - construction, the early-close
  // handling, the replay, this check - so nothing can currently finish a relay
  // in between and this guard catches nothing today. It stays anyway, because
  // the alternative is a rule that holds by accident: the moment an await, or a
  // runtime that hands over a transport differently, appears in this stretch, a
  // dead relay would silently be handed a 101. Stated rather than implied, so
  // nobody reads it as tested behavior.
  if (!relay.isLive()) return neutral(502, APP_UNREACHABLE_BODY);

  // MARKED BEFORE THE CALL, not after: the runtime can own a browser transport
  // at any point inside it, and on Bun 1.3.11 it runs the socket's `open`
  // handler before returning. See beginUpgrade.
  relay.beginUpgrade();
  let upgraded: boolean;
  try {
    upgraded = ctx.upgrade(
      req,
      { kind: "app", relay },
      responseHeaders.has("Sec-WebSocket-Protocol")
        ? responseHeaders
        : undefined,
    );
  } catch (err) {
    // An exceptional runtime seam is the one path where a permit and a live
    // upstream socket could leak silently, so it is handled exactly like a
    // refusal rather than propagated.
    console.error(`[app-ws-relay] ${ctx.app.hostLabel}: upgrade threw:`, err);
    relay.upgradeRejected();
    relay.finish(
      goingAway("office closed the socket"),
      "the runtime threw on upgrade",
    );
    return neutral(500, APP_WS_UPGRADE_FAILED_BODY);
  }
  if (!upgraded) {
    relay.upgradeRejected();
    relay.finish(
      goingAway("office closed the socket"),
      "the runtime refused the upgrade",
    );
    return neutral(500, APP_WS_UPGRADE_FAILED_BODY);
  }
  // Nothing to mark and nothing to return: the socket is the runtime's now, and
  // anything written here would be written AFTER a synchronous close callback
  // may already have run.
  return undefined;
}

function peerAddress(ctx: AppWsRelayContext): string | null {
  try {
    return ctx.peer?.() ?? null;
  } catch {
    return null;
  }
}
