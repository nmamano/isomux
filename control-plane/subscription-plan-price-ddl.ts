// The subscriptions columns behind the price-against-plan check (task
// 644649b3), kept out of store.ts for its size. store.ts splices the DDL into
// SCHEMA after the subscriptions table, and bootstrap.ts
// migrateSubscriptionItemPriceColumns runs the same text on an existing
// database.

/**
 * Stripe-owned: what the subscription's items say, written by reconciliation
 * from a fetched subscription (stripe/dunning.ts ownedFrom).
 *   item_price_state    null = not recorded yet; 'single' = exactly one item,
 *                       whose price has a unit amount; 'other' = recorded, any
 *                       other shape (no item, several, no unit amount).
 *   item_price_amount   the price's unit_amount, for 'single' only.
 *   item_price_currency the price's own currency, for 'single' only.
 * Ours: plan_mismatch_since, when plan-price-check.ts first saw the price and
 * instances.plan disagree; null while they agree.
 */
export const SUBSCRIPTION_PLAN_PRICE_DDL = `
alter table if exists subscriptions add column if not exists item_price_state text check (
  item_price_state is null or item_price_state in ('single', 'other')
);
alter table if exists subscriptions add column if not exists item_price_amount bigint;
alter table if exists subscriptions add column if not exists item_price_currency text;
alter table if exists subscriptions add column if not exists plan_mismatch_since bigint;
`;

/** The subscriptions columns added after the table was first created, which
 * Store.assertSchemaIsCurrent requires. */
export const SUBSCRIPTION_REQUIRED_COLUMNS: [string, string][] = [
  ["subscriptions", "episode_state"],
  ["subscriptions", "exhaustion_observed_at"],
  ["subscriptions", "ended_at"],
  ["subscriptions", "canceled_at"],
  ["subscriptions", "cancellation_reason"],
  ["subscriptions", "cancellation_policy"],
  ["subscriptions", "currency"],
  ["subscriptions", "item_price_state"],
  ["subscriptions", "item_price_amount"],
  ["subscriptions", "item_price_currency"],
  ["subscriptions", "plan_mismatch_since"],
];
