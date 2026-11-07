// The tables of the enterprise accounts, kept out of store.ts for its size.
// store.ts splices ENTERPRISE_DDL into SCHEMA.

/** The tables ENTERPRISE_DDL creates, for store.ts PRODUCT_TABLES. */
export const ENTERPRISE_TABLES = [
  "enterprise_accounts",
  "enterprise_offices",
  "enterprise_seat_changes",
  "enterprise_invoices",
] as const;

/**
 * An enterprise account (enterprise.ts) and the offices that joined it. SCHEMA
 * creates them on a new database and migrateEnterpriseTables on an existing
 * one, from this one text.
 *
 * The account's secret is not stored: it is an HMAC of the account id and
 * secret_generation (enterprise.ts enterpriseSecret), so a database copy gives
 * no secret. An office makes its own id, so the office key is the pair
 * (enterprise_id, id): the same office id under two accounts is two rows.
 */
/*
 * S4 (billing, enterprise-invoices.ts): every change of N is a row of
 * enterprise_seat_changes, written in the transaction that changes N, so the
 * invoices can find the highest N of a month and the seats added in a quarter.
 * enterprise_invoices is the ledger: one row per account and billing period
 * (enterprise-billing.ts BillingPeriod.id), with the amount fixed when the
 * period is claimed and the step reached in Stripe.
 */
export const ENTERPRISE_DDL = `
create table if not exists enterprise_accounts (
  id text primary key,
  account_id text not null unique,
  company text not null,
  billing_email text not null,
  plan text not null check (plan in ('monthly', 'yearly')),
  seats integer not null check (seats > 0),
  kind text not null check (kind in ('standard', 'negotiated')),
  price_note text,
  secret_generation integer not null default 1,
  signer_name text,
  signer_title text,
  signed_at bigint,
  agreement_version text,
  agreement_sha256 text,
  contract_start bigint,
  version integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists enterprise_offices (
  enterprise_id text not null,
  id text not null,
  name text,
  members integer not null check (members >= 0),
  joined_at bigint not null,
  last_seen_at bigint not null,
  removed_at bigint,
  primary key (enterprise_id, id)
);
alter table enterprise_accounts add column if not exists stripe_customer_id text;
alter table enterprise_accounts add column if not exists next_invoice_at bigint;
create table if not exists enterprise_seat_changes (
  id text primary key,
  enterprise_id text not null,
  at bigint not null,
  from_seats integer not null check (from_seats >= 0),
  to_seats integer not null check (to_seats > 0)
);
create index if not exists enterprise_seat_changes_by_account
  on enterprise_seat_changes (enterprise_id, at);
create table if not exists enterprise_invoices (
  enterprise_id text not null,
  period text not null,
  amount_cents bigint not null check (amount_cents > 0),
  lines text not null,
  state text not null check (
    state in ('claimed', 'finalized', 'sent', 'held', 'manual')
  ),
  reason text,
  stripe_invoice_id text,
  manual_invoice_ids text,
  claimed_at bigint not null,
  updated_at bigint not null,
  primary key (enterprise_id, period)
);
`;

/** The enterprise accounts the invoice pass bills: signed standard ones. */
const INVOICED =
  "kind = 'standard' and signed_at is not null and contract_start is not null";

/**
 * store.ts workSchedule's clauses for the enterprise invoice pass (S4), kept
 * here for store.ts's size: `due` wakes the watch passes for an account the
 * pass has not looked at since it was signed, or whose next period is due
 * (invoiceEnterprises sets next_invoice_at); `at` adds those times to the next
 * due time. Off (no Stripe client), neither ever matches. Constants only, no
 * input.
 */
export function invoiceDue(opts: { enterpriseInvoicesConfigured?: boolean }): {
  due: string;
  at: string;
} {
  if (opts.enterpriseInvoicesConfigured !== true)
    return { due: "false", at: "" };
  return {
    due:
      `exists (select 1 from enterprise_accounts where ${INVOICED} ` +
      "and (next_invoice_at is null or next_invoice_at <= $1))",
    at:
      " union all select coalesce(next_invoice_at, $1) from enterprise_accounts " +
      `where $11 = 1 and ${INVOICED}`,
  };
}
