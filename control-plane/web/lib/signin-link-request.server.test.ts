// POST /api/signin/email: who may ask for a link, how often, and where the link
// points.
//
// Every dependency is passed in except the origin check, which is the real one:
// the route sends mail on behalf of whoever posts to it, so a cross-site post is
// a mail-bomb by proxy, and a link built from anything but the deployment's own
// origin sends a customer's token to another host.

import { beforeEach, describe, expect, test } from "bun:test";
import { createLimiter, type Limiter } from "./rate-limit.server";
import {
  handleSignInLinkRequest,
  type SignInLinkDeps,
} from "./signin-link-request.server";
import { createSignInTokens } from "./signin-link.server";
import { LANGUAGE_COOKIE, SUPPORTED_LANGUAGES } from "./i18n/languages";
import { translatorFor } from "./i18n/translate";
import { SUPPORT_EMAIL } from "./support-email";

const ORIGIN = "https://hosted.example.com";
const CONTAINER = "http://localhost:3000";
const KEY = "re_route_test_key_51c0d2";
const SECRET = "route-test-secret-0123456789abcdef";

beforeEach(() => {
  // Read per request by the real origin check. Set per test: other files in
  // the same process set it too.
  process.env.AUTH_URL = ORIGIN;
});

type Mail = Parameters<SignInLinkDeps["sendMail"]>[0];

function wide(): Limiter {
  return createLimiter({ limit: 1000, windowMs: 600_000, maxKeys: 100 });
}

function harness(over: Partial<SignInLinkDeps> = {}) {
  const mails: Mail[] = [];
  const keys: string[] = [];
  const tokens = createSignInTokens({ secret: SECRET });
  const deps: SignInLinkDeps = {
    apiKey: KEY,
    tokens,
    ipLimiter: wide(),
    addressLimiter: wide(),
    sendMail: async (mail, auth) => {
      mails.push(mail);
      keys.push(auth.apiKey);
      return { ok: true };
    },
    ...over,
  };
  return { deps, mails, keys, tokens };
}

let address = 10;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${CONTAINER}/api/signin/email`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${address++}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("a request that gets a link", () => {
  test("mails one link to the normalized address, on the deployment origin, token in the fragment only", async () => {
    const { deps, mails, keys, tokens } = harness();
    const response = await handleSignInLinkRequest(
      post({ email: "  User@Proton.ME " }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mails.length).toBe(1);
    expect(keys).toEqual([KEY]);
    const [mail] = mails;
    expect(mail.to).toBe("user@proton.me");
    const link = new URL(mail.link);
    // The deployment origin, not the container origin the request URL carries.
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/signin/email");
    // Nothing in the query: a query reaches the proxy log, the server log and
    // a Referer; a fragment reaches none of them.
    expect(link.search).toBe("");
    const fragment = new URLSearchParams(link.hash.slice(1));
    const token = fragment.get("token") ?? "";
    expect(tokens.redeem(token)).toEqual({
      ok: true,
      email: "user@proton.me",
    });
  });

  test("the mail is in the visitor's language: the cookie first, then Accept-Language", async () => {
    const { deps, mails } = harness();
    await handleSignInLinkRequest(
      post({ email: "a@example.com" }, { "accept-language": "es-ES,es;q=0.9" }),
      deps,
    );
    await handleSignInLinkRequest(
      post(
        { email: "b@example.com" },
        { "accept-language": "es-ES", cookie: `${LANGUAGE_COOKIE}=ca` },
      ),
      deps,
    );
    expect(mails.map((m) => m.language)).toEqual(["es", "ca"]);
  });
});

describe("a request that is refused", () => {
  test("a post from another site, or with no origin, sends nothing", async () => {
    const { deps, mails } = harness();
    const foreign = await handleSignInLinkRequest(
      post({ email: "a@example.com" }, { origin: "https://evil.example.net" }),
      deps,
    );
    const request = post({ email: "a@example.com" });
    request.headers.delete("origin");
    const missing = await handleSignInLinkRequest(request, deps);
    expect([foreign.status, missing.status]).toEqual([403, 403]);
    expect(mails.length).toBe(0);
  });

  test("without a mail key or a signing secret the route is unavailable, sends nothing, and names support in the visitor's language", async () => {
    for (const missing of [{ apiKey: undefined }, { tokens: undefined }]) {
      const { deps, mails } = harness(missing);
      for (const { code } of SUPPORTED_LANGUAGES) {
        const response = await handleSignInLinkRequest(
          post(
            { email: "a@example.com" },
            { cookie: `${LANGUAGE_COOKIE}=${code}` },
          ),
          deps,
        );
        const body = await response.text();
        const label = [Object.keys(missing)[0], code];
        expect([...label, response.status]).toEqual([...label, 503]);
        // The body is the visitor's language, and says where to write.
        expect([...label, body]).toEqual([
          ...label,
          translatorFor(code).t("signIn.emailUnavailable", {
            support: SUPPORT_EMAIL,
          }),
        ]);
        expect([...label, body.includes(SUPPORT_EMAIL)]).toEqual([
          ...label,
          true,
        ]);
      }
      expect(mails.length).toBe(0);
    }
  });

  test("a body that is not one address is a 400 and sends nothing", async () => {
    const { deps, mails } = harness();
    for (const body of [
      { email: "not-an-address" },
      { email: ["a@example.com"] },
      {},
      "not json",
    ]) {
      const response = await handleSignInLinkRequest(post(body), deps);
      expect(response.status).toBe(400);
    }
    expect(mails.length).toBe(0);
  });

  test("one client past its quota is refused, whatever address it asks for", async () => {
    const { deps, mails } = harness({
      ipLimiter: createLimiter({ limit: 2, windowMs: 600_000, maxKeys: 100 }),
    });
    const ip = { "x-forwarded-for": "203.0.113.7" };
    const statuses: number[] = [];
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      statuses.push(
        (await handleSignInLinkRequest(post({ email }, ip), deps)).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(mails.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
    // Another client is not affected.
    const other = await handleSignInLinkRequest(
      post({ email: "c@example.com" }),
      deps,
    );
    expect(other.status).toBe(200);
  });

  test("one address past its quota is refused from every client, however it is written", async () => {
    const { deps, mails } = harness({
      addressLimiter: createLimiter({
        limit: 2,
        windowMs: 600_000,
        maxKeys: 100,
      }),
    });
    const statuses: number[] = [];
    // A fresh client address per request: only the address quota can refuse.
    for (const email of [
      "victim@example.com",
      "Victim@Example.com",
      " VICTIM@example.COM",
    ]) {
      statuses.push(
        (await handleSignInLinkRequest(post({ email }), deps)).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(mails.length).toBe(2);
    const another = await handleSignInLinkRequest(
      post({ email: "someone@example.com" }),
      deps,
    );
    expect(another.status).toBe(200);
  });

  test("a mail the sender refuses or cannot deliver is a 502", async () => {
    for (const sendMail of [
      async () => ({ ok: false as const, reason: "provider said no" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const { deps } = harness({ sendMail });
      const response = await handleSignInLinkRequest(
        post({ email: "a@example.com" }),
        deps,
      );
      expect(response.status).toBe(502);
    }
  });
});
