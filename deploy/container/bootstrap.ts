import { createHash } from "node:crypto";
import type { ClaimErr } from "../../server/auth.ts";
import {
  claimWithSetupKey,
  renderSetupPage,
  type SetupKeyHelp,
} from "../../server/auth-middleware.ts";
import { translatorForRequest } from "../../server/i18n.ts";
import {
  SETUP_KEY_MIN_LENGTH,
  setupKeyMatches,
} from "../../server/setup-key.ts";

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

// The office takes the port only some seconds after this listener closes, and
// a proxy answers 502 in that gap. The starting page therefore polls and opens
// the office only once it answers: 200 with the new session, 401 without one
// (as probe.ts reads it). After the claim, this listener answers 409.
const startingScript = `const poll=async()=>{try{const r=await fetch("/",{cache:"no-store"});if(r.status===200||r.status===401)return location.replace("/")}catch{}setTimeout(poll,1000)};setTimeout(poll,1000)`;
const startingHeaders = {
  ...headers,
  "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${createHash("sha256").update(startingScript).digest("base64")}'; connect-src 'self'; frame-ancestors 'none'`,
};
const startingPage = `<!doctype html><title>Office ready</title><p>Your office is starting.</p><script>${startingScript}</script>`;

// The container's setup listener, which serves before the office boots. It
// serves the office's own setup form and claim (server/auth-middleware.ts):
// GET / and GET /setup show the form, POST /auth/claim claims. POST /setup
// stays as an alias for scripts written against the older setup page.
// `client` is the caller's address as server/proxy-trust.ts resolves it.
export function createSetupHandler(options: {
  key: string;
  hasOwner: () => boolean;
  claim: (
    name: string,
    userAgent: string | null,
  ) => Promise<{ ok: true; cookie: string } | ClaimErr>;
  complete: () => void;
}) {
  if (options.key.length < SETUP_KEY_MIN_LENGTH)
    throw new Error(
      `Setup key must contain at least ${SETUP_KEY_MIN_LENGTH} characters`,
    );
  const keyHelp: SetupKeyHelp =
    process.env.RENDER === "true" ? "render" : "container";
  let claimed = false;
  return async (request: Request, client: string): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return new Response("ok");
    if (options.hasOwner() || claimed)
      return new Response("Office setup is complete", { status: 409 });
    const i18n = translatorForRequest(
      null,
      request.headers.get("accept-language"),
    );
    if ((path === "/" || path === "/setup") && request.method === "GET")
      return renderSetupPage(i18n, { officeName: null, keyHelp });
    if (
      (path !== "/auth/claim" && path !== "/setup") ||
      request.method !== "POST"
    )
      return new Response("Not found", { status: 404 });
    const result = await claimWithSetupKey(request, {
      client,
      i18n,
      officeName: null,
      keyHelp,
      keyMatches: (key) => setupKeyMatches(key, options.key),
      claim: options.claim,
    });
    if (result instanceof Response) return result;
    claimed = true;
    // Give the browser its cookie before replacing this listener with the office.
    setTimeout(options.complete, 500);
    return new Response(startingPage, {
      headers: { ...startingHeaders, "Set-Cookie": result.cookie },
    });
  };
}
