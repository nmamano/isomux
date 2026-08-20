// The one seam through which webhook handling learns what Stripe currently says.
//
// A webhook event is a NOTIFICATION, not truth. Two events for the same
// subscription can carry the same one-second `created` value, so ordering them by
// their own timestamps cannot be made correct - the older payload would overwrite
// the newer one and the state would silently regress. So every accepted event
// causes a fetch of the object it is about, and reconciliation writes from THAT.
// Replays and reorderings then converge by construction: whichever event triggers
// the fetch, the fetch returns the same current object.
//
// The seam is injected, which is what makes all of this testable without a live
// account: the stub tier hands the reconciler deterministic snapshots, including
// the pathological ones (a live-mode object, an absent object, an unavailable
// read).

import type { StripeClient } from "./client.ts";
import type { StripeMode } from "./mode.ts";
import {
  MalformedStripeObject,
  normalizeInvoice,
  normalizeSession,
  normalizeSubscription,
  type InvoiceSnapshot,
  type SessionSnapshot,
  type SubscriptionSnapshot,
} from "./shapes.ts";

/** A fetched object disagreed with configured mode. Defence in depth behind the
 * key and event checks; never retried or downgraded to "unavailable". */
export class StripeModeObjectRefused extends Error {}

export type ReadResult<T> =
  | { kind: "ok"; object: T }
  /** Stripe says there is no such object. A real answer, not a failure. */
  | { kind: "absent" }
  /** We could not get an answer. The caller must commit NOTHING and let Stripe
   * redeliver. */
  | { kind: "unavailable"; reason: string };

export interface StripeObjectReader {
  getSubscription(id: string): Promise<ReadResult<SubscriptionSnapshot>>;
  getInvoice(id: string): Promise<ReadResult<InvoiceSnapshot>>;
  getCheckoutSession(id: string): Promise<ReadResult<SessionSnapshot>>;
}

export class LiveStripeReader implements StripeObjectReader {
  constructor(
    private readonly client: StripeClient,
    private readonly mode: StripeMode,
  ) {}

  async getSubscription(id: string): Promise<ReadResult<SubscriptionSnapshot>> {
    // `discounts.source.coupon`, not `discounts`.
    //
    // OBSERVED 2026-08-09 on API version 2026-07-29.dahlia: an expanded discount
    // carries `source: {type: "coupon", coupon: "<id>"}` and NO percentage. The
    // percentage - which is the whole signal for "comped" - only arrives when the
    // coupon behind the source is expanded too. Expanding `discounts` alone looks
    // like it works and silently yields a discount with no percentage.
    return this.read(
      id,
      { expand: ["discounts.source.coupon"] },
      "subscriptions",
      normalizeSubscription,
    );
  }

  async getInvoice(id: string): Promise<ReadResult<InvoiceSnapshot>> {
    return this.read(id, {}, "invoices", normalizeInvoice);
  }

  async getCheckoutSession(id: string): Promise<ReadResult<SessionSnapshot>> {
    return this.read(id, {}, "checkout/sessions", normalizeSession);
  }

  private async read<T extends { livemode: boolean; id: string }>(
    id: string,
    query: Record<string, string[] | string>,
    collection: string,
    normalize: (raw: unknown) => T,
  ): Promise<ReadResult<T>> {
    const res = await this.client.get(
      `/v1/${collection}/${encodeURIComponent(id)}`,
      query,
    );
    if (res.kind === "ambiguous") {
      return { kind: "unavailable", reason: res.reason };
    }
    if (res.kind === "rejected") {
      // 404 is an ANSWER: the object does not exist. Everything else leaves us
      // without one.
      if (res.status === 404) return { kind: "absent" };
      return { kind: "unavailable", reason: res.reason };
    }
    // Malformed is deliberately a THROW rather than "unavailable": a second
    // identical fetch returns the same object, so retrying it forever would be a
    // silent loop instead of a visible stop.
    const object = normalize(res.body);
    assertStripeMode(object, collection, this.mode);
    return { kind: "ok", object };
  }
}

/**
 * Refuse an object from the other Stripe mode.
 *
 * Exported so a non-live reader implementation (a recorded-fixture reader, a
 * test double meant to be realistic) applies exactly the same rule as the live
 * one, instead of each seam inventing its own.
 */
export function assertStripeMode(
  object: { livemode: boolean; id: string },
  what: string,
  mode: StripeMode,
): void {
  if (object.livemode !== (mode === "live")) {
    throw new StripeModeObjectRefused(
      `the Stripe ${what} object does not match configured ${mode} mode; refusing to read or write it`,
    );
  }
}

export { MalformedStripeObject };
