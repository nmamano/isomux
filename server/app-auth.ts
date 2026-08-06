// The sign-in handshake for registered-app hostnames (phase 3, slice 4).
//
// An app lives at `hello.office.example` and the office at `office.example`.
// The office session cookie is host-only, deliberately - that is what keeps a
// scratch app built by an agent from being able to act as the boss - so it
// never reaches the app host, and the app host therefore has no way to know
// who is knocking. This module is how it finds out, in three hops, none of
// which lets the office cookie leave the office origin:
//
//   1. the app host bounces the request to the office - only a GET that could
//      complete the round trip - naming the app and the path asked for;
//   2. the office, where the session cookie IS readable, mints a single-use
//      code and redirects back to the app host carrying only that code;
//   3. the app host redeems the code, sets its OWN cookie for that one
//      hostname, and sends the browser to the path from step 1.
//
// Afterwards the app host has a cookie of its own, bound to the app and to the
// office session that vouched for it, and revalidated against that session on
// every request - so signing out of the office closes every app with it.
//
// Specified in internal-docs/port-proxy-design.md ("Auth handshake"). Nothing
// here relays app bytes; slice 5 does that, below this module.
//
// WHAT IS IN A URL, AND WHY THAT IS THE WHOLE THREAT MODEL. A code has to
// cross an origin boundary, and the only way across is a URL - so for one
// round trip a credential lives somewhere a browser writes down. Every rule in
// this file follows from that: 45-second lifetime, one redemption ever, bound
// to the exact app host and to the minting session, `Referrer-Policy:
// no-referrer` on every response whose own URL holds it, `Cache-Control:
// no-store` everywhere, the path kept server-side so it is not a second thing
// to leak, and not one line of logging that touches a URL.

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { appRegistry as productionRegistry } from "./app-registry.ts";
import type { AppRegistry } from "./app-registry.ts";
import { buildPublicOrigin, revalidateByHash } from "./auth.ts";
import type { SessionLookup } from "./auth.ts";
import type { AppRecord } from "../shared/types.ts";
import {
  AUTH_REQUIRED_BODY,
  BAD_REQUEST_BODY,
  MINT_LIMITED_BODY,
  SIGN_IN_FAILED_BODY,
  handshake,
  handshakeRedirect,
  neutralNotFound,
} from "./app-host-responses.ts";

// --- constants (plain named values, no env vars) -----------------------------

// The app-host route the handshake lands on, inside the `/__isomux` prefix
// slice 3 reserved for it. An app can never serve or shadow this path.
export const APP_AUTH_PATH = "/__isomux/auth";

// The office route that mints a code. Behind the office's ordinary auth wall,
// so an unauthenticated visitor meets the normal login page here.
export const APP_MINT_PATH = "/auth/app";

// The app-host cookie. `__Host-` is browser-enforced: Secure, Path=/, and no
// Domain attribute, which makes it host-only in a way a sibling app cannot
// override. One name serves every app because host-only cookies of the same
// name on different hostnames are different cookies - and the record behind it
// names its app anyway, so a cookie that somehow arrived at the wrong host
// still fails.
export const APP_COOKIE_NAME = "__Host-isomux_app";

// Code lifetime. The design doc's 30-60s: long enough for a browser to follow
// two redirects on a slow phone, short enough that a code copied out of a
// history entry or a proxy log is dead before anyone reads it.
export const APP_CODE_TTL_MS = 45_000;

// How long an app session lasts before the handshake runs again. Generous
// because it is not the security boundary: the office session behind it is
// revalidated on EVERY request, so a sign-out or a revoke closes the app
// immediately regardless of this number. It only decides how often a user
// pays one invisible redirect.
export const APP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Mint budget, per office session. Also the loop breaker: if a browser refuses
// the app cookie - an office declaring https while its terminator actually
// serves plain http - the bounce/mint pair would otherwise repeat forever.
export const APP_MINT_MAX_PER_WINDOW = 20;
export const APP_MINT_WINDOW_MS = 60_000;

// Redeem budget, per app label. Nuisance control, not the boundary: guessing a
// 256-bit code is not a thing that happens. Keyed by label because there is no
// usable per-caller key - the office sits behind a terminator on the same box,
// so every external request arrives from loopback, and slice 2 established
// that `X-Forwarded-*` is not trustworthy here. The cost of that choice,
// stated rather than hidden: someone hammering one app's hostname can spend
// that app's redeem budget for a minute, and its legitimate users wait.
export const APP_REDEEM_MAX_PER_WINDOW = 60;
export const APP_REDEEM_WINDOW_MS = 60_000;

// Table ceilings, so churn cannot grow memory without bound.
const MAX_PENDING_CODES = 512;
const MAX_APP_SESSIONS = 4096;
const MAX_TRACKED_LIMITER_KEYS = 1024;

// A return path is a path, not a URL, and 2KB is far past any real one.
const MAX_RETURN_PATH_LENGTH = 2048;

// Codes and cookie values are both 32 random bytes in base64url (43 chars).
// The cap and the alphabet are checked BEFORE hashing, so an attacker cannot
// make the server hash a megabyte, and a malformed value never reaches a table
// at all.
const MAX_TOKEN_LENGTH = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

const TOKEN_BYTES = 32; // 256 bits, matching the office session id

// --- primitives -------------------------------------------------------------

function randomTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Constant-time compare of two sha256 hex digests. The Map lookup already
// found the row; this is the belt on top of it, so a near-miss cannot be
// distinguished by timing. Same shape as auth.ts's safeHashEq.
function safeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- fixed-window rate limiting ---------------------------------------------

// Same shape as ready-limiter.ts, twice, with the failure posture as a
// constructor argument because the two sides fail in opposite directions:
//
//   mint  - fail CLOSED when the table is full. Refusing to mint is a 429 the
//           user can retry; minting untracked would remove the only bound on
//           a redirect loop.
//   redeem - fail OPEN. It guards a 256-bit code, so it is nuisance control,
//           and a full table failing closed would lock every app's users out
//           of signing in at all.
class FixedWindowLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
    private readonly failOpenWhenFull: boolean,
  ) {}

  allow(key: string, now: number): boolean {
    const w = this.windows.get(key);
    if (w && now - w.start < this.windowMs) {
      w.count++;
      return w.count <= this.maxPerWindow;
    }
    if (!w && this.windows.size >= MAX_TRACKED_LIMITER_KEYS) {
      for (const [k, win] of this.windows) {
        if (now - win.start >= this.windowMs) this.windows.delete(k);
      }
      if (this.windows.size >= MAX_TRACKED_LIMITER_KEYS) {
        return this.failOpenWhenFull;
      }
    }
    this.windows.set(key, { start: now, count: 1 });
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}

const mintLimiter = new FixedWindowLimiter(
  APP_MINT_WINDOW_MS,
  APP_MINT_MAX_PER_WINDOW,
  false,
);
const redeemLimiter = new FixedWindowLimiter(
  APP_REDEEM_WINDOW_MS,
  APP_REDEEM_MAX_PER_WINDOW,
  true,
);

// --- the two tables ---------------------------------------------------------

// A minted, not-yet-redeemed code. `codeHash` is stored alongside being the
// map key so the constant-time re-check after a lookup has something to
// compare against; the raw code is never stored anywhere.
export interface PendingCode {
  codeHash: string;
  // The app this code opens, as the issuance tuple the registry treats as an
  // app's identity - not the label alone. A label is unique forever, so the
  // generation is belt: it makes a cookie from `hello` gen 1 structurally
  // incapable of vouching for a later `hello`.
  label: string;
  hostGen: number;
  // The exact normalized hostname the code may be redeemed at.
  appHost: string;
  // The office session that minted it. The app session inherits this, and it
  // is revalidated on every subsequent request.
  officeSessionHash: string;
  // Where to send the browser after redemption. Kept HERE rather than in the
  // callback URL (port-proxy-design.md: "code only, no path") so it is
  // validated exactly once, cannot be swapped between the two hops, and is
  // not a second value written into a browser's history.
  returnPath: string;
  expiresAt: number;
}

interface AppSession {
  tokenHash: string;
  label: string;
  hostGen: number;
  officeSessionHash: string;
  expiresAt: number;
}

const pendingCodes = new Map<string, PendingCode>();
const appSessions = new Map<string, AppSession>();

function pruneExpired<T extends { expiresAt: number }>(
  table: Map<string, T>,
  now: number,
): void {
  for (const [key, row] of table) {
    if (row.expiresAt <= now) table.delete(key);
  }
}

// --- return-path validation (pure) ------------------------------------------

// `r` is a path on the app host and nothing else. The rules exist so that a
// crafted value cannot turn the handshake into an open redirect, and so that
// the value can be put in a `Location` header without any further escaping:
//
//   - one leading `/`, never two: `//evil.example` is a protocol-relative URL
//     and a browser would leave the app host entirely.
//   - no backslash anywhere: some browsers have historically read `/\evil` and
//     `\\evil` as authority forms.
//   - printable ASCII only, so CR and LF cannot split the response header and
//     no percent-decoding surprise reaches the wire. Browsers percent-encode
//     everything else already.
//   - no `#`: a real fragment never reaches a server, so one arriving here was
//     hand-written.
//
// Returns the path unchanged, or null for "refuse". Absent means `/`. An
// invalid value is REFUSED rather than quietly rewritten to `/`: our own
// bounce always builds a valid one, so an invalid one is either hand-crafted
// or a bug on our side, and a silent rewrite would hide both.
export function validateReturnPath(raw: string | null): string | null {
  if (raw === null) return "/";
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // 0x20 (space) is excluded along with the controls: a space in a Location
    // header is not something to pass along.
    if (code <= 0x20 || code >= 0x7f) return null;
  }
  if (raw.includes("\\") || raw.includes("#")) return null;
  return raw;
}

// --- who may start the handshake (pure) -------------------------------------

// Only a request that could actually FINISH the handshake is sent into it.
// Manager ruling, 2026-08-06 (final, after two revisions), and the first half
// of it is about correctness rather than security:
//
//   - a 302 on a POST loses the method and the body, so an unauthenticated
//     form submission would arrive at the app as a GET with nothing in it;
//   - a subresource or an XHR cannot complete a handshake that ends in a
//     cookie plus a navigation. It would fail as an opaque CORS error instead
//     of showing the user a sign-in;
//   - HEAD is out too: it could start the flow but the callback is GET-only, so
//     a client that preserved the method across the redirect would land on a
//     404 halfway through. Better to refuse at the first hop than to strand it
//     at the second.
//
// GET, then, and one of two positive signals:
//
//   1. `Sec-Fetch-Mode: navigate` AND `Sec-Fetch-Dest: document`, compared
//      exactly. These are browser-attested - page JavaScript cannot set them -
//      so when they are present they are evidence. Present but not that exact
//      pair (a `cors` fetch, a `script` destination, one header without the
//      other) is a request that is provably NOT a navigation, or ambiguous
//      either way: refused.
//
//   2. No Sec-Fetch metadata at all. Deliberate, and NOT because such a client
//      is safe - a browser old enough to omit Fetch Metadata can still be made
//      to issue a cross-site request and can still carry cookies. Its absence
//      is precisely why the server cannot tell that request's context apart
//      from a navigation's. The ruling is that refusing it buys nothing here:
//      the worst it enables is the cross-site mint already accepted as a design
//      consequence of GET /auth/app (the code is unreadable to the attacker and
//      the cookie it yields is bound to the victim's own session, for an app
//      that user may already open), while refusing would mean a client that
//      never sends the headers cannot sign in to an app AT ALL. Strictness
//      where evidence exists; permissiveness only where evidence cannot.
export function mayInitiateHandshake(req: Request): boolean {
  if (req.method !== "GET") return false;
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  const site = req.headers.get("sec-fetch-site");
  const user = req.headers.get("sec-fetch-user");
  // Any Sec-Fetch header at all means this client speaks Fetch Metadata, so
  // the exact pair is required. All four are checked rather than the two we
  // read: a request carrying only `Sec-Fetch-Site` is a client whose silence
  // about mode and dest is meaningful.
  if (mode === null && dest === null && site === null && user === null) {
    return true;
  }
  return mode === "navigate" && dest === "document";
}

// --- the app cookie ---------------------------------------------------------

// Attributes in the same order auth.ts writes the office cookie. `Secure` is
// unconditional: the app-host arm only exists on an https office, and the
// `__Host-` prefix makes a browser drop the cookie without it.
function appCookieLine(value: string, maxAgeSec: number): string {
  return [
    `${APP_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    "Secure",
  ].join("; ");
}

export function appCookieClearLine(): string {
  return appCookieLine("", 0);
}

// The app cookie as it arrived. `null` means ABSENT; a cookie that is present
// with an empty value is `""`, and that distinction is load-bearing twice over
// - it is the same one readSessionCookies draws for the office cookie. An empty
// value never authenticates, but it IS something sitting in the browser, so it
// has to be cleared rather than treated as nothing to clean up.
//
// First occurrence wins per name: a browser sends the more specific match first
// and a later duplicate must not overwrite it.
export function readAppCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() !== APP_COOKIE_NAME) continue;
    return part.slice(idx + 1).trim();
  }
  return null;
}

// --- the code store ---------------------------------------------------------

export type MintFailure = "rate_limited" | "no_capacity";

export function mintAppCode(
  input: {
    label: string;
    hostGen: number;
    appHost: string;
    officeSessionHash: string;
    returnPath: string;
  },
  now: number = Date.now(),
): { code: string } | { error: MintFailure } {
  if (!mintLimiter.allow(input.officeSessionHash, now)) {
    return { error: "rate_limited" };
  }
  pruneExpired(pendingCodes, now);
  if (pendingCodes.size >= MAX_PENDING_CODES) {
    // Fail closed rather than evicting somebody else's live code: a full table
    // is a 429 the user retries, and evicting would turn one user's flood into
    // another user's broken sign-in.
    return { error: "no_capacity" };
  }
  const code = randomTokenValue();
  const codeHash = hashOf(code);
  pendingCodes.set(codeHash, {
    codeHash,
    label: input.label,
    hostGen: input.hostGen,
    appHost: input.appHost,
    officeSessionHash: input.officeSessionHash,
    returnPath: input.returnPath,
    expiresAt: now + APP_CODE_TTL_MS,
  });
  return { code };
}

// Redeem, in the one order that makes single-use unconditional:
//
//   syntactic bound -> hash -> get -> DELETE -> charge the limiter -> validate
//
// Deleting before anything else can fail is what makes a code single-use even
// under a race or a refusal: every presentation of a well-formed code consumes
// it, including one that arrives while the app's redeem budget is spent. The
// alternative - check the limiter first - would leave a valid code alive and
// replayable because somebody else was noisy.
export function redeemAppCode(
  rawCode: string | null,
  ctx: { host: string; label: string; now?: number },
): PendingCode | null {
  const now = ctx.now ?? Date.now();
  if (
    rawCode === null ||
    rawCode.length === 0 ||
    rawCode.length > MAX_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(rawCode)
  ) {
    return null;
  }
  const codeHash = hashOf(rawCode);
  const record = pendingCodes.get(codeHash);
  pendingCodes.delete(codeHash);
  if (!redeemLimiter.allow(ctx.label, now)) return null;
  if (!record) return null;
  if (!safeHashEq(record.codeHash, codeHash)) return null;
  if (record.expiresAt <= now) return null;
  if (record.appHost !== ctx.host) return null;
  if (record.label !== ctx.label) return null;
  return record;
}

// --- the app-session store --------------------------------------------------

// Start a session for a redeemed code. The deadline is the office session's
// absolute cap or this session's own TTL, whichever comes first: an app
// session must never outlive the office session that vouched for it, and
// nothing here may extend that session's life.
//
// Returns null when there is no positive lifetime left - a session inside its
// last second. Emitting `Max-Age=0` would be a cookie the browser deletes on
// arrival, i.e. reporting success and handing back nothing.
export function startAppSession(
  input: {
    label: string;
    hostGen: number;
    officeSessionHash: string;
    absoluteExpiresAt: number;
  },
  now: number = Date.now(),
): { token: string; maxAgeSec: number } | null {
  const deadline = Math.min(now + APP_SESSION_TTL_MS, input.absoluteExpiresAt);
  const maxAgeSec = Math.floor((deadline - now) / 1000);
  if (maxAgeSec <= 0) return null;
  pruneExpired(appSessions, now);
  if (appSessions.size >= MAX_APP_SESSIONS) {
    // Evict the row closest to expiry. Unlike a code, an app session can be
    // re-established invisibly (one redirect), so failing closed here would
    // cost availability for nothing.
    let oldestKey: string | null = null;
    let oldestExpiry = Infinity;
    for (const [key, row] of appSessions) {
      if (row.expiresAt < oldestExpiry) {
        oldestExpiry = row.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) appSessions.delete(oldestKey);
  }
  const token = randomTokenValue();
  const tokenHash = hashOf(token);
  appSessions.set(tokenHash, {
    tokenHash,
    label: input.label,
    hostGen: input.hostGen,
    officeSessionHash: input.officeSessionHash,
    expiresAt: deadline,
  });
  return { token, maxAgeSec };
}

// Is this cookie a live session for this exact app? Fail-closed at every step,
// and the last step is the one that matters: the office session is revalidated
// by hash on EVERY request, so a sign-out, a revoke, an expiry or a deleted
// user closes the app immediately rather than at the cookie's leisure.
export function validateAppSession(
  rawCookie: string | null,
  ctx: { label: string; hostGen: number; now?: number },
): boolean {
  // Present-but-empty lands here as `""` and is refused like any other value
  // that is not a live token.
  if (rawCookie === null || rawCookie.length === 0) return false;
  if (rawCookie.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(rawCookie)) {
    return false;
  }
  const now = ctx.now ?? Date.now();
  const tokenHash = hashOf(rawCookie);
  const row = appSessions.get(tokenHash);
  if (!row) return false;
  if (!safeHashEq(row.tokenHash, tokenHash)) return false;
  if (row.expiresAt <= now) {
    appSessions.delete(tokenHash);
    return false;
  }
  if (row.label !== ctx.label || row.hostGen !== ctx.hostGen) return false;
  if (revalidateByHash(row.officeSessionHash) === null) {
    // The office session is gone. The app session is orphaned and will never
    // be valid again, so drop the row rather than re-checking it forever.
    appSessions.delete(tokenHash);
    return false;
  }
  return true;
}

// How many minted codes are still outstanding. Test-only, and it exists for one
// assertion that cannot be made from the outside: that presenting a code
// CONSUMES it even when the presentation is refused. Both orders of the delete
// and the rate-limit check return the same refusal, so the difference is only
// visible in the table.
export function _testPendingCodeCount(): number {
  return pendingCodes.size;
}

export function _testResetAppAuth(): void {
  pendingCodes.clear();
  appSessions.clear();
  mintLimiter.reset();
  redeemLimiter.reset();
}

// --- office side: GET /auth/app?app=<label>&r=<path> -------------------------

// Exactly one value per parameter. A repeated parameter is a request somebody
// built by hand, and "first one wins" is the kind of ambiguity that turns into
// a bypass when two layers disagree about which one won.
function singleParam(url: URL, name: string): string | null | undefined {
  const all = url.searchParams.getAll(name);
  if (all.length === 0) return null;
  if (all.length > 1) return undefined; // malformed
  return all[0];
}

function liveAppByLabel(
  registry: AppRegistry,
  label: string,
): AppRecord | null {
  try {
    return registry.list().find((app) => app.hostLabel === label) ?? null;
  } catch (err) {
    // A registry that cannot be read cannot vouch for a label. Fail closed,
    // and indistinguishably from a label that does not exist.
    console.error("[app-auth] app registry unreadable; refusing label:", err);
    return null;
  }
}

// Mints a code for a signed-in office user and redirects to the app host.
//
// The CALLER has already established the identity: this runs behind the
// office's auth wall, so an unauthenticated visitor met the login page before
// reaching here, and `session` is the caller's own cookie session.
//
// The wall does NOT bring a CSRF check with it - authenticate() checks Origin
// only on unsafe methods - so this GET can be triggered cross-site by any page
// a signed-in user visits. Accepted deliberately (manager ruling, 2026-08-06):
// the attacker cannot read the code, the cookie it produces is bound to the
// victim's own session and to an app that user may already open, and the cost
// is a slice of that session's mint budget. It is the shape every SSO
// authorize endpoint has.
export function handleAppMintRequest(
  req: Request,
  url: URL,
  session: SessionLookup,
  opts: {
    appHostDomain: string | null;
    registry?: AppRegistry;
    now?: number;
  },
): Response {
  // Defined as a GET. Any other method is not this route at all.
  if (req.method !== "GET") return neutralNotFound();
  // No app-host domain means this office has no app hostnames, so there is no
  // origin to send anybody to. Same refusal as an unknown label: the office's
  // deployment shape is not something to report.
  if (opts.appHostDomain === null) return neutralNotFound();

  const labelParam = singleParam(url, "app");
  const rParam = singleParam(url, "r");
  if (labelParam === undefined || rParam === undefined) {
    return handshake(400, BAD_REQUEST_BODY);
  }
  if (labelParam === null) return neutralNotFound();

  const registry = opts.registry ?? productionRegistry;
  const app = liveAppByLabel(registry, labelParam);
  if (app === null) return neutralNotFound();

  const returnPath = validateReturnPath(rParam);
  if (returnPath === null) return handshake(400, BAD_REQUEST_BODY);

  // Built from the registry's own label and the boot-frozen domain - never
  // from a request value - so there is nothing here to point elsewhere.
  const appHost = `${app.hostLabel}.${opts.appHostDomain}`;
  const minted = mintAppCode(
    {
      label: app.hostLabel,
      hostGen: app.hostGen,
      appHost,
      officeSessionHash: session.sessionIdHash,
      returnPath,
    },
    opts.now,
  );
  if ("error" in minted) return handshake(429, MINT_LIMITED_BODY);

  return handshakeRedirect(
    `https://${appHost}${APP_AUTH_PATH}?code=${encodeURIComponent(minted.code)}`,
  );
}

// --- app-host side ----------------------------------------------------------

export interface AppHostContext {
  // The request's normalized Host, and the live app it resolved to. Both come
  // from the arm in app-hosts.ts, which has already classified the host and
  // confirmed the app is live - this module never re-derives either.
  host: string;
  app: AppRecord;
  now?: number;
}

// GET /__isomux/auth?code=... on an app host: redeem, set the cookie, go to
// the path the code remembers.
export function handleAppAuthRedeem(
  req: Request,
  ctx: AppHostContext,
): Response {
  const now = ctx.now ?? Date.now();
  const url = new URL(req.url);
  const codeParam = singleParam(url, "code");
  if (codeParam === undefined || codeParam === null) {
    return handshake(400, SIGN_IN_FAILED_BODY);
  }
  const record = redeemAppCode(codeParam, {
    host: ctx.host,
    label: ctx.app.hostLabel,
    now,
  });
  if (record === null) return handshake(400, SIGN_IN_FAILED_BODY);
  // The generation is checked against the app that is live NOW, not the one
  // that was live at mint time: a code minted seconds before a delete and a
  // re-registration must not open the successor.
  if (record.hostGen !== ctx.app.hostGen) {
    return handshake(400, SIGN_IN_FAILED_BODY);
  }
  // The office session has to still be alive, and its absolute cap is what
  // bounds the app session. Revalidating here rather than trusting the code
  // closes the window between mint and redeem.
  const office = revalidateByHash(record.officeSessionHash);
  if (office === null) return handshake(400, SIGN_IN_FAILED_BODY);

  const started = startAppSession(
    {
      label: ctx.app.hostLabel,
      hostGen: ctx.app.hostGen,
      officeSessionHash: record.officeSessionHash,
      absoluteExpiresAt: office.absoluteExpiresAt,
    },
    now,
  );
  if (started === null) return handshake(400, SIGN_IN_FAILED_BODY);

  return handshakeRedirect(record.returnPath, [
    appCookieLine(started.token, started.maxAgeSec),
  ]);
}

// The gate in front of everything an app host serves. Returns null when the
// caller holds a live app session and the request may proceed (to the
// placeholder today, to the app itself in slice 5).
//
// Otherwise: a request that may start the handshake is bounced into it, and
// anything else is refused. When a cookie was presented and rejected, the refusal
// clears it - a dead credential must not sit in a browser waiting to confuse
// its owner, which is the lesson slice 2's logout blocker taught.
export function appHostAuthGate(
  req: Request,
  ctx: AppHostContext,
): Response | null {
  const rawCookie = readAppCookie(req);
  if (
    validateAppSession(rawCookie, {
      label: ctx.app.hostLabel,
      hostGen: ctx.app.hostGen,
      now: ctx.now,
    })
  ) {
    return null;
  }
  // PRESENT and rejected -> clear it, whatever the reason it failed (expired,
  // revoked, another app's, or empty). Absent -> nothing to clear.
  const clear = rawCookie === null ? [] : [appCookieClearLine()];
  if (!mayInitiateHandshake(req)) {
    return handshake(
      401,
      AUTH_REQUIRED_BODY,
      clear.length > 0 ? { "Set-Cookie": clear[0] } : undefined,
    );
  }
  const url = new URL(req.url);
  const target =
    `${buildPublicOrigin().origin}${APP_MINT_PATH}` +
    `?app=${encodeURIComponent(ctx.app.hostLabel)}` +
    `&r=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
  return handshakeRedirect(target, clear);
}
