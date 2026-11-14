// The token exchange's pure parts and its cache (task 124eb47e): what the
// proxy sends to the token address, what it accepts back, and how often it
// asks. The cache runs on a fake clock and a fake send; the proxy's own
// fetch is in proxy-exchange.test.ts. Values and tokens are obvious fakes.

import { describe, expect, test } from "bun:test";

import type { ExchangeSpec } from "../../shared/secret-hosts.ts";
import {
  buildExchangeRequest,
  createTokenCache,
  EXCHANGE_401_MIN_AGE_MS,
  EXCHANGE_BACKOFF_MS,
  EXCHANGE_DEFAULT_LIFETIME_MS,
  EXCHANGE_MAX_LIFETIME_MS,
  exchangeFailureText,
  parseExchangeReply,
  refreshMarginMs,
  type ExchangeReply,
  type ExchangeRequest,
} from "./exchange.ts";
import type { ProxySecret } from "./proxy.ts";

const SECRET = "fake-app-secret:with&odd=chars+0001";
const OAUTH: ExchangeSpec = {
  url: "https://auth.stub.test/oauth/token?tenant=t1",
  body: { kind: "oauth", clientAuth: "basic" },
  id: "client:id&0001",
  params: { scope: "read write" },
  tokenField: "access_token",
  expiryField: "expires_in",
};
const FEISHU: ExchangeSpec = {
  url: "https://open.stub.test/open-apis/auth/v3/tenant_access_token/internal",
  body: { kind: "json", idField: "app_id", secretField: "app_secret" },
  id: "cli_fake0001",
  params: {},
  tokenField: "tenant_access_token",
  expiryField: "expire",
};

const headerOf = (request: ExchangeRequest, name: string) =>
  request.headers.find(([n]) => n.toLowerCase() === name)?.[1];

describe("buildExchangeRequest", () => {
  test("OAuth with Basic: the id and secret form-encoded inside Basic, the grant and params in the body", () => {
    const request = buildExchangeRequest(OAUTH, SECRET);
    expect(request.host).toBe("auth.stub.test");
    expect(request.path).toBe("/oauth/token?tenant=t1");
    // RFC 6749 2.3.1: each part is form-encoded before Basic.
    const basic = headerOf(request, "authorization");
    expect(basic).toBe(
      `Basic ${Buffer.from(
        `${encodeURIComponent(OAUTH.id)}:${encodeURIComponent(SECRET)}`,
      ).toString("base64")}`,
    );
    expect(headerOf(request, "content-type")).toStartWith(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(request.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      scope: "read write",
    });
    expect(request.body).not.toContain(SECRET);
    expect(request.body).not.toContain(encodeURIComponent(SECRET));
  });

  test("OAuth with the body: the id and secret are body fields, and no Authorization goes", () => {
    const request = buildExchangeRequest(
      { ...OAUTH, body: { kind: "oauth", clientAuth: "body" } },
      SECRET,
    );
    expect(headerOf(request, "authorization")).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: "client_credentials",
      client_id: OAUTH.id,
      client_secret: SECRET,
      scope: "read write",
    });
  });

  test("JSON: the id and secret under the named fields, with the params", () => {
    const request = buildExchangeRequest(
      { ...FEISHU, params: { tenant_key: "tk-1" } },
      SECRET,
    );
    expect(request.host).toBe("open.stub.test");
    expect(request.path).toBe(
      "/open-apis/auth/v3/tenant_access_token/internal",
    );
    expect(headerOf(request, "content-type")).toStartWith("application/json");
    expect(headerOf(request, "authorization")).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      app_id: FEISHU.id,
      app_secret: SECRET,
      tenant_key: "tk-1",
    });
  });
});

describe("parseExchangeReply", () => {
  const TOKEN = "t-FAKEtoken0001";
  const reply = (body: unknown, status = 200, spec = OAUTH) =>
    parseExchangeReply(
      spec,
      status,
      typeof body === "string" ? body : JSON.stringify(body),
    );

  test("the token and its lifetime from the named paths", () => {
    expect(reply({ access_token: TOKEN, expires_in: 3600 })).toEqual({
      ok: true,
      token: TOKEN,
      lifetimeMs: 3_600_000,
    });
    // Feishu answers 200 with its own field names.
    expect(
      reply(
        { code: 0, msg: "ok", tenant_access_token: TOKEN, expire: 7200 },
        200,
        FEISHU,
      ),
    ).toEqual({ ok: true, token: TOKEN, lifetimeMs: 7_200_000 });
    // A dotted path, and a lifetime sent as a numeric string.
    expect(
      reply({ data: { token: TOKEN, ttl: "120" } }, 200, {
        ...OAUTH,
        tokenField: "data.token",
        expiryField: "data.ttl",
      }),
    ).toEqual({ ok: true, token: TOKEN, lifetimeMs: 120_000 });
  });

  test("keeps a short lifetime as sent, cuts a long one, and gives a missing one the default", () => {
    // A token is never used past the lifetime its service gave.
    expect(reply({ access_token: TOKEN, expires_in: 30 })).toMatchObject({
      lifetimeMs: 30_000,
    });
    expect(
      reply({ access_token: TOKEN, expires_in: 10 * 24 * 3600 }),
    ).toMatchObject({ lifetimeMs: EXCHANGE_MAX_LIFETIME_MS });
    expect(reply({ access_token: TOKEN })).toMatchObject({
      lifetimeMs: EXCHANGE_DEFAULT_LIFETIME_MS,
    });
  });

  test("a lifetime of zero or less is no token", () => {
    for (const expires_in of [0, -5, "0"])
      expect([expires_in, reply({ access_token: TOKEN, expires_in })]).toEqual([
        expires_in,
        { ok: false, reason: "no_token" },
      ]);
  });

  test("a token that could break the header, or that the scrub would skip, is no token", () => {
    const bad = [
      "short07",
      "has space-0001",
      "crlf\r\nX-Evil: 1",
      "tab\there-0001",
      "non-ascii-ä-0001",
      "x".repeat(8193),
      12345678901,
      null,
      { nested: TOKEN },
    ];
    for (const token of bad)
      expect([
        String(token).slice(0, 20),
        reply({ access_token: token, expires_in: 60 }),
      ]).toEqual([
        String(token).slice(0, 20),
        { ok: false, reason: "no_token" },
      ]);
    // The bounds themselves pass: 8 and 8192 visible ASCII characters.
    for (const token of ["a!~/+=_8", "x".repeat(8192)])
      expect(reply({ access_token: token, expires_in: 60 }).ok).toBe(true);
  });

  test("a status that is not 2xx is that status, and a 3xx is a redirect", () => {
    const body = { access_token: TOKEN, expires_in: 60 };
    for (const status of [301, 302, 303, 307, 308])
      expect([status, reply(body, status)]).toEqual([
        status,
        { ok: false, reason: "redirect" },
      ]);
    for (const status of [400, 401, 403, 429, 500, 503])
      expect([status, reply(body, status)]).toEqual([
        status,
        { ok: false, reason: status },
      ]);
  });

  test("a 200 without a token is no token: Feishu's error code, HTML, an empty body", () => {
    for (const body of [
      { code: 10003, msg: `invalid app_secret ${SECRET}` },
      `<html>${SECRET}</html>`,
      "",
      "[]",
    ])
      expect(reply(body, 200, FEISHU)).toEqual({
        ok: false,
        reason: "no_token",
      });
  });
});

describe("refreshMarginMs", () => {
  test("a tenth of the lifetime, at least a minute, and never more than half", () => {
    expect(refreshMarginMs(7_200_000)).toBe(720_000);
    expect(refreshMarginMs(300_000)).toBe(60_000);
    // A 60 s token is fetched again at half its life, not on every request.
    expect(refreshMarginMs(60_000)).toBe(30_000);
    expect(refreshMarginMs(10_000)).toBe(5_000);
  });
});

describe("exchangeFailureText", () => {
  test("names the secret and the status, and differs by reason", () => {
    const texts = (
      [401, 502, "unreachable", "timeout", "redirect", "no_token"] as const
    ).map((reason) => exchangeFailureText("FEISHU_APP", reason));
    for (const text of texts) expect(text).toContain("FEISHU_APP");
    expect(texts[0]).toContain("401");
    expect(new Set(texts).size).toBe(texts.length);
  });
});

// --- the cache ---

const secret = (patch: Partial<ProxySecret> = {}): ProxySecret => ({
  scope: "user:alice",
  ownerId: "alice",
  name: "FEISHU_APP",
  value: SECRET,
  hosts: ["open.stub.test"],
  form: { kind: "authorization" },
  exchange: FEISHU,
  placeholder: "fake-placeholder-0001",
  ...patch,
});

function harness() {
  const clock = { now: 1_000_000 };
  const sent: ExchangeRequest[] = [];
  const exchanges: [string, ExchangeRequest][] = [];
  let issued = 0;
  // What the next sends answer; a string throws that failure reason.
  const answers: (
    { status: number; body: string } | "unreachable" | "timeout"
  )[] = [];
  let gate: Promise<void> | null = null;
  const cache = createTokenCache({
    now: () => clock.now,
    send: async (request) => {
      sent.push(request);
      if (gate) await gate;
      const next = answers.shift();
      if (typeof next === "string") throw next;
      if (next) return next;
      issued++;
      return {
        status: 200,
        body: JSON.stringify({
          tenant_access_token: `t-FAKEtoken${String(issued).padStart(4, "0")}`,
          expire: 7200,
        }),
      };
    },
    onExchange: (s, request) => exchanges.push([s.name, request]),
  });
  return {
    cache,
    clock,
    sent,
    exchanges,
    answers,
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const tokenOf = (reply: ExchangeReply) => (reply.ok ? reply.token : null);
const LIFETIME = 7_200_000;
const freshUntil = () => LIFETIME - refreshMarginMs(LIFETIME);

describe("the token cache", () => {
  test("fetches once, and serves the token until the refresh margin", async () => {
    const h = harness();
    const first = await h.cache.token(secret());
    expect(tokenOf(first)).toBe("t-FAKEtoken0001");
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body)).toEqual({
      app_id: FEISHU.id,
      app_secret: SECRET,
    });
    expect(h.exchanges.map(([name]) => name)).toEqual(["FEISHU_APP"]);

    h.clock.now += freshUntil() - 1;
    expect(tokenOf(await h.cache.token(secret()))).toBe("t-FAKEtoken0001");
    expect(h.sent).toHaveLength(1);

    h.clock.now += 2;
    expect(tokenOf(await h.cache.token(secret()))).toBe("t-FAKEtoken0002");
    expect(h.sent).toHaveLength(2);
    expect(h.exchanges).toHaveLength(2);
  });

  test("from cold, concurrent callers share one fetch", async () => {
    const h = harness();
    const release = h.hold();
    const pending = Array.from({ length: 5 }, () => h.cache.token(secret()));
    // Let every caller reach the cache before the reply comes.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const replies = await Promise.all(pending);
    expect(replies.map(tokenOf)).toEqual(Array(5).fill("t-FAKEtoken0001"));
    expect(h.sent).toHaveLength(1);
  });

  test("a rotated value, an edited exchange or another secret is another token", async () => {
    const h = harness();
    await h.cache.token(secret());
    await h.cache.token(secret({ value: "fake-app-secret-rotated-0002" }));
    expect(JSON.parse(h.sent[1].body).app_secret).toBe(
      "fake-app-secret-rotated-0002",
    );
    await h.cache.token(
      secret({ exchange: { ...FEISHU, id: "cli_fake0002" } }),
    );
    await h.cache.token(secret({ name: "OTHER_APP" }));
    await h.cache.token(secret({ scope: "office", ownerId: null }));
    expect(h.sent).toHaveLength(5);
    // And each is cached in turn.
    await h.cache.token(secret({ name: "OTHER_APP" }));
    expect(h.sent).toHaveLength(5);
  });

  test("a failure is answered from the cache for the backoff, then fetched again", async () => {
    const h = harness();
    h.answers.push({ status: 401, body: `{"error":"${SECRET}"}` });
    expect(await h.cache.token(secret())).toEqual({ ok: false, reason: 401 });
    h.clock.now += EXCHANGE_BACKOFF_MS - 1;
    expect(await h.cache.token(secret())).toEqual({ ok: false, reason: 401 });
    expect(h.sent).toHaveLength(1);
    h.clock.now += 2;
    expect(tokenOf(await h.cache.token(secret()))).toBe("t-FAKEtoken0001");
    expect(h.sent).toHaveLength(2);
  });

  test("a thrown send is its failure reason, kept for the backoff too", async () => {
    for (const reason of ["unreachable", "timeout"] as const) {
      const h = harness();
      h.answers.push(reason);
      expect(await h.cache.token(secret())).toEqual({ ok: false, reason });
      expect(await h.cache.token(secret())).toEqual({ ok: false, reason });
      expect(h.sent).toHaveLength(1);
    }
  });

  test("a 401 drops the token only once it is a minute old, and only the token that was sent", async () => {
    const h = harness();
    const token = tokenOf(await h.cache.token(secret()))!;
    h.clock.now += EXCHANGE_401_MIN_AGE_MS - 1;
    h.cache.unauthorized(secret(), token);
    expect(tokenOf(await h.cache.token(secret()))).toBe(token);
    expect(h.sent).toHaveLength(1);

    h.clock.now += 2;
    // A 401 for a token the cache no longer holds changes nothing.
    h.cache.unauthorized(secret(), "t-FAKEtokenOLD0");
    expect(tokenOf(await h.cache.token(secret()))).toBe(token);
    expect(h.sent).toHaveLength(1);

    h.cache.unauthorized(secret(), token);
    expect(tokenOf(await h.cache.token(secret()))).toBe("t-FAKEtoken0002");
    expect(h.sent).toHaveLength(2);
  });

  test("the scrub keeps a replaced or dropped token until the end of its lifetime", async () => {
    // A request that carried the old token can still be in flight when a
    // refresh or a 401 replaces it, and the service still takes the old
    // token until it expires: its echo must stay scrubbed.
    const h = harness();
    await h.cache.token(secret());
    h.clock.now += freshUntil() + 1;
    await h.cache.token(secret());
    expect([...h.cache.liveTokens()].sort()).toEqual([
      "t-FAKEtoken0001",
      "t-FAKEtoken0002",
    ]);
    h.clock.now += EXCHANGE_401_MIN_AGE_MS;
    h.cache.unauthorized(secret(), "t-FAKEtoken0002");
    await h.cache.token(secret());
    expect([...h.cache.liveTokens()].sort()).toEqual([
      "t-FAKEtoken0001",
      "t-FAKEtoken0002",
      "t-FAKEtoken0003",
    ]);
    // Past the first token's lifetime (two hours from its fetch), it goes.
    h.clock.now += LIFETIME;
    await h.cache.token(secret({ name: "OTHER_APP" }));
    expect(h.cache.liveTokens()).not.toContain("t-FAKEtoken0001");
  });

  test("lists every live token for the scrub, and moves the version when one comes", async () => {
    const h = harness();
    const before = h.cache.version();
    expect(h.cache.liveTokens()).toEqual([]);
    await h.cache.token(secret());
    await h.cache.token(secret({ name: "OTHER_APP" }));
    expect(h.cache.version()).not.toBe(before);
    expect([...h.cache.liveTokens()].sort()).toEqual([
      "t-FAKEtoken0001",
      "t-FAKEtoken0002",
    ]);
    const after = h.cache.version();
    // A cache hit changes nothing.
    await h.cache.token(secret());
    expect(h.cache.version()).toBe(after);
  });
});
