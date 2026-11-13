// The enterprise invoices (task 71718489, S4). The provisioner's watch passes
// run invoiceEnterprises: for each signed standard account, each billing period
// that is due (enterprise-billing.ts) is claimed in the ledger with its amount
// fixed, then made in Stripe step by step (customer, draft invoice, its one
// item, finalize, send). Each step resumes from the ledger and from Stripe's
// own state, so a lost answer never makes a second invoice, even after the
// idempotency keys (the second guard) expired. Stripe sends the invoice to the
// billing email (send_invoice, due in 30 days). Unpaid invoices change nothing
// (Nil, 2026-11-06). A period that cannot be sent safely is 'held' for an
// operator: the ops floor lists it, and the CLI releases it or records that it
// was invoiced by hand.

import { randomUUID } from "node:crypto";
import {
  billingPeriodsDue,
  INVOICE_GRACE_MS,
  MAX_INVOICE_CENTS,
  nextInvoice,
  periodCharge,
  type BillingPeriod,
  type EnterprisePlan,
  type SeatChange,
} from "./enterprise-billing.ts";
import { currentSubscriptionForInstance } from "./reinstatement.ts";
import type { Store } from "./store.ts";
import type { StripeClient, StripeResult } from "./stripe/client.ts";

const ACTOR = "billing";
/** Days an invoice is due after it is sent (agreement s.4). */
const DAYS_UNTIL_DUE = 30;
/** Lines of the invoice item's description; the ledger keeps every line. */
const DESCRIPTION_LINES = 3;
/** Our customer portal configuration, found by this metadata. */
const PORTAL_TAG = "enterprise-portal";
/** The default configuration we make on an account that has none. */
const PORTAL_BASE_TAG = "portal-base";
/** A failed Stripe step is tried again after this long. */
const RETRY_MS = 15 * 60_000;

export interface InvoicePassSummary {
  /** Periods claimed in this pass. */
  claimed: number;
  sent: number;
  held: number;
  /** Periods left for the next pass (a Stripe call failed). */
  failed: number;
}

interface AccountRow {
  id: string;
  company: string;
  plan: EnterprisePlan;
  contract_start: string | number;
}

interface LedgerRow {
  period: string;
  amount_cents: string | number;
  lines: string;
  state: "claimed" | "finalized" | "sent" | "held" | "manual";
  stripe_invoice_id: string | null;
}

interface StripeInvoice {
  id: string;
  status: string;
  subtotal: number;
  metadata: Record<string, string>;
  lineCount: number;
}

interface StepFailure {
  ok: false;
  detail: string;
  /** Stripe refused it and will refuse it again: a 4xx other than a rate
   * limit, a conflict (409, the portal route sends the same customer key), a
   * failed outside dependency (424) or a key without the permission (fixed
   * for every account at once). */
  refused: boolean;
}

type Step<T> = { ok: true; value: T } | StepFailure;

function failed(result: StripeResult): StepFailure {
  return {
    ok: false,
    detail:
      result.kind === "ok"
        ? "unexpected answer"
        : result.kind === "rejected"
          ? `${result.status} ${result.reason}`
          : result.reason,
    refused:
      result.kind === "rejected" &&
      !result.retryable &&
      ![401, 403, 409, 424].includes(result.status),
  };
}

function audit(
  store: Store,
  enterpriseId: string,
  action: string,
  detail: string,
): Promise<unknown> {
  return store.appendAudit({
    actor: ACTOR,
    instance_id: null,
    action,
    target: enterpriseId,
    outcome: "succeeded",
    detail,
  });
}

function invoiceOf(body: Record<string, unknown>): StripeInvoice | null {
  if (typeof body.id !== "string" || typeof body.status !== "string")
    return null;
  const lines = body.lines as { data?: unknown[] } | undefined;
  return {
    id: body.id,
    status: body.status,
    subtotal: Number(body.subtotal ?? 0),
    metadata: (body.metadata as Record<string, string> | undefined) ?? {},
    lineCount: Array.isArray(lines?.data) ? lines.data.length : 0,
  };
}

/** The invoice item's description: the first lines, then a count. */
function description(lines: readonly string[]): string {
  if (lines.length <= DESCRIPTION_LINES + 1) return lines.join("\n");
  const rest = lines.length - DESCRIPTION_LINES;
  return [
    ...lines.slice(0, DESCRIPTION_LINES),
    `and ${rest} more seat increases`,
  ].join("\n");
}

async function historyOf(
  store: Store,
  enterpriseId: string,
): Promise<SeatChange[]> {
  const rows = await store.sqlAll<{
    at: string | number;
    from_seats: number;
    to_seats: number;
  }>(
    "select at, from_seats, to_seats from enterprise_seat_changes " +
      "where enterprise_id = $1 order by at, id",
    [enterpriseId],
  );
  return rows.map((r) => ({
    at: Number(r.at),
    from: Number(r.from_seats),
    to: Number(r.to_seats),
  }));
}

async function hold(
  store: Store,
  enterpriseId: string,
  row: LedgerRow,
  reason: string,
  invoiceId: string | null,
  stripeDetail?: string,
): Promise<void> {
  await store.tx(async () => {
    await store.sqlRun(
      "update enterprise_invoices set state = 'held', reason = $3, " +
        "stripe_invoice_id = coalesce(stripe_invoice_id, $4), updated_at = $5 " +
        "where enterprise_id = $1 and period = $2",
      [enterpriseId, row.period, reason, invoiceId, store.now()],
    );
    await audit(
      store,
      enterpriseId,
      "enterprise.invoice_held",
      `${row.period} ${row.amount_cents} ${reason}${invoiceId ? ` ${invoiceId}` : ""}` +
        (stripeDetail ? `: ${stripeDetail}` : ""),
    );
  });
}

async function setState(
  store: Store,
  enterpriseId: string,
  period: string,
  state: string,
): Promise<void> {
  await store.sqlRun(
    "update enterprise_invoices set state = $3, updated_at = $4 " +
      "where enterprise_id = $1 and period = $2",
    [enterpriseId, period, state, store.now()],
  );
}

/** The period's invoice: the stored one, or a draft/open one Stripe already
 * holds for it, or a new draft. */
async function invoiceFor(
  store: Store,
  stripe: StripeClient,
  enterpriseId: string,
  customerId: string,
  row: LedgerRow,
): Promise<Step<StripeInvoice>> {
  if (row.stripe_invoice_id) {
    const got = await stripe.get(`/v1/invoices/${row.stripe_invoice_id}`);
    if (got.kind !== "ok") return failed(got);
    const inv = invoiceOf(got.body);
    return inv ? { ok: true, value: inv } : failed(got);
  }
  // A create whose answer was lost: adopt it. A list, not a search: the list
  // is consistent at once.
  const list = await stripe.get("/v1/invoices", {
    customer: customerId,
    limit: 100,
  });
  if (list.kind !== "ok") return failed(list);
  const data = Array.isArray(list.body.data) ? list.body.data : [];
  let found: StripeInvoice | null = null;
  for (const item of data) {
    const inv = invoiceOf(item as Record<string, unknown>);
    if (
      inv &&
      (inv.status === "draft" || inv.status === "open") &&
      inv.metadata.enterprise_id === enterpriseId &&
      inv.metadata.period === row.period
    ) {
      found = inv;
      break;
    }
  }
  if (!found) {
    const made = await stripe.post(
      "/v1/invoices",
      {
        customer: customerId,
        collection_method: "send_invoice",
        days_until_due: DAYS_UNTIL_DUE,
        currency: "usd",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        description: `Isomux Enterprise seats (${row.period})`,
        metadata: { enterprise_id: enterpriseId, period: row.period },
      },
      `isx-ent-invoice-${enterpriseId}-${row.period}`,
    );
    if (made.kind !== "ok") return failed(made);
    found = invoiceOf(made.body);
    if (!found) return failed(made);
  }
  await store.sqlRun(
    "update enterprise_invoices set stripe_invoice_id = $3, updated_at = $4 " +
      "where enterprise_id = $1 and period = $2 and stripe_invoice_id is null",
    [enterpriseId, row.period, found.id, store.now()],
  );
  return { ok: true, value: found };
}

type Outcome = "sent" | "held" | "failed";

/** One claimed period, from wherever it stopped to sent (or held). */
async function advance(
  store: Store,
  stripe: StripeClient,
  enterpriseId: string,
  row: LedgerRow,
  report: (line: string) => void,
): Promise<Outcome> {
  const amount = Number(row.amount_cents);
  const lines = JSON.parse(row.lines) as string[];
  // A refusal that would repeat holds the period: failing it every pass would
  // block the account's later periods, seen only in the provisioner log.
  const fail = async (step: string, f: StepFailure): Promise<Outcome> => {
    if (f.refused) {
      report(
        `enterprise ${enterpriseId} ${row.period}: ${step}: ${f.detail}; held`,
      );
      await hold(
        store,
        enterpriseId,
        row,
        "refused",
        row.stripe_invoice_id,
        `${step}: ${f.detail}`,
      );
      return "held";
    }
    report(
      `enterprise ${enterpriseId} ${row.period}: ${step}: ${f.detail}; next pass`,
    );
    return "failed";
  };
  if (amount > MAX_INVOICE_CENTS) {
    await hold(store, enterpriseId, row, "over_limit", row.stripe_invoice_id);
    return "held";
  }
  const customer = await ensureEnterpriseCustomer(store, stripe, enterpriseId);
  if (!customer.ok)
    return fail("customer", {
      ok: false,
      detail: customer.detail ?? customer.reason,
      refused: customer.refused ?? false,
    });
  const got = await invoiceFor(
    store,
    stripe,
    enterpriseId,
    customer.customerId,
    row,
  );
  if (!got.ok) return fail("invoice", got);
  let inv = got.value;
  if (inv.status === "paid" && row.state === "finalized") {
    await markSent(store, enterpriseId, row, inv.id, amount);
    return "sent";
  }
  if (inv.status !== "draft" && inv.status !== "open") {
    await hold(store, enterpriseId, row, "void", inv.id);
    return "held";
  }
  if (inv.status === "draft") {
    if (inv.lineCount === 0) {
      const item = await stripe.post(
        "/v1/invoiceitems",
        {
          customer: customer.customerId,
          invoice: inv.id,
          amount,
          currency: "usd",
          description: description(lines),
        },
        `isx-ent-item-${enterpriseId}-${row.period}`,
      );
      if (item.kind !== "ok") return fail("item", failed(item));
      const again = await stripe.get(`/v1/invoices/${inv.id}`);
      if (again.kind !== "ok") return fail("invoice", failed(again));
      inv = invoiceOf(again.body) ?? inv;
    }
    if (inv.subtotal !== amount) {
      await hold(store, enterpriseId, row, "amount_mismatch", inv.id);
      return "held";
    }
    const done = await stripe.post(
      `/v1/invoices/${inv.id}/finalize`,
      { auto_advance: false },
      `isx-ent-finalize-${enterpriseId}-${row.period}`,
    );
    if (done.kind !== "ok") return fail("finalize", failed(done));
  } else if (inv.subtotal !== amount) {
    await hold(store, enterpriseId, row, "amount_mismatch", inv.id);
    return "held";
  }
  // Ours, not a Stripe field: Stripe marks no invoice as sent. A send repeated
  // after a lost answer is one more email, never a second charge.
  if (row.state !== "finalized")
    await setState(store, enterpriseId, row.period, "finalized");
  const sent = await stripe.post(
    `/v1/invoices/${inv.id}/send`,
    {},
    `isx-ent-send-${enterpriseId}-${row.period}`,
  );
  if (sent.kind !== "ok") return fail("send", failed(sent));
  await markSent(store, enterpriseId, row, inv.id, amount);
  return "sent";
}

async function markSent(
  store: Store,
  enterpriseId: string,
  row: LedgerRow,
  invoiceId: string,
  amount: number,
): Promise<void> {
  await store.tx(async () => {
    await store.sqlRun(
      "update enterprise_invoices set state = 'sent', stripe_invoice_id = $3, " +
        "updated_at = $4 where enterprise_id = $1 and period = $2",
      [enterpriseId, row.period, invoiceId, store.now()],
    );
    await audit(
      store,
      enterpriseId,
      "enterprise.invoice_sent",
      `${row.period} ${amount} ${invoiceId}`,
    );
  });
}

/** The ledger row of a due period: the existing one, or a new claim with its
 * amount fixed now. Null when the period bills nothing. */
async function claim(
  store: Store,
  account: AccountRow,
  history: readonly SeatChange[],
  period: BillingPeriod,
): Promise<{ row: LedgerRow; claimed: boolean } | null> {
  const existing = await store.sqlGet<LedgerRow>(
    "select period, amount_cents, lines, state, stripe_invoice_id " +
      "from enterprise_invoices where enterprise_id = $1 and period = $2",
    [account.id, period.id],
  );
  if (existing) return { row: existing, claimed: false };
  const charge = periodCharge(
    account.plan,
    Number(account.contract_start),
    history,
    period,
  );
  if (!charge) return null;
  const now = store.now();
  const made = await store.sqlGet<LedgerRow>(
    "insert into enterprise_invoices (enterprise_id, period, amount_cents, lines, " +
      "state, claimed_at, updated_at) values ($1, $2, $3, $4, 'claimed', $5, $5) " +
      "on conflict (enterprise_id, period) do nothing " +
      "returning period, amount_cents, lines, state, stripe_invoice_id",
    [
      account.id,
      period.id,
      charge.amountCents,
      JSON.stringify(charge.lines),
      now,
    ],
  );
  if (made) return { row: made, claimed: true };
  // Another pass claimed it first.
  const theirs = await store.sqlGet<LedgerRow>(
    "select period, amount_cents, lines, state, stripe_invoice_id " +
      "from enterprise_invoices where enterprise_id = $1 and period = $2",
    [account.id, period.id],
  );
  return theirs ? { row: theirs, claimed: false } : null;
}

/** One pass over every signed standard account. */
export async function invoiceEnterprises(
  store: Store,
  stripe: StripeClient,
  now: number,
  report: (line: string) => void = () => {},
): Promise<InvoicePassSummary> {
  const summary: InvoicePassSummary = {
    claimed: 0,
    sent: 0,
    held: 0,
    failed: 0,
  };
  // Negotiated accounts have a custom price: an operator invoices them.
  const accounts = await store.sqlAll<AccountRow>(
    "select id, company, plan, contract_start from enterprise_accounts " +
      "where kind = 'standard' and signed_at is not null and contract_start is not null " +
      "order by created_at, id",
  );
  for (const account of accounts) {
    const periods = billingPeriodsDue(
      account.plan,
      Number(account.contract_start),
      now,
    );
    let retry = false;
    // One account that throws (a ledger row it cannot read) must not stop the
    // others, nor wake the pass again at once.
    try {
      const history =
        periods.length > 0 ? await historyOf(store, account.id) : [];
      for (const period of periods) {
        const claimed = await claim(store, account, history, period);
        if (!claimed) continue;
        if (claimed.claimed) summary.claimed += 1;
        const { row } = claimed;
        if (row.state !== "claimed" && row.state !== "finalized") continue;
        const outcome = await advance(store, stripe, account.id, row, report);
        summary[outcome] += 1;
        // Oldest first: a period that failed keeps the later ones of this
        // account for the next pass.
        if (outcome === "failed") {
          retry = true;
          break;
        }
      }
    } catch (err) {
      report(
        `enterprise ${account.id}: ${err instanceof Error ? err.message : String(err)}; next pass`,
      );
      summary.failed += 1;
      retry = true;
    }
    // When the drive loop wakes this pass for the account again (store.ts
    // workSchedule): soon after a failure, else when its next period is due.
    const start = Number(account.contract_start);
    const next = retry
      ? now + RETRY_MS
      : nextInvoice(account.plan, start, [], now - INVOICE_GRACE_MS).period
          .issuedAt + INVOICE_GRACE_MS;
    await store.sqlRun(
      "update enterprise_accounts set next_invoice_at = $2 where id = $1",
      [account.id, next],
    );
  }
  return summary;
}

export type EnsureCustomerResult =
  | { ok: true; customerId: string }
  | {
      ok: false;
      reason: "no_account" | "stripe";
      detail?: string;
      /** Stripe will refuse it again (see StepFailure). */
      refused?: boolean;
    };

/** The account's Stripe customer, made once (pass and portal route share it:
 * the same key and the same parameters, stored by compare-and-set). A create
 * whose answer was lost and then failed for over 24 hours (the key expired)
 * makes a second customer: the first stays empty, nothing is charged twice. */
export async function ensureEnterpriseCustomer(
  store: Store,
  stripe: StripeClient,
  enterpriseId: string,
): Promise<EnsureCustomerResult> {
  const read = () =>
    store.sqlGet<{
      company: string;
      billing_email: string;
      stripe_customer_id: string | null;
    }>(
      "select company, billing_email, stripe_customer_id from enterprise_accounts where id = $1",
      [enterpriseId],
    );
  const row = await read();
  if (!row) return { ok: false, reason: "no_account" };
  if (row.stripe_customer_id)
    return { ok: true, customerId: row.stripe_customer_id };
  const made = await stripe.post(
    "/v1/customers",
    {
      email: row.billing_email,
      name: row.company,
      metadata: { enterprise_id: enterpriseId },
    },
    `isx-ent-customer-${enterpriseId}`,
  );
  if (made.kind !== "ok" || typeof made.body.id !== "string") {
    const f = failed(made);
    return {
      ok: false,
      reason: "stripe",
      detail: f.detail,
      refused: f.refused,
    };
  }
  await store.sqlRun(
    "update enterprise_accounts set stripe_customer_id = $2 " +
      "where id = $1 and stripe_customer_id is null",
    [enterpriseId, made.body.id],
  );
  const stored = await read();
  return {
    ok: true,
    customerId: stored?.stripe_customer_id ?? made.body.id,
  };
}

export type HeldInvoiceResult =
  { ok: true } | { ok: false; reason: "not_found" | "not_held" | "invalid" };

async function changeHeld(
  store: Store,
  enterpriseId: string,
  period: string,
  apply: () => Promise<unknown>,
): Promise<HeldInvoiceResult> {
  return store.tx(async (): Promise<HeldInvoiceResult> => {
    const row = await store.sqlGet<{ state: string }>(
      "select state from enterprise_invoices " +
        "where enterprise_id = $1 and period = $2 for update",
      [enterpriseId, period],
    );
    if (!row) return { ok: false, reason: "not_found" };
    if (row.state !== "held") return { ok: false, reason: "not_held" };
    await apply();
    return { ok: true };
  });
}

/** Operator: a held period goes back to the pass (state 'claimed'). */
export async function releaseHeldInvoice(
  store: Store,
  enterpriseId: string,
  period: string,
): Promise<HeldInvoiceResult> {
  return changeHeld(store, enterpriseId, period, async () => {
    await store.sqlRun(
      "update enterprise_invoices set state = 'claimed', reason = null, " +
        "updated_at = $3 where enterprise_id = $1 and period = $2",
      [enterpriseId, period, store.now()],
    );
    // Wake the pass for this account now, not at its next period.
    await store.sqlRun(
      "update enterprise_accounts set next_invoice_at = null where id = $1",
      [enterpriseId],
    );
    await store.appendAudit({
      actor: "operator",
      instance_id: null,
      action: "enterprise.invoice_released",
      target: enterpriseId,
      outcome: "succeeded",
      detail: period,
    });
  });
}

/** Operator: a held period was invoiced by hand in Stripe (state 'manual'). */
export async function recordManualInvoice(
  store: Store,
  enterpriseId: string,
  period: string,
  invoiceIds: readonly string[],
): Promise<HeldInvoiceResult> {
  const ids = invoiceIds.map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0 || ids.some((id) => !/^in_[A-Za-z0-9_]+$/.test(id)))
    return { ok: false, reason: "invalid" };
  return changeHeld(store, enterpriseId, period, async () => {
    await store.sqlRun(
      "update enterprise_invoices set state = 'manual', manual_invoice_ids = $3, " +
        "updated_at = $4 where enterprise_id = $1 and period = $2",
      [enterpriseId, period, ids.join(","), store.now()],
    );
    await store.appendAudit({
      actor: "operator",
      instance_id: null,
      action: "enterprise.invoice_manual",
      target: enterpriseId,
      outcome: "succeeded",
      detail: `${period} ${ids.join(",")}`,
    });
  });
}

/** A held period, for the ops floor. */
export interface HeldEnterpriseInvoice {
  enterpriseId: string;
  company: string;
  period: string;
  amountCents: number;
  reason: string;
  stripeInvoiceId: string | null;
}

export async function heldEnterpriseInvoices(
  store: Store,
): Promise<HeldEnterpriseInvoice[]> {
  const rows = await store.sqlAll<{
    enterprise_id: string;
    company: string;
    period: string;
    amount_cents: string | number;
    reason: string | null;
    stripe_invoice_id: string | null;
  }>(
    "select i.enterprise_id, a.company, i.period, i.amount_cents, i.reason, " +
      "i.stripe_invoice_id from enterprise_invoices i " +
      "join enterprise_accounts a on a.id = i.enterprise_id " +
      "where i.state = 'held' order by i.claimed_at, i.enterprise_id, i.period",
  );
  return rows.map((r) => ({
    enterpriseId: r.enterprise_id,
    company: r.company,
    period: r.period,
    amountCents: Number(r.amount_cents),
    reason: r.reason ?? "",
    stripeInvoiceId: r.stripe_invoice_id,
  }));
}

interface PortalConfigurationItem {
  id?: unknown;
  active?: unknown;
  is_default?: unknown;
  metadata?: Record<string, string>;
}

async function portalConfigurations(
  stripe: StripeClient,
): Promise<Step<PortalConfigurationItem[]>> {
  const list = await stripe.get("/v1/billing_portal/configurations", {
    limit: 100,
  });
  if (list.kind !== "ok") return failed(list);
  const data = Array.isArray(list.body.data) ? list.body.data : [];
  return { ok: true, value: data as PortalConfigurationItem[] };
}

/** A default configuration on the account: the existing one, or a base we
 * make. Stripe makes the first configuration of an account its default, and
 * the Dashboard's portal settings edit the default, so ours must never be the
 * first one. The base has conservative features and its own tag. */
async function ensureDefaultConfiguration(
  stripe: StripeClient,
  data: readonly PortalConfigurationItem[],
): Promise<Step<null>> {
  if (data.some((c) => c.is_default === true)) return { ok: true, value: null };
  const made = await stripe.post(
    "/v1/billing_portal/configurations",
    {
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: false },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
      metadata: { isx: PORTAL_BASE_TAG },
    },
    "isx-ent-portal-configuration-base",
  );
  if (made.kind !== "ok") return failed(made);
  if (made.body.is_default === true) return { ok: true, value: null };
  // Another configuration became the default first: confirm one exists.
  const again = await portalConfigurations(stripe);
  if (!again.ok) return again;
  return again.value.some((c) => c.is_default === true)
    ? { ok: true, value: null }
    : { ok: false, detail: "no default portal configuration", refused: false };
}

/** Our portal configuration: found by its tag (an active one first, else an
 * inactive one, made active again), else made once, after the account has a
 * default (ensureDefaultConfiguration). Never a default: we do not edit or
 * deactivate one. An inactive one is never left to the create: for 24 hours
 * its fixed key replays the inactive id. */
async function portalConfiguration(
  stripe: StripeClient,
): Promise<Step<string>> {
  const list = await portalConfigurations(stripe);
  if (!list.ok) return list;
  const data = list.value;
  let inactive: string | null = null;
  for (const c of data) {
    if (typeof c.id !== "string" || c.metadata?.isx !== PORTAL_TAG) continue;
    if (c.active === true) return { ok: true, value: c.id };
    inactive ??= c.id;
  }
  if (inactive) {
    const on = await stripe.post(
      `/v1/billing_portal/configurations/${inactive}`,
      { active: true },
      `isx-ent-portal-configuration-on-${inactive}-${randomUUID()}`,
    );
    if (on.kind !== "ok") return failed(on);
    return { ok: true, value: inactive };
  }
  const base = await ensureDefaultConfiguration(stripe, data);
  if (!base.ok) return base;
  const made = await stripe.post(
    "/v1/billing_portal/configurations",
    {
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        // No email: the account page names the billing email we keep.
        customer_update: {
          enabled: true,
          allowed_updates: ["address", "tax_id", "name"],
        },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
      metadata: { isx: PORTAL_TAG },
    },
    `isx-ent-portal-configuration-${PORTAL_TAG}`,
  );
  if (made.kind !== "ok" || typeof made.body.id !== "string")
    return failed(made);
  return { ok: true, value: made.body.id };
}

/** The Stripe customer portal for a Hosted office's subscription: the
 * customer updates the card and pays the open invoice there. Only the account
 * that owns the subscription gets a session. */
export async function hostedPortalUrl(
  store: Store,
  stripe: StripeClient,
  accountId: string,
  instanceId: string,
  returnUrl: string,
): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: "not_yours" | "no_subscription" | "stripe" }
> {
  const row = await currentSubscriptionForInstance(store, instanceId);
  if (!row) return { ok: false, reason: "no_subscription" };
  if (row.account_id !== accountId) return { ok: false, reason: "not_yours" };
  return portalSession(
    stripe,
    row.stripe_customer_id,
    returnUrl,
    // A new session per click.
    `isx-hosted-portal-${row.id}-${randomUUID()}`,
  );
}

/** One portal session on our configuration for `customer`. */
async function portalSession(
  stripe: StripeClient,
  customer: string,
  returnUrl: string,
  idempotencyKey: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: "stripe" }> {
  const configuration = await portalConfiguration(stripe);
  if (!configuration.ok) return { ok: false, reason: "stripe" };
  const session = await stripe.post(
    "/v1/billing_portal/sessions",
    {
      customer,
      return_url: returnUrl,
      configuration: configuration.value,
    },
    idempotencyKey,
  );
  if (session.kind !== "ok" || typeof session.body.url !== "string")
    return { ok: false, reason: "stripe" };
  return { ok: true, url: session.body.url };
}

/** The Stripe customer portal for the signed-in account's IT, with our own
 * configuration (invoice history, payment method, address and tax id; no
 * email change). */
export async function enterprisePortalUrl(
  store: Store,
  stripe: StripeClient,
  accountId: string,
  returnUrl: string,
): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: "no_account" | "not_signed" | "negotiated" | "stripe" }
> {
  const row = await store.sqlGet<{
    id: string;
    kind: string;
    signed_at: string | number | null;
  }>(
    "select id, kind, signed_at from enterprise_accounts where account_id = $1",
    [accountId],
  );
  if (!row) return { ok: false, reason: "no_account" };
  if (row.kind === "negotiated") return { ok: false, reason: "negotiated" };
  if (row.signed_at === null) return { ok: false, reason: "not_signed" };
  const customer = await ensureEnterpriseCustomer(store, stripe, row.id);
  if (!customer.ok) return { ok: false, reason: "stripe" };
  return portalSession(
    stripe,
    customer.customerId,
    returnUrl,
    // A new session per click.
    `isx-ent-portal-${row.id}-${randomUUID()}`,
  );
}
