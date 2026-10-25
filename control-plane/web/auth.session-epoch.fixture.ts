// Child process for control-plane/web-session-epoch.test.ts: which session
// cookies Auth.js still honours once an account's session epoch moved on.
//
// A separate process because auth.ts decides its providers when it is first
// imported, and because next/headers is replaced here: keepSession runs in a
// route handler, where Next supplies the request's headers and cookie jar, and
// outside Next those calls throw. The stand-in serves one request's cookie
// header and records the cookies set on the response. Everything else - Auth.js,
// the jwt callback, the store - is the real code.
//
// Input (environment): AUTH_SECRET, AUTH_URL, AUTH_RESEND_KEY, and
// CONTROL_PLANE_DB unless the run is FIXTURE_MODE=no-store. FIXTURE_ACCOUNT, an
// account two changes old (epoch 2) at FIXTURE_EMAIL; FIXTURE_FRESH, an account
// that never changed (epoch 0); FIXTURE_SIGNIN_TOKEN, a sign-in link token for
// FIXTURE_EMAIL. Output: one JSON line on stdout.

import { mock } from "bun:test";

const SESSION_COOKIE = "authjs.session-token";
const BASE = process.env.AUTH_URL!;
const SECRET = process.env.AUTH_SECRET!;

let requestHeaders = new Headers();
const setOnResponse = new Map<string, string>();
const realHeaders = await import("next/headers");
await mock.module("next/headers", () => ({
  ...realHeaders,
  headers: async () => requestHeaders,
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: (name: string, value: string) => {
      setOnResponse.set(name, value);
    },
    delete: (name: string) => {
      setOnResponse.set(name, "");
    },
  }),
}));

const { NextRequest } = await import("next/server");
const { encode } = await import("next-auth/jwt");
const { handlers, keepSession } = await import("./auth");

type CookieFate = "reissued" | "cleared" | "untouched";

interface Read {
  accountId: string | null;
  cookie: CookieFate;
}

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

function fate(value: string | undefined): CookieFate {
  if (value === undefined) return "untouched";
  return value === "" ? "cleared" : "reissued";
}

/** A session cookie as Auth.js would have issued it, with these claims. */
async function mint(claims: Record<string, unknown>): Promise<string> {
  return encode({
    token: { email: "someone@example.com", ...claims },
    secret: SECRET,
    salt: SESSION_COOKIE,
  });
}

async function readOf(response: Response): Promise<Read> {
  const body = (await response.json().catch(() => null)) as {
    accountId?: unknown;
  } | null;
  return {
    accountId: typeof body?.accountId === "string" ? body.accountId : null,
    cookie: fate(cookiesOf(response).get(SESSION_COOKIE)),
  };
}

/** GET /api/auth/session, as every page and route reads the session. */
async function read(session: string): Promise<Read> {
  const response = await handlers.GET(
    nextRequest("/api/auth/session", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    }) as never,
  );
  return readOf(response);
}

/** POST /api/auth/session, as next-auth/react's update() sends it from any
 * browser that holds the cookie. */
async function clientUpdate(session: string, data: unknown): Promise<Read> {
  const csrf = await handlers.GET(nextRequest("/api/auth/csrf") as never);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = [
    ...[...cookiesOf(csrf)].map(([k, v]) => `${k}=${v}`),
    `${SESSION_COOKIE}=${session}`,
  ].join("; ");
  const response = await handlers.POST(
    nextRequest("/api/auth/session", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(
        data === undefined ? { csrfToken } : { csrfToken, data },
      ),
    }) as never,
  );
  return readOf(response);
}

/** keepSession inside a route handler whose request carries this cookie, then
 * a read with whatever cookie the response set. */
async function kept(
  session: string,
): Promise<{ threw: boolean; cookie: CookieFate; after: string | null }> {
  requestHeaders = new Headers({
    cookie: `${SESSION_COOKIE}=${session}`,
    host: new URL(BASE).host,
  });
  setOnResponse.clear();
  let threw = false;
  try {
    await keepSession();
  } catch {
    threw = true;
  }
  const value = setOnResponse.get(SESSION_COOKIE);
  return {
    threw,
    cookie: fate(value),
    after: value ? (await read(value)).accountId : null,
  };
}

/** The email-link sign-in, CSRF and all, then a read with its cookie. */
async function signIn(token: string): Promise<string | null> {
  const csrf = await handlers.GET(nextRequest("/api/auth/csrf") as never);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = [...cookiesOf(csrf)].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await handlers.POST(
    nextRequest("/api/auth/callback/email-link", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, csrfToken, callbackUrl: "/" }),
    }) as never,
  );
  const session = cookiesOf(response).get(SESSION_COOKIE);
  return session ? (await read(session)).accountId : null;
}

const ACCOUNT = process.env.FIXTURE_ACCOUNT ?? "";
const FRESH = process.env.FIXTURE_FRESH ?? "";

const current = await mint({ accountId: ACCOUNT, sessionEpoch: 2 });
const stale = await mint({ accountId: ACCOUNT, sessionEpoch: 1 });
const gone = await mint({ accountId: "acct-gone", sessionEpoch: 0 });

if (process.env.FIXTURE_MODE === "no-store") {
  console.log(JSON.stringify({ current: await read(current) }));
  process.exit(0);
}

const result = {
  current: await read(current),
  stale: await read(stale),
  // Issued before the epoch existed: no field.
  unmarkedMoved: await read(await mint({ accountId: ACCOUNT })),
  unmarkedFresh: await read(await mint({ accountId: FRESH })),
  gone: await read(gone),
  noAccount: await read(await mint({ sessionEpoch: 0 })),
  clientUpdateCurrent: await clientUpdate(current, { keep: "a-guess" }),
  clientUpdateStale: await clientUpdate(stale, { keep: "a-guess" }),
  clientUpdateStaleNoData: await clientUpdate(stale, undefined),
  keepStale: await kept(stale),
  keepGone: await kept(gone),
  signedIn: await signIn(process.env.FIXTURE_SIGNIN_TOKEN ?? ""),
};
console.log(JSON.stringify(result));
// The store's pool would otherwise hold the process open for its idle timeout.
process.exit(0);

export {};
