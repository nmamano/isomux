// The whole of this app's access to the control plane.
//
// THIS IS THE ONLY FILE THAT MAY OPEN THE STORE, and it hands no store out.
// Every export below returns plain, already-serialised data, so no page, layout
// or route handler ever holds an object carrying the database handle, the
// transaction opener, an enqueue or a compare-and-set. A boundary test asserts
// both halves of that: this file's export list, and the absence of raw store
// access everywhere else under web/.
//
// Every control-plane import is a REQUEST-TIME dynamic import. Two reasons, and
// both are load-bearing:
//
//   - the store speaks bun:sqlite, and `next build` runs under Node, where that
//     module does not exist. Next evaluates every page and route module while
//     collecting page data, so a module-scope import would fail the build. The
//     build is therefore the enforcement of this rule, not a comment about it.
//   - it keeps the module graph of the public app free of the driver: nothing
//     here reaches keys, ssh, handlers or the webhook path.
//
// One Store per request, closed in a finally. The connection is cheap, and a
// process-lifetime handle would outlive dev-server hot reloads.

import type { ProgressView } from "../../progress";

export type { ProgressView };

function databasePath(): string {
  const configured = process.env.CONTROL_PLANE_DB;
  if (configured) return configured;
  throw new Error(
    "CONTROL_PLANE_DB is not set: this app never guesses which control-plane " +
      "database it is talking to",
  );
}

async function withStore<T>(
  fn: (store: InstanceType<typeof import("../../store").Store>) => T,
): Promise<T> {
  const { Store } = await import("../../store");
  const store = new Store(databasePath());
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * The origin this deployment answers on, and the only one a signup may come
 * from or redirect to.
 *
 * AUTH_URL already has to be right for sign-in to work, so it is the trusted
 * origin rather than a second knob that could disagree with it.
 */
function deploymentOrigin(): string | null {
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Refuse a signup POST that did not come from this deployment's own page.
 *
 * The route writes durably and spends at Stripe on the strength of a cookie, so
 * a form on another site - including a customer's own office, which shares the
 * registrable domain - must not be able to drive it. A missing Origin is
 * refused as hard as a foreign one.
 */
export async function checkSignupOrigin(
  origin: string | null,
): Promise<OriginVerdict> {
  const { originIsTrusted } = await import("../../signup");
  const trusted = deploymentOrigin();
  if (!trusted) {
    return { ok: false, reason: "this deployment has no origin configured" };
  }
  if (!originIsTrusted(origin, trusted)) {
    return { ok: false, reason: "that request did not come from this site" };
  }
  return { ok: true };
}

export interface PlanOption {
  id: string;
  label: string;
}

/** The plans a signup form may offer. Configuration, read through the same
 * module the validator uses, so a form cannot offer one signup would refuse. */
export async function plans(): Promise<PlanOption[]> {
  const { PLANS } = await import("../../signup");
  return PLANS.map((p) => ({ id: p.id, label: p.label }));
}

export type SignupResult =
  | { ok: true; checkoutUrl: string; instanceId: string }
  | { ok: false; reason: string };

/**
 * Reserve a name and open Checkout for it.
 *
 * The two halves are deliberately separate transactions with a Stripe call
 * between them: the reservation is durable BEFORE anything is created at
 * Stripe, so a failure at Stripe leaves a row the same account can retry
 * against with the same idempotency keys. The keys come from that row, so the
 * retry cannot become a second customer or a second session.
 */
export async function signUpOffice(args: {
  accountId: string;
  officeName: string;
  plan: string;
  couponId?: string | null;
}): Promise<SignupResult> {
  const [
    { reserveOffice, checkoutInputsFor, validateSignup, customerReason },
    { StripeClient },
    { openCheckout },
  ] = await Promise.all([
    import("../../signup"),
    import("../../stripe/client"),
    import("../../stripe/checkout"),
  ]);

  // WHAT THE CUSTOMER TYPED IS JUDGED FIRST. Checking our own configuration
  // ahead of it answered every bad name with "no price configured", which is
  // both the wrong message and a way to reserve a name for a deployment that
  // cannot sell anything. A browser run is what found it.
  const valid = validateSignup({
    officeName: args.officeName,
    plan: args.plan,
  });
  if (!valid.ok) return { ok: false, reason: valid.reason };

  const priceId = process.env.CONTROL_PLANE_PRICE_ID;
  if (!priceId) {
    return {
      ok: false,
      reason: "this deployment has no price configured yet",
    };
  }
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) {
    return {
      ok: false,
      reason: "this deployment has no Stripe key configured",
    };
  }

  // Redirect targets come from the deployment's own origin, never from the
  // request: a Host header is not configuration.
  const origin = deploymentOrigin();
  if (!origin) {
    return { ok: false, reason: "this deployment has no origin configured" };
  }

  const reserved = await withStore((store) =>
    reserveOffice(store, {
      accountId: args.accountId,
      officeName: args.officeName,
      plan: args.plan,
      couponId: args.couponId ?? null,
    }),
  );
  if (!reserved.ok) return { ok: false, reason: reserved.reason };

  // The one Stripe creation path in the product. Coupon verification, customer
  // creation, session parameters and the test-mode refusals all live there.
  const client = new StripeClient({ key });
  const inputs = checkoutInputsFor({
    reservation: reserved.reservation,
    account: reserved.account,
    // The account's own address is the Checkout contact, not whatever the
    // session happens to carry today.
    email: reserved.account.email,
    priceId,
    successUrl: `${origin}/office/${reserved.reservation.instance_id}`,
    cancelUrl: `${origin}/signup`,
  });
  // openCheckout RETURNS its refusals but the session step THROWS - which is
  // right for the operator CLI, where a stack trace is the audience, and wrong
  // here, where an archived price turned a signup into a 500 page. A real run
  // is what found it. The detail goes to the server log; the customer gets a
  // sentence, because "the price specified is inactive" is our problem to fix.
  let opened: Awaited<ReturnType<typeof openCheckout>>;
  try {
    opened = await openCheckout(client, inputs);
  } catch (err) {
    console.error(
      `[signup] Checkout failed for ${reserved.reservation.name}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      ok: false,
      reason:
        "we could not open a payment page just now - your name is reserved, " +
        "so try again in a moment",
    };
  }
  // The CLI's wording is right for the CLI and wrong for a form.
  if (!opened.ok) return { ok: false, reason: customerReason(opened.reason) };
  if (!opened.session.url) {
    return { ok: false, reason: "Stripe returned a session with no URL" };
  }
  return {
    ok: true,
    checkoutUrl: opened.session.url,
    instanceId: reserved.reservation.instance_id,
  };
}

/** The account's office, or null. One per account: the reservation table's
 * unique account_id is what makes that true. */
export async function officeForAccount(
  accountId: string,
): Promise<ProgressView | null> {
  const [{ reservationForAccount }, { projectionFor }] = await Promise.all([
    import("../../signup"),
    import("../../progress"),
  ]);
  return withStore((store) => {
    const reservation = reservationForAccount(store, accountId);
    if (!reservation) return null;
    return projectionFor(store, {
      accountId,
      instanceId: reservation.instance_id,
    });
  });
}

/**
 * One office, or null.
 *
 * Null covers "no such instance" and "not yours" alike, and the caller answers
 * 404 to both: which of the two it was is not the asker's business.
 */
export async function progressForAccount(
  accountId: string,
  instanceId: string,
): Promise<ProgressView | null> {
  const { projectionFor } = await import("../../progress");
  return withStore((store) => projectionFor(store, { accountId, instanceId }));
}

/**
 * The account a sign-in resolves to, for BOTH providers.
 *
 * Returns an account id, which is what the session then carries. A Google
 * sign-in binds by subject and returns the account that subject is bound to -
 * so a changed email reaches the SAME account rather than making a second one.
 * A refusal is returned as a value: a sign-in that cannot be bound must not
 * become a session.
 */
export async function identityForSignIn(args: {
  provider: "google" | "dev";
  subject?: string;
  email: string;
}): Promise<{ ok: true; accountId: string } | { ok: false; reason: string }> {
  const { bindGoogleSubject, accountForDevSignIn, SubjectBindingConflict } =
    await import("../../signup");
  try {
    if (args.provider === "google") {
      if (!args.subject) return { ok: false, reason: "no Google subject" };
      const account = await withStore((store) =>
        bindGoogleSubject(store, { subject: args.subject!, email: args.email }),
      );
      return { ok: true, accountId: account.id };
    }
    const account = await withStore((store) =>
      accountForDevSignIn(store, args.email),
    );
    return { ok: true, accountId: account.id };
  } catch (err) {
    if (err instanceof SubjectBindingConflict) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}
