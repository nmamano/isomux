// /api/unsubscribe: the welcome series opt-out (control-plane/welcome-mail.ts).
//
// POST is the RFC 8058 one-click endpoint named in List-Unsubscribe, so it has
// no Origin check and no session: a mail client sends it, not a page of ours.
// It can only stop the welcome mails of the token's account, and it answers
// the same for an unknown token. GET never unsubscribes: a client without
// one-click support opens the same URL in a browser, and mail scanners open
// links too, so GET redirects to the /unsubscribe page and its button.
//
// Neither handler logs the token: it is the whole credential.

export interface UnsubscribeDeps {
  unsubscribe: (token: string) => Promise<void>;
}

function tokenOf(request: Request): string | null {
  return new URL(request.url).searchParams.get("t") || null;
}

export async function handleUnsubscribePost(
  request: Request,
  deps: UnsubscribeDeps,
): Promise<Response> {
  const token = tokenOf(request);
  if (!token) return new Response("no unsubscribe token", { status: 400 });
  await deps.unsubscribe(token);
  return new Response("unsubscribed", {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export function handleUnsubscribeGet(request: Request): Response {
  const token = tokenOf(request);
  // Relative, so the redirect stays on whatever origin the client used; behind
  // the proxy the request URL is the container's own origin.
  const location = token
    ? `/unsubscribe?t=${encodeURIComponent(token)}`
    : "/unsubscribe";
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}
