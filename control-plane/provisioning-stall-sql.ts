// The provisioning stall predicate as SQL fragments, so the sweep
// (provisioning-stall.ts) and the work schedule (store.ts) apply one rule.
// It imports nothing, so store.ts can use it without reaching attention.ts.

/**
 * The subscription statuses that pay for an office: the set the start sweep
 * opens a create for (provisioning-start.ts).
 */
const PAID_STATUSES = "('active', 'trialing')";

/**
 * A paid office whose provisioning never started: `i` is an instances alias,
 * `cutoff` a SQL expression for now minus PROVISIONING_STALL_MS. The sweep and
 * the work schedule both use it, so a row the sweep raises is a row that woke it.
 */
export function stalledSql(i: string, cutoff: string): string {
  return (
    `(${i}.service_state = 'provisioning' ` +
    `and not exists (select 1 from operations o where o.instance_id = ${i}.id) ` +
    `and exists (select 1 from subscriptions s where s.instance_id = ${i}.id ` +
    `and s.status in ${PAID_STATUSES} and s.created_at <= ${cutoff}))`
  );
}

/**
 * When a paid office with no operation becomes stalled: its earliest paid
 * subscription plus `stallMs` (both SQL expressions). Null when it has none.
 */
export function stallDueSql(i: string, stallMs: string): string {
  return (
    `(select min(s.created_at) + ${stallMs} from subscriptions s ` +
    `where s.instance_id = ${i}.id and s.status in ${PAID_STATUSES})`
  );
}
