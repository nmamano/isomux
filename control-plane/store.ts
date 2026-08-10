// The durable state behind the driver: instances, provider assets, typed
// operations, attention and the audit log.
//
// SQLite is the engine for this slice; the deployed provisioner runs managed
// Postgres. That port is meant to be mechanical, so the SQL here is constrained
// rather than idiomatic:
//
//   - times are INTEGER milliseconds since the epoch, never a date type;
//   - booleans are 0/1 INTEGER;
//   - JSON travels as an already-serialised TEXT PARAMETER. No json() calls, no
//     jsonb, nothing the other engine spells differently;
//   - no INSERT OR REPLACE, no rowid tricks, no AUTOINCREMENT. The audit log's
//     event id comes from a `sequences` row bumped in the same transaction,
//     which is the same statement on both engines;
//   - every mutation is ONE statement carrying a version predicate.
//
// Durability is not decoration here: `create_intents` is the latch that stops us
// buying a box twice, so the database opens WAL with synchronous=FULL and a
// commit is fsynced before it returns.
//
// EVERY METHOD THAT TOUCHES THE DATABASE IS ASYNC, including the readers, even
// though bun:sqlite answers synchronously. The engine behind this class becomes
// Postgres, whose driver cannot answer synchronously at all; flipping the API
// separately from the engine is what keeps that change narrow instead of
// re-touching every caller twice. `now()` and `inTransaction()` stay
// synchronous, because neither reaches the database on either engine.

import { Database } from "bun:sqlite";

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
  value integer not null
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
  attention_raised_at integer,
  acknowledged_at integer,
  acknowledged_by text,
  access_window_expires_at integer,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
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
  next_reconcile_at integer not null,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists operations (
  id text primary key,
  instance_id text not null,
  kind text not null,
  status text not null check (
    status in ('pending', 'running', 'succeeded', 'failed', 'ambiguous')
  ),
  attempt integer not null,
  next_attempt_at integer not null,
  lease_until integer,
  lease_holder text,
  inactivity_deadline_at integer not null,
  absolute_deadline_at integer not null,
  evidence text not null,
  evidence_at integer not null,
  inactivity_flagged integer not null default 0,
  absolute_flagged integer not null default 0,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
);
create unique index if not exists operations_one_active
  on operations (instance_id, kind)
  where status in ('pending', 'running', 'ambiguous');
create table if not exists create_intents (
  intent_id text primary key,
  state text not null check (
    state in ('intended', 'created', 'rejected', 'ambiguous')
  ),
  latched_at integer not null,
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
  raised_at integer not null,
  cleared_at integer,
  acknowledged_at integer,
  acknowledged_by text,
  version integer not null default 1
);
create unique index if not exists attention_reasons_open
  on attention_reasons (instance_id, source_op_id, reason)
  where cleared_at is null;
create table if not exists audit_events (
  seq integer primary key,
  ts integer not null,
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
  created_at integer not null,
  updated_at integer not null
);
create unique index if not exists accounts_email on accounts (email);
create table if not exists subscriptions (
  id text primary key,
  account_id text not null,
  instance_id text,
  stripe_customer_id text not null,
  status text not null,
  current_period_end integer,
  cancel_at_period_end integer not null default 0,
  -- Slice 5, and all three are STRIPE-OWNED like the columns above them.
  -- ended_at is the instant service actually ended, and it is the cancellation
  -- timeline's anchor: measured 2026-08-10 on API 2026-07-29.dahlia, a terminal
  -- subscription carries it and it equals the item period end exactly. The
  -- period end is a PROJECTION until then; ended_at is the proven fact.
  -- cancellation_reason is the discriminator between a customer cancellation
  -- ("cancellation_requested") and a dunning one ("payment_failed", observed
  -- 2026-08-09) - the two walk completely different machines.
  ended_at integer,
  canceled_at integer,
  cancellation_reason text,
  discount_percent_off integer,
  discount_coupon_id text,
  discount_ends_at integer,
  ever_full_discount integer not null default 0,
  latest_invoice_id text,
  payment_failures integer not null default 0,
  exhaustion_observed_at integer,
  coupon_grace_until integer,
  episode_id text,
  episode_state text not null default 'none' check (
    episode_state in ('none', 'open', 'coupon_hold', 'suspension_requested')
  ),
  last_event_id text,
  last_event_created integer,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  created integer not null,
  received_at integer not null,
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
  checked_at integer,
  next_check_at integer not null,
  claim_until integer,
  claim_holder text,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists name_reservations (
  name text primary key,
  id text not null unique,
  account_id text not null unique,
  instance_id text not null,
  plan text not null,
  coupon_id text,
  version integer not null,
  created_at integer not null,
  updated_at integer not null
);
`;

/**
 * Indexes over columns THIS build added, created after the column check rather
 * than with the tables.
 *
 * An index names a column, so creating one on a database that predates the
 * column fails with a raw SQLite error - which is precisely the "fails
 * somewhere in the middle" outcome the check below exists to replace with a
 * sentence naming the file. Order is the fix: refuse by name first, index
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

export class Store {
  private depth = 0;

  /** Inert on purpose: it assigns fields and touches nothing. Opening is
   * `Store.open`, so there is no path to a Store that skipped the schema
   * check. */
  private constructor(
    readonly file: string,
    readonly now: Clock,
    private readonly db: Database,
  ) {}

  /**
   * Open the database and bring the schema up.
   *
   * The order below is the contract, not an implementation detail: the pragmas
   * come before any statement that writes, the column check comes before the
   * indexes (an index names a column, so creating one on an older database
   * fails with a raw engine error instead of the sentence that names the file),
   * and the sequence seed comes last.
   *
   * A failure at any step CLOSES THE HANDLE and rethrows the original error
   * unwrapped. A half-opened Store must not escape: every caller of this class
   * is entitled to assume the schema check has run.
   */
  static async open(
    file: string,
    now: Clock = () => Date.now(),
  ): Promise<Store> {
    const db = new Database(file, { create: true });
    const store = new Store(file, now, db);
    try {
      // A commit that has not reached the disk is not a latch. WAL plus
      // synchronous=FULL is what makes "the row exists" survive the machine.
      await store.sqlRun("pragma journal_mode = wal");
      await store.sqlRun("pragma synchronous = full");
      await store.sqlRun("pragma busy_timeout = 5000");
      await store.sqlRun(SCHEMA);
      await store.assertSchemaIsCurrent();
      await store.sqlRun(LATE_INDEXES);
      await store.sqlRun(
        "insert into sequences (name, value) select 'audit', 0 " +
          "where not exists (select 1 from sequences where name = 'audit')",
      );
    } catch (err) {
      try {
        db.close();
      } catch {
        // A handle that will not close says nothing about why the open failed,
        // and the original error describes that better than this one would.
      }
      throw err;
    }
    return store;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ------------------------------------------------------- raw statements
  //
  // The escape hatch, for the handful of callers whose SQL does not fit a typed
  // method - the create latch's INSERT, the name reservation, the billing
  // tables. Deliberately ugly names so `grep sql[A-Z]` finds every one of them,
  // and the web app's boundary test forbids them outright.
  //
  // They exist so that NOTHING outside this file holds an engine handle: `db` is
  // private, so the whole codebase reaches the database through this class and
  // the engine can be replaced underneath it.

  async sqlAll<T>(sql: string, args: SqlArgs = []): Promise<T[]> {
    return this.db.query<T, SqlArgs>(sql).all(...args);
  }

  async sqlGet<T>(sql: string, args: SqlArgs = []): Promise<T | null> {
    return this.db.query<T, SqlArgs>(sql).get(...args) ?? null;
  }

  async sqlRun(sql: string, args: SqlArgs = []): Promise<void> {
    this.db.run(sql, args);
  }

  /**
   * Refuse to run on a database written before this slice.
   *
   * `create table if not exists` is silent about a table that exists with the
   * WRONG columns, so an older development database would open cleanly and then
   * fail somewhere in the middle of a provisioning run with a raw SQLite error.
   * Failing at open, by name, is the difference between "move this file aside"
   * and a debugging session.
   *
   * It guards COLUMNS, and only columns. A table this build adds outright -
   * `name_reservations` - cannot be listed here and would be pointless if it
   * were: SCHEMA runs `create table if not exists` first, so by the time this
   * check reads `pragma table_info`, the table exists with every column. Nor
   * does it need guarding. An older database simply gains an empty reservations
   * table, and an empty one is not ambiguous state - nothing was signed up
   * before this build existed.
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
    ];
    for (const [table, column] of required) {
      const cols = (
        await this.sqlAll<{ name: string }>(`pragma table_info(${table})`)
      ).map((c) => c.name);
      if (cols.length > 0 && !cols.includes(column)) {
        throw new Error(
          `the database at ${this.file} predates this version of the control ` +
            `plane: ${table} has no ${column} column. Move it aside and let a ` +
            `fresh one be created; there is no migration in this slice.`,
        );
      }
    }
  }

  /**
   * One write transaction, immediate so two writers cannot both start reading
   * and then deadlock on upgrade. Nesting is a programming error rather than a
   * silently-flattened savepoint: every money and attention invariant in this
   * file is stated as "these statements commit together", and a nested call
   * would quietly widen someone else's boundary. The guard holds across an
   * await too, which is the case an async body newly makes reachable.
   *
   * A RULE THIS SLICE IMPOSES, not a property of the engine: a transaction body
   * may await only store calls and the helpers built on them, never remote I/O
   * and never a timer. Under bun:sqlite every store call settles immediately,
   * so a body that keeps to the rule cannot be suspended part-way; a body that
   * broke it would hold `begin immediate` open across a network round trip on
   * the one connection this class owns. Per-transaction connections are the
   * real answer and they arrive with the Postgres engine.
   *
   * The control statements go through `sqlRun` like everything else, so a test
   * that needs to make a COMMIT fail has one seam to patch rather than a
   * private path it cannot reach.
   */
  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.depth > 0) throw new Error("nested transaction");
    this.depth = 1;
    await this.sqlRun("begin immediate");
    try {
      const out = await fn();
      await this.sqlRun("commit");
      return out;
    } catch (err) {
      try {
        await this.sqlRun("rollback");
      } catch {
        // A rollback that cannot run leaves the connection unusable, which the
        // original error already describes better than this one would.
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  inTransaction(): boolean {
    return this.depth > 0;
  }

  // ------------------------------------------------------------- sequences

  /** Portable monotonic id. AUTOINCREMENT is SQLite-only and would break the
   * stated portability rule. */
  async nextSeq(name: string): Promise<number> {
    const row = await this.sqlGet<{ value: number }>(
      "update sequences set value = value + 1 where name = ? returning value",
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
    > & { subscription_state?: string },
  ): Promise<InstanceRow> {
    const ts = this.now();
    await this.sqlRun(
      "insert into instances (id, run_id, name, plan, region, service_state, goal, " +
        "subscription_state, attention_state, access_window_expires_at, version, created_at, updated_at) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?, 'clear', ?, 1, ?, ?)",
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
        ts,
        ts,
      ],
    );
    const made = await this.getInstance(row.id);
    if (!made) throw new Error("instance insert did not land");
    return made;
  }

  async getInstance(id: string): Promise<InstanceRow | null> {
    return this.sqlGet<InstanceRow>("select * from instances where id = ?", [
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
        "run_id" | "service_state" | "goal" | "subscription_state"
      >
    >,
  ): Promise<InstanceRow | null> {
    if ("access_window_expires_at" in patch) {
      throw new Error(
        "the access-window ceiling is written once, with the instance row: it " +
          "cannot be updated, because the box already carries that instant",
      );
    }
    const sets: string[] = [];
    const args: SqlArgs = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      args.push(v);
    }
    sets.push("updated_at = ?");
    args.push(this.now());
    return this.sqlGet<InstanceRow>(
      `update instances set ${sets.join(", ")}, version = version + 1 ` +
        "where id = ? and version = ? returning *",
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
        "version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
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
    return this.sqlGet<AssetRow>("select * from provider_assets where id = ?", [
      id,
    ]);
  }

  async assetForInstance(instanceId: string): Promise<AssetRow | null> {
    return this.sqlGet<AssetRow>(
      "select * from provider_assets where instance_id = ? order by created_at limit 1",
      [instanceId],
    );
  }

  async assetsDueForReconcile(now: number): Promise<AssetRow[]> {
    return this.sqlAll<AssetRow>(
      "select * from provider_assets where provider_id is not null " +
        "and next_reconcile_at <= ? order by next_reconcile_at",
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
      sets.push(`${k} = ?`);
      args.push(v);
    }
    sets.push("updated_at = ?");
    args.push(this.now());
    return this.sqlGet<AssetRow>(
      `update provider_assets set ${sets.join(", ")}, version = version + 1 ` +
        "where id = ? and version = ? returning *",
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
        "values (?, ?, ?, ?, 0, ?, null, null, ?, ?, ?, ?, 0, 0, 1, ?, ?)",
      [
        row.id,
        row.instance_id,
        row.kind,
        row.status ?? "pending",
        row.next_attempt_at ?? ts,
        row.inactivity_deadline_at,
        row.absolute_deadline_at,
        // Constraint from review: serialise here and bind as TEXT. A json()
        // call would be SQLite-specific and break the portability rule above.
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
    return this.sqlGet<OperationRow>("select * from operations where id = ?", [
      id,
    ]);
  }

  async operationsFor(instanceId: string): Promise<OperationRow[]> {
    return this.sqlAll<OperationRow>(
      "select * from operations where instance_id = ? order by created_at",
      [instanceId],
    );
  }

  async activeOperation(
    instanceId: string,
    kind: string,
  ): Promise<OperationRow | null> {
    return this.sqlGet<OperationRow>(
      "select * from operations where instance_id = ? and kind = ? " +
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
        "and next_attempt_at <= ? and (lease_until is null or lease_until <= ?) " +
        "order by next_attempt_at limit ?",
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
      "update operations set lease_until = ?, lease_holder = ?, status = " +
        "case when status = 'pending' then 'running' else status end, " +
        "version = version + 1, updated_at = ? " +
        "where id = ? and version = ? and (lease_until is null or lease_until <= ?) " +
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
      "update operations set lease_until = ?, version = version + 1, updated_at = ? " +
        "where id = ? and version = ? and lease_holder = ? returning *",
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
      sets.push(`${k} = ?`);
      args.push(
        k === "evidence"
          ? JSON.stringify(v ?? {})
          : (v as string | number | null),
      );
    }
    sets.push("updated_at = ?");
    args.push(this.now());
    return this.sqlGet<OperationRow>(
      `update operations set ${sets.join(", ")}, version = version + 1 ` +
        "where id = ? and version = ? and lease_holder = ? returning *",
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
        `updated_at = ? where id = ? and version = ? and ${column} = 0 ` +
        "and (lease_until is null or lease_until <= ?) returning *",
      [now, id, expectedVersion, now],
    );
  }

  // -------------------------------------------------------------- intents

  async getIntent(intentId: string): Promise<IntentRow | null> {
    return this.sqlGet<IntentRow>(
      "select * from create_intents where intent_id = ?",
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
      sets.push(`${k} = ?`);
      args.push(v);
    }
    return this.sqlGet<IntentRow>(
      `update create_intents set ${sets.join(", ")}, version = version + 1 ` +
        "where intent_id = ? and version = ? returning *",
      [...args, intentId, expectedVersion],
    );
  }

  // ------------------------------------------------------------ liveness

  async getLiveness(instanceId: string): Promise<LivenessRow | null> {
    return this.sqlGet<LivenessRow>(
      "select * from instance_liveness where instance_id = ?",
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
    await this.sqlRun(
      "insert into instance_liveness (instance_id, rung, strikes, checked_at, " +
        "next_check_at, claim_until, claim_holder, version, created_at, updated_at) " +
        "select ?, 'unknown', 0, null, ?, null, null, 1, ?, ? " +
        "where not exists (select 1 from instance_liveness where instance_id = ?)",
      [instanceId, dueAt, ts, ts, instanceId],
    );
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
      "update instance_liveness set claim_until = ?, claim_holder = ?, " +
        "version = version + 1, updated_at = ? where instance_id = ? " +
        "and next_check_at <= ? and (claim_until is null or claim_until <= ?) " +
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
      "update instance_liveness set rung = ?, strikes = ?, checked_at = ?, " +
        "next_check_at = ?, claim_until = null, claim_holder = null, " +
        "version = version + 1, updated_at = ? where instance_id = ? " +
        "and version = ? and claim_holder = ? returning *",
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
        "values (?, ?, ?, ?, ?, ?, ?, ?)",
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
      "select * from attention_reasons where instance_id = ? and cleared_at is null " +
        "order by raised_at",
      [instanceId],
    );
  }

  async allReasons(instanceId: string): Promise<AttentionReasonRow[]> {
    return this.sqlAll<AttentionReasonRow>(
      "select * from attention_reasons where instance_id = ? order by raised_at",
      [instanceId],
    );
  }

  async insertReason(row: Omit<AttentionReasonRow, "version">): Promise<void> {
    await this.sqlRun(
      "insert into attention_reasons (id, instance_id, source_op_id, reason_class, reason, " +
        "severity, raised_at, cleared_at, acknowledged_at, acknowledged_by, version) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
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
      "update attention_reasons set cleared_at = ?, version = version + 1 " +
        "where id = ? and version = ? and cleared_at is null returning *",
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
        "update attention_reasons set acknowledged_at = ?, acknowledged_by = ?, " +
          "version = version + 1 where id = ? and version = ? and cleared_at is null " +
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
        "select * from attention_reasons where id = ?",
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
          "acknowledged_by = null, version = version + 1, updated_at = ? " +
          "where id = ? and version = ? returning *",
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
      "update instances set attention_state = 'needs_operator', attention_reason = ?, " +
        "attention_severity = ?, attention_raised_at = ?, acknowledged_at = ?, " +
        "acknowledged_by = ?, version = version + 1, updated_at = ? " +
        "where id = ? and version = ? returning *",
      [worst.reason, worst.severity, worst.raised_at, ackedAt, ackedBy],
    );
  }
}
