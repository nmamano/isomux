import { describe, expect, test } from "bun:test";
import { translatorFor } from "./i18n/translate";
import {
  RATE_LIMITED_MARKER,
  RATE_LIMITED_SIGNIN_URL,
} from "./rate-limit-marker";
import {
  authLimiter,
  clientKey,
  createLimiter,
  isCountedAuthPath,
  limitRequest,
  signupLimiter,
  UNKNOWN_CLIENT,
  withAuthLimit,
} from "./rate-limit.server";

const ORIGIN = "https://storefront.example.com";
const WINDOW = 10 * 60 * 1000;

// Each test takes its own documentation-range addresses: the module-level
// limiters are shared by every test in this process.
let nextAddress = 1;
function freshAddress(): string {
  return `198.51.100.${nextAddress++}`;
}

function request(
  path: string,
  init: {
    method?: string;
    address?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.address !== undefined) headers.set("x-forwarded-for", init.address);
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

describe("the fixed-window limiter", () => {
  test("allows the limit, refuses the next, and opens a new window exactly at its end", () => {
    const limiter = createLimiter({ limit: 3, windowMs: WINDOW, maxKeys: 10 });
    const start = 1_000_000;
    expect([0, 1, 2].map((i) => limiter.take("a", start + i).allowed)).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take("a", start + WINDOW - 1).allowed).toBe(false);
    expect(limiter.take("a", start + WINDOW).allowed).toBe(true);
  });

  test("Retry-After is the window remainder rounded up to whole seconds, at least one", () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    const start = 5_000_000;
    limiter.take("a", start);
    expect(limiter.take("a", start)).toEqual({
      allowed: false,
      retryAfterSeconds: WINDOW / 1000,
    });
    expect(limiter.take("a", start + WINDOW - 1500)).toEqual({
      allowed: false,
      retryAfterSeconds: 2,
    });
    expect(limiter.take("a", start + WINDOW - 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  test("keys are independent", () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    expect(limiter.take("a", 0).allowed).toBe(true);
    expect(limiter.take("a", 0).allowed).toBe(false);
    expect(limiter.take("b", 0).allowed).toBe(true);
  });

  test("at the key cap, expired windows go first, then the oldest live one", () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 2 });
    limiter.take("expired", 0);
    limiter.take("live", WINDOW / 2);
    // "expired" has run out by now; making room for "new" drops it, not "live".
    limiter.take("new", WINDOW + 1);
    expect(limiter.take("live", WINDOW + 2).allowed).toBe(false);
    // All tracked windows are live: the oldest ("live") makes room.
    limiter.take("newer", WINDOW + 3);
    expect(limiter.take("live", WINDOW + 4).allowed).toBe(true);
  });
});

describe("the client key", () => {
  test("is the whole X-Forwarded-For value the proxy set", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": " 203.0.113.9 " }))).toBe(
      "203.0.113.9",
    );
  });

  test("missing and blank addresses share one bucket", () => {
    const keys = [
      new Headers(),
      new Headers({ "x-forwarded-for": "" }),
      new Headers({ "x-forwarded-for": "   " }),
    ].map(clientKey);
    expect(keys).toEqual([UNKNOWN_CLIENT, UNKNOWN_CLIENT, UNKNOWN_CLIENT]);
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    expect(keys.map((key) => limiter.take(key, 0).allowed)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("the counted sign-in paths", () => {
  test("sign-in start and callback count, with or without a query", () => {
    for (const path of [
      "/api/auth/signin/google",
      "/api/auth/callback/google",
      "/api/auth/callback/dev",
    ]) {
      expect(isCountedAuthPath(new URL(`${ORIGIN}${path}?a=b`).pathname)).toBe(
        true,
      );
    }
  });

  test("csrf, session, providers and the bare sign-in page do not", () => {
    for (const path of [
      "/api/auth/csrf",
      "/api/auth/session",
      "/api/auth/providers",
      "/api/auth/signin",
      "/api/auth/signout",
      "/api/signup",
    ]) {
      expect(isCountedAuthPath(path)).toBe(false);
    }
  });
});

describe("the 429", () => {
  test("carries a numeric Retry-After and the translated sentence as text", async () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    const address = freshAddress();
    const make = () =>
      request("/api/signup", {
        method: "POST",
        address,
        headers: { "accept-language": "es" },
      });
    expect(limitRequest(limiter, make(), 0)).toBeNull();
    const refusal = limitRequest(limiter, make(), 1000);
    expect(refusal?.status).toBe(429);
    expect(refusal?.headers.get("retry-after")).toBe(String(WINDOW / 1000 - 1));
    expect(refusal?.headers.get("content-type")).toStartWith("text/plain");
    expect(await refusal?.text()).toBe(
      translatorFor("es").t("errors.rateLimited"),
    );
  });

  test("the language cookie wins over Accept-Language", async () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    limiter.take("x", 0);
    const refusal = limitRequest(
      limiter,
      request("/api/signup", {
        method: "POST",
        address: "x",
        headers: { "accept-language": "es", cookie: "a=1; isomux_lang=ca" },
      }),
      1,
    );
    expect(await refusal?.text()).toBe(
      translatorFor("ca").t("errors.rateLimited"),
    );
  });

  test("a sign-in start from the client library gets the fixed sign-in URL as JSON", async () => {
    const limiter = createLimiter({ limit: 1, windowMs: WINDOW, maxKeys: 10 });
    limiter.take("x", 0);
    const refusal = limitRequest(
      limiter,
      request("/api/auth/signin/google?callbackUrl=https://evil.example", {
        method: "POST",
        address: "x",
        headers: { "x-auth-return-redirect": "1" },
      }),
      1,
    );
    expect(refusal?.status).toBe(429);
    expect(Number(refusal?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refusal?.json()).toEqual({ url: RATE_LIMITED_SIGNIN_URL });
    expect(
      new URL(RATE_LIMITED_SIGNIN_URL, ORIGIN).searchParams.get("error"),
    ).toBe(RATE_LIMITED_MARKER);
  });
});

describe("the sign-in quota in front of Auth.js", () => {
  function fakeAuth() {
    const calls: string[] = [];
    const handler = (method: string) => async (r: Request) => {
      calls.push(`${method} ${new URL(r.url).pathname}`);
      return new Response("handled");
    };
    return {
      calls,
      GET: withAuthLimit(handler("GET")),
      POST: withAuthLimit(handler("POST")),
    };
  }

  test("start (POST) and callback (GET) draw on one quota of 40", async () => {
    const auth = fakeAuth();
    const address = freshAddress();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push(
        (
          await auth.POST(
            request("/api/auth/signin/google", { method: "POST", address }),
          )
        ).status,
      );
      statuses.push(
        (
          await auth.GET(
            request("/api/auth/callback/google?code=c", { address }),
          )
        ).status,
      );
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(auth.calls).toHaveLength(40);
    const refusedGet = await auth.GET(
      request("/api/auth/callback/google", { address }),
    );
    const refusedPost = await auth.POST(
      request("/api/auth/signin/google", { method: "POST", address }),
    );
    expect([refusedGet.status, refusedPost.status]).toEqual([429, 429]);
    // Refused before Auth.js ran.
    expect(auth.calls).toHaveLength(40);
  });

  test("uncounted Auth.js paths pass after the quota is spent", async () => {
    const auth = fakeAuth();
    const address = freshAddress();
    for (let i = 0; i < 40; i++) authLimiter.take(address);
    expect(
      (await auth.GET(request("/api/auth/callback/google", { address })))
        .status,
    ).toBe(429);
    for (const path of [
      "/api/auth/csrf",
      "/api/auth/session",
      "/api/auth/providers",
    ]) {
      expect((await auth.GET(request(path, { address }))).status).toBe(200);
    }
  });

  test("another address and the checkout-start quota are untouched", async () => {
    const auth = fakeAuth();
    const spent = freshAddress();
    for (let i = 0; i < 40; i++) authLimiter.take(spent);
    expect(
      (await auth.GET(request("/api/auth/callback/google", { address: spent })))
        .status,
    ).toBe(429);
    expect(
      (
        await auth.GET(
          request("/api/auth/callback/google", { address: freshAddress() }),
        )
      ).status,
    ).toBe(200);
    expect(
      limitRequest(
        signupLimiter,
        request("/api/signup", { method: "POST", address: spent }),
      ),
    ).toBeNull();
  });
});
