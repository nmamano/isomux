// The tables of the critical-issue status pages, kept out of store.ts for its
// size. store.ts splices INCIDENTS_DDL into SCHEMA.

/**
 * The status pages for an enterprise customer's critical issue (incidents.ts).
 * SCHEMA creates them on a new database and migrateIncidentTables on an
 * existing one, from this one text.
 *
 * A customer's private link is not stored: it is an HMAC of the customer id and
 * link_generation (incidents.ts statusToken). incident_updates has no update
 * and no delete grant, so an update cannot change once posted. incident_keys
 * holds one row, seeded here with no key, so the web role needs no insert.
 */
export const INCIDENTS_DDL = `
create table if not exists status_customers (
  id text primary key,
  label text not null unique,
  link_generation integer not null default 1,
  version integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists incidents (
  id text primary key,
  customer_id text not null,
  n integer not null,
  title text not null,
  kind text not null check (kind in ('critical', 'security')),
  time_zone text not null,
  contacts text not null,
  status text not null check (status in ('open', 'resolved')),
  opened_at bigint not null,
  opened_by text not null,
  resolved_at bigint,
  version integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null,
  unique (customer_id, n)
);
create table if not exists incident_updates (
  id text primary key,
  incident_id text not null,
  n integer not null,
  found text not null,
  doing_now text not null,
  estimate_at bigint,
  final integer not null default 0 check (final in (0, 1)),
  author_kind text not null check (author_kind in ('engineer', 'support_agent')),
  author_ref text not null,
  posted_at bigint not null,
  unique (incident_id, n)
);
create table if not exists incident_keys (
  id text primary key,
  key_hash text,
  rotated_at bigint,
  rotated_by text,
  version integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);
insert into incident_keys (id, key_hash, created_at, updated_at)
  values ('current', null, 0, 0) on conflict (id) do nothing;
`;
