// The two routes wire their quotas where the design puts them. Outside a Next
// request, `auth()` throws: a route that answers 429 there refused the request
// before asking for the session.

import { describe, expect, test } from "bun:test";
import { RATE_LIMITED_SIGNIN_URL } from "../../lib/rate-limit-marker";
import { authLimiter, signupLimiter } from "../../lib/rate-limit.server";
import * as authRoute from "./auth/[...nextauth]/route";
import * as signupRoute from "./signup/route";

const ORIGIN = "https://storefront.example.com";
process.env.AUTH_URL = ORIGIN;

/** A body that fails the request if anything reads it. */
function unreadableBody(): ReadableStream {
  return new ReadableStream({
    pull() {
      throw new Error("the body was read");
    },
  });
}

function signupPost(address: string, origin: string): Request {
  return new Request(`${ORIGIN}/api/signup`, {
    method: "POST",
    headers: { origin, "x-forwarded-for": address },
    body: unreadableBody(),
  });
}

describe("POST /api/signup", () => {
  test("past the quota: 429 before the session, the form and any business call", async () => {
    const address = "192.0.2.10";
    for (let i = 0; i < 10; i++) signupLimiter.take(address);
    const response = await signupRoute.POST(signupPost(address, ORIGIN));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("an off-origin post is refused without spending the quota", async () => {
    const address = "192.0.2.11";
    for (let i = 0; i < 12; i++) {
      const response = await signupRoute.POST(
        signupPost(address, "https://elsewhere.example"),
      );
      expect(response.status).toBe(403);
    }
    const left = Array.from({ length: 10 }, () => signupLimiter.take(address));
    expect(left.every((decision) => decision.allowed)).toBe(true);
  });
});

describe("the Auth.js route", () => {
  test("a spent address is refused on the callback and on sign-in start", async () => {
    const address = "192.0.2.20";
    for (let i = 0; i < 40; i++) authLimiter.take(address);
    const callback = await authRoute.GET(
      new Request(`${ORIGIN}/api/auth/callback/google?code=c&state=s`, {
        headers: { "x-forwarded-for": address },
      }) as Parameters<typeof authRoute.GET>[0],
    );
    expect(callback.status).toBe(429);
    const start = await authRoute.POST(
      new Request(`${ORIGIN}/api/auth/signin/google`, {
        method: "POST",
        headers: { "x-forwarded-for": address, "x-auth-return-redirect": "1" },
      }) as Parameters<typeof authRoute.POST>[0],
    );
    expect(start.status).toBe(429);
    expect(await start.json()).toEqual({ url: RATE_LIMITED_SIGNIN_URL });
  });
});
