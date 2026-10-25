// When an unpaid office reservation stops holding its name and its admission
// place (task 9ed7430a). SQL fragments rather than TypeScript, so the admission
// count, the per-account bound, the takeover and the progress projection all
// apply one rule inside their own statement. It imports nothing, so store.ts
// and signup.ts can both use it.

/**
 * How long an 'opening' reservation stays live with no recorded session. Stripe
 * may still hold a session made under its idempotency key when recording it
 * failed: a session lives at most 24 h, and Stripe retries a webhook for up to
 * three days, so after four days an unseen payment is not possible in practice.
 */
export const UNPAID_OPENING_HOLD_MS = 4 * 24 * 60 * 60 * 1000;

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
 * DEAD: unpaid with its Checkout over. A dead reservation holds no admission
 * place, does not count against its account's one live unpaid reservation,
 * and its name goes to the next signup for it. One predicate for all three,
 * so they cannot disagree.
 */
export function deadSql(r: string, cutoff: string): string {
  return `(not ${paidSql(r)} and ${checkoutOverSql(r, cutoff)})`;
}
