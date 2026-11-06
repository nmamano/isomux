// The enterprise account routes through the web tier, as the deployed web role
// (WEB_GRANTS, least privilege): set up, sign, change N, make a new secret.
// Each route checks the origin, then the session, then hands the body to the
// domain; a refusal keeps its reason, 400 for a bad field and 409 for the rest.
// The account pages send no referrer, are not cached and are not indexed.
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
import { enterpriseFor, enterpriseSecret } from "./enterprise.ts";
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
};
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

const ENV_KEYS = ["AUTH_SECRET", "AUTH_URL", "CONTROL_PLANE_DB"];
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
