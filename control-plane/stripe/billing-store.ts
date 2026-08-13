// Billing rows: accounts, subscriptions, and the durable event ledger.
//
// These are FUNCTIONS OVER THE SLICE-2 STORE, not a second store. One schema
// owner and one transaction owner, because the whole point of putting billing
// here is that a subscription change, the instance mirror, an attention raise,
// an audit row and a suspension enqueue commit TOGETHER with slice 2's rows -
// they run inside the caller's transaction, on its connection. A separately
// opened store could not give that.
//
// The two setters below are deliberately separate, with disjoint patch types:
//
//   casStripeOwnedSubscription - the cache of Stripe truth. Reconciliation is
//     its only caller, and reconciliation only ever writes from a freshly
//     fetched Stripe object. This is the design's "webhooks are the only writer
//     of subscription state", expressed as a seam rather than as a habit.
//   casEpisodeBookkeeping - our dunning bookkeeping. Reconciliation writes it,
//     and so does the coupon-hold deadline tick, which is the one non-webhook
//     transition the design asks for.
//
// A source-ownership test asserts that split, so a later redirect handler or
// dashboard button cannot quietly become a writer of Stripe truth.

import { isUniqueViolation, type SqlArgs, type Store } from "../store.ts";

export interface AccountRow {
  id: string;
  email: string;
  google_subject: string | null;
  stripe_customer_id: string | null;
  /** 0 or 1. The ops floor's only authority (slice 5). Deliberately NOT in
   * casAccount's patch type: the one writer is operator-admin.ts, so a future
   * caller cannot raise its own privilege through the generic account CAS. */
  is_operator: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export type EpisodeState =
  | "none"
  | "open"
  | "coupon_hold"
  | "suspension_requested";

export interface SubscriptionRow {
  /** The Stripe subscription id. Stripe's identity is the identity: a local id
   * would need a mapping table and could disagree with the thing it caches. */
  id: string;
  account_id: string;
  instance_id: string | null;
  stripe_customer_id: string;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  /**
   * When service actually ENDED, per Stripe. Null while the subscription lives.
   *
   * This is the cancellation timeline's anchor, and it is deliberately not
   * current_period_end: the period end is a projection that moves with the
   * subscription, while ended_at appears once and never changes. Measured
   * 2026-08-10 on API 2026-07-29.dahlia: a terminal subscription carries it and
   * it equals the item period end exactly.
   */
  ended_at: number | null;
  /** When cancellation was REQUESTED. Reverted to null by an un-cancel, so it
   * tracks the current intent rather than the history (measured 2026-08-10). */
  canceled_at: number | null;
  /**
   * cancellation_details.reason. The discriminator between the two completely
   * different machines a cancelled subscription can be in:
   * "cancellation_requested" is the customer's own act and walks the grace ->
   * power_off -> retention -> deprovision timeline; "payment_failed" (observed
   * 2026-08-09) is dunning and walks the suspension ladder, which is resumable.
   */
  cancellation_reason: string | null;
  cancellation_policy: CancellationPolicy;
  discount_percent_off: number | null;
  discount_coupon_id: string | null;
  discount_ends_at: number | null;
  /** Sticky, never unset. "Comped" stays derived from the ACTIVE discount, per
   * the design; this only records that the subscription was once fully
   * discounted, which is what routes a lapse to a human instead of the ladder. */
  ever_full_discount: number;
  latest_invoice_id: string | null;
  payment_failures: number;
  /** When Stripe was authoritatively observed to have given up retrying. Set
   * per episode; cleared with the episode. */
  exhaustion_observed_at: number | null;
  coupon_grace_until: number | null;
  episode_id: string | null;
  episode_state: EpisodeState;
  last_event_id: string | null;
  last_event_created: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export type CancellationPolicy = "legacy" | "launch";

/** What Stripe says. Written only from a fetched object, only by reconciliation. */
export type StripeOwnedPatch = Partial<
  Pick<
    SubscriptionRow,
    | "status"
    | "current_period_end"
    | "cancel_at_period_end"
    | "ended_at"
    | "canceled_at"
    | "cancellation_reason"
    | "discount_percent_off"
    | "discount_coupon_id"
    | "discount_ends_at"
    | "ever_full_discount"
    | "latest_invoice_id"
    | "instance_id"
    | "last_event_id"
    | "last_event_created"
  >
>;

/** Ours. Reconciliation and the coupon-hold tick. */
export type EpisodePatch = Partial<
  Pick<
    SubscriptionRow,
    | "payment_failures"
    | "exhaustion_observed_at"
    | "coupon_grace_until"
    | "episode_id"
    | "episode_state"
  >
>;

/** Ours. Stripe cannot shorten or extend a cancellation promise. */
export type CancellationPolicyPatch = Pick<
  SubscriptionRow,
  "cancellation_policy"
>;

export interface StripeEventRow {
  id: string;
  type: string;
  created: number;
  received_at: number;
  subscription_id: string | null;
  outcome: string;
  detail: string | null;
}

// ---------------------------------------------------------------- accounts

/**
 * The account row for an email, created on first use.
 *
 * An account is NOT subscription state: it is who is buying, and it has to exist
 * before Checkout can carry an id in its metadata. Slice 4 replaces this with
 * Google sign-in; the email uniqueness index is what keeps that migration from
 * finding duplicates.
 */
export async function ensureAccount(
  store: Store,
  args: { id: string; email: string },
): Promise<AccountRow> {
  assertInTx(store, "ensureAccount");
  const existing = await accountByEmail(store, args.email);
  if (existing) return existing;
  const ts = store.now();
  // is_operator is written as 0 EXPLICITLY rather than left to the column
  // default. Every account arrives through here or through a sign-in that calls
  // here, so the literal is the proof that no sign-in path can create a
  // privileged account.
  try {
    await store.recoverable(() =>
      store.sqlRun(
        "insert into accounts (id, email, google_subject, stripe_customer_id, is_operator, " +
          "version, created_at, updated_at) values ($1, $2, null, null, 0, 1, $3, $4)",
        [args.id, args.email, ts, ts],
      ),
    );
  } catch (err) {
    // The read above is a fast path, not the decision: under read committed two
    // callers can both find the address absent and only one of them can insert
    // it. The previous engine serialised writers, so the loser's read happened
    // after the winner's commit and returned the existing account - and that is
    // the outcome preserved here.
    if (!isUniqueViolation(err)) throw err;
    // The EMAIL index is what decides identity, so the winner is read back by
    // address. A collision on the primary key with a different address is a
    // different fact - two accounts fighting over one id - and is not something
    // to answer with somebody else's row.
    const winner = await accountByEmail(store, args.email);
    if (!winner) throw err;
    return winner;
  }
  const made = await getAccount(store, args.id);
  if (!made) throw new Error("account insert did not land");
  return made;
}

export async function getAccount(
  store: Store,
  id: string,
): Promise<AccountRow | null> {
  return store.sqlGet<AccountRow>("select * from accounts where id = $1", [id]);
}

export async function accountByEmail(
  store: Store,
  email: string,
): Promise<AccountRow | null> {
  return store.sqlGet<AccountRow>("select * from accounts where email = $1", [
    email,
  ]);
}

export async function listAccounts(store: Store): Promise<AccountRow[]> {
  return store.sqlAll<AccountRow>("select * from accounts order by created_at");
}

/** Version CAS, like every other transition in this schema. A loser re-reads. */
export async function casAccount(
  store: Store,
  id: string,
  expectedVersion: number,
  patch: Partial<Pick<AccountRow, "google_subject" | "stripe_customer_id">>,
): Promise<AccountRow | null> {
  assertInTx(store, "casAccount");
  return casRow<AccountRow>(
    store,
    "accounts",
    "id",
    id,
    expectedVersion,
    patch,
  );
}

// ----------------------------------------------------------- subscriptions

/**
 * Create the local cache row for a Stripe subscription.
 *
 * Reconciliation is the only caller, and it inserts from a FETCHED subscription
 * object - never from a Checkout redirect and never from an event payload taken
 * as truth.
 */
export async function insertSubscription(
  store: Store,
  row: Omit<
    SubscriptionRow,
    | "version"
    | "created_at"
    | "updated_at"
    | "episode_state"
    | "cancellation_policy"
  > & {
    episode_state?: EpisodeState;
    cancellation_policy?: CancellationPolicy;
  },
): Promise<SubscriptionRow> {
  assertInTx(store, "insertSubscription");
  const ts = store.now();
  await store.sqlRun(
    "insert into subscriptions (id, account_id, instance_id, stripe_customer_id, status, " +
      "current_period_end, cancel_at_period_end, ended_at, canceled_at, cancellation_reason, cancellation_policy, " +
      "discount_percent_off, discount_coupon_id, " +
      "discount_ends_at, ever_full_discount, latest_invoice_id, payment_failures, " +
      "exhaustion_observed_at, coupon_grace_until, episode_id, episode_state, last_event_id, " +
      "last_event_created, version, created_at, updated_at) " +
      "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 1, $24, $25)",
    [
      row.id,
      row.account_id,
      row.instance_id,
      row.stripe_customer_id,
      row.status,
      row.current_period_end,
      row.cancel_at_period_end,
      row.ended_at,
      row.canceled_at,
      row.cancellation_reason,
      row.cancellation_policy ?? "launch",
      row.discount_percent_off,
      row.discount_coupon_id,
      row.discount_ends_at,
      row.ever_full_discount,
      row.latest_invoice_id,
      row.payment_failures,
      row.exhaustion_observed_at,
      row.coupon_grace_until,
      row.episode_id,
      row.episode_state ?? "none",
      row.last_event_id,
      row.last_event_created,
      ts,
      ts,
    ],
  );
  const made = await getSubscription(store, row.id);
  if (!made) throw new Error("subscription insert did not land");
  return made;
}

export async function casCancellationPolicy(
  store: Store,
  id: string,
  expectedVersion: number,
  patch: CancellationPolicyPatch,
): Promise<SubscriptionRow | null> {
  assertInTx(store, "casCancellationPolicy");
  return casRow<SubscriptionRow>(
    store,
    "subscriptions",
    "id",
    id,
    expectedVersion,
    patch,
  );
}

export async function getSubscription(
  store: Store,
  id: string,
): Promise<SubscriptionRow | null> {
  return store.sqlGet<SubscriptionRow>(
    "select * from subscriptions where id = $1",
    [id],
  );
}

export async function listSubscriptions(
  store: Store,
): Promise<SubscriptionRow[]> {
  return store.sqlAll<SubscriptionRow>(
    "select * from subscriptions order by created_at",
  );
}

/** Subscriptions whose coupon-lapse hold has run out. The tick's only query. */
export async function holdsExpiredAt(
  store: Store,
  now: number,
): Promise<SubscriptionRow[]> {
  return store.sqlAll<SubscriptionRow>(
    "select * from subscriptions where episode_state = 'coupon_hold' " +
      "and coupon_grace_until is not null and coupon_grace_until <= $1 " +
      "order by coupon_grace_until",
    [now],
  );
}

/**
 * THE STRIPE-OWNED SETTER. Reconciliation only.
 *
 * If you are reading this because you want to write `status` from somewhere
 * else: that is the thing the design forbids. Fetch the object and reconcile,
 * or leave the row alone.
 */
export async function casStripeOwnedSubscription(
  store: Store,
  id: string,
  expectedVersion: number,
  patch: StripeOwnedPatch,
): Promise<SubscriptionRow | null> {
  assertInTx(store, "casStripeOwnedSubscription");
  return casRow<SubscriptionRow>(
    store,
    "subscriptions",
    "id",
    id,
    expectedVersion,
    patch,
  );
}

/** Our dunning bookkeeping. Reconciliation and the coupon-hold tick. */
export async function casEpisodeBookkeeping(
  store: Store,
  id: string,
  expectedVersion: number,
  patch: EpisodePatch,
): Promise<SubscriptionRow | null> {
  assertInTx(store, "casEpisodeBookkeeping");
  return casRow<SubscriptionRow>(
    store,
    "subscriptions",
    "id",
    id,
    expectedVersion,
    patch,
  );
}

// ------------------------------------------------------------ event ledger

/**
 * Has this event already been applied?
 *
 * Called INSIDE the applying transaction, after the object fetch, because the
 * fetch happens with no transaction open and a concurrent delivery of the same
 * event could have landed in the meantime.
 */
export async function eventSeen(
  store: Store,
  id: string,
): Promise<StripeEventRow | null> {
  return store.sqlGet<StripeEventRow>(
    "select * from stripe_events where id = $1",
    [id],
  );
}

/**
 * Claim an event id. The PRIMARY KEY is the dedupe, and it is claimed in the
 * SAME transaction as the effect: a throw anywhere in the apply rolls the claim
 * back too, so a redelivery of that event still has work to do. A claim written
 * in its own transaction would turn a crash mid-apply into a silently dropped
 * event.
 */
export async function claimEvent(
  store: Store,
  row: Omit<StripeEventRow, "received_at"> & { received_at?: number },
): Promise<StripeEventRow> {
  assertInTx(store, "claimEvent");
  const receivedAt = row.received_at ?? store.now();
  await store.sqlRun(
    "insert into stripe_events (id, type, created, received_at, subscription_id, outcome, detail) " +
      "values ($1, $2, $3, $4, $5, $6, $7)",
    [
      row.id,
      row.type,
      row.created,
      receivedAt,
      row.subscription_id,
      row.outcome,
      row.detail,
    ],
  );
  return { ...row, received_at: receivedAt };
}

export async function listEvents(
  store: Store,
  limit = 50,
): Promise<StripeEventRow[]> {
  return store.sqlAll<StripeEventRow>(
    "select * from stripe_events order by received_at desc limit $1",
    [limit],
  );
}

// ----------------------------------------------------------------- helpers

function assertInTx(store: Store, what: string): void {
  if (!store.inTransaction()) {
    throw new Error(`${what} must run inside a transaction`);
  }
}

/** One statement, version predicate, `returning *`. The same shape slice 2 uses
 * for every row it owns. */
async function casRow<T>(
  store: Store,
  table: string,
  key: string,
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<T | null> {
  const sets: string[] = [];
  const args: SqlArgs = [];
  for (const [k, v] of Object.entries(patch)) {
    args.push(v as string | number | null);
    sets.push(`${k} = $${args.length}`);
  }
  if (sets.length === 0) return null;
  args.push(store.now());
  sets.push(`updated_at = $${args.length}`);
  return store.sqlGet<T>(
    `update ${table} set ${sets.join(", ")}, version = version + 1 ` +
      `where ${key} = $${args.length + 1} and version = $${args.length + 2} returning *`,
    [...args, id, expectedVersion],
  );
}
