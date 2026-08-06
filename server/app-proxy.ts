// The HTTP relay behind app hostnames (phase 3, slice 5).
//
// Slices 3 and 4 built the road: a request whose Host is a strict child of the
// office host is diverted before any office handler sees it, and a caller who
// cannot prove an office session never gets past the gate. This module is what
// finally sits at the end of it - an authenticated request is carried to the
// app's own loopback port and its bytes are carried back, streamed both ways.
//
// A relay is a place where two parties' assumptions meet, so nearly all of the
// code here is about NOT passing something along:
//
//   - the app never sees `__Host-isomux_app`, the cookie that admits to it.
//     That is the whole point of the handshake: a program an agent wrote in a
//     scratch directory must not be handed the credential that opens itself,
//     let alone one that opens the office. The two office session cookie names
//     go the same way, for the same money.
//   - the app never sees a client's `X-Forwarded-*`. The relay writes those,
//     and a header the relay owns is worthless if a client can pre-fill it.
//   - the browser never sees the app's hop-by-hop headers, and never sees a
//     `Content-Encoding` describing bytes Bun already decoded on the way in.
//   - nothing at all is sent to an app that is not RUNNING. A stopped app's
//     port is just a free port, and any local process can be sitting on it.
//
// WebSocket upgrades never reach here - the arm refuses them above this module
// (slice 6 relays them).

import type { AppRecord } from "../shared/types.ts";
import type { AppRuntime, AppSupervisor } from "./app-supervisor.ts";
import { APP_COOKIE_NAME } from "./app-auth.ts";
import { COOKIE_NAME, HOST_COOKIE_NAME } from "./auth.ts";
import {
  APP_BUSY_BODY,
  APP_STOPPED_BODY,
  APP_UNREACHABLE_BODY,
  neutral,
} from "./app-host-responses.ts";

// --- constants (plain named values, no env vars) -----------------------------

// How long the app has to produce RESPONSE HEADERS. Cleared the moment they
// arrive: a stream that then runs for a day is a feature (SSE), so this can
// never become a total-duration cap.
export const APP_RELAY_TTFB_MS = 30_000;

// How long a started response may move no bytes before the relay gives up on
// it. This is the case abort propagation cannot see: the client is still
// attached and the app is still connected, but nothing is coming. It is a
// dead-upstream reclamation bound, not a liveness policy - an app that means to
// hold a stream open across a quiet period (SSE, long-poll) has to send a
// heartbeat inside this window, which is what every SSE implementation does
// anyway. Deliberately generous, because the cost of it being wrong is a
// working stream cut off.
export const APP_RELAY_STALL_MS = 300_000;

// Concurrency, so one app - or one flood at one app - cannot occupy the
// office's whole event loop. Sanity bounds, not a quota anybody should notice.
export const APP_RELAY_MAX_CONCURRENT_PER_APP = 128;
export const APP_RELAY_MAX_CONCURRENT_TOTAL = 512;

// Request-body size is NOT capped here. The listener's own maxRequestBodySize
// already applies - the app-host arm is the same Bun.serve as the office - so a
// second number here would be one more thing to keep consistent with the
// office's own story, buying no behavior it does not already have.

// --- header sets (pure) ------------------------------------------------------

// RFC 7230 section 6.1: connection-specific, never forwarded by a proxy in
// either direction. `Connection` also NAMES further headers that are
// connection-specific for this message; those are collected per-message below.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Headers the RELAY owns on the way in. A client-supplied value is dropped
// before ours is written, so an app can trust these exactly as far as it trusts
// isomux - and no further, which is the honest position.
const RELAY_OWNED_REQUEST_HEADERS = new Set([
  "host",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

// Content codings Bun's fetch decodes transparently.
//
// This set exists because of a measurement, and it has to keep matching a
// measurement rather than the spec. A gzip response arrives here with its body
// ALREADY DECOMPRESSED and its `Content-Encoding: gzip` plus the COMPRESSED
// `Content-Length` still attached, so forwarding those verbatim hands the
// browser a lie about the bytes and a wrong framing for them. Sending
// `Accept-Encoding: identity` upstream does not prevent it (also measured).
//
// THE MATCH IS EXACT AND CASE-SENSITIVE ON PURPOSE, which is not what the HTTP
// grammar says a coding list is. Measured on Bun 1.3.11: `gzip`, `deflate`,
// `br` and `zstd` are decoded; `GZIP`, `Gzip`, `x-gzip`, `Deflate`, `BR` and
// any comma list (`identity, gzip`) are NOT - the body comes through still
// compressed. Parsing this the way the RFC describes would therefore strip the
// headers off bodies Bun left ENCODED, which is the same corruption in the
// other direction. So the rule mirrors the decoder, and a test pins the
// decoder's behavior directly: if a runtime upgrade widens it, that test fails
// and points here rather than shipping broken bytes.
const DECODED_CODINGS = new Set(["gzip", "deflate", "br", "zstd"]);

// Cookies that never leave the office, whoever sent them.
//
// `__Host-isomux_app` is the load-bearing one and slice 4's explicit handoff:
// it is the credential that opens THIS app, and an app holding it could open
// itself as its own visitor. The two office session names are stripped for the
// same reason one level up - an app handed a live office session could act as
// that user against the office API. No browser sends any of the three to a
// child host (all are host-only), so a request carrying one was hand-built, and
// there is nothing to preserve for it.
//
// Names are matched EXACTLY, and cookie names are case-sensitive (RFC 6265): an
// app's own `isomux_session_id` or `ISOMUX_SESSION` is its own business and
// passes through.
const STRIPPED_COOKIE_NAMES = new Set([
  APP_COOKIE_NAME,
  HOST_COOKIE_NAME,
  COOKIE_NAME,
]);

// Statuses defined to carry no body. A `Response` built with one of these and a
// body is a framing error waiting to happen, and there is nothing to stream.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// The header names a message's own `Connection` header nominates as
// connection-specific. Comma-separated, case-insensitive tokens.
function connectionNominated(headers: Headers): Set<string> {
  const out = new Set<string>();
  const value = headers.get("connection");
  if (!value) return out;
  for (const token of value.split(",")) {
    const name = token.trim().toLowerCase();
    if (name.length > 0) out.add(name);
  }
  return out;
}

// Did Bun decode this response on the way in? Whitespace is trimmed because
// the decoder trims too (measured: ` gzip` and `gzip ` are both decoded);
// nothing else is normalized, for the reason above.
export function carriesDecodedCoding(contentEncoding: string | null): boolean {
  if (contentEncoding === null) return false;
  return DECODED_CODINGS.has(contentEncoding.trim());
}

// The Cookie header with every isomux credential removed, or null when nothing
// is left worth sending. Splitting on `;` is the whole grammar: cookie VALUES
// cannot contain a semicolon or a comma unquoted, so there is no ambiguity to
// get wrong here.
export function stripIsomuxCookies(header: string | null): string | null {
  if (header === null) return null;
  const kept: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (STRIPPED_COOKIE_NAMES.has(name)) continue;
    kept.push(trimmed);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

// --- concurrency permits -----------------------------------------------------

// Keyed by the app's ISSUANCE - label plus generation - and never by its name.
// A name is reusable: an app can be deleted and re-registered while one of its
// responses is still unwinding, and a release from the dead app must not
// decrement the live one's bucket. A label is issued once, forever.
function permitKey(app: AppRecord): string {
  return `${app.hostLabel}#${app.hostGen}`;
}

const perApp = new Map<string, number>();
let totalInFlight = 0;

interface Permit {
  release(): void;
}

// Both counters move in ONE synchronous turn, and neither moves until BOTH
// limits have said yes - so there is no half-taken permit to roll back, and no
// leaked count when the two disagree.
function acquirePermit(
  key: string,
  limits: { perApp: number; total: number },
): Permit | null {
  const forApp = perApp.get(key) ?? 0;
  if (forApp >= limits.perApp) return null;
  if (totalInFlight >= limits.total) return null;
  perApp.set(key, forApp + 1);
  totalInFlight++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      totalInFlight--;
      const left = (perApp.get(key) ?? 1) - 1;
      // Buckets are deleted at zero: a map that only ever grows is a leak with
      // a slow fuse, and app labels are issued forever.
      if (left <= 0) perApp.delete(key);
      else perApp.set(key, left);
    },
  };
}

export function _testRelayInFlight(): { total: number; perApp: number } {
  let max = 0;
  for (const count of perApp.values()) max = Math.max(max, count);
  return { total: totalInFlight, perApp: max };
}

export function _testResetRelay(): void {
  perApp.clear();
  totalInFlight = 0;
}

// --- building the upstream request (pure) -----------------------------------

// The peer address as an `X-Forwarded-For` node.
//
// Bun reports a loopback peer on a dual-stack socket as `::ffff:127.0.0.1` -
// the IPv4-mapped IPv6 form, which auth-middleware.ts already has to know about.
// It is the same address written a way most XFF parsers have never seen, so the
// mapping is unwrapped here. A genuine IPv6 peer is written bare, which is what
// every terminator that writes this header does; the bracketed form belongs to
// the `Forwarded` header's grammar, not this one.
export function forwardedForValue(peer: string | null): string | null {
  if (peer === null || peer.length === 0) return null;
  const mapped = /^::ffff:((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/i.exec(peer);
  return mapped ? mapped[1] : peer;
}

// The headers the app sees. `peerAddress` is the TCP peer of the office's own
// listener - which, on every deployment that has app hostnames, is the local
// terminator rather than the browser. That is deliberate and it is the honest
// answer: slice 2 established that the office socket is directly reachable, so
// an inbound `X-Forwarded-For` is client-settable and cannot be promoted to
// truth by relaying it. An app therefore learns who connected to the office,
// not who the user is. Absent peer -> no header at all, rather than a literal
// "unknown" sitting where an address belongs.
export function buildUpstreamHeaders(
  req: Request,
  appHost: string,
  peerAddress: string | null | undefined,
): Headers {
  const drop = connectionNominated(req.headers);
  const out = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    if (RELAY_OWNED_REQUEST_HEADERS.has(lower)) continue;
    if (lower === "cookie") continue; // handled below
    out.set(name, value);
  }
  const cookie = stripIsomuxCookies(req.headers.get("cookie"));
  if (cookie !== null) out.set("Cookie", cookie);
  // The VERIFIED host - the normalized name the arm matched against the
  // registry - never the raw `Host` line the client wrote.
  out.set("Host", appHost);
  out.set("X-Forwarded-Host", appHost);
  // The app-host arm only exists on an https office, so this is a constant
  // rather than a reading of anything.
  out.set("X-Forwarded-Proto", "https");
  const forwardedFor = forwardedForValue(peerAddress ?? null);
  if (forwardedFor !== null) out.set("X-Forwarded-For", forwardedFor);
  return out;
}

// The headers the browser sees.
export function buildDownstreamHeaders(
  upstream: Response,
  opts: { rewriteEncoding: boolean },
): Headers {
  const drop = connectionNominated(upstream.headers);
  const out = new Headers();
  const rewrite =
    opts.rewriteEncoding &&
    carriesDecodedCoding(upstream.headers.get("content-encoding"));
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    // Set-Cookie is handled below: iterating a Headers object folds repeated
    // field lines into one comma-joined value, and an `Expires` date contains a
    // comma - so re-appending that string would hand the browser one malformed
    // cookie instead of two good ones.
    if (lower === "set-cookie") continue;
    if (rewrite && (lower === "content-encoding" || lower === "content-length"))
      continue;
    out.set(name, value);
  }
  // getSetCookie() is the multi-value read; append is the multi-value write.
  for (const line of upstream.headers.getSetCookie()) {
    out.append("Set-Cookie", line);
  }
  return out;
}

// --- the relay ---------------------------------------------------------------

export interface RelayContext {
  // The live app record, and the normalized hostname the arm resolved it from.
  app: AppRecord;
  host: string;
  // The SAME registry snapshot the arm matched the label against. Passed in
  // rather than re-read: a second read is a second answer, and it is also what
  // makes the supervisor's state cache hit (it keys on the exact set of names
  // asked for, and clears itself on a miss).
  apps: readonly AppRecord[];
  supervisor: AppSupervisor;
  // Read once per relayed request, inside a guard: `requestIP` is a socket
  // question, and a socket that has already gone away is not an error case
  // worth failing a response over.
  peer?: () => string | null | undefined;
  // Test seams, so a stall can be provoked in milliseconds instead of five
  // minutes and a cap in two requests instead of five hundred.
  stallMs?: number;
  ttfbMs?: number;
  maxPerApp?: number;
  maxTotal?: number;
}

function peerAddress(ctx: RelayContext): string | null {
  try {
    return ctx.peer?.() ?? null;
  } catch {
    return null;
  }
}

export async function relayToApp(
  req: Request,
  ctx: RelayContext,
): Promise<Response> {
  // 1. PROOF THE APP IS UP, before anything opens a socket. Not "proof it is
  // down": a missing entry, `activating`, `failed` and `unknown` all refuse,
  // because a port whose app is not running is a port anything on this box can
  // be listening on. An externally-started app may briefly 503 while systemd
  // reports `activating`, which is the right side to be wrong on.
  let runtime: AppRuntime | undefined;
  try {
    runtime = ctx.supervisor
      .states(ctx.apps.map((app) => app.name))
      .get(ctx.app.name);
  } catch (err) {
    console.error("[app-proxy] supervisor unreadable; refusing app:", err);
    return neutral(503, APP_STOPPED_BODY);
  }
  if (runtime?.state !== "running") return neutral(503, APP_STOPPED_BODY);

  // 2. A permit, taken in this same synchronous turn.
  const permit = acquirePermit(permitKey(ctx.app), {
    perApp: ctx.maxPerApp ?? APP_RELAY_MAX_CONCURRENT_PER_APP,
    total: ctx.maxTotal ?? APP_RELAY_MAX_CONCURRENT_TOTAL,
  });
  if (permit === null) return neutral(429, APP_BUSY_BODY);

  // Everything below releases EXACTLY ONCE, on every path out: a rejected
  // fetch, a bodyless response, the end of the stream, an error in it, the
  // client hanging up, a stall, or a throw nobody expected.
  const ac = new AbortController();
  const onClientGone = (): void => ac.abort();
  // Registered FIRST, then the past checked - `addEventListener` does not
  // replay an abort that already happened, and there is real time between the
  // office receiving this request and here (a state lookup and a permit). A
  // client can be gone by now, and starting an upstream request on its behalf
  // would be work nobody is waiting for. Checking before registering would
  // leave the opposite gap.
  req.signal.addEventListener("abort", onClientGone);
  if (req.signal.aborted) ac.abort();
  let ttfbTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by the body guard, which owns the timer's lifetime; kept here so a
  // release from any other path still cannot leave one armed.
  let disarmStall: (() => void) | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (ttfbTimer !== null) clearTimeout(ttfbTimer);
    ttfbTimer = null;
    disarmStall?.();
    disarmStall = null;
    req.signal.removeEventListener("abort", onClientGone);
    permit.release();
  };

  try {
    const url = new URL(req.url);
    // Loopback and the registry's own port, always. Nothing from the request
    // decides where this connects.
    const target = `http://127.0.0.1:${ctx.app.port}${url.pathname}${url.search}`;
    const hasRequestBody = req.method !== "GET" && req.method !== "HEAD";

    ttfbTimer = setTimeout(() => ac.abort(), ctx.ttfbMs ?? APP_RELAY_TTFB_MS);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: buildUpstreamHeaders(req, ctx.host, peerAddress(ctx)),
        // Streamed, never buffered: an upload of any size and an SSE response
        // both have to work, and neither can if a body is read into memory
        // first. A `Content-Length` the client sent is preserved above, so the
        // app sees the same framing its caller used; `Transfer-Encoding` is
        // hop-by-hop and was dropped, so there is no ambiguity between them.
        body: hasRequestBody ? req.body : undefined,
        // A 3xx belongs to the browser: following it here would mean the relay
        // deciding where the user goes, and would silently turn one app's
        // redirect into a request the user never made.
        redirect: "manual",
        signal: ac.signal,
      });
    } catch (err) {
      // Nothing has been written downstream yet, so this is the one failure the
      // relay can still report honestly as a status.
      console.error(
        `[app-proxy] ${ctx.app.hostLabel}: upstream request failed:`,
        err,
      );
      release();
      return neutral(502, APP_UNREACHABLE_BODY);
    } finally {
      // Headers are in (or will never come). Whatever happens to the body from
      // here is the stall guard's business, not this timer's.
      if (ttfbTimer !== null) clearTimeout(ttfbTimer);
      ttfbTimer = null;
    }

    const bodyless =
      req.method === "HEAD" ||
      NULL_BODY_STATUSES.has(upstream.status) ||
      upstream.body === null;
    const headers = buildDownstreamHeaders(upstream, {
      // A HEAD or a 304 carries metadata ABOUT a representation it does not
      // contain, so its `Content-Encoding` and `Content-Length` describe bytes
      // Bun never saw, let alone decoded. Rewriting them there would corrupt a
      // cache validation with a length of a body that was never sent.
      rewriteEncoding: !bodyless,
    });

    if (bodyless) {
      // Cancel rather than leave a body half-read holding the connection.
      upstream.body?.cancel().catch(() => {});
      release();
      return new Response(null, { status: upstream.status, headers });
    }

    const guarded = guardBody(upstream.body!, {
      stallMs: ctx.stallMs ?? APP_RELAY_STALL_MS,
      onStall: () => ac.abort(),
      onDone: release,
    });
    disarmStall = guarded.disarm;
    return new Response(guarded.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    // Nothing here is expected to throw - header rewriting, taking the reader,
    // building the Response. But if one of them does, the upstream request may
    // already be live, and releasing the permit while leaving it running would
    // be accounting that has lost track of a real connection. Abort first.
    console.error(`[app-proxy] ${ctx.app.hostLabel}: relay failed:`, err);
    ac.abort();
    release();
    return neutral(502, APP_UNREACHABLE_BODY);
  }
}

// The response body, with a timer that resets on every chunk.
//
// Once these bytes are on the wire the status is spent: a connection reset
// halfway through a 200 cannot be retroactively turned into a 502, and pretending
// otherwise would mean buffering the whole response to find out. So a failure
// here terminates the stream and the client sees a truncated response, which is
// exactly what it is - the same thing it would see from the app directly.
function guardBody(
  upstream: ReadableStream<Uint8Array>,
  opts: { stallMs: number; onStall: () => void; onDone: () => void },
): { body: ReadableStream<Uint8Array>; disarm: () => void } {
  const reader = upstream.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  // Always through disarm first: an armed timer that is merely forgotten still
  // fires, and would abort a stream that is running perfectly well.
  const arm = (): void => {
    disarm();
    timer = setTimeout(opts.onStall, opts.stallMs);
  };
  const finish = (): void => {
    disarm();
    opts.onDone();
  };
  const body = new ReadableStream<Uint8Array>({
    // ARMED ONLY ACROSS A PENDING READ, which is the whole distinction this
    // guard has to draw. "The app has produced nothing" and "the client has not
    // consumed what the app produced" look identical from a timer that runs
    // continuously, and they are opposites: the second one is BACKPRESSURE, the
    // thing streaming exists to do. A chunk sitting in the downstream queue
    // waiting for a slow reader must not kill a healthy app.
    //
    // It also keeps the abort path honest. An abort can only be noticed by a
    // read that rejects, so arming while no read is outstanding could fire a
    // timer that nothing catches - aborting the upstream and leaving this
    // stream, and its permit, waiting for a client that is still perfectly
    // happy.
    async pull(controller) {
      arm();
      try {
        const { done, value } = await reader.read();
        disarm();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    // The client hung up, or the office tore the response down. Cancel the
    // upstream reader AND abort the fetch: cancelling alone leaves the request
    // running at the app, which is the half-closed state this whole slice is
    // meant not to produce.
    cancel(reason) {
      opts.onStall();
      finish();
      reader.cancel(reason).catch(() => {});
    },
  });
  return { body, disarm };
}
