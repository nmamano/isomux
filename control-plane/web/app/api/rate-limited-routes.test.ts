// The two routes wire their quotas where the design puts them. Outside a Next
// request, `auth()` throws: a route that answers 429 there refused the request
// before asking for the session.

import { describe, expect, test } from "bun:test";
import { RATE_LIMITED_SIGNIN_URL } from "../../lib/rate-limit-marker";
import {
  authLimiter,
  incidentLimiter,
  signupLimiter,
} from "../../lib/rate-limit.server";
import * as authRoute from "./auth/[...nextauth]/route";
import * as incidentsRoute from "./ops/incidents/route";
import * as incidentUpdatesRoute from "./ops/incidents/[id]/updates/route";
import * as enterpriseRoute from "./enterprise/route";
import * as enterpriseAgreementRoute from "./enterprise/agreement/route";
import * as enterpriseSeatsRoute from "./enterprise/seats/route";
import * as enterpriseSecretRoute from "./enterprise/secret/route";
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

describe("the critical-issue routes", () => {
  test("a spent address is refused before the key and the body", async () => {
    const address = "192.0.2.30";
    for (let i = 0; i < 60; i++) incidentLimiter.take(address);
    const posted = await incidentUpdatesRoute.POST(
      new Request(`${ORIGIN}/api/ops/incidents/i-1/updates`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: "Bearer some-key",
          "x-forwarded-for": address,
        },
        body: unreadableBody(),
      }),
      { params: Promise.resolve({ id: "i-1" }) },
    );
    expect(posted.status).toBe(429);
    const listed = await incidentsRoute.GET(
      new Request(`${ORIGIN}/api/ops/incidents?due=1`, {
        headers: {
          authorization: "Bearer some-key",
          "x-forwarded-for": address,
        },
      }),
    );
    expect(listed.status).toBe(429);
  });
});

describe("the enterprise account routes", () => {
  test("one address past its quota is refused before the session and the body", async () => {
    const routes = {
      "/api/enterprise": enterpriseRoute,
      "/api/enterprise/agreement": enterpriseAgreementRoute,
      "/api/enterprise/seats": enterpriseSeatsRoute,
      "/api/enterprise/secret": enterpriseSecretRoute,
    };
    let n = 40;
    for (const [pathname, route] of Object.entries(routes)) {
      const address = `192.0.2.${n++}`;
      // Under the quota, `auth()` throws outside a Next request; past it, the
      // route answers 429 without reaching it.
      let refused: Response | null = null;
      for (let i = 0; i < 200 && !refused; i++) {
        const response = await route
          .POST(
            new Request(`${ORIGIN}${pathname}`, {
              method: "POST",
              headers: { origin: ORIGIN, "x-forwarded-for": address },
              body: unreadableBody(),
            }),
          )
          .catch(() => null);
        if (response?.status === 429) refused = response;
      }
      expect({ pathname, status: refused?.status }).toEqual({
        pathname,
        status: 429,
      });
      expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another address is not refused.
      const other = await route
        .POST(
          new Request(`${ORIGIN}${pathname}`, {
            method: "POST",
            headers: { origin: ORIGIN, "x-forwarded-for": `192.0.2.${n++}` },
            body: unreadableBody(),
          }),
        )
        .catch(() => null);
      expect({
        pathname,
        status: other?.status ?? "reached the session",
      }).toEqual({
        pathname,
        status: "reached the session",
      });
    }
  });
});
