// Stripe objects, normalised into the small snapshots this slice reasons about.
//
// This layer exists because the pinned API version moved fields that older
// documentation and most example code still put at the top level:
//
//   - a subscription's period end lives on its ITEMS (`items.data[].
//     current_period_end`) since the 2025-03-31 version, not on the subscription;
//   - an invoice names its subscription through `parent.subscription_details.
//     subscription` rather than `invoice.subscription`;
//   - a subscription's discount is the `discounts` ARRAY, not the singular
//     `discount`.
//
// Each reader below takes the new location first and falls back to the old one,
// so the same code works if the pin moves either way, and the fallbacks are unit
// tested against both shapes rather than only against whatever the live account
// happened to return.
//
// `livemode` is carried on every snapshot on purpose: the refusal that keeps
// test-mode-only code away from real customer data is enforced on the object, not
// only on the event that mentioned it.

/** A Stripe object arrived without the fields we must have. Never retried: a
 * second identical fetch produces the same object. */
export class MalformedStripeObject extends Error {}

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  /** Milliseconds, or null when the object carries no period at all. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** Milliseconds. Null while the subscription is alive; set once, at the instant
   * service ended, and measured 2026-08-10 to survive on the terminal object. */
  endedAt: number | null;
  /** Milliseconds. Reverted to null by an un-cancel (measured 2026-08-10), so it
   * carries the CURRENT intent rather than a history. */
  canceledAt: number | null;
  /** `cancellation_details.reason`: "cancellation_requested" for the customer's
   * own act, "payment_failed" for a dunning cancellation. */
  cancellationReason: string | null;
  discount: {
    couponId: string;
    percentOff: number | null;
    /** Milliseconds; null means the discount does not expire on its own. */
    endsAt: number | null;
  } | null;
  latestInvoiceId: string | null;
  metadata: Record<string, string>;
  livemode: boolean;
}

export interface InvoiceSnapshot {
  id: string;
  subscriptionId: string | null;
  customerId: string | null;
  status: string;
  amountDue: number;
  attemptCount: number;
  /** Milliseconds. Null is Stripe saying it will not try again by itself, which
   * is the evidence the dunning ladder waits for. */
  nextPaymentAttempt: number | null;
  paid: boolean;
  livemode: boolean;
}

export interface SessionSnapshot {
  id: string;
  subscriptionId: string | null;
  customerId: string | null;
  status: string | null;
  paymentStatus: string | null;
  /** Recorded because it is the verify-at-implementation item: what Checkout does
   * with `if_required` on a fully discounted subscription. */
  paymentMethodCollection: string | null;
  metadata: Record<string, string>;
  livemode: boolean;
}

type Raw = Record<string, unknown>;

export function normalizeSubscription(raw: unknown): SubscriptionSnapshot {
  const o = objectOf(raw, "subscription");
  const id = stringField(o, "id", "subscription");
  const status = stringField(o, "status", "subscription");
  return {
    id,
    customerId: idOf(o.customer, "subscription.customer", id),
    status,
    currentPeriodEnd: periodEndOf(o),
    cancelAtPeriodEnd: o.cancel_at_period_end === true,
    endedAt: secondsToMs(o.ended_at),
    canceledAt: secondsToMs(o.canceled_at),
    cancellationReason: cancellationReasonOf(o),
    discount: discountOf(o),
    latestInvoiceId: optionalId(o.latest_invoice),
    metadata: metadataOf(o.metadata),
    livemode: booleanField(o, "livemode", `subscription ${id}`),
  };
}

export function normalizeInvoice(raw: unknown): InvoiceSnapshot {
  const o = objectOf(raw, "invoice");
  const id = stringField(o, "id", "invoice");
  return {
    id,
    subscriptionId: invoiceSubscriptionOf(o),
    customerId: optionalId(o.customer),
    status: stringField(o, "status", `invoice ${id}`),
    amountDue: numberOr(o.amount_due, 0),
    attemptCount: numberOr(o.attempt_count, 0),
    nextPaymentAttempt: secondsToMs(o.next_payment_attempt),
    paid: paidOf(o),
    livemode: booleanField(o, "livemode", `invoice ${id}`),
  };
}

/**
 * Whether this invoice is settled.
 *
 * OBSERVED 2026-08-09 on API version 2026-07-29.dahlia: an invoice has NO `paid`
 * boolean. It reports `status` and `amount_remaining`, so reading `paid` alone
 * would call every invoice unpaid - including settled ones. The boolean is still
 * honoured first for an older pin.
 */
function paidOf(o: Raw): boolean {
  if (typeof o.paid === "boolean") return o.paid;
  if (o.status === "paid") return true;
  return (
    typeof o.amount_remaining === "number" &&
    o.amount_remaining === 0 &&
    o.status !== "draft" &&
    o.status !== "open"
  );
}

export function normalizeSession(raw: unknown): SessionSnapshot {
  const o = objectOf(raw, "checkout session");
  const id = stringField(o, "id", "checkout session");
  return {
    id,
    subscriptionId: optionalId(o.subscription),
    customerId: optionalId(o.customer),
    status: typeof o.status === "string" ? o.status : null,
    paymentStatus:
      typeof o.payment_status === "string" ? o.payment_status : null,
    paymentMethodCollection:
      typeof o.payment_method_collection === "string"
        ? o.payment_method_collection
        : null,
    metadata: metadataOf(o.metadata),
    livemode: booleanField(o, "livemode", `checkout session ${id}`),
  };
}

// ----------------------------------------------------------------- helpers

/**
 * The period end, from the subscription ITEM first.
 *
 * The item is where the pinned version puts it. The top-level field is read as a
 * fallback so an older pin still works, and the maximum across items is taken
 * because a subscription with several items has one period per item and the
 * latest is the one the customer is paid up to.
 */
function periodEndOf(o: Raw): number | null {
  const items = (o.items as Raw | undefined)?.data;
  if (Array.isArray(items)) {
    const ends = items
      .map((item) => secondsToMs((item as Raw)?.current_period_end))
      .filter((v): v is number => v !== null);
    if (ends.length > 0) return Math.max(...ends);
  }
  return secondsToMs(o.current_period_end);
}

/**
 * `cancellation_details.reason`, and nothing else out of that object.
 *
 * `comment` and `feedback` are customer-authored free text - a cancellation
 * survey - so they are deliberately not read: nothing in this codebase needs
 * them, and a durable column holding text somebody typed is a liability the
 * timeline gains nothing from.
 */
function cancellationReasonOf(o: Raw): string | null {
  const details = o.cancellation_details as Raw | null | undefined;
  const reason = details?.reason;
  return typeof reason === "string" && reason ? reason : null;
}

/**
 * The invoice's subscription, from `parent.subscription_details` first.
 *
 * A one-off invoice legitimately has no subscription, so an absent id is null
 * rather than an error - the caller decides whether that matters.
 */
function invoiceSubscriptionOf(o: Raw): string | null {
  const parent = o.parent as Raw | undefined;
  const details = parent?.subscription_details as Raw | undefined;
  const fromParent = optionalId(details?.subscription);
  if (fromParent) return fromParent;
  return optionalId(o.subscription);
}

/**
 * The active discount, from the `discounts` array.
 *
 * OBSERVED 2026-08-09 on API version 2026-07-29.dahlia, against a real coupon
 * applied at Checkout: a discount object does NOT carry a `coupon` field. It
 * carries `source: {type: "coupon", coupon: "<id>"}`, and the percentage only
 * appears if the fetch expands `discounts.source.coupon` - which the reader does.
 * The older `discount.coupon` shape is still read as a fallback, so this works
 * either side of that change.
 *
 * Only ONE discount is modelled, because the design's comped path is a single
 * 100%-off coupon. If Stripe ever reports several, the largest percentage is the
 * one that decides whether anything is owed, which is the only question the
 * ladder asks.
 */
function discountOf(o: Raw): SubscriptionSnapshot["discount"] {
  const candidates: unknown[] = [];
  if (Array.isArray(o.discounts)) candidates.push(...o.discounts);
  if (o.discount) candidates.push(o.discount);

  let best: SubscriptionSnapshot["discount"] = null;
  for (const raw of candidates) {
    // A DISCOUNT WE CANNOT SEE INTO IS NOT "NO DISCOUNT".
    //
    // An event payload carries `discounts: ["di_..."]` - bare ids. Reading that as
    // absence would tell the ladder a comped subscription is no longer comped,
    // which is exactly the wrong answer and a silent one. So it stops here instead,
    // naming the fetch that would have answered it.
    if (typeof raw === "string") {
      throw new MalformedStripeObject(
        `this subscription's discount arrived as a bare id, so nothing can be ` +
          `said about it; fetch the subscription with expand[]=discounts.source.coupon ` +
          `rather than deciding from an unexpanded object`,
      );
    }
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Raw;
    const source = d.source as Raw | undefined;
    const couponValue = source?.coupon ?? d.coupon;
    if (typeof couponValue === "string") {
      throw new MalformedStripeObject(
        `this subscription's coupon arrived as a bare id, so its percentage is ` +
          `unknown; fetch with expand[]=discounts.source.coupon`,
      );
    }
    const coupon =
      couponValue && typeof couponValue === "object"
        ? (couponValue as Raw)
        : undefined;
    const couponId = optionalId(coupon) ?? optionalId(d.id);
    if (!couponId) continue;
    // Null is legitimate here and does NOT mean unknown: an amount-off coupon has
    // no percentage, and it is honestly not a 100% discount.
    const percentOff =
      typeof coupon?.percent_off === "number" ? coupon.percent_off : null;
    const entry = { couponId, percentOff, endsAt: secondsToMs(d.end) };
    if (!best || (percentOff ?? 0) > (best.percentOff ?? 0)) best = entry;
  }
  return best;
}

function objectOf(raw: unknown, what: string): Raw {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MalformedStripeObject(`expected a Stripe ${what} object`);
  }
  return raw as Raw;
}

function stringField(o: Raw, field: string, what: string): string {
  const v = o[field];
  if (typeof v !== "string" || v === "") {
    throw new MalformedStripeObject(`${what} has no ${field}`);
  }
  return v;
}

/**
 * `livemode` must be a real boolean.
 *
 * A missing or non-boolean field is malformed rather than "probably test mode":
 * treating absence as false is exactly how live data would slip through.
 */
function booleanField(o: Raw, field: string, what: string): boolean {
  const v = o[field];
  if (typeof v !== "boolean") {
    throw new MalformedStripeObject(
      `${what} has no boolean ${field}; refusing to guess which mode it belongs to`,
    );
  }
  return v;
}

/** An id that may arrive as a bare string or as an expanded object. */
function optionalId(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v && typeof v === "object") {
    const id = (v as Raw).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function idOf(v: unknown, what: string, owner: string): string {
  const id = optionalId(v);
  if (!id) throw new MalformedStripeObject(`${owner}: ${what} is missing`);
  return id;
}

function metadataOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Raw)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

/** Stripe timestamps are unix SECONDS; every time in our schema is milliseconds. */
function secondsToMs(v: unknown): number | null {
  return typeof v === "number" ? v * 1000 : null;
}
