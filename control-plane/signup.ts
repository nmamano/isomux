// Who is buying, what they called their office, and the row that makes a name
// unique across accounts.
//
// These are FUNCTIONS OVER THE SLICE-2 STORE, like billing-store.ts: one
// connection, one schema owner, one transaction owner. Signup has to write an
// account, a reservation, an instance and its provider asset TOGETHER, because
// a reservation without an instance is a name nobody can provision and an
// instance without a reservation is a box no account owns.
//
// The uniqueness decision is the INSERT. `name` is the reservation table's
// primary key, so two signups racing for one name are separated by the
// database; the loser reads the winner's row and finds out whose it is. A
// SELECT-then-INSERT would let both callers observe "absent" in the same
// instant, which is the same defect the create latch exists to prevent, at a
// smaller scale.
//
// Everything a retry needs is READ BACK FROM THE ROW: the instance id and both
// Stripe idempotency keys are derived from the stored reservation id, never
// recomputed from a request body and never from a clock. A second POST is
// therefore incapable of moving a Checkout session to a different plan, coupon
// or instance under one idempotency key.

import { isUniqueViolation, type Store } from "./store.ts";
import {
  accountByEmail,
  casAccount,
  ensureAccount,
  getAccount,
  type AccountRow,
} from "./stripe/billing-store.ts";
import type { OpenCheckoutArgs } from "./stripe/checkout.ts";
import { validateOfficeName } from "./stripe/checkout.ts";
import { validateCustomerSshKey } from "./key-lines.ts";
import { ACCESS_WINDOW_MS } from "./access-window-policy.ts";
import { planById, type Plan } from "./plans.ts";
export { ACCESS_WINDOW_MS } from "./access-window-policy.ts";
export {
  ENTRY_PLAN,
  PLANS,
  POWERUSER_PLAN,
  planById,
  planByProviderProduct,
  planDisplayForProviderProduct,
  resolveStripePrice,
  type CustomerPrice,
  type Plan,
  type PlanDisplay,
  type StripePriceConfiguration,
  type StripePriceResolution,
} from "./plans.ts";

/**
 * The domain offices are named under. A constant rather than an environment
 * variable: it is the same value for every caller of a given build, and launch
 * flips one line.
 */
export const OFFICE_DOMAIN = "test.isomux.app";

/**
 * The access-window ceiling written with the instance row, per R-2026-08-15-1:
 * a seven-day fail-safe backstop, with customer-confirmed early revocation as the
 * normal path.
 *
 * It is written HERE because it can be written nowhere else. `createInstance`
 * is the only statement in the schema that sets `access_window_expires_at`;
 * `casInstance` refuses it at runtime as well as in its type, because the box
 * carries that instant in an authorized_keys option and a systemd timer we
 * cannot reach afterwards. A row created without a ceiling could never be given
 * one, and the driver is fail-closed on a missing ceiling - so signup writes it
 * or the office can never be provisioned at all.
 */
/**
 * Plans, as configuration rather than code (design: "plan tiers map to provider
 * products in configuration").
 *
 * The Stripe price is not in here because a price id belongs to one Stripe
 * ACCOUNT: the test account's ids are not the live account's, so it arrives
 * from the environment with the rest of the Stripe credentials rather than
 * being frozen into a public repository.
 */
export interface ReservationRow {
  name: string;
  id: string;
  account_id: string;
  instance_id: string;
  plan: string;
  coupon_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export function hostnameFor(officeName: string): string {
  return `${officeName}.${OFFICE_DOMAIN}`;
}

export async function reservationByName(
  store: Store,
  name: string,
): Promise<ReservationRow | null> {
  return store.sqlGet<ReservationRow>(
    "select * from name_reservations where name = $1",
    [name],
  );
}

export async function reservationForInstance(
  store: Store,
  instanceId: string,
): Promise<ReservationRow | null> {
  return store.sqlGet<ReservationRow>(
    "select * from name_reservations where instance_id = $1",
    [instanceId],
  );
}

/** At most one, because account_id is unique: one office per account is the
 * MVP's shape, and the constraint is what makes it true. */
export async function reservationForAccount(
  store: Store,
  accountId: string,
): Promise<ReservationRow | null> {
  return store.sqlGet<ReservationRow>(
    "select * from name_reservations where account_id = $1",
    [accountId],
  );
}

/** The instance an account may read. Tenant scope is the reservation row, and
 * there is no other path: nothing takes an account id from a caller. */
export async function instanceOwnedBy(
  store: Store,
  accountId: string,
  instanceId: string,
): Promise<ReservationRow | null> {
  const res = await reservationForInstance(store, instanceId);
  if (!res || res.account_id !== accountId) return null;
  return res;
}

// ------------------------------------------------------------------ identity

export class SubjectBindingConflict extends Error {}

export async function accountByGoogleSubject(
  store: Store,
  subject: string,
): Promise<AccountRow | null> {
  return store.sqlGet<AccountRow>(
    "select * from accounts where google_subject = $1",
    [subject],
  );
}

/**
 * Bind a Google identity to an account, or refuse.
 *
 * Two refusals, both of which are silent data corruption if they are allowed
 * through: one Google subject claiming a second account, and an account already
 * bound to a different subject being rebound by whoever holds that email today.
 * The partial unique index is the final arbiter - a race that gets past these
 * reads still ends in a constraint failure rather than two accounts sharing an
 * identity.
 */
export async function bindGoogleSubject(
  store: Store,
  args: { subject: string; email: string; now?: () => number },
): Promise<AccountRow> {
  const newId = () => `acct-${crypto.randomUUID()}`;
  return store.tx(async () => {
    const bySubject = await accountByGoogleSubject(store, args.subject);
    const byEmail = await accountByEmail(store, args.email);
    if (bySubject && byEmail && bySubject.id !== byEmail.id) {
      throw new SubjectBindingConflict(
        `this Google account is already signed in as ${bySubject.email}; ` +
          `${args.email} belongs to a different account`,
      );
    }
    if (bySubject) return bySubject;
    if (byEmail) {
      if (byEmail.google_subject && byEmail.google_subject !== args.subject) {
        throw new SubjectBindingConflict(
          `${args.email} is already bound to a different Google account`,
        );
      }
      const bound = await casAccount(store, byEmail.id, byEmail.version, {
        google_subject: args.subject,
      });
      if (!bound) {
        throw new Error(
          `account ${byEmail.id} is being changed by another process; try again`,
        );
      }
      return bound;
    }
    const made = await ensureAccount(store, { id: newId(), email: args.email });
    const bound = await casAccount(store, made.id, made.version, {
      google_subject: args.subject,
    });
    if (!bound) throw new Error("account binding did not land");
    return bound;
  });
}

/**
 * The account behind a developer sign-in, created on first use.
 *
 * It exists so that BOTH providers hand the session an account id: the durable
 * account is the tenant key, and a session that carried only an email would put
 * a mutable field in the authorization path.
 */
export async function accountForDevSignIn(
  store: Store,
  email: string,
): Promise<AccountRow> {
  return store.tx(() =>
    ensureAccount(store, { id: `acct-${crypto.randomUUID()}`, email }),
  );
}

/**
 * Is this the origin the deployment answers on?
 *
 * The signup POST writes durably and spends at Stripe on the strength of a
 * cookie, so a cross-site form post is a real request to refuse. Absence is
 * refused as hard as a mismatch: treating a missing Origin as same-origin is
 * exactly how the check would be bypassed.
 */
export function originIsTrusted(
  origin: string | null | undefined,
  trusted: string | null | undefined,
): boolean {
  if (!origin || !trusted) return false;
  try {
    return new URL(origin).origin === new URL(trusted).origin;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- reservation

export interface SignupRequest {
  /** THE TENANT KEY. Not the email: a session carrying an email would let a
   * changed Google email reach a different account than the one its durable
   * subject binding names. */
  accountId: string;
  officeName: string;
  plan: string;
  couponId?: string | null;
  customerSshKey?: string | null;
}

export interface SignupDeps {
  now?: () => number;
  /** Injected so a test can prove that a retry's identity does not come from a
   * clock: the same reservation must yield the same ids under a clock that
   * moved. */
  newId?: () => string;
}

export type SignupValidation =
  | { ok: true; plan: Plan }
  | { ok: false; reason: string };

/**
 * Everything that can be decided about a signup without touching anything.
 *
 * Separate from `reserveOffice` because callers need it BEFORE they check their
 * own configuration: a customer who typed a bad name should be told about the
 * name, not about our missing price id, and a deployment that cannot sell
 * anything should not have reserved a name on the way to finding that out.
 */
export function validateSignup(req: {
  officeName: string;
  plan: string;
  customerSshKey?: string | null;
}): SignupValidation {
  const plan = planById(req.plan);
  if (!plan)
    return { ok: false, reason: `"${req.plan}" is not a plan we offer` };
  const verdict = validateOfficeName(req.officeName);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  if (req.customerSshKey) {
    const key = validateCustomerSshKey(req.customerSshKey);
    if (!key.ok) return key;
  }
  return { ok: true, plan };
}

export type SignupOutcome =
  | {
      ok: true;
      reservation: ReservationRow;
      account: AccountRow;
      /** True when this call found an existing reservation of the same name for
       * the same account. The caller may then retry Checkout with identical
       * inputs; nothing was written. */
      reused: boolean;
    }
  | { ok: false; reason: string };

/**
 * Reserve an office name for an account, creating everything the name needs to
 * become a box.
 *
 * Refusals that cost nothing happen before the transaction opens: an unknown
 * plan and a bad or reserved name are decided by pure functions, so neither
 * reaches the database and neither can reach Stripe.
 */
export async function reserveOffice(
  store: Store,
  req: SignupRequest,
  deps: SignupDeps = {},
): Promise<SignupOutcome> {
  const now = deps.now ?? (() => store.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const valid = validateSignup(req);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const plan = valid.plan;

  const coupon = req.couponId ? req.couponId : null;
  const key = req.customerSshKey
    ? validateCustomerSshKey(req.customerSshKey)
    : null;
  if (key && !key.ok) return key;
  const customerSshKey = key?.normalized ?? null;
  const uuid = newId();
  const ts = now();

  return store.tx(async (): Promise<SignupOutcome> => {
    const account = await getAccount(store, req.accountId);
    if (!account) {
      return { ok: false, reason: "we do not recognise this account" };
    }
    const instanceId = `inst-${uuid}`;
    try {
      // AWAITED INSIDE THE TRY. Without the await the UNIQUE violation would
      // reject after this frame has left, so the catch below - the arm that
      // reads both constraints back and refuses a taken name - would never run.
      //
      // RECOVERABLE, because the catch below reads the database again: a failed
      // statement aborts the whole transaction on this engine, so without the
      // savepoint the read-back that decides refusal-versus-retry could not run
      // at all. The INSERT is still the arbiter, with no SELECT in front of it.
      await store.recoverable(() =>
        store.sqlRun(
          "insert into name_reservations (name, id, account_id, instance_id, plan, " +
            "coupon_id, version, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, 1, $7, $8)",
          [
            req.officeName,
            `res-${uuid}`,
            account.id,
            instanceId,
            plan.id,
            coupon,
            ts,
            ts,
          ],
        ),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // TWO unique constraints can refuse this insert, and they mean different
      // things: the name is somebody else's, or this account already has an
      // office. Read both back rather than guessing from the error text.
      const held = await reservationByName(store, req.officeName);
      if (!held) {
        const mine = await reservationForAccount(store, account.id);
        if (mine) {
          return {
            ok: false,
            reason:
              `you already have an office at "${mine.name}", and an account ` +
              `can have one office`,
          };
        }
        throw err;
      }
      if (held.account_id !== account.id) {
        return {
          ok: false,
          reason: `"${req.officeName}" is taken`,
        };
      }
      // The owner's own retry. Checkout inputs come from the row, so the only
      // question is whether this request AGREES with it: silently using the
      // stored plan would leave someone believing they had changed it.
      if (held.plan !== plan.id) {
        return {
          ok: false,
          reason:
            `"${req.officeName}" is already reserved on the ` +
            `${held.plan} plan; finish or abandon that checkout before ` +
            `choosing a different one`,
        };
      }
      if ((held.coupon_id ?? null) !== coupon) {
        return {
          ok: false,
          reason:
            `"${req.officeName}" is already reserved ` +
            (held.coupon_id
              ? `with the code ${held.coupon_id}`
              : "without a code") +
            `; finish or abandon that checkout before changing it`,
        };
      }
      const heldInstance = await store.getInstance(held.instance_id);
      if (!heldInstance)
        throw new Error("reserved instance is missing", { cause: err });
      if (
        heldInstance.access_window_expires_at !==
        held.created_at + ACCESS_WINDOW_MS
      ) {
        return {
          ok: false,
          reason:
            `"${req.officeName}" was reserved before the seven-day ` +
            `setup-access policy; recycle it from a new signup`,
        };
      }
      if ((heldInstance.customer_ssh_key ?? null) !== customerSshKey) {
        return {
          ok: false,
          reason: heldInstance.customer_ssh_key
            ? `"${req.officeName}" is already reserved with an SSH key; finish or abandon that checkout before changing it`
            : `"${req.officeName}" is already reserved without an SSH key; finish or abandon that checkout before adding one`,
        };
      }
      return { ok: true, reservation: held, account, reused: true };
    }

    await store.createInstance({
      id: instanceId,
      run_id: null,
      name: hostnameFor(req.officeName),
      plan: plan.providerProduct,
      region: plan.region,
      service_state: "provisioning",
      // 'live' and not 'handed_off': handoff is a customer-confirmed step, so
      // the chain this instance will walk ends at the invite.
      goal: "live",
      access_window_expires_at: ts + ACCESS_WINDOW_MS,
      customer_ssh_key: customerSshKey,
      ssh_login_user: null,
    });
    await store.createAsset({
      id: `asset-${uuid}`,
      instance_id: instanceId,
      provider: "contabo",
      // No box yet, and no claim that there is one. The axis exists so billing
      // and attention have somewhere to hang; it points at nothing.
      provider_id: null,
      intent_id: null,
      asset_state: "none",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: ts,
    });
    await store.appendAudit({
      actor: `account:${account.id}`,
      instance_id: instanceId,
      action: "reserve_office",
      target: req.officeName,
      outcome: "reserved",
      detail: JSON.stringify({ plan: plan.id, coupon: coupon ?? null }),
      ts,
    });
    const made = await reservationByName(store, req.officeName);
    if (!made) throw new Error("reservation insert did not land");
    return { ok: true, reservation: made, account, reused: false };
  });
}

/**
 * Turn a Checkout refusal into something a customer can act on.
 *
 * `openCheckout` is shared with the operator CLI, so its refusals name CLI
 * flags: "--coupon X cannot be used as a full discount: no such coupon". That
 * is the right message for the command and the wrong one for a form. The
 * translation lives here rather than in the web app so it is a tested function
 * rather than a string built in a route handler, and checkout.ts keeps its own
 * wording unchanged.
 */
export function customerReason(reason: string): string {
  const coupon =
    /^--coupon \S+ cannot be used as a full discount: ([\s\S]*)$/.exec(reason);
  if (coupon) return `that code cannot be applied: ${coupon[1]}`;
  return reason;
}

// ----------------------------------------------------------------- checkout

/** Both keys and the instance id come from the STORED reservation id, so a
 * retry cannot move a session to different inputs. */
export function checkoutKeysFor(reservation: ReservationRow): {
  customer: string;
  session: string;
} {
  const suffix = reservation.id.replace(/^res-/, "");
  return { customer: `cp4-cus-${suffix}`, session: `cp4-ses-${suffix}` };
}

/**
 * Assemble the inputs for `openCheckout`. Assembly only: coupon verification,
 * customer creation, session parameters and the test-mode checks all stay in
 * stripe/checkout.ts, which is the single Stripe creation path.
 */
export function checkoutInputsFor(args: {
  reservation: ReservationRow;
  account: AccountRow;
  email: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): OpenCheckoutArgs {
  const { reservation, account } = args;
  return {
    accountId: account.id,
    email: args.email,
    officeName: reservation.name,
    priceId: args.priceId,
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
    instanceId: reservation.instance_id,
    ...(reservation.coupon_id ? { couponId: reservation.coupon_id } : {}),
    ...(account.stripe_customer_id
      ? { customerId: account.stripe_customer_id }
      : {}),
    label: reservation.name,
    idempotencyKeys: checkoutKeysFor(reservation),
  };
}
