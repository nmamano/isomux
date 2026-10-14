// The sign-in handshake for registered-app hostnames.
//
// An app lives at `hello.office.example` and the office at `office.example`.
// The office session cookie is host-only, deliberately - that is what keeps a
// scratch app built by an agent from being able to act as the member - so it
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
// here relays app bytes; the relay does that below this module.
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
import { appRegistrationGeneration } from "./app-registry.ts";
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

// The app-host route the handshake lands on, inside the reserved `/__isomux`
// prefix. An app can never serve or shadow this path.
export const APP_AUTH_PATH = "/__isomux/auth";

// The office route that mints a code. Behind the office's ordinary auth wall,
// so an unauthenticated visitor meets the normal login page here.
export const APP_MINT_PATH = "/auth/app";

// Protocol value shared with the office wrapper. No app or member data crosses
// the frame boundary, and unknown labels use the same response.
export const APP_SESSION_REQUIRED_MESSAGE = "isomux:app-session-required";

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

// Redeem budget, per app label and client. Nuisance control, not the boundary:
// guessing a 256-bit code is not a thing that happens, so a budget per client
// does not make guessing possible. The client is the address
// server/proxy-trust.ts resolves: behind a declared proxy, the address the
// proxy wrote into X-Forwarded-For, so one noisy caller spends only its own
// budget. With an undeclared proxy every caller shares the proxy's address,
// and someone hammering one app's hostname can spend that app's redeem budget
// for a minute.
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

// A minted, not-yet-redeemed code. `codeHash` is stored alongside being the
// map key so the constant-time re-check after a lookup has something to
// compare against; the raw code is never stored anywhere.
export interface PendingCode {
  codeHash: string;
  // The public label lineage and the changing server-held registration
  // identity. A reused label is intentional; its old credential must still be
  // structurally unable to vouch for the replacement.
  label: string;
  hostGen: number;
  registrationGen: number;
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
  wrapperReturn?: boolean;
  expiresAt: number;
}

interface AppSession {
  tokenHash: string;
  label: string;
  hostGen: number;
  registrationGen: number;
  officeSessionHash: string;
  expiresAt: number;
}

// Both tables are process-local and die on restart. Legacy registration
// identity derivation in app-registry.ts relies on that fact: a rollback and
// restart cannot leave a session alive to match a derived identity. If either
// table becomes persistent, that derivation must change first.
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

// Only a request that could actually FINISH the handshake is sent into it.
// The first half of this rule is about correctness rather than security:
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

export type MintFailure = "rate_limited" | "no_capacity";

export function mintAppCode(
  input: {
    label: string;
    hostGen: number;
    registrationGen?: number;
    appHost: string;
    officeSessionHash: string;
    returnPath: string;
    wrapperReturn?: boolean;
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
    registrationGen: input.registrationGen ?? input.hostGen,
    appHost: input.appHost,
    officeSessionHash: input.officeSessionHash,
    returnPath: input.returnPath,
    wrapperReturn: input.wrapperReturn,
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
  ctx: {
    host: string;
    label: string;
    client: string;
    registrationGen?: number;
    now?: number;
  },
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
  if (!redeemLimiter.allow(`${ctx.label} ${ctx.client}`, now)) return null;
  if (!record) return null;
  if (!safeHashEq(record.codeHash, codeHash)) return null;
  if (record.expiresAt <= now) return null;
  if (record.appHost !== ctx.host) return null;
  if (record.label !== ctx.label) return null;
  if (record.registrationGen !== (ctx.registrationGen ?? record.hostGen))
    return null;
  return record;
}

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
    registrationGen?: number;
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
    registrationGen: input.registrationGen ?? input.hostGen,
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
  ctx: {
    label: string;
    hostGen: number;
    registrationGen?: number;
    now?: number;
  },
): { userId: string; officeSessionHash: string } | null {
  // Present-but-empty lands here as `""` and is refused like any other value
  // that is not a live token.
  if (rawCookie === null || rawCookie.length === 0) return null;
  if (rawCookie.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(rawCookie)) {
    return null;
  }
  const now = ctx.now ?? Date.now();
  const tokenHash = hashOf(rawCookie);
  const row = appSessions.get(tokenHash);
  if (!row) return null;
  if (!safeHashEq(row.tokenHash, tokenHash)) return null;
  if (row.expiresAt <= now) {
    appSessions.delete(tokenHash);
    return null;
  }
  if (
    row.label !== ctx.label ||
    row.hostGen !== ctx.hostGen ||
    row.registrationGen !== (ctx.registrationGen ?? ctx.hostGen)
  )
    return null;
  const office = revalidateByHash(row.officeSessionHash);
  if (office === null) {
    // The office session is gone. The app session is orphaned and will never
    // be valid again, so drop the row rather than re-checking it forever.
    appSessions.delete(tokenHash);
    return null;
  }
  return { userId: office.userId, officeSessionHash: row.officeSessionHash };
}

// Server readiness is not proof that the browser kept its app cookie. The
// framed refusal signal covers that case without exposing either credential.
export function appSessionExpiresAt(
  app: AppRecord,
  officeSessionHash: string | null,
  now = Date.now(),
): number | null {
  if (!officeSessionHash) return null;
  const office = revalidateByHash(officeSessionHash);
  if (!office) return null;
  let expiresAt: number | null = null;
  for (const row of appSessions.values()) {
    if (
      row.officeSessionHash === officeSessionHash &&
      row.label === app.hostLabel &&
      row.hostGen === app.hostGen &&
      row.registrationGen === appRegistrationGeneration(app) &&
      row.expiresAt > now
    ) {
      expiresAt = Math.max(
        expiresAt ?? 0,
        Math.min(row.expiresAt, office.absoluteExpiresAt),
      );
    }
  }
  return expiresAt;
}

// How many minted codes are still outstanding. Test-only, and it exists for one
// assertion that cannot be made from the outside: that presenting a code
// CONSUMES it even when the presentation is refused. Both orders of the delete
// and the rate-limit check return the same refusal, so the difference is only
// visible in the table.
export function _testPendingCodeCount(): number {
  return pendingCodes.size;
}

// Minted screenshot codes not yet redeemed or released. Test-only: "this URL
// minted nothing" is not visible from the URL Chrome was given alone.
export function _testPreviewCodeCount(): number {
  return previewCodes.size;
}

export function _testResetAppAuth(): void {
  pendingCodes.clear();
  appSessions.clear();
  mintLimiter.reset();
  redeemLimiter.reset();
  previewCodes.clear();
  previewSessions.clear();
  previewMintLimiter.reset();
  previewRedeemLimiter.reset();
}

/** Synchronous by construction: delete cannot free a name across an await. */
export function invalidateAppRegistration(
  label: string,
  registrationGen: number,
): void {
  for (const [key, row] of pendingCodes) {
    if (row.label === label && row.registrationGen === registrationGen)
      pendingCodes.delete(key);
  }
  for (const [key, row] of appSessions) {
    if (row.label === label && row.registrationGen === registrationGen)
      appSessions.delete(key);
  }
  for (const table of [previewCodes, previewSessions] as const) {
    for (const [key, row] of table) {
      if (row.label === label && row.registrationGen === registrationGen)
        table.delete(key);
    }
  }
}

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
// a signed-in user visits. Accepted deliberately:
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
    canAccess: (app: AppRecord, userId: string) => boolean;
    now?: number;
  },
): Response {
  if (req.method !== "GET") return neutralNotFound();
  // No app-host domain means this office has no app hostnames, so there is no
  // origin to send anybody to. Same refusal as an unknown label: the office's
  // deployment shape is not something to report.
  if (opts.appHostDomain === null) return neutralNotFound();

  const labelParam = singleParam(url, "app");
  const rParam = singleParam(url, "r");
  const modeParam = singleParam(url, "mode");
  const registrationParam = singleParam(url, "registration");
  if (
    labelParam === undefined ||
    rParam === undefined ||
    modeParam === undefined ||
    registrationParam === undefined ||
    (modeParam !== null && modeParam !== "wrapper")
  ) {
    return handshake(400, BAD_REQUEST_BODY);
  }
  if (labelParam === null) return neutralNotFound();

  const registry = opts.registry ?? productionRegistry;
  const app = liveAppByLabel(registry, labelParam);
  if (app === null) return neutralNotFound();
  if (!opts.canAccess(app, session.userId)) return neutralNotFound();
  if (
    modeParam === "wrapper" &&
    registrationParam !== String(appRegistrationGeneration(app))
  )
    return neutralNotFound();

  const returnPath = validateReturnPath(rParam);
  if (returnPath === null) return handshake(400, BAD_REQUEST_BODY);

  // Built from the registry's own label and the boot-frozen domain - never
  // from a request value - so there is nothing here to point elsewhere.
  const appHost = `${app.hostLabel}.${opts.appHostDomain}`;
  const minted = mintAppCode(
    {
      label: app.hostLabel,
      hostGen: app.hostGen,
      registrationGen: appRegistrationGeneration(app),
      appHost,
      officeSessionHash: session.sessionIdHash,
      returnPath,
      wrapperReturn: modeParam === "wrapper",
    },
    opts.now,
  );
  if ("error" in minted) return handshake(429, MINT_LIMITED_BODY);

  return handshakeRedirect(
    `https://${appHost}${APP_AUTH_PATH}?code=${encodeURIComponent(minted.code)}`,
  );
}

export interface AppHostContext {
  // The request's normalized Host, and the live app it resolved to. Both come
  // from the arm in app-hosts.ts, which has already classified the host and
  // confirmed the app is live - this module never re-derives either.
  host: string;
  app: AppRecord;
  canAccess: (app: AppRecord, userId: string) => boolean;
  now?: number;
}

// GET /__isomux/auth?code=... on an app host: redeem, set the cookie, go to
// the path the code remembers.
export function handleAppAuthRedeem(
  req: Request,
  ctx: AppHostContext & { client: string },
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
    client: ctx.client,
    registrationGen: appRegistrationGeneration(ctx.app),
    now,
  });
  if (record === null) return handshake(400, SIGN_IN_FAILED_BODY);
  // The generation is checked against the app that is live NOW, not the one
  // that was live at mint time: a code minted seconds before a delete and a
  // re-registration must not open the successor.
  if (
    record.hostGen !== ctx.app.hostGen ||
    record.registrationGen !== appRegistrationGeneration(ctx.app)
  ) {
    return handshake(400, SIGN_IN_FAILED_BODY);
  }
  // The office session has to still be alive, and its absolute cap is what
  // bounds the app session. Revalidating here rather than trusting the code
  // closes the window between mint and redeem.
  const office = revalidateByHash(record.officeSessionHash);
  if (office === null) return handshake(400, SIGN_IN_FAILED_BODY);
  if (!ctx.canAccess(ctx.app, office.userId)) {
    return handshake(400, SIGN_IN_FAILED_BODY);
  }

  const started = startAppSession(
    {
      label: ctx.app.hostLabel,
      hostGen: ctx.app.hostGen,
      registrationGen: appRegistrationGeneration(ctx.app),
      officeSessionHash: record.officeSessionHash,
      absoluteExpiresAt: office.absoluteExpiresAt,
    },
    now,
  );
  if (started === null) return handshake(400, SIGN_IN_FAILED_BODY);

  const destination = record.wrapperReturn
    ? `${buildPublicOrigin().origin}/${ctx.app.name}${new URL(record.returnPath, "https://app.invalid").search}`
    : record.returnPath;
  return handshakeRedirect(destination, [
    appCookieLine(started.token, started.maxAgeSec),
  ]);
}

// The gate in front of everything an app host serves. Returns null when the
// caller holds a live app session and the request may proceed (to the app
// itself).
//
// Otherwise: a request that may start the handshake is bounced into it, and
// anything else is refused. When a cookie was presented and rejected, the refusal
// clears it - a dead credential must not sit in a browser waiting to confuse
// its owner or block logout.
// The same question for a WebSocket upgrade, which needs its own answer rather
// than the gate below.
//
// The difference is not stylistic: the gate's non-session path either BOUNCES a
// request into the handshake or refuses it, and an upgrade can do neither
// usefully. A browser's upgrade carries `Sec-Fetch-Dest: websocket`, so it would
// take the refusal branch; a hand-built client with no Fetch Metadata would take
// the REDIRECT branch and be handed a 302 no WebSocket client can follow. Both
// end in failure, one of them confusingly. So an upgrade gets one answer, the
// honest one: hold a live app session or be refused.
//
// In practice a browser reaches an app's page over HTTP first, which
// is where the session is established, so a real app's socket opens with the
// cookie already in hand.
export function appHostWsAuthGate(
  req: Request,
  ctx: AppHostContext,
): Response | null {
  const rawCookie = readAppCookie(req);
  const session = validateAppSession(rawCookie, {
    label: ctx.app.hostLabel,
    hostGen: ctx.app.hostGen,
    registrationGen: appRegistrationGeneration(ctx.app),
    now: ctx.now,
  });
  if (session && ctx.canAccess(ctx.app, session.userId)) {
    return null;
  }
  return noAppSessionAnswer(req, {
    label: ctx.app.hostLabel,
    rawCookie,
    upgrade: true,
  });
}

export function appHostAuthGate(
  req: Request,
  ctx: AppHostContext,
): Response | null {
  const rawCookie = readAppCookie(req);
  const session = validateAppSession(rawCookie, {
    label: ctx.app.hostLabel,
    hostGen: ctx.app.hostGen,
    registrationGen: appRegistrationGeneration(ctx.app),
    now: ctx.now,
  });
  if (session && ctx.canAccess(ctx.app, session.userId)) {
    return null;
  }
  if (previewSessionAllows(rawCookie, ctx.app, ctx.now ?? Date.now())) {
    return null;
  }
  return noAppSessionAnswer(req, {
    label: ctx.app.hostLabel,
    rawCookie,
    upgrade: false,
  });
}

// A label with no live app gets the answer that a live app gives a caller with
// no app session, so an anonymous caller cannot tell which labels are live. A
// signed-in caller who follows the bounce gets the mint endpoint's 404.
export function unknownLabelAnswer(
  req: Request,
  label: string,
  upgrade: boolean,
): Response {
  return noAppSessionAnswer(req, {
    label,
    rawCookie: readAppCookie(req),
    upgrade,
  });
}

// The one answer for a caller with no live app session, shared by both gates
// and by unknownLabelAnswer so they cannot emit different bytes. It depends
// only on the request and the label, never on the app's state: no
// Clear-Site-Data for a reused label, because a missing label could not send
// the same.
//
// PRESENT and rejected -> clear the cookie, whatever the reason it failed
// (expired, revoked, another app's, or empty). Absent -> nothing to clear.
function noAppSessionAnswer(
  req: Request,
  opts: { label: string; rawCookie: string | null; upgrade: boolean },
): Response {
  const clear = opts.rawCookie === null ? [] : [appCookieClearLine()];
  if (
    !opts.upgrade &&
    req.method === "GET" &&
    req.headers.get("Sec-Fetch-Dest") === "iframe"
  ) {
    const origin = buildPublicOrigin().origin;
    // The host arm also adds self to this policy; keep this response safe alone.
    const script = `parent.postMessage(${JSON.stringify(APP_SESSION_REQUIRED_MESSAGE)},${JSON.stringify(origin)});`;
    const hash = createHash("sha256").update(script).digest("base64");
    return handshake(401, `<!doctype html><script>${script}</script>`, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors ${origin}`,
      ...(clear.length > 0 ? { "Set-Cookie": clear[0] } : {}),
    });
  }
  if (opts.upgrade || !mayInitiateHandshake(req)) {
    return handshake(
      401,
      AUTH_REQUIRED_BODY,
      clear.length > 0 ? { "Set-Cookie": clear[0] } : {},
    );
  }
  const url = new URL(req.url);
  const target =
    `${buildPublicOrigin().origin}${APP_MINT_PATH}` +
    `?app=${encodeURIComponent(opts.label)}` +
    `&r=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
  return handshakeRedirect(target, clear);
}

// SCREENSHOT GRANTS. The server's screenshot browser (preview-capture.ts)
// starts every capture with an empty profile, so it holds no office session,
// and the gate above sends it to the office sign-in page. A grant lets an
// agent's capture open an app that the agent may open, with no office session:
//
//   1. the office mints a single-use code for ONE app host, bound to the app's
//      issuance tuple and to a revalidate() that asks the agent's own access
//      question again, on the live app record;
//   2. Chrome navigates to APP_PREVIEW_AUTH_PATH with that code, and the redeem
//      sets the usual host-only app cookie in the capture's throwaway profile;
//   3. the HTTP gate accepts the session it starts, with revalidate() in
//      place of revalidateByHash on every request. The WebSocket gate does
//      not: the relay revalidates an office session for the socket's whole
//      life (app-ws-relay.ts), so a capture's page loads without its sockets.
//
// Separate tables, limiters and redeem path: a capture never spends a member's
// mint or redeem budget and never touches a member's rows. Both rows expire at
// the capture deadline, and the capture deletes them when it ends.
export const APP_PREVIEW_AUTH_PATH = "/__isomux/preview";
export const APP_PREVIEW_MINT_MAX_PER_WINDOW = 20;

const previewMintLimiter = new FixedWindowLimiter(
  APP_MINT_WINDOW_MS,
  APP_PREVIEW_MINT_MAX_PER_WINDOW,
  false,
);
const previewRedeemLimiter = new FixedWindowLimiter(
  APP_REDEEM_WINDOW_MS,
  APP_REDEEM_MAX_PER_WINDOW,
  true,
);

// May the agent that holds this grant open this app record now?
export type PreviewRevalidate = (app: AppRecord) => boolean;

interface PreviewRow {
  grantId: number;
  label: string;
  hostGen: number;
  registrationGen: number;
  revalidate: PreviewRevalidate;
  expiresAt: number;
}

interface PreviewCode extends PreviewRow {
  codeHash: string;
  appHost: string;
  returnPath: string;
}

interface PreviewSession extends PreviewRow {
  tokenHash: string;
}

const previewCodes = new Map<string, PreviewCode>();
const previewSessions = new Map<string, PreviewSession>();
let nextPreviewGrantId = 1;

function previewRowMatches(row: PreviewRow, app: AppRecord): boolean {
  return (
    row.label === app.hostLabel &&
    row.hostGen === app.hostGen &&
    row.registrationGen === appRegistrationGeneration(app)
  );
}

function wellFormedToken(raw: string | null | undefined): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(raw)
  );
}

// The caller has already decided that the agent may open `app` and that
// `appHost` and `returnPath` are the registry's host and a valid return path.
// Null when the agent's mint budget or the table is spent, or the capture
// deadline has passed.
export function mintPreviewGrant(
  input: {
    agentId: string;
    app: AppRecord;
    appHost: string;
    returnPath: string;
    revalidate: PreviewRevalidate;
    expiresAt: number;
  },
  now: number = Date.now(),
): { code: string; release: () => void } | null {
  if (input.expiresAt <= now) return null;
  if (!previewMintLimiter.allow(input.agentId, now)) return null;
  pruneExpired(previewCodes, now);
  if (previewCodes.size >= MAX_PENDING_CODES) return null;
  const code = randomTokenValue();
  const codeHash = hashOf(code);
  const grantId = nextPreviewGrantId++;
  previewCodes.set(codeHash, {
    codeHash,
    grantId,
    label: input.app.hostLabel,
    hostGen: input.app.hostGen,
    registrationGen: appRegistrationGeneration(input.app),
    appHost: input.appHost,
    returnPath: input.returnPath,
    revalidate: input.revalidate,
    expiresAt: input.expiresAt,
  });
  const release = () => {
    for (const table of [previewCodes, previewSessions] as const) {
      for (const [key, row] of table) {
        if (row.grantId === grantId) table.delete(key);
      }
    }
  };
  return { code, release };
}

// GET /__isomux/preview?code=... on an app host. Same order as redeemAppCode,
// so every presentation consumes the code, refused or not.
export function handleAppPreviewRedeem(
  req: Request,
  ctx: { host: string; app: AppRecord; client: string; now?: number },
): Response {
  const now = ctx.now ?? Date.now();
  const raw = singleParam(new URL(req.url), "code");
  if (!wellFormedToken(raw)) return handshake(400, SIGN_IN_FAILED_BODY);
  const codeHash = hashOf(raw);
  const record = previewCodes.get(codeHash);
  previewCodes.delete(codeHash);
  if (!previewRedeemLimiter.allow(`${ctx.app.hostLabel} ${ctx.client}`, now))
    return handshake(400, SIGN_IN_FAILED_BODY);
  if (
    !record ||
    !safeHashEq(record.codeHash, codeHash) ||
    record.expiresAt <= now ||
    record.appHost !== ctx.host ||
    !previewRowMatches(record, ctx.app) ||
    !record.revalidate(ctx.app)
  ) {
    return handshake(400, SIGN_IN_FAILED_BODY);
  }
  const maxAgeSec = Math.floor((record.expiresAt - now) / 1000);
  pruneExpired(previewSessions, now);
  if (maxAgeSec <= 0 || previewSessions.size >= MAX_PENDING_CODES)
    return handshake(400, SIGN_IN_FAILED_BODY);
  const token = randomTokenValue();
  const tokenHash = hashOf(token);
  previewSessions.set(tokenHash, {
    tokenHash,
    grantId: record.grantId,
    label: record.label,
    hostGen: record.hostGen,
    registrationGen: record.registrationGen,
    revalidate: record.revalidate,
    expiresAt: record.expiresAt,
  });
  return handshakeRedirect(record.returnPath, [
    appCookieLine(token, maxAgeSec),
  ]);
}

function previewSessionAllows(
  rawCookie: string | null,
  app: AppRecord,
  now: number,
): boolean {
  if (!wellFormedToken(rawCookie)) return false;
  const tokenHash = hashOf(rawCookie);
  const row = previewSessions.get(tokenHash);
  if (!row || !safeHashEq(row.tokenHash, tokenHash)) return false;
  if (row.expiresAt <= now) {
    previewSessions.delete(tokenHash);
    return false;
  }
  return previewRowMatches(row, app) && row.revalidate(app);
}
