// The whole of this app's access to the control plane.
//
// THIS IS THE ONLY FILE THAT MAY OPEN THE STORE, and it hands no store out.
// Every export below returns plain, already-serialised data, so no page, layout
// or route handler ever holds an object carrying the database handle, the
// transaction opener, an enqueue or a compare-and-set. A boundary test asserts
// both halves of that: this file's export list, and the absence of raw store
// access everywhere else under web/.
//
// Every control-plane import is a REQUEST-TIME dynamic import. The reason it
// was introduced - the store spoke bun:sqlite, which `next build` under Node
// could not load - died with the Postgres port. The reason it stays did not: it
// keeps the module graph of the public app free of the driver, so nothing here
// reaches keys, ssh, handlers or the webhook path. `web-boundary.test.ts` is
// what enforces that now; the build no longer does it for us.
//
// One Store per request, closed in a finally, which under a pooled driver costs
// a connection per request rather than a file handle. That is a deployment
// question (a process-lifetime pool would also outlive dev-server hot reloads)
// and it is deliberately not answered here: the boundary this file exists for
// is that no page holds a store, and that is unchanged.

import type { ProgressView } from "../../progress";
import type { OpsFloor, OpsInstanceView } from "../../ops";

export type { ProgressView, OpsFloor, OpsInstanceView };

function databaseUrl(): string {
  const configured = process.env.CONTROL_PLANE_DB;
  if (configured) return configured;
  throw new Error(
    "CONTROL_PLANE_DB is not set: this app never guesses which control-plane " +
      "database it is talking to",
  );
}

async function withStore<T>(
  // The class named directly rather than through InstanceType: the constructor
  // is private now, and only `Store.open` may produce one.
  fn: (store: import("../../store").Store) => Promise<T> | T,
): Promise<T> {
  const { Store } = await import("../../store");
  const store = await Store.open(databaseUrl());
  try {
    // Awaited inside the try, so the store is closed by the finally rather
    // than left open by a rejection that escaped this frame.
    return await fn(store);
  } finally {
    await store.close();
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
 * Refuse a POST that did not come from this deployment's own page.
 *
 * Every route that writes uses this, not just signup: on the strength of a
 * cookie these routes spend at Stripe, restart a server, and ask for our own
 * access to be removed. A form on another site - including a customer's own
 * office, which shares the registrable domain - must not be able to drive any
 * of them. A missing Origin is refused as hard as a foreign one.
 */
export async function checkTrustedOrigin(
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
  return withStore(async (store) => {
    const reservation = await reservationForAccount(store, accountId);
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

// ------------------------------------------------------- customer requests
//
// Three verbs, and they are the whole of what this app can ask the control
// plane to DO. Each one is a named function over the store in
// control-plane/requests.ts: nothing here names an operation kind, opens a
// transaction or enqueues anything, so a new way to drive the machine cannot
// appear as a side effect of writing a page.

export type RequestResult =
  | { ok: true; operationId: string }
  | { ok: false; reason: string };

async function customerRequest(
  verb: "requestInvite" | "confirmHandoff" | "requestRestart",
  accountId: string,
  instanceId: string,
): Promise<RequestResult> {
  const requests = await import("../../requests");
  const outcome = await withStore((store) =>
    requests[verb](store, { accountId, instanceId }),
  );
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return { ok: true, operationId: outcome.operationId };
}

/** Ask for an owner invite. This opens the request; the URL is collected
 * separately, once, by `revealInvite`. */
export async function requestInvite(
  accountId: string,
  instanceId: string,
): Promise<RequestResult> {
  return customerRequest("requestInvite", accountId, instanceId);
}

/** "Revoke isomux's access" - the customer confirming they are in. */
export async function confirmHandoff(
  accountId: string,
  instanceId: string,
): Promise<RequestResult> {
  return customerRequest("confirmHandoff", accountId, instanceId);
}

/** Restart the server at the provider. */
export async function requestRestart(
  accountId: string,
  instanceId: string,
): Promise<RequestResult> {
  return customerRequest("requestRestart", accountId, instanceId);
}

// ------------------------------------------------------------ cancellation
//
// Cancel and un-cancel reach Stripe from here, exactly as signup reaches
// Checkout from here. The store is NOT in a transaction while that happens -
// cancel.ts owns that discipline - and neither verb writes subscription state:
// webhooks remain the only writer, so the page says "we asked, waiting for
// Stripe" until the projection catches up.

export type CancelResult = { ok: true } | { ok: false; reason: string };

async function billingVerb(
  verb: "requestCancel" | "requestUncancel",
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) {
    return {
      ok: false,
      reason: "this deployment has no Stripe key configured",
    };
  }
  const [cancel, { StripeClient }] = await Promise.all([
    import("../../cancel"),
    import("../../stripe/client"),
  ]);
  const { Store } = await import("../../store");
  const store = await Store.open(databaseUrl());
  try {
    const outcome = await cancel[verb](store, new StripeClient({ key }), {
      accountId,
      instanceId,
    });
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  } finally {
    await store.close();
  }
}

/** "Cancel my office": schedule the subscription to end at the period end. */
export async function requestCancel(
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  return billingVerb("requestCancel", accountId, instanceId);
}

/** "Keep my office": Stripe reactivation, while the period is still open. */
export async function requestUncancel(
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  return billingVerb("requestUncancel", accountId, instanceId);
}

// -------------------------------------------------------------- ops floor
//
// Three pass-throughs, and they hold NO authority of their own. Every one of
// them is gated inside the ops service, which re-reads the account and its
// operator column before it reads or writes anything - so this file never names
// that column, and a page cannot become an ops page by calling the wrong thing.
// A non-operator gets the same null a missing office gets; the caller answers
// 404 to both.

export async function opsFloor(accountId: string): Promise<OpsFloor | null> {
  const { opsFloor: read } = await import("../../ops");
  return withStore((store) => read(store, accountId));
}

export async function opsInstance(
  accountId: string,
  instanceId: string,
): Promise<OpsInstanceView | null> {
  const { opsInstance: read } = await import("../../ops");
  return withStore((store) => read(store, accountId, instanceId));
}

/** Record that a human has seen an office's open reasons. Null means refused,
 * which is deliberately the same answer a missing office gives. */
export async function acknowledgeOpsInstance(
  accountId: string,
  instanceId: string,
): Promise<number | null> {
  const { acknowledgeInstance } = await import("../../ops");
  return withStore((store) =>
    acknowledgeInstance(store, accountId, instanceId),
  );
}

export type RevealResult =
  | { status: "ready"; url: string }
  | {
      status:
        | "not_ready"
        | "expired_or_lost"
        | "window_closed"
        | "failed"
        | "forbidden";
      reason: string;
    };

/**
 * Collect a minted invite from the provisioner, once.
 *
 * The URL is never stored, cached or logged on this side: it is returned to the
 * route, rendered by the page that asked, and forgotten. Asking twice is
 * answered by the provisioner, not by us - the value is gone from its memory
 * after the first collection, which is what makes "shown once" a fact rather
 * than a flag.
 */
export async function revealInvite(
  accountId: string,
  instanceId: string,
  operationId: string,
): Promise<RevealResult> {
  const { fetchInviteFromSeam, seamConfigFrom } =
    await import("../../mint-client");
  const config = seamConfigFrom(process.env);
  if (!config) {
    return {
      status: "failed",
      reason: "this deployment cannot hand out invites yet",
    };
  }
  return fetchInviteFromSeam(config, { accountId, instanceId, operationId });
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
