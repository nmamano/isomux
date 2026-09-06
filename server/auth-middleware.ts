// HTTP middleware + WS upgrade auth + /auth/* routes.
//
// The whole gating layer lives in this file so a future audit can read one
// file end-to-end and trace every request shape.

import type { Server } from "bun";
import {
  acceptInvite,
  browserSessionDiagnostic,
  buildPublicOrigin,
  isLoopbackOrigin,
  claimOwnership,
  clearCookieHeaders,
  emitBrowserSessionDiagnostic,
  logoutBySessionHash,
  peekInvite,
  readSessionCookie,
  readSessionCookies,
  setCookieHeader,
  validateSession,
  wouldRevokeLeaveOfficeUnreachable,
  type InvitePeek,
  type SessionLookup,
} from "./auth.ts";
import { getUserById, getUserByName, hasOwner } from "./users.ts";
import { translatorForRequest } from "./i18n.ts";
import type { Translator } from "../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../shared/languages.ts";
import {
  readBearerToken,
  identityFromSession,
  type Identity,
} from "./identity/index.ts";
import { resolveToken } from "./identity/tokens.ts";
import { appIdentityFromToken } from "./app-tokens.ts";
import { resolveApiToken } from "./api-tokens.ts";
import { API_CAPABILITIES } from "./identity/index.ts";
import { deriveAppHostDomain } from "./app-domain.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Fires after the office gets its first owner - either through the tokenless
// claim form (handleClaim → claimOwnership) or the legacy bootstrap-invite
// accept path (handleAccept where isBootstrap is true). Awaited best-effort
// after the session has persisted but before the redirect response is
// returned; the hook MUST NOT roll auth state back on its own failure, and
// the caller must log + swallow any throw. `null` resets for repeated test
// boots.
type OwnerCreatedCb = (opts: { username: string }) => Promise<void> | void;
let onOwnerCreated: OwnerCreatedCb | null = null;
export function setOnOwnerCreated(cb: OwnerCreatedCb | null): void {
  onOwnerCreated = cb;
}

// Test-only driver for the registered first-owner hook. This lets onboarding
// tests prove the seed itself is idempotent without manufacturing a second
// first-owner auth transition, which the real auth state correctly forbids.
export async function _testRunOwnerCreatedHook(
  username: string,
): Promise<void> {
  await onOwnerCreated?.({ username });
}

// Loopback detection. This is NOT an authentication bypass, and there is no
// longer one: every caller needs a bearer token or a session cookie, and the
// last loopback-trusted prefixes were retired (see the gating function below,
// which says so at the point it enforces it). What survives is a locality
// check for the two places that care where the peer is rather than who it is -
// the tokenless claim, which refuses an off-box peer outright, and /readyz,
// which exempts loopback from rate limiting so the updater's own poll cannot
// manufacture a rollback.

function isLoopback(addr: string | null): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

export function requestIsLoopback<T>(req: Request, server: Server<T>): boolean {
  try {
    const info = server.requestIP(req);
    return isLoopback(info?.address ?? null);
  } catch {
    return false;
  }
}

// Origin check. Reverse proxies are configured by the operator setting
// ISOMUX_PUBLIC_ORIGIN; we do not infer the origin from Host/X-Forwarded-Host
// because that's how WebSocket-hijacking bugs happen.
//
// Exact match, with no loopback exemption, stops a hostile page from driving a
// browser that holds a live session cookie. On a Caddy-fronted box, every public
// request arrives from 127.0.0.1, so a "loopback peer" exemption would disable
// it for all external traffic.
// On-box tooling must send the configured public origin verbatim.

export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const { origin: expected } = buildPublicOrigin();
  return origin === expected;
}

// Standard response headers for every HTML surface (SPA shell, login,
// invite-accept, error pages). Two headers:
//
//   Referrer-Policy: no-referrer
//     The invite URL contains a bearer token. Without this header, a
//     future outbound link or subresource on the invite-accept page
//     could leak the token via the Referer header. Setting this also
//     covers back-button-to-bookmark navigations from a still-live
//     token. Suppressed for tokenless pages (claim form, etc) via the
//     `tokenInUrl: false` option - Chrome couples `Referrer-Policy:
//     no-referrer` to a privacy mode where top-level form POSTs send
//     `Origin: null` instead of the page origin, which breaks strict
//     same-origin checks on the form's POST handler. Tokenless URLs
//     have nothing to leak through Referer, so the trade-off is wrong
//     for them.
//
//   Strict-Transport-Security (HTTPS only)
//     HSTS protects later requests that start over HTTP (stale
//     bookmark, scheme-less hostname, HTTP redirect chain) by pinning
//     the origin to HTTPS for max-age. A direct HTTPS request is
//     protected by TLS validation independently - HSTS does not
//     improve that first HTTPS visit unless the domain is preloaded.
//     `includeSubDomains` is NOT set: an office origin on a shared
//     parent domain (e.g. `office.example.com` where the operator
//     doesn't own all of `*.example.com`) should not pin siblings to
//     HTTPS. Operators who want subdomain-wide HSTS can layer it at
//     their reverse proxy.
export function securityHeaders(opts?: {
  tokenInUrl?: boolean;
}): Record<string, string> {
  const tokenInUrl = opts?.tokenInUrl ?? true;
  const { origin, isHttps } = buildPublicOrigin();
  const appDomain = deriveAppHostDomain(origin, isHttps);
  const frameSources = ["'self'", "blob:", "data:"];
  if (appDomain) frameSources.push(`https://*.${appDomain}`);
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' ws: wss:",
    "font-src 'self' https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `frame-src ${frameSources.join(" ")}`,
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  const h: Record<string, string> = {
    "Content-Security-Policy": csp,
    "Permissions-Policy":
      "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    "Referrer-Policy": tokenInUrl
      ? "no-referrer"
      : "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (isHttps) {
    h["Strict-Transport-Security"] = "max-age=31536000";
  }
  return h;
}

export function withSecurityHeaders(response: Response): Response {
  const headers = securityHeaders({ tokenInUrl: false });
  for (const [name, value] of Object.entries(headers)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

export interface AuthOk {
  kind: "ok";
  // Present for the cookie path; absent for a bearer-only caller (agent/run
  // token, which has no cookie session). No consumer reads this beyond the
  // `kind` check today; it stays for the cookie callers that already relied
  // on it.
  session?: SessionLookup;
  // The resolved caller identity. Always set on an "ok" result:
  // a bearer token resolves to an agent/run identity, a cookie to a user
  // identity.
  identity: Identity;
}
export interface AuthRejected {
  kind: "rejected";
  response: Response;
}

export type AuthResult = AuthOk | AuthRejected;

function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json") || !accept.includes("text/html");
}

function unauthorized(req: Request, officeName: string | null): Response {
  if (wantsJson(req)) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(renderLoginPage(translatorForVisitor(req), officeName), {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Login page has no bearer token in its URL; skip Referrer-Policy:
      // no-referrer so any future form on this page wouldn't trip Chrome's
      // Origin: null behavior.
      ...securityHeaders({ tokenInUrl: false }),
    },
  });
}

// The language a pre-sign-in page is written in (S9). The gating layer's own
// helpers answer who is asking - a bearer, a cookie session, or nobody - and
// server/i18n.ts turns that into a translator: a reader we already know reads
// their stored preference, a stranger reads what their browser asked for.
function translatorForVisitor(req: Request): Translator {
  const cookies = readSessionCookies(req);
  const identity = resolveIdentityForRequest(
    req,
    validateSession(cookies.selected || null),
  );
  return translatorForRequest(identity, req.headers.get("accept-language"));
}

// Browser-tab title for /auth/* and /i/<token> pages. Mirrors the format
// used by the SPA shell (see serveIndexHtml in server/isomux-office.ts) so the tab
// title stays consistent across authenticated and pre-auth surfaces. The suffix
// arrives translated; the frame around it is punctuation and a proper noun.
function authPageTitle(officeName: string | null, suffix: string): string {
  return officeName
    ? `${officeName} | Isomux - ${suffix}`
    : `Isomux - ${suffix}`;
}

// Gating function. Called at the top of every fetch handler.
//
// Every caller needs an identity: a bearer token (agent / cron-run) or a
// session cookie. There is no loopback bypass - the last three
// loopback-trusted prefixes (/tasks, the /cronjobs reads, /backup/status) were
// retired in favour of their bearer-gated /api equivalents, so a same-box agent
// presents its ISOMUX_AGENT_TOKEN and a same-box browser claims a cookie via
// /i/<token> instead of getting a half-functional landing page where HTTP works
// but WS doesn't.

export function authenticate(
  req: Request,
  opts?: { officeName?: string | null },
): AuthResult {
  // Origin check runs regardless of the cookie path. A user's browser
  // running on the same machine as the server can otherwise be tricked by
  // a malicious origin into mutating state via the agent-API endpoints
  // (CSRF). We allow missing-Origin (typical for agent curl, which never
  // sends one) but reject mismatched-Origin always.
  if (!SAFE_METHODS.has(req.method)) {
    const originHeader = req.headers.get("origin");
    if (originHeader && !checkOrigin(req)) {
      return {
        kind: "rejected",
        response: new Response(JSON.stringify({ error: "bad origin" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
  }
  // Bearer is resolved BEFORE the cookie so `Authorization: Bearer ...` is
  // deterministic and a valid bearer wins; an invalid/garbage bearer is IGNORED
  // (treated like no Authorization) rather than becoming its own rejection, so a
  // valid cookie alongside it can still pass and an invalid bearer alone gets
  // the plain 401.
  //
  // A valid agent/run bearer clears this wall anywhere authenticate() gates.
  // What the caller may then DO is decided per route on the /api surface (the
  // capability + resource guards); this function only answers "is there an
  // identity".
  const bearerId = resolveBearerIdentity(req);
  if (bearerId) {
    return { kind: "ok", identity: bearerId };
  }
  const cookies = readSessionCookies(req);
  const session = validateSession(cookies.selected || null);
  emitBrowserSessionDiagnostic(
    browserSessionDiagnostic(cookies, session, "http"),
    req,
  );
  if (!session) {
    return {
      kind: "rejected",
      response: unauthorized(req, opts?.officeName ?? null),
    };
  }
  return { kind: "ok", session, identity: identityFromSession(session) };
}

// The bearer-then-cookie identity precedence, factored out as a pure helper so
// the "a valid bearer wins over a valid cookie" contract is unit-testable
// without constructing a Server. authenticate() applies the same order with the
// loopback fallback interleaved (loopback is anonymous trust and carries no
// identity). A valid bearer wins; an invalid bearer is ignored; otherwise a
// cookie session (if any) yields a USER identity.
export function resolveIdentityForRequest(
  req: Request,
  cookieLookup: SessionLookup | null,
): Identity | null {
  const bearerId = resolveBearerIdentity(req);
  if (bearerId) return bearerId;
  if (cookieLookup) return identityFromSession(cookieLookup);
  return null;
}

// Single source of bearer-identity resolution, shared by authenticate() and
// resolveIdentityForRequest() so the bearer precedence has exactly ONE
// implementation - no drift between the live gate and the unit-tested helper.
function resolveBearerIdentity(req: Request): Identity | null {
  const bearer = readBearerToken(req);
  if (!bearer) return null;
  // In-memory tokens (agent, cron-run) first, then the persisted app-token
  // store. The two spaces cannot collide - 256 bits of entropy each - so the
  // order is about cost, not precedence: an agent token resolves from a map,
  // an app token reads a file.
  const transientOrApp = resolveToken(bearer) ?? appIdentityFromToken(bearer);
  if (transientOrApp) return transientOrApp;
  const apiToken = resolveApiToken(bearer);
  if (!apiToken) return null;
  // Role and existence are live, never stamped into a durable credential. A
  // deletion or demotion therefore changes authorization on the next request.
  const user = getUserById(apiToken.userId);
  if (!user) return null;
  return {
    scope: "api",
    userId: user.id,
    role: user.role,
    capabilities: API_CAPABILITIES,
    apiTokenId: apiToken.id,
    apiTokenName: apiToken.name,
  };
}

// /auth/* route handlers. These run BEFORE the gating function - they're how
// unauthenticated visitors transition to authenticated.

// GET /i/<token> - peek (do NOT consume). Renders an HTML page with a
// submit button (and a name field for bootstrap invites). The actual
// consumption happens on POST /auth/accept. The two-step shape protects
// against link previewers / chat unfurlers / scanners burning the one-time
// invite before the human opens it.
export function handleInvitePeek(
  req: Request,
  token: string,
  officeName: string | null,
): Response {
  const i18n = translatorForVisitor(req);
  const peek = peekInvite(token);
  if ("error" in peek) {
    if (peek.error === "consumed") {
      const signedIn = redirectConsumedVisitorIfSignedIn(req);
      if (signedIn) return signedIn;
    }
    return renderInviteError(i18n, peek.error, officeName);
  }
  const conflict = inviteIdentityConflict(req, peek, null);
  if (conflict) return renderInviteIdentityConflict(i18n, conflict, officeName);
  return new Response(
    renderAcceptPage(i18n, token, peek.needsName, null, officeName),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...securityHeaders(),
      },
    },
  );
}

// POST /auth/accept - actually consume the invite, create the session,
// set the cookie. `name` is only required for null-username invites
// (bootstrap, etc.). Origin must match ISOMUX_PUBLIC_ORIGIN.
export async function handleAccept(
  req: Request,
  officeName: string | null,
): Promise<Response> {
  if (!originValidForAuthPost(req)) {
    return new Response("bad origin", { status: 403 });
  }
  const i18n = translatorForVisitor(req);
  const form = await req.formData().catch(() => null);
  const tokenField = form?.get("token");
  const nameField = form?.get("name");
  const token = typeof tokenField === "string" ? tokenField : "";
  const name = typeof nameField === "string" ? nameField : "";
  if (!token) return renderInviteError(i18n, "not_found", officeName);
  const peek = peekInvite(token);
  // This is an allow-list: a live browser session may accept only for the
  // same stable user. A missing target record therefore refuses rather than
  // making two unresolved values look equal. Peek errors stay on the existing
  // acceptInvite path below, which preserves the consumed-invite redirect.
  if (!("error" in peek)) {
    const conflict = inviteIdentityConflict(req, peek, name);
    if (conflict)
      return renderInviteIdentityConflict(i18n, conflict, officeName);
  }
  const ua = req.headers.get("user-agent");
  const result = await acceptInvite(token, { userAgent: ua, chosenName: name });
  if (!result.ok) {
    if (result.error === "needs_name" || result.error === "invalid_name") {
      return new Response(
        renderAcceptPage(
          i18n,
          token,
          true,
          i18n.t("preAuth.invite.errorName"),
          officeName,
        ),
        {
          status: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...securityHeaders(),
          },
        },
      );
    }
    if (result.error === "consumed") {
      const signedIn = redirectConsumedVisitorIfSignedIn(req);
      if (signedIn) return signedIn;
    }
    return renderInviteError(i18n, result.error, officeName);
  }
  if (result.isBootstrap && onOwnerCreated) {
    // Best-effort: never roll back the accept on hook failure.
    try {
      await onOwnerCreated({ username: result.username });
    } catch (err) {
      console.error("[auth] onOwnerCreated threw:", err);
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": setCookieHeader(
        result.rawSessionId,
        result.absoluteExpiresAt,
      ),
      ...securityHeaders(),
    },
  });
}

function inviteIdentityConflict(
  req: Request,
  invite: InvitePeek,
  chosenName: string | null,
): { current: string; invitee: string } | null {
  const session = validateSession(readSessionCookie(req));
  if (!session) return null;

  let invitee: string;
  if (invite.username !== null) {
    invitee = invite.username;
  } else {
    invitee = (chosenName ?? "").trim();
    // Match acceptInvite's bootstrap-name validation. Invalid input continues
    // to that existing error path instead of becoming an identity refusal.
    if (
      !invitee ||
      invitee.length > 64 ||
      !/^[\p{L}\p{N} ._'-]+$/u.test(invitee)
    ) {
      return null;
    }
  }

  const invitedUser = getUserByName(invitee);
  if (invitedUser?.id === session.userId) return null;
  console.log(
    `[auth] invite acceptance refused: live browser session ${session.sessionPrefix}… differs from invite target`,
  );
  return { current: session.username, invitee };
}

function renderInviteIdentityConflict(
  i18n: Translator,
  conflict: { current: string; invitee: string },
  officeName: string | null,
): Response {
  const { t } = i18n;
  return new Response(
    baseHtml(
      i18n.language,
      authPageTitle(officeName, t("common.titleInvite")),
      `<h1>${t("preAuth.conflict.heading")}</h1>
      <p>${t("preAuth.conflict.body", {
        current: escapeHtml(conflict.current),
        invitee: escapeHtml(conflict.invitee),
      })}</p>
      <p><a href="/">${t("common.returnToOffice")}</a></p>`,
    ),
    {
      status: 409,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...securityHeaders(),
      },
    },
  );
}

// POST /auth/logout - clear the cookie and revoke the session server-side.
// Origin must match: a malicious site can otherwise sign the user out via
// a credentialed form POST (annoying, not a data breach, but still CSRF).
// Same lockout-prevention rule as the WS logout: refuse if this is the
// office's last active owner session.
export async function handleLogout(
  req: Request,
  officeName: string | null,
): Promise<Response> {
  if (!originValidForAuthPost(req)) {
    return new Response("bad origin", { status: 403 });
  }
  const cookie = readSessionCookie(req);
  const lookup = validateSession(cookie);
  if (lookup && wouldRevokeLeaveOfficeUnreachable(lookup.sessionIdHash)) {
    const i18n = translatorForVisitor(req);
    return new Response(
      renderLockoutBlocked(
        i18n,
        i18n.t("preAuth.signOutBlocked.lastOwnerSession"),
        officeName,
      ),
      {
        status: 409,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Lockout-blocked page is tokenless - same rationale as the
          // login page above.
          ...securityHeaders({ tokenInUrl: false }),
        },
      },
    );
  }
  if (lookup) {
    await logoutBySessionHash(lookup.sessionIdHash);
  }
  // Both names, as independent Set-Cookie lines (an object literal can only
  // carry one). Clearing the name that did NOT authenticate this request is
  // client-side cleanup only - the session revoked above is the one the
  // request actually selected.
  const headers = new Headers({ Location: "/", ...securityHeaders() });
  for (const line of clearCookieHeaders()) headers.append("Set-Cookie", line);
  return new Response(null, { status: 302, headers });
}

function renderLockoutBlocked(
  i18n: Translator,
  message: string,
  officeName: string | null,
): string {
  const { t } = i18n;
  return baseHtml(
    i18n.language,
    authPageTitle(officeName, t("preAuth.signOutBlocked.title")),
    `<h1>${t("preAuth.signOutBlocked.heading")}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">${t("common.returnToOffice")}</a></p>`,
  );
}

// /auth/* POSTs are exclusively browser-driven. Unlike the agent-API
// endpoints (which accept missing Origin from local curl), these require
// an explicit Origin match - except for the absent/`null` Origin case,
// where we fall back to the Fetch Metadata `Sec-Fetch-Site: same-origin`
// signal (browser-attested, not forgeable by page JS). The literal-`null`
// case happens on Chrome for top-level form POSTs from a page that sets
// `Referrer-Policy: no-referrer` (the audit §6 hardening); absent Origin
// is the broader legacy/privacy case. Empty-string Origin fails closed.
function hasSameOriginFetchMetadata(req: Request): boolean {
  return req.headers.get("sec-fetch-site") === "same-origin";
}
function originValidForAuthPost(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "null") {
    return hasSameOriginFetchMetadata(req);
  }
  if (origin === "") return false;
  return checkOrigin(req);
}

// Top-level router used by isomux-office.ts: returns null when the path isn't an
// /auth/* path, so the caller falls through to its normal dispatch.
export async function tryHandleAuthRoute<T>(
  req: Request,
  url: URL,
  officeName: string | null,
  server: Server<T>,
): Promise<Response | null> {
  // Pre-claim tokenless flow. The server binds 127.0.0.1 pre-claim, so this
  // surface is unreachable from off-box; we still layer a strict same-origin
  // + loopback-peer-IP check on the POST as defense-in-depth in case the
  // bind is widened by operator override.
  if (req.method === "GET" && url.pathname === "/" && !hasOwner()) {
    return handleClaimForm(translatorForVisitor(req), officeName);
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    return handleClaim(req, server, officeName);
  }
  // GET /i/<token> - peek + render accept page (NEVER consumes).
  if (req.method === "GET" && url.pathname.startsWith("/i/")) {
    const token = url.pathname.slice(3);
    if (!token)
      return renderInviteError(
        translatorForVisitor(req),
        "not_found",
        officeName,
      );
    return handleInvitePeek(req, token, officeName);
  }
  // POST /auth/accept - actually consumes the invite. Origin-checked.
  if (url.pathname === "/auth/accept" && req.method === "POST") {
    return handleAccept(req, officeName);
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    return handleLogout(req, officeName);
  }
  // GET /auth/login-bg.png - pre-auth static asset (the login page's
  // backdrop screenshot). Same image as the marketing site so an unauth
  // visitor sees nothing about this specific deployment. Long-cached
  // because the asset is build-time-baked and treated as immutable.
  if (url.pathname === "/auth/login-bg.png" && req.method === "GET") {
    return handleLoginBackdrop();
  }
  return null;
}

// GET / when !hasOwner(): render the tokenless name-picker form. Routes
// here BEFORE the cookie gate, since pre-claim there's no cookie surface
// yet. After claim, hasOwner() flips and this branch goes dead; the SPA
// shell + login page resume normal dispatch.
//
// The claim page uses `tokenInUrl: false` so `Referrer-Policy: no-referrer`
// is omitted: there's no token in the URL to leak, and Chrome's coupling
// between that header and `Origin: null` on top-level form POSTs would
// otherwise make the form's strict same-origin check reject the real
// browser submit with 403.
function handleClaimForm(
  i18n: Translator,
  officeName: string | null,
): Response {
  return new Response(renderClaimPage(i18n, null, officeName), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders({ tokenInUrl: false }),
    },
  });
}

// POST /auth/claim - consume the tokenless form, create the owner record,
// set the cookie. Locality is enforced at multiple layers:
//   1. The server bind (127.0.0.1 pre-claim) keeps off-box clients off the
//      TCP socket entirely;
//   2. requestIsLoopback rejects non-loopback peers if the bind has been
//      widened by operator override;
//   3. A strict same-origin check rejects ordinary browser POSTs from
//      pages on other origins (CSRF defense).
//
// The strict-Origin check does NOT close the "non-browser client forges
// Origin over a same-host proxy" case - curl can set Origin to anything,
// including the exact loopback value. A reverse proxy or tunnel running
// on the same box that forwards external traffic to localhost:4000 is
// indistinguishable from a real local browser at the peer-IP level. This
// is an inherent topology limit; the documented mitigation is operator
// discipline (claim first, expose later - see docs/access-and-invites.md
// "Bootstrap-window exposure").
async function handleClaim<T>(
  req: Request,
  server: Server<T>,
  officeName: string | null,
): Promise<Response> {
  if (!requestIsLoopback(req, server)) {
    return new Response("forbidden", { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (!origin || !isLoopbackOrigin(origin)) {
    return new Response("bad origin", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const nameField = form?.get("name");
  const name = typeof nameField === "string" ? nameField : "";
  const ua = req.headers.get("user-agent");
  const result = await claimOwnership(name, { userAgent: ua });
  if (!result.ok) {
    const i18n = translatorForVisitor(req);
    const errorMsg =
      result.error === "owner_exists"
        ? i18n.t("preAuth.claim.errorOwnerExists")
        : i18n.t("preAuth.claim.errorName");
    return new Response(renderClaimPage(i18n, errorMsg, officeName), {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...securityHeaders({ tokenInUrl: false }),
      },
    });
  }
  if (onOwnerCreated) {
    // Best-effort, same contract as the bootstrap-invite path: hook
    // failure must not roll the claim back. Runs after the session has
    // persisted (claimOwnership returned ok) and before the redirect
    // response is returned to the browser.
    try {
      await onOwnerCreated({ username: result.username });
    } catch (err) {
      console.error("[auth] onOwnerCreated threw:", err);
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": setCookieHeader(
        result.rawSessionId,
        result.absoluteExpiresAt,
      ),
      ...securityHeaders({ tokenInUrl: false }),
    },
  });
}

async function handleLoginBackdrop(): Promise<Response> {
  // Read from ui/dist (build.sh copies the screenshot there). If the file
  // is missing - e.g. a dev install that didn't run build:ui - fall back
  // to a transparent 1x1 so the login page still renders.
  const path = new URL("../ui/dist/login-bg.png", import.meta.url).pathname;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response(EMPTY_PNG, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// 1x1 transparent PNG used as a graceful fallback when the build hasn't
// staged the real backdrop. Decoded once at module load.
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
  "base64",
);

// HTML helpers. Kept inline to avoid a separate templating layer; the auth
// pages are static enough that string concatenation is clearer than spinning
// up a renderer.

function renderLoginPage(i18n: Translator, officeName: string | null): string {
  const { t } = i18n;
  // The visible page body remains generic - the backdrop is a baked
  // screenshot of the office UI served from /auth/login-bg.png (the same
  // asset isomux.com uses on its marketing page) so it reveals nothing
  // about this specific deployment. Once an owner exists, the office name is
  // surfaced only via the browser-tab title for consistency with the SPA shell.
  const hasOfficeOwner = hasOwner();
  const body = `
    <div class="login-bg" aria-hidden="true"></div>
    <main class="card">
      <h1>Isomux</h1>
      ${
        hasOfficeOwner
          ? `<p>${t("preAuth.login.openInvite")}</p>
      <p>${t("preAuth.login.alreadySignedIn")}</p>
      <p class="muted">${t("preAuth.login.askOwner")}</p>`
          : `<p>${t("preAuth.login.noOwner")}</p>
      <p>${t("preAuth.login.claimHere", {
        link: `<a href="/">${t("preAuth.login.claimHereLink")}</a>`,
      })}</p>
      <p class="muted">${t("preAuth.login.sshHint", {
        command: "<code>ssh -L</code>",
      })}</p>`
      }
    </main>
  `;
  return baseHtml(
    i18n.language,
    authPageTitle(officeName, t("preAuth.login.title")),
    body,
    undefined,
    PREAUTH_EXTRA_CSS,
  );
}

// Tokenless first-time-setup form for the pre-claim flow. Shape mirrors
// renderAcceptPage's bootstrap branch (same display-name constraints, same
// "form must be submitted to take effect" anti-preview property) but without
// a token field since locality is the gate.
function renderClaimPage(
  i18n: Translator,
  errorMsg: string | null,
  officeName: string | null,
): string {
  const { t } = i18n;
  const err = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
  // Match the open-graph treatment from renderAcceptPage; no image, generic
  // copy that reveals nothing about the deployment.
  const og = {
    title: t("common.ogTitleFirstTimeSetup"),
    description: t("preAuth.claim.ogDescription"),
  };
  return baseHtml(
    i18n.language,
    authPageTitle(officeName, t("common.titleFirstTimeSetup")),
    `
    <div class="login-bg" aria-hidden="true"></div>
    <main class="card">
      <h1>${t("common.welcomeNewOffice")}</h1>
      <p>${t("preAuth.claim.intro")}</p>
      <form method="POST" action="/auth/claim">
        <label>${t("common.displayName")} <input name="name" type="text" autofocus maxlength="64" required pattern="[\\p{L}\\p{N} ._'\\-]+" /></label>
        ${err}
        <button type="submit">${t("common.continue")}</button>
      </form>
    </main>
    `,
    og,
    PREAUTH_EXTRA_CSS,
  );
}

// Shared CSS for pre-auth pages (login + invite accept). Overrides the
// base layout so the iso backdrop fills the viewport and the card floats
// over it.
const PREAUTH_EXTRA_CSS = `
  body {
    max-width: none;
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(120% 80% at 50% 0%, #fbeed6 0%, #f3dfb8 55%, #e5c98f 100%);
    color: #2a2418;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    position: relative;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    body {
      background:
        radial-gradient(120% 80% at 50% 0%, #2f2a22 0%, #221e18 55%, #15120e 100%);
      color: #e7dcc4;
    }
  }
  /* Backdrop is a baked screenshot of the office UI (the same one
     isomux.com uses on its marketing page). We center+cover it and lift
     opacity a touch so the login card stays readable in front. */
  .login-bg {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: url('/auth/login-bg.png');
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    opacity: 0.55;
  }
  @media (prefers-color-scheme: dark) {
    .login-bg { opacity: 0.35; }
  }
  /* The login card itself floats above the painted floor. */
  .card {
    position: relative;
    z-index: 1;
    background: rgba(255, 250, 240, 0.92);
    border: 1px solid rgba(110, 80, 36, 0.2);
    border-radius: 14px;
    padding: 32px 28px;
    max-width: 440px;
    width: 100%;
    box-shadow: 0 16px 48px rgba(0,0,0,0.12);
    backdrop-filter: blur(8px);
  }
  @media (prefers-color-scheme: dark) {
    .card {
      background: rgba(34, 28, 20, 0.92);
      border-color: rgba(220, 190, 130, 0.18);
      box-shadow: 0 16px 48px rgba(0,0,0,0.45);
    }
  }
  .card h1 {
    margin: 0 0 12px;
    font-size: 1.75rem;
  }
  .muted {
    color: #6a5530;
    font-size: 0.9em;
  }
  @media (prefers-color-scheme: dark) {
    .muted { color: #a88f60; }
  }
`;

function renderAcceptPage(
  i18n: Translator,
  token: string,
  needsName: boolean,
  errorMsg: string | null,
  officeName: string | null,
): string {
  const { t } = i18n;
  const safeToken = escapeAttr(token);
  const err = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
  // Open-graph metadata so chat-app link unfurlers show a readable preview
  // instead of just the opaque token URL. No image (intentional: any image
  // route would still be fetched by third-party preview services who see
  // the bearer URL anyway; keep the cost matched to the gain). The office
  // name is intentionally NOT plumbed into OG fields - those are scraped
  // by external preview services we shouldn't leak the office name to.
  const og = {
    title: needsName
      ? t("common.ogTitleFirstTimeSetup")
      : t("preAuth.invite.ogTitleAccept"),
    description: needsName
      ? t("preAuth.invite.ogDescriptionSetup")
      : t("preAuth.invite.ogDescriptionAccept"),
  };
  if (needsName) {
    // Bootstrap (or any null-username invite): invitee picks their display
    // name. The form double-purposes as the "accept" gesture, so a link
    // previewer can't burn it just by fetching the URL.
    return baseHtml(
      i18n.language,
      authPageTitle(officeName, t("common.titleFirstTimeSetup")),
      `
      <div class="login-bg" aria-hidden="true"></div>
      <main class="card">
        <h1>${t("common.welcomeNewOffice")}</h1>
        <p>${t("preAuth.invite.bootstrapIntro")}</p>
        <form method="POST" action="/auth/accept">
          <input type="hidden" name="token" value="${safeToken}" />
          <label>${t("common.displayName")} <input name="name" type="text" autofocus maxlength="64" required pattern="[\\p{L}\\p{N} ._'\\-]+" /></label>
          ${err}
          <button type="submit">${t("common.continue")}</button>
        </form>
      </main>
      `,
      og,
      PREAUTH_EXTRA_CSS,
    );
  }
  // Pre-named invite: a single-click accept gesture. Same anti-preview
  // property - the GET only renders the form; consumption is on POST. When
  // the office has a display name we surface it in the heading so the
  // invitee can confirm they're joining the right office before clicking.
  const heading = officeName
    ? t("preAuth.invite.headingNamed", { office: escapeHtml(officeName) })
    : t("preAuth.invite.heading");
  return baseHtml(
    i18n.language,
    authPageTitle(officeName, t("preAuth.invite.titleAccept")),
    `
    <div class="login-bg" aria-hidden="true"></div>
    <main class="card">
      <h1>${heading}</h1>
      <p>${t("preAuth.invite.clickHint")}</p>
      <form method="POST" action="/auth/accept">
        <input type="hidden" name="token" value="${safeToken}" />
        ${err}
        <button type="submit" autofocus>${t("preAuth.invite.accept")}</button>
      </form>
    </main>
    `,
    og,
    PREAUTH_EXTRA_CSS,
  );
}

// A consumed-invite visitor who already holds a valid session is almost
// always the invitee who just accepted and then re-opened the one-time
// link (second click from chat, browser history, another tab's stale
// accept form re-POSTing). Dead-ending them on the 410 reads as "signup
// failed" even though they're signed in - send them into the office
// instead. Only the `consumed` error takes this path: an expired or
// unknown invite says nothing about the visitor's own session, and an
// unauthenticated visitor on a consumed link still gets the honest 410.
function redirectConsumedVisitorIfSignedIn(req: Request): Response | null {
  const lookup = validateSession(readSessionCookie(req));
  if (!lookup) return null;
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      // The /i/<token> URL carries the bearer token, so keep the
      // no-referrer policy on the redirect just like the peek page.
      ...securityHeaders(),
    },
  });
}

// The peek and accept paths hand this function whatever error the invite
// store reported, so the lookup is by own property (an inherited name like
// "constructor" must not resolve to a key) and anything unknown reads as the
// generic sentence, exactly as the chain it replaces did.
const INVITE_ERROR_KEYS = {
  consumed: "preAuth.inviteError.consumed",
  expired: "preAuth.inviteError.expired",
  role_mismatch: "preAuth.inviteError.roleMismatch",
  owner_exists: "preAuth.inviteError.ownerExists",
} as const;

function renderInviteError(
  i18n: Translator,
  kind: string,
  officeName: string | null,
): Response {
  const { t } = i18n;
  const key = Object.prototype.hasOwnProperty.call(INVITE_ERROR_KEYS, kind)
    ? INVITE_ERROR_KEYS[kind as keyof typeof INVITE_ERROR_KEYS]
    : "preAuth.inviteError.generic";
  const body = baseHtml(
    i18n.language,
    authPageTitle(officeName, t("common.titleInvite")),
    `<h1>${t("preAuth.inviteError.heading")}</h1><p>${escapeHtml(t(key))}</p>`,
  );
  return new Response(body, {
    status: 410, // Gone - invite was once valid (or never)
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

function baseHtml(
  lang: SupportedLanguageCode,
  title: string,
  body: string,
  og?: { title: string; description: string },
  extraCss: string = "",
): string {
  const ogMeta = og
    ? `
<meta property="og:title" content="${escapeAttr(og.title)}" />
<meta property="og:description" content="${escapeAttr(og.description)}" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escapeAttr(og.title)}" />
<meta name="twitter:description" content="${escapeAttr(og.description)}" />`
    : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />${ogMeta}
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5em; }
  p { margin: 0.5em 0; }
  form { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  label { display: flex; flex-direction: column; gap: 6px; }
  input[type=text] { padding: 8px; font-size: 1rem; border: 1px solid #888; border-radius: 4px; }
  button { padding: 8px 16px; font-size: 1rem; border-radius: 4px; cursor: pointer; }
  .err { color: #c33; }
${extraCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  // Tokens are base64url so they only contain [A-Za-z0-9_-]; escapeHtml is
  // still applied as defense-in-depth in case of an unexpected token shape.
  return escapeHtml(s);
}
