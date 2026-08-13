// The durable state behind the driver: instances, provider assets, typed
// operations, attention and the audit log.
//
// POSTGRES IS THE ENGINE, under both Bun and Node. The driver is `pg`, chosen
// because it is the one that runs on both: the deployed shape is a Next app
// under Node and a provisioner that may be either, and a Bun-only driver would
// put the store back where the port found it.
//
// The SQL stays constrained rather than idiomatic, for the same reason it was
// before - it is the part of this file that a second engine would have to
// agree with:
//
//   - times are BIGINT milliseconds since the epoch, never a date type. Bigint
//     because a ms epoch does not fit `integer`: the unported schema answers
//     22003 the moment one is bound. The driver is configured to hand int8
//     back as a JS number, which is safe because a ms epoch is far below
//     2^53;
//   - booleans are 0/1 integers;
//   - JSON travels as an already-serialised TEXT PARAMETER. No json() calls, no
//     jsonb, nothing another engine spells differently;
//   - no upserts, no rowid tricks, no identity columns. The audit log's event
//     id comes from a `sequences` row bumped in the same transaction;
//   - every mutation is ONE statement carrying a version predicate.
//
// Durability is not decoration here: `create_intents` is the latch that stops
// us buying a box twice, so `synchronous_commit` is left at its default `on`
// and nothing in this codebase turns it off. A commit that has not reached the
// disk is not a latch.
//
// EVERY METHOD THAT TOUCHES THE DATABASE IS ASYNC, including the readers.
// `now()` and `inTransaction()` stay synchronous, because neither reaches the
// database.

import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";

export type Clock = () => number;

/** What a statement may be bound to. Deliberately narrow: times are integers,
 * booleans are 0/1, and JSON arrives already serialised. */
export type SqlArgs = (string | number | null)[];

/** Identifies a leaseholder's claim on a row: only this holder, at this
 * version, may write. Produced by the lease/headroom check immediately before
 * acting, never carried over from an earlier read. */
export interface Fence {
  id: string;
  version: number;
  holder: string;
}

export type ServiceState =
  | "provisioning"
  | "live"
  | "suspended"
  | "deprovisioned";

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "ambiguous";

/** Statuses that hold the one-active slot for an (instance, kind) pair. */
export const ACTIVE_STATUSES: OperationStatus[] = [
  "pending",
  "running",
  "ambiguous",
];

export type Severity = "info" | "warning" | "critical";

/**
 * What CONDITION an attention row is about, so that clearing can be about the
 * condition rather than about whichever operation happened to raise it.
 *
 * Keying only on the source operation is what let evidence progress erase a
 * failed revocation: the operation was making progress, the revocation still had
 * not happened.
 */
export type ReasonClass =
  | "inactivity_deadline"
  | "absolute_deadline"
  | "operation_condition";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

export interface InstanceRow {
  id: string;
  run_id: string | null;
  name: string;
  plan: string;
  region: string;
  service_state: ServiceState;
  goal: string;
  subscription_state: string;
  attention_state: "clear" | "needs_operator";
  attention_reason: string | null;
  attention_severity: Severity | null;
  attention_raised_at: number | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  access_window_expires_at: number | null;
  customer_ssh_key: string | null;
  customer_ssh_key_fingerprint: string | null;
  ssh_login_user: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface AssetRow {
  id: string;
  instance_id: string;
  provider: string;
  provider_id: string | null;
  intent_id: string | null;
  asset_state: string;
  ipv4: string | null;
  service_ends_at: string | null;
  host_key_fingerprint: string | null;
  next_reconcile_at: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface OperationRow {
  id: string;
  instance_id: string;
  kind: string;
  status: OperationStatus;
  attempt: number;
  next_attempt_at: number;
  lease_until: number | null;
  lease_holder: string | null;
  inactivity_deadline_at: number;
  absolute_deadline_at: number;
  evidence: string;
  evidence_at: number;
  /** Flagged separately, because a crossed ABSOLUTE ceiling stays crossed while
   * an inactivity flag is cleared by the next piece of evidence. One column
   * would make the absolute condition flap. */
  inactivity_flagged: number;
  absolute_flagged: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface IntentRow {
  intent_id: string;
  state: "intended" | "created" | "rejected" | "ambiguous";
  latched_at: number;
  plan: string;
  region: string;
  provider_id: string | null;
  reason: string | null;
  version: number;
}

export interface AttentionReasonRow {
  id: string;
  instance_id: string;
  source_op_id: string;
  reason_class: ReasonClass;
  reason: string;
  severity: Severity;
  raised_at: number;
  cleared_at: number | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  version: number;
}

/**
 * Where an office is on the probe ladder, and how many consecutive checks have
 * failed.
 *
 * `strikes` is a COUNT, not a flag, because the design's threshold is three
 * consecutive failures and a single flap is not an outage. It is persisted
 * rather than recomputed because there is nothing to recompute it from: a probe
 * leaves no other trace.
 *
 * `next_check_at` plus `claim_until`/`claim_holder` are what stop two
 * overlapping ticks probing the same office and counting one outage twice. The
 * claim is taken by the same UPDATE that tests whether the row is due, so there
 * is no read-then-act window between the two.
 */
export interface LivenessRow {
  instance_id: string;
  rung: string;
  strikes: number;
  checked_at: number | null;
  next_check_at: number;
  claim_until: number | null;
  claim_holder: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface AuditRow {
  seq: number;
  ts: number;
  actor: string;
  instance_id: string | null;
  action: string;
  target: string;
  outcome: string;
  detail: string | null;
}

/**
 * EVERY TABLE `SCHEMA` CREATES, and the ONE list of them.
 *
 * It lives beside the statements that create them because three things have to
 * agree about this roster and a second copy is how they stop agreeing: the
 * open-time check that refuses a database of the wrong shape, the bootstrap's
 * schema-ready and zero-user-data evidence, and the grant matrix's sweeps.
 * `bootstrap.ts` re-exports it as `EXPECTED_TABLES` rather than keeping its own.
 *
 * These are literals from this file and never input, which is why callers may
 * interpolate them into a count query without a quoting helper.
 */
export const PRODUCT_TABLES = [
  "accounts",
  "attention_reasons",
  "audit_events",
  "create_intents",
  "instance_liveness",
  "instances",
  "name_reservations",
  "operations",
  "provider_assets",
  "schema_meta",
  "sequences",
  "stripe_events",
  "subscriptions",
] as const;

// `source_op_id` is NOT NULL with an empty-string sentinel on purpose: NULLs
// compare distinct in a unique index on both engines, so a nullable column would
// let the same reason be raised twice for the same instance.
const SCHEMA = `
create table if not exists schema_meta (
  key text primary key,
  value text not null
);
create table if not exists sequences (
  name text primary key,
  value bigint not null
);
create table if not exists instances (
  id text primary key,
  run_id text,
  name text not null,
  plan text not null,
  region text not null,
  service_state text not null check (
    service_state in ('provisioning', 'live', 'suspended', 'deprovisioned')
  ),
  goal text not null check (
    goal in ('first_contact', 'installed', 'live', 'handed_off')
  ),
  subscription_state text not null default 'none',
  attention_state text not null default 'clear' check (
    attention_state in ('clear', 'needs_operator')
  ),
  attention_reason text,
  attention_severity text check (
    attention_severity is null or attention_severity in ('info', 'warning', 'critical')
  ),
  attention_raised_at bigint,
  acknowledged_at bigint,
  acknowledged_by text,
  access_window_expires_at bigint,
  customer_ssh_key text,
  customer_ssh_key_fingerprint text,
  ssh_login_user text,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists provider_assets (
  id text primary key,
  instance_id text not null,
  provider text not null,
  provider_id text,
  intent_id text,
  asset_state text not null check (
    asset_state in ('none', 'order_pending', 'order_ambiguous', 'active',
                    'cancel_scheduled', 'cancelled', 'absent')
  ),
  ipv4 text,
  service_ends_at text,
  host_key_fingerprint text,
  next_reconcile_at bigint not null,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists operations (
  id text primary key,
  instance_id text not null,
  kind text not null,
  status text not null check (
    status in ('pending', 'running', 'succeeded', 'failed', 'ambiguous')
  ),
  attempt integer not null,
  next_attempt_at bigint not null,
  lease_until bigint,
  lease_holder text,
  inactivity_deadline_at bigint not null,
  absolute_deadline_at bigint not null,
  evidence text not null,
  evidence_at bigint not null,
  inactivity_flagged integer not null default 0,
  absolute_flagged integer not null default 0,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists operations_one_active
  on operations (instance_id, kind)
  where status in ('pending', 'running', 'ambiguous');
create table if not exists create_intents (
  intent_id text primary key,
  state text not null check (
    state in ('intended', 'created', 'rejected', 'ambiguous')
  ),
  latched_at bigint not null,
  plan text not null,
  region text not null,
  provider_id text,
  reason text,
  version integer not null
);
create table if not exists attention_reasons (
  id text primary key,
  instance_id text not null,
  source_op_id text not null default '',
  reason_class text not null check (
    reason_class in ('inactivity_deadline', 'absolute_deadline', 'operation_condition')
  ),
  reason text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  raised_at bigint not null,
  cleared_at bigint,
  acknowledged_at bigint,
  acknowledged_by text,
  version integer not null default 1
);
create unique index if not exists attention_reasons_open
  on attention_reasons (instance_id, source_op_id, reason)
  where cleared_at is null;
create table if not exists audit_events (
  seq bigint primary key,
  ts bigint not null,
  actor text not null,
  instance_id text,
  action text not null,
  target text not null,
  outcome text not null,
  detail text
);
-- Billing (slice 3). Two column families with DIFFERENT WRITERS, which is what
-- keeps the design's "webhooks are the only writer of subscription state"
-- literally true rather than roughly true:
--   STRIPE-OWNED (status, current_period_end, cancel_at_period_end, the three
--   discount columns, ever_full_discount, latest_invoice_id) are written only by
--   webhook reconciliation, from a freshly fetched Stripe object.
--   OURS (payment_failures, exhaustion_observed_at, coupon_grace_until,
--   episode_id, episode_state) is dunning bookkeeping. Only reconciliation and
--   the coupon-hold deadline tick touch it.
-- last_event_id / last_event_created are EVIDENCE. Nothing reads them to decide
-- whether to apply an event: ordering is settled by re-fetching the object,
-- because Stripe timestamps have one-second resolution and two same-second
-- snapshots would otherwise regress each other.
-- is_operator (slice 5) is the ops floor's ONLY authority. A column rather than a
-- hardcoded email, because an email is a display string that changes and a
-- deployment cannot audit who holds a constant. It is written by the operator
-- CLI and by nothing else: no sign-in path, no web route and no environment
-- variable touches it, which is what makes "sign-in cannot self-assign" a
-- property of the writer set rather than of a check somebody could forget.
create table if not exists accounts (
  id text primary key,
  email text not null,
  google_subject text,
  stripe_customer_id text,
  is_operator integer not null default 0,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists accounts_email on accounts (email);
create table if not exists subscriptions (
  id text primary key,
  account_id text not null,
  instance_id text,
  stripe_customer_id text not null,
  status text not null,
  current_period_end bigint,
  cancel_at_period_end integer not null default 0,
  -- Slice 5, and all three are STRIPE-OWNED like the columns above them.
  -- ended_at is the instant service actually ended, and it is the cancellation
  -- timeline's anchor: measured 2026-08-10 on API 2026-07-29.dahlia, a terminal
  -- subscription carries it and it equals the item period end exactly. The
  -- period end is a PROJECTION until then; ended_at is the proven fact.
  -- cancellation_reason is the discriminator between a customer cancellation
  -- ("cancellation_requested") and a dunning one ("payment_failed", observed
  -- 2026-08-09) - the two walk completely different machines.
  ended_at bigint,
  canceled_at bigint,
  cancellation_reason text,
  discount_percent_off integer,
  discount_coupon_id text,
  discount_ends_at bigint,
  ever_full_discount integer not null default 0,
  latest_invoice_id text,
  payment_failures integer not null default 0,
  exhaustion_observed_at bigint,
  coupon_grace_until bigint,
  episode_id text,
  episode_state text not null default 'none' check (
    episode_state in ('none', 'open', 'coupon_hold', 'suspension_requested')
  ),
  last_event_id text,
  last_event_created bigint,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  created bigint not null,
  received_at bigint not null,
  subscription_id text,
  outcome text not null,
  detail text
);
-- Signup (slice 4a). The office name is unique across accounts, and THIS TABLE
-- IS WHERE THAT IS DECIDED: name is the primary key, so a second account taking
-- a name is refused by a failed INSERT rather than by a SELECT in front of one.
-- Two connections can both read "absent" in the same instant; only one can
-- insert.
--
-- id is the durable identity everything derived hangs off - the instance id and
-- both Stripe idempotency keys are computed from it once, at insert, and read
-- back from the row on every retry. Deriving them from a timestamp instead
-- would make a future release-and-reissue path depend on two reservations never
-- sharing a millisecond.
--
-- Nothing writes this row after the insert in this slice. version and
-- updated_at are carried for consistency with every other table here, and have
-- no writer yet: an abandoned checkout stays held, and releasing a name is
-- slice-5 work with its own ruling. A named state column was considered and
-- dropped for exactly that reason - a state nobody transitions is a claim the
-- code cannot keep.
--
-- (No backticks anywhere in this string: SCHEMA is a template literal, and one
-- would end it. Same mechanism as the install.sh heredoc defect.)
-- account_id is UNIQUE: the design puts more than one box per account outside
-- the MVP, so "one office per account" is a database constraint rather than a
-- check somebody could forget. Two connections reserving different names for
-- one account are separated here, not by a SELECT in front of the insert.
-- Liveness (slice 4b). A NEW TABLE, which is why it needs no migration and no
-- entry in the column check below: an older database gains an empty one, and an
-- office with no row has simply never been probed - which is not ambiguous
-- state, it is the absence of a reading.
create table if not exists instance_liveness (
  instance_id text primary key,
  rung text not null,
  strikes integer not null default 0,
  checked_at bigint,
  next_check_at bigint not null,
  claim_until bigint,
  claim_holder text,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists name_reservations (
  name text primary key,
  id text not null unique,
  account_id text not null unique,
  instance_id text not null,
  plan text not null,
  coupon_id text,
  version integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
`;

/**
 * Indexes over columns THIS build added, created after the column check rather
 * than with the tables.
 *
 * An index names a column, so creating one on a database that predates the
 * column fails with a raw engine error - which is precisely the "fails
 * somewhere in the middle" outcome the check below exists to replace with a
 * sentence naming the database. Order is the fix: refuse by name first, index
 * after.
 */
const LATE_INDEXES = `
-- One Google identity, one account. Partial rather than plain because
-- google_subject is null for every account created by the CLI or by a dev
-- sign-in, and NULLs compare distinct on both engines - a plain unique index
-- would permit exactly one of them.
create unique index if not exists accounts_google_subject
  on accounts (google_subject) where google_subject is not null;
`;

/**
 * How long a statement, a connect and an abandoned transaction may take.
 *
 * Measured on this schema, an ordinary statement is under a millisecond, so
 * thirty seconds is not a budget for slow SQL - it is the bound on a wedged row
 * lock, which is the only way a statement here can take real time. The
 * idle-in-transaction bound is the matching one for a holder that died with
 * `begin` open: without it, its locks outlive it until someone notices.
 *
 * The connect bound is shorter and points at a person: a control plane whose
 * database is unreachable must say so in seconds rather than hang.
 */
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * What one process may hold open against the database.
 *
 * Optional, and absent everywhere but the web app: a CLI is one short-lived
 * command and the tick loop is one process on a box we operate, so `pg`'s own
 * defaults are the right answer for both. The web app is the caller that has to
 * say a number out loud, because its process count is the platform's decision
 * rather than ours - see the comment over its constants.
 */
export interface PoolLimits {
  /** Connections this process may hold at once. */
  max: number;
  /** How long an unused connection is kept before it is dropped, ms. */
  idleTimeoutMillis: number;
}

/** Postgres OID 20, int8. */
const INT8_OID = 20;

/**
 * Times are ms epochs in `bigint` columns, and `pg` hands bigint back as a
 * STRING by default - which would turn every timestamp into a string the
 * moment it crossed the driver, silently, since a string compares and
 * serialises without complaining.
 *
 * The parser is attached to OUR POOL rather than installed with
 * `pg.types.setTypeParser`, which is process-global: a second pg user in the
 * same process (a Next app, a script) must not have its int8 reads changed by
 * this class opening. Null stays null; a ms epoch is far below 2^53, so Number
 * is exact.
 */
const TYPES: PoolConfig["types"] = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === INT8_OID
      ? (value: string | null) => (value === null ? null : Number(value))
      : pg.types.getTypeParser(oid, format),
};

/**
 * One open transaction, and WHOSE it is.
 *
 * The store no longer owns a single connection, so "am I in a transaction" is a
 * question about the CALLING FLOW rather than about the process. The frame
 * travels in async context, which is what routes a statement issued inside a
 * transaction body to that transaction's own connection and everything else to
 * the pool.
 *
 * `store` is part of the frame because two Stores are two databases: a
 * statement on one must never be routed onto the other's checked-out client,
 * and a transaction on a DIFFERENT store is not nesting - it cannot widen this
 * store's boundary. `parent` keeps that chain visible.
 */
interface TxFrame {
  store: Store;
  client: PoolClient;
  parent: TxFrame | null;
  /** Names savepoints apart, so nested or serial recovery scopes cannot
   * release each other's. */
  savepoints: number;
  /** Set when the connection can no longer be reasoned about - a savepoint
   * rollback that failed - or when Postgres turned our COMMIT into a ROLLBACK.
   * Either way the transaction must not report success. */
  failed: Error | null;
}

const TX_CONTEXT = new AsyncLocalStorage<TxFrame>();

/**
 * Read a transaction's failure through a call.
 *
 * Both checks below are live: `sqlRun("commit")` can set the field BETWEEN
 * them, which is the whole point of the second one. Reading the property
 * directly would let the type checker carry the first check's narrowing past
 * the commit and call the second one dead.
 */
function txFailure(frame: TxFrame): Error | null {
  return frame.failed;
}

/** Postgres SQLSTATE 23505, unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Did this error come from a uniqueness rule the database enforces?
 *
 * ONE COPY, exported, because the callers that ask are the ones where a wrong
 * answer is silent: a name reservation that reads a real failure as "taken"
 * refuses a customer their own name, and one that reads a CHECK violation as a
 * duplicate turns a bug into a shrug. Postgres separates them - 23505 is
 * uniqueness, 23514 is a check - so nothing here matches on message text.
 *
 * It covers both the primary key and a unique index, which Postgres reports
 * identically and distinguishes by `constraint`.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === UNIQUE_VIOLATION;
}

/**
 * What to call this database in a sentence.
 *
 * A FIXED STRING, naming the configuration SOURCE rather than anything derived
 * from the configured value. The value used to be a file path, which could be
 * printed; it is now a credential, and a credential has no safe abbreviation.
 * Stripping the password is not enough - measured 2026-08-11, the host carries
 * a Neon endpoint id, the role travels in the driver's own 28P01 message, and
 * every one of those is a fragment of a DSN. An operator who has to act needs
 * to know WHERE the value is configured, and that is a constant.
 */
export const DATABASE_NAME = "the database named by CONTROL_PLANE_DB";

/**
 * The two bounds this build states as guarantees, as `options` tokens.
 *
 * They used to travel as pg pool options, which the driver sends as protocol
 * startup fields. Measured 2026-08-11: the local Postgres applies those and
 * NEON SILENTLY IGNORES THEM - `current_setting('statement_timeout')` came back
 * `30s` locally and `0` on Neon's direct endpoint, with no error and no
 * warning. A bound that is quietly absent in the only deployment target is not
 * a bound, and the README argues these two cap a wedged row lock and a holder
 * that died with `begin` open.
 *
 * The same values DO apply when they travel in the `options` startup parameter,
 * which is the channel the test DSNs already use for `search_path` (measured
 * the same day, both engines). So the store BUILDS the connection string it
 * uses rather than trusting whoever wrote the DSN, and `assertBoundsInEffect`
 * reads them back: a provider that swallows `options` too is caught at open
 * instead of during an incident.
 */
export const GOVERNED_SETTINGS: [string, string][] = [
  // Seconds, because that is the unit `current_setting` answers in: the
  // read-back compares the engine's own rendering, so asking in milliseconds
  // would fail a comparison against a value that is actually correct.
  ["statement_timeout", `${STATEMENT_TIMEOUT_MS / 1000}s`],
  [
    "idle_in_transaction_session_timeout",
    `${IDLE_IN_TRANSACTION_TIMEOUT_MS / 1000}s`,
  ],
];

/**
 * Merge our two bounds into a DSN's `options`, AUTHORITATIVELY.
 *
 * Every token that sets either governed name is dropped first - in both the
 * `-c name=value` and the `--name=value` form, and however many copies there
 * are - and ours are appended last. Unrelated tokens (`-c search_path=...`, the
 * one the test harness depends on) are preserved in order. A caller who writes
 * a different statement_timeout into CONTROL_PLANE_DB does not get it: this is
 * the store's own guarantee, not a default it offers.
 */
export function withGovernedOptions(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can reason about. Handing it back unchanged lets the driver
    // produce the error, which is a better one than anything invented here.
    return url;
  }
  const governed = new Set(GOVERNED_SETTINGS.map(([name]) => name));
  const kept: string[] = [];
  const existing = parsed.searchParams.get("options") ?? "";
  const tokens = existing.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // `-c name=value` arrives either as one token or as two.
    if (token === "-c") {
      const next = tokens[i + 1] ?? "";
      i++;
      if (!governed.has(next.split("=")[0])) kept.push("-c", next);
      continue;
    }
    const named = token.startsWith("--")
      ? token.slice(2)
      : token.startsWith("-c")
        ? token.slice(2)
        : null;
    if (named !== null && governed.has(named.split("=")[0])) continue;
    kept.push(token);
  }
  for (const [name, value] of GOVERNED_SETTINGS)
    kept.push("-c", `${name}=${value}`);
  parsed.searchParams.set("options", kept.join(" "));
  return parsed.toString();
}

/**
 * Every fragment of a DSN, so an error can be scrubbed of all of them.
 *
 * Password, role, host (which carries the endpoint id), PORT, database name,
 * every query parameter NAME and VALUE - `options` included, and each token
 * inside a value - and the whole string. NO LENGTH EXEMPTION: an earlier
 * version skipped anything under four characters, which is precisely how a
 * short role, a two-letter database or a port escapes.
 */
function componentsOf(url: string): string[] {
  const out = new Set<string>([url]);
  const add = (value: string | null | undefined): void => {
    if (!value) return;
    out.add(value);
    try {
      out.add(decodeURIComponent(value));
    } catch {
      // A value that is not valid percent-encoding is already covered raw.
    }
    out.add(encodeURIComponent(value));
  };
  try {
    const parsed = new URL(url);
    add(parsed.password);
    add(parsed.username);
    add(parsed.hostname);
    add(parsed.host);
    add(parsed.port);
    // Each label of the host on its own: the leftmost one is the provider's
    // endpoint id and identifies the compute by itself, so a message quoting
    // only that is a leak even though it quotes no whole component.
    //
    // A PURELY NUMERIC label is not a component, and this is the one exclusion
    // in this function. It is not a length rule dressed up: an IPv4 octet
    // identifies nothing on its own, and admitting `0` and `1` from
    // `127.0.0.1` makes EVERY string fail the check - including the SQLSTATE,
    // which is how this was found. A boundary that emits nothing at all is not
    // safer, it is only blinder, and the whole host and the whole DSN remain
    // components either way.
    for (const label of parsed.hostname.split(".")) {
      if (!/^[0-9]+$/.test(label)) add(label);
    }
    add(parsed.pathname.replace(/^\//, ""));
    for (const [name, value] of parsed.searchParams) {
      add(name);
      add(value);
      // A value is itself a list of tokens, and a check against the whole
      // value alone misses a message quoting only the schema out of it.
      for (const token of value.split(/[\s=]+/)) add(token);
    }
  } catch {
    // An unparseable string is still covered whole.
  }
  out.delete("");
  return [...out];
}

/** Does this text contain ANY component of the connection string? */
function leaks(text: string, components: string[]): boolean {
  return components.some((component) => text.includes(component));
}

/**
 * An error carrying nothing derived from the connection string.
 *
 * The NAME tells a reader why the text is thin, where a bare `Error` would look
 * like the driver said something strange.
 */
export class RedactedDatabaseError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "RedactedDatabaseError";
  }
}

/** The structured fields a Postgres error carries that are OURS by
 * construction - a table, a column, a constraint are literals in this file.
 * `schema` is deliberately absent: it can be the search_path out of `options`,
 * which is a DSN component. `detail`, `hint` and `where` are absent because
 * they interpolate values. */
const SAFE_FIELDS = [
  "severity",
  "table",
  "column",
  "constraint",
  "routine",
] as const;

/**
 * Sanitize a driver failure BEFORE it can reach anything that prints.
 *
 * THE DRIVER'S FREE-TEXT MESSAGE IS NEVER PASSED THROUGH. Not scrubbed, not
 * checked and forwarded - never copied at all. Two earlier designs tried to
 * keep it and both were wrong: replacing each component substring mangles a
 * diagnostic into holes and cannot handle a one-character role, and skipping
 * short components to avoid that lets a short role, a two-letter database or a
 * port straight out. Forwarding a message that merely LOOKS clean is the same
 * bet with an extra step, and it rests on the component list being exhaustive -
 * which is the assumption that failed when a message quoting only the endpoint
 * id passed a whole-hostname check.
 *
 * What IS emitted: a fixed sentence chosen by error class, plus the structured
 * fields in SAFE_FIELDS, which are literals of ours rather than provider text.
 * Those still go through the component check, as a second line rather than the
 * first. The stack is rebuilt from `at ...` frames with a sanitized header,
 * because a stack's first line is the driver's message and copying one whole
 * would smuggle the free text past everything above.
 *
 * The consequence is worth stating rather than hiding: an ordinary SQL failure
 * now reads `the database refused a statement (SQLSTATE 23505)
 * constraint=operations_pkey table=operations` instead of the engine's prose.
 * That is a real debugging cost, deliberately paid - the alternative is a
 * boundary whose safety depends on a list of substrings staying complete.
 *
 * Two measurements make a class allowlist impossible too (2026-08-11): a bad
 * password answers SQLSTATE 28P01 with `password authentication failed for user
 * '<role>'`, so a legitimate SQLSTATE carries the role, and a refused port
 * answers ECONNREFUSED with the address.
 *
 * NO CAUSE IS ATTACHED. A cause is exactly how the original message comes back,
 * through any logger that walks the chain.
 */
export function redactConnectionDetails(err: unknown, url: string): Error {
  const components = componentsOf(url);
  const safe = (text: unknown): string | null =>
    typeof text === "string" && text.length > 0 && !leaks(text, components)
      ? text
      : null;

  const rawCode = (err as { code?: string } | null)?.code;
  const code = safe(rawCode) ?? undefined;
  // A SQLSTATE is five characters of the engine's own vocabulary; anything else
  // (ECONNREFUSED, ENOTFOUND, a TLS code, nothing at all) came from the socket.
  const isStatement = code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  const parts = [
    isStatement
      ? `the database refused a statement (SQLSTATE ${code})`
      : `${DATABASE_NAME} could not be reached` +
        (code === undefined ? "" : ` (${code})`),
  ];
  for (const field of SAFE_FIELDS) {
    const value = safe((err as Record<string, unknown> | null)?.[field]);
    if (value) parts.push(`${field}=${value}`);
  }
  const message = parts.join(" ");

  const sanitized = new RedactedDatabaseError(message, code);

  // THE STACK IS REBUILT FROM FRAMES, never copied whole. A stack's FIRST LINE
  // is `Error: <the driver's own message>`, so retaining a stack that merely
  // passed a component check would have carried the driver's free text across
  // this boundary through the back door - and made safety depend on
  // `componentsOf` being exhaustive after all. The header is discarded
  // unconditionally and replaced with the sanitized one; only `at ...` frames
  // are considered, and they are kept only if EVERY one of them is clean, so a
  // single suspect frame drops the lot rather than being filtered out quietly.
  const frames =
    err instanceof Error && typeof err.stack === "string"
      ? err.stack.split("\n").filter((line) => /^\s*at\s/.test(line))
      : [];
  const header = `${sanitized.name}: ${message}`;
  sanitized.stack =
    frames.length > 0 && frames.every((frame) => safe(frame) !== null)
      ? [header, ...frames].join("\n")
      : header;
  return sanitized;
}

export class Store {
  private closed = false;

  /** Inert on purpose: it assigns fields and touches nothing. Opening is
   * `Store.open`, so there is no path to a Store that skipped the schema
   * check. */
  private constructor(
    readonly url: string,
    readonly now: Clock,
    private readonly pool: Pool,
  ) {}

  /** What to call this database in a sentence. Fixed: see DATABASE_NAME. */
  describe(): string {
    return DATABASE_NAME;
  }

  /** This flow's open transaction on THIS store, if it has one. */
  private frame(): TxFrame | null {
    for (
      let f = TX_CONTEXT.getStore() ?? null;
      f !== null;
      f = f.parent ?? null
    ) {
      if (f.store === this) return f;
    }
    return null;
  }

  /**
   * Open the database and bring the schema up.
   *
   * The order below is the contract, not an implementation detail: the column
   * check comes before the indexes (an index names a column, so creating one on
   * an older database fails with a raw engine error instead of the sentence
   * that names the database), and the sequence seed comes last.
   *
   * A failure at any step CLOSES THE POOL and rethrows the original error
   * unwrapped. A half-opened Store must not escape: every caller of this class
   * is entitled to assume the schema check has run.
   */
  static async open(
    url: string,
    now: Clock = () => Date.now(),
    limits?: PoolLimits,
  ): Promise<Store> {
    const store = await Store.connect(url, now, limits);
    try {
      await store.sqlRun(SCHEMA);
      await store.assertSchemaIsCurrent();
      await store.sqlRun(LATE_INDEXES);
      await store.sqlRun(
        "insert into sequences (name, value) select 'audit', 0 " +
          "where not exists (select 1 from sequences where name = 'audit')",
      );
    } catch (err) {
      await store.discard();
      throw err;
    }
    return store;
  }

  /**
   * Open a database this process may USE but must not build.
   *
   * The two deployed components - the web tier and the provisioner - reach a
   * database that a bootstrap already prepared, and they hold a role that is
   * granted rows rather than the schema. That is not a convenience: measured
   * 2026-08-11, a role with USAGE and full DML still cannot run `create table
   * if not exists` on a table that already exists, because Postgres checks
   * CREATE on the schema during parse analysis and never reaches the
   * IF NOT EXISTS skip. So a runtime process that runs the schema statements
   * cannot be a least-privileged one, and the cheaper half of that trade is to
   * stop running them.
   *
   * IT WRITES NOTHING. No schema, no index, no audit seed - the seed is
   * ASSERTED instead, so a database that was never bootstrapped fails here
   * rather than at the first event that needs a sequence. A runtime process
   * migrating the database it connects to is a habit this build no longer has:
   * bringing a database up is `Store.open`, run by an operator's own role.
   */
  static async openRuntime(
    url: string,
    now: Clock = () => Date.now(),
    limits?: PoolLimits,
  ): Promise<Store> {
    const store = await Store.connect(url, now, limits);
    try {
      await store.assertSchemaIsCurrent();
      const seed = await store.sqlGet<{ name: string }>(
        "select name from sequences where name = 'audit'",
      );
      if (!seed) {
        throw new Error(
          `${DATABASE_NAME} has no audit sequence, so it has not been ` +
            `bootstrapped. A runtime process reads and writes rows; bringing a ` +
            `database up is a separate step run by an operator's own role.`,
        );
      }
    } catch (err) {
      await store.discard();
      throw err;
    }
    return store;
  }

  /**
   * Connect, and prove the two bounds are in effect - by whichever route this
   * database is supposed to deliver them.
   *
   * THE ROUTE IS READ FROM THE ENGINE, NOT FROM A CALLER. A session on a
   * managed branch says so itself (`neon.branch_id` is present on every Neon
   * session and on nothing else), and on that path the bounds MUST come from
   * the role: `rolconfig` must carry exactly the governed pair and the engine
   * must report both. There is no fallback there, and that absence is the
   * point - a fallback would answer a reverted `ALTER ROLE` by quietly
   * reinstating the client-side mechanism, which is the posture the deployment
   * moved away from, and nothing would look wrong.
   *
   * Everywhere else - a local container, CI - the older mechanism stands
   * unchanged: if the bounds are already in effect the session is kept, and
   * otherwise the pool is rebuilt with `withGovernedOptions` and the answer is
   * read back. A contributor's `bun test` needs no setup step it did not need
   * before.
   *
   * The first connection is a READ ONLY one either way, and it is the only
   * session that exists before the bounds are proved.
   */
  private static async connect(
    url: string,
    now: Clock,
    limits?: PoolLimits,
  ): Promise<Store> {
    const build = (connectionString: string): Pool => {
      const pool = new pg.Pool({
        connectionString,
        types: TYPES,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        ...(limits ?? {}),
      });
      // A pool emits an error when an IDLE connection dies with nobody awaiting
      // it - a server restart, a network drop. Unhandled, that is a
      // process-level crash on an event nothing was waiting for; the pool
      // discards the client and the next checkout makes a new one.
      pool.on("error", () => {});
      return pool;
    };

    let store = new Store(url, now, build(url));
    try {
      const managed = await store.onManagedBranch();
      if (managed) {
        await store.assertBoundsAreRoleConfiguration();
        await store.assertBoundsInEffect();
        return store;
      }
      if (await store.boundsAlreadyInEffect()) return store;
    } catch (err) {
      await store.discard();
      throw err;
    }

    // Unmanaged and ungoverned: the store builds the connection string it uses,
    // exactly as it did before role configuration existed.
    await store.discard();
    store = new Store(url, now, build(withGovernedOptions(url)));
    try {
      await store.assertBoundsInEffect();
    } catch (err) {
      await store.discard();
      throw err;
    }
    return store;
  }

  /** Close a pool that is being abandoned. A pool that will not close says
   * nothing about why the open failed, and the original error describes that
   * better than this one would. */
  private async discard(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      // Deliberately swallowed - see above.
    }
  }

  /**
   * Close the pool.
   *
   * IDEMPOTENT, which the engine handle was not: several callers close in a
   * `finally` and again in a test's teardown, and under a pool the second call
   * would reject rather than being harmless. Only a close AFTER A SUCCESSFUL
   * one is a no-op - a first close that fails is reported, and leaves the store
   * closeable again.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.pool.end();
    this.closed = true;
  }

  // ------------------------------------------------------- raw statements
  //
  // The escape hatch, for the handful of callers whose SQL does not fit a typed
  // method - the create latch's INSERT, the name reservation, the billing
  // tables. Deliberately ugly names so `grep sql[A-Z]` finds every one of them,
  // and the web app's boundary test forbids them outright.
  //
  // They exist so that NOTHING outside this file holds an engine handle: `pool`
  // is private, so the whole codebase reaches the database through this class
  // and the engine can be replaced underneath it.
  //
  // All three route the same way: inside a transaction body the statement goes
  // to THAT transaction's checked-out connection, and outside one it goes to
  // the pool. That routing is the whole reason the transaction boundary
  // comments in this file still describe the wire: two transactions cannot
  // interleave onto one connection, because neither can reach the other's.

  private async query<T>(sql: string, args: SqlArgs): Promise<T[]> {
    const frame = this.frame();
    const on: Pick<PoolClient, "query"> = frame?.client ?? this.pool;
    // Arguments are passed ONLY when there are some. A parameter list, even an
    // empty one, puts the driver on the extended protocol, which refuses more
    // than one statement per message - and `SCHEMA` is deliberately one
    // multi-statement round trip.
    // THE BOUNDARY. Every statement in this class passes here, so this is where
    // a driver error stops being the driver's object and becomes one of ours:
    // scrubbed of every fragment of the connection string, carrying the code
    // and no cause.
    let answer;
    try {
      answer =
        args.length > 0
          ? await on.query<Record<string, unknown>>(sql, args)
          : await on.query<Record<string, unknown>>(sql);
    } catch (err) {
      throw redactConnectionDetails(err, this.url);
    }
    // A multi-statement simple query answers with one result per statement.
    const results = Array.isArray(answer) ? answer : [answer];
    const last = results[results.length - 1];

    // A COMMIT ISSUED ON AN ABORTED TRANSACTION SUCCEEDS AND COMMITS NOTHING:
    // Postgres answers it with the command tag ROLLBACK. Without this check a
    // caller that swallowed a statement error would be told its writes landed,
    // which is the quietest way this engine can lose data. The tag is read
    // here, where every statement passes, rather than from a return value -
    // `sqlRun` stays void, so the failed-COMMIT injection seam still works by
    // patching it.
    if (
      frame &&
      /^\s*commit\s*;?\s*$/i.test(sql) &&
      last?.command !== "COMMIT"
    ) {
      frame.failed = new Error(
        `the transaction could not commit: Postgres answered COMMIT with ` +
          `${last?.command ?? "nothing"}, which means an earlier statement ` +
          `failed and its error was swallowed. Nothing in it was written.`,
      );
    }
    return (last?.rows ?? []) as T[];
  }

  async sqlAll<T>(sql: string, args: SqlArgs = []): Promise<T[]> {
    return this.query<T>(sql, args);
  }

  async sqlGet<T>(sql: string, args: SqlArgs = []): Promise<T | null> {
    return (await this.query<T>(sql, args))[0] ?? null;
  }

  async sqlRun(sql: string, args: SqlArgs = []): Promise<void> {
    await this.query<never>(sql, args);
  }

  /**
   * Refuse to run on a database written before this slice.
   *
   * `create table if not exists` is silent about a table that exists with the
   * WRONG columns, so an older development database would open cleanly and then
   * fail somewhere in the middle of a provisioning run with a raw engine error.
   * Failing at open, by name, is the difference between "move this database
   * aside" and a debugging session.
   *
   * It guards COLUMNS, and only columns. A table this build adds outright -
   * `name_reservations` - cannot be listed here and would be pointless if it
   * were: SCHEMA runs `create table if not exists` first, so by the time this
   * check reads the catalog, the table exists with every column. Nor does it
   * need guarding. An older database simply gains an empty reservations table,
   * and an empty one is not ambiguous state - nothing was signed up before this
   * build existed.
   */
  /**
   * Refuse to hand back a Store whose stated bounds are not actually in effect.
   *
   * FAIL CLOSED, and first of the open steps, because everything after it
   * assumes a wedged lock cannot hold a connection for ever. The engine's own
   * answer is the evidence: a provider that accepts `options` and ignores it
   * looks identical to one that honours it until the day it matters.
   */
  /**
   * Is this session served by a managed branch?
   *
   * `neon.branch_id` is present on every session of the managed engine this
   * build deploys on and absent everywhere else, so it answers "is this a
   * deployment" without any configuration being trusted. This is the ONLY place
   * the store knows anything about the provider, and it is deliberately a
   * presence test rather than a value: what the branch IS remains `boot.ts`'s
   * question, and the id is never read here, compared here or printed here.
   */
  private async onManagedBranch(): Promise<boolean> {
    const row = await this.sqlGet<{ v: string | null }>(
      "select current_setting('neon.branch_id', true) as v",
    );
    return (row?.v ?? "").length > 0;
  }

  /** Are both bounds already what this build asks for, without being asked? */
  private async boundsAlreadyInEffect(): Promise<boolean> {
    for (const [name, expected] of GOVERNED_SETTINGS) {
      const row = await this.sqlGet<{ value: string | null }>(
        `select current_setting('${name}', true) as value`,
      );
      if (row?.value !== expected) return false;
    }
    return true;
  }

  /**
   * Refuse a managed database whose ROLE does not carry the bounds.
   *
   * Reading them back from the session is not enough on this path: a session
   * can report the right answer because somebody put it in the connection
   * string, and the deployment's guarantee is that every session of that role
   * inherits it whether or not the caller asked. So the catalog is checked as
   * well as the session, and EXACTLY - an extra governed entry, a missing one
   * or a changed value all refuse, because "close enough" in a posture that
   * exists to be a number is not a posture.
   */
  private async assertBoundsAreRoleConfiguration(): Promise<void> {
    const row = await this.sqlGet<{ config: string[] | null }>(
      "select coalesce(rolconfig, '{}') as config from pg_roles " +
        "where rolname = current_user",
    );
    const config = row?.config ?? null;
    if (config === null) {
      throw new Error(
        `${DATABASE_NAME} did not report this role's configuration, so the ` +
          `bounds this build guarantees cannot be shown to come from the role. ` +
          `The store refuses to open rather than run on a bound it cannot ` +
          `account for.`,
      );
    }
    const want = GOVERNED_SETTINGS.map(([name, value]) => `${name}=${value}`);
    const same =
      config.length === want.length && want.every((e) => config.includes(e));
    if (!same) {
      throw new Error(
        `${DATABASE_NAME} is a managed database whose role does not carry ` +
          `exactly the ${want.length} governed settings this build guarantees. ` +
          `On a managed engine those bounds come from the role, so every ` +
          `session inherits them; a session that has them only because the ` +
          `caller asked is not the guarantee. The store refuses to open.`,
      );
    }
  }

  private async assertBoundsInEffect(): Promise<void> {
    for (const [name, expected] of GOVERNED_SETTINGS) {
      const row = await this.sqlGet<{ value: string }>(
        `select current_setting('${name}') as value`,
      );
      if (row?.value !== expected) {
        throw new Error(
          `${DATABASE_NAME} did not apply ${name}: this build asks for ` +
            `${expected} and the engine reports ${row?.value ?? "nothing"}. ` +
            `That bound is a guarantee this build makes, so the store refuses ` +
            `to open rather than run without it. Some managed providers drop ` +
            `connection options they do not recognise.`,
        );
      }
    }
  }

  /**
   * Is the database this session opens the shape this build expects?
   *
   * IT READS pg_class RATHER THAN information_schema, and that is a posture fix
   * rather than a style choice. `information_schema` shows a role only the
   * objects it holds a privilege on: measured 2026-08-12 on Postgres 18, a role
   * with NO privilege on a table sees ZERO of its columns there while
   * `pg_class`/`pg_attribute` show all of them and a SELECT is still refused
   * 42501. The check therefore used to be silently VOID on exactly the
   * deployment it matters for - a least-privileged runtime role skipped every
   * table it was not granted (`stripe_events` for both roles, and every table
   * outside each role's matrix), because "zero columns" was read as "not this
   * build's table" and waved through.
   *
   * The same clause hid a worse case for every caller: a table that is not
   * there at all also returns zero columns, so a MISSING TABLE passed. The
   * catalog read below cannot express that - the relation has to be there, and
   * every required column has to be a live one.
   *
   * EXISTENCE IS ASKED OF THE WHOLE ROSTER, not of the tables that happen to
   * carry a version column. The required-column list below names five tables;
   * checking existence only for those would leave eight - `name_reservations`,
   * `provider_assets`, `create_intents`, `instance_liveness`, `audit_events`,
   * `instances`, `schema_meta` and `sequences` - able to be absent while a
   * runtime process booted cleanly and failed at first use. That is exactly the
   * shape of the 2026-08-12 incident (a boot that worked and an invite path
   * that did not), so the roster is `PRODUCT_TABLES` and the column checks run
   * on top of it (reviewer finding, 2026-08-12).
   *
   * EVERY UNCERTAIN ANSWER REFUSES. A missing relation, a missing column, a
   * name that resolves to more than one relation, and a catalog row this build
   * cannot read all raise. There is no branch here that continues on a question
   * it could not answer, which is the property the old `cols.length > 0` guard
   * gave away.
   *
   * IT WRITES NOTHING, which is what lets `openRuntime` call it: two catalog
   * reads on the session's own resolution schema, and no DDL.
   */
  private async assertSchemaIsCurrent(): Promise<void> {
    const required: [string, string][] = [
      ["operations", "inactivity_flagged"],
      ["operations", "absolute_flagged"],
      ["attention_reasons", "reason_class"],
      ["attention_reasons", "version"],
      ["accounts", "stripe_customer_id"],
      ["accounts", "google_subject"],
      ["accounts", "is_operator"],
      ["subscriptions", "episode_state"],
      ["subscriptions", "exhaustion_observed_at"],
      ["subscriptions", "ended_at"],
      ["subscriptions", "canceled_at"],
      ["subscriptions", "cancellation_reason"],
      ["stripe_events", "type"],
      ["instances", "customer_ssh_key"],
      ["instances", "customer_ssh_key_fingerprint"],
      ["instances", "ssh_login_user"],
    ];
    // THE WHOLE ROSTER, not the tables the column list happens to name.
    const tables: readonly string[] = PRODUCT_TABLES;
    // ORDINARY NAMED RELATIONS ONLY - 'r' and 'p'. A view, an index or a
    // composite type carrying one of these names is not the table the
    // statements will write to, and treating one as though it were is how a
    // check passes against something that cannot hold a row.
    //
    // Scoped to `current_schema()`, so it reads the same relation an
    // unqualified statement from this session will.
    const rows = await this.sqlAll<{
      table: unknown;
      relation: unknown;
      column: unknown;
    }>(
      "select c.relname as table, c.oid::text as relation, a.attname as column " +
        "from pg_class c " +
        "join pg_namespace n on n.oid = c.relnamespace " +
        "left join pg_attribute a on a.attrelid = c.oid " +
        "  and a.attnum > 0 and not a.attisdropped " +
        "where n.nspname = current_schema() " +
        // The list travels as ONE parameter and is split by the engine:
        // `SqlArgs` is scalars by design, and the alternative - interpolating
        // thirteen names - would put identifier building back into this file
        // for no gain. The names are literals above and carry no comma.
        "and c.relkind in ('r', 'p') " +
        "and c.relname = any(string_to_array($1, ','))",
      [tables.join(",")],
    );

    const relations = new Map<string, Set<string>>();
    const columns = new Map<string, Set<string>>();
    for (const row of rows) {
      // A row whose own identity cannot be read is an answer this build does
      // not get to interpret. It refuses rather than skipping the row, which
      // would silently shrink the set being checked.
      if (typeof row.table !== "string" || typeof row.relation !== "string") {
        throw new Error(
          `the catalog of the database at ${this.describe()} did not come ` +
            `back in a shape this build can read, so the schema it carries ` +
            `cannot be established. The store refuses to open.`,
        );
      }
      let oids = relations.get(row.table);
      if (!oids) relations.set(row.table, (oids = new Set()));
      oids.add(row.relation);
      if (typeof row.column === "string") {
        let names = columns.get(row.table);
        if (!names) columns.set(row.table, (names = new Set()));
        names.add(row.column);
      }
    }

    for (const table of tables) {
      const oids = relations.get(table);
      if (!oids || oids.size === 0) {
        throw new Error(
          `the database at ${this.describe()} has no ${table} table in the ` +
            `schema this session resolves names in, so it is not a database ` +
            `this build can run against. Bringing a database up is a separate ` +
            `step; the store refuses to open.`,
        );
      }
      if (oids.size > 1) {
        throw new Error(
          `the database at ${this.describe()} answers with more than one ` +
            `${table} relation in one schema, so which one a statement would ` +
            `reach is not decidable. The store refuses to open.`,
        );
      }
    }
    for (const [table, column] of required) {
      if (!columns.get(table)?.has(column)) {
        throw new Error(
          `the database at ${this.describe()} predates this version of the ` +
            `control plane: ${table} has no ${column} column. Apply this ` +
            `build's owner-role migration before starting a runtime process.`,
        );
      }
    }
  }

  /**
   * One write transaction, ON ITS OWN CONNECTION.
   *
   * The connection is checked out for the body's whole life, so every statement
   * the body issues - through the async context, not through a handle the
   * caller has to thread - lands inside these `begin`/`commit` brackets and
   * inside no others. That is what makes the transaction boundary comments in
   * this file true on the wire rather than true by convention, and it is why
   * the previous engine's rule ("a body may await only store calls, never
   * remote I/O and never a timer") is gone: a body that waits now holds one
   * connection out of the pool, which is a cost, not a correctness problem.
   *
   * Nesting is still a programming error rather than a silently-flattened
   * savepoint: every money and attention invariant in this file is stated as
   * "these statements commit together", and a nested call would quietly widen
   * someone else's boundary. A transaction on a DIFFERENT store is not nesting
   * and is allowed - it is a second database on a second connection, and it
   * cannot widen this one's boundary.
   *
   * Two CONCURRENT flows are also no longer an error, which is the point of the
   * engine: they take a connection each and commit independently. The old depth
   * counter could not tell that case from nesting, and refused both.
   *
   * `begin`, `commit` and `rollback` go through `sqlRun` like everything else,
   * so a test that needs to make a COMMIT fail has one seam to patch rather
   * than a private path it cannot reach.
   */
  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.frame()) throw new Error("nested transaction");
    // The second seam: a checkout is where a CONNECT failure surfaces, and a
    // connect failure is the one that carries the address and the role.
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw redactConnectionDetails(err, this.url);
    }
    const frame: TxFrame = {
      store: this,
      client,
      parent: TX_CONTEXT.getStore() ?? null,
      savepoints: 0,
      failed: null,
    };
    // Set only when the ROLLBACK itself failed. A body that threw and rolled
    // back cleanly leaves a perfectly good connection, and discarding one on
    // every refused CAS would make every error path pay for a new one; a
    // rollback that could not run leaves the session in a state nobody can
    // describe, and that one must not go back into the pool.
    let poisoned: Error | undefined;
    try {
      // Everything, `begin` included, runs INSIDE the context: otherwise the
      // control statements would go to the pool and open a transaction on a
      // connection nobody is holding.
      return await TX_CONTEXT.run(frame, async () => {
        await this.sqlRun("begin");
        try {
          const out = await fn();
          // A body that returned normally on a connection we can no longer
          // reason about must not reach COMMIT.
          const beforeCommit = txFailure(frame);
          if (beforeCommit) throw beforeCommit;
          await this.sqlRun("commit");
          // And a COMMIT that Postgres turned into a ROLLBACK is a failure
          // whatever the body believed.
          const atCommit = txFailure(frame);
          if (atCommit) throw atCommit;
          return out;
        } catch (err) {
          try {
            await this.sqlRun("rollback");
          } catch (rollbackErr) {
            poisoned =
              rollbackErr instanceof Error
                ? rollbackErr
                : new Error(String(rollbackErr));
          }
          throw err;
        }
      });
    } finally {
      // `frame.failed` covers the same class from the other direction: a
      // savepoint rollback that could not run leaves a connection nobody can
      // describe. A COMMIT that came back ROLLBACK does not strictly need
      // discarding, and is discarded anyway - it is a bug path, and one
      // connection is a cheaper thing to be wrong about.
      client.release(poisoned ?? frame.failed ?? undefined);
    }
  }

  inTransaction(): boolean {
    return this.frame() !== null;
  }

  /**
   * Run a statement whose failure the caller INTENDS TO RECOVER FROM, without
   * losing the transaction around it.
   *
   * Postgres aborts the whole transaction on any statement error: every later
   * statement answers 25P02 until a rollback. The previous engine did not, and
   * two rules in this codebase are built on catching a failure and carrying on
   * - the name reservation, where the INSERT IS the uniqueness decision and the
   * conflicting row is read back inside the same transaction, and the
   * one-active operation index, where the refusal becomes a customer-facing
   * "already in progress". A savepoint is what keeps those exactly as they
   * were.
   *
   * DELIBERATELY EXPLICIT, one site at a time. Wrapping every statement in a
   * savepoint would make "this failure is expected" the default, and the
   * failures that are not expected are the ones that must take the transaction
   * down with them.
   *
   * Outside a transaction it just runs `fn`: a failed statement in autocommit
   * aborts nothing there is to abort.
   */
  async recoverable<T>(fn: () => Promise<T>): Promise<T> {
    const frame = this.frame();
    if (!frame) return fn();
    // Named from a counter on the frame, never from anything a caller passed,
    // so nested or serial scopes cannot release each other's.
    const name = `cp_sp_${++frame.savepoints}`;
    await this.sqlRun(`savepoint ${name}`);
    try {
      const out = await fn();
      await this.sqlRun(`release savepoint ${name}`);
      return out;
    } catch (err) {
      try {
        // Back to the instant before the statement, which un-aborts the
        // transaction, and then release: an un-released savepoint would pile up
        // on a retrying caller.
        await this.sqlRun(`rollback to savepoint ${name}`);
        await this.sqlRun(`release savepoint ${name}`);
      } catch (undoErr) {
        // The recovery itself failed, so what state this connection is in is no
        // longer knowable. The ORIGINAL error is what the caller gets - it
        // describes what actually went wrong - but the transaction must not be
        // allowed to commit, and the connection must not go back to the pool.
        frame.failed =
          undoErr instanceof Error ? undoErr : new Error(String(undoErr));
      }
      throw err;
    }
  }

  // ------------------------------------------------------------- sequences

  /** Portable monotonic id. An identity column would tie the audit sequence to
   * one engine's spelling, and it is bumped in the same transaction as the row
   * it numbers. */
  async nextSeq(name: string): Promise<number> {
    const row = await this.sqlGet<{ value: number }>(
      "update sequences set value = value + 1 where name = $1 returning value",
      [name],
    );
    if (!row) throw new Error(`no sequence named ${name}`);
    return row.value;
  }

  // ------------------------------------------------------------- instances

  async createInstance(
    row: Omit<
      InstanceRow,
      | "version"
      | "created_at"
      | "updated_at"
      | "attention_state"
      | "attention_reason"
      | "attention_severity"
      | "attention_raised_at"
      | "acknowledged_at"
      | "acknowledged_by"
      | "subscription_state"
      | "customer_ssh_key"
      | "customer_ssh_key_fingerprint"
      | "ssh_login_user"
    > & {
      subscription_state?: string;
      customer_ssh_key?: string | null;
      customer_ssh_key_fingerprint?: string | null;
      ssh_login_user?: string | null;
    },
  ): Promise<InstanceRow> {
    const ts = this.now();
    await this.sqlRun(
      "insert into instances (id, run_id, name, plan, region, service_state, goal, " +
        "subscription_state, attention_state, access_window_expires_at, customer_ssh_key, customer_ssh_key_fingerprint, ssh_login_user, version, created_at, updated_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, 'clear', $9, $10, $11, $12, 1, $13, $14)",
      [
        row.id,
        row.run_id,
        row.name,
        row.plan,
        row.region,
        row.service_state,
        row.goal,
        row.subscription_state ?? "none",
        row.access_window_expires_at,
        row.customer_ssh_key ?? null,
        row.customer_ssh_key_fingerprint ?? null,
        row.ssh_login_user ?? null,
        ts,
        ts,
      ],
    );
    const made = await this.getInstance(row.id);
    if (!made) throw new Error("instance insert did not land");
    return made;
  }

  async getInstance(id: string): Promise<InstanceRow | null> {
    return this.sqlGet<InstanceRow>("select * from instances where id = $1", [
      id,
    ]);
  }

  async listInstances(): Promise<InstanceRow[]> {
    return this.sqlAll<InstanceRow>(
      "select * from instances order by created_at",
    );
  }

  /**
   * CAS on the version column. A loser re-reads; it never retries blind.
   *
   * `access_window_expires_at` is deliberately NOT in the patch surface, and is
   * rejected at runtime as well as in the type. It is written once, by
   * `createInstance`, and never again: the box carries that instant in an
   * authorized_keys option and a systemd timer, which we cannot reach
   * afterwards. Leaving it settable here would make the immutability a
   * convention in one caller rather than a property of the store, and any later
   * caller - or a cast - could reopen the race it exists to close.
   */
  async casInstance(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        InstanceRow,
        | "run_id"
        | "service_state"
        | "goal"
        | "subscription_state"
        | "customer_ssh_key"
        | "customer_ssh_key_fingerprint"
        | "ssh_login_user"
      >
    >,
  ): Promise<InstanceRow | null> {
    if ("access_window_expires_at" in patch) {
      throw new Error(
        "the access-window ceiling is written once, with the instance row: it " +
          "cannot be updated, because the box already carries that instant",
      );
    }
    // The patch decides how many parameters there are, so the numbering is
    // built with the list rather than written out: each argument is pushed
    // first, and its 1-based position is what the placeholder names. Same
    // shape in every dynamic statement below.
    const sets: string[] = [];
    const args: SqlArgs = [];
    for (const [k, v] of Object.entries(patch)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(this.now());
    sets.push(`updated_at = $${args.length}`);
    return this.sqlGet<InstanceRow>(
      `update instances set ${sets.join(", ")}, version = version + 1 ` +
        `where id = $${args.length + 1} and version = $${args.length + 2} ` +
        "returning *",
      [...args, id, expectedVersion],
    );
  }

  // --------------------------------------------------------------- assets

  async createAsset(
    row: Omit<AssetRow, "version" | "created_at" | "updated_at">,
  ): Promise<AssetRow> {
    const ts = this.now();
    await this.sqlRun(
      "insert into provider_assets (id, instance_id, provider, provider_id, intent_id, " +
        "asset_state, ipv4, service_ends_at, host_key_fingerprint, next_reconcile_at, " +
        "version, created_at, updated_at) values " +
        "($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12)",
      [
        row.id,
        row.instance_id,
        row.provider,
        row.provider_id,
        row.intent_id,
        row.asset_state,
        row.ipv4,
        row.service_ends_at,
        row.host_key_fingerprint,
        row.next_reconcile_at,
        ts,
        ts,
      ],
    );
    const made = await this.getAsset(row.id);
    if (!made) throw new Error("asset insert did not land");
    return made;
  }

  async getAsset(id: string): Promise<AssetRow | null> {
    return this.sqlGet<AssetRow>(
      "select * from provider_assets where id = $1",
      [id],
    );
  }

  async assetForInstance(instanceId: string): Promise<AssetRow | null> {
    return this.sqlGet<AssetRow>(
      "select * from provider_assets where instance_id = $1 order by created_at limit 1",
      [instanceId],
    );
  }

  async assetsDueForReconcile(now: number): Promise<AssetRow[]> {
    return this.sqlAll<AssetRow>(
      "select * from provider_assets where provider_id is not null " +
        "and next_reconcile_at <= $1 order by next_reconcile_at",
      [now],
    );
  }

  async casAsset(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        AssetRow,
        | "provider_id"
        | "asset_state"
        | "ipv4"
        | "service_ends_at"
        | "host_key_fingerprint"
        | "next_reconcile_at"
      >
    >,
  ): Promise<AssetRow | null> {
    const sets: string[] = [];
    const args: SqlArgs = [];
    for (const [k, v] of Object.entries(patch)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(this.now());
    sets.push(`updated_at = $${args.length}`);
    return this.sqlGet<AssetRow>(
      `update provider_assets set ${sets.join(", ")}, version = version + 1 ` +
        `where id = $${args.length + 1} and version = $${args.length + 2} ` +
        "returning *",
      [...args, id, expectedVersion],
    );
  }

  // ----------------------------------------------------------- operations

  /**
   * Open an operation. The partial unique index is the arbiter: a second active
   * row for the same (instance, kind) is refused by the database, not by a
   * check in front of it.
   */
  async enqueue(row: {
    id: string;
    instance_id: string;
    kind: string;
    status?: OperationStatus;
    next_attempt_at?: number;
    inactivity_deadline_at: number;
    absolute_deadline_at: number;
    evidence?: unknown;
  }): Promise<OperationRow> {
    const ts = this.now();
    await this.sqlRun(
      "insert into operations (id, instance_id, kind, status, attempt, next_attempt_at, " +
        "lease_until, lease_holder, inactivity_deadline_at, absolute_deadline_at, " +
        "evidence, evidence_at, inactivity_flagged, absolute_flagged, version, created_at, updated_at) " +
        "values ($1, $2, $3, $4, 0, $5, null, null, $6, $7, $8, $9, 0, 0, 1, $10, $11)",
      [
        row.id,
        row.instance_id,
        row.kind,
        row.status ?? "pending",
        row.next_attempt_at ?? ts,
        row.inactivity_deadline_at,
        row.absolute_deadline_at,
        // Constraint from review: serialise here and bind as TEXT, so the
        // column stays text on any engine and no driver decides how to encode
        // it.
        JSON.stringify(row.evidence ?? {}),
        ts,
        ts,
        ts,
      ],
    );
    const made = await this.getOperation(row.id);
    if (!made) throw new Error("operation insert did not land");
    return made;
  }

  async getOperation(id: string): Promise<OperationRow | null> {
    return this.sqlGet<OperationRow>("select * from operations where id = $1", [
      id,
    ]);
  }

  async operationsFor(instanceId: string): Promise<OperationRow[]> {
    return this.sqlAll<OperationRow>(
      "select * from operations where instance_id = $1 order by created_at",
      [instanceId],
    );
  }

  async activeOperation(
    instanceId: string,
    kind: string,
  ): Promise<OperationRow | null> {
    return this.sqlGet<OperationRow>(
      "select * from operations where instance_id = $1 and kind = $2 " +
        "and status in ('pending', 'running', 'ambiguous')",
      [instanceId, kind],
    );
  }

  /** Every non-terminal operation, for deadline evaluation. */
  /**
   * Operations that crossed their ABSOLUTE ceiling and have not succeeded.
   *
   * Deliberately NOT a subset of `liveOperations`: a failed operation is the
   * one an operator most needs to see, and it is exactly the row that leaves
   * the live set. Succeeded work is excluded because a step that finished late
   * is history, not an alert.
   */
  async overdueOperations(): Promise<OperationRow[]> {
    return this.sqlAll<OperationRow>(
      "select * from operations where absolute_flagged = 1 and status != 'succeeded' " +
        "order by absolute_deadline_at",
    );
  }

  async liveOperations(): Promise<OperationRow[]> {
    return this.sqlAll<OperationRow>(
      "select * from operations where status in ('pending', 'running', 'ambiguous') " +
        "order by created_at",
    );
  }

  async dueOperations(now: number, limit: number): Promise<OperationRow[]> {
    return this.sqlAll<OperationRow>(
      "select * from operations where status in ('pending', 'running', 'ambiguous') " +
        "and next_attempt_at <= $1 and (lease_until is null or lease_until <= $2) " +
        "order by next_attempt_at limit $3",
      [now, now, limit],
    );
  }

  /**
   * Take the lease by CAS.
   *
   * Both predicates are load-bearing and neither implies the other: the version
   * fences a stale writer, and the lease predicate is what stops a second holder
   * adopting a lease that has not expired. Deliberately no SELECT in front of
   * it - the UPDATE is the arbiter, so two contenders holding the same pre-read
   * version cannot both win.
   */
  async tryLease(
    id: string,
    expectedVersion: number,
    holder: string,
    leaseUntil: number,
    now: number,
  ): Promise<OperationRow | null> {
    return this.sqlGet<OperationRow>(
      "update operations set lease_until = $1, lease_holder = $2, status = " +
        "case when status = 'pending' then 'running' else status end, " +
        "version = version + 1, updated_at = $3 " +
        "where id = $4 and version = $5 and (lease_until is null or lease_until <= $6) " +
        "returning *",
      [leaseUntil, holder, now, id, expectedVersion, now],
    );
  }

  /** Extend a lease we already hold. Fenced by holder AND version. */
  async renewLease(
    fence: Fence,
    leaseUntil: number,
  ): Promise<OperationRow | null> {
    return this.sqlGet<OperationRow>(
      "update operations set lease_until = $1, version = version + 1, updated_at = $2 " +
        "where id = $3 and version = $4 and lease_holder = $5 returning *",
      [leaseUntil, this.now(), fence.id, fence.version, fence.holder],
    );
  }

  /**
   * Any other write to an operation, fenced by holder and version.
   *
   * THERE ARE TWO BOUNDARIES HERE AND THEY ARE NOT THE SAME ONE.
   *
   *   TIME fences the right to BEGIN remote work. `RemoteBudget` caps itself by
   *   `lease_until - LEASE_SAFETY_MS`, so once the lease is spent no call can
   *   start. That is what "only the leaseholder acts" means.
   *
   *   The VERSION/HOLDER token fences whether a late RESULT may be recorded. If
   *   another holder adopted, or a deadline flag landed, or anything else
   *   touched the row, the version has moved and the old result is refused.
   *
   * So an expired holder that nobody has adopted yet may still write down what
   * it did while it legitimately held the lease. Requiring the lease to still be
   * live at write time would discard valid evidence without preventing a single
   * conflicting write - the version predicate already prevents those - and the
   * evidence is often the record of a real remote effect that the next holder
   * would otherwise have to rediscover.
   *
   * A losing holder gets null and must re-read. It must not retry the write.
   */
  async casOperation(
    fence: Fence,
    patch: Partial<{
      status: OperationStatus;
      attempt: number;
      next_attempt_at: number;
      lease_until: number | null;
      lease_holder: string | null;
      inactivity_deadline_at: number;
      absolute_deadline_at: number;
      evidence: unknown;
      evidence_at: number;
      inactivity_flagged: number;
      absolute_flagged: number;
    }>,
  ): Promise<OperationRow | null> {
    const sets: string[] = [];
    const args: SqlArgs = [];
    for (const [k, v] of Object.entries(patch)) {
      args.push(
        k === "evidence"
          ? JSON.stringify(v ?? {})
          : (v as string | number | null),
      );
      sets.push(`${k} = $${args.length}`);
    }
    args.push(this.now());
    sets.push(`updated_at = $${args.length}`);
    return this.sqlGet<OperationRow>(
      `update operations set ${sets.join(", ")}, version = version + 1 ` +
        `where id = $${args.length + 1} and version = $${args.length + 2} ` +
        `and lease_holder = $${args.length + 3} returning *`,
      [...args, fence.id, fence.version, fence.holder],
    );
  }

  /**
   * Mark an operation as having blown ONE of its deadlines. Version CAS,
   * deliberately without a holder predicate: the caller has already established
   * that nobody holds this row, and the version is what makes a concurrent
   * flagger re-read rather than double-raise. It writes no status - a deadline
   * flags, it never concludes.
   *
   * The two deadlines flag separately because they clear differently: new
   * evidence answers an inactivity flag, and nothing except the operation
   * finishing answers a crossed absolute ceiling.
   */
  async flagDeadline(
    id: string,
    expectedVersion: number,
    which: "inactivity" | "absolute",
    now: number = this.now(),
  ): Promise<OperationRow | null> {
    const column =
      which === "absolute" ? "absolute_flagged" : "inactivity_flagged";
    // The LEASE PREDICATE is in the SQL, not in a check the caller made
    // earlier. Reading "unleased" and then flagging is a check-then-act: a
    // holder can lease in between, and the flag would bump the version out from
    // under a fence that is already at a remote seam.
    return this.sqlGet<OperationRow>(
      `update operations set ${column} = 1, version = version + 1, ` +
        `updated_at = $1 where id = $2 and version = $3 and ${column} = 0 ` +
        "and (lease_until is null or lease_until <= $4) returning *",
      [now, id, expectedVersion, now],
    );
  }

  // -------------------------------------------------------------- intents

  async getIntent(intentId: string): Promise<IntentRow | null> {
    return this.sqlGet<IntentRow>(
      "select * from create_intents where intent_id = $1",
      [intentId],
    );
  }

  async listIntents(): Promise<IntentRow[]> {
    return this.sqlAll<IntentRow>(
      "select * from create_intents order by latched_at",
    );
  }

  /**
   * Record what a create turned out to do. It never relaxes the latch: there is
   * no statement anywhere that writes state='intended' except the INSERT in
   * create-latch.ts, so a row can never return to a state that permits a call.
   */
  async casIntent(
    intentId: string,
    expectedVersion: number,
    patch: Partial<Pick<IntentRow, "state" | "provider_id" | "reason">>,
  ): Promise<IntentRow | null> {
    if (patch.state === "intended") {
      throw new Error("an intent may never be returned to the intended state");
    }
    const sets: string[] = [];
    const args: SqlArgs = [];
    for (const [k, v] of Object.entries(patch)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    return this.sqlGet<IntentRow>(
      `update create_intents set ${sets.join(", ")}, version = version + 1 ` +
        `where intent_id = $${args.length + 1} and version = $${args.length + 2} ` +
        "returning *",
      [...args, intentId, expectedVersion],
    );
  }

  // ------------------------------------------------------------ liveness

  async getLiveness(instanceId: string): Promise<LivenessRow | null> {
    return this.sqlGet<LivenessRow>(
      "select * from instance_liveness where instance_id = $1",
      [instanceId],
    );
  }

  /**
   * Create the row if this office has never been probed. Conditional INSERT
   * rather than a SELECT in front of one: two ticks starting together must not
   * both insert, and the primary key is what decides that.
   */
  async ensureLiveness(instanceId: string, dueAt: number): Promise<void> {
    const ts = this.now();
    try {
      await this.recoverable(() =>
        this.sqlRun(
          "insert into instance_liveness (instance_id, rung, strikes, checked_at, " +
            "next_check_at, claim_until, claim_holder, version, created_at, updated_at) " +
            "select $1, 'unknown', 0, null, $2, null, null, 1, $3, $4 " +
            "where not exists (select 1 from instance_liveness where instance_id = $5)",
          [instanceId, dueAt, ts, ts, instanceId],
        ),
      );
    } catch (err) {
      // THE `where not exists` IS NOT THE ARBITER, the primary key is. Under
      // read committed two first probes can both find the row absent in the
      // same instant, and one of them then loses to the key - so the conditional
      // insert is the fast path and this is the race. The previous engine's
      // single writer hid it: the loser re-evaluated its own condition after the
      // winner had committed and quietly did nothing.
      if (!isUniqueViolation(err)) throw err;
      // "Ensure" promises the row EXISTS, not that we made it. Only the row
      // being there discharges that; anything else is somebody else's failure
      // wearing this one's error code.
      if (!(await this.getLiveness(instanceId))) throw err;
    }
  }

  /**
   * Take the right to probe this office, if it is due and nobody else holds it.
   *
   * The due test and the claim are ONE statement on purpose. Reading "due" and
   * then claiming is a check-then-act: two ticks can both read due, both probe,
   * and both count the same failure - which is exactly the double-counted strike
   * this row exists to prevent. A caller that gets null does not probe.
   */
  async claimLiveness(
    instanceId: string,
    holder: string,
    claimUntil: number,
    now: number,
  ): Promise<LivenessRow | null> {
    return this.sqlGet<LivenessRow>(
      "update instance_liveness set claim_until = $1, claim_holder = $2, " +
        "version = version + 1, updated_at = $3 where instance_id = $4 " +
        "and next_check_at <= $5 and (claim_until is null or claim_until <= $6) " +
        "returning *",
      [claimUntil, holder, now, instanceId, now, now],
    );
  }

  /**
   * Write a probe's result, fenced by the version AND the holder that claimed
   * it. A holder that lost its claim writes nothing rather than adding its
   * strike on top of the winner's.
   */
  async recordLiveness(
    instanceId: string,
    expectedVersion: number,
    holder: string,
    patch: { rung: string; strikes: number; checkedAt: number; nextAt: number },
  ): Promise<LivenessRow | null> {
    return this.sqlGet<LivenessRow>(
      "update instance_liveness set rung = $1, strikes = $2, checked_at = $3, " +
        "next_check_at = $4, claim_until = null, claim_holder = null, " +
        "version = version + 1, updated_at = $5 where instance_id = $6 " +
        "and version = $7 and claim_holder = $8 returning *",
      [
        patch.rung,
        patch.strikes,
        patch.checkedAt,
        patch.nextAt,
        this.now(),
        instanceId,
        expectedVersion,
        holder,
      ],
    );
  }

  // ------------------------------------------------------------- audit

  /**
   * Append one classified event. Must run inside a transaction: an audit row is
   * half of a state transition, not a log line that happens to be nearby.
   */
  async appendAudit(
    ev: Omit<AuditRow, "seq" | "ts"> & { ts?: number },
  ): Promise<AuditRow> {
    if (!this.inTransaction()) {
      throw new Error("appendAudit must run inside a transaction");
    }
    const seq = await this.nextSeq("audit");
    const ts = ev.ts ?? this.now();
    await this.sqlRun(
      "insert into audit_events (seq, ts, actor, instance_id, action, target, outcome, detail) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        seq,
        ts,
        ev.actor,
        ev.instance_id,
        ev.action,
        ev.target,
        ev.outcome,
        ev.detail ?? null,
      ],
    );
    return { ...ev, seq, ts, detail: ev.detail ?? null };
  }

  async auditEvents(): Promise<AuditRow[]> {
    return this.sqlAll<AuditRow>("select * from audit_events order by seq");
  }

  // --------------------------------------------------------- attention

  async openReasons(instanceId: string): Promise<AttentionReasonRow[]> {
    return this.sqlAll<AttentionReasonRow>(
      "select * from attention_reasons where instance_id = $1 and cleared_at is null " +
        "order by raised_at",
      [instanceId],
    );
  }

  async allReasons(instanceId: string): Promise<AttentionReasonRow[]> {
    return this.sqlAll<AttentionReasonRow>(
      "select * from attention_reasons where instance_id = $1 order by raised_at",
      [instanceId],
    );
  }

  async insertReason(row: Omit<AttentionReasonRow, "version">): Promise<void> {
    await this.sqlRun(
      "insert into attention_reasons (id, instance_id, source_op_id, reason_class, reason, " +
        "severity, raised_at, cleared_at, acknowledged_at, acknowledged_by, version) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)",
      [
        row.id,
        row.instance_id,
        row.source_op_id,
        row.reason_class,
        row.reason,
        row.severity,
        row.raised_at,
        row.cleared_at,
        row.acknowledged_at,
        row.acknowledged_by,
      ],
    );
  }

  /** Version CAS, like every other transition. A loser re-reads. */
  async clearReason(
    id: string,
    expectedVersion: number,
    at: number,
  ): Promise<AttentionReasonRow | null> {
    return this.sqlGet<AttentionReasonRow>(
      "update attention_reasons set cleared_at = $1, version = version + 1 " +
        "where id = $2 and version = $3 and cleared_at is null returning *",
      [at, id, expectedVersion],
    );
  }

  async acknowledgeReasons(
    instanceId: string,
    at: number,
    by: string,
  ): Promise<number> {
    // Acknowledging is NOT clearing: cleared_at is deliberately untouched, so
    // the instance keeps reporting needs_operator until the condition itself
    // goes away. Each row is a version CAS; a row that moved under us is left
    // for the caller to re-read rather than overwritten.
    const ack = (id: string, version: number) =>
      this.sqlGet<AttentionReasonRow>(
        "update attention_reasons set acknowledged_at = $1, acknowledged_by = $2, " +
          "version = version + 1 where id = $3 and version = $4 and cleared_at is null " +
          "returning *",
        [at, by, id, version],
      );

    let acked = 0;
    for (const row of await this.openReasons(instanceId)) {
      if (row.acknowledged_at !== null) continue;
      if (await ack(row.id, row.version)) {
        acked++;
        continue;
      }
      // A loser RE-READS and decides from current state rather than skipping.
      // The row may have been cleared (nothing to acknowledge), already
      // acknowledged by someone else (nothing to do), or simply moved.
      const fresh = await this.sqlGet<AttentionReasonRow>(
        "select * from attention_reasons where id = $1",
        [row.id],
      );
      if (!fresh || fresh.cleared_at !== null) continue;
      if (fresh.acknowledged_at !== null) continue;
      if (await ack(fresh.id, fresh.version)) acked++;
    }
    return acked;
  }

  /**
   * Rewrite the instance's persisted attention summary from its still-open
   * reasons.
   *
   * The columns are written, not computed at read time - the design wants
   * attention persisted so an operator-facing reason outlives the operation that
   * caused it. What is recomputed is only WHICH open reason the summary names,
   * which is how an installer deadline can never overwrite an open revocation
   * failure: it cannot reach that row, and the summary takes the highest
   * severity among everything still open.
   */
  async refreshAttentionSummary(
    instanceId: string,
    /** The version the CALLER read. Passing it in is what makes this a real
     * compare-and-swap rather than a read-and-write that happens to be inside a
     * transaction: a caller working from a stale copy loses here and has to
     * re-read, instead of silently overwriting whoever won. */
    expectedVersion: number,
  ): Promise<InstanceRow> {
    const open = await this.openReasons(instanceId);
    const inst = await this.getInstance(instanceId);
    if (!inst) throw new Error(`no instance ${instanceId} to summarise`);

    // A version CAS like every other transition. It runs inside a write
    // transaction, so a loser here means the row genuinely moved under us -
    // which must roll the transition back rather than overwrite the winner.
    const write = async (sql: string, args: SqlArgs): Promise<InstanceRow> => {
      const row = await this.sqlGet<InstanceRow>(sql, [
        ...args,
        this.now(),
        instanceId,
        expectedVersion,
      ]);
      if (!row) {
        throw new Error(
          `instance ${instanceId} moved while its attention summary was being ` +
            `written; refusing to overwrite the winner`,
        );
      }
      return row;
    };

    if (open.length === 0) {
      return write(
        "update instances set attention_state = 'clear', attention_reason = null, " +
          "attention_severity = null, attention_raised_at = null, acknowledged_at = null, " +
          "acknowledged_by = null, version = version + 1, updated_at = $1 " +
          "where id = $2 and version = $3 returning *",
        [],
      );
    }
    const worst = open.reduce((a, b) =>
      SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
    );
    // Acknowledged only when EVERY open reason has been seen; a new reason
    // arriving after an ack puts the instance back to unacknowledged.
    const allAcked = open.every((r) => r.acknowledged_at !== null);
    const ackedAt = allAcked
      ? Math.max(...open.map((r) => r.acknowledged_at ?? 0))
      : null;
    const ackedBy = allAcked
      ? (open.find((r) => r.acknowledged_at === ackedAt)?.acknowledged_by ??
        null)
      : null;
    return write(
      "update instances set attention_state = 'needs_operator', attention_reason = $1, " +
        "attention_severity = $2, attention_raised_at = $3, acknowledged_at = $4, " +
        "acknowledged_by = $5, version = version + 1, updated_at = $6 " +
        "where id = $7 and version = $8 returning *",
      [worst.reason, worst.severity, worst.raised_at, ackedAt, ackedBy],
    );
  }
}
