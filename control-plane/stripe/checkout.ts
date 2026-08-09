// Creating a Checkout session, and the two validations the design puts at that
// boundary.
//
// Checkout is the only place a customer's chosen office name arrives, and the
// design refuses a name that is not a DNS label or that shadows a hostname we
// serve centrally. Both are pure syntax rules and both are here.
//
// Cross-account UNIQUENESS is deliberately not here: it needs a durable
// reservation taken at signup, and signup is slice 4's web app. Nothing in this
// file, and nothing in the metadata it writes, makes a name unique - a second
// account can pass the same name and both sessions will be created. Slice 4 owns
// the reservation.
//
// This file writes NOTHING to the store. A Checkout session is a Stripe object and
// a redirect; the subscription row appears when a webhook reconciles a fetched
// subscription, never from a session or a success_url.

import type { FormValue, StripeClient } from "./client.ts";
import { createOwnedCustomer } from "./test-clock.ts";
import {
  META_ACCOUNT,
  META_EMAIL,
  META_INSTANCE,
  META_OFFICE_NAME,
} from "./reconcile.ts";

/**
 * Names we serve centrally, so a customer's office may not take them.
 *
 * The design's list plus the obvious operational neighbours. It is a plain
 * constant rather than configuration: a name that shadows our own hostnames is
 * wrong on every deployment, not just this one.
 */
export const RESERVED_OFFICE_NAMES = new Set([
  "admin",
  "api",
  "apps",
  "assets",
  "auth",
  "billing",
  "blog",
  "cdn",
  "cloud",
  "dashboard",
  "dev",
  "docs",
  "ftp",
  "help",
  "imap",
  "isomux",
  "localhost",
  "login",
  "mail",
  "ns1",
  "ns2",
  "smtp",
  "staging",
  "static",
  "status",
  "support",
  "test",
  "webhook",
  "webhooks",
  "www",
]);

export type NameVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A customer's office name: a DNS label, and not one of ours.
 *
 * Strict on purpose. The name becomes a hostname, a certificate subject and the
 * origin of every link and cookie the customer holds, and the design makes it
 * immutable after provisioning - so a name that merely "mostly works" is a
 * problem nobody can fix later.
 */
export function validateOfficeName(raw: string): NameVerdict {
  if (raw !== raw.toLowerCase()) {
    return { ok: false, reason: "an office name must be lower case" };
  }
  if (raw.length < 1 || raw.length > 63) {
    return {
      ok: false,
      reason: "an office name must be 1 to 63 characters (it is one DNS label)",
    };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(raw)) {
    return {
      ok: false,
      reason:
        "an office name may hold only a-z, 0-9 and hyphens, and must start and " +
        "end with a letter or digit",
    };
  }
  if (raw.startsWith("xn--")) {
    return {
      ok: false,
      reason: "an office name may not start with xn-- (reserved for punycode)",
    };
  }
  if (RESERVED_OFFICE_NAMES.has(raw)) {
    return {
      ok: false,
      reason: `"${raw}" is a hostname we serve centrally, so an office cannot take it`,
    };
  }
  return { ok: true };
}

// --------------------------------------------------------- verified discounts

declare const fullDiscountBrand: unique symbol;

/**
 * A coupon PROVEN to be a live 100%-off discount in test mode.
 *
 * The brand is the point: `checkoutParams` asks for this type, and the only way to
 * obtain one is `verifyFullDiscount`, which fetches the coupon and checks it. A
 * coupon ID STRING IS NOT PROOF - a 50%-off or expired coupon carries the same
 * shape - and the design only permits Checkout to skip collecting a card when
 * nothing is owed. Before this type existed, any `--coupon` argument turned
 * `payment_method_collection` into `if_required` and a partially discounted signup
 * would have gone through with no payment method at all.
 */
export interface FullDiscount {
  readonly couponId: string;
  readonly [fullDiscountBrand]: true;
}

export type DiscountVerdict =
  | { ok: true; discount: FullDiscount }
  /** The coupon exists and is not a full discount. Retrying changes nothing. */
  | { ok: false; retryable: false; reason: string }
  /** We could not establish what the coupon is. NO session may be created. */
  | { ok: false; retryable: true; reason: string };

/**
 * Fetch a coupon and decide whether it is a full discount.
 *
 * Every refusal is explicit, including the ones that look like edge cases: an
 * amount-off coupon has no percentage, an expired or exhausted coupon reports
 * `valid: false`, and a coupon that reports live mode means this code is talking to
 * the wrong account.
 */
export async function verifyFullDiscount(
  client: StripeClient,
  couponId: string,
): Promise<DiscountVerdict> {
  const res = await client.get(`/v1/coupons/${encodeURIComponent(couponId)}`);
  if (res.kind === "ambiguous") {
    return {
      ok: false,
      retryable: true,
      reason: `could not read the coupon: ${res.reason}`,
    };
  }
  if (res.kind === "rejected") {
    return res.status === 404
      ? { ok: false, retryable: false, reason: "no such coupon" }
      : { ok: false, retryable: true, reason: res.reason };
  }
  const coupon = res.body;
  if (coupon.livemode !== false) {
    return {
      ok: false,
      retryable: false,
      reason:
        "the coupon is not test mode; refusing to build a session around a live " +
        "coupon",
    };
  }
  if (coupon.valid !== true) {
    return {
      ok: false,
      retryable: false,
      reason: "the coupon is not valid (expired, or fully redeemed)",
    };
  }
  if (typeof coupon.percent_off !== "number" || coupon.percent_off !== 100) {
    const seen =
      typeof coupon.percent_off === "number"
        ? `${coupon.percent_off}% off`
        : typeof coupon.amount_off === "number"
          ? "an amount-off coupon"
          : "no percentage";
    return {
      ok: false,
      retryable: false,
      reason:
        `this is ${seen}, not a 100% discount, so Checkout must still collect a ` +
        `card; pass it as an ordinary discount or use a full-discount coupon`,
    };
  }
  // The brand is TYPE-ONLY - `declare const` has no runtime value - so the cast is
  // how the verified value is minted. Nothing ever reads the brand; it exists to
  // make this function the only place a FullDiscount can come from.
  return { ok: true, discount: { couponId } as unknown as FullDiscount };
}

export interface CheckoutArgs {
  accountId: string;
  email: string;
  officeName: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** A VERIFIED full discount. Its presence is what makes this the comped path,
   * and its type is what stops an unverified coupon id getting here. */
  discount?: FullDiscount;
  /** An existing Stripe customer - how a test-clock customer reaches Checkout.
   * Mutually exclusive with letting Checkout collect the email. */
  customerId?: string;
  /** Pre-linked instance, when the caller already has one. Slice 4 sets this from
   * the provisioning flow. */
  instanceId?: string;
}

export interface CheckoutSessionCreated {
  id: string;
  url: string | null;
  /** Echoed back so the caller can RECORD what Stripe decided, rather than assume
   * that asking for `if_required` was honoured. */
  paymentMethodCollection: string | null;
  livemode: boolean;
}

/**
 * Build the parameters for a Checkout session.
 *
 * Separated from the call so the shape is testable without a client, and so the
 * one interesting branch - the comped path - is a value rather than a mock
 * expectation.
 */
export function checkoutParams(args: CheckoutArgs): Record<string, FormValue> {
  const metadata: Record<string, FormValue> = {
    [META_ACCOUNT]: args.accountId,
    [META_EMAIL]: args.email,
    [META_OFFICE_NAME]: args.officeName,
    ...(args.instanceId ? { [META_INSTANCE]: args.instanceId } : {}),
  };
  return {
    mode: "subscription",
    "line_items[0][price]": args.priceId,
    "line_items[0][quantity]": 1,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    // NO TRIAL (ruling 1): the card is charged at checkout. The only reason a
    // card is not collected is that a 100% discount leaves nothing to charge.
    // `if_required` ONLY behind a verified full discount: nothing is owed, so
    // Checkout has nothing to collect a card for. Anything less than 100% off still
    // charges today and still needs one.
    payment_method_collection: args.discount ? "if_required" : "always",
    ...(args.discount
      ? { "discounts[0][coupon]": args.discount.couponId }
      : {}),
    ...(args.customerId
      ? { customer: args.customerId }
      : { customer_email: args.email }),
    metadata,
    // Mirrored onto the subscription so `customer.subscription.*` events carry
    // the linkage too. An update that arrives before the session's own event must
    // still be able to establish the row.
    subscription_data: { metadata },
  };
}

export async function createCheckoutSession(
  client: StripeClient,
  args: CheckoutArgs,
  idempotencyKey: string,
): Promise<CheckoutSessionCreated> {
  const verdict = validateOfficeName(args.officeName);
  if (!verdict.ok) throw new Error(verdict.reason);

  const res = await client.post(
    "/v1/checkout/sessions",
    checkoutParams(args),
    idempotencyKey,
  );
  if (res.kind !== "ok") {
    throw new Error(`could not create a Checkout session: ${res.reason}`);
  }
  const body = res.body;
  const livemode = body.livemode;
  if (livemode !== false) {
    // Defence in depth behind the key check: a session that reports live mode
    // means this code is talking to the real account.
    throw new Error(
      "the Checkout session Stripe returned is not test mode; stopping before " +
        "any URL is handed to anyone",
    );
  }
  return {
    id: String(body.id),
    url: typeof body.url === "string" ? body.url : null,
    paymentMethodCollection:
      typeof body.payment_method_collection === "string"
        ? body.payment_method_collection
        : null,
    livemode: false,
  };
}

// ------------------------------------------------------- opening a checkout

export interface OpenCheckoutArgs extends Omit<
  CheckoutArgs,
  "discount" | "customerId"
> {
  /** An unverified coupon id, as a human typed it. Verified here or refused. */
  couponId?: string;
  /** A customer the caller already owns - a test-clock one, say. When absent, one
   * is created and TAGGED so cleanup can find it later. */
  customerId?: string;
  /** Names the created customer `cp3-<label>`. */
  label: string;
  idempotencyKeys: { customer: string; session: string };
}

export type OpenCheckoutResult =
  | { ok: true; session: CheckoutSessionCreated; customerId: string }
  | { ok: false; retryable: boolean; reason: string };

/**
 * The whole sequence, in the one order that leaves nothing behind:
 *
 *   1. VERIFY the coupon, if one was named. Read-only, so a refusal here has
 *      created nothing at all.
 *   2. CREATE the customer, tagged, and check what came back.
 *   3. CREATE the session.
 *
 * It lives here rather than in the CLI because the property worth testing is what
 * does NOT happen: a refused coupon must leave no customer, and a refused customer
 * must leave no session. That cannot be asserted about code that only exists inside
 * a command.
 */
export async function openCheckout(
  client: StripeClient,
  args: OpenCheckoutArgs,
): Promise<OpenCheckoutResult> {
  const verdict = validateOfficeName(args.officeName);
  if (!verdict.ok)
    return { ok: false, retryable: false, reason: verdict.reason };

  let discount: FullDiscount | undefined;
  if (args.couponId) {
    const coupon = await verifyFullDiscount(client, args.couponId);
    if (!coupon.ok) {
      return {
        ok: false,
        retryable: coupon.retryable,
        reason: `--coupon ${args.couponId} cannot be used as a full discount: ${coupon.reason}`,
      };
    }
    discount = coupon.discount;
  }

  let customerId = args.customerId;
  if (!customerId) {
    const created = await createOwnedCustomer(
      client,
      { email: args.email, label: args.label },
      args.idempotencyKeys.customer,
    );
    if (!created.ok) {
      return {
        ok: false,
        retryable: created.retryable,
        reason: created.reason,
      };
    }
    customerId = created.id;
  }

  const session = await createCheckoutSession(
    client,
    { ...args, discount, customerId },
    args.idempotencyKeys.session,
  );
  return { ok: true, session, customerId };
}
