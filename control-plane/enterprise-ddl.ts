// The tables of the enterprise accounts, kept out of store.ts for its size.
// store.ts splices ENTERPRISE_DDL into SCHEMA.

/** The tables ENTERPRISE_DDL creates, for store.ts PRODUCT_TABLES. */
export const ENTERPRISE_TABLES = [
  "enterprise_accounts",
  "enterprise_offices",
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
`;
