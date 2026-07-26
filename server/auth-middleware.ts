// HTTP middleware + WS upgrade auth + /auth/* routes.
//
// The whole gating layer lives in this file so a future audit can read one
// file end-to-end and trace every request shape.

import type { Server } from "bun";
import {
  acceptInvite,
  buildPublicOrigin,
  isLoopbackOrigin,
  claimOwnership,
  clearCookieHeader,
  logoutBySessionHash,
  peekInvite,
  readSessionCookie,
  setCookieHeader,
  validateSession,
  wouldRevokeLeaveOfficeUnreachable,
  type SessionLookup,
} from "./auth.ts";
import { hasOwner } from "./users.ts";
import {
  readBearerToken,
  identityFromSession,
  type Identity,
} from "./identity/index.ts";
import { resolveToken } from "./identity/tokens.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Fires after the office gets its first owner — either through the tokenless
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

// ---------------------------------------------------------------------------
// Loopback detection. Localhost calls (agent-to-server curl, in-process tests)
// bypass cookie auth — the host already trusts its own processes. The cookie
// path exists to gate browser/remote access, not local IPC.

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

// ---------------------------------------------------------------------------
// Origin check. Reverse proxies are configured by the operator setting
// ISOMUX_PUBLIC_ORIGIN; we do not infer the origin from Host/X-Forwarded-Host
// because that's how WebSocket-hijacking bugs happen.

export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const { origin: expected } = buildPublicOrigin();
  return origin === expected;
}

// ---------------------------------------------------------------------------
// Standard response headers for every HTML surface (SPA shell, login,
// invite-accept, error pages). Two headers:
//
//   Referrer-Policy: no-referrer
//     The invite URL contains a bearer token. Without this header, a
//     future outbound link or subresource on the invite-accept page
//     could leak the token via the Referer header. Setting this also
//     covers back-button-to-bookmark navigations from a still-live
//     token. Suppressed for tokenless pages (claim form, etc) via the
//     `tokenInUrl: false` option — Chrome couples `Referrer-Policy:
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
//     protected by TLS validation independently — HSTS does not
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
  const { isHttps } = buildPublicOrigin();
  const h: Record<string, string> = {};
  if (tokenInUrl) {
    h["Referrer-Policy"] = "no-referrer";
  }
  if (isHttps) {
    h["Strict-Transport-Security"] = "max-age=31536000";
  }
  return h;
}

// ---------------------------------------------------------------------------
// Auth-result type that the isomux-office.ts dispatcher consumes.

export interface AuthOk {
  kind: "ok";
  // Present for the cookie path; absent for a bearer-only caller (agent/run
  // token, which has no cookie session). No consumer reads this beyond the
  // `kind` check today; it stays for the cookie callers that already relied
  // on it.
  session?: SessionLookup;
  // The resolved caller identity (Phase 2.1). Always set on an "ok" result:
  // a bearer token resolves to an agent/run identity, a cookie to a user
  // identity. Nothing enforces against it yet — the guard catalog (2.2) and
  // dispatcher (2.3) will.
  identity: Identity;
}
export interface AuthLoopback {
  kind: "loopback";
}
export interface AuthRejected {
  kind: "rejected";
  response: Response;
}

export type AuthResult = AuthOk | AuthLoopback | AuthRejected;

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
  return new Response(renderLoginPage(officeName), {
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

// Browser-tab title for /auth/* and /i/<token> pages. Mirrors the format
// used by the SPA shell (see serveIndexHtml in server/isomux-office.ts) so the tab
// title stays consistent across authenticated and pre-auth surfaces.
function authPageTitle(officeName: string | null, suffix: string): string {
  return officeName
    ? `${officeName} | Isomux — ${suffix}`
    : `Isomux — ${suffix}`;
}

// ---------------------------------------------------------------------------
// Gating function. Called at the top of every fetch handler.
//
// The `allowLoopback` parameter is true for the API paths agents legitimately
// hit from the same box (POST /tasks, /cronjobs read routes, /backup/status).
// It's false for the SPA shell and static assets — and for the agent surface
// (/agents/...), which is bearer-required after the loopback-bypass removal, so
// a same-box agent must present its ISOMUX_AGENT_TOKEN. A same-box browser still
// has to claim a cookie via /i/<token> instead of getting a half-functional
// landing page where HTTP works but WS doesn't.

export function authenticate<T>(
  req: Request,
  server: Server<T>,
  opts?: { allowLoopback?: boolean; officeName?: string | null },
): AuthResult {
  const looped = !!opts?.allowLoopback && requestIsLoopback(req, server);
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
  // Bearer (Phase 2.1, ADDITIVE) lands ALONGSIDE the cookie path. A valid
  // bearer is resolved BEFORE the loopback short-circuit so that
  // `Authorization: Bearer ...` is deterministic and a valid bearer wins; an
  // invalid/garbage bearer is IGNORED (treated like no Authorization) so it
  // never becomes a NEW rejection — valid cookie/loopback can still pass, and
  // an invalid bearer alone still gets today's 401.
  //
  // Until the guard catalog lands (2.2), a valid agent/run bearer clears the
  // cookie wall anywhere authenticate() gates. That broad acceptance is
  // acceptable ONLY for this additive phase because the token is a bearer
  // secret injected into local subprocess env; 2.2 + the Reviewer4 pass narrow
  // it by capability + resource guard.
  const bearerId = resolveBearerIdentity(req);
  if (bearerId) {
    return { kind: "ok", identity: bearerId };
  }
  if (looped) {
    return { kind: "loopback" };
  }
  const cookie = readSessionCookie(req);
  const session = validateSession(cookie);
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
// implementation — no drift between the live gate and the unit-tested helper.
function resolveBearerIdentity(req: Request): Identity | null {
  const bearer = readBearerToken(req);
  return bearer ? resolveToken(bearer) : null;
}

// ---------------------------------------------------------------------------
// /auth/* route handlers. These run BEFORE the gating function — they're how
// unauthenticated visitors transition to authenticated.

// GET /i/<token> — peek (do NOT consume). Renders an HTML page with a
// submit button (and a name field for bootstrap invites). The actual
// consumption happens on POST /auth/accept. The two-step shape protects
// against link previewers / chat unfurlers / scanners burning the one-time
// invite before the human opens it.
export function handleInvitePeek(
  req: Request,
  token: string,
  officeName: string | null,
): Response {
  const peek = peekInvite(token);
  if ("error" in peek) {
    if (peek.error === "consumed") {
      const signedIn = redirectConsumedVisitorIfSignedIn(req);
      if (signedIn) return signedIn;
    }
    return renderInviteError(peek.error, officeName);
  }
  return new Response(
    renderAcceptPage(token, peek.needsName, null, officeName),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...securityHeaders(),
      },
    },
  );
}

// POST /auth/accept — actually consume the invite, create the session,
// set the cookie. `name` is only required for null-username invites
// (bootstrap, etc.). Origin must match ISOMUX_PUBLIC_ORIGIN.
export async function handleAccept(
  req: Request,
  officeName: string | null,
): Promise<Response> {
  if (!originValidForAuthPost(req)) {
    return new Response("bad origin", { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const tokenField = form?.get("token");
  const nameField = form?.get("name");
  const token = typeof tokenField === "string" ? tokenField : "";
  const name = typeof nameField === "string" ? nameField : "";
  if (!token) return renderInviteError("not_found", officeName);
  const ua = req.headers.get("user-agent");
  const result = await acceptInvite(token, { userAgent: ua, chosenName: name });
  if (!result.ok) {
    if (result.error === "needs_name" || result.error === "invalid_name") {
      return new Response(
        renderAcceptPage(
          token,
          true,
          "Please pick a display name.",
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
    return renderInviteError(result.error, officeName);
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

// POST /auth/logout — clear the cookie and revoke the session server-side.
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
    return new Response(
      renderLockoutBlocked(
        "Sign out refused: this is the last active owner session in the " +
          "office. Mint an additional invite for yourself and accept it " +
          "on another device first, then retry.",
        officeName,
      ),
      {
        status: 409,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Lockout-blocked page is tokenless — same rationale as the
          // login page above.
          ...securityHeaders({ tokenInUrl: false }),
        },
      },
    );
  }
  if (lookup) {
    await logoutBySessionHash(lookup.sessionIdHash);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearCookieHeader(),
      ...securityHeaders(),
    },
  });
}

function renderLockoutBlocked(
  message: string,
  officeName: string | null,
): string {
  return baseHtml(
    authPageTitle(officeName, "sign out blocked"),
    `<h1>Sign out blocked</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">Return to office</a></p>`,
  );
}

// /auth/* POSTs are exclusively browser-driven. Unlike the agent-API
// endpoints (which accept missing Origin from local curl), these require
// an explicit Origin match — except for the absent/`null` Origin case,
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
    return handleClaimForm(officeName);
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    return handleClaim(req, server, officeName);
  }
  // GET /i/<token> — peek + render accept page (NEVER consumes).
  if (req.method === "GET" && url.pathname.startsWith("/i/")) {
    const token = url.pathname.slice(3);
    if (!token) return renderInviteError("not_found", officeName);
    return handleInvitePeek(req, token, officeName);
  }
  // POST /auth/accept — actually consumes the invite. Origin-checked.
  if (url.pathname === "/auth/accept" && req.method === "POST") {
    return handleAccept(req, officeName);
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    return handleLogout(req, officeName);
  }
  // GET /auth/login-bg.png — pre-auth static asset (the login page's
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
function handleClaimForm(officeName: string | null): Response {
  return new Response(renderClaimPage(null, officeName), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders({ tokenInUrl: false }),
    },
  });
}

// POST /auth/claim — consume the tokenless form, create the owner record,
// set the cookie. Locality is enforced at multiple layers:
//   1. The server bind (127.0.0.1 pre-claim) keeps off-box clients off the
//      TCP socket entirely;
//   2. requestIsLoopback rejects non-loopback peers if the bind has been
//      widened by operator override;
//   3. A strict same-origin check rejects ordinary browser POSTs from
//      pages on other origins (CSRF defense).
//
// The strict-Origin check does NOT close the "non-browser client forges
// Origin over a same-host proxy" case — curl can set Origin to anything,
// including the exact loopback value. A reverse proxy or tunnel running
// on the same box that forwards external traffic to localhost:4000 is
// indistinguishable from a real local browser at the peer-IP level. This
// is an inherent topology limit; the documented mitigation is operator
// discipline (claim first, expose later — see docs/access-and-invites.md
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
    const errorMsg =
      result.error === "owner_exists"
        ? "This office already has an owner. Refresh and sign in with an invite link instead."
        : "Please pick a display name (letters, numbers, spaces, periods, hyphens, apostrophes, or underscores).";
    return new Response(renderClaimPage(errorMsg, officeName), {
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
  // is missing — e.g. a dev install that didn't run build:ui — fall back
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

// ---------------------------------------------------------------------------
// HTML helpers. Kept inline to avoid a separate templating layer; the auth
// pages are static enough that string concatenation is clearer than spinning
// up a renderer.

function renderLoginPage(officeName: string | null): string {
  // The visible page body remains generic — the backdrop is a baked
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
          ? `<p>This office requires an invite link.</p>
      <p>If the owner sent you a URL, open it. Each invite link signs you in on the device that opens it.</p>
      <p class="muted">If you don't have one, ask the office owner to issue one from the Invites pane.</p>`
          : `<p>No owner has been set up for this office yet.</p>
      <p>Open <a href="/">this office's home page</a> to claim ownership.</p>
      <p class="muted">If you're trying to reach this office from another machine, you'll need to SSH-tunnel first (the claim form is only reachable from loopback). The server's startup log spells out the exact <code>ssh -L</code> command.</p>`
      }
    </main>
  `;
  return baseHtml(
    authPageTitle(officeName, "sign in"),
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
  errorMsg: string | null,
  officeName: string | null,
): string {
  const err = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
  // Match the open-graph treatment from renderAcceptPage; no image, generic
  // copy that reveals nothing about the deployment.
  const og = {
    title: "Isomux — first-time setup",
    description: "Claim ownership of a new Isomux office.",
  };
  return baseHtml(
    authPageTitle(officeName, "first-time setup"),
    `
    <div class="login-bg" aria-hidden="true"></div>
    <main class="card">
      <h1>Welcome to your new Isomux office</h1>
      <p>You're the first person to claim this office. Pick a display name; it'll appear next to anything you say.</p>
      <form method="POST" action="/auth/claim">
        <label>Display name <input name="name" type="text" autofocus maxlength="64" required pattern="[\\p{L}\\p{N} ._'\\-]+" /></label>
        ${err}
        <button type="submit">Continue</button>
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
  token: string,
  needsName: boolean,
  errorMsg: string | null,
  officeName: string | null,
): string {
  const safeToken = escapeAttr(token);
  const err = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
  // Open-graph metadata so chat-app link unfurlers show a readable preview
  // instead of just the opaque token URL. No image (intentional: any image
  // route would still be fetched by third-party preview services who see
  // the bearer URL anyway; keep the cost matched to the gain). The office
  // name is intentionally NOT plumbed into OG fields — those are scraped
  // by external preview services we shouldn't leak the office name to.
  const og = {
    title: needsName ? "Isomux — first-time setup" : "Isomux — accept invite",
    description: needsName
      ? "Open this link to claim ownership of an Isomux office."
      : "Open this link to sign in to an Isomux office on this device.",
  };
  if (needsName) {
    // Bootstrap (or any null-username invite): invitee picks their display
    // name. The form double-purposes as the "accept" gesture, so a link
    // previewer can't burn it just by fetching the URL.
    return baseHtml(
      authPageTitle(officeName, "first-time setup"),
      `
      <div class="login-bg" aria-hidden="true"></div>
      <main class="card">
        <h1>Welcome to your new Isomux office</h1>
        <p>You're the first person to claim this office. Pick a display name — it'll appear next to anything you say.</p>
        <form method="POST" action="/auth/accept">
          <input type="hidden" name="token" value="${safeToken}" />
          <label>Display name <input name="name" type="text" autofocus maxlength="64" required pattern="[\\p{L}\\p{N} ._'\\-]+" /></label>
          ${err}
          <button type="submit">Continue</button>
        </form>
      </main>
      `,
      og,
      PREAUTH_EXTRA_CSS,
    );
  }
  // Pre-named invite: a single-click accept gesture. Same anti-preview
  // property — the GET only renders the form; consumption is on POST. When
  // the office has a display name we surface it in the heading so the
  // invitee can confirm they're joining the right office before clicking.
  const heading = officeName
    ? `Open your invite to the Isomux office: ${escapeHtml(officeName)}`
    : "Open your Isomux invite";
  return baseHtml(
    authPageTitle(officeName, "accept invite"),
    `
    <div class="login-bg" aria-hidden="true"></div>
    <main class="card">
      <h1>${heading}</h1>
      <p>Clicking the button below will sign you in on this device.</p>
      <form method="POST" action="/auth/accept">
        <input type="hidden" name="token" value="${safeToken}" />
        ${err}
        <button type="submit" autofocus>Accept and continue</button>
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
// failed" even though they're signed in — send them into the office
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

function renderInviteError(kind: string, officeName: string | null): Response {
  const msg =
    kind === "consumed"
      ? "This invite has already been used."
      : kind === "expired"
        ? "This invite has expired."
        : kind === "role_mismatch"
          ? "This invite can't be accepted because the existing user has a different role. Ask the owner to mint a new invite."
          : kind === "owner_exists"
            ? "This office already has an owner. Bootstrap invites stop working once the office has been claimed."
            : "This invite is no longer valid.";
  const body = baseHtml(
    authPageTitle(officeName, "invite"),
    `<h1>Invite unavailable</h1><p>${escapeHtml(msg)}</p>`,
  );
  return new Response(body, {
    status: 410, // Gone — invite was once valid (or never)
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders(),
    },
  });
}

function baseHtml(
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
<html lang="en">
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
