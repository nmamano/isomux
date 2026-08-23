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
// ONE STORE PER PROCESS, not one per request, and it is never closed while the
// process lives. Opening is not a connect: it proves the governed bounds and
// checks the catalog, and the version that also ran the schema statements
// MEASURED 2026-08-10 against a local Postgres at a median 62.6ms (20 runs, min
// 49.1, max 79.1) against 9.1ms for a bare pool connect and 1.3ms for the read
// the request actually came for. Per request, that was about 54ms of repeated
// schema work wrapped around a millisecond of answer - and over a
// network-attached database it is worse, not better.
//
// The cache is a PROMISE, not a resolved handle: two cold requests arriving
// together must join one open rather than each build a pool. A rejected open is
// evicted, so an unreachable database is retried by the next request instead of
// poisoning the process. It lives on a globalThis symbol because a dev server
// re-evaluates this module on every hot reload, and a module-scope variable
// would leak a pool per reload.
//
// The boundary is unchanged and is the reason this file exists: no page holds a
// store, every export still returns plain data, and the store is reachable only
// through the accessor below.

import type { PoolLimits } from "../../store";
import type { ProgressView } from "../../progress";
import type { OpsFloor, OpsInstanceView } from "../../ops";
import type { ReservationRow } from "../../signup";
import type { AccountRow } from "../../stripe/billing-store";
import type { CustomerPrice, StripePriceConfiguration } from "../../plans";
import { customerFailure, safeCustomerReason } from "./customer-error";

export type { ProgressView, OpsFloor, OpsInstanceView };

/**
 * What one web process may hold open against the database.
 *
 * A number rather than a default, because the platform decides how many of
 * these processes exist: a serverless deployment scales instances out, and each
 * one holding `pg`'s default ten idle connections is how a small managed
 * Postgres runs out of them without a single slow query. Four is above the
 * concurrency a page render needs (each request issues its statements in
 * sequence) and low enough that a large fan-out of warm instances stays inside
 * an ordinary connection limit. The idle timeout is what makes that true over
 * time: an instance that stops serving gives its connections back rather than
 * holding them until the platform freezes it.
 */
const WEB_POOL: PoolLimits = { max: 4, idleTimeoutMillis: 10_000 };

/** Where the process-wide store lives across dev-server hot reloads. */
const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");

interface StoreCell {
  opening?: Promise<import("../../store").Store>;
}

function cell(): StoreCell {
  const global = globalThis as { [STORE_SLOT]?: StoreCell };
  return (global[STORE_SLOT] ??= {});
}

function openedStore(): Promise<import("../../store").Store> {
  const held = cell();
  if (held.opening) return held.opening;
  const opening = (async () => {
    // The class named directly rather than through InstanceType: the
    // constructor is private now, and only the two openers may produce one.
    //
    // RUNTIME, not `open`: this app holds a role that is granted rows and not
    // the schema, and a schema statement from it is refused by the engine
    // rather than tolerated. What it gets instead is the same bounds proof and
    // a catalog check, and a database that was never bootstrapped fails here.
    const { Store } = await import("../../store");
    return Store.openRuntime(databaseUrl(), undefined, WEB_POOL);
  })();
  held.opening = opening;
  // An open that fails is not a state to keep. Evicting on rejection is what
  // makes a database that was briefly unreachable a failed request rather than
  // a process that answers every later request with the same stale error - and
  // the identity check is what stops a late failure evicting a newer open.
  opening.catch(() => {
    if (held.opening === opening) delete held.opening;
  });
  return opening;
}

async function stripeRuntime(): Promise<{
  mode: import("../../stripe/mode").StripeMode;
  key: string;
}> {
  const { resolveStripeMode, stripeKeyFromEnv } =
    await import("../../stripe/mode");
  const mode = resolveStripeMode(process.env);
  return { mode, key: stripeKeyFromEnv(mode, process.env) };
}

async function withStore<T>(
  fn: (store: import("../../store").Store) => Promise<T> | T,
): Promise<T> {
  return fn(await openedStore());
}

function databaseUrl(): string {
  const configured = process.env.CONTROL_PLANE_DB;
  if (configured) return configured;
  throw new Error(
    "CONTROL_PLANE_DB is not set: this app never guesses which control-plane " +
      "database it is talking to",
  );
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
  specification: string;
  customerPrice: CustomerPrice | null;
}

/** The plans a signup form may offer. Configuration, read through the same
 * module the validator uses, so a form cannot offer one signup would refuse. */
export async function plans(): Promise<PlanOption[]> {
  const { PLANS } = await import("../../plans");
  return PLANS.map(({ id, label, specification, customerPrice }) => ({
    id,
    label,
    specification,
    customerPrice,
  }));
}

function stripePriceConfiguration(): StripePriceConfiguration {
  return {
    entryStripePriceId: process.env.CONTROL_PLANE_ENTRY_PRICE_ID,
    poweruserStripePriceId: process.env.CONTROL_PLANE_POWERUSER_PRICE_ID,
    legacyEntryStripePriceId: process.env.CONTROL_PLANE_PRICE_ID,
  };
}

export type SignupResult =
  | { ok: true; checkoutUrl: string; instanceId: string }
  | { ok: false; reason: string };

export type SignupPageState =
  | { kind: "new" }
  | { kind: "continue"; officeName: string }
  | { kind: "paid" };

export async function signupPageState(
  accountId: string,
): Promise<SignupPageState> {
  const [{ reservationsForAccount }, { subscriptionForInstance }] =
    await Promise.all([
      import("../../signup"),
      import("../../stripe/billing-store"),
    ]);
  return withStore(async (store) => {
    const reservations = await reservationsForAccount(store, accountId);
    let hasSubscription = false;
    for (const reservation of reservations) {
      const subscription = await subscriptionForInstance(
        store,
        reservation.instance_id,
      );
      if (!subscription)
        return { kind: "continue", officeName: reservation.name };
      hasSubscription = true;
    }
    return hasSubscription ? { kind: "paid" } : { kind: "new" };
  });
}

async function openReservedCheckout(args: {
  reservation: ReservationRow;
  account: AccountRow;
}): Promise<SignupResult> {
  const [
    { checkoutInputsFor, customerReason },
    { planById, resolveStripePrice },
    { StripeClient },
    { CheckoutCreationError, openCheckout },
  ] = await Promise.all([
    import("../../signup"),
    import("../../plans"),
    import("../../stripe/client"),
    import("../../stripe/checkout"),
  ]);
  const plan = planById(args.reservation.plan);
  if (!plan)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "checkout_reserved",
        `The stored plan ${args.reservation.plan} is not offered`,
      ),
    };
  const resolved = resolveStripePrice(plan, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "checkout_reserved",
        resolved.reason,
      ),
    };
  const origin = deploymentOrigin();
  if (!origin)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "checkout_reserved",
        "This deployment has no origin configured",
      ),
    };

  let client: InstanceType<typeof StripeClient>;
  try {
    const { key, mode } = await stripeRuntime();
    client = new StripeClient({ key, mode });
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure("configuration", "checkout_reserved", err),
    };
  }
  const inputs = checkoutInputsFor({
    reservation: args.reservation,
    account: args.account,
    email: args.account.email,
    priceId: resolved.stripePriceId,
    successUrl: `${origin}/office/${args.reservation.name}`,
    cancelUrl: `${origin}/signup`,
  });
  let opened: Awaited<ReturnType<typeof openCheckout>>;
  try {
    opened = await openCheckout(client, inputs);
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure(
        err instanceof CheckoutCreationError && err.ambiguous
          ? "transient"
          : "configuration",
        "checkout_reserved",
        err,
      ),
    };
  }
  if (!opened.ok) {
    const couponReason = customerReason(opened.reason);
    if (couponReason)
      return { ok: false, reason: safeCustomerReason(couponReason) };
    return {
      ok: false,
      reason: customerFailure(
        opened.retryable ? "transient" : "configuration",
        "checkout_reserved",
        opened.reason,
      ),
    };
  }
  if (!opened.session.url)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "checkout_reserved",
        "Stripe returned a session with no URL",
      ),
    };
  return {
    ok: true,
    checkoutUrl: opened.session.url,
    instanceId: args.reservation.instance_id,
  };
}

export async function continueSignup(
  accountId: string,
  officeName: string,
): Promise<SignupResult | { ok: false; officeName: string }> {
  const { reservationByName } = await import("../../signup");
  const { getAccount, subscriptionForInstance } =
    await import("../../stripe/billing-store");
  const owned = await withStore(async (store) => {
    const reservation = await reservationByName(store, officeName);
    if (!reservation || reservation.account_id !== accountId) return null;
    const subscription = await subscriptionForInstance(
      store,
      reservation.instance_id,
    );
    if (subscription) return { paid: true as const, reservation };
    const account = await getAccount(store, accountId);
    if (!account) return null;
    return { paid: false as const, reservation, account };
  });
  if (!owned)
    return {
      ok: false,
      reason: safeCustomerReason("we do not recognise this account"),
    };
  if (owned.paid) return { ok: false, officeName: owned.reservation.name };
  return openReservedCheckout(owned);
}

export async function reinstateOffice(
  accountId: string,
  instanceId: string,
): Promise<SignupResult> {
  const [
    {
      prepareReinstatementCheckout,
      recordReinstatementSession,
      recordFetchedExpiredReinstatementSession,
      recordReinstatementCheckoutFailure,
      reinstatementSessionKey,
      REINSTATEMENT_REFUSAL_WORDS,
    },
    { StripeClient },
    { LiveStripeReader },
    { CheckoutCreationError, openCheckout },
    { customerReason },
  ] = await Promise.all([
    import("../../reinstatement"),
    import("../../stripe/client"),
    import("../../stripe/reader"),
    import("../../stripe/checkout"),
    import("../../signup"),
  ]);
  const origin = deploymentOrigin();
  if (!origin)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "reinstatement",
        "Reinstatement payment has no deployment origin configured",
      ),
    };

  let client: InstanceType<typeof StripeClient>;
  let mode: import("../../stripe/mode").StripeMode;
  try {
    const runtime = await stripeRuntime();
    mode = runtime.mode;
    client = new StripeClient(runtime);
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure("configuration", "reinstatement", err),
    };
  }

  const tier = await withStore(async (store) => {
    const { instanceOwnedBy } = await import("../../signup");
    const owned = await instanceOwnedBy(store, accountId, instanceId);
    if (!owned) return null;
    const instance = await store.getInstance(instanceId);
    if (!instance) return null;
    const { planByProviderProduct } = await import("../../plans");
    return planByProviderProduct(instance.plan);
  });
  if (!tier)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "reinstatement",
        "Reinstatement has no offered plan",
      ),
    };
  const { resolveStripePrice } = await import("../../plans");
  const resolved = resolveStripePrice(tier, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "reinstatement",
        resolved.reason,
      ),
    };

  let prepared = await withStore((store) =>
    prepareReinstatementCheckout(store, accountId, instanceId, Date.now()),
  );
  if (!prepared.ok) {
    const safeReasons = new Set([
      "we could not find that office",
      "we could not find that subscription",
      "this office is already reinstated",
      ...Object.values(REINSTATEMENT_REFUSAL_WORDS),
    ]);
    return {
      ok: false,
      reason: safeReasons.has(prepared.reason)
        ? safeCustomerReason(prepared.reason)
        : customerFailure("configuration", "reinstatement", prepared.reason),
    };
  }
  if (prepared.existingSessionId) {
    let fetched: Awaited<
      ReturnType<InstanceType<typeof LiveStripeReader>["getCheckoutSession"]>
    >;
    try {
      fetched = await new LiveStripeReader(client, mode).getCheckoutSession(
        prepared.existingSessionId,
      );
    } catch (err) {
      return {
        ok: false,
        reason: customerFailure("configuration", "reinstatement", err),
      };
    }
    if (fetched.kind !== "ok")
      return {
        ok: false,
        reason: customerFailure(
          fetched.kind === "unavailable" ? "transient" : "configuration",
          "reinstatement",
          fetched.kind === "unavailable"
            ? fetched.reason
            : "The prior payment session does not exist",
        ),
      };
    if (fetched.object.status === "complete")
      return {
        ok: false,
        reason: safeCustomerReason(
          "the prior payment is still being reconciled",
        ),
      };
    if (fetched.object.status === "expired") {
      await withStore((store) =>
        recordFetchedExpiredReinstatementSession(
          store,
          prepared.ok ? prepared.attemptId : "",
          prepared.ok ? prepared.existingSessionId! : "",
        ),
      );
      prepared = await withStore((store) =>
        prepareReinstatementCheckout(store, accountId, instanceId, Date.now()),
      );
      if (!prepared.ok) return prepared;
    }
  }
  let opened: Awaited<ReturnType<typeof openCheckout>>;
  try {
    opened = await openCheckout(client, {
      accountId,
      email: prepared.account.email,
      officeName: prepared.reservation.name,
      priceId: resolved.stripePriceId,
      successUrl: `${origin}/office/${prepared.reservation.name}`,
      cancelUrl: `${origin}/office/${prepared.reservation.name}`,
      instanceId,
      reinstatementAttemptId: prepared.attemptId,
      expiresAt: Math.floor(prepared.stripeExpiresAt / 1000),
      ...(prepared.reservation.coupon_id
        ? { couponId: prepared.reservation.coupon_id }
        : {}),
      customerId: prepared.account.stripe_customer_id!,
      label: prepared.reservation.name,
      idempotencyKeys: {
        customer: `unused-${prepared.attemptId}`,
        session: reinstatementSessionKey(
          prepared.attemptId,
          prepared.generation,
        ),
      },
    });
  } catch (err) {
    // An ambiguous create may already exist at Stripe. Keep the generation and
    // idempotency key so the next click resolves that same request. A definite
    // refusal created nothing and may advance safely.
    if (!(err instanceof CheckoutCreationError && err.ambiguous)) {
      await withStore((store) =>
        recordReinstatementCheckoutFailure(
          store,
          prepared,
          err instanceof Error ? err.message : "Checkout creation threw",
        ),
      );
    }
    return {
      ok: false,
      reason: customerFailure(
        err instanceof CheckoutCreationError && err.ambiguous
          ? "transient"
          : "configuration",
        "reinstatement",
        err,
      ),
    };
  }
  if (!opened.ok) {
    await withStore((store) =>
      recordReinstatementCheckoutFailure(store, prepared, opened.reason),
    );
    const couponReason = customerReason(opened.reason);
    return couponReason
      ? { ok: false, reason: safeCustomerReason(couponReason) }
      : {
          ok: false,
          reason: customerFailure(
            opened.retryable ? "transient" : "configuration",
            "reinstatement",
            opened.reason,
          ),
        };
  }
  if (!opened.session.url) {
    await withStore((store) =>
      recordReinstatementSession(store, prepared, opened.session.id),
    );
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "reinstatement",
        "Stripe returned no payment URL",
      ),
    };
  }
  await withStore((store) =>
    recordReinstatementSession(store, prepared, opened.session.id),
  );
  return { ok: true, checkoutUrl: opened.session.url, instanceId };
}

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
  customerSshKey?: string | null;
}): Promise<SignupResult> {
  if (!args.customerSshKey) return { ok: false, reason: "" };
  const { reserveOffice, validateSignup } = await import("../../signup");
  const { resolveStripePrice } = await import("../../plans");

  // WHAT THE CUSTOMER TYPED IS JUDGED FIRST. Checking our own configuration
  // ahead of it answered every bad name with "no price configured", which is
  // both the wrong message and a way to reserve a name for a deployment that
  // cannot sell anything. A browser run is what found it.
  const valid = validateSignup({
    officeName: args.officeName,
    plan: args.plan,
    customerSshKey: args.customerSshKey,
  });
  if (!valid.ok) return { ok: false, reason: safeCustomerReason(valid.reason) };

  const resolved = resolveStripePrice(valid.plan, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure("configuration", "payments", resolved.reason),
    };
  try {
    await stripeRuntime();
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure("configuration", "payments", err),
    };
  }
  // Redirect targets come from the deployment's own origin, never from the
  // request: a Host header is not configuration.
  const origin = deploymentOrigin();
  if (!origin) {
    return {
      ok: false,
      reason: customerFailure(
        "configuration",
        "payments",
        "This deployment has no origin configured",
      ),
    };
  }

  const reserved = await withStore((store) =>
    reserveOffice(store, {
      accountId: args.accountId,
      officeName: args.officeName,
      plan: args.plan,
      couponId: args.couponId ?? null,
      customerSshKey: args.customerSshKey ?? null,
    }),
  );
  if (!reserved.ok)
    return {
      ok: false,
      reason:
        reserved.reason ===
        "this deployment needs its multi-office database migration"
          ? customerFailure("configuration", "payments", reserved.reason)
          : safeCustomerReason(reserved.reason),
    };
  return openReservedCheckout(reserved);
}

/** The account's offices, in reservation order. */
export async function officesForAccount(
  accountId: string,
): Promise<ProgressView[]> {
  const [{ reservationsForAccount }, { projectionFor }] = await Promise.all([
    import("../../signup"),
    import("../../progress"),
  ]);
  return withStore(async (store) => {
    const reservations = await reservationsForAccount(store, accountId);
    return Promise.all(
      reservations.map((reservation) =>
        projectionFor(store, {
          accountId,
          instanceId: reservation.instance_id,
        }),
      ),
    ).then((offices) => offices.filter((office) => office !== null));
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
 * Resolve a customer-facing office route from the signed-in account's own
 * reservation. Looking up the account first keeps a foreign name and a value
 * that does not exist on the same null path. Internal instance ids are not
 * customer-facing route keys.
 */
export async function officeRouteForAccount(
  accountId: string,
  routeKey: string,
): Promise<ProgressView | null> {
  const [{ reservationByName }, { projectionFor }] = await Promise.all([
    import("../../signup"),
    import("../../progress"),
  ]);
  return withStore(async (store) => {
    const reservation = await reservationByName(store, routeKey);
    if (!reservation || reservation.account_id !== accountId) return null;
    return projectionFor(store, {
      accountId,
      instanceId: reservation.instance_id,
    });
  });
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

/** "Remove Hosted Isomux Provisioning access" - the customer confirming they are in. */
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
  const [cancel, { StripeClient }] = await Promise.all([
    import("../../cancel"),
    import("../../stripe/client"),
  ]);
  // The same process-wide store as every other verb. It used to open its own
  // because it holds no transaction across the Stripe call and could afford to;
  // "could afford to" is not a reason to pay the schema check twice.
  let client: InstanceType<typeof StripeClient>;
  try {
    const runtime = await stripeRuntime();
    client = new StripeClient(runtime);
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure("configuration", "billing_change", err),
    };
  }
  return withStore(async (store) => {
    const outcome = await cancel[verb](store, client, {
      accountId,
      instanceId,
    });
    if (outcome.ok) return { ok: true };
    if (outcome.code === "stripe_unavailable")
      return {
        ok: false,
        reason: customerFailure("transient", "billing_change", outcome.reason),
      };
    if (outcome.code === "stripe_ambiguous")
      return {
        ok: false,
        reason: customerFailure(
          "transient",
          "billing_change_ambiguous",
          outcome.reason,
        ),
      };
    return { ok: false, reason: safeCustomerReason(outcome.reason) };
  });
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
