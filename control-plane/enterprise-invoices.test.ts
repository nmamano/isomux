// The enterprise invoices (task 71718489, S4): the pass that bills each due
// period of a signed standard account through Stripe, step by step, resumed
// from the ledger and from Stripe's own state after any failure; the periods
// it holds for an operator; the Stripe customer and the customer portal.
//
// Stripe is a fake behind the real StripeClient (fetchImpl): it keeps its own
// customers, invoices, lines and portal configurations, replays a write sent
// again with the same idempotency key, and can lose a write after applying it.
// "forgetKeys" stands for Stripe's 24-hour key lifetime.
//
// The calendar and the amounts are in enterprise-billing.test.ts.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import {
  changeSeats,
  createEnterprise,
  createNegotiatedEnterprise,
  signAgreement,
} from "./enterprise.ts";
import { addContractMonths, INVOICE_GRACE_MS } from "./enterprise-billing.ts";
import {
  enterprisePortalUrl,
  ensureEnterpriseCustomer,
  heldEnterpriseInvoices,
  hostedPortalUrl,
  invoiceEnterprises,
  recordManualInvoice,
  releaseHeldInvoice,
} from "./enterprise-invoices.ts";
import { opsFloor } from "./ops.ts";
import { setOperator } from "./operator-admin.ts";
import { PROVISIONER_GRANTS, WEB_GRANTS } from "./roles.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { Store, type WorkScheduleOptions } from "./store.ts";
import { StripeClient } from "./stripe/client.ts";
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

const roleStores: Store[] = [];
afterEach(async () => {
  for (const s of roleStores.splice(0)) await s.close().catch(() => {});
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);
afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The contract start: every account here signs at this moment. */
const START = Date.parse("2027-01-31T10:00:00Z");
const M = (k: number) => addContractMonths(START, k);
/** When contract month k's invoice may go out. */
const due = (k: number) => M(k) + INVOICE_GRACE_MS;

let clock = START;

// ------------------------------------------------------------------ fake Stripe

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
  key: string | null;
}

interface Line {
  id: string;
  amount: number;
  description: string;
}

interface Invoice {
  id: string;
  customer: string;
  status: "draft" | "open" | "void";
  metadata: Record<string, string>;
  params: Record<string, string>;
  lines: Line[];
  sent: number;
  finalized: number;
}

type FaultMode =
  /** Stripe applies it and the answer is lost (ambiguous, applied). */
  | "lost"
  /** Stripe refuses it and applies nothing: the same call fails again. */
  | "refused"
  /** A 4xx that applies nothing and passes: another request holds the same
   * idempotency key (409), or a dependency outside Stripe failed (424). */
  | "conflict"
  | "dependency"
  /** The key lacks the permission (403): an operator fixes the key once. */
  | "forbidden"
  /** Stripe is down (HTTP 500) and applies nothing: worth trying again. */
  | "down";

interface Fault {
  method: string;
  path: RegExp;
  mode: FaultMode;
  /** Stripe's error message, when the test needs its words. */
  message?: string;
}

class FakeStripe {
  calls: Call[] = [];
  customers = new Map<string, Record<string, string>>();
  invoices = new Map<string, Invoice>();
  /** Invoice items made without an invoice: they would land on a later one. */
  pending: Record<string, string>[] = [];
  configs = new Map<
    string,
    {
      id: string;
      is_default: boolean;
      active: boolean;
      params: Record<string, string>;
    }
  >();
  sessions: Record<string, string>[] = [];
  configUpdates: string[] = [];
  private keys = new Map<
    string,
    { fingerprint: string; status: number; body: unknown }
  >();
  private faults: Fault[] = [];
  private n = 0;

  /** `noConfigurations`: an account with no portal configuration yet, where
   * Stripe makes the first one created the default (seen 2026-11-07). */
  constructor(opts: { noConfigurations?: boolean } = {}) {
    if (opts.noConfigurations) return;
    // The Hosted portal's default configuration: never ours to change.
    this.configs.set("bpc_default", {
      id: "bpc_default",
      is_default: true,
      active: true,
      params: {},
    });
  }

  client(): StripeClient {
    return new StripeClient({
      key: "sk_test_enterprise",
      mode: "test",
      fetchImpl: this.fetch,
      attempts: 1,
      sleep: async () => {},
    });
  }

  /** The next matching request fails once. */
  fail(method: string, path: RegExp, mode: FaultMode, message?: string): void {
    this.faults.push({ method, path, mode, ...(message ? { message } : {}) });
  }

  /** Stripe drops idempotency keys after 24 hours. */
  forgetKeys(): void {
    this.keys.clear();
  }

  posts(): Call[] {
    return this.calls.filter((c) => c.method === "POST");
  }

  invoicesOf(metadataEnterprise: string): Invoice[] {
    return [...this.invoices.values()].filter(
      (i) => i.metadata.enterprise_id === metadataEnterprise,
    );
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }

  private view(inv: Invoice) {
    const total = inv.lines.reduce((sum, l) => sum + l.amount, 0);
    return {
      id: inv.id,
      object: "invoice",
      customer: inv.customer,
      status: inv.status,
      metadata: inv.metadata,
      collection_method: inv.params.collection_method,
      currency: inv.params.currency,
      auto_advance: inv.params.auto_advance === "true",
      subtotal: total,
      total,
      amount_due: total,
      lines: {
        object: "list",
        has_more: false,
        data: inv.lines.map((l) => ({ ...l, object: "line_item" })),
      },
      status_transitions: {
        finalized_at: inv.finalized > 0 ? 1 : null,
      },
    };
  }

  private apply(c: Call): { status: number; body: unknown } {
    const notFound = {
      status: 404,
      body: {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such object",
        },
      },
    };
    const unexpected = {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "invoice_unexpected_state",
          message: "unexpected state",
        },
      },
    };
    const p = c.params;
    let m: RegExpExecArray | null;
    if (c.method === "POST" && c.path === "/v1/customers") {
      const id = this.id("cus");
      this.customers.set(id, { ...p, id });
      return { status: 200, body: { id, object: "customer", email: p.email } };
    }
    if (c.method === "GET" && c.path === "/v1/invoices") {
      const data = [...this.invoices.values()]
        .filter((i) => !p.customer || i.customer === p.customer)
        .reverse()
        .slice(0, Number(p.limit ?? 10))
        .map((i) => this.view(i));
      return { status: 200, body: { object: "list", has_more: false, data } };
    }
    if (c.method === "POST" && c.path === "/v1/invoices") {
      if (!this.customers.has(p.customer)) return notFound;
      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(p)) {
        const mm = /^metadata\[(.+)\]$/.exec(k);
        if (mm) metadata[mm[1]] = v;
      }
      const id = this.id("in");
      this.invoices.set(id, {
        id,
        customer: p.customer,
        status: "draft",
        metadata,
        params: p,
        lines: [],
        sent: 0,
        finalized: 0,
      });
      return { status: 200, body: this.view(this.invoices.get(id)!) };
    }
    if ((m = /^\/v1\/invoices\/([^/]+)$/.exec(c.path)) && c.method === "GET") {
      const inv = this.invoices.get(m[1]);
      return inv ? { status: 200, body: this.view(inv) } : notFound;
    }
    if (
      (m = /^\/v1\/invoices\/([^/]+)\/lines$/.exec(c.path)) &&
      c.method === "GET"
    ) {
      const inv = this.invoices.get(m[1]);
      return inv ? { status: 200, body: this.view(inv).lines } : notFound;
    }
    if (c.method === "POST" && c.path === "/v1/invoiceitems") {
      if (!p.invoice) {
        this.pending.push(p);
        return {
          status: 200,
          body: { id: this.id("ii"), object: "invoiceitem" },
        };
      }
      const inv = this.invoices.get(p.invoice);
      if (!inv) return notFound;
      if (inv.status !== "draft") return unexpected;
      const amount = Number(p.amount);
      if (!Number.isInteger(amount) || p.currency !== "usd")
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message: "amount and currency usd required",
            },
          },
        };
      const line = {
        id: this.id("il"),
        amount,
        description: p.description ?? "",
      };
      inv.lines.push(line);
      return {
        status: 200,
        body: {
          id: this.id("ii"),
          object: "invoiceitem",
          invoice: inv.id,
          amount,
        },
      };
    }
    if (
      (m = /^\/v1\/invoices\/([^/]+)\/finalize$/.exec(c.path)) &&
      c.method === "POST"
    ) {
      const inv = this.invoices.get(m[1]);
      if (!inv) return notFound;
      if (inv.status !== "draft") return unexpected;
      inv.status = "open";
      inv.finalized += 1;
      return { status: 200, body: this.view(inv) };
    }
    if (
      (m = /^\/v1\/invoices\/([^/]+)\/send$/.exec(c.path)) &&
      c.method === "POST"
    ) {
      const inv = this.invoices.get(m[1]);
      if (!inv) return notFound;
      if (inv.status !== "open") return unexpected;
      inv.sent += 1;
      return { status: 200, body: this.view(inv) };
    }
    if (c.method === "GET" && c.path === "/v1/billing_portal/configurations") {
      const data = [...this.configs.values()]
        .filter((x) => p.active === undefined || String(x.active) === p.active)
        .map((x) => ({
          id: x.id,
          object: "billing_portal.configuration",
          is_default: x.is_default,
          active: x.active,
          metadata: metadataOf(x.params),
        }));
      return { status: 200, body: { object: "list", has_more: false, data } };
    }
    if (c.method === "POST" && c.path === "/v1/billing_portal/configurations") {
      const id = this.id("bpc");
      // Stripe makes the first configuration of an account its default.
      const isDefault = ![...this.configs.values()].some((x) => x.is_default);
      this.configs.set(id, {
        id,
        is_default: isDefault,
        active: true,
        params: p,
      });
      return {
        status: 200,
        body: {
          id,
          object: "billing_portal.configuration",
          is_default: isDefault,
          active: true,
          metadata: metadataOf(p),
        },
      };
    }
    if (
      (m = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(c.path)) &&
      c.method === "POST"
    ) {
      this.configUpdates.push(m[1]);
      const config = this.configs.get(m[1]);
      if (!config) return notFound;
      if (p.active === "false" && config.is_default)
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message:
                "You cannot set `active: false` on your default PortalConfiguration.",
            },
          },
        };
      if (p.active !== undefined) config.active = p.active === "true";
      return {
        status: 200,
        body: {
          id: m[1],
          active: config.active,
          metadata: metadataOf(config.params),
        },
      };
    }
    if (c.method === "POST" && c.path === "/v1/billing_portal/sessions") {
      // Stripe refuses a session on a configuration that is not active.
      if (p.configuration && this.configs.get(p.configuration)?.active !== true)
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message: "The configuration is not active.",
            },
          },
        };
      const id = this.id("bps");
      const session = {
        ...p,
        id,
        url: `https://billing.stripe.example/session/${id}`,
      };
      this.sessions.push(session);
      return {
        status: 200,
        body: { id, object: "billing_portal.session", url: session.url },
      };
    }
    return notFound;
  }

  fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const params: Record<string, string> = {};
    const source =
      method === "GET"
        ? u.searchParams
        : new URLSearchParams(String(init?.body ?? ""));
    for (const [k, v] of source) params[k] = v;
    const headers = new Headers(init?.headers);
    const call: Call = {
      method,
      path: u.pathname,
      params,
      key: headers.get("idempotency-key"),
    };
    this.calls.push(call);
    const fault = this.faults.findIndex(
      (f) => f.method === method && f.path.test(u.pathname),
    );
    const answer = (status: number, body: unknown) => ({
      ok: status < 300,
      status,
      json: async () => body,
    });
    if (fault >= 0 && this.faults[fault].mode === "down") {
      this.faults.splice(fault, 1);
      return answer(500, {
        error: { type: "api_error", message: "down for the test" },
      });
    }
    if (fault >= 0 && this.faults[fault].mode === "refused") {
      const [f] = this.faults.splice(fault, 1);
      return answer(400, {
        error: {
          type: "api_error",
          message: f.message ?? "refused by the test",
        },
      });
    }
    const passing = { conflict: 409, dependency: 424, forbidden: 403 } as const;
    const mode = fault >= 0 ? this.faults[fault].mode : null;
    if (mode && mode in passing) {
      const [f] = this.faults.splice(fault, 1);
      return answer(passing[mode as keyof typeof passing], {
        error: {
          type: "invalid_request_error",
          message: f.message ?? "passing by the test",
        },
      });
    }
    let result: { status: number; body: unknown };
    if (method === "POST" && call.key) {
      const fingerprint = `${u.pathname}?${[...Object.entries(params)].sort().join("&")}`;
      const seen = this.keys.get(call.key);
      if (seen && seen.fingerprint !== fingerprint) {
        result = {
          status: 400,
          body: {
            error: {
              type: "idempotency_error",
              message:
                "Keys for idempotent requests can only be used with the same parameters",
            },
          },
        };
      } else if (seen) {
        result = seen;
      } else {
        result = this.apply(call);
        this.keys.set(call.key, { fingerprint, ...result });
      }
    } else {
      result = this.apply(call);
    }
    if (fault >= 0 && this.faults[fault].mode === "lost") {
      this.faults.splice(fault, 1);
      throw new Error("connection reset after the write");
    }
    return answer(result.status, result.body);
  };
}

function metadataOf(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const m = /^metadata\[(.+)\]$/.exec(k);
    if (m) out[m[1]] = v;
  }
  return out;
}

// ------------------------------------------------------------------ setup

interface Setup {
  store: Store;
  dsn: string;
}

async function setup(): Promise<Setup> {
  clock = START;
  const dsn = await testDsn();
  const store = await openTestStoreOn(dsn, () => clock);
  return { store, dsn };
}

let signIns = 0;
/** A signed standard account set up the day before START and signed at START. */
async function account(
  s: Setup,
  plan: "monthly" | "yearly",
  seats: number,
): Promise<{ id: string; it: string }> {
  signIns += 1;
  const it = (await accountForDevSignIn(s.store, `it${signIns}@acme.example`))
    .id;
  clock = START - DAY;
  const made = await createEnterprise(s.store, it, {
    company: "Acme Inc.",
    billingEmail: "billing@acme.example",
    plan,
    seats,
  });
  if (!made.ok) throw new Error(`create refused: ${JSON.stringify(made)}`);
  clock = START;
  const signed = await signAgreement(s.store, it, {
    name: "Ada Admin",
    title: "IT Director",
    authority: true,
  });
  expect(signed).toEqual({ ok: true });
  return { id: made.id, it };
}

async function changeAt(
  s: Setup,
  it: string,
  at: number,
  from: number,
  to: number,
): Promise<void> {
  clock = at;
  expect(await changeSeats(s.store, it, { from, to })).toEqual({
    ok: true,
    seats: to,
  });
}

async function sql(
  s: Setup,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: s.dsn });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

interface LedgerRow {
  period: string;
  amountCents: number;
  lines: string[];
  state: string;
  reason: string | null;
  stripeInvoiceId: string | null;
}

async function ledger(s: Setup, enterpriseId: string): Promise<LedgerRow[]> {
  const rows = await sql(
    s,
    "select period, amount_cents, lines, state, reason, stripe_invoice_id " +
      "from enterprise_invoices where enterprise_id = $1 order by claimed_at, period",
    [enterpriseId],
  );
  return rows.rows.map((r) => ({
    period: r.period as string,
    amountCents: Number(r.amount_cents),
    lines: JSON.parse(r.lines as string) as string[],
    state: r.state as string,
    reason: r.reason as string | null,
    stripeInvoiceId: r.stripe_invoice_id as string | null,
  }));
}

async function auditActions(s: Setup, enterpriseId: string) {
  return (await s.store.auditEvents())
    .filter(
      (r) =>
        r.target === enterpriseId && r.action.startsWith("enterprise.invoice_"),
    )
    .map(({ actor, action, detail }) => ({ actor, action, detail }));
}

/** The one live (not void) Stripe invoice of a period, with its checks. */
function onlyInvoice(
  fake: FakeStripe,
  enterpriseId: string,
  period: string,
): Invoice {
  const found = fake
    .invoicesOf(enterpriseId)
    .filter((i) => i.metadata.period === period && i.status !== "void");
  expect({ period, count: found.length }).toEqual({ period, count: 1 });
  return found[0];
}

// ------------------------------------------------------------------ the pass

describe("the invoice pass", () => {
  test("monthly: each due month is one sent invoice for its highest N, to the billing email; a second pass writes nothing", async () => {
    const s = await setup();
    const { id, it } = await account(s, "monthly", 50);
    await changeAt(s, it, M(1) + DAY, 50, 80);
    await changeAt(s, it, M(1) + 2 * DAY, 80, 60);
    const fake = new FakeStripe();
    clock = due(3);
    expect(await invoiceEnterprises(s.store, fake.client(), due(3))).toEqual({
      claimed: 2,
      sent: 2,
      held: 0,
      failed: 0,
    });

    expect([...fake.customers.values()]).toEqual([
      expect.objectContaining({
        email: "billing@acme.example",
        name: "Acme Inc.",
        "metadata[enterprise_id]": id,
      }),
    ]);
    const customer = [...fake.customers.keys()][0];
    const stored = await sql(
      s,
      "select stripe_customer_id from enterprise_accounts where id = $1",
      [id],
    );
    expect(stored.rows[0].stripe_customer_id).toBe(customer);

    for (const [period, amount] of [
      ["m1", 80 * 2500],
      ["m2", 60 * 2500],
    ] as const) {
      const inv = onlyInvoice(fake, id, period);
      expect({
        period,
        customer: inv.customer,
        status: inv.status,
        sent: inv.sent,
        lines: inv.lines.map((l) => l.amount),
        collection: inv.params.collection_method,
        days: inv.params.days_until_due,
        currency: inv.params.currency,
        autoAdvance: inv.params.auto_advance,
      }).toEqual({
        period,
        customer,
        status: "open",
        sent: 1,
        lines: [amount],
        collection: "send_invoice",
        days: "30",
        currency: "usd",
        autoAdvance: "false",
      });
    }
    // Every item went on its own invoice, none on the customer's pending list.
    expect(fake.pending).toEqual([]);

    const rows = await ledger(s, id);
    expect(
      rows.map((r) => [r.period, r.amountCents, r.state, r.stripeInvoiceId]),
    ).toEqual([
      ["m1", 80 * 2500, "sent", onlyInvoice(fake, id, "m1").id],
      ["m2", 60 * 2500, "sent", onlyInvoice(fake, id, "m2").id],
    ]);
    for (const r of rows) expect(r.lines.length).toBeGreaterThan(0);

    const audits = await auditActions(s, id);
    expect(audits.map((a) => [a.actor, a.action])).toEqual([
      ["billing", "enterprise.invoice_sent"],
      ["billing", "enterprise.invoice_sent"],
    ]);
    for (const [i, period] of ["m1", "m2"].entries()) {
      expect(audits[i].detail).toContain(period);
      expect(audits[i].detail).toContain(onlyInvoice(fake, id, period).id);
    }

    // Every write is keyed; each step of each period has its own key.
    const posts = fake.posts();
    expect(posts.every((c) => c.key !== null && c.key.includes(id))).toBe(true);
    const invoiceKeys = posts
      .filter((c) => c.path !== "/v1/customers")
      .map((c) => c.key ?? "");
    expect(new Set(invoiceKeys).size).toBe(invoiceKeys.length);
    for (const period of ["m1", "m2"]) {
      expect(invoiceKeys.filter((k) => k.includes(period))).toHaveLength(4);
    }

    const before = fake.posts().length;
    expect(await invoiceEnterprises(s.store, fake.client(), due(3))).toEqual({
      claimed: 0,
      sent: 0,
      held: 0,
      failed: 0,
    });
    expect(fake.posts()).toHaveLength(before);
  });

  test("nothing in the free month or the grace after a month, and nothing for an unsigned or a negotiated account", async () => {
    const s = await setup();
    const { id } = await account(s, "monthly", 50);
    const unsignedIt = (await accountForDevSignIn(s.store, "it@globex.example"))
      .id;
    const unsigned = await createEnterprise(s.store, unsignedIt, {
      company: "Globex",
      billingEmail: "billing@globex.example",
      plan: "monthly",
      seats: 20,
    });
    if (!unsigned.ok) throw new Error("create refused");
    await accountForDevSignIn(s.store, "it@initech.example");
    const negotiated = await createNegotiatedEnterprise(s.store, {
      email: "it@initech.example",
      company: "Initech",
      plan: "monthly",
      seats: 300,
      priceNote: "custom",
      start: START,
    });
    if (!negotiated.ok) throw new Error("negotiated refused");
    const fake = new FakeStripe();
    for (const now of [START + DAY, M(2) + INVOICE_GRACE_MS - 1]) {
      expect(await invoiceEnterprises(s.store, fake.client(), now)).toEqual({
        claimed: 0,
        sent: 0,
        held: 0,
        failed: 0,
      });
    }
    expect(fake.posts()).toEqual([]);
    expect(await ledger(s, id)).toEqual([]);
    // The control: Acme's month 1 goes out once the grace is over.
    expect(
      (await invoiceEnterprises(s.store, fake.client(), due(2))).sent,
    ).toBe(1);
    expect(await ledger(s, unsigned.id)).toEqual([]);
    expect(await ledger(s, negotiated.id)).toEqual([]);
    expect(fake.invoicesOf(negotiated.id)).toEqual([]);
  });

  test("yearly: year 0 at the end of the trial; a quarter with no added seat writes no ledger row and no invoice", async () => {
    const s = await setup();
    const { id } = await account(s, "yearly", 50);
    const fake = new FakeStripe();
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(6)),
    ).toMatchObject({ sent: 1, held: 0, failed: 0 });
    expect(
      (await ledger(s, id)).map((r) => [r.period, r.amountCents, r.state]),
    ).toEqual([["y0", 50 * 2000 * 11, "sent"]]);
    expect(fake.invoicesOf(id).map((i) => i.metadata.period)).toEqual(["y0"]);
  });

  test("a quarter with many added seats: the ledger keeps every line, the invoice description stays short", async () => {
    const s = await setup();
    const { id, it } = await account(s, "yearly", 50);
    let n = 50;
    for (let i = 1; i <= 5; i++) {
      await changeAt(s, it, M(4) + i * DAY, n, n + 1);
      n += 1;
    }
    const fake = new FakeStripe();
    await invoiceEnterprises(s.store, fake.client(), due(6));
    const q1 = (await ledger(s, id)).find((r) => r.period === "y0q1");
    expect({ lines: q1?.lines.length, amount: q1?.amountCents }).toEqual({
      lines: 5,
      amount: 5 * 2000 * 8,
    });
    const inv = onlyInvoice(fake, id, "y0q1");
    expect(inv.lines.map((l) => l.amount)).toEqual([5 * 2000 * 8]);
    expect(inv.lines[0].description.split("\n").length).toBeLessThanOrEqual(4);
  });
});

describe("resuming after a failure", () => {
  const steps: [string, string, RegExp][] = [
    ["the customer", "POST", /^\/v1\/customers$/],
    ["the draft invoice", "POST", /^\/v1\/invoices$/],
    ["the item", "POST", /^\/v1\/invoiceitems$/],
    ["the finalize", "POST", /\/finalize$/],
    ["the send", "POST", /\/send$/],
  ];
  for (const [name, method, path] of steps) {
    test(`Stripe applied ${name} and the answer was lost: a pass after the keys expired makes no second invoice`, async () => {
      const s = await setup();
      const { id } = await account(s, "monthly", 50);
      const fake = new FakeStripe();
      fake.fail(method, path, "lost");
      expect(
        await invoiceEnterprises(s.store, fake.client(), due(2)),
      ).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
      // The enabling condition: Stripe did apply the step.
      expect(
        fake.calls.some((c) => c.method === method && path.test(c.path)),
      ).toBe(true);
      expect((await ledger(s, id))[0]?.state).not.toBe("sent");

      fake.forgetKeys();
      const later = due(2) + 25 * HOUR;
      expect(
        await invoiceEnterprises(s.store, fake.client(), later),
      ).toMatchObject({ claimed: 0, sent: 1, held: 0, failed: 0 });
      const inv = onlyInvoice(fake, id, "m1");
      expect({
        status: inv.status,
        lines: inv.lines.map((l) => l.amount),
        finalized: inv.finalized,
        sentAtLeastOnce: inv.sent >= 1,
      }).toEqual({
        status: "open",
        lines: [50 * 2500],
        finalized: 1,
        sentAtLeastOnce: true,
      });
      expect(fake.pending).toEqual([]);
      expect(
        (await ledger(s, id)).map((r) => [
          r.period,
          r.state,
          r.stripeInvoiceId,
        ]),
      ).toEqual([["m1", "sent", inv.id]]);
    });
  }

  test("the amount is fixed at the claim: a retry sends the claimed amount with the same key", async () => {
    const s = await setup();
    const { id } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    fake.fail("POST", /^\/v1\/invoices$/, "down");
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2)),
    ).toMatchObject({ claimed: 1, failed: 1 });
    expect(fake.invoicesOf(id)).toEqual([]);
    // N in month 1 changes in the database after the claim.
    await sql(
      s,
      "insert into enterprise_seat_changes (id, enterprise_id, at, from_seats, to_seats) " +
        "values ('late', $1, $2, 50, 500)",
      [id, M(1) + DAY],
    );
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2) + HOUR),
    ).toMatchObject({ sent: 1, failed: 0 });
    expect(onlyInvoice(fake, id, "m1").lines.map((l) => l.amount)).toEqual([
      50 * 2500,
    ]);
    expect((await ledger(s, id))[0]?.amountCents).toBe(50 * 2500);
    const creates = fake.posts().filter((c) => c.path === "/v1/invoices");
    expect(creates).toHaveLength(2);
    expect(creates[1].key).toBe(creates[0].key);
  });
});

// ------------------------------------------------------------------ held

describe("a period held for an operator", () => {
  test("over Stripe's limit: held with its amount, never sent, on the ops floor, until it is closed by hand", async () => {
    const s = await setup();
    // 5000 seats x $20 x 11 = $1.1M, over $999,999.99.
    const { id } = await account(s, "yearly", 5000);
    await accountForDevSignIn(s.store, "ops@isomux.example");
    expect(
      await setOperator(s.store, {
        email: "ops@isomux.example",
        on: true,
        actor: "cli:test",
      }),
    ).toMatchObject({ ok: true });
    const operator = (await accountForDevSignIn(s.store, "ops@isomux.example"))
      .id;
    const fake = new FakeStripe();
    expect(await invoiceEnterprises(s.store, fake.client(), due(1))).toEqual({
      claimed: 1,
      sent: 0,
      held: 1,
      failed: 0,
    });
    expect(
      fake.posts().filter((c) => c.path.startsWith("/v1/invoice")),
    ).toEqual([]);
    expect(await ledger(s, id)).toEqual([
      {
        period: "y0",
        amountCents: 5000 * 2000 * 11,
        lines: expect.any(Array),
        state: "held",
        reason: "over_limit",
        stripeInvoiceId: null,
      },
    ]);
    expect((await auditActions(s, id)).map((a) => a.action)).toEqual([
      "enterprise.invoice_held",
    ]);
    const listed = {
      enterpriseId: id,
      company: "Acme Inc.",
      period: "y0",
      amountCents: 5000 * 2000 * 11,
      reason: "over_limit",
      stripeInvoiceId: null,
    };
    expect(await heldEnterpriseInvoices(s.store)).toEqual([listed]);
    expect((await opsFloor(s.store, operator))?.enterpriseHeld).toEqual([
      listed,
    ]);

    // A held period is never retried by the pass.
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(1) + HOUR),
    ).toEqual({ claimed: 0, sent: 0, held: 0, failed: 0 });

    // Released, the pass looks again, and holds it again: still over.
    expect(await releaseHeldInvoice(s.store, id, "y0")).toEqual({ ok: true });
    expect((await ledger(s, id))[0]?.state).toBe("claimed");
    expect(
      (await invoiceEnterprises(s.store, fake.client(), due(1) + 2 * HOUR))
        .held,
    ).toBe(1);
    expect((await ledger(s, id))[0]?.state).toBe("held");

    // Closed by hand: invoiced in Stripe by the operator.
    expect(await recordManualInvoice(s.store, id, "y0", [])).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await recordManualInvoice(s.store, id, "y1", ["in_a"])).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await recordManualInvoice(s.store, id, "y0", ["in_a", "in_b"]),
    ).toEqual({ ok: true });
    expect((await ledger(s, id))[0]?.state).toBe("manual");
    expect(await heldEnterpriseInvoices(s.store)).toEqual([]);
    expect((await opsFloor(s.store, operator))?.enterpriseHeld).toEqual([]);
    expect(await recordManualInvoice(s.store, id, "y0", ["in_c"])).toEqual({
      ok: false,
      reason: "not_held",
    });
    expect(await releaseHeldInvoice(s.store, id, "y0")).toEqual({
      ok: false,
      reason: "not_held",
    });
    const before = fake.posts().length;
    await invoiceEnterprises(s.store, fake.client(), due(1) + 3 * HOUR);
    expect(fake.posts()).toHaveLength(before);
    expect(fake.invoicesOf(id)).toEqual([]);
  });

  test("an invoice changed in Stripe before it was finalized is held, not finalized", async () => {
    const s = await setup();
    const { id } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    fake.fail("POST", /\/finalize$/, "down");
    await invoiceEnterprises(s.store, fake.client(), due(2));
    const draft = onlyInvoice(fake, id, "m1");
    expect(draft.status).toBe("draft");
    // Someone adds a line in the Stripe dashboard.
    draft.lines.push({ id: "il_hand", amount: 999, description: "by hand" });
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2) + HOUR),
    ).toMatchObject({ sent: 0, held: 1 });
    expect(draft.status).toBe("draft");
    expect(draft.sent).toBe(0);
    expect((await ledger(s, id))[0]).toMatchObject({
      state: "held",
      reason: "amount_mismatch",
      stripeInvoiceId: draft.id,
    });
  });

  test("an invoice voided in Stripe before we sent it is held, and no second invoice is made", async () => {
    const s = await setup();
    const { id } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    fake.fail("POST", /\/send$/, "down");
    await invoiceEnterprises(s.store, fake.client(), due(2));
    const inv = onlyInvoice(fake, id, "m1");
    expect(inv.status).toBe("open");
    inv.status = "void";
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2) + HOUR),
    ).toMatchObject({ sent: 0, held: 1 });
    expect(fake.invoicesOf(id)).toHaveLength(1);
    expect(inv.sent).toBe(0);
    expect((await ledger(s, id))[0]).toMatchObject({
      state: "held",
      reason: "void",
      stripeInvoiceId: inv.id,
    });
  });
});

describe("what Stripe refuses for good, and what throws", () => {
  test("a refusal that would repeat (a 4xx, or the stored invoice gone) holds the period for an operator instead of failing every pass", async () => {
    const s = await setup();
    const a = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    fake.fail("POST", /^\/v1\/invoiceitems$/, "refused");
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2)),
    ).toMatchObject({ sent: 0, held: 1, failed: 0 });
    expect((await ledger(s, a.id))[0]).toMatchObject({
      period: "m1",
      state: "held",
    });
    expect(
      (await heldEnterpriseInvoices(s.store)).map((h) => [
        h.enterpriseId,
        h.period,
      ]),
    ).toEqual([[a.id, "m1"]]);

    // Someone deletes the draft in Stripe after we stored its id.
    const b = await account(s, "monthly", 20);
    fake.fail("POST", /\/finalize$/, "down");
    await invoiceEnterprises(s.store, fake.client(), due(2) + HOUR);
    const draft = onlyInvoice(fake, b.id, "m1");
    fake.invoices.delete(draft.id);
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2) + 2 * HOUR),
    ).toMatchObject({ sent: 0, held: 1, failed: 0 });
    expect((await ledger(s, b.id))[0]).toMatchObject({
      state: "held",
      stripeInvoiceId: draft.id,
    });
    expect(fake.invoicesOf(b.id)).toEqual([]);
  });

  test("a 4xx that passes (409, 424) or a key without the permission (403) is tried again next pass, not held", async () => {
    const s = await setup();
    const fake = new FakeStripe();
    const cases: [FaultMode, string, RegExp][] = [
      ["conflict", "POST", /^\/v1\/customers$/],
      ["dependency", "POST", /\/finalize$/],
      ["forbidden", "POST", /\/send$/],
    ];
    let t = due(2);
    for (const [mode, method, path] of cases) {
      const a = await account(s, "monthly", 50);
      fake.fail(method, path, mode);
      t += HOUR;
      expect(await invoiceEnterprises(s.store, fake.client(), t)).toMatchObject(
        {
          held: 0,
          failed: 1,
        },
      );
      expect((await ledger(s, a.id))[0].state).not.toBe("held");
      t += HOUR;
      await invoiceEnterprises(s.store, fake.client(), t);
      expect((await ledger(s, a.id))[0]).toMatchObject({
        period: "m1",
        state: "sent",
      });
    }
    expect(await heldEnterpriseInvoices(s.store)).toEqual([]);
  });

  test("Stripe's error text names the key: neither the pass's log lines nor a held period's audit row keep any of it", async () => {
    // Stripe's 403, as it answered on 2026-11-07 (2026-07-29.dahlia): the key
    // masked to its class and its last characters.
    const tail = "Zq7W";
    const forbidden =
      `Permission denied. The provided key 'rk_test_...${tail}' does not have ` +
      "the required permissions for this endpoint on account 'acct_x'. " +
      "Enabling Invoices Write ('invoice_write') permissions on this key would " +
      "allow this request to continue.";
    const refused = `Invalid request with key sk_live_****${tail}: no such customer.`;
    const s = await setup();
    const fake = new FakeStripe();
    const log: string[] = [];
    const a = await account(s, "monthly", 50);
    fake.fail("POST", /^\/v1\/invoices$/, "forbidden", forbidden);
    expect(
      await invoiceEnterprises(s.store, fake.client(), due(2), (l) =>
        log.push(l),
      ),
    ).toMatchObject({ failed: 1, held: 0 });
    // The next pass sends a's period, so the refusal below is b's alone.
    await invoiceEnterprises(s.store, fake.client(), due(2) + HOUR);
    expect((await ledger(s, a.id))[0].state).toBe("sent");
    const b = await account(s, "monthly", 20);
    fake.fail("POST", /^\/v1\/invoiceitems$/, "refused", refused);
    await invoiceEnterprises(s.store, fake.client(), due(2) + 2 * HOUR, (l) =>
      log.push(l),
    );
    expect((await ledger(s, b.id))[0].state).toBe("held");

    const audit = (await auditActions(s, b.id)).map((r) => r.detail ?? "");
    // Each surface carries Stripe's reason, so the redaction must leave it.
    const written = [
      { where: "log", text: log.join("\n") },
      { where: "audit", text: audit.join("\n") },
    ];
    for (const w of written) {
      expect({
        where: w.where,
        keyClass: /(?:sk|rk|pk)_(?:test|live)_/.test(w.text),
      }).toEqual({ where: w.where, keyClass: false });
      expect({ where: w.where, tail: w.text.includes(tail) }).toEqual({
        where: w.where,
        tail: false,
      });
    }
    expect(
      log.some((l) => l.includes(a.id) && l.includes("invoice_write")),
    ).toBe(true);
    expect(audit.some((d) => d.includes("no such customer"))).toBe(true);
  });

  test("an account whose period throws is retried soon; the accounts after it are still invoiced", async () => {
    const s = await setup();
    const broken = await account(s, "monthly", 50);
    const fine = await account(s, "monthly", 20);
    // A ledger row the pass cannot read.
    await sql(
      s,
      "insert into enterprise_invoices (enterprise_id, period, amount_cents, lines, " +
        "state, claimed_at, updated_at) values ($1, 'm1', 125000, '{', 'claimed', $2, $2)",
      [broken.id, due(2)],
    );
    const fake = new FakeStripe();
    const summary = await invoiceEnterprises(s.store, fake.client(), due(2));
    expect(summary.sent).toBe(1);
    expect((await ledger(s, fine.id)).map((r) => r.state)).toEqual(["sent"]);
    expect(fake.invoicesOf(broken.id)).toEqual([]);
    const at = await sql(
      s,
      "select next_invoice_at from enterprise_accounts where id = $1",
      [broken.id],
    );
    const next = Number(at.rows[0].next_invoice_at);
    expect(next).toBeGreaterThan(due(2));
    expect(next).toBeLessThanOrEqual(due(2) + HOUR);
  });
});

// ------------------------------------------------------------------ customer and portal

describe("the Stripe customer", () => {
  test("two callers at once make one customer; a refusal is 'stripe'; an unknown account is 'no_account'", async () => {
    const s = await setup();
    const { id } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    const [a, b] = await Promise.all([
      ensureEnterpriseCustomer(s.store, fake.client(), id),
      ensureEnterpriseCustomer(s.store, fake.client(), id),
    ]);
    expect(a).toEqual(b);
    expect(fake.customers.size).toBe(1);
    expect(a).toEqual({ ok: true, customerId: [...fake.customers.keys()][0] });
    expect(
      await ensureEnterpriseCustomer(s.store, fake.client(), "ent-none"),
    ).toMatchObject({ ok: false, reason: "no_account" });
    const other = await account(s, "monthly", 10);
    fake.fail("POST", /^\/v1\/customers$/, "refused");
    expect(
      await ensureEnterpriseCustomer(s.store, fake.client(), other.id),
    ).toMatchObject({ ok: false, reason: "stripe" });
  });
});

describe("the customer portal", () => {
  test("our own configuration (no email change, no subscription features), never the default; one configuration for every session", async () => {
    const s = await setup();
    const { it } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    const back = "https://cloud.example/enterprise";
    const first = await enterprisePortalUrl(s.store, fake.client(), it, back);
    expect(first).toEqual({ ok: true, url: fake.sessions[0]?.url });
    const configPosts = fake
      .posts()
      .filter((c) => c.path === "/v1/billing_portal/configurations");
    expect(configPosts).toHaveLength(1);
    const config = configPosts[0].params;
    expect(config["metadata[isx]"]).toBe("enterprise-portal");
    expect(config["features[invoice_history][enabled]"]).toBe("true");
    expect(config["features[payment_method_update][enabled]"]).toBe("true");
    const allowed = Object.entries(config)
      .filter(([k]) =>
        k.startsWith("features[customer_update][allowed_updates]"),
      )
      .map(([, v]) => v);
    expect(allowed).not.toContain("email");
    expect(config["features[subscription_cancel][enabled]"]).not.toBe("true");
    expect(config["features[subscription_update][enabled]"]).not.toBe("true");
    const ours =
      [...fake.configs.values()].find((c) => !c.is_default)?.id ?? "";
    expect(ours).not.toBe("");
    expect(fake.sessions[0]).toMatchObject({
      customer: [...fake.customers.keys()][0],
      return_url: back,
      configuration: ours,
    });

    const second = await enterprisePortalUrl(s.store, fake.client(), it, back);
    expect(second).toMatchObject({ ok: true });
    expect(
      fake
        .posts()
        .filter((c) => c.path === "/v1/billing_portal/configurations"),
    ).toHaveLength(1);
    expect(fake.sessions[1]?.configuration).toBe(ours);
    expect(fake.customers.size).toBe(1);
    expect(fake.configUpdates).not.toContain("bpc_default");
  });

  test("a configuration made earlier (another process) is found by its tag, not made again", async () => {
    const s = await setup();
    const { it } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    fake.configs.set("bpc_ours", {
      id: "bpc_ours",
      is_default: false,
      active: true,
      params: { "metadata[isx]": "enterprise-portal" },
    });
    expect(
      await enterprisePortalUrl(
        s.store,
        fake.client(),
        it,
        "https://cloud.example/enterprise",
      ),
    ).toMatchObject({ ok: true });
    expect(
      fake
        .posts()
        .filter((c) => c.path === "/v1/billing_portal/configurations"),
    ).toEqual([]);
    expect(fake.sessions[0]?.configuration).toBe("bpc_ours");
  });

  test("our configuration deactivated within the 24 hours Stripe keeps the create key: reactivated, not replayed", async () => {
    const s = await setup();
    const { it } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    const back = "https://cloud.example/enterprise";
    expect(
      await enterprisePortalUrl(s.store, fake.client(), it, back),
    ).toMatchObject({ ok: true });
    const ours = [...fake.configs.values()].filter((c) => !c.is_default);
    expect(ours).toHaveLength(1);
    // Someone deactivates it in the dashboard; the create key is still kept.
    ours[0].active = false;

    expect(await enterprisePortalUrl(s.store, fake.client(), it, back)).toEqual(
      { ok: true, url: fake.sessions[1]?.url },
    );
    expect(fake.sessions[1]?.configuration).toBe(ours[0].id);
    expect(fake.configs.get(ours[0].id)?.active).toBe(true);
    expect(
      [...fake.configs.values()].filter((c) => !c.is_default),
    ).toHaveLength(1);
    expect(fake.configs.get("bpc_default")?.active).toBe(true);
    expect(fake.configUpdates).not.toContain("bpc_default");
  });

  test("an active configuration of ours wins over an inactive one, which stays as it is", async () => {
    const s = await setup();
    const { it } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    const tag = { "metadata[isx]": "enterprise-portal" };
    fake.configs.set("bpc_old", {
      id: "bpc_old",
      is_default: false,
      active: false,
      params: tag,
    });
    fake.configs.set("bpc_new", {
      id: "bpc_new",
      is_default: false,
      active: true,
      params: tag,
    });
    expect(
      await enterprisePortalUrl(
        s.store,
        fake.client(),
        it,
        "https://cloud.example/enterprise",
      ),
    ).toMatchObject({ ok: true });
    expect(fake.sessions[0]?.configuration).toBe("bpc_new");
    expect(fake.configs.get("bpc_old")?.active).toBe(false);
    expect(
      fake
        .posts()
        .filter((c) => c.path.startsWith("/v1/billing_portal/configurations")),
    ).toEqual([]);
  });

  describe("on a Stripe account with no portal configuration yet", () => {
    const back = "https://cloud.example/enterprise";
    const tagOf = (c: { params: Record<string, string> }) =>
      c.params["metadata[isx]"];
    const ours = (fake: FakeStripe) =>
      [...fake.configs.values()].filter(
        (c) => tagOf(c) === "enterprise-portal",
      );
    const others = (fake: FakeStripe) =>
      [...fake.configs.values()].filter(
        (c) => tagOf(c) !== "enterprise-portal",
      );
    /** One default that is not ours (and says where it came from), and ours,
     * which is not the default; the sessions use ours. */
    function expectBaseAndOurs(fake: FakeStripe): void {
      const base = others(fake);
      const mine = ours(fake);
      expect(
        base.map((c) => ({
          isDefault: c.is_default,
          tagged: Boolean(tagOf(c)),
        })),
      ).toEqual([{ isDefault: true, tagged: true }]);
      expect(mine.map((c) => c.is_default)).toEqual([false]);
      expect(fake.sessions.length).toBeGreaterThan(0);
      for (const session of fake.sessions)
        expect(session.configuration).toBe(mine[0].id);
    }

    test("a default that is not ours is made first, so ours never becomes the default", async () => {
      const s = await setup();
      const { it } = await account(s, "monthly", 50);
      const fake = new FakeStripe({ noConfigurations: true });
      expect(
        await enterprisePortalUrl(s.store, fake.client(), it, back),
      ).toEqual({ ok: true, url: fake.sessions[0]?.url });
      expectBaseAndOurs(fake);

      const creates = () =>
        fake
          .posts()
          .filter((c) => c.path === "/v1/billing_portal/configurations").length;
      const before = creates();
      expect(
        await enterprisePortalUrl(s.store, fake.client(), it, back),
      ).toMatchObject({ ok: true });
      expect(creates()).toBe(before);
      expectBaseAndOurs(fake);
    });

    for (const mode of ["refused", "down"] as const) {
      test(`the default's create ${mode}: ours is not made on that call, and the next call recovers`, async () => {
        const s = await setup();
        const { it } = await account(s, "monthly", 50);
        const fake = new FakeStripe({ noConfigurations: true });
        fake.fail("POST", /^\/v1\/billing_portal\/configurations$/, mode);
        expect(
          await enterprisePortalUrl(s.store, fake.client(), it, back),
        ).toEqual({ ok: false, reason: "stripe" });
        expect(ours(fake)).toEqual([]);
        expect(fake.sessions).toEqual([]);

        expect(
          await enterprisePortalUrl(s.store, fake.client(), it, back),
        ).toMatchObject({ ok: true });
        expectBaseAndOurs(fake);
      });
    }

    test("the default's create applied with its answer lost: ours waits for the next call, which makes no second default", async () => {
      const s = await setup();
      const { it } = await account(s, "monthly", 50);
      const fake = new FakeStripe({ noConfigurations: true });
      fake.fail("POST", /^\/v1\/billing_portal\/configurations$/, "lost");
      expect(
        await enterprisePortalUrl(s.store, fake.client(), it, back),
      ).toEqual({ ok: false, reason: "stripe" });
      expect(others(fake).map((c) => c.is_default)).toEqual([true]);
      expect(ours(fake)).toEqual([]);

      expect(
        await enterprisePortalUrl(s.store, fake.client(), it, back),
      ).toMatchObject({ ok: true });
      expectBaseAndOurs(fake);
    });
  });

  test("refused for a negotiated, an unsigned or a missing account, with no Stripe call", async () => {
    const s = await setup();
    const fake = new FakeStripe();
    const back = "https://cloud.example/enterprise";
    const none = (await accountForDevSignIn(s.store, "it@none.example")).id;
    expect(
      await enterprisePortalUrl(s.store, fake.client(), none, back),
    ).toEqual({
      ok: false,
      reason: "no_account",
    });
    const unsignedIt = (await accountForDevSignIn(s.store, "it@globex.example"))
      .id;
    expect(
      (
        await createEnterprise(s.store, unsignedIt, {
          company: "Globex",
          billingEmail: "billing@globex.example",
          plan: "monthly",
          seats: 20,
        })
      ).ok,
    ).toBe(true);
    expect(
      await enterprisePortalUrl(s.store, fake.client(), unsignedIt, back),
    ).toEqual({ ok: false, reason: "not_signed" });
    const negotiatedIt = (
      await accountForDevSignIn(s.store, "it@initech.example")
    ).id;
    expect(
      (
        await createNegotiatedEnterprise(s.store, {
          email: "it@initech.example",
          company: "Initech",
          plan: "monthly",
          seats: 300,
          priceNote: "custom",
        })
      ).ok,
    ).toBe(true);
    expect(
      await enterprisePortalUrl(s.store, fake.client(), negotiatedIt, back),
    ).toEqual({ ok: false, reason: "negotiated" });
    expect(fake.calls).toEqual([]);
  });
});

// ------------------------------------------------------- the Hosted portal
//
// A Hosted customer updates the card and pays the open invoice in the same
// Stripe portal, on the customer of the office's subscription (task 87e0251d).

let hostedOffices = 0;
/** A Hosted office owned by a new account, with a subscription in `status`
 * (none for null). */
async function hostedOffice(
  s: Setup,
  status: string | null = "unpaid",
): Promise<{ accountId: string; instanceId: string; customer: string }> {
  hostedOffices += 1;
  const n = hostedOffices;
  const account = await s.store.tx(
    async () =>
      await ensureAccount(s.store, {
        id: `acct-hosted-${n}`,
        email: `owner${n}@hosted.example`,
      }),
  );
  const reserved = await reserveOffice(s.store, {
    accountId: account.id,
    officeName: `hosted${n}`,
    plan: "office",
    couponId: null,
  });
  if (!reserved.ok) throw new Error(JSON.stringify(reserved));
  const instanceId = reserved.reservation.instance_id;
  const customer = `cus_hosted_${n}`;
  if (status === null) return { accountId: account.id, instanceId, customer };
  await s.store.tx(
    async () =>
      await insertSubscription(s.store, {
        id: `sub_hosted_${n}`,
        account_id: account.id,
        instance_id: instanceId,
        stripe_customer_id: customer,
        status,
        current_period_end: START + 30 * DAY,
        cancel_at_period_end: 0,
        ended_at: null,
        canceled_at: null,
        cancellation_reason: null,
        discount_percent_off: null,
        discount_coupon_id: null,
        discount_ends_at: null,
        ever_full_discount: 0,
        latest_invoice_id: null,
        payment_failures: 4,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
        episode_id: null,
        last_event_id: null,
        last_event_created: null,
      }),
  );
  return { accountId: account.id, instanceId, customer };
}

describe("the Hosted customer portal", () => {
  const back = "https://cloud.example/office/hosted";

  test("the owner gets a new session on the subscription's customer, with our configuration, per click", async () => {
    const s = await setup();
    const office = await hostedOffice(s);
    const fake = new FakeStripe();
    const first = await hostedPortalUrl(
      s.store,
      fake.client(),
      office.accountId,
      office.instanceId,
      back,
    );
    expect(first).toEqual({ ok: true, url: fake.sessions[0]?.url });
    const ours =
      [...fake.configs.values()].find(
        (c) => c.params["metadata[isx]"] === "enterprise-portal",
      )?.id ?? "";
    // The enabling condition: our tagged configuration exists, and it is not
    // the account's default.
    expect(ours).not.toBe("");
    expect(ours).not.toBe("bpc_default");
    expect(fake.sessions[0]).toMatchObject({
      customer: office.customer,
      return_url: back,
      configuration: ours,
    });
    // The Hosted customer is never copied into a Stripe customer of our own.
    expect(fake.posts().filter((c) => c.path === "/v1/customers")).toEqual([]);

    // A second click is a new session, not a replay of the first.
    const second = await hostedPortalUrl(
      s.store,
      fake.client(),
      office.accountId,
      office.instanceId,
      back,
    );
    expect(second).toEqual({ ok: true, url: fake.sessions[1]?.url });
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]?.url).not.toBe(fake.sessions[0]?.url);
    expect(fake.configUpdates).not.toContain("bpc_default");
  });

  test("another account's office is refused before Stripe is asked", async () => {
    const s = await setup();
    const office = await hostedOffice(s);
    const stranger = await hostedOffice(s);
    const fake = new FakeStripe();
    expect(
      await hostedPortalUrl(
        s.store,
        fake.client(),
        stranger.accountId,
        office.instanceId,
        back,
      ),
    ).toEqual({ ok: false, reason: "not_yours" });
    expect(fake.calls).toEqual([]);
  });

  test("an office with no subscription, or no such office, is refused before Stripe is asked", async () => {
    const s = await setup();
    const office = await hostedOffice(s, null);
    const fake = new FakeStripe();
    for (const instanceId of [office.instanceId, "inst-not-there"]) {
      expect([
        instanceId,
        await hostedPortalUrl(
          s.store,
          fake.client(),
          office.accountId,
          instanceId,
          back,
        ),
      ]).toEqual([instanceId, { ok: false, reason: "no_subscription" }]);
    }
    expect(fake.calls).toEqual([]);
  });

  test("a session Stripe refuses is 'stripe'", async () => {
    const s = await setup();
    const office = await hostedOffice(s);
    const fake = new FakeStripe();
    fake.fail("POST", /^\/v1\/billing_portal\/sessions$/, "refused");
    expect(
      await hostedPortalUrl(
        s.store,
        fake.client(),
        office.accountId,
        office.instanceId,
        back,
      ),
    ).toEqual({ ok: false, reason: "stripe" });
    // The enabling condition: the refusal came from the session call.
    expect(
      fake.calls.some((c) => c.path === "/v1/billing_portal/sessions"),
    ).toBe(true);
    expect(fake.sessions).toEqual([]);
  });
});

// ------------------------------------------------------------------ roles

describe("as the deployed roles", () => {
  test("the provisioner runs the pass and holds a period; the web tier opens the portal and lists the held periods", async () => {
    const s = await setup();
    const monthly = await account(s, "monthly", 50);
    const big = await account(s, "yearly", 5000);
    const provisioner = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn: s.dsn, grants: PROVISIONER_GRANTS }),
      () => clock,
    );
    roleStores.push(provisioner);
    const fake = new FakeStripe();
    expect(
      await invoiceEnterprises(provisioner, fake.client(), due(2)),
    ).toEqual({ claimed: 2, sent: 1, held: 1, failed: 0 });
    expect((await ledger(s, monthly.id)).map((r) => r.state)).toEqual(["sent"]);
    expect((await ledger(s, big.id)).map((r) => r.state)).toEqual(["held"]);

    const web = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn: s.dsn, grants: WEB_GRANTS }),
      () => clock,
    );
    roleStores.push(web);
    expect(
      (await heldEnterpriseInvoices(web)).map((h) => [
        h.enterpriseId,
        h.period,
      ]),
    ).toEqual([[big.id, "y0"]]);
    // The big account has no customer yet: the web tier makes and stores it.
    expect(
      await enterprisePortalUrl(
        web,
        fake.client(),
        big.it,
        "https://cloud.example/enterprise",
      ),
    ).toMatchObject({ ok: true });
    const stored = await sql(
      s,
      "select stripe_customer_id from enterprise_accounts where id = $1",
      [big.id],
    );
    expect(stored.rows[0].stripe_customer_id).toMatch(/^cus_/);
  });

  test("the web tier opens a Hosted office's portal", async () => {
    const s = await setup();
    const office = await hostedOffice(s);
    const web = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn: s.dsn, grants: WEB_GRANTS }),
      () => clock,
    );
    roleStores.push(web);
    const fake = new FakeStripe();
    expect(
      await hostedPortalUrl(
        web,
        fake.client(),
        office.accountId,
        office.instanceId,
        "https://cloud.example/office/hosted",
      ),
    ).toEqual({ ok: true, url: fake.sessions[0]?.url });
  });
});

// ------------------------------------------------------------------ wake-up

const SCHEDULE: WorkScheduleOptions = {
  providerConfigured: false,
  provisioningConfigured: false,
  checkoutConfigured: false,
  cadenceConfigured: false,
  livenessConfigured: true,
  welcomeMailConfigured: false,
  enterpriseInvoicesConfigured: true,
  staleProvisioningMs: 30 * 60_000,
  staleProvisioningReason: "stalled",
};

describe("the drive loop wakes the pass", () => {
  async function wake(
    s: Setup,
    now: number,
    opts: WorkScheduleOptions = SCHEDULE,
  ) {
    const schedule = await s.store.workSchedule(now, 1, 1, opts);
    return { due: schedule.livenessDue, at: schedule.nextDueAt };
  }

  test("for a signed account the pass has not seen, then at its next period, soon after a failure, and at once after a release", async () => {
    const s = await setup();
    // With no office live, nothing else wakes the watch passes.
    const { id } = await account(s, "monthly", 50);
    const fake = new FakeStripe();
    const now = START + DAY;
    expect(await wake(s, now)).toEqual({ due: true, at: now });
    for (const on of [false, undefined]) {
      const opts = { ...SCHEDULE, enterpriseInvoicesConfigured: on };
      expect({ on, ...(await wake(s, now, opts)) }).toEqual({
        on,
        due: false,
        at: null,
      });
    }

    // Seen in the trial: idle until month 1's invoice may go out.
    await invoiceEnterprises(s.store, fake.client(), now);
    expect(await wake(s, now)).toEqual({ due: false, at: due(2) });
    expect((await wake(s, due(2) - 1)).due).toBe(false);
    expect((await wake(s, due(2))).due).toBe(true);

    // A failed step: soon, not at the next period.
    fake.fail("POST", /^\/v1\/invoices$/, "down");
    expect(
      (await invoiceEnterprises(s.store, fake.client(), due(2))).failed,
    ).toBe(1);
    const soon = await wake(s, due(2));
    expect(soon.due).toBe(false);
    expect(soon.at).toBeGreaterThan(due(2));
    expect(soon.at).toBeLessThanOrEqual(due(2) + HOUR);
    const retryAt = soon.at ?? 0;
    expect((await wake(s, retryAt)).due).toBe(true);
    expect(
      (await invoiceEnterprises(s.store, fake.client(), retryAt)).sent,
    ).toBe(1);
    expect(await wake(s, retryAt)).toEqual({ due: false, at: due(3) });

    // A held period waits for an operator, not for the loop; a release wakes it.
    await sql(
      s,
      "update enterprise_invoices set state = 'held', reason = 'void' " +
        "where enterprise_id = $1 and period = 'm1'",
      [id],
    );
    expect((await wake(s, retryAt)).due).toBe(false);
    expect(await releaseHeldInvoice(s.store, id, "m1")).toEqual({ ok: true });
    expect(await wake(s, retryAt)).toEqual({ due: true, at: retryAt });
  });

  test("a negotiated or an unsigned account never wakes it", async () => {
    const s = await setup();
    const unsignedIt = (await accountForDevSignIn(s.store, "it@globex.example"))
      .id;
    expect(
      (
        await createEnterprise(s.store, unsignedIt, {
          company: "Globex",
          billingEmail: "billing@globex.example",
          plan: "monthly",
          seats: 20,
        })
      ).ok,
    ).toBe(true);
    await accountForDevSignIn(s.store, "it@initech.example");
    expect(
      (
        await createNegotiatedEnterprise(s.store, {
          email: "it@initech.example",
          company: "Initech",
          plan: "monthly",
          seats: 300,
          priceNote: "custom",
          start: START,
        })
      ).ok,
    ).toBe(true);
    for (const now of [START + DAY, due(2), due(14)]) {
      expect({ now, ...(await wake(s, now)) }).toEqual({
        now,
        due: false,
        at: null,
      });
    }
  });
});
