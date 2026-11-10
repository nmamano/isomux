// The end of the customer lifecycle, as arithmetic over durable rows.
//
// No store, no clock of its own, no I/O - the same shape as dunning.ts, and for
// the same reason: every branch below is a unit test on seeded numbers rather
// than a test-clock exercise, and a timeline that could only be observed by
// waiting would never be observed at all.
//
// TWO POLICIES SHARE THIS MACHINE:
//
//   launch: power off at endedAt; retain until endedAt + 14 days.
//   legacy: serve until endedAt + 7 days; retain one calendar month from the
//           first proven cancellation power-off.
//
// retentionEnd is when we ASK for permanent deletion. It is not a provider
// deletion date. A corrective power-off after a late reboot never re-anchors
// the legacy promise.
//
//   serviceEndsAt= the provider's own term end, on `provider_assets`. The only
//                  date on which data actually disappears, and the provider owns
//                  it.
//
// R-2026-08-10-3 clause 1, verbatim, because it is the mechanism this file
// implements: "The asset is NOT cancel-scheduled during suspension -
// cancel_asset is issued only at deprovision_due, and if the provider term
// renews meanwhile, that renewal is an accepted cost, not a bug."
//
// So retention beats provider billing convenience, and a provider truth that
// would end service BEFORE our promised retention deadline is a promise at
// risk - an attention case - never a quiet shortening of what the customer was
// told.

import type { OperationKind } from "./operations.ts";
import type { AssetRow, InstanceRow, OperationRow, Severity } from "./store.ts";
import type { CancellationPolicy } from "./stripe/billing-store.ts";

/** Grandfathered grace. Launch rows never enter the grace phase. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Stripe's own word for a customer cancellation, measured 2026-08-10 on API
 * version 2026-07-29.dahlia. Dunning cancellations arrive as `payment_failed`
 * (observed 2026-08-09), and the two walk completely different machines.
 */
export const CUSTOMER_CANCELLATION_REASON = "cancellation_requested";

/**
 * One calendar month later, in UTC, with an explicit end-of-month CLAMP.
 *
 * Ruling 8 says one month, and a month is not 30 days: 31 January plus 30 days
 * is 2 March, which is a different promise in February than it is in July. The
 * clamp is what makes the shorter month land on its last day instead of
 * overflowing into the next one.
 *
 * UTC throughout, deliberately. Every instant in this schema is epoch
 * milliseconds and there is no customer time zone anywhere in the product, so a
 * local-time month would introduce one purely as a source of off-by-a-day.
 */
export function addUtcMonth(instant: number): number {
  const d = new Date(instant);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetYear = month === 11 ? year + 1 : year;
  const targetMonth = month === 11 ? 0 : month + 1;
  // Day 0 of the month AFTER the target is the target's last day.
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(day, lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * Where a cancelled office is on its way out.
 *
 * `serving` covers everything before the subscription actually ends, INCLUDING a
 * scheduled cancellation that has not arrived yet. That is not a rounding: a
 * scheduled cancellation is reversible, and no operation of this lifecycle may
 * be opened while it is.
 */
export type LifecyclePhase =
  | "serving"
  | "grace"
  | "power_off_due"
  | "suspended"
  | "deprovision_due"
  | "reinstatement_pending"
  | "checkout_expiry_due"
  | "reinstated"
  | "ended";

export interface TimelineFacts {
  /** `subscriptions.ended_at`. Null until service actually ended. */
  endedAt: number | null;
  /** `subscriptions.cancellation_reason`. */
  cancellationReason: string | null;
  /** When the CANCELLATION's own power_off succeeded, from that operation's own
   * evidence. Never another power_off's, and never a row timestamp. */
  poweredOffAt: number | null;
  /** A reboot after the last proven cancellation power-off. */
  repoweredAt?: number | null;
  cancellationPolicy?: CancellationPolicy | null;
  /** Whether provider truth already reports the asset gone. */
  assetGone: boolean;
  reinstatement?: {
    state: "pending" | "accepted" | "expired" | "attention";
    attemptId: string;
    fenceExpiresAt: number;
    expiryProven: boolean;
  } | null;
}

export interface Timeline {
  phase: LifecyclePhase;
  /** Null until `endedAt` exists: before that every date here is a projection,
   * and this type carries only proven instants. */
  graceEnd: number | null;
  /** Null until the box has actually been powered off. */
  retentionEnd: number | null;
  /**
   * The earliest instant at which the data may legitimately be gone.
   *
   * `retentionEnd` once the box has been powered off; before that, a PROJECTION
   * from the grace end, because the power-off cannot happen earlier than that
   * and the promise therefore cannot expire earlier either. It exists so that a
   * provider term ending during the GRACE WEEK is already a risk - waiting for
   * `poweredOffAt` to appear before checking would leave the whole grace week
   * unwatched.
   */
  promisedUntil: number | null;
}

/** Explicit so a new lifecycle phase cannot inherit a restart policy silently. */
export function restartAllowedIn(phase: LifecyclePhase): boolean {
  switch (phase) {
    case "grace":
      return true;
    case "serving":
    case "power_off_due":
    case "suspended":
    case "deprovision_due":
    case "reinstatement_pending":
    case "checkout_expiry_due":
    case "reinstated":
    case "ended":
      return false;
    default: {
      const neverPhase: never = phase;
      return neverPhase;
    }
  }
}

/** Is this a CUSTOMER cancellation - the only thing this machine drives? */
export function isCustomerCancellation(facts: {
  endedAt: number | null;
  cancellationReason: string | null;
}): boolean {
  return (
    facts.endedAt !== null &&
    facts.cancellationReason === CUSTOMER_CANCELLATION_REASON
  );
}

/**
 * The phase, as a pure function of durable facts and an instant.
 *
 * Every boundary is "the deadline has been REACHED", `<=`, not "has passed".
 * A deadline that only fires strictly after itself is a deadline that never
 * fires on the tick that lands exactly on it.
 */
export function phaseAt(facts: TimelineFacts, now: number): Timeline {
  if (!isCustomerCancellation(facts)) {
    return {
      phase: "serving",
      graceEnd: null,
      retentionEnd: null,
      promisedUntil: null,
    };
  }
  const legacy = facts.cancellationPolicy !== "launch";
  const graceEnd = facts.endedAt! + (legacy ? GRACE_MS : 0);
  const retentionEnd = legacy
    ? facts.poweredOffAt === null
      ? null
      : addUtcMonth(facts.poweredOffAt)
    : facts.endedAt! + RETENTION_MS;
  // The projection is from the GRACE END, not from now: the power-off cannot
  // land before then, so neither can the promise expire.
  const promisedUntil = legacy
    ? (retentionEnd ?? addUtcMonth(graceEnd))
    : facts.endedAt! + RETENTION_MS;
  const base = { graceEnd, retentionEnd, promisedUntil };

  // Provider truth still wins after payment. An accepted linkage cannot make a
  // provider asset that is already gone exist again.
  if (facts.assetGone) {
    return { ...base, phase: "ended" };
  }
  if (facts.reinstatement?.state === "accepted") {
    return { ...base, phase: "reinstated" };
  }
  if (facts.reinstatement?.state === "pending") {
    if (now < facts.reinstatement.fenceExpiresAt) {
      return { ...base, phase: "reinstatement_pending" };
    }
    if (!facts.reinstatement.expiryProven) {
      return { ...base, phase: "checkout_expiry_due" };
    }
  }

  if (facts.poweredOffAt !== null && (facts.repoweredAt ?? null) === null) {
    return {
      ...base,
      phase: now >= retentionEnd! ? "deprovision_due" : "suspended",
    };
  }
  return {
    ...base,
    phase: legacy && now < graceEnd ? "grace" : "power_off_due",
  };
}

/**
 * The identity of a persistent condition, separate from the sentence describing
 * it.
 *
 * Attention rows deduplicate on (source_op_id, reason), so a reason that
 * interpolated the observation time opened a NEW critical row on every tick.
 * These keys give each condition one durable identity, which is what makes a
 * raise idempotent and a clear addressable.
 */
export const PROMISE_AT_RISK = "lifecycle-promise-at-risk";
export const PROMISE_BROKEN = "lifecycle-promise-broken";
export const LIFECYCLE_STRAY = "lifecycle-stray-rows";
export const LIFECYCLE_REPOWERED = "lifecycle-repowered";
export const LIFECYCLE_ASSET_GONE = "lifecycle-asset-gone";
/** The asset-gone row's sentence. Exported because the work schedule matches
 * the full open identity (key and sentence) when it decides a raise is due. */
export const ASSET_GONE_REASON =
  `the provider asset for this office is gone while its ` +
  `subscription cancellation is not complete; billing and provider ` +
  `state need operator review`;

/**
 * What to do about a condition.
 *
 * Two kinds, because one of these conditions is REVERSIBLE and the other is
 * not. A provider term that lapses too early can be renewed, and an incident
 * that stays open after the danger passed teaches an operator to ignore the
 * floor. A promise that was actually broken cannot be un-broken, so nothing
 * automatic clears it: an operator resolves it (`attention --resolve`), and it
 * is never raised again for the same promised date.
 */
export type AttentionAction =
  | {
      kind: "raise";
      key: string;
      reason: string;
      severity: Severity;
      /** Dated evidence for the audit row. Never part of the identity. */
      detail?: string;
    }
  | { kind: "clear"; key: string };

/** What the tick should do about one instance, and why. */
export interface LifecycleDecision {
  /** Operation kinds to open, with the id each must carry. Empty is the normal
   * answer: this machine acts twice in a customer's whole life. */
  open: {
    kind: OperationKind;
    id: string;
    evidence: Record<string, unknown>;
  }[];
  /** Set when provider truth has ended the asset and the instance has not been
   * recorded as deprovisioned yet. */
  finish: boolean;
  /**
   * A LIST, in order, applied in one transaction.
   *
   * One action was not enough for the transition that matters: an at-risk
   * incident being PROMOTED to a broken promise has to clear the superseded row
   * and raise the new one together, or the ops floor shows both - one saying
   * the term must be renewed while the data is already gone.
   */
  attention: AttentionAction[];
  phase: LifecyclePhase;
  note: string;
}

/**
 * The operation ids this lifecycle uses, derived from the ANCHOR rather than
 * from a counter.
 *
 * `endedAt` is the anchor because it is the one instant that does not exist
 * until the lifecycle may begin and never changes afterwards. Measured
 * 2026-08-10: a cancel / un-cancel / re-cancel inside one period leaves
 * `current_period_end` untouched, so a period-derived id would have been the
 * SAME id across a reversal - which only sounds dangerous until you notice that
 * no lifecycle operation may be opened before the subscription is terminal
 * anyway. Anchoring on `ended_at` removes the question rather than answering it:
 * before termination there is no id to collide with.
 */
export function lifecycleOperationId(
  kind: OperationKind,
  subscriptionId: string,
  endedAt: number,
): string {
  return `op-${kind}-cancel-${subscriptionId}-${endedAt}`;
}

/** Evidence stamp that marks a row as belonging to THIS machine. */
export const LIFECYCLE_REASON = "cancellation";

export interface LifecycleInputs {
  instance: InstanceRow;
  asset: AssetRow | null;
  operations: OperationRow[];
  subscription: {
    id: string;
    endedAt: number | null;
    cancellationReason: string | null;
    cancellationPolicy?: CancellationPolicy | null;
  } | null;
  reinstatement?: TimelineFacts["reinstatement"];
  now: number;
}

function numberEvidence(op: OperationRow, key: string): number | null {
  try {
    const value = (JSON.parse(op.evidence) as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function stringArrayEvidence(op: OperationRow, key: string): string[] {
  try {
    const value = (JSON.parse(op.evidence) as Record<string, unknown>)[key];
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function correctivePowerOffId(
  subscriptionId: string,
  rebootId: string,
): string {
  return `op-power_off-cancel-corrective-${subscriptionId}-${rebootId}`;
}

export function repowerFacts(
  operations: OperationRow[],
  subscriptionId: string,
  endedAt: number,
  firstPoweredOffAt: number | null,
): { repoweredAt: number | null; rebootId: string | null; unknown: boolean } {
  if (firstPoweredOffAt === null)
    return { repoweredAt: null, rebootId: null, unknown: false };
  const correctionRows = operations.filter(
    (op) =>
      op.kind === "power_off" &&
      op.status === "succeeded" &&
      isLifecycleRow(op) &&
      op.id !== lifecycleOperationId("power_off", subscriptionId, endedAt),
  );
  const corrections = correctionRows
    .map((op) => numberEvidence(op, "poweredOffAt"))
    .filter((at): at is number => at !== null);
  const lastOff = Math.max(firstPoweredOffAt, ...corrections);
  const reboots = operations.filter(
    (op) => op.kind === "reboot" && op.status === "succeeded",
  );
  for (const reboot of reboots) {
    const at = numberEvidence(reboot, "rebootedAt");
    const explicitlyAnswered = correctionRows.some((op) => {
      try {
        const evidence = JSON.parse(op.evidence) as Record<string, unknown>;
        return (
          evidence.correctiveFor === reboot.id ||
          stringArrayEvidence(op, "answeredReboots").includes(reboot.id)
        );
      } catch {
        return false;
      }
    });
    if (at === null && !explicitlyAnswered) {
      return {
        repoweredAt: firstPoweredOffAt,
        rebootId: reboot.id,
        unknown: true,
      };
    }
  }
  const later = reboots
    .map((op) => ({ op, at: numberEvidence(op, "rebootedAt") }))
    .filter(
      (entry): entry is { op: OperationRow; at: number } => entry.at !== null,
    )
    .filter((entry) => entry.at > lastOff)
    .sort((a, b) => b.at - a.at)[0];
  return later
    ? { repoweredAt: later.at, rebootId: later.op.id, unknown: false }
    : { repoweredAt: null, rebootId: null, unknown: false };
}

/** Did this operation come from the cancellation lifecycle? A stamp we wrote. */
export function isLifecycleRow(op: OperationRow): boolean {
  try {
    const parsed: unknown = JSON.parse(op.evidence);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    return (parsed as Record<string, unknown>).reason === LIFECYCLE_REASON;
  } catch {
    return false;
  }
}

/**
 * When the cancellation's own power_off succeeded, from ITS OWN evidence.
 *
 * Not "the latest succeeded power_off": an account can carry an old dunning
 * suspension from months ago, and anchoring retention on that one would start
 * the deletion clock before the customer had even cancelled. The row is
 * identified by the derived id, and the instant is a field the handler wrote on
 * purpose rather than a row timestamp another writer can move.
 */
export function poweredOffAtFrom(
  operations: OperationRow[],
  subscriptionId: string,
  endedAt: number,
): number | null {
  const id = lifecycleOperationId("power_off", subscriptionId, endedAt);
  const row = operations.find(
    (op) => op.id === id && op.status === "succeeded",
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.evidence) as Record<string, unknown>;
    const at = parsed.poweredOffAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export interface CancellationState {
  timeline: Timeline;
  poweredOffAt: number | null;
  repower: ReturnType<typeof repowerFacts>;
}

/** One pure timeline projection for the ticker, request fence, handler and UI. */
export function cancellationStateFrom(
  subscription: LifecycleInputs["subscription"],
  operations: OperationRow[],
  asset: AssetRow | null,
  now: number,
  reinstatement?: TimelineFacts["reinstatement"],
): CancellationState | null {
  if (!subscription || !isCustomerCancellation(subscription)) return null;
  const endedAt = subscription.endedAt!;
  const poweredOffAt = poweredOffAtFrom(operations, subscription.id, endedAt);
  const repower = repowerFacts(
    operations,
    subscription.id,
    endedAt,
    poweredOffAt,
  );
  return {
    poweredOffAt,
    repower,
    timeline: phaseAt(
      {
        endedAt,
        cancellationReason: subscription.cancellationReason,
        poweredOffAt,
        repoweredAt: repower.repoweredAt,
        cancellationPolicy:
          subscription.cancellationPolicy === "launch" ? "launch" : "legacy",
        assetGone: !!asset && GONE_STATES.has(asset.asset_state),
        reinstatement,
      },
      now,
    ),
  };
}

/** Provider states that mean the asset is really gone, not merely scheduled. */
export const GONE_STATES = new Set(["cancelled", "absent"]);

/**
 * The asset-gone condition for an office whose subscription is not terminal:
 * raise while the asset is gone and the office is not deprovisioned, clear
 * otherwise. Two callers share it so that both raise and clear ONE row:
 * decideLifecycle's non-terminal arm, and lifecycle-tick's scan of the
 * never-cancelled subscriptions decideLifecycle never sees.
 */
export function assetGoneAction(
  instance: InstanceRow,
  asset: AssetRow | null,
): AttentionAction {
  const gone =
    instance.service_state !== "deprovisioned" &&
    asset !== null &&
    GONE_STATES.has(asset.asset_state);
  return gone
    ? {
        kind: "raise",
        key: LIFECYCLE_ASSET_GONE,
        reason: ASSET_GONE_REASON,
        severity: "critical",
      }
    : { kind: "clear", key: LIFECYCLE_ASSET_GONE };
}

/**
 * An office pays when it has a subscription that is active or trialing and not
 * cancelling; past_due does not count. One SQL fragment over an `instances i`
 * alias, shared by the lifecycle pass and the work schedule, so the schedule
 * reads the same predicate the pass decides on.
 */
export const PAYING_SQL =
  "exists (select 1 from subscriptions s where s.instance_id = i.id " +
  "and s.status in ('active', 'trialing') and s.cancel_at_period_end = 0)";

/** The provider-cancel row's key: a provider cancel on the asset of an office
 * that pays and is not cancelling. */
export const LIFECYCLE_PROVIDER_CANCEL = "lifecycle-provider-cancel-scheduled";
/**
 * The fixed parts of the provider-cancel sentence, around the provider id and
 * the provider's raw end date. Exported because the work schedule builds the
 * same sentence in SQL to find the open identity (key and sentence).
 */
export const PROVIDER_CANCEL_REASON_PARTS = {
  before: "the provider will delete server ",
  between: " on ",
  after:
    ", but this office's subscription is active and not cancelling; revoke " +
    "the cancellation at the provider",
  unknownDate: "an unknown date",
} as const;

/** The provider-cancel sentence for this asset. */
export function providerCancelReason(asset: AssetRow): string {
  const p = PROVIDER_CANCEL_REASON_PARTS;
  // The provider's raw date, not a parsed one: the schedule rebuilds this
  // sentence with a string concat, which cannot fail on a bad date.
  return (
    p.before +
    (asset.provider_id ?? asset.id) +
    p.between +
    (asset.service_ends_at ?? p.unknownDate) +
    p.after
  );
}

/**
 * The provider-cancel condition: raise while the office pays (an active or
 * trialing subscription that is not cancelling) and its asset is
 * cancel-scheduled, clear otherwise.
 */
export function providerCancelAction(
  asset: AssetRow | null,
  paying: boolean,
): AttentionAction {
  // The state only, never service_ends_at: reconcile leaves the old date on the
  // row when the provider cancel is revoked.
  return paying && asset?.asset_state === "cancel_scheduled"
    ? {
        kind: "raise",
        key: LIFECYCLE_PROVIDER_CANCEL,
        reason: providerCancelReason(asset),
        severity: "critical",
      }
    : { kind: "clear", key: LIFECYCLE_PROVIDER_CANCEL };
}

export function decideLifecycle(inputs: LifecycleInputs): LifecycleDecision {
  const { instance, asset, operations, subscription, now } = inputs;
  const none = (note: string): LifecycleDecision => ({
    open: [],
    finish: false,
    attention: [],
    phase: "serving",
    note,
  });

  if (!subscription) return none("no subscription is linked to this office");

  const terminal = isCustomerCancellation(subscription);
  // KNOWN LIMIT, accepted 2026-10-02 (task 6e13f9d8): an office deprovisioned
  // by hand while its subscription is not terminal (cp2's shape) gets no
  // remove_dns from this arm. Its id is anchored on ended_at, and there is
  // none. lifecycle-tick still clears its stale liveness alert.
  if (!terminal) {
    const assetGoneAttention = [assetGoneAction(instance, asset)];
    // DEFENSIVE, not decorative. "Stripe does not un-delete a subscription" is
    // true and is still not a mechanism: if a lifecycle row exists while the
    // subscription is not terminal, something we do not model has happened, and
    // the honest answer is a person rather than another operation.
    const stray = operations.filter(isLifecycleRow);
    if (stray.length > 0) {
      return {
        open: [],
        finish: false,
        attention: [
          ...assetGoneAttention,
          {
            kind: "raise" as const,
            key: LIFECYCLE_STRAY,
            // No count in the sentence: it would change as rows are added and
            // open a second row for the same condition.
            reason:
              `a cancellation lifecycle was started for this office and its ` +
              `subscription is not terminal; nothing further will be opened ` +
              `until a person looks`,
            severity: "critical",
          },
        ],
        phase: "serving",
        note: "lifecycle rows exist without a terminal cancellation",
      };
    }
    return {
      ...none("not a customer cancellation"),
      attention: assetGoneAttention,
    };
  }

  const endedAt = subscription.endedAt!;
  const state = cancellationStateFrom(
    subscription,
    operations,
    asset,
    now,
    inputs.reinstatement,
  )!;
  const { timeline, repower } = state;

  // A provider term that ends before the retention deadline is a PROMISE AT
  // RISK. It never shortens what the customer was told and never advances
  // deprovisioning; it raises a person, because only a person can buy the
  // renewal that keeps the promise.
  // Against `promisedUntil`, not `retentionEnd`: a provider term lapsing during
  // the GRACE WEEK is already a risk, and waiting for the power-off to happen
  // before looking would leave the whole week unwatched.
  const atRisk = promiseAtRisk(asset, timeline.promisedUntil);

  if (timeline.phase === "ended") {
    // A GONE ASSET BEFORE THE PROMISED DEADLINE IS A BROKEN PROMISE, not a
    // normal end. The data is already gone, so the data end is still recorded -
    // pretending otherwise would put the row at odds with the world - but it is
    // recorded WITH the incident, because R-2026-08-10-3 makes the retention
    // deadline the thing we owe and this is the case where we failed to pay it.
    //
    // PROVIDER TRUTH OUTRANKS THE OBSERVATION TIME. A term that ended on 1 July
    // against a 17 July deadline broke the promise whether we noticed on the
    // 2nd or the 18th, and keying on `now` alone let a late reconcile record a
    // silent, ordinary-looking data end for a failure the asset row can prove.
    // The observation-time test is the FALLBACK, for a provider that gives no
    // usable end instant at all.
    const provenEarly = atRisk !== null;
    const early =
      provenEarly ||
      (parseServiceEndsAt(asset?.service_ends_at ?? null) === null &&
        timeline.promisedUntil !== null &&
        now < timeline.promisedUntil);
    return {
      // The asset can end before deprovision_due, and then that phase never
      // opens remove_dns. The office and wildcard records would keep pointing at
      // a provider address that can go to another customer. Same derived id as
      // deprovision_due, so an office that passed through it gets no second row.
      open: [
        {
          kind: "remove_dns",
          id: lifecycleOperationId("remove_dns", subscription.id, endedAt),
          evidence: {
            reason: LIFECYCLE_REASON,
            subscription: subscription.id,
            assetState: asset?.asset_state ?? null,
          },
        },
      ],
      // Deprovisioned is recorded from PROVIDER TRUTH and nothing else. Our own
      // deadline passing is a request, not a deletion.
      finish: instance.service_state !== "deprovisioned",
      attention: [
        { kind: "clear" as const, key: LIFECYCLE_REPOWERED },
        { kind: "clear" as const, key: LIFECYCLE_ASSET_GONE },
        ...(early
          ? [
              // PROMOTION, and both halves commit together. The at-risk row said
              // "renew the term or the promise breaks"; the promise has now
              // broken, so leaving it open would put a stale instruction on the
              // ops floor beside the incident that superseded it.
              { kind: "clear" as const, key: PROMISE_AT_RISK },
              {
                kind: "raise" as const,
                key: PROMISE_BROKEN,
                // STABLE. No `now` in it: the row's own raised_at records when we
                // first saw it, and a sentence carrying the observation time would
                // open a fresh critical row on every later tick.
                reason:
                  `the provider asset for this office ended BEFORE the ` +
                  `${iso(timeline.promisedUntil)} the customer was promised; the ` +
                  `retention promise was broken and the data is already gone`,
                severity: "critical" as const,
                // The DATED evidence, in the audit row rather than the identity: a
                // later renewal overwrites the asset's date, and the incident has
                // to stay reconstructable afterwards.
                detail: datedEvidence(asset, timeline.promisedUntil, now),
              },
            ]
          : // The risk, if one was raised, resolved into an ordinary end.
            [{ kind: "clear" as const, key: PROMISE_AT_RISK }]),
      ],
      phase: timeline.phase,
      note: early
        ? `provider ended the asset EARLY (${asset?.asset_state}); promise broken`
        : `provider reports the asset ${asset?.asset_state}; data end recorded`,
    };
  }

  const open: LifecycleDecision["open"] = [];
  const attention: AttentionAction[] = atRisk
    ? [
        {
          kind: "raise",
          key: PROMISE_AT_RISK,
          ...atRisk,
          detail: datedEvidence(asset, timeline.promisedUntil, now),
        },
      ]
    : [{ kind: "clear", key: PROMISE_AT_RISK }];
  if (timeline.phase === "reinstated") {
    const allowed = lifecycleOperationId("power_off", subscription.id, endedAt);
    const stray = operations.some(
      (op) =>
        isLifecycleRow(op) &&
        !(
          op.id === allowed &&
          op.kind === "power_off" &&
          op.status === "succeeded"
        ),
    );
    return {
      open: [],
      finish: false,
      attention: [
        { kind: "clear", key: PROMISE_AT_RISK },
        ...(stray
          ? [
              {
                kind: "raise" as const,
                key: LIFECYCLE_STRAY,
                reason:
                  "a reinstated office has cancellation lifecycle rows beyond its exact succeeded suspension; a person must inspect them",
                severity: "critical" as const,
              },
            ]
          : []),
      ],
      phase: timeline.phase,
      note: "the retained office was reinstated",
    };
  }
  if (timeline.phase === "reinstatement_pending") {
    return {
      open: [],
      finish: false,
      attention,
      phase: timeline.phase,
      note: "reinstatement Checkout remains pending until the lifecycle tick runs",
    };
  }
  if (timeline.phase === "checkout_expiry_due") {
    const attemptId = inputs.reinstatement?.attemptId;
    if (attemptId) {
      open.push({
        kind: "expire_checkout",
        id: `op-checkout_expire-${attemptId}`,
        evidence: { reason: "reinstatement", attempt: attemptId },
      });
    }
    return {
      open,
      finish: false,
      attention,
      phase: timeline.phase,
      note: "Checkout must be expired and fetched before deletion may open",
    };
  }
  if (timeline.phase === "power_off_due") {
    const activeCorrection = operations.find(
      (op) =>
        op.kind === "power_off" &&
        ["pending", "running", "ambiguous"].includes(op.status) &&
        isLifecycleRow(op) &&
        op.id !== lifecycleOperationId("power_off", subscription.id, endedAt),
    );
    const id = activeCorrection
      ? activeCorrection.id
      : repower.rebootId
        ? correctivePowerOffId(subscription.id, repower.rebootId)
        : lifecycleOperationId("power_off", subscription.id, endedAt);
    open.push({
      kind: "power_off",
      id,
      evidence: {
        reason: LIFECYCLE_REASON,
        subscription: subscription.id,
        graceEnd: timeline.graceEnd,
        ...(repower.rebootId ? { correctiveFor: repower.rebootId } : {}),
        ...(repower.rebootId
          ? {
              answeredReboots: operations
                .filter(
                  (op) => op.kind === "reboot" && op.status === "succeeded",
                )
                .map((op) => op.id),
            }
          : {}),
      },
    });
  }
  if (timeline.phase === "deprovision_due") {
    // BOTH, in one decision, and neither waits for the other. Separate
    // retryable operations is the design's rule; a chain would make a stuck DNS
    // record hold an asset we are still paying for.
    for (const kind of ["cancel_asset", "remove_dns"] as const) {
      open.push({
        kind,
        id: lifecycleOperationId(kind, subscription.id, endedAt),
        evidence: {
          reason: LIFECYCLE_REASON,
          subscription: subscription.id,
          retentionEnd: timeline.retentionEnd,
        },
      });
    }
  }
  if (repower.repoweredAt !== null) {
    attention.push({
      kind: "raise",
      key: LIFECYCLE_REPOWERED,
      reason:
        "a reboot succeeded after cancellation suspension; the office must be powered off again before deletion",
      severity: "critical",
      detail: repower.unknown
        ? `reboot=${repower.rebootId}; rebootedAt=missing; observed=${iso(now)}`
        : `reboot=${repower.rebootId}; rebootedAt=${iso(repower.repoweredAt)}; observed=${iso(now)}`,
    });
  } else {
    attention.push({ kind: "clear", key: LIFECYCLE_REPOWERED });
  }

  return {
    open,
    finish: false,
    // Reversible: raised while the term threatens the promise, and CLEARED when
    // a renewal pushes it back out. A critical incident that survived the fix
    // would be indistinguishable from one nobody had dealt with.
    attention,
    phase: timeline.phase,
    note: `${timeline.phase} (grace ends ${iso(timeline.graceEnd)}, retention ends ${iso(timeline.retentionEnd)})`,
  };
}

/**
 * Does provider truth threaten the retention promise?
 *
 * Contabo cancels at its paid-term end and bills whole months, so a term that
 * lapses inside the retention month would delete the customer's data early. The
 * ruling says the retention deadline wins, so this is exactly the case that has
 * to reach a human while there is still time to buy the renewal.
 */
export function promiseAtRisk(
  asset: AssetRow | null,
  promisedUntil: number | null,
): { reason: string; severity: Severity } | null {
  const retentionEnd = promisedUntil;
  if (!asset || retentionEnd === null) return null;
  const endsAt = parseServiceEndsAt(asset.service_ends_at);
  if (endsAt === null || endsAt >= retentionEnd) return null;
  return {
    // STABLE for the condition, not for the reading: the provider's date moves
    // when the term is renewed, and embedding it would leave the old row open
    // beside a new one. The date lives in the audit trail and on the asset row.
    reason:
      `the provider ends service for ${asset.provider_id ?? asset.id} BEFORE ` +
      `the retention deadline this office was promised; the term has to be ` +
      `renewed or the promise is broken`,
    severity: "critical",
  };
}

/** The provider's date, as an instant. Kept tolerant: `service_ends_at` is the
 * provider's own string and a shape we cannot parse must not be read as "no
 * risk" silently - it returns null and the caller treats that as unknown. */
export function parseServiceEndsAt(raw: string | null): number | null {
  if (!raw) return null;
  const asDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const ms = Date.parse(asDate);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The instants behind a retention incident, for the audit row.
 *
 * Every one of them moves or is overwritten somewhere - the provider's date on
 * renewal, the observation time by definition - which is exactly why they
 * cannot live in the dedup identity and must live in an append-only record
 * instead. Room rule: a measured claim carries its date.
 */
function datedEvidence(
  asset: AssetRow | null,
  promisedUntil: number | null,
  now: number,
): string {
  return (
    `service_ends_at=${asset?.service_ends_at ?? "unknown"} ` +
    `promisedUntil=${iso(promisedUntil)} observed=${iso(now)}`
  );
}

function iso(instant: number | null): string {
  return instant === null ? "unknown" : new Date(instant).toISOString();
}

// ------------------------------------------------------------------ payment
//
// The PAYMENT lifecycle (Nil, 2026-11-10: "treat like cancellation"). When
// Stripe's retries run out, dunning powers the box off. This machine keeps it 14
// days from that proven power-off, tells the customer the date first, and then
// asks the provider to delete it. Paying inside the window resumes the same box
// (resume.ts), as before. It never touches a customer cancellation: that is the
// machine above.

/**
 * When the payment deletion rule took effect (the hosted terms, "If a payment
 * fails"). A box powered off before this instant counts its 14 days from here,
 * so no box suspended under the old terms is deleted earlier than 14 days
 * after the change.
 */
export const PAYMENT_DELETION_EFFECTIVE_AT = Date.UTC(2026, 11, 1);

/** Evidence stamp that marks a row as belonging to the payment lifecycle. Not
 * LIFECYCLE_REASON: isLifecycleRow stays a cancellation-only predicate. */
export const PAYMENT_LIFECYCLE_REASON = "payment";

/** Attention key: deletion is due, and the customer has not been told. */
export const PAYMENT_DELETION_HELD = "payment-deletion-held";
/** Attention key: a payment arrived after the payment deletion started. */
export const PAYMENT_AFTER_DELETION = "payment-after-deletion";

/** The earliest deletion for a box powered off at `poweredOffAt`. */
export function paymentDeletionAt(poweredOffAt: number): number {
  return Math.max(poweredOffAt, PAYMENT_DELETION_EFFECTIVE_AT) + RETENTION_MS;
}

/** The payment lifecycle's operation ids, derived from the dunning episode. */
export function paymentOperationId(
  kind: OperationKind,
  episodeId: string,
): string {
  return `op-${kind}-payment-${episodeId}`;
}

/**
 * The resume operation's id, derived from the EPISODE the suspension belongs to
 * (resume.ts re-exports it). Same construction as `suspensionOperationId`: the
 * operations primary key then refuses a second resume for one episode.
 */
export function resumeOperationId(episodeId: string): string {
  return `op-power_on-${episodeId}`;
}

/** Did this operation come from the payment lifecycle? A stamp we wrote. */
export function isPaymentLifecycleRow(op: OperationRow): boolean {
  try {
    const parsed: unknown = JSON.parse(op.evidence);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    return (
      (parsed as Record<string, unknown>).reason === PAYMENT_LIFECYCLE_REASON
    );
  } catch {
    return false;
  }
}

export interface DunningSuspension {
  episode: string;
  /** The subscription the opener stamped, or null on a row without one. */
  subscription: string | null;
  /** The instant the handler proved the box off, or null on a row without one. */
  poweredOffAt: number | null;
}

/**
 * The dunning suspension this office is sitting in: the LATEST succeeded
 * dunning power_off, by the instant the handler recorded (a row without one
 * loses to any row with one), with the operation id as a deterministic
 * tie-break (row order is not a rule: created_at can tie, and taking the first
 * match once left a paying customer's box off). Never skips an episode that was
 * already resumed: a stale older
 * episode must not stand in for the newest one.
 */
export function latestDunningSuspension(
  operations: { id: string; kind: string; status: string; evidence: string }[],
): DunningSuspension | null {
  let best: { s: DunningSuspension; at: number; id: string } | null = null;
  for (const op of operations) {
    if (op.kind !== "power_off" || op.status !== "succeeded") continue;
    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(op.evidence);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      ev = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.reason !== "dunning") continue;
    if (typeof ev.episode !== "string" || ev.episode === "") continue;
    const poweredOffAt =
      typeof ev.poweredOffAt === "number" && Number.isFinite(ev.poweredOffAt)
        ? ev.poweredOffAt
        : null;
    const at = poweredOffAt ?? -Infinity;
    if (
      !best ||
      at > best.at ||
      (at === best.at && op.id.localeCompare(best.id) > 0)
    ) {
      best = {
        s: {
          episode: ev.episode,
          subscription:
            typeof ev.subscription === "string" ? ev.subscription : null,
          poweredOffAt,
        },
        at,
        id: op.id,
      };
    }
  }
  return best?.s ?? null;
}

export interface PaymentLifecycleInputs {
  instance: InstanceRow;
  asset: AssetRow | null;
  operations: OperationRow[];
  subscription: {
    id: string;
    status: string;
    endedAt: number | null;
    cancellationReason: string | null;
  };
  now: number;
}

/** Stripe statuses that mean the customer is paid up (dunning.ts, resume.ts). */
const PAID_UP = new Set(["active", "trialing"]);

/**
 * What the lifecycle tick does about one payment-suspended office. Phase
 * "serving" with nothing to open is the answer for every office this machine
 * does not own.
 *
 * The deletion date is the LATEST of three instants, so the server may be kept
 * longer than the mail says and never shorter:
 *   - paymentDeletionAt(poweredOffAt), from the proven power-off;
 *   - the date the mail named (`deletesAt`, fixed when the mail was opened, so
 *     moving PAYMENT_DELETION_EFFECTIVE_AT later never changes a date a
 *     customer already read);
 *   - 14 days after the mail actually went out (`sentAt`), so a mail that went
 *     out late still gives the customer 14 days.
 * Deletion waits for a mail that went out: we never delete the server of a
 * customer we did not tell.
 */
export function decidePaymentLifecycle(
  inputs: PaymentLifecycleInputs,
): LifecycleDecision {
  const { instance, asset, operations, subscription, now } = inputs;
  const clearHeld: AttentionAction = {
    kind: "clear",
    key: PAYMENT_DELETION_HELD,
  };
  const none = (note: string): LifecycleDecision => ({
    open: [],
    finish: false,
    attention: [clearHeld],
    phase: "serving",
    note,
  });

  // A customer cancellation is the cancellation machine's, start to end.
  if (isCustomerCancellation(subscription)) {
    return none("a customer cancellation; not the payment lifecycle's");
  }
  const suspension = latestDunningSuspension(operations);
  if (!suspension) return none("no dunning suspension");
  const episode = suspension.episode;
  if (
    operations.some(
      (op) => op.id === resumeOperationId(episode) && op.status === "succeeded",
    )
  ) {
    return none("the dunning suspension was resumed");
  }
  if (PAID_UP.has(subscription.status)) {
    return none(`the subscription is ${subscription.status} again`);
  }
  // No proven power-off, no clock: a box that might still serve is never
  // deleted.
  if (suspension.poweredOffAt === null) {
    return none("the suspension has no proven power-off instant");
  }

  const noticeId = paymentOperationId("payment_notice", episode);
  const noticeRow = operations.find((op) => op.id === noticeId) ?? null;
  const named = noticeRow ? numberEvidence(noticeRow, "deletesAt") : null;
  const sentAt =
    noticeRow?.status === "succeeded"
      ? numberEvidence(noticeRow, "sentAt")
      : null;
  const computed = paymentDeletionAt(suspension.poweredOffAt);
  // Before the mail went out this is the earliest the deletion can be; after,
  // it is the deletion date.
  const promised = Math.max(
    computed,
    named ?? -Infinity,
    sentAt === null ? -Infinity : sentAt + RETENTION_MS,
  );
  const atRisk = promiseAtRisk(asset, promised);
  const stamp = {
    reason: PAYMENT_LIFECYCLE_REASON,
    subscription: subscription.id,
    episode,
  };

  if (asset && GONE_STATES.has(asset.asset_state)) {
    // The same rule as the cancellation's ended arm: provider truth records
    // the data end, and an end before the promised date is a broken promise.
    const early =
      atRisk !== null ||
      (parseServiceEndsAt(asset.service_ends_at) === null && now < promised);
    return {
      open: [
        {
          kind: "remove_dns",
          id: paymentOperationId("remove_dns", episode),
          evidence: { ...stamp, assetState: asset.asset_state },
        },
      ],
      finish: instance.service_state !== "deprovisioned",
      attention: [
        clearHeld,
        { kind: "clear", key: LIFECYCLE_ASSET_GONE },
        { kind: "clear", key: PROMISE_AT_RISK },
        ...(early
          ? [
              {
                kind: "raise" as const,
                key: PROMISE_BROKEN,
                reason:
                  `the provider asset for this office ended BEFORE the ` +
                  `${iso(promised)} the customer was promised; the payment ` +
                  `suspension promise was broken and the data is already gone`,
                severity: "critical" as const,
                detail: datedEvidence(asset, promised, now),
              },
            ]
          : []),
      ],
      phase: "ended",
      note: early
        ? `provider ended the asset EARLY (${asset.asset_state}); promise broken`
        : `provider reports the asset ${asset.asset_state}; data end recorded`,
    };
  }

  if (instance.service_state !== "suspended") {
    return none(`the office is ${instance.service_state}, not suspended`);
  }

  const open: LifecycleDecision["open"] = [];
  const attention: AttentionAction[] = [
    atRisk
      ? {
          kind: "raise",
          key: PROMISE_AT_RISK,
          ...atRisk,
          detail: datedEvidence(asset, promised, now),
        }
      : { kind: "clear", key: PROMISE_AT_RISK },
  ];
  if (!noticeRow) {
    open.push({
      kind: "payment_notice",
      id: noticeId,
      evidence: { ...stamp, deletesAt: computed },
    });
  }
  if (sentAt === null) {
    // Held: the date has come and the customer has not been told. One key,
    // one sentence, no date in it; cleared by this same arm once the mail
    // went out, the customer paid, or the box ended.
    attention.push(
      now >= promised
        ? {
            kind: "raise",
            key: PAYMENT_DELETION_HELD,
            reason:
              "this office's payment deletion is due, and the suspension mail " +
              "to the customer has not gone out; the server is kept until it does",
            severity: "warning",
          }
        : clearHeld,
    );
    return {
      open,
      finish: false,
      attention,
      phase: "suspended",
      note: `payment suspension; mail not sent yet (deletion not before ${iso(promised)})`,
    };
  }
  attention.push(clearHeld);
  if (now < promised) {
    return {
      open,
      finish: false,
      attention,
      phase: "suspended",
      note: `payment suspension; deletion due ${iso(promised)}`,
    };
  }
  for (const kind of ["cancel_asset", "remove_dns"] as const) {
    open.push({
      kind,
      id: paymentOperationId(kind, episode),
      evidence: { ...stamp, deletesAt: promised },
    });
  }
  return {
    open,
    finish: false,
    attention,
    phase: "deprovision_due",
    note: `payment deletion due ${iso(promised)}`,
  };
}

/**
 * The work schedule's view of the payment lifecycle (store.workSchedule), as
 * SQL over the caller's placeholders. Clause for clause the same rule as
 * decidePaymentLifecycle, so a pass the schedule wakes does work, and handled
 * work goes idle.
 *
 * `cte`: the offices the payment arm owns - the latest succeeded dunning
 * power_off per office (by its recorded instant, then id), with a proven
 * instant, on a subscription that is not paid up, not a customer cancellation,
 * not resumed for that episode, on a suspended office. `computed` is
 * paymentDeletionAt. The CASE keeps the jsonb cast off rows that are not
 * dunning stamps.
 * `due`: the mail when it was never opened; the deletion at the latest of the
 * three instants once the mail went out; the held row's raise once the date
 * came with no mail sent, and its clear once that stopped being true.
 * `times`: the next instants the deletion or the held raise fall due.
 */
export function paymentScheduleSql(p: {
  now: string;
  retention: string;
  enabled: string;
  effective: string;
  heldKey: string;
}): { cte: string; due: string; times: string } {
  const named = "greatest(p.computed, coalesce(p.deletes_at, p.computed))";
  const deleteAt = `greatest(p.computed, coalesce(p.deletes_at, p.computed), p.sent_at + ${p.retention})`;
  const cte =
    "dunning as (select distinct on (o.instance_id) o.instance_id, " +
    "j.ev ->> 'episode' as episode, j.ev ->> 'subscription' as subscription, " +
    "(j.ev ->> 'poweredOffAt')::bigint as powered_off_at from operations o " +
    'cross join lateral (select case when o.evidence like \'%"reason":"dunning"%\' ' +
    "then o.evidence::jsonb end as ev) j " +
    "where o.kind = 'power_off' and o.status = 'succeeded' and j.ev ->> 'reason' = 'dunning' " +
    "and coalesce(j.ev ->> 'episode', '') <> '' " +
    "order by o.instance_id, (j.ev ->> 'poweredOffAt')::bigint desc nulls last, o.id desc), " +
    `payment as (select d.instance_id, greatest(d.powered_off_at, ${p.effective}) + ${p.retention} as computed, ` +
    "n.status as notice_status, (n.ev ->> 'deletesAt')::bigint as deletes_at, " +
    "case when n.status = 'succeeded' then (n.ev ->> 'sentAt')::bigint end as sent_at, " +
    "exists (select 1 from operations c where c.id = 'op-cancel_asset-payment-' || d.episode) as deleting, " +
    "exists (select 1 from attention_reasons r where r.instance_id = d.instance_id " +
    `and r.cleared_at is null and r.source_op_id = ${p.heldKey}) as held_open ` +
    "from dunning d join subscriptions s on s.id = d.subscription and s.instance_id = d.instance_id " +
    "join instances i on i.id = d.instance_id " +
    "left join lateral (select n0.status, n0.evidence::jsonb as ev from operations n0 " +
    "where n0.id = 'op-payment_notice-payment-' || d.episode) n on true " +
    "where d.powered_off_at is not null " +
    `and not (s.ended_at is not null and s.cancellation_reason = '${CUSTOMER_CANCELLATION_REASON}') ` +
    "and s.status not in ('active', 'trialing') " +
    "and not exists (select 1 from operations p where p.id = 'op-power_on-' || d.episode " +
    "and p.status = 'succeeded') and i.service_state = 'suspended')";
  const due =
    "(exists (select 1 from payment p where p.notice_status is null " +
    `or (p.sent_at is not null and not p.deleting and ${p.now} >= ${deleteAt}) ` +
    `or (p.sent_at is null and not p.held_open and ${p.now} >= ${named})) ` +
    "or exists (select 1 from attention_reasons r where r.cleared_at is null " +
    `and r.source_op_id = ${p.heldKey} and not exists (select 1 from payment p ` +
    `where p.instance_id = r.instance_id and p.sent_at is null and ${p.now} >= ${named})))`;
  const times =
    `union all select ${deleteAt} from payment p where ${p.enabled} = 1 ` +
    "and p.sent_at is not null and not p.deleting " +
    `union all select ${named} from payment p where ${p.enabled} = 1 ` +
    "and p.sent_at is null and not p.held_open";
  return { cte, due, times };
}
