// Returning one retained office to the same customer after a terminal
// cancellation. Stripe creates a new subscription; these rows are the durable
// proof that it is allowed to govern the old instance.

import {
  lifecycleOperationId,
  RETENTION_MS,
  poweredOffAtFrom,
} from "./lifecycle.ts";
import { deadlinesFor } from "./operations.ts";
import type { ReservationRow } from "./signup.ts";
import type { OperationRow, Store } from "./store.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";
import { getAccount, type AccountRow } from "./stripe/billing-store.ts";
import { instanceOwnedBy, planById } from "./signup.ts";

export const REINSTATEMENT_CHECKOUT_MS = 30 * 60_000;
export const REINSTATEMENT_REASON = "reinstatement";
export const REFUND_REQUIRED = "reinstatement-paid-refund-required";

export interface ReinstatementAttemptRow {
  id: string;
  account_id: string;
  reservation_id: string;
  instance_id: string;
  closed_subscription_id: string;
  closed_ended_at: number;
  new_subscription_id: string | null;
  checkout_session_id: string | null;
  checkout_generation: number;
  accepted_at: number;
  /** The customer/product boundary: always the old subscription retention end. */
  fence_expires_at: number;
  /** Stripe's separate technical Checkout expiry. Never a lifecycle deadline. */
  stripe_expires_at: number;
  state: "opening" | "pending" | "accepted" | "expired" | "attention";
  version: number;
  created_at: number;
  updated_at: number;
}

export async function attemptById(
  store: Store,
  id: string,
): Promise<ReinstatementAttemptRow | null> {
  return store.sqlGet("select * from reinstatement_attempts where id = $1", [
    id,
  ]);
}

export async function attemptForClosedSubscription(
  store: Store,
  subscriptionId: string,
): Promise<ReinstatementAttemptRow | null> {
  return store.sqlGet(
    "select * from reinstatement_attempts where closed_subscription_id = $1",
    [subscriptionId],
  );
}

/** The one subscription every instance-scoped consumer reads. */
export async function currentSubscriptionForInstance(
  store: Store,
  instanceId: string,
): Promise<SubscriptionRow | null> {
  const accepted = await store.sqlGet<{ new_subscription_id: string }>(
    "select new_subscription_id from reinstatement_attempts " +
      "where instance_id = $1 and state = 'accepted' " +
      "order by accepted_at desc limit 1",
    [instanceId],
  );
  if (accepted?.new_subscription_id) {
    return store.sqlGet("select * from subscriptions where id = $1", [
      accepted.new_subscription_id,
    ]);
  }
  return store.sqlGet(
    "select * from subscriptions where instance_id = $1 order by created_at desc limit 1",
    [instanceId],
  );
}

export type ReinstatementRefusal =
  | "not_cancelled"
  | "too_late"
  | "power_off_not_proven"
  | "not_suspended"
  | "deletion_started"
  | "asset_not_retainable"
  | "ownership_mismatch"
  | "no_customer_access";

export const REINSTATEMENT_REFUSAL_WORDS: Record<ReinstatementRefusal, string> =
  {
    not_cancelled: "This office is not in retained cancellation.",
    too_late:
      "The retention period has ended, so we cannot open a reinstatement payment.",
    power_off_not_proven:
      "The office has not finished powering off safely. Contact support before paying.",
    not_suspended:
      "The retained office is not safely suspended. Contact support before paying.",
    deletion_started:
      "Permanent deletion has already started, so this office cannot be reinstated.",
    asset_not_retainable:
      "The retained server is no longer available for reinstatement.",
    ownership_mismatch:
      "We could not prove that every subscription for this office belongs to your account.",
    no_customer_access:
      "We cannot prove that you can enter this office after it starts. Contact support before paying.",
  };

export type Eligibility =
  | { ok: true; operations: OperationRow[] }
  | { ok: false; code: ReinstatementRefusal; reason: string };

function refusal(code: ReinstatementRefusal): Eligibility {
  return { ok: false, code, reason: REINSTATEMENT_REFUSAL_WORDS[code] };
}

/** Every predicate is read by the transaction that writes the attempt/link. */
export async function checkReinstatementEligibility(
  store: Store,
  args: {
    reservation: ReservationRow;
    closed: SubscriptionRow;
    now: number;
  },
): Promise<Eligibility> {
  const { reservation, closed, now } = args;
  if (
    closed.instance_id !== reservation.instance_id ||
    closed.ended_at === null ||
    closed.cancellation_reason !== "cancellation_requested"
  )
    return refusal("not_cancelled");
  if (now >= closed.ended_at + RETENTION_MS) return refusal("too_late");
  const instance = await store.getInstance(reservation.instance_id);
  if (!instance || instance.service_state !== "suspended")
    return refusal("not_suspended");
  const asset = await store.assetForInstance(instance.id);
  if (!asset || asset.asset_state !== "active")
    return refusal("asset_not_retainable");
  const operations = await store.operationsFor(instance.id);
  if (
    operations.some(
      (op) => op.kind === "cancel_asset" || op.kind === "remove_dns",
    )
  )
    return refusal("deletion_started");
  const expectedPowerOff = lifecycleOperationId(
    "power_off",
    closed.id,
    closed.ended_at,
  );
  const powerOff = operations.find((op) => op.id === expectedPowerOff);
  if (
    !powerOff ||
    powerOff.status !== "succeeded" ||
    poweredOffAtFrom(operations, closed.id, closed.ended_at) === null
  )
    return refusal("power_off_not_proven");
  const foreign = await store.sqlGet<{ id: string }>(
    "select id from subscriptions where instance_id = $1 and account_id <> $2 limit 1",
    [instance.id, reservation.account_id],
  );
  if (closed.account_id !== reservation.account_id || foreign)
    return refusal("ownership_mismatch");
  const handoff = operations.some(
    (op) => op.kind === "revoke_access" && op.status === "succeeded",
  );
  // ssh_login_user is deliberately NOT evidence. It is also written when the
  // customer supplied no key. Only the installed-key fingerprint proves access.
  if (!handoff && instance.customer_ssh_key_fingerprint === null)
    return refusal("no_customer_access");
  return { ok: true, operations };
}

export function reinstatementAttemptId(closedSubscriptionId: string): string {
  return `reinstate-${closedSubscriptionId}`;
}

export function reinstatementSessionKey(
  attemptId: string,
  generation: number,
): string {
  return `cp-resub-ses-${attemptId}-${generation}`;
}

export function reinstatementPowerOnId(newSubscriptionId: string): string {
  return `op-power_on-reinstate-${newSubscriptionId}`;
}

export function checkoutExpiryOperationId(attemptId: string): string {
  return `op-checkout_expire-${attemptId}`;
}

export type PreparedReinstatement =
  | {
      ok: true;
      reservation: ReservationRow;
      account: AccountRow;
      attemptId: string;
      generation: number;
      stripeExpiresAt: number;
      existingSessionId: string | null;
    }
  | { ok: false; reason: string };

export async function prepareReinstatementCheckout(
  store: Store,
  accountId: string,
  instanceId: string,
  stripeCallPreparedAt: number,
): Promise<PreparedReinstatement> {
  return store.tx(async () => {
    const reservation = await instanceOwnedBy(store, accountId, instanceId);
    if (!reservation)
      return { ok: false, reason: "we could not find that office" };
    if (!planById(reservation.plan))
      return {
        ok: false,
        reason: "this retained plan is no longer configured",
      };
    const account = await getAccount(store, accountId);
    const closed = await currentSubscriptionForInstance(store, instanceId);
    if (!account || !closed)
      return { ok: false, reason: "we could not find that subscription" };
    if (!account.stripe_customer_id)
      return {
        ok: false,
        reason: "we could not prove the original Stripe customer",
      };
    const now = store.now();
    const eligible = await checkReinstatementEligibility(store, {
      reservation,
      closed,
      now,
    });
    if (!eligible.ok) return { ok: false, reason: eligible.reason };
    const id = reinstatementAttemptId(closed.id);
    const existing = await attemptById(store, id);
    if (existing?.state === "accepted")
      return { ok: false, reason: "this office is already reinstated" };
    const generation = existing
      ? existing.checkout_generation + (existing.state === "expired" ? 1 : 0)
      : 1;
    // Five seconds is transport/API-floor safety only. The customer boundary
    // is fence_expires_at, which remains the old subscription retention end.
    const stripeExpiresAt =
      existing && existing.state !== "expired"
        ? existing.stripe_expires_at
        : stripeCallPreparedAt + REINSTATEMENT_CHECKOUT_MS + 5_000;
    const fenceExpiresAt = closed.ended_at! + RETENTION_MS;
    if (!existing) {
      await store.sqlRun(
        "insert into reinstatement_attempts " +
          "(id, account_id, reservation_id, instance_id, closed_subscription_id, closed_ended_at, " +
          "new_subscription_id, checkout_session_id, checkout_generation, accepted_at, " +
          "fence_expires_at, stripe_expires_at, state, version, created_at, updated_at) " +
          "values ($1,$2,$3,$4,$5,$6,null,null,$7,$8,$9,$10,'opening',1,$11,$12)",
        [
          id,
          accountId,
          reservation.id,
          instanceId,
          closed.id,
          closed.ended_at!,
          generation,
          now,
          fenceExpiresAt,
          stripeExpiresAt,
          now,
          now,
        ],
      );
    } else if (existing.state === "expired") {
      await store.sqlRun(
        "update reinstatement_attempts set checkout_generation=$1, checkout_session_id=null, " +
          "accepted_at=$2, stripe_expires_at=$3, state='opening', updated_at=$2, version=version+1 where id=$4",
        [generation, now, stripeExpiresAt, id],
      );
    }
    await store.appendAudit({
      actor: `account:${accountId}`,
      instance_id: instanceId,
      action: "reinstatement_checkout_start",
      target: id,
      outcome: "started",
      detail: `acceptedAt=${new Date(now).toISOString()}; fenceExpiresAt=${new Date(fenceExpiresAt).toISOString()}; stripeExpiresAt=${new Date(stripeExpiresAt).toISOString()}; generation=${generation}`,
    });
    return {
      ok: true,
      reservation,
      account,
      attemptId: id,
      generation,
      stripeExpiresAt,
      existingSessionId:
        existing && existing.state !== "expired"
          ? existing.checkout_session_id
          : null,
    };
  });
}

/** Move only the exact fetched-expired session to the next durable generation. */
export async function recordFetchedExpiredReinstatementSession(
  store: Store,
  attemptId: string,
  sessionId: string,
): Promise<boolean> {
  const changed = await store.sqlGet<{ id: string }>(
    "update reinstatement_attempts set state='expired', updated_at=$1, version=version+1 " +
      "where id=$2 and checkout_session_id=$3 and state in ('opening','pending') returning id",
    [store.now(), attemptId, sessionId],
  );
  return changed !== null;
}

/** A failed create exposed no payment URL and no session identity to a buyer. */
export async function recordReinstatementCheckoutFailure(
  store: Store,
  prepared: Extract<PreparedReinstatement, { ok: true }>,
  detail: string,
): Promise<boolean> {
  return store.tx(async () => {
    const changed = await store.sqlGet<{ id: string }>(
      "update reinstatement_attempts set state='expired', updated_at=$1, version=version+1 " +
        "where id=$2 and checkout_generation=$3 and state='opening' and checkout_session_id is null returning id",
      [store.now(), prepared.attemptId, prepared.generation],
    );
    if (!changed) return false;
    await store.appendAudit({
      actor: `account:${prepared.account.id}`,
      instance_id: prepared.reservation.instance_id,
      action: "reinstatement_checkout_open_failed",
      target: prepared.attemptId,
      outcome: "failed",
      detail: `generation=${prepared.generation}; ${detail}`,
    });
    return true;
  });
}

export async function recordReinstatementSession(
  store: Store,
  prepared: Extract<PreparedReinstatement, { ok: true }>,
  sessionId: string,
): Promise<void> {
  await store.tx(async () => {
    await store.sqlRun(
      "update reinstatement_attempts set checkout_session_id=$1, state='pending', updated_at=$2, version=version+1 where id=$3 and checkout_generation=$4",
      [sessionId, store.now(), prepared.attemptId, prepared.generation],
    );
    await store.appendAudit({
      actor: `account:${prepared.account.id}`,
      instance_id: prepared.reservation.instance_id,
      action: "reinstatement_checkout_opened",
      target: prepared.attemptId,
      outcome: "succeeded",
      detail: `session=${sessionId}; generation=${prepared.generation}`,
    });
  });
}

/** A separate opener. Dunning requestResume remains unchanged. */
export async function requestReinstatementPowerOn(
  store: Store,
  attempt: ReinstatementAttemptRow,
  subscription: SubscriptionRow,
  now: number,
): Promise<string | null> {
  if (!store.inTransaction())
    throw new Error("reinstatement power-on needs a transaction");
  const id = reinstatementPowerOnId(subscription.id);
  if (await store.getOperation(id)) return id;
  const reservation = await store.sqlGet<ReservationRow>(
    "select * from name_reservations where id = $1",
    [attempt.reservation_id],
  );
  if (!reservation) return null;
  const closed = await store.sqlGet<SubscriptionRow>(
    "select * from subscriptions where id = $1",
    [attempt.closed_subscription_id],
  );
  if (
    !closed ||
    !(await checkReinstatementEligibility(store, { reservation, closed, now }))
      .ok
  )
    return null;
  if (!new Set(["active", "trialing"]).has(subscription.status)) return null;
  if (subscription.instance_id !== attempt.instance_id) return null;
  const activePower = (await store.operationsFor(attempt.instance_id)).some(
    (op) =>
      ["power_on", "power_off"].includes(op.kind) &&
      ["pending", "running", "ambiguous"].includes(op.status),
  );
  if (activePower) return null;
  const d = deadlinesFor("power_on");
  await store.enqueue({
    id,
    instance_id: attempt.instance_id,
    kind: "power_on",
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
    evidence: {
      reason: REINSTATEMENT_REASON,
      attempt: attempt.id,
      closedSubscription: attempt.closed_subscription_id,
      newSubscription: subscription.id,
    },
  });
  return id;
}
