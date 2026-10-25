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
  checkoutOverSql,
  deadSql,
  paidSql,
  UNPAID_OPENING_HOLD_MS,
} from "./reservation-hold.ts";
import {
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
import type { Refusal } from "./refusal.ts";
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
 * The domain new customer offices are named under. It is a reviewed build
 * constant because every caller composing a NEW office name uses the same
 * customer namespace. Changing it does not rename offices already persisted in
 * the store.
 */
export const OFFICE_DOMAIN = "isomux.app";

export const NEW_OFFICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NEW_OFFICES_PER_WINDOW = 40;

/**
 * Serializes the rolling admission check without adding a table-lock edge to
 * the reservation DML graph. The value is a stable, process-independent key.
 */
const NEW_OFFICE_ADMISSION_LOCK = 0x69736f6d7578;

/**
 * Let's Encrypt allowed 50 new certificates per registered domain per seven
 * days, as measured 2026-08-13 in internal-docs/port-proxy-design.md. Each new
 * office needs one office+wildcard certificate. Forty admissions hold ten back
 * for reissue, replacement, and the cp1/cp2/cp5 infrastructure names, which
 * also spend the isomux.app budget from under test.isomux.app.
 *
 * This is a sanity check on ADMISSIONS, not certificate accounting. A reserved
 * office issues its certificate when provisioning runs, so the bound holds
 * while issuance follows reservation closely.
 */
const NEW_OFFICE_LIMIT_REASON =
  "we cannot accept another office signup yet; try again later";
const NEW_OFFICE_LIMIT = new Error("new office admission limit");

/** Thrown, not returned, so the transaction rolls back what it wrote. */
class UnpaidReservationHeld extends Error {
  constructor(readonly officeName: string) {
    super("the account holds a live unpaid reservation");
  }
}

function admissionOutcome(err: unknown): SignupOutcome {
  if (err === NEW_OFFICE_LIMIT) {
    return { ok: false, kind: "customer", reason: NEW_OFFICE_LIMIT_REASON };
  }
  if (err instanceof UnpaidReservationHeld) {
    return {
      ok: false,
      kind: "customer",
      reason:
        `complete payment for "${err.officeName}" before you set up ` +
        `another office`,
    };
  }
  throw err;
}

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
  checkout_session_id: string | null;
  checkout_generation: number | null;
  checkout_expires_at: number | null;
  checkout_state: "opening" | "pending" | "reconciled" | "expired" | null;
  checkout_next_check_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

/** Compose the full hostname for a NEW office before its instance is stored. */
export function hostnameForNewOffice(officeName: string): string {
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

export { UNPAID_OPENING_HOLD_MS };

/** The account's first unpaid reservation whose Checkout is not over, or null.
 * `except` leaves out the name being reserved. */
export async function heldUnpaidReservation(
  store: Store,
  accountId: string,
  now: number,
  except?: string,
): Promise<ReservationRow | null> {
  return store.sqlGet<ReservationRow>(
    "select r.* from name_reservations r where r.account_id = $1 " +
      "and ($3::text is null or r.name <> $3) " +
      `and not ${paidSql("r")} and not ${checkoutOverSql("r", "$2")} ` +
      "order by r.created_at, r.name limit 1",
    [accountId, now - UNPAID_OPENING_HOLD_MS, except ?? null],
  );
}

/** Whether the reservation is dead: unpaid, with its Checkout over. */
export async function reservationIsDead(
  store: Store,
  reservation: ReservationRow,
  now: number,
): Promise<boolean> {
  const row = await store.sqlGet<{ dead: boolean }>(
    `select ${deadSql("r", "$2")} as dead from name_reservations r where r.id = $1`,
    [reservation.id, now - UNPAID_OPENING_HOLD_MS],
  );
  return row?.dead === true;
}

/** Every office reserved by an account, in creation order. The name tie-breaker
 * makes the order total when two reservations share a millisecond. */
export async function reservationsForAccount(
  store: Store,
  accountId: string,
): Promise<ReservationRow[]> {
  return store.sqlAll<ReservationRow>(
    "select * from name_reservations where account_id = $1 order by created_at, name",
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
 *
 * An address Google has not verified proves nothing, so it reaches only the
 * account its subject is already bound to: it neither binds onto an account by
 * address nor creates one. Since email sign-in, an account can exist that no
 * Google subject made, and an unverified claim on its address would otherwise
 * take it - or pre-create it, so that the real owner's later email sign-in
 * lands in an account the claimant can enter.
 */
export async function bindGoogleSubject(
  store: Store,
  args: {
    subject: string;
    email: string;
    emailVerified: boolean;
    now?: () => number;
  },
): Promise<AccountRow> {
  const newId = () => `acct-${crypto.randomUUID()}`;
  return store.tx(async () => {
    const bySubject = await accountByGoogleSubject(store, args.subject);
    if (bySubject && !args.emailVerified) return bySubject;
    if (!args.emailVerified) {
      throw new SubjectBindingConflict(`Google has not verified ${args.email}`);
    }
    const byEmail = await accountByAddress(store, args.email);
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
 * The account an address names, whatever case either side wrote it in.
 *
 * Google keeps the case a customer typed and an email sign-in lowercases, so an
 * exact match would let the two sign-ins make two accounts for one inbox. Two
 * rows that differ only in case can predate this; the exact spelling wins.
 */
async function accountByAddress(
  store: Store,
  email: string,
): Promise<AccountRow | null> {
  return store.sqlGet<AccountRow>(
    "select * from accounts where lower(email) = lower($1) " +
      "order by (email = $1) desc, created_at limit 1",
    [email],
  );
}

/**
 * The account behind an email sign-in link, created on first use.
 *
 * A redeemed link proves control of the inbox, the same authority a verified
 * Google address carries, so it reaches the account with that address also when
 * a Google subject is bound to it.
 */
export async function accountForEmailSignIn(
  store: Store,
  email: string,
): Promise<AccountRow> {
  return store.tx(async () => {
    const existing = await accountByAddress(store, email);
    if (existing) return existing;
    return ensureAccount(store, { id: `acct-${crypto.randomUUID()}`, email });
  });
}

// ------------------------------------------------------------ email change

/** Why a new address cannot become this account's address. */
export type EmailChangeRefusal = "unchanged" | "taken" | "no-account";

export type EmailChangeOutcome =
  | { ok: true; oldEmail: string; changed: boolean }
  | { ok: false; code: "taken" | "no-account" };

/** The form an address is stored in. `accounts_email` is a unique index on
 * the exact string, and an email sign-in writes lowercase, so only a lowercase
 * write lets the index refuse a second account at one inbox. */
function storedAddress(email: string): string {
  return email.trim().toLowerCase();
}

function refusalFor(
  account: AccountRow | null,
  holder: AccountRow | null,
  email: string,
): EmailChangeRefusal | null {
  if (!account) return "no-account";
  if (account.email.toLowerCase() === email) return "unchanged";
  if (holder && holder.id !== account.id) return "taken";
  return null;
}

/**
 * The read check before a change link is mailed and before Stripe is written.
 * Null when the address may become this account's address.
 */
export async function emailChangeRefusal(
  store: Store,
  accountId: string,
  newEmail: string,
): Promise<EmailChangeRefusal | null> {
  const email = storedAddress(newEmail);
  return refusalFor(
    await getAccount(store, accountId),
    await accountByAddress(store, email),
    email,
  );
}

/**
 * Move an account to a new address, after its holder opened the link mailed
 * there. The address is stored lowercased; the audit row names the account id
 * only, because an address is display data (the ops.ts rule).
 *
 * The read check is a fast path. The decision is the unique index: an account
 * made at the address by a sign-in that has not committed yet is invisible to
 * the read, and the update then waits on it and fails, inside a savepoint so
 * the answer is "taken" and not an aborted transaction.
 */
export async function changeAccountEmail(
  store: Store,
  args: { accountId: string; newEmail: string },
): Promise<EmailChangeOutcome> {
  const email = storedAddress(args.newEmail);
  return store.tx(async (): Promise<EmailChangeOutcome> => {
    const account = await getAccount(store, args.accountId);
    const refusal = refusalFor(
      account,
      await accountByAddress(store, email),
      email,
    );
    if (refusal === "no-account") return { ok: false, code: "no-account" };
    if (refusal === "taken") return { ok: false, code: "taken" };
    if (refusal === "unchanged") {
      return { ok: true, oldEmail: account!.email, changed: false };
    }
    let changed: AccountRow | null;
    try {
      changed = await store.recoverable(() =>
        casAccount(store, account!.id, account!.version, { email }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, code: "taken" };
      throw err;
    }
    if (!changed) {
      throw new Error(
        `account ${account!.id} is being changed by another process; try again`,
      );
    }
    await appendAccountAudit(store, account!.id, "account.email_changed");
    return { ok: true, oldEmail: account!.email, changed: true };
  });
}

/** Every Stripe customer that bills this account: one per office's
 * subscription, and the account's own when the operator CLI set one. */
export async function stripeCustomersForAccount(
  store: Store,
  accountId: string,
): Promise<string[]> {
  const rows = await store.sqlAll<{ customer: string }>(
    "select stripe_customer_id as customer from subscriptions where account_id = $1 " +
      "union select stripe_customer_id as customer from accounts " +
      "where id = $1 and stripe_customer_id is not null order by customer",
    [accountId],
  );
  return rows.map((row) => row.customer);
}

/**
 * Unbind the account's Google sign-in. False when none was bound.
 *
 * Afterwards that Google account reaches this one only by its address, the way
 * an unbound Google sign-in does (bindGoogleSubject): after an email change it
 * no longer does, and email is the way in.
 */
export async function removeGoogleSignIn(
  store: Store,
  accountId: string,
): Promise<boolean> {
  return store.tx(async () => {
    const account = await getAccount(store, accountId);
    if (!account?.google_subject) return false;
    const unbound = await casAccount(store, account.id, account.version, {
      google_subject: null,
    });
    if (!unbound) {
      throw new Error(
        `account ${account.id} is being changed by another process; try again`,
      );
    }
    await appendAccountAudit(store, account.id, "account.google_removed");
    return true;
  });
}

async function appendAccountAudit(
  store: Store,
  accountId: string,
  action: string,
): Promise<void> {
  await store.appendAudit({
    actor: `account:${accountId}`,
    instance_id: null,
    action,
    target: `account:${accountId}`,
    outcome: "succeeded",
    detail: null,
  });
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

export type SignupValidation = { ok: true; plan: Plan } | Refusal;

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
    return {
      ok: false,
      kind: "customer",
      reason: `"${req.plan}" is not a plan we offer`,
    };
  const verdict = validateOfficeName(req.officeName);
  if (!verdict.ok)
    return { ok: false, kind: "customer", reason: verdict.reason };
  if (req.customerSshKey) {
    const key = validateCustomerSshKey(req.customerSshKey);
    if (!key.ok) return { ok: false, kind: "customer", reason: key.reason };
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
  | Refusal;

/**
 * Give a dead reservation's name to a new signup. The row keeps its name and
 * gets everything else new; the caller has it locked and creates the office the
 * new instance id names.
 */
async function takeOverReservation(
  store: Store,
  old: ReservationRow,
  next: {
    id: string;
    accountId: string;
    instanceId: string;
    plan: string;
    coupon: string | null;
    ts: number;
  },
): Promise<void> {
  const taken = await store.sqlGet<{ id: string }>(
    "update name_reservations set id=$1, account_id=$2, instance_id=$3, plan=$4, " +
      "coupon_id=$5, checkout_generation=1, checkout_session_id=null, " +
      "checkout_expires_at=null, checkout_state='opening', checkout_next_check_at=null, " +
      "version=version+1, created_at=$6, updated_at=$6 where name=$7 and id=$8 returning id",
    [
      next.id,
      next.accountId,
      next.instanceId,
      next.plan,
      next.coupon,
      next.ts,
      old.name,
      old.id,
    ],
  );
  if (!taken) throw new Error("the locked reservation moved during takeover");
}

/** Retire the office a taken-over reservation named. Its asset never reached a
 * provider (provider_id is null), so nothing reconciles it. */
async function releaseOffice(
  store: Store,
  old: ReservationRow,
  takerAccountId: string,
  ts: number,
): Promise<void> {
  const instance = await store.getInstance(old.instance_id);
  if (!instance) throw new Error("released instance is missing");
  const retired = await store.casInstance(instance.id, instance.version, {
    service_state: "deprovisioned",
  });
  if (!retired) throw new Error(`instance ${instance.id} moved while released`);
  await store.appendAudit({
    actor: `account:${takerAccountId}`,
    instance_id: old.instance_id,
    action: "release_office",
    target: old.name,
    outcome: "released",
    detail: JSON.stringify({
      reservation: old.id,
      account: old.account_id,
      checkout_state: old.checkout_state,
    }),
    ts,
  });
}

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
  if (!valid.ok) return valid;
  const plan = valid.plan;

  const coupon = req.couponId ? req.couponId : null;
  const key = req.customerSshKey
    ? validateCustomerSshKey(req.customerSshKey)
    : null;
  if (key && !key.ok)
    return { ok: false, kind: "customer", reason: key.reason };
  const customerSshKey = key?.normalized ?? null;
  const uuid = newId();
  const ts = now();

  const reserve = async (): Promise<SignupOutcome> => {
    const account = await getAccount(store, req.accountId);
    if (!account) {
      return {
        ok: false,
        kind: "customer",
        reason: "we do not recognise this account",
      };
    }
    const instanceId = `inst-${uuid}`;
    let released: ReservationRow | null = null;
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
            "coupon_id, checkout_generation, checkout_state, version, created_at, updated_at) " +
            "values ($1, $2, $3, $4, $5, $6, 1, 'opening', 1, $7, $8)",
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
      // The name constraint decides collisions. Read it back rather than
      // guessing from the engine's error text. Locked, so the takeover below
      // decides on the row it then rewrites.
      const held = await store.sqlGet<ReservationRow & { dead: boolean }>(
        `select r.*, ${deadSql("r", "$2")} as dead from name_reservations r ` +
          "where r.name = $1 for update",
        [req.officeName, ts - UNPAID_OPENING_HOLD_MS],
      );
      if (held?.dead) {
        // Its Checkout is over and nobody paid: the name goes to this signup,
        // the owner's own included, as a fresh reservation with a new id. Both
        // Stripe idempotency keys derive from the id, so keeping the old one
        // would replay the old account's customer and session.
        const { dead: _, ...old } = held;
        await takeOverReservation(store, old, {
          id: `res-${uuid}`,
          accountId: account.id,
          instanceId,
          plan: plan.id,
          coupon,
          ts,
        });
        released = old;
      } else {
        if (!held) {
          // A database that has not received the multi-office owner migration can
          // still refuse a second name on its legacy account_id constraint. The
          // runtime schema check normally prevents that database from opening;
          // this arm keeps a direct caller from turning the same condition into
          // an unexplained 500.
          const mine = await reservationsForAccount(store, account.id);
          if (mine.length > 0) {
            return {
              ok: false,
              kind: "configuration",
              reason:
                "this deployment needs its multi-office database migration",
            };
          }
          throw err;
        }
        if (held.account_id !== account.id) {
          return {
            ok: false,
            kind: "customer",
            reason: `"${req.officeName}" is taken`,
          };
        }
        // The owner's own retry. Checkout inputs come from the row, so the only
        // question is whether this request AGREES with it: silently using the
        // stored plan would leave someone believing they had changed it.
        if (held.plan !== plan.id) {
          return {
            ok: false,
            kind: "customer",
            reason:
              `"${req.officeName}" is already reserved on the ` +
              `${held.plan} plan; finish or abandon that checkout before ` +
              `choosing a different one`,
          };
        }
        if ((held.coupon_id ?? null) !== coupon) {
          return {
            ok: false,
            kind: "customer",
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
            kind: "customer",
            reason:
              `"${req.officeName}" was reserved before the seven-day ` +
              `setup-access policy; recycle it from a new signup`,
          };
        }
        if ((heldInstance.customer_ssh_key ?? null) !== customerSshKey) {
          return {
            ok: false,
            kind: "customer",
            reason: heldInstance.customer_ssh_key
              ? `"${req.officeName}" is already reserved with an SSH key; finish or abandon that checkout before changing it`
              : `"${req.officeName}" is already reserved without an SSH key; finish or abandon that checkout before adding one`,
          };
        }
        const { dead: _, ...row } = held;
        return { ok: true, reservation: row, account, reused: true };
      }
    }

    await store.sqlRun("select pg_advisory_xact_lock($1)", [
      NEW_OFFICE_ADMISSION_LOCK,
    ]);
    // One live unpaid reservation per account, read under the lock so two
    // concurrent signups from one account see each other. It throws so the
    // transaction rolls back the row written above.
    const other = await heldUnpaidReservation(
      store,
      account.id,
      ts,
      req.officeName,
    );
    if (other) throw new UnpaidReservationHeld(other.name);
    // Dead reservations hold no place: only a paid office or a Checkout that
    // can still be paid may spend a certificate.
    const admitted = await store.sqlGet<{ n: number }>(
      "select count(*) as n from name_reservations r where r.created_at >= $1 " +
        `and not ${deadSql("r", "$2")}`,
      [ts - NEW_OFFICE_WINDOW_MS, ts - UNPAID_OPENING_HOLD_MS],
    );
    if (!admitted) throw new Error("new-office admission count is missing");
    if (admitted.n > MAX_NEW_OFFICES_PER_WINDOW) throw NEW_OFFICE_LIMIT;

    await store.createInstance({
      id: instanceId,
      run_id: null,
      name: hostnameForNewOffice(req.officeName),
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
    if (released) await releaseOffice(store, released, account.id, ts);
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
  };
  return store.tx(reserve).catch(admissionOutcome);
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
export function customerReason(reason: string): string | null {
  const coupon =
    /^--coupon \S+ cannot be used as a full discount: ([\s\S]*)$/.exec(reason);
  if (!coupon) return null;
  const detail = coupon[1];
  const safe =
    detail === "no such coupon" ||
    detail === "the coupon is not valid (expired, or fully redeemed)" ||
    /^this is (?:\d+(?:\.\d+)?% off|an amount-off coupon|no percentage), not a 100% discount, so Checkout must still collect a card; pass it as an ordinary discount or use a full-discount coupon$/.test(
      detail,
    );
  if (safe) return `that code cannot be applied: ${detail}`;
  return null;
}

// ----------------------------------------------------------------- checkout

/** Both keys and the instance id come from the STORED reservation id, so a
 * retry cannot move a session to different inputs. */
export function checkoutKeysFor(reservation: ReservationRow): {
  customer: string;
  session: string;
} {
  const suffix = reservation.id.replace(/^res-/, "");
  const generation = reservation.checkout_generation ?? 1;
  return {
    customer: `cp4-cus-${suffix}`,
    session: `cp4-ses-${suffix}-g${generation}`,
  };
}

export const CHECKOUT_POLL_INTERVAL_MS = 60_000;

/** Record only the ordinary reservation generation that opened this session. */
export async function recordOrdinaryCheckoutSession(
  store: Store,
  reservation: ReservationRow,
  session: { id: string; expiresAt: number },
): Promise<boolean> {
  const changed = await store.sqlGet<{ id: string }>(
    "update name_reservations set checkout_session_id=$1, checkout_expires_at=$2, " +
      "checkout_generation=$6, " +
      "checkout_state='pending', checkout_next_check_at=$3, updated_at=$4, version=version+1 " +
      "where id=$5 and coalesce(checkout_generation, 1)=$6 " +
      "and (checkout_state='opening' or checkout_state is null) " +
      "and checkout_session_id is null returning id",
    [
      session.id,
      session.expiresAt,
      store.now() + CHECKOUT_POLL_INTERVAL_MS,
      store.now(),
      reservation.id,
      reservation.checkout_generation ?? 1,
    ],
  );
  return changed !== null;
}

/** Terminalize only the exact generation Stripe confirms is no longer usable. */
export async function recordTerminalOrdinarySession(
  store: Store,
  reservationId: string,
  sessionId: string,
): Promise<boolean> {
  const changed = await store.sqlGet<{ id: string }>(
    "update name_reservations set checkout_state='expired', checkout_next_check_at=null, " +
      "updated_at=$1, version=version+1 where id=$2 and checkout_session_id=$3 " +
      "and checkout_state='pending' returning id",
    [store.now(), reservationId, sessionId],
  );
  return changed !== null;
}

/** Start the next generation only after the previous one is terminal. */
export async function advanceExpiredOrdinaryCheckout(
  store: Store,
  reservationId: string,
): Promise<ReservationRow | null> {
  return store.sqlGet<ReservationRow>(
    "update name_reservations set checkout_generation=checkout_generation+1, " +
      "checkout_session_id=null, checkout_expires_at=null, checkout_state='opening', " +
      "checkout_next_check_at=null, updated_at=$1, version=version+1 " +
      "where id=$2 and checkout_state='expired' returning *",
    [store.now(), reservationId],
  );
}

export async function dueOrdinaryCheckouts(
  store: Store,
  now: number,
): Promise<ReservationRow[]> {
  return store.sqlAll<ReservationRow>(
    "select r.* from name_reservations r left join subscriptions s " +
      "on s.instance_id=r.instance_id where r.checkout_state='pending' " +
      "and r.checkout_session_id is not null and r.checkout_next_check_at <= $1 " +
      "and s.id is null order by r.checkout_next_check_at, r.name",
    [now],
  );
}

export async function deferOrdinaryCheckoutPoll(
  store: Store,
  reservationId: string,
  sessionId: string,
  nextCheckAt: number,
): Promise<boolean> {
  const changed = await store.sqlGet<{ id: string }>(
    "update name_reservations set checkout_next_check_at=$1, updated_at=$2, " +
      "version=version+1 where id=$3 and checkout_session_id=$4 " +
      "and checkout_state='pending' returning id",
    [nextCheckAt, store.now(), reservationId, sessionId],
  );
  return changed !== null;
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
