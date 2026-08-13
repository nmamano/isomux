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

  if (facts.assetGone) {
    return { ...base, phase: "ended" };
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

/**
 * What to do about a condition.
 *
 * Two kinds, because one of these conditions is REVERSIBLE and the other is
 * not. A provider term that lapses too early can be renewed, and an incident
 * that stays open after the danger passed teaches an operator to ignore the
 * floor. A promise that was actually broken cannot be un-broken, so nothing
 * ever clears it.
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
      },
      now,
    ),
  };
}

/** Provider states that mean the asset is really gone, not merely scheduled. */
const GONE_STATES = new Set(["cancelled", "absent"]);

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
  if (!terminal) {
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
    return none("not a customer cancellation");
  }

  const endedAt = subscription.endedAt!;
  const state = cancellationStateFrom(subscription, operations, asset, now)!;
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
      open: [],
      // Deprovisioned is recorded from PROVIDER TRUTH and nothing else. Our own
      // deadline passing is a request, not a deletion.
      finish: instance.service_state !== "deprovisioned",
      attention: [
        { kind: "clear" as const, key: LIFECYCLE_REPOWERED },
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
