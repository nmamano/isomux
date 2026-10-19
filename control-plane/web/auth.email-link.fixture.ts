// Child process for control-plane/web-email-signin.test.ts: one storefront configuration, from
// the request for a link to the session it ends in.
//
// A separate process because auth.ts decides its providers when it is first
// imported, and the test process may already hold it under another
// configuration. Resend is the one thing replaced: the fetch to it is recorded
// and answered here, so a run never sends mail. Everything else - the request
// route, Auth.js, the provider, the store - is the real code.
//
// Input (environment): AUTH_SECRET, AUTH_URL, CONTROL_PLANE_DB, and optionally
// AUTH_RESEND_KEY; FIXTURE_EMAIL, the address to ask a link for; FIXTURE_TOKEN,
// a token the parent minted, tried directly. Output: one JSON line on stdout.

const resendCalls: { url: string; authorized: boolean; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as { text?: string };
    resendCalls.push({
      url,
      authorized:
        headers.get("authorization") ===
        `Bearer ${process.env.AUTH_RESEND_KEY}`,
      text: body.text ?? "",
    });
    return Response.json({ id: "fixture-email" });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { NextRequest } = await import("next/server");
const { decode } = await import("next-auth/jwt");
const { handlers } = await import("./auth");
const { POST: requestLink } = await import("./app/api/signin/email/route");

const BASE = process.env.AUTH_URL!;
const SECRET = process.env.AUTH_SECRET!;
const SESSION_COOKIE = "authjs.session-token";

function nextRequest(path: string, init?: RequestInit): Request {
  return new NextRequest(`${BASE}${path}`, init as never);
}

function cookiesOf(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return jar;
}

/** One Credentials callback, CSRF and all, as next-auth/react's signIn does
 * it. The account id the resulting session carries, or null for no session. */
async function callback(
  provider: string,
  fields: Record<string, string>,
): Promise<{ status: number; accountId: string | null }> {
  const csrf = await handlers.GET(nextRequest("/api/auth/csrf") as never);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = [...cookiesOf(csrf)].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await handlers.POST(
    nextRequest(`/api/auth/callback/${provider}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...fields, csrfToken, callbackUrl: "/" }),
    }) as never,
  );
  const session = cookiesOf(response).get(SESSION_COOKIE);
  if (!session) return { status: response.status, accountId: null };
  const claims = await decode({
    token: session,
    secret: SECRET,
    salt: SESSION_COOKIE,
  });
  const accountId = claims?.accountId;
  return {
    status: response.status,
    accountId: typeof accountId === "string" ? accountId : null,
  };
}

const providersResponse = await handlers.GET(
  nextRequest("/api/auth/providers") as never,
);
const providers = Object.keys(
  (await providersResponse.json()) as Record<string, unknown>,
);

const linkResponse = await requestLink(
  new Request(`${BASE}/api/signin/email`, {
    method: "POST",
    headers: {
      origin: BASE,
      "content-type": "application/json",
      "x-forwarded-for": "192.0.2.200",
    },
    body: JSON.stringify({ email: process.env.FIXTURE_EMAIL }),
  }),
);

const mailedLink = resendCalls[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? null;
const mailedToken = mailedLink
  ? new URLSearchParams(new URL(mailedLink).hash.slice(1)).get("token")
  : null;

const viaMailedLink = mailedToken
  ? await callback("email-link", { token: mailedToken })
  : null;
const replay = mailedToken
  ? await callback("email-link", { token: mailedToken })
  : null;
const addressOnly = await callback("email-link", {
  email: process.env.FIXTURE_EMAIL ?? "",
});
const parentToken = await callback("email-link", {
  token: process.env.FIXTURE_TOKEN ?? "",
});

console.log(
  JSON.stringify({
    providers,
    linkStatus: linkResponse.status,
    resendCalls: resendCalls.map(({ url, authorized }) => ({
      url,
      authorized,
    })),
    mailedLink,
    viaMailedLink,
    replay,
    addressOnly,
    parentToken,
  }),
);
// The store's pool would otherwise hold the process open for its idle timeout.
process.exit(0);

export {};
