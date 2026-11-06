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
import type { DueIncidentItem, IncidentUpdateInput } from "../../incidents";
import type { OpenIncidentInput, OpsIncidentsView } from "../../incidents";
import type { PostRefusal, StatusIncidentView } from "../../incidents";
import type { StatusListView } from "../../incidents";
import type { IncidentMailOutcome } from "./incident-mail.server";
import type { ReservationRow, SignupSource } from "../../signup";
import type { AccountRow } from "../../stripe/billing-store";
import type { CustomerPrice, StripePriceConfiguration } from "../../plans";
import {
  customerFailure,
  refusedResult,
  safeCustomerReason,
  type CustomerFailureContext,
  type CustomerFailureSurface,
} from "./customer-error";
import type { SupportedLanguageCode } from "./i18n/languages";
import { translatorFor } from "./i18n/translate";

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
    //
    // A deployment that names its database identity gets the same proof as
    // the provisioner, before any request reads or writes a row. Unset means
    // no claim, as in local development.
    const { Store } = await import("../../store");
    const { DATABASE_IDENTITY_ENV, proveDatabaseIdentity } =
      await import("../../boot");
    const store = await Store.openRuntime(databaseUrl(), undefined, WEB_POOL);
    try {
      await proveDatabaseIdentity(store, process.env[DATABASE_IDENTITY_ENV]);
    } catch (err) {
      await store.close().catch(() => {});
      throw err;
    }
    return store;
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

/** A trusted verdict carries the deployment origin, so a route that redirects
 * builds its Location from configuration and not from the request URL, which
 * behind a proxy is the container's own origin. */
export type OriginVerdict =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

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
  return { ok: true, origin: trusted };
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
  | { ok: false; code?: string; reason: string };

export type SignupPageState =
  | { kind: "new" }
  | { kind: "continue"; officeName: string }
  | { kind: "paid" };

export async function signupPageState(
  accountId: string,
): Promise<SignupPageState> {
  const [
    { heldUnpaidReservation, reservationsForAccount },
    { subscriptionForInstance },
  ] = await Promise.all([
    import("../../signup"),
    import("../../stripe/billing-store"),
  ]);
  return withStore(async (store) => {
    // Continue only while the checkout can still be paid. Once it is over the
    // name is free, and the new-office form takes it over afresh.
    const held = await heldUnpaidReservation(store, accountId, store.now());
    if (held) return { kind: "continue", officeName: held.name };
    for (const reservation of await reservationsForAccount(store, accountId)) {
      if (await subscriptionForInstance(store, reservation.instance_id))
        return { kind: "paid" };
    }
    return { kind: "new" };
  });
}

/**
 * The customer's answer to a refused Checkout or coupon. A coupon refusal says
 * what is wrong with the code; anything else is a failure on `surface`,
 * transient when a retry may work.
 */
async function checkoutRefusal(
  language: SupportedLanguageCode,
  surface: CustomerFailureSurface,
  refusal: { retryable: boolean; reason: string },
  context: CustomerFailureContext,
): Promise<string> {
  const { customerReason } = await import("../../signup");
  const couponReason = customerReason(refusal.reason);
  if (couponReason) return safeCustomerReason(language, couponReason, context);
  return customerFailure(
    language,
    refusal.retryable ? "transient" : "configuration",
    surface,
    refusal.reason,
    context,
  );
}

async function openReservedCheckout(args: {
  language: SupportedLanguageCode;
  reservation: ReservationRow;
  account: AccountRow;
}): Promise<SignupResult> {
  const language = args.language;
  const context: CustomerFailureContext = {
    accountId: args.account.id,
    instanceId: args.reservation.instance_id,
    officeName: args.reservation.name,
  };
  const [
    {
      advanceExpiredOrdinaryCheckout,
      checkoutInputsFor,
      recordOrdinaryCheckoutSession,
      recordTerminalOrdinarySession,
      reservationByName,
    },
    { planById, resolveStripePrice },
    { StripeClient },
    { LiveStripeReader },
    { CheckoutCreationError, openCheckout },
  ] = await Promise.all([
    import("../../signup"),
    import("../../plans"),
    import("../../stripe/client"),
    import("../../stripe/reader"),
    import("../../stripe/checkout"),
  ]);
  let reservation = args.reservation;
  const plan = planById(args.reservation.plan);
  if (!plan)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "checkout_reserved",
        `The stored plan ${args.reservation.plan} is not offered`,
        context,
      ),
    };
  const resolved = resolveStripePrice(plan, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "checkout_reserved",
        resolved.reason,
        context,
      ),
    };
  const origin = deploymentOrigin();
  if (!origin)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "checkout_reserved",
        "This deployment has no origin configured",
        context,
      ),
    };

  // The client is built inside the try: its constructor refuses a key that
  // does not fit the mode, and that throw must be a refusal, not a 500.
  let mode: Awaited<ReturnType<typeof stripeRuntime>>["mode"];
  let client: InstanceType<typeof StripeClient>;
  try {
    const runtime = await stripeRuntime();
    mode = runtime.mode;
    client = new StripeClient(runtime);
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "checkout_reserved",
        err,
        context,
      ),
    };
  }
  const advanceTerminalGeneration = async (
    sessionId?: string,
  ): Promise<boolean> => {
    const advanced = await withStore(async (store) => {
      if (sessionId) {
        await recordTerminalOrdinarySession(store, reservation.id, sessionId);
      }
      return advanceExpiredOrdinaryCheckout(store, reservation.id);
    });
    if (advanced) {
      reservation = advanced;
      return true;
    }
    const current = await withStore((store) =>
      reservationByName(store, reservation.name),
    );
    // The same row only: after a takeover the name holds another account's
    // reservation, with its instance and its Stripe keys.
    if (current?.id !== reservation.id || current.checkout_state !== "opening")
      return false;
    reservation = current;
    return true;
  };

  if (
    reservation.checkout_state === "expired" &&
    !(await advanceTerminalGeneration())
  ) {
    return {
      ok: false,
      reason: translatorFor(language).t("errors.checkoutSessionUnavailable"),
    };
  }
  if (
    reservation.checkout_state === "pending" &&
    reservation.checkout_session_id
  ) {
    const existing = await new LiveStripeReader(
      client,
      mode,
    ).getCheckoutSession(reservation.checkout_session_id);
    if (existing.kind === "unavailable") {
      return {
        ok: false,
        reason: translatorFor(language).t("errors.checkoutSessionUnavailable"),
      };
    }
    if (existing.kind === "absent" || existing.object.status === "expired") {
      if (!(await advanceTerminalGeneration(reservation.checkout_session_id))) {
        return {
          ok: false,
          reason: translatorFor(language).t(
            "errors.checkoutSessionUnavailable",
          ),
        };
      }
    } else if (
      existing.kind === "ok" &&
      existing.object.status === "complete"
    ) {
      return {
        ok: true,
        checkoutUrl: `${origin}/office/${reservation.name}`,
        instanceId: reservation.instance_id,
      };
    } else if (existing.kind === "ok" && existing.object.url) {
      return {
        ok: true,
        checkoutUrl: existing.object.url,
        instanceId: reservation.instance_id,
      };
    } else if (existing.kind === "ok") {
      return {
        ok: false,
        reason: customerFailure(
          language,
          "configuration",
          "checkout_reserved",
          "Stripe returned a session with no URL",
          context,
        ),
      };
    }
  }
  const inputs = checkoutInputsFor({
    reservation,
    account: args.account,
    email: args.account.email,
    priceId: resolved.stripePriceId,
    successUrl: `${origin}/office/${reservation.name}`,
    cancelUrl: `${origin}/signup`,
  });
  // NO `locale` HERE, deliberately. The session's idempotency key is derived
  // from stored state alone (checkoutKeysFor in signup.ts,
  // reinstatementSessionKey in reinstatement.ts), so every replay of one
  // generation must send a byte-identical body. A locale read from the REQUEST
  // is the one input a language switch can change between a lost response and
  // its retry, and Stripe refuses a reused key with a different body. Checkout
  // reads the customer's own browser instead. (PM ruling, 2026-09-06.)
  let opened: Awaited<ReturnType<typeof openCheckout>>;
  try {
    opened = await openCheckout(client, inputs);
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure(
        language,
        err instanceof CheckoutCreationError && err.ambiguous
          ? "transient"
          : "configuration",
        "checkout_reserved",
        err,
        context,
      ),
    };
  }
  if (!opened.ok) {
    return {
      ok: false,
      reason: await checkoutRefusal(
        language,
        "checkout_reserved",
        opened,
        context,
      ),
    };
  }
  if (!opened.session.url)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "checkout_reserved",
        "Stripe returned a session with no URL",
        context,
      ),
    };
  // GUARDED: this is the only database call after Stripe has already created
  // the session, so a transient store failure here must come back as the same
  // retryable refusal as a lost update - not escape as a 500. The retry reuses
  // the generation-keyed idempotency key and gets the same session back.
  // (Seen live 2026-08-24: session created, this write threw, customer saw a
  // raw 500.)
  let recorded: boolean;
  try {
    recorded = await withStore(async (store) => {
      if (
        await recordOrdinaryCheckoutSession(store, reservation, opened.session)
      ) {
        return true;
      }
      const current = await reservationByName(store, reservation.name);
      return (
        current?.checkout_state === "pending" &&
        current.checkout_session_id === opened.session.id
      );
    });
  } catch {
    recorded = false;
  }
  if (!recorded) {
    return {
      ok: false,
      reason: translatorFor(language).t("errors.checkoutSessionUnsaved"),
    };
  }
  return {
    ok: true,
    checkoutUrl: opened.session.url,
    instanceId: args.reservation.instance_id,
  };
}

export async function continueSignup(
  language: SupportedLanguageCode,
  accountId: string,
  officeName: string,
): Promise<SignupResult | { ok: false; officeName: string }> {
  const context: CustomerFailureContext = { accountId, officeName };
  const { reservationByName, reservationIsDead } = await import("../../signup");
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
    // Its checkout is over, so its name is free: re-arming it here would hold
    // the name past the admission count and the one-unpaid-office bound.
    if (await reservationIsDead(store, reservation, store.now()))
      return { over: true as const };
    const account = await getAccount(store, accountId);
    if (!account) return null;
    return { paid: false as const, reservation, account };
  });
  if (!owned)
    return {
      ok: false,
      reason: safeCustomerReason(
        language,
        "we do not recognise this account",
        context,
      ),
    };
  if ("over" in owned)
    return {
      ok: false,
      reason: safeCustomerReason(
        language,
        `the payment page for "${officeName}" expired. Set up the office again`,
        context,
      ),
    };
  if (owned.paid) return { ok: false, officeName: owned.reservation.name };
  return openReservedCheckout({ language, ...owned });
}

export async function reinstateOffice(
  language: SupportedLanguageCode,
  accountId: string,
  instanceId: string,
): Promise<SignupResult> {
  const context: CustomerFailureContext = { accountId, instanceId };
  const [
    {
      prepareReinstatementCheckout,
      recordReinstatementSession,
      recordFetchedExpiredReinstatementSession,
      recordReinstatementCheckoutFailure,
      reinstatementSessionKey,
    },
    { StripeClient },
    { LiveStripeReader },
    { CheckoutCreationError, openCheckout },
  ] = await Promise.all([
    import("../../reinstatement"),
    import("../../stripe/client"),
    import("../../stripe/reader"),
    import("../../stripe/checkout"),
  ]);
  const origin = deploymentOrigin();
  if (!origin)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "reinstatement",
        "Reinstatement payment has no deployment origin configured",
        context,
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
      reason: customerFailure(
        language,
        "configuration",
        "reinstatement",
        err,
        context,
      ),
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
        language,
        "configuration",
        "reinstatement",
        "Reinstatement has no offered plan",
        context,
      ),
    };
  const { resolveStripePrice } = await import("../../plans");
  const resolved = resolveStripePrice(tier, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "reinstatement",
        resolved.reason,
        context,
      ),
    };

  let prepared = await withStore((store) =>
    prepareReinstatementCheckout(store, accountId, instanceId, Date.now()),
  );
  if (!prepared.ok)
    return refusedResult(language, "reinstatement", prepared, context);
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
        reason: customerFailure(
          language,
          "configuration",
          "reinstatement",
          err,
          context,
        ),
      };
    }
    if (fetched.kind !== "ok")
      return {
        ok: false,
        reason: customerFailure(
          language,
          fetched.kind === "unavailable" ? "transient" : "configuration",
          "reinstatement",
          fetched.kind === "unavailable"
            ? fetched.reason
            : "The prior payment session does not exist",
          context,
        ),
      };
    if (fetched.object.status === "complete")
      return {
        ok: false,
        reason: translatorFor(language).t("errors.reinstatementReconciling"),
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
      if (!prepared.ok)
        return refusedResult(language, "reinstatement", prepared, context);
    }
  }
  // NO `locale` HERE, deliberately. The session's idempotency key is derived
  // from stored state alone (checkoutKeysFor in signup.ts,
  // reinstatementSessionKey in reinstatement.ts), so every replay of one
  // generation must send a byte-identical body. A locale read from the REQUEST
  // is the one input a language switch can change between a lost response and
  // its retry, and Stripe refuses a reused key with a different body. Checkout
  // reads the customer's own browser instead. (PM ruling, 2026-09-06.)
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
        language,
        err instanceof CheckoutCreationError && err.ambiguous
          ? "transient"
          : "configuration",
        "reinstatement",
        err,
        context,
      ),
    };
  }
  if (!opened.ok) {
    await withStore((store) =>
      recordReinstatementCheckoutFailure(store, prepared, opened.reason),
    );
    return {
      ok: false,
      reason: await checkoutRefusal(language, "reinstatement", opened, context),
    };
  }
  if (!opened.session.url) {
    await withStore((store) =>
      recordReinstatementSession(store, prepared, opened.session.id),
    );
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "reinstatement",
        "Stripe returned no payment URL",
        context,
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
 * A named coupon is read first, so a refused one reserves nothing. The two
 * halves are deliberately separate transactions with a Stripe call
 * between them: the reservation is durable BEFORE anything is created at
 * Stripe, so a failure at Stripe leaves a row the same account can retry
 * against with the same idempotency keys. The keys come from that row, so the
 * retry cannot become a second customer or a second session.
 */
export async function signUpOffice(args: {
  language: SupportedLanguageCode;
  accountId: string;
  officeName: string;
  plan: string;
  couponId?: string | null;
  customerSshKey?: string | null;
  source?: SignupSource | null;
}): Promise<SignupResult> {
  if (!args.customerSshKey) return { ok: false, reason: "" };
  const language = args.language;
  const context: CustomerFailureContext = {
    accountId: args.accountId,
    officeName: args.officeName,
  };
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
  if (!valid.ok) return refusedResult(language, "payments", valid, context);

  const resolved = resolveStripePrice(valid.plan, stripePriceConfiguration());
  if (!resolved.ok)
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "payments",
        resolved.reason,
        context,
      ),
    };
  // The client is built here, before the reservation: its constructor refuses
  // a key that does not fit the mode, and that refusal must reserve nothing.
  const { StripeClient } = await import("../../stripe/client");
  let client: InstanceType<typeof StripeClient>;
  try {
    client = new StripeClient(await stripeRuntime());
  } catch (err) {
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "payments",
        err,
        context,
      ),
    };
  }
  // Redirect targets come from the deployment's own origin, never from the
  // request: a Host header is not configuration.
  const origin = deploymentOrigin();
  if (!origin) {
    return {
      ok: false,
      reason: customerFailure(
        language,
        "configuration",
        "payments",
        "This deployment has no origin configured",
        context,
      ),
    };
  }

  // THE COUPON IS READ BEFORE ANYTHING IS RESERVED. A refused code then leaves
  // no row: no name held, no account place, no admission place. Reserving
  // first let free accounts fill the shared admission bound with codes that
  // do not exist (task b390cb25). Read-only; openCheckout reads it again.
  if (args.couponId) {
    const { couponRefusalReason, verifyFullDiscount } =
      await import("../../stripe/checkout");
    const coupon = await verifyFullDiscount(client, args.couponId);
    if (!coupon.ok)
      return {
        ok: false,
        reason: await checkoutRefusal(
          language,
          "payments",
          {
            retryable: coupon.retryable,
            reason: couponRefusalReason(args.couponId, coupon.reason),
          },
          context,
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
      source: args.source ?? null,
    }),
  );
  if (!reserved.ok)
    return refusedResult(language, "payments", reserved, context);
  return openReservedCheckout({ language, ...reserved });
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
  | { ok: false; code: string; reason: string };

async function customerRequest(
  verb: "requestInvite" | "confirmHandoff" | "requestRestart",
  accountId: string,
  instanceId: string,
): Promise<RequestResult> {
  const requests = await import("../../requests");
  const outcome = await withStore((store) =>
    requests[verb](store, { accountId, instanceId }),
  );
  if (!outcome.ok)
    return { ok: false, code: outcome.code, reason: outcome.reason };
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

export type CancelResult =
  | { ok: true }
  | { ok: false; code?: string; reason: string };

async function billingVerb(
  language: SupportedLanguageCode,
  verb: "requestCancel" | "requestUncancel",
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  const context: CustomerFailureContext = { accountId, instanceId };
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
      reason: customerFailure(
        language,
        "configuration",
        "billing_change",
        err,
        context,
      ),
    };
  }
  return withStore(async (store) => {
    const outcome = await cancel[verb](store, client, {
      accountId,
      instanceId,
    });
    if (outcome.ok) return { ok: true };
    return refusedResult(
      language,
      outcome.code === "stripe_ambiguous"
        ? "billing_change_ambiguous"
        : "billing_change",
      outcome,
      context,
    );
  });
}

/** "Cancel my office": schedule the subscription to end at the period end. */
export async function requestCancel(
  language: SupportedLanguageCode,
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  return billingVerb(language, "requestCancel", accountId, instanceId);
}

/** "Keep my office": Stripe reactivation, while the period is still open. */
export async function requestUncancel(
  language: SupportedLanguageCode,
  accountId: string,
  instanceId: string,
): Promise<CancelResult> {
  return billingVerb(language, "requestUncancel", accountId, instanceId);
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

// ------------------------------------------------------ critical issues
//
// The status pages of an enterprise customer's critical issue (incidents.ts).
// Each check lives in the incidents service, inside its transaction: the
// customer's link, the operator column, or the write key. This file only reads
// AUTH_SECRET for the link and sends the update's mail after the post commits.

/** /ops/incidents, with each customer's status link. */
export interface OpsIncidentsPage extends OpsIncidentsView {
  /** Customer id -> its /status/<token> path. */
  statusPaths: Record<string, string>;
}

/** Who posts an update: an operator's session or the write key. */
export type IncidentPoster = { accountId: string } | { key: string };

/** A post that went through, with what happened to its mail. */
export type IncidentPostOutcome =
  | { ok: true; incidentId: string; n: number; mail: IncidentMailOutcome }
  | PostRefusal;

/** The key the status links are made with: Auth.js's own secret, under a
 * context of its own (incidents.ts statusToken). */
function statusSecret(): string | null {
  return process.env.AUTH_SECRET || null;
}

/** /status/<token>. Null for a bad, stale or unknown token. */
export async function statusList(
  token: string,
): Promise<StatusListView | null> {
  const secret = statusSecret();
  if (!secret) return null;
  const { statusListFor } = await import("../../incidents");
  return withStore((store) => statusListFor(store, secret, token));
}

/** /status/<token>/<n>. Null for a bad token or an n that is not its own. */
export async function statusIncident(
  token: string,
  n: number,
): Promise<StatusIncidentView | null> {
  const secret = statusSecret();
  if (!secret) return null;
  const { statusIncidentFor } = await import("../../incidents");
  return withStore((store) => statusIncidentFor(store, secret, token, n));
}

/** /ops/incidents. Null for a non-operator. */
export async function opsIncidentsFor(
  accountId: string,
): Promise<OpsIncidentsPage | null> {
  const { opsIncidents, statusToken } = await import("../../incidents");
  const view = await withStore((store) => opsIncidents(store, accountId));
  if (!view) return null;
  const secret = statusSecret();
  const statusPaths: Record<string, string> = {};
  if (secret) {
    for (const customer of view.customers) {
      statusPaths[customer.id] =
        `/status/${statusToken(secret, customer.id, customer.linkGeneration)}`;
    }
  }
  return { ...view, statusPaths };
}

/** Mail a posted update to its contacts, after the post committed. A mail
 * that fails does not undo the update: the update is the record. */
async function mailPosted(
  result: import("../../incidents").PostResult | null,
): Promise<IncidentPostOutcome | null> {
  if (!result) return null;
  if (!result.ok) return result;
  const { posted } = result;
  const done = (mail: IncidentMailOutcome): IncidentPostOutcome => ({
    ok: true,
    incidentId: posted.incidentId,
    n: posted.update.n,
    mail,
  });
  const secret = statusSecret();
  const origin = deploymentOrigin();
  if (!secret || !origin) return done("not_configured");
  const { statusToken } = await import("../../incidents");
  const { sendIncidentUpdateMail } = await import("./incident-mail.server");
  const token = statusToken(secret, posted.customerId, posted.linkGeneration);
  const mail = await sendIncidentUpdateMail(
    posted,
    `${origin}/status/${token}/${posted.n}`,
    { apiKey: process.env.AUTH_RESEND_KEY },
  );
  return done(mail);
}

/** Open an issue with its first update, and mail it. Null for a
 * non-operator. */
export async function openIncidentFor(
  accountId: string,
  input: OpenIncidentInput,
): Promise<IncidentPostOutcome | null> {
  const { openIncident } = await import("../../incidents");
  return mailPosted(
    await withStore((store) => openIncident(store, accountId, input)),
  );
}

/** Post an update, and mail it. Null for a non-operator or a bad key. */
export async function postIncidentUpdateFor(
  poster: IncidentPoster,
  incidentId: string,
  input: IncidentUpdateInput,
): Promise<IncidentPostOutcome | null> {
  const { postUpdateAsOperator, postUpdateWithKey } =
    await import("../../incidents");
  return mailPosted(
    await withStore((store) =>
      "key" in poster
        ? postUpdateWithKey(store, poster.key, incidentId, input)
        : postUpdateAsOperator(store, poster.accountId, incidentId, input),
    ),
  );
}

/** The open issues for the write key, or only the due ones. Null for a bad
 * key. */
export async function incidentsForKey(
  key: string,
  dueOnly: boolean,
): Promise<DueIncidentItem[] | null> {
  const { incidentsWithKey } = await import("../../incidents");
  return withStore((store) => incidentsWithKey(store, key, { dueOnly }));
}

/** Re-make a customer's link; returns its new /status/<token> path. Null for
 * a non-operator or an unknown customer. */
export async function remakeStatusLinkFor(
  accountId: string,
  customerId: string,
): Promise<{ statusPath: string } | null> {
  const secret = statusSecret();
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const { remakeStatusLink } = await import("../../incidents");
  const made = await withStore((store) =>
    remakeStatusLink(store, accountId, secret, customerId),
  );
  return made ? { statusPath: `/status/${made.token}` } : null;
}

/** Rotate the write key; the new key is shown once. Null for a
 * non-operator. */
export async function rotateIncidentKeyFor(
  accountId: string,
): Promise<{ key: string } | null> {
  const { rotateIncidentKey } = await import("../../incidents");
  return withStore((store) => rotateIncidentKey(store, accountId));
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

/** The key a removed Google sign-in's mark is made with (signup.ts
 * removedGoogleSubjectHash). Auth.js does not run without AUTH_SECRET. */
function googleSubjectKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return secret;
}

/**
 * The account a sign-in resolves to, for every provider.
 *
 * Returns an account id, which is what the session then carries. A Google
 * sign-in binds by subject and returns the account that subject is bound to -
 * so a changed email reaches the SAME account rather than making a second one.
 * An email-link sign-in reaches the account with that address, Google-made or
 * not (signup.ts accountForEmailSignIn).
 * A refusal is returned as a value: a sign-in that cannot be bound must not
 * become a session.
 */
export async function identityForSignIn(args: {
  provider: "google" | "dev" | "email-link";
  subject?: string;
  email: string;
  /** Google's email_verified claim; read only for provider "google". */
  emailVerified?: boolean;
}): Promise<
  | { ok: true; accountId: string }
  | { ok: false; reason: string; code?: "google-removed" }
> {
  const {
    bindGoogleSubject,
    accountForDevSignIn,
    accountForEmailSignIn,
    SubjectBindingConflict,
    GoogleSignInRemoved,
  } = await import("../../signup");
  try {
    if (args.provider === "google") {
      if (!args.subject) return { ok: false, reason: "no Google subject" };
      const account = await withStore((store) =>
        bindGoogleSubject(store, {
          subject: args.subject!,
          email: args.email,
          emailVerified: args.emailVerified === true,
          subjectKey: googleSubjectKey(),
        }),
      );
      return { ok: true, accountId: account.id };
    }
    if (args.provider === "email-link") {
      const account = await withStore((store) =>
        accountForEmailSignIn(store, args.email),
      );
      return { ok: true, accountId: account.id };
    }
    const account = await withStore((store) =>
      accountForDevSignIn(store, args.email),
    );
    return { ok: true, accountId: account.id };
  } catch (err) {
    if (err instanceof GoogleSignInRemoved) {
      return { ok: false, reason: err.message, code: "google-removed" };
    }
    if (err instanceof SubjectBindingConflict) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- account
//
// The account page: its address, its Google sign-in, and the email change.
// The rules live in lib/account-email-request.server.ts; these are the store
// and Stripe ends it is wired to.

/** What the account page and the dashboard show: the address from the account
 * row (not the session, which keeps the address it signed in with) and whether
 * a Google sign-in is bound. Null when the account does not exist. */
export async function accountSettings(
  accountId: string,
): Promise<{ email: string; google: boolean } | null> {
  const { getAccount } = await import("../../stripe/billing-store");
  const account = await withStore((store) => getAccount(store, accountId));
  if (!account) return null;
  return { email: account.email, google: account.google_subject !== null };
}

export async function emailChangeRefusalFor(
  accountId: string,
  newEmail: string,
): Promise<import("../../signup").EmailChangeRefusal | null> {
  const { emailChangeRefusal } = await import("../../signup");
  return withStore((store) => emailChangeRefusal(store, accountId, newEmail));
}

export async function stripeCustomersFor(accountId: string): Promise<string[]> {
  const { stripeCustomersForAccount } = await import("../../signup");
  return withStore((store) => stripeCustomersForAccount(store, accountId));
}

/** Throws when Stripe is not configured. */
export async function updateStripeCustomerEmail(
  customerId: string,
  email: string,
  idempotencyKey: string,
): Promise<import("../../stripe/customer-email").CustomerEmailResult> {
  const [{ StripeClient }, { updateCustomerEmail }] = await Promise.all([
    import("../../stripe/client"),
    import("../../stripe/customer-email"),
  ]);
  const client = new StripeClient(await stripeRuntime());
  return updateCustomerEmail(client, customerId, email, idempotencyKey);
}

export async function changeAccountEmailFor(args: {
  accountId: string;
  newEmail: string;
}): Promise<import("../../signup").EmailChangeOutcome> {
  const { changeAccountEmail } = await import("../../signup");
  return withStore((store) => changeAccountEmail(store, args));
}

export async function removeGoogleSignInFor(
  accountId: string,
): Promise<boolean> {
  const { removeGoogleSignIn } = await import("../../signup");
  return withStore((store) =>
    removeGoogleSignIn(store, accountId, googleSubjectKey()),
  );
}

/** The account's session epoch, or null when it does not exist. */
export async function sessionEpochFor(
  accountId: string,
): Promise<number | null> {
  const { sessionEpoch } = await import("../../signup");
  return withStore((store) => sessionEpoch(store, accountId));
}

/**
 * Opt the account behind an unsubscribe token out of the welcome series. An
 * unknown token changes nothing and is not an error.
 */
export async function unsubscribeWelcomeMail(token: string): Promise<void> {
  await withStore((store) => store.unsubscribeWelcomeMail(token, Date.now()));
}
