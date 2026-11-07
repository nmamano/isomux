#!/usr/bin/env bun
// Exercise: the enterprise invoices and the customer portal against the REAL
// Stripe test API (task c4e204bf).
//
// The unit tests run enterprise-invoices.ts against a fake Stripe, which can
// only confirm what we believe about Stripe. This runs the same functions the
// storefront routes (createEnterprise, signAgreement, changeSeats,
// enterprisePortalUrl) and the provisioner pass (invoiceEnterprises) call, on
// a scratch schema with a clock it moves months ahead, and reads every object
// back from Stripe. No Stripe test clock: the invoices are one-off, and the
// trial and the periods are our contract calendar.
//
// Test mode only (StripeClient refuses a live key). Every customer carries the
// run id in its name and email, and the cleanup at the end finds them through
// Stripe's own list, so a run that stopped half way is cleaned up too. It
// prints ids, amounts and hosts only: never the key, a portal URL or an
// invoice URL.
//
// Usage:
//   bun --env-file=<test env file> control-plane/exercises/enterprise-billing-live.ts
//   ... enterprise-billing-live.ts --cleanup <run id>   # only the cleanup of an earlier run

import pg from "pg";
import { createEnterprise, changeSeats, signAgreement } from "../enterprise.ts";
import { addContractMonths, INVOICE_GRACE_MS } from "../enterprise-billing.ts";
import {
  enterprisePortalUrl,
  invoiceEnterprises,
} from "../enterprise-invoices.ts";
import { accountForDevSignIn } from "../signup.ts";
import type { Store } from "../store.ts";
import {
  StripeClient,
  type FormValue,
  type StripeResult,
} from "../stripe/client.ts";
import { freshDsn, openTestStoreOn, releaseTestStores } from "../testing/pg.ts";

const DAY_MS = 86_400_000;
const cleanupOnly = process.argv.indexOf("--cleanup");
const RUN =
  cleanupOnly >= 0
    ? (process.argv[cleanupOnly + 1] ?? "")
    : `isx-e2e-${Math.floor(Date.now() / 1000).toString(36)}`;
if (!/^isx-e2e-[a-z0-9]+$/.test(RUN))
  throw new Error("usage: --cleanup isx-e2e-<id>");
console.log(`run ${RUN}`);

const key = process.env.STRIPE_TEST_SECRET_KEY;
if (!key) throw new Error("STRIPE_TEST_SECRET_KEY is not set");
const real = new StripeClient({ key, mode: "test", timeoutMs: 30_000 });

function check(label: string, pass: boolean, detail = ""): void {
  console.log(
    `${pass ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`,
  );
  if (!pass) process.exitCode = 1;
}

function ok(r: StripeResult, what: string): Record<string, unknown> {
  if (r.kind !== "ok")
    throw new Error(
      `${what}: ${r.kind} ${"status" in r ? r.status : ""} ${r.reason}`,
    );
  return r.body;
}

function livemodeFalse(what: string, body: Record<string, unknown>): void {
  check(`${what} livemode=false`, body.livemode === false);
}

/** `/v1/invoices/in_123/send` -> `/v1/invoices/{id}/send`. */
function template(path: string): string {
  return path.replace(/\/(cus|in|ii|bpc|bps)_[A-Za-z0-9]+/g, "/{id}");
}

/** A StripeClient that records what it calls, and can lose one answer: the
 * call reaches Stripe, and the caller gets an ambiguous result. */
class Recording {
  readonly calls = new Set<string>();
  lose: { method: string; path: RegExp } | null = null;
  lastPortalSession: Record<string, unknown> | null = null;

  private note(method: string, path: string): void {
    this.calls.add(`${method} ${template(path)}`);
  }

  /** Only an applied call loses its answer: a refusal lost would be a
   * different case, so it fails the run instead. */
  private maybeLose(
    method: string,
    path: string,
    r: StripeResult,
  ): StripeResult {
    if (this.lose && this.lose.method === method && this.lose.path.test(path)) {
      this.lose = null;
      if (r.kind !== "ok") {
        check(
          `loss case applied on ${method} ${template(path)}`,
          false,
          r.kind,
        );
        return r;
      }
      console.log(`     (lost the answer to ${method} ${template(path)})`);
      return { kind: "ambiguous", reason: "exercise: answer lost" };
    }
    return r;
  }

  async get(path: string, query: Record<string, FormValue> = {}) {
    this.note("GET", path);
    return this.maybeLose("GET", path, await real.get(path, query));
  }

  async post(
    path: string,
    params: Record<string, FormValue>,
    idempotencyKey: string,
  ) {
    this.note("POST", path);
    const r = await real.post(path, params, idempotencyKey);
    if (path === "/v1/billing_portal/sessions" && r.kind === "ok")
      this.lastPortalSession = r.body;
    return this.maybeLose("POST", path, r);
  }

  async del(path: string) {
    this.note("DELETE", path);
    return this.maybeLose("DELETE", path, await real.del(path));
  }

  asClient(): StripeClient {
    return this as unknown as StripeClient;
  }
}

const pass = new Recording();
const portal = new Recording();

let now = Date.now();
const T0 = now;
const M = (k: number) => addContractMonths(T0, k);
/** The lost-answer account starts 10 days later, so at its due moments no
 * other account has a period due, and the lost answer can only be its own. */
const TL = T0 + 10 * DAY_MS;
const ML = (k: number) => addContractMonths(TL, k);
/** The moment a pass that is due at `issuedAt` runs. */
const due = (issuedAt: number) => issuedAt + INVOICE_GRACE_MS + 60_000;

interface Account {
  label: string;
  email: string;
  accountId: string;
  enterpriseId: string;
}

async function newAccount(
  store: Store,
  label: string,
  plan: "monthly" | "yearly",
  seats: number,
): Promise<Account> {
  const email = `${RUN}-${label}@example.com`;
  const account = await accountForDevSignIn(store, email);
  const made = await createEnterprise(store, account.id, {
    company: `${RUN} ${label}`,
    billingEmail: email,
    plan,
    seats,
  });
  if (!made.ok) throw new Error(`create ${label}: ${made.reason}`);
  const signed = await signAgreement(store, account.id, {
    name: "Exercise Signer",
    title: "IT",
    authority: true,
  });
  if (!signed.ok) throw new Error(`sign ${label}: ${signed.reason}`);
  return { label, email, accountId: account.id, enterpriseId: made.id };
}

async function seats(
  store: Store,
  a: Account,
  from: number,
  to: number,
): Promise<void> {
  const r = await changeSeats(store, a.accountId, { from, to });
  if (!r.ok) throw new Error(`seats ${a.label} ${from}->${to}: ${r.reason}`);
}

async function runPass(store: Store, label: string): Promise<void> {
  const s = await invoiceEnterprises(store, pass.asClient(), now, (line) =>
    console.log(`     pass: ${line}`),
  );
  console.log(
    `pass ${label}: claimed ${s.claimed}, sent ${s.sent}, held ${s.held}, failed ${s.failed}`,
  );
}

interface LedgerRow {
  period: string;
  amount_cents: string | number;
  state: string;
  stripe_invoice_id: string | null;
}

async function ledger(store: Store, a: Account): Promise<LedgerRow[]> {
  return store.sqlAll<LedgerRow>(
    "select period, amount_cents, state, stripe_invoice_id from enterprise_invoices " +
      "where enterprise_id = $1 order by claimed_at, period",
    [a.enterpriseId],
  );
}

async function customerOf(store: Store, a: Account): Promise<string> {
  const row = await store.sqlGet<{ stripe_customer_id: string | null }>(
    "select stripe_customer_id from enterprise_accounts where id = $1",
    [a.enterpriseId],
  );
  if (!row?.stripe_customer_id) throw new Error(`${a.label}: no customer`);
  return row.stripe_customer_id;
}

/** Every invoice Stripe holds for the account's customer. */
async function stripeInvoices(
  store: Store,
  a: Account,
): Promise<Record<string, unknown>[]> {
  const list = ok(
    await real.get("/v1/invoices", {
      customer: await customerOf(store, a),
      limit: 100,
    }),
    "list invoices",
  );
  return (list.data as Record<string, unknown>[]) ?? [];
}

/** The period's invoice, read back from Stripe, against Nil's amount. */
async function expectInvoice(
  store: Store,
  a: Account,
  period: string,
  cents: number,
): Promise<void> {
  const what = `${a.label} ${period}`;
  const rows = await ledger(store, a);
  const row = rows.find((r) => r.period === period);
  check(`${what} ledger sent`, row?.state === "sent", row?.state ?? "no row");
  check(
    `${what} ledger amount ${cents}`,
    Number(row?.amount_cents) === cents,
    String(row?.amount_cents),
  );
  const all = (await stripeInvoices(store, a)).filter(
    (i) => (i.metadata as Record<string, string>)?.period === period,
  );
  check(
    `${what} exactly one Stripe invoice`,
    all.length === 1,
    `${all.length}`,
  );
  if (all.length === 0 || !row?.stripe_invoice_id) return;
  const inv = ok(
    await real.get(`/v1/invoices/${row.stripe_invoice_id}`),
    "get invoice",
  );
  const lines = (inv.lines as { data?: unknown[] } | undefined)?.data ?? [];
  const meta = (inv.metadata as Record<string, string>) ?? {};
  livemodeFalse(`${what} invoice`, inv);
  check(`${what} id matches the list`, inv.id === all[0].id);
  check(`${what} status open`, inv.status === "open", String(inv.status));
  check(
    `${what} send_invoice`,
    inv.collection_method === "send_invoice",
    String(inv.collection_method),
  );
  check(`${what} usd`, inv.currency === "usd", String(inv.currency));
  check(
    `${what} amount_due ${cents}`,
    inv.amount_due === cents,
    String(inv.amount_due),
  );
  check(`${what} one line`, lines.length === 1, `${lines.length}`);
  check(
    `${what} customer email`,
    inv.customer_email === a.email,
    String(inv.customer_email === a.email),
  );
  check(
    `${what} metadata`,
    meta.enterprise_id === a.enterpriseId && meta.period === period,
  );
  const dueDays =
    typeof inv.due_date === "number" && typeof inv.created === "number"
      ? Math.round((inv.due_date - inv.created) / 86_400)
      : NaN;
  check(`${what} due in 30 days`, dueDays === 30, `${dueDays}`);
  console.log(`     ${what}: ${String(inv.id)} ${cents} ${String(inv.status)}`);
}

async function expectNextInvoiceAt(
  store: Store,
  a: Account,
  at: number,
): Promise<void> {
  const row = await store.sqlGet<{ next_invoice_at: string | number | null }>(
    "select next_invoice_at from enterprise_accounts where id = $1",
    [a.enterpriseId],
  );
  check(
    `${a.label} next_invoice_at`,
    Number(row?.next_invoice_at) === at + INVOICE_GRACE_MS,
    `${new Date(Number(row?.next_invoice_at)).toISOString()}`,
  );
}

async function expectPortal(store: Store, a: Account, what: string) {
  portal.lastPortalSession = null;
  const r = await enterprisePortalUrl(
    store,
    portal.asClient(),
    a.accountId,
    "https://example.com/enterprise",
  );
  if (!r.ok) {
    check(`portal ${what}`, false, r.reason);
    return;
  }
  const host = new URL(r.url).host;
  check(`portal ${what} host`, host === "billing.stripe.com", host);
  const session = portal.lastPortalSession as Record<string, unknown> | null;
  if (session) {
    livemodeFalse(`portal ${what} session`, session);
    const config = ok(
      await real.get(
        `/v1/billing_portal/configurations/${String(session.configuration)}`,
      ),
      "get portal configuration",
    );
    livemodeFalse(`portal ${what} configuration`, config);
    const meta = (config.metadata as Record<string, string>) ?? {};
    const features = config.features as Record<
      string,
      { enabled?: boolean; allowed_updates?: string[] }
    >;
    check(
      `portal ${what} configuration tagged`,
      meta.isx === "enterprise-portal",
    );
    check(`portal ${what} configuration active`, config.active === true);
    check(
      `portal ${what} features`,
      features.invoice_history?.enabled === true &&
        features.payment_method_update?.enabled === true &&
        features.subscription_cancel?.enabled === false &&
        features.subscription_update?.enabled === false &&
        !features.customer_update?.allowed_updates?.includes("email"),
    );
    console.log(`     portal ${what}: config ${String(config.id)}`);
    return String(config.id);
  }
  return undefined;
}

// ---------------------------------------------------------------- the run

const accounts: Account[] = [];
let configId: string | undefined;

if (cleanupOnly >= 0) {
  await cleanupStripe();
  process.exit(process.exitCode ?? 0);
}

const dsn = await freshDsn();
const schema = new URL(dsn).searchParams.get("application_name") ?? "";
const store = await openTestStoreOn(dsn, () => now);
try {
  const yearly = await newAccount(store, "yearly", "yearly", 5);
  const monthly = await newAccount(store, "monthly", "monthly", 3);
  now = TL;
  const lost = await newAccount(store, "lost", "monthly", 2);
  accounts.push(yearly, monthly, lost);

  // Monthly: 3 -> 4 -> 3 inside month 1. m1 bills the highest N.
  now = M(1) + DAY_MS;
  await seats(store, monthly, 3, 4);
  now = M(1) + 2 * DAY_MS;
  await seats(store, monthly, 4, 3);

  // The trial ends: yearly y0 = 5 x $20 x 11.
  now = due(M(1));
  await runPass(store, "trial end");
  await expectInvoice(store, yearly, "y0", 110_000);
  const yearlyCustomer = ok(
    await real.get(`/v1/customers/${await customerOf(store, yearly)}`),
    "get customer",
  );
  livemodeFalse("yearly customer", yearlyCustomer);
  check("yearly customer email", yearlyCustomer.email === yearly.email);
  await expectNextInvoiceAt(store, yearly, M(3));

  // m1 = 4 x $25 (highest N).
  now = due(M(2));
  await runPass(store, "month 2");
  await expectInvoice(store, monthly, "m1", 10_000);
  await expectNextInvoiceAt(store, monthly, M(3));

  // lost m1, the draft create's answer lost: the next pass adopts the draft.
  pass.lose = { method: "POST", path: /^\/v1\/invoices$/ };
  now = due(ML(2));
  await runPass(store, "lost month 2 (draft answer lost)");
  check("draft loss used", pass.lose === null);
  {
    const row = (await ledger(store, lost)).find((r) => r.period === "m1");
    check("lost m1 ledger has no invoice id", row?.stripe_invoice_id === null);
    const drafts = (await stripeInvoices(store, lost)).filter(
      (i) =>
        i.status === "draft" &&
        (i.metadata as Record<string, string>)?.period === "m1",
    );
    check(
      "lost m1 Stripe holds one draft",
      drafts.length === 1,
      `${drafts.length}`,
    );
  }
  await runPass(store, "lost month 2 again");
  await expectInvoice(store, lost, "m1", 5_000);

  // y0q0 bills nothing.
  now = due(M(3));
  await runPass(store, "month 3");
  check(
    "yearly y0q0 bills nothing",
    !(await ledger(store, yearly)).some((r) => r.period === "y0q0"),
  );

  // lost m2, the item's answer lost: the re-read shows the line.
  pass.lose = { method: "POST", path: /^\/v1\/invoiceitems$/ };
  now = due(ML(3));
  await runPass(store, "lost month 3 (item answer lost)");
  check("item loss used", pass.lose === null);
  {
    const row = (await ledger(store, lost)).find((r) => r.period === "m2");
    check("lost m2 ledger has the invoice id", Boolean(row?.stripe_invoice_id));
    if (row?.stripe_invoice_id) {
      const inv = ok(
        await real.get(`/v1/invoices/${row.stripe_invoice_id}`),
        "get invoice",
      );
      const lines = (inv.lines as { data?: unknown[] } | undefined)?.data ?? [];
      check(
        "lost m2 Stripe draft has one line",
        inv.status === "draft" && lines.length === 1,
        `${String(inv.status)} ${lines.length}`,
      );
    }
  }
  await runPass(store, "lost month 3 again");
  await expectInvoice(store, lost, "m2", 5_000);

  // +2 seats in contract month 4: y0q1 = 2 x $20 x 8.
  now = due(M(4));
  await runPass(store, "month 4");
  now = M(4) + DAY_MS;
  await seats(store, yearly, 5, 7);

  // lost m3, the finalize answer lost: the re-read is open, then the send.
  pass.lose = { method: "POST", path: /^\/v1\/invoices\/in_[^/]+\/finalize$/ };
  now = due(ML(4));
  await runPass(store, "lost month 4 (finalize answer lost)");
  check("finalize loss used", pass.lose === null);
  {
    const row = (await ledger(store, lost)).find((r) => r.period === "m3");
    check(
      "lost m3 ledger not sent",
      row?.state !== "sent",
      row?.state ?? "no row",
    );
    if (row?.stripe_invoice_id) {
      const inv = ok(
        await real.get(`/v1/invoices/${row.stripe_invoice_id}`),
        "get invoice",
      );
      check(
        "lost m3 Stripe invoice open",
        inv.status === "open",
        String(inv.status),
      );
    } else check("lost m3 ledger has the invoice id", false);
  }
  await runPass(store, "lost month 4 again");
  await expectInvoice(store, lost, "m3", 5_000);

  now = due(M(6));
  await runPass(store, "month 6");
  await expectInvoice(store, yearly, "y0q1", 32_000);

  // +1 seat in contract month 10: y0q2 nothing, y0q3 = 1 x $20 x 2, and y1 =
  // 8 x $240, both open on the same customer.
  now = due(M(9));
  await runPass(store, "month 9");
  now = M(10) + DAY_MS;
  await seats(store, yearly, 7, 8);
  now = due(M(12));
  await runPass(store, "month 12");
  check(
    "yearly y0q2 bills nothing",
    !(await ledger(store, yearly)).some((r) => r.period === "y0q2"),
  );
  await expectInvoice(store, yearly, "y0q3", 4_000);
  await expectInvoice(store, yearly, "y1", 192_000);

  // A second pass at the same moment: no new Stripe invoice.
  const before = new Map<string, number>();
  for (const a of accounts)
    before.set(a.label, (await stripeInvoices(store, a)).length);
  await runPass(store, "month 12 again");
  for (const a of accounts) {
    const n = (await stripeInvoices(store, a)).length;
    check(
      `${a.label} no new invoice on a second pass`,
      n === before.get(a.label),
      `${n}`,
    );
  }

  // The customer portal, for both plans; then again after the configuration
  // was deactivated (C5).
  configId = await expectPortal(store, yearly, "yearly");
  await expectPortal(store, monthly, "monthly");
  const isDefault = configId
    ? ok(
        await real.get(`/v1/billing_portal/configurations/${configId}`),
        "get portal configuration",
      ).is_default === true
    : false;
  if (isDefault) {
    // An account's first configuration is its default, and Stripe refuses to
    // deactivate a default or move the default. Today's code makes a base
    // default first; an account where an older build made ours first keeps it.
    console.log(
      `     portal: ${configId} is this account's default; the deactivation step is skipped`,
    );
  } else if (configId) {
    ok(
      await real.post(
        `/v1/billing_portal/configurations/${configId}`,
        { active: false },
        `${RUN}-deactivate-1`,
      ),
      "deactivate portal configuration",
    );
    const again = await expectPortal(store, yearly, "after deactivation");
    check(
      "portal after deactivation: the same configuration",
      again === configId,
    );
  }

  console.log(`pass client calls:\n  ${[...pass.calls].sort().join("\n  ")}`);
  console.log(
    `portal client calls:\n  ${[...portal.calls].sort().join("\n  ")}`,
  );
} catch (err) {
  check("run", false, err instanceof Error ? err.message : String(err));
} finally {
  await cleanup();
}
// The scratch pool in testing/pg.ts stays open and would keep the process up.
process.exit(process.exitCode ?? 0);

async function cleanup(): Promise<void> {
  try {
    await cleanupStripe();
  } finally {
    await releaseTestStores();
    check("scratch schema named", schema.length > 0);
    const db = new pg.Client({ connectionString: dsn });
    await db.connect();
    const left = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_namespace where nspname = $1",
      [schema],
    );
    await db.end();
    check(`scratch schema ${schema} dropped`, left.rows[0]?.n === 0);
  }
}

/** One cleanup step: a failure names what it left and does not stop the
 * others. */
async function step(
  what: string,
  call: () => Promise<StripeResult>,
): Promise<boolean> {
  try {
    const r = await call();
    if (r.kind === "ok") {
      console.log(`  ${what}`);
      return true;
    }
    check(`cleanup: ${what}`, false, `${r.kind}, left behind`);
  } catch (err) {
    check(
      `cleanup: ${what}`,
      false,
      `${err instanceof Error ? err.message : String(err)}, left behind`,
    );
  }
  return false;
}

async function listOf(
  path: string,
  query: Record<string, FormValue>,
): Promise<Record<string, unknown>[] | null> {
  try {
    const r = await real.get(path, query);
    if (r.kind === "ok")
      return (r.body.data as Record<string, unknown>[]) ?? [];
    check(`cleanup: list ${path}`, false, r.kind);
  } catch (err) {
    check(
      `cleanup: list ${path}`,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

async function cleanupStripe(): Promise<void> {
  console.log("cleanup:");
  for (const label of ["yearly", "monthly", "lost"]) {
    const email = `${RUN}-${label}@example.com`;
    const customers = await listOf("/v1/customers", { email, limit: 100 });
    if (!customers) {
      check(
        `cleanup: customers of ${email}`,
        false,
        "not listed, may be left behind",
      );
      continue;
    }
    for (const c of customers) {
      const id = String(c.id);
      const invoices = await listOf("/v1/invoices", {
        customer: id,
        limit: 100,
      });
      for (const inv of invoices ?? []) {
        const invId = String(inv.id);
        if (inv.status === "draft")
          await step(`deleted draft ${invId}`, () =>
            real.del(`/v1/invoices/${invId}`),
          );
        else if (inv.status === "open")
          await step(`voided ${invId}`, () =>
            real.post(`/v1/invoices/${invId}/void`, {}, `${RUN}-void-${invId}`),
          );
      }
      await step(`deleted customer ${id}`, () =>
        real.del(`/v1/customers/${id}`),
      );
    }
  }
  // Every active tagged configuration in test mode, ours or not (it carries
  // no run id): Stripe cannot delete one, and the next portal call makes it
  // active again.
  for (const c of (await listOf("/v1/billing_portal/configurations", {
    limit: 100,
  })) ?? []) {
    const meta = (c.metadata as Record<string, string>) ?? {};
    if (meta.isx !== "enterprise-portal" || c.active !== true) continue;
    // Stripe refuses to deactivate a default.
    if (c.is_default === true) {
      console.log(
        `  kept portal configuration ${String(c.id)}: the account's default`,
      );
      continue;
    }
    const id = String(c.id);
    await step(`deactivated portal configuration ${id}`, () =>
      real.post(
        `/v1/billing_portal/configurations/${id}`,
        { active: false },
        `${RUN}-deactivate-${id}`,
      ),
    );
  }
}
