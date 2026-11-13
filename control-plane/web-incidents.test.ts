// The critical-issue status pages through the web tier, as the deployed web
// role (WEB_GRANTS, least privilege): the write-key API the support agent and
// the office reminder use (POST an update, GET ?due=1), the customer's issue
// page, the update's mail, and the grant that keeps updates append-only. Also
// the web role's read of the operator flag, which the top bar's /ops link uses.
//
// The rules themselves (numbering, due, late, links) are in incidents.test.ts.
// The limiter's place in front of these routes is in
// web/app/api/rate-limited-routes.test.ts.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import pg from "pg";
import {
  openIncident,
  postUpdateAsOperator,
  rotateIncidentKey,
  statusToken,
  type IncidentUpdateInput,
  type OpenIncidentInput,
  type PostedUpdate,
} from "./incidents.ts";
import { setOperator } from "./operator-admin.ts";
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
import {
  accountIsOperator,
  statusIncident,
} from "./web/lib/services.server.ts";

// The app's own React and Next, which the root does not install: a page
// element is rendered by the React that made it.
const webRequire = createRequire(
  path.join(import.meta.dir, "web", "package.json"),
);
const { renderToStaticMarkup } = webRequire(
  "react-dom/server",
) as typeof import("react-dom/server");
const { getPathMatch } = webRequire(
  "next/dist/shared/lib/router/utils/path-match",
) as {
  getPathMatch: (source: string) => (pathname: string) => object | false;
};

// The app's routes, pages and config, loaded at run time: the repository-wide
// type check excludes the web package (tsconfig.json), and a static import
// would pull Next's types into it.
const WEB = path.join(import.meta.dir, "web");
type Page<P> = (props: { params: Promise<P> }) => Promise<unknown>;
const incidentsRoute = (await import(
  path.join(WEB, "app/api/ops/incidents/route.ts")
)) as { GET: (request: Request) => Promise<Response> };
const updatesRoute = (await import(
  path.join(WEB, "app/api/ops/incidents/[id]/updates/route.ts")
)) as {
  POST: (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
};
const StatusIncidentPage = (
  (await import(path.join(WEB, "app/status/[token]/[n]/page.tsx"))) as {
    default: Page<{ token: string; n: string }>;
  }
).default;
const StatusListPage = (
  (await import(path.join(WEB, "app/status/[token]/page.tsx"))) as {
    default: Page<{ token: string }>;
  }
).default;
const nextConfig = (
  (await import(path.join(WEB, "next.config.ts"))) as {
    default: {
      headers?: () => Promise<
        { source: string; headers: { key: string; value: string }[] }[]
      >;
    };
  }
).default;

const SECRET = "web-incidents-secret-0123456789abcdef";
const ORIGIN = "https://storefront.example.com";
const MIN = 60_000;

/** The same symbol the facade caches its store on (web-store-lifetime.test.ts). */
const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");

const ENV_KEYS = [
  "AUTH_SECRET",
  "AUTH_URL",
  "AUTH_RESEND_KEY",
  "CONTROL_PLANE_DB",
];
let savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

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
  delete process.env.AUTH_RESEND_KEY;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetSlot();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

/** The seeding store's clock, in the past of the facade's real one. */
let clock = Date.now();

interface Seeded {
  owner: Store;
  operator: string;
  key: string;
  acme: PostedUpdate;
  token: string;
}

function update(over: Partial<IncidentUpdateInput> = {}): IncidentUpdateInput {
  return {
    found: "The sync worker crashes on start",
    doingNow: "Rolling back the last release",
    estimateAt: Date.now() + 90 * MIN,
    ...over,
  };
}

function opening(over: Partial<OpenIncidentInput> = {}): OpenIncidentInput {
  return {
    customerLabel: "Acme",
    contacts: ["ops@acme.example"],
    kind: "critical",
    timeZone: "America/Los_Angeles",
    title: "Office down",
    first: update(),
    ...over,
  };
}

async function openAs(
  owner: Store,
  operator: string,
  over: Partial<OpenIncidentInput> = {},
): Promise<PostedUpdate> {
  const result = await openIncident(owner, operator, opening(over));
  if (!result?.ok) throw new Error(`open refused: ${JSON.stringify(result)}`);
  return result.posted;
}

/** A bootstrapped schema with an operator, the write key, and Acme's issue 1
 * opened 45 minutes ago; the facade runs on it as the web role. */
async function seed(): Promise<Seeded> {
  const dsn = await testDsn();
  await (await Store.open(dsn)).close();
  clock = Date.now() - 45 * MIN;
  const owner = await openTestStoreOn(dsn, () => clock);
  const operator = (await accountForDevSignIn(owner, "eng@example.test")).id;
  const granted = await setOperator(owner, {
    email: "eng@example.test",
    on: true,
    actor: "cli:test",
  });
  expect(granted.ok).toBe(true);
  const key = (await rotateIncidentKey(owner, operator))?.key ?? "";
  const acme = await openAs(owner, operator);
  process.env.CONTROL_PLANE_DB = await leastPrivilegedDsn({
    dsn,
    grants: WEB_GRANTS,
  });
  return {
    owner,
    operator,
    key,
    acme,
    token: statusToken(SECRET, acme.customerId, acme.linkGeneration),
  };
}

let addresses = 0;
/** Each request from its own address, so no test spends another's quota. */
function address(): string {
  addresses += 1;
  return `198.51.100.${addresses}`;
}

function postUpdate(
  id: string,
  body: unknown,
  authorization: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": address(),
  };
  if (authorization !== null) headers.authorization = authorization;
  return updatesRoute.POST(
    new Request(`${ORIGIN}/api/ops/incidents/${id}/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function getIncidents(query: string, authorization: string): Promise<Response> {
  return incidentsRoute.GET(
    new Request(`${ORIGIN}/api/ops/incidents${query}`, {
      headers: { authorization, "x-forwarded-for": address() },
    }),
  );
}

/** A page's HTML, or "404" when it called notFound(). */
async function render(page: Promise<unknown>): Promise<string> {
  try {
    return renderToStaticMarkup(
      (await page) as Parameters<typeof renderToStaticMarkup>[0],
    );
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (
      typeof digest === "string" &&
      digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")
    )
      return "404";
    throw err;
  }
}

function issuePage(token: string, n: string): Promise<string> {
  return render(StatusIncidentPage({ params: Promise.resolve({ token, n }) }));
}

function listPage(token: string): Promise<string> {
  return render(StatusListPage({ params: Promise.resolve({ token }) }));
}

/** How many updates Acme's issue 1 has, as the web tier reads them. */
async function updatesShown(s: Seeded): Promise<number> {
  return (await statusIncident(s.token, 1))?.updates.length ?? -1;
}

describe("POST /api/ops/incidents/<id>/updates with the write key", () => {
  test("the update lands, signed as the support agent, and the answer reports the mail", async () => {
    const s = await seed();
    const response = await postUpdate(
      s.acme.incidentId,
      update({
        found: "The queue is draining",
        doingNow: "Restarting the worker",
      }),
      `Bearer ${s.key}`,
    );
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({
      ok: true,
      incidentId: s.acme.incidentId,
      mail: "not_configured",
    });
    const html = await issuePage(s.token, "1");
    expect(html).toContain("The queue is draining");
    expect(html).toContain("Restarting the worker");
  });

  test("a wrong, empty or non-bearer credential is 401 and writes nothing", async () => {
    const s = await seed();
    for (const authorization of [
      "Bearer wrong-key",
      "Bearer ",
      `Basic ${s.key}`,
      s.key,
    ]) {
      const response = await postUpdate(
        s.acme.incidentId,
        update({ doingNow: "Restarting the worker" }),
        authorization,
      );
      expect({ authorization, status: response.status }).toEqual({
        authorization,
        status: 401,
      });
    }
    expect(await updatesShown(s)).toBe(1);
  });

  test("a refusal keeps its reason: unknown issue 404, invalid 400, resolved 409", async () => {
    const s = await seed();
    const bearer = `Bearer ${s.key}`;
    expect((await postUpdate("no-such-issue", update(), bearer)).status).toBe(
      404,
    );
    expect(
      (
        await postUpdate(
          s.acme.incidentId,
          update({ estimateAt: Date.now() - MIN }),
          bearer,
        )
      ).status,
    ).toBe(400);
    expect(
      (await postUpdate(s.acme.incidentId, { found: "only this" }, bearer))
        .status,
    ).toBe(400);
    const final = await postUpdate(
      s.acme.incidentId,
      update({
        doingNow: "Restarting the worker",
        estimateAt: null,
        final: true,
      }),
      bearer,
    );
    expect(final.ok).toBe(true);
    expect((await postUpdate(s.acme.incidentId, update(), bearer)).status).toBe(
      409,
    );
    expect(await updatesShown(s)).toBe(2);
  });

  test("a mail that fails is reported; the update stays posted", async () => {
    const s = await seed();
    process.env.AUTH_RESEND_KEY = "re_test_key";
    const sent: { to: unknown; content: string }[] = [];
    let answer = 200;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.startsWith("https://api.resend.com/")) {
        return realFetch(input, init);
      }
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      sent.push({
        to: body.to,
        content: [body.text, body.html]
          .filter((part): part is string => typeof part === "string")
          .join("\n"),
      });
      return new Response("{}", { status: answer });
    }) as typeof fetch;

    const ok = await postUpdate(
      s.acme.incidentId,
      update({ doingNow: "Restarting the worker" }),
      `Bearer ${s.key}`,
    );
    expect(await ok.json()).toMatchObject({ ok: true, mail: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["ops@acme.example"]);
    expect(sent[0].content).toContain(`/status/${s.token}/1`);

    answer = 500;
    const failed = await postUpdate(
      s.acme.incidentId,
      update({ doingNow: "Restarting the worker" }),
      `Bearer ${s.key}`,
    );
    expect(failed.ok).toBe(true);
    expect(await failed.json()).toMatchObject({ ok: true, mail: "failed" });
    expect(await updatesShown(s)).toBe(3);
  });
});

describe("GET /api/ops/incidents with the write key", () => {
  test("?due=1 lists the issues 40 minutes past their last update; without it, every open issue", async () => {
    const s = await seed();
    clock = Date.now() - 10 * MIN;
    const fresh = await openAs(s.owner, s.operator, { title: "Mail stuck" });
    clock = Date.now() - 50 * MIN;
    const closed = await openAs(s.owner, s.operator, { customerLabel: "Beta" });
    const resolved = await postUpdateAsOperator(
      s.owner,
      s.operator,
      closed.incidentId,
      update({ estimateAt: null, final: true }),
    );
    expect(resolved?.ok).toBe(true);

    const due = await getIncidents("?due=1", `Bearer ${s.key}`);
    expect(due.status).toBe(200);
    const dueItems = (await due.json()) as {
      id: string;
      lastUpdateAt: number;
      dueAt: number;
    }[];
    expect(dueItems.map((i) => i.id)).toEqual([s.acme.incidentId]);
    expect(dueItems[0].dueAt - dueItems[0].lastUpdateAt).toBe(60 * MIN);

    const all = await getIncidents("", `Bearer ${s.key}`);
    const allIds = ((await all.json()) as { id: string }[])
      .map((i) => i.id)
      .sort();
    expect(allIds).toEqual([s.acme.incidentId, fresh.incidentId].sort());

    expect((await getIncidents("?due=1", "Bearer wrong-key")).status).toBe(401);
  });
});

describe("the customer's pages", () => {
  test("the issue page shows the estimate in the issue's time zone and in UTC, and nothing private", async () => {
    const s = await seed();
    // 21:47 UTC is 13:47 (1:47 PM) in Los Angeles in January.
    const estimateAt = Date.parse("2030-01-15T21:47:00Z");
    const posted = await postUpdateAsOperator(
      s.owner,
      s.operator,
      s.acme.incidentId,
      update({ estimateAt }),
    );
    expect(posted?.ok).toBe(true);
    const html = await issuePage(s.token, "1");
    expect(html).toContain("Office down");
    expect(html).toMatch(/\b(1|13):47\b/);
    expect(html).toMatch(/\b(21|9):47\b/);
    for (const secret of [
      "ops@acme.example",
      "eng@example.test",
      s.operator,
      s.acme.incidentId,
    ]) {
      expect({ secret, leaked: html.includes(secret) }).toEqual({
        secret,
        leaked: false,
      });
    }
  });

  test("a wrong link or number is the same 404, on both pages", async () => {
    const s = await seed();
    const beta = await openAs(s.owner, s.operator, {
      customerLabel: "Beta",
      title: "Beta's outage",
    });
    const betaToken = statusToken(SECRET, beta.customerId, beta.linkGeneration);
    await openAs(s.owner, s.operator, { title: "Mail stuck" });

    // The controls.
    expect(await issuePage(s.token, "2")).toContain("Mail stuck");
    const list = await listPage(s.token);
    expect(list).toContain("Office down");
    expect(list).toContain("Mail stuck");
    expect(list).not.toContain("Beta's outage");

    for (const [name, token, n] of [
      ["Beta's link, Acme's second issue", betaToken, "2"],
      ["unknown number", s.token, "3"],
      ["not a number", s.token, "abc"],
      ["a fraction", s.token, "1.5"],
      [
        "another secret",
        statusToken("other-secret-0123456789abcdef", s.acme.customerId, 1),
        "1",
      ],
      ["garbage", "x.y", "1"],
    ]) {
      expect({ name, page: await issuePage(token, n) }).toEqual({
        name,
        page: "404",
      });
    }
    expect(await listPage("x.y")).toBe("404");
  });

  test("the status paths are not indexed, send no referrer and are not cached", async () => {
    const entries = (await nextConfig.headers?.()) ?? [];
    for (const path of ["/status/abc.def", "/status/abc.def/1"]) {
      // Next applies every matching entry in order; a later key wins.
      const effective = new Map<string, string>();
      for (const entry of entries) {
        if (getPathMatch(entry.source)(path) === false) continue;
        for (const h of entry.headers)
          effective.set(h.key.toLowerCase(), h.value);
      }
      expect({ path, robots: effective.get("x-robots-tag") }).toEqual({
        path,
        robots: expect.stringContaining("noindex"),
      });
      expect({ path, referrer: effective.get("referrer-policy") }).toEqual({
        path,
        referrer: "no-referrer",
      });
      expect({ path, cache: effective.get("cache-control") }).toEqual({
        path,
        cache: expect.stringContaining("no-store"),
      });
    }
  });
});

describe("the web role", () => {
  // The top bar's link to /ops asks this (task 639b302f); the seed's operator
  // is the one account with the flag.
  test("reads which account is an operator through the facade", async () => {
    const s = await seed();
    const customer = (
      await accountForDevSignIn(s.owner, "customer@example.test")
    ).id;
    expect(await accountIsOperator(s.operator)).toBe(true);
    expect(await accountIsOperator(customer)).toBe(false);
  });

  test("cannot change or delete a posted update, or delete an issue", async () => {
    await seed();
    const client = new pg.Client({
      connectionString: process.env.CONTROL_PLANE_DB,
    });
    await client.connect();
    try {
      // The control: the same role reads them.
      const read = await client.query(
        "select count(*)::int as n from incident_updates",
      );
      expect(read.rows[0].n).toBe(1);
      for (const sql of [
        "update incident_updates set found = 'rewritten'",
        "delete from incident_updates",
        "delete from incidents",
        "update incidents set title = 'renamed'",
      ]) {
        const code = await client.query(sql).then(
          () => "ALLOWED",
          (err: { code?: string }) => err.code,
        );
        expect({ sql, code }).toEqual({ sql, code: "42501" });
      }
    } finally {
      await client.end();
    }
  });
});
