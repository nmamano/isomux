// The enterprise account routes through the web tier, as the deployed web role
// (WEB_GRANTS, least privilege): set up, sign, change N, make a new secret,
// rename and remove an office. Each route checks the origin, then the session,
// then hands the body to the domain; a refusal keeps its reason, 400 for a bad
// field and 409 for the rest. The account pages send no referrer, are not
// cached and are not indexed.
//
// The seat API (POST /api/enterprise/v1/seats, S2) is called by an office,
// server to server: the secret is its only credential, with no session and no
// origin check, and each refusal has its own status and {error} body.
//
// The rules themselves are in enterprise.test.ts. The limiter in front of
// these routes is in web/app/api/rate-limited-routes.test.ts.
//
// Outside a Next request `auth()` and `next/headers` throw: the session and
// the language are stand-ins; the origin check, the services and the database
// are real.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  createEnterprise,
  enterpriseFor,
  enterpriseSecret,
  signAgreement,
} from "./enterprise.ts";
import { WEB_GRANTS } from "./roles.ts";
import { accountForDevSignIn } from "./signup.ts";
import { Store } from "./store.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";
import {
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";

const webRequire = createRequire(
  path.join(import.meta.dir, "web", "package.json"),
);
const { getPathMatch } = webRequire(
  "next/dist/shared/lib/router/utils/path-match",
) as {
  getPathMatch: (source: string) => (pathname: string) => object | false;
};

// Loaded at run time: the repository-wide type check excludes the web package.
const WEB = path.join(import.meta.dir, "web");
const AUTH_MODULE = path.join(WEB, "auth.ts");
const LANGUAGE_MODULE = path.join(WEB, "lib/i18n/request.server.ts");

let session: { accountId: string; expires: string } | null = null;

// A module mock outlives this file in Bun's shared test process and patches
// the bindings other files already imported, so the real exports are copied
// out first and put back when this file is done.
const realAuth = { ...(await import(AUTH_MODULE)) };
const realLanguage = { ...(await import(LANGUAGE_MODULE)) };
await mock.module(AUTH_MODULE, () => ({
  ...realAuth,
  auth: async () => session,
}));
await mock.module(LANGUAGE_MODULE, () => ({
  ...realLanguage,
  languageForRequest: async () => "en",
}));

type Post = { POST: (request: Request) => Promise<Response> };
const route = async (rel: string) =>
  (await import(path.join(WEB, "app/api/enterprise", rel, "route.ts"))) as Post;
const ROUTES = {
  create: await route("."),
  agreement: await route("agreement"),
  seats: await route("seats"),
  secret: await route("secret"),
  "offices/rename": await route("offices/rename"),
  "offices/remove": await route("offices/remove"),
  "billing/portal": await route("billing/portal"),
};
const SEAT_API = await route("v1/seats");
const nextConfig = (
  (await import(path.join(WEB, "next.config.ts"))) as {
    default: {
      headers?: () => Promise<
        { source: string; headers: { key: string; value: string }[] }[]
      >;
    };
  }
).default;

const SECRET = "web-enterprise-secret-0123456789abcdef";
const ORIGIN = "https://storefront.example.com";

/** The same symbol the facade caches its store on (web-store-lifetime.test.ts). */
const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");

const ENV_KEYS = [
  "AUTH_SECRET",
  "AUTH_URL",
  "CONTROL_PLANE_DB",
  "CONTROL_PLANE_STRIPE_MODE",
  "STRIPE_TEST_SECRET_KEY",
];
let savedEnv: Record<string, string | undefined> = {};

async function resetSlot(): Promise<void> {
  const held = ((globalThis as { [STORE_SLOT]?: { opening?: Promise<Store> } })[
    STORE_SLOT
  ] ??= {});
  const opening = held.opening;
  delete held.opening;
  if (opening) await (await opening).close().catch(() => {});
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  await resetSlot();
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_URL = ORIGIN;
  session = null;
});

afterEach(async () => {
  await resetSlot();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mock.module(AUTH_MODULE, () => realAuth);
  await mock.module(LANGUAGE_MODULE, () => realLanguage);
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Seeded {
  owner: Store;
  it: string;
}

/** A bootstrapped schema with IT's storefront sign-in; the facade runs on it
 * as the web role. */
async function seed(): Promise<Seeded> {
  const dsn = await testDsn();
  await (await Store.open(dsn)).close();
  const owner = await openTestStoreOn(dsn);
  const it = (await accountForDevSignIn(owner, "it@acme.example")).id;
  process.env.CONTROL_PLANE_DB = await leastPrivilegedDsn({
    dsn,
    grants: WEB_GRANTS,
  });
  return { owner, it };
}

let addresses = 0;
/** Each request from its own address, so no test spends another's quota. */
function address(): string {
  addresses += 1;
  return `198.51.100.${addresses}`;
}

function post(
  name: keyof typeof ROUTES,
  body: unknown,
  origin = ORIGIN,
): Promise<Response> {
  const pathname = name === "create" ? "" : `/${name}`;
  return ROUTES[name].POST(
    new Request(`${ORIGIN}/api/enterprise${pathname}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": address(),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function answer(
  response: Promise<Response>,
): Promise<{ status: number; body: unknown }> {
  const r = await response;
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A plain-text refusal (origin, session) stays text.
  }
  return { status: r.status, body };
}

const SETUP = {
  company: "Acme Inc.",
  billingEmail: "billing@acme.example",
  plan: "monthly",
  seats: 50,
};
const SIGN = { name: "Ada Admin", title: "IT Director", authority: true };

describe("the account routes as the web role", () => {
  test("set up, sign, change N and make a new secret, end to end", async () => {
    const s = await seed();
    session = { accountId: s.it, expires: "2999-01-01T00:00:00.000Z" };
    const made = await answer(
      post("create", { ...SETUP, billingEmail: "  Billing@Acme.Example " }),
    );
    expect(made).toEqual({
      status: 200,
      body: { ok: true, id: expect.any(String) },
    });
    const id = (made.body as { id: string }).id;
    expect(await answer(post("agreement", SIGN))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await answer(post("seats", { from: 50, to: 60 }))).toEqual({
      status: 200,
      body: { ok: true, seats: 60 },
    });
    expect(await answer(post("secret", {}))).toEqual({
      status: 200,
      body: { ok: true, secret: enterpriseSecret(SECRET, id, 2) },
    });
    const view = await enterpriseFor(s.owner, s.it, SECRET);
    expect(view).toMatchObject({
      id,
      billingEmail: "billing@acme.example",
      seats: 60,
      secret: enterpriseSecret(SECRET, id, 2),
    });
    expect(view?.signature?.name).toBe("Ada Admin");
  });

  test("a refusal keeps its reason: a bad field 400, every other refusal 409", async () => {
    const s = await seed();
    session = { accountId: s.it, expires: "2999-01-01T00:00:00.000Z" };
    // Nothing set up yet.
    expect(await answer(post("seats", { from: 50, to: 60 }))).toEqual({
      status: 409,
      body: { ok: false, reason: "no_account" },
    });
    expect(await answer(post("create", { ...SETUP, seats: "50" }))).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid", field: "seats" },
    });
    expect(
      await answer(post("create", { ...SETUP, billingEmail: "not an email" })),
    ).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid", field: "billingEmail" },
    });
    expect((await post("create", "{not json")).status).toBe(400);
    expect(await enterpriseFor(s.owner, s.it, SECRET)).toBeNull();

    expect((await post("create", SETUP)).status).toBe(200);
    expect(await answer(post("create", SETUP))).toEqual({
      status: 409,
      body: { ok: false, reason: "exists" },
    });
    expect(await answer(post("secret", {}))).toEqual({
      status: 409,
      body: { ok: false, reason: "not_signed" },
    });
    expect(
      await answer(post("agreement", { ...SIGN, authority: "yes" })),
    ).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid", field: "authority" },
    });
    expect((await post("agreement", SIGN)).status).toBe(200);
    expect(await answer(post("seats", { from: 40, to: 60 }))).toEqual({
      status: 409,
      body: { ok: false, reason: "stale", seats: 50, inUse: 0 },
    });
    expect(await answer(post("seats", { from: 50, to: "60" }))).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid" },
    });
    expect((await enterpriseFor(s.owner, s.it, SECRET))?.seats).toBe(50);
  });

  test("signed out is 401 and an off-site post is 403, on every route, and nothing is written", async () => {
    const s = await seed();
    for (const name of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
      session = null;
      expect({ name, status: (await post(name, SETUP)).status }).toEqual({
        name,
        status: 401,
      });
      session = { accountId: s.it, expires: "2999-01-01T00:00:00.000Z" };
      expect({
        name,
        status: (await post(name, SETUP, "https://elsewhere.example")).status,
      }).toEqual({ name, status: 403 });
    }
    expect(await enterpriseFor(s.owner, s.it, SECRET)).toBeNull();
    // The control: the same session, from the site, is let in.
    expect((await post("create", SETUP)).status).toBe(200);
  });
});

const A = "a".repeat(32);
const B = "b".repeat(32);
const SESSION_END = "2999-01-01T00:00:00.000Z";

/** A signed standard account of `seats`, set up by IT; its current secret. */
async function signedAccount(
  s: Seeded,
  seats = 50,
): Promise<{ id: string; secret: string }> {
  const made = await createEnterprise(s.owner, s.it, {
    company: "Acme Inc.",
    billingEmail: "billing@acme.example",
    plan: "monthly",
    seats,
  });
  if (!made.ok) throw new Error(`create refused: ${JSON.stringify(made)}`);
  expect(await signAgreement(s.owner, s.it, SIGN)).toEqual({ ok: true });
  return { id: made.id, secret: enterpriseSecret(SECRET, made.id, 1) };
}

/** An office's call: no cookie and, unless given, no Origin. */
function seatCall(
  authorization: string | null,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": address(),
    ...extra,
  };
  if (authorization !== null) headers.authorization = authorization;
  return SEAT_API.POST(
    new Request(`${ORIGIN}/api/enterprise/v1/seats`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** Status, body and whether the answer may be cached. */
async function seatAnswer(response: Promise<Response>) {
  const r = await response;
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: kept as text, so a failure shows what came back.
  }
  return {
    status: r.status,
    noStore: (r.headers.get("cache-control") ?? "").includes("no-store"),
    body,
  };
}

describe("the seat API as the web role", () => {
  test("an office joins, checks in and raises the seats with the secret alone; IT renames and removes it", async () => {
    const s = await seed();
    const { id, secret } = await signedAccount(s);
    // No session at all: the secret is the only credential.
    session = null;
    expect(
      await seatAnswer(
        seatCall(`Bearer ${secret}`, { office: A, members: 10, add: true }),
      ),
    ).toEqual({
      status: 200,
      noStore: true,
      body: {
        company: "Acme Inc.",
        kind: "standard",
        seats: 50,
        inUse: 10,
        offices: 1,
      },
    });
    // Server to server: an Origin, even another site's, changes nothing.
    expect(
      await seatAnswer(
        seatCall(
          `Bearer ${secret}`,
          { office: B, members: 45, add: false },
          { origin: "https://elsewhere.example" },
        ),
      ),
    ).toEqual({
      status: 200,
      noStore: true,
      body: {
        company: "Acme Inc.",
        kind: "standard",
        seats: 55,
        inUse: 55,
        offices: 2,
      },
    });
    expect((await enterpriseFor(s.owner, s.it, SECRET))?.seats).toBe(55);

    session = { accountId: s.it, expires: SESSION_END };
    expect(
      await answer(post("offices/rename", { office: A, name: "Berlin" })),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(
      await answer(post("offices/rename", { office: A, name: "  " })),
    ).toEqual({ status: 400, body: { ok: false, reason: "invalid" } });
    expect(
      await answer(post("offices/remove", { office: "c".repeat(32) })),
    ).toEqual({ status: 409, body: { ok: false, reason: "not_found" } });
    expect(await answer(post("offices/remove", { office: B }))).toEqual({
      status: 200,
      body: { ok: true },
    });
    const view = await enterpriseFor(s.owner, s.it, SECRET);
    expect(view?.offices.map((o) => [o.id, o.name, o.members])).toEqual([
      [A, "Berlin", 10],
    ]);
    expect(view?.inUse).toBe(10);
    expect(view?.id).toBe(id);
  });

  test("each refusal has its status and {error} body, is not cached, and the secret is checked before the body", async () => {
    const s = await seed();
    const { id, secret } = await signedAccount(s);
    const good = { office: A, members: 1, add: true };
    const forged = `isx_ent_${id}_forged`;
    const cases: [string, string | null, unknown, number, unknown][] = [
      ["no Authorization", null, good, 401, { error: "bad_secret" }],
      ["not a Bearer", `Basic ${secret}`, good, 401, { error: "bad_secret" }],
      [
        "a forged secret",
        `Bearer ${forged}`,
        good,
        401,
        { error: "bad_secret" },
      ],
      // A stranger learns nothing about the body rules.
      [
        "forged, broken JSON",
        `Bearer ${forged}`,
        "{not json",
        401,
        { error: "bad_secret" },
      ],
      [
        "forged, bad body",
        `Bearer ${forged}`,
        { office: "x" },
        401,
        { error: "bad_secret" },
      ],
      [
        "broken JSON",
        `Bearer ${secret}`,
        "{not json",
        400,
        { error: "bad_request" },
      ],
      [
        "bad body",
        `Bearer ${secret}`,
        { office: "x" },
        400,
        { error: "bad_request" },
      ],
      [
        "past the seats",
        `Bearer ${secret}`,
        { office: A, members: 51, add: true },
        409,
        { error: "seats_full", seats: 50, inUse: 0 },
      ],
    ];
    for (const [name, authorization, body, status, expected] of cases) {
      expect({
        name,
        ...(await seatAnswer(seatCall(authorization, body))),
      }).toEqual({ name, status, noStore: true, body: expected });
    }
    // A standard account not signed yet, under another sign-in.
    const other = (await accountForDevSignIn(s.owner, "it@globex.example")).id;
    const unsigned = await createEnterprise(s.owner, other, {
      company: "Globex",
      billingEmail: "billing@globex.example",
      plan: "monthly",
      seats: 10,
    });
    if (!unsigned.ok) throw new Error("create refused");
    expect(
      await seatAnswer(
        seatCall(`Bearer ${enterpriseSecret(SECRET, unsigned.id, 1)}`, good),
      ),
    ).toEqual({ status: 403, noStore: true, body: { error: "not_signed" } });
    expect((await enterpriseFor(s.owner, s.it, SECRET))?.offices).toEqual([]);
  });

  test("per secret: past its quota one bearer is 429 before its body is read; another bearer of the same account is not", async () => {
    const s = await seed();
    const { secret, id } = await signedAccount(s);
    // Too long to parse, so no call reaches the database; it names Acme's id.
    const spent = `Bearer isx_ent_${id}_${"x".repeat(200)}`;
    let refused: Response | null = null;
    let calls = 0;
    for (; calls < 700 && !refused; calls++) {
      const response = await SEAT_API.POST(
        new Request(`${ORIGIN}/api/enterprise/v1/seats`, {
          method: "POST",
          headers: { authorization: spent, "x-forwarded-for": address() },
          body: unreadableBody(),
        }),
      ).catch(() => null);
      if (response?.status === 429) refused = response;
    }
    // Each call came from its own address: the per-secret quota refused it.
    expect({ status: refused?.status, calls }).toEqual({
      status: 429,
      calls: 601,
    });
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused?.json()).toEqual({ error: "rate_limited" });
    // The account's own secret still works: the quota is not the account's.
    expect(
      (
        await seatAnswer(
          seatCall(`Bearer ${secret}`, { office: A, members: 1, add: true }),
        )
      ).status,
    ).toBe(200);
  });
});

/** A body that fails the request if anything reads it. */
function unreadableBody(): ReadableStream {
  return new ReadableStream({
    pull() {
      throw new Error("the body was read");
    },
  });
}

describe("the billing portal route as the web role", () => {
  test("a signed account's IT gets a Stripe portal session that comes back to the account page", async () => {
    const s = await seed();
    const { id } = await signedAccount(s);
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_web_enterprise";
    // Stripe, as far as this route goes: one customer, a default and our
    // configuration, a session.
    const stripeCalls: {
      method: string;
      path: string;
      params: URLSearchParams;
    }[] = [];
    let configsMade = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.hostname !== "api.stripe.com") return realFetch(input, init);
      const method = init?.method ?? "GET";
      const params =
        method === "GET"
          ? url.searchParams
          : new URLSearchParams(
              typeof init?.body === "string" ? init.body : "",
            );
      stripeCalls.push({ method, path: url.pathname, params });
      if (method === "POST" && url.pathname === "/v1/customers")
        return Response.json({ id: "cus_web", object: "customer" });
      if (
        method === "GET" &&
        url.pathname === "/v1/billing_portal/configurations"
      )
        return Response.json({ object: "list", has_more: false, data: [] });
      // Stripe makes an account's first configuration its default: the base
      // the code makes first, then ours.
      if (
        method === "POST" &&
        url.pathname === "/v1/billing_portal/configurations"
      ) {
        configsMade += 1;
        return Response.json({
          id: configsMade === 1 ? "bpc_base" : "bpc_web",
          object: "billing_portal.configuration",
          is_default: configsMade === 1,
        });
      }
      if (method === "POST" && url.pathname === "/v1/billing_portal/sessions")
        return Response.json({
          id: "bps_web",
          url: "https://billing.stripe.example/s/web",
        });
      return Response.json(
        { error: { message: "unexpected" } },
        { status: 404 },
      );
    }) as typeof fetch;
    try {
      session = { accountId: s.it, expires: SESSION_END };
      expect(await answer(post("billing/portal", {}))).toEqual({
        status: 200,
        body: { ok: true, url: "https://billing.stripe.example/s/web" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const sessionCall = stripeCalls.find(
      (c) => c.path === "/v1/billing_portal/sessions",
    );
    expect({
      customer: sessionCall?.params.get("customer"),
      returnUrl: sessionCall?.params.get("return_url"),
      configuration: sessionCall?.params.get("configuration"),
    }).toEqual({
      customer: "cus_web",
      returnUrl: `${ORIGIN}/enterprise`,
      configuration: "bpc_web",
    });
    // The web role stored the customer it made.
    const row = await s.owner.sqlGet<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from enterprise_accounts where id = $1",
      [id],
    );
    expect(row?.stripe_customer_id).toBe("cus_web");
  });
});

describe("the account pages", () => {
  test("are not indexed, send no referrer and are not cached", async () => {
    const entries = (await nextConfig.headers?.()) ?? [];
    for (const page of ["/enterprise", "/enterprise/agreement"]) {
      // Next applies every matching entry in order; a later key wins.
      const effective = new Map<string, string>();
      for (const entry of entries) {
        if (getPathMatch(entry.source)(page) === false) continue;
        for (const h of entry.headers)
          effective.set(h.key.toLowerCase(), h.value);
      }
      expect({
        page,
        robots: effective.get("x-robots-tag"),
        referrer: effective.get("referrer-policy"),
        cache: effective.get("cache-control"),
      }).toEqual({
        page,
        robots: expect.stringContaining("noindex"),
        referrer: "no-referrer",
        cache: expect.stringContaining("no-store"),
      });
    }
  });
});
