// HTTP middleware + WS upgrade auth + /auth/* routes.
//
// The whole gating layer lives in this file so a future audit can read one
// file end-to-end and trace every request shape.

import type { Server } from "bun";
import {
  acceptInvite,
  buildPublicOrigin,
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
// Auth-result type that the index.ts dispatcher consumes.

export interface AuthOk {
  kind: "ok";
  session: SessionLookup;
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
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Browser-tab title for /auth/* and /i/<token> pages. Mirrors the format
// used by the SPA shell (see serveIndexHtml in server/index.ts) so the tab
// title stays consistent across authenticated and pre-auth surfaces.
function authPageTitle(officeName: string | null, suffix: string): string {
  return officeName
    ? `${officeName} | Isomux — ${suffix}`
    : `Isomux — ${suffix}`;
}

// ---------------------------------------------------------------------------
// Gating function. Called at the top of every fetch handler.
//
// The `allowLoopback` parameter is true for endpoints agents legitimately hit
// from the same box (POST /tasks, POST /agents/:id/message, etc.). It's
// false for the SPA shell and static assets, so a same-box browser still has
// to claim a cookie via /i/<token> instead of getting a half-functional
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
  return { kind: "ok", session };
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
  _req: Request,
  token: string,
  officeName: string | null,
): Response {
  const peek = peekInvite(token);
  if ("error" in peek) return renderInviteError(peek.error, officeName);
  return new Response(
    renderAcceptPage(token, peek.needsName, null, officeName),
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
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
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    return renderInviteError(result.error, officeName);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": setCookieHeader(
        result.rawSessionId,
        result.absoluteExpiresAt,
      ),
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
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
  if (lookup) {
    await logoutBySessionHash(lookup.sessionIdHash);
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": clearCookieHeader() },
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
// an explicit Origin match. There's no legitimate use case for a non-
// browser caller hitting them.
function originValidForAuthPost(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return checkOrigin(req);
}

// Top-level router used by index.ts: returns null when the path isn't an
// /auth/* path, so the caller falls through to its normal dispatch.
export async function tryHandleAuthRoute(
  req: Request,
  url: URL,
  officeName: string | null,
): Promise<Response | null> {
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
      <p class="muted">If you don't have one, ask the office owner to issue one from the Access pane.</p>`
          : `<p>No owner exists for this office yet.</p>
      <p>The server printed a one-time bootstrap URL to its log on startup. Open that URL to claim ownership.</p>
      <p class="muted">For the systemd service, check <code>journalctl --user -u isomux</code>. If the URL was lost, restart with <code>--regenerate-bootstrap</code>.</p>`
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

function renderInviteError(kind: string, officeName: string | null): Response {
  const msg =
    kind === "consumed"
      ? "This invite has already been used."
      : kind === "expired"
        ? "This invite has expired."
        : kind === "role_mismatch"
          ? "This invite can't be accepted because the existing user has a different role. Ask the owner to mint a new invite."
          : "This invite is no longer valid.";
  const body = baseHtml(
    authPageTitle(officeName, "invite"),
    `<h1>Invite unavailable</h1><p>${escapeHtml(msg)}</p>`,
  );
  return new Response(body, {
    status: 410, // Gone — invite was once valid (or never)
    headers: { "Content-Type": "text/html; charset=utf-8" },
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
