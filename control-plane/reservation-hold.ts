// When an unpaid office reservation stops holding its name and its admission
// place (task 9ed7430a). SQL fragments rather than TypeScript, so the admission
// count, the per-account bound, the takeover and the progress projection all
// apply one predicate inside their own statement. The predicate takes its
// cutoff as an argument: the admission count passes the short
// OPENING_ADMISSION_HOLD_MS and is its only reader; the others pass
// UNPAID_OPENING_HOLD_MS. It imports nothing, so store.ts and signup.ts can
// both use it.

/**
 * How long an 'opening' reservation stays live with no recorded session. Stripe
 * may still hold a session made under its idempotency key when recording it
 * failed: a session lives at most 24 h, and Stripe retries a webhook for up to
 * three days, so after four days an unseen payment is not possible in practice.
 */
export const UNPAID_OPENING_HOLD_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * How long an 'opening' reservation with no recorded session counts against
 * the shared new-office admission bound. The row is written and its Checkout
 * opened in one request, so an hour covers a burst of signups between their
 * insert and their session record. After it the row keeps its name and its
 * account's place for the full hold, but no longer blocks other signups
 * (task b390cb25).
 */
export const OPENING_ADMISSION_HOLD_MS = 60 * 60 * 1000;

/**
 * A reservation is PAID once its office has a subscription or a create
 * operation: either one can spend a certificate.
 */
export function paidSql(r: string): string {
  return (
    `(exists (select 1 from subscriptions s where s.instance_id = ${r}.instance_id) ` +
    `or exists (select 1 from operations o where o.instance_id = ${r}.instance_id ` +
    `and o.kind = 'create_instance'))`
  );
}

/**
 * Its Checkout is OVER when Stripe confirmed the session ended unpaid, or when
 * it recorded no session for the whole hold. `cutoff` is now minus the hold.
 * A pending session past its expiry is not over until the poll confirms it.
 * A legacy null state reads as 'opening'; the coalesce on both arms keeps the
 * predicate from being NULL, which `not` would leave NULL and drop the row.
 */
export function checkoutOverSql(r: string, cutoff: string): string {
  return (
    `(coalesce(${r}.checkout_state, 'opening') = 'expired' or ` +
    `(coalesce(${r}.checkout_state, 'opening') = 'opening' and ${r}.updated_at <= ${cutoff}))`
  );
}

/**
 * DEAD: unpaid with its Checkout over. With the UNPAID_OPENING_HOLD_MS cutoff,
 * a dead reservation does not count against its account's one live unpaid
 * reservation, and its name goes to the next signup for it. The admission
 * count calls it with the OPENING_ADMISSION_HOLD_MS cutoff instead, so a row
 * with no recorded session frees its admission place first, while it still
 * holds its name and its account's place.
 */
export function deadSql(r: string, cutoff: string): string {
  return `(not ${paidSql(r)} and ${checkoutOverSql(r, cutoff)})`;
}

/**
 * ABANDONED: instance `i` is still 'provisioning' while its reservation is
 * dead (task 03eef464). The sweep (abandoned-office.ts) and the work schedule
 * (store.ts) apply this one rule. `cutoff` is now minus UNPAID_OPENING_HOLD_MS.
 */
export function abandonedSql(i: string, cutoff: string): string {
  return (
    `(${i}.service_state = 'provisioning' and exists (select 1 from ` +
    `name_reservations n where n.instance_id = ${i}.id and ${deadSql("n", cutoff)}))`
  );
}

/**
 * The work schedule's cadence clause: some office is abandoned at `now` (a SQL
 * expression), with the cutoff the sweep computes.
 */
export function abandonedWakeSql(now: string): string {
  const cutoff = `(${now} - ${UNPAID_OPENING_HOLD_MS})`;
  return `exists (select 1 from instances i where ${abandonedSql("i", cutoff)})`;
}

/**
 * The work schedule's due-time arm, a complete `union all` branch: an office
 * with no recorded session becomes abandoned at its unpaid 'opening'
 * reservation's updated_at plus the hold. An expired reservation is abandoned
 * at once and needs no due time. The arm runs only while `gate` (a SQL
 * expression) is 1.
 */
export function abandonedDueSql(gate: string): string {
  return (
    `union all select n.updated_at + ${UNPAID_OPENING_HOLD_MS} from name_reservations n ` +
    `join instances i on i.id = n.instance_id where ${gate} = 1 ` +
    `and i.service_state = 'provisioning' and not ${paidSql("n")} ` +
    "and coalesce(n.checkout_state, 'opening') = 'opening'"
  );
}
