// Every byte an app hostname can send back before a real app answers.
//
// One module for two reasons. The first is a security property: several
// different situations have to be EXTERNALLY INDISTINGUISHABLE - an unknown
// label and a retired one, an expired sign-in code and a forged one, a
// registry that cannot be read and a label that was never issued. That
// promise is only as good as the response bytes, so the bytes live in one
// place and are shared by both arms (the app-host arm in app-hosts.ts and the
// handshake in app-auth.ts) rather than duplicated as literals that could
// drift a word apart. The second is prosaic: this is where every user-visible
// string on this surface is, for a wording pass.
//
// Nothing here reads the request. No body carries a host, a label, a path, a
// code or session material, so there is no reflection surface at all, and no
// response varies with who is asking.

// --- bodies -----------------------------------------------------------------

// The refusal. Sent for a label that names no live app - never issued, or
// issued once and retired - and for anything under an app host that is not a
// route. "This label used to be somebody's app" is not the internet's
// business, so all of it is one answer.
export const NOT_FOUND_BODY = "not found\n";

// A live app, an authenticated caller, and nothing to relay yet: slice 5
// replaces this with the app's own bytes.
export const NOT_READY_BODY = "this app is not reachable yet\n";

// A live app and no valid app session, on a request that could not complete the
// sign-in handshake anyway: an unsafe method, a HEAD, or Fetch Metadata saying
// this is a subresource rather than a navigation. None of them can finish a
// redirect chain that ends in a cookie, so they are told plainly instead of
// being sent into one.
export const AUTH_REQUIRED_BODY = "authentication required\n";

// A sign-in code that did not work, for every reason it can fail: unknown,
// already used, expired, minted for a different app host, minted against an
// office session that has since been revoked, or presented while the app's
// redeem budget was spent. One body, deliberately - the differences are not
// something an anonymous caller gets to probe for.
export const SIGN_IN_FAILED_BODY =
  "sign-in link expired; open the app again from the office\n";

// The office refused to mint another code for this session this minute. Also
// the loop breaker: a browser that will not store the app cookie would
// otherwise bounce between the app host and the office forever.
export const MINT_LIMITED_BODY =
  "too many app sign-in attempts; wait a minute and try again\n";

// A malformed request to the office's mint endpoint: a return path that is not
// a path, or a repeated parameter. Distinct from "not found" because the
// caller is a signed-in office user who can act on it.
export const BAD_REQUEST_BODY = "bad request\n";

// --- responses --------------------------------------------------------------

// The plain refusal, exactly as slice 3 shipped it. Byte-for-byte frozen:
// app-host-dispatch.test.ts compares whole responses, and the indistinguisha-
// bility promise above is what those comparisons protect.
export function neutral(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// THE 404. Every "no" that must be indistinguishable from every other "no"
// goes through this one call, on both arms.
export function neutralNotFound(): Response {
  return neutral(404, NOT_FOUND_BODY);
}

// A handshake response. Same as `neutral` plus `Referrer-Policy: no-referrer`,
// which is load-bearing rather than decorative: these are the responses whose
// own URL carries a single-use code, and the referrer of the NEXT request is
// governed by the header on THIS one. Without it the app itself would be
// handed the code in a `Referer` header the moment the page loaded anything.
export function handshake(
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

// A handshake redirect. `Set-Cookie` lines go through Headers.append: an array
// in a plain headers object is silently dropped by Bun (the slice-2 trap), and
// silently dropping the cookie here would produce an endless redirect.
export function handshakeRedirect(
  location: string,
  setCookieLines: string[] = [],
): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const line of setCookieLines) headers.append("Set-Cookie", line);
  return new Response(null, { status: 302, headers });
}
