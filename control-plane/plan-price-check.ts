// The price-against-plan check (task 644649b3). A plan change is done by hand
// in two places: the operator switches the Stripe price, then moves the box in
// the provider's panel, and the provider poll writes instances.plan
// (tick.ts syncPlan). This check reports a subscription whose item price and
// instances.plan still disagree after a grace period that covers that lag.

import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import { planForItemPrice } from "./plans.ts";
import type { Store } from "./store.ts";

/** How long a price and a plan may disagree before an operator is told. */
export const PLAN_PRICE_GRACE_MS = 72 * 60 * 60 * 1000;

const ACTOR = "plan-price-check";
const REASON =
  "the subscription's Stripe price does not match the office's plan";

export interface PlanPriceSweepSummary {
  examined: number;
  raised: number;
  cleared: number;
}

interface Candidate {
  id: string;
  instance_id: string;
  item_price_state: "single" | "other";
  item_price_amount: number | null;
  item_price_currency: string | null;
  plan_mismatch_since: number | null;
  plan: string;
}

/**
 * One pass over live subscriptions (ended_at null, any status) linked to an
 * instance that is not deprovisioned, with a recorded item price. A mismatch
 * (an item price that is no plan's, or another plan's, or not a single priced
 * item) sets plan_mismatch_since; after PLAN_PRICE_GRACE_MS it raises attention
 * (operation_condition, warning, sourceOpId plan-price:<subscription id>). A
 * match clears plan_mismatch_since and that attention.
 *
 * plan_mismatch_since is our bookkeeping, so its writes are guarded on the
 * value read, not on subscriptions.version: bumping the version would make a
 * concurrent webhook apply lose its CAS on the Stripe-owned columns.
 */
export async function sweepPlanPrices(
  store: Store,
  now: number,
  report: (line: string) => void = () => {},
): Promise<PlanPriceSweepSummary> {
  const summary: PlanPriceSweepSummary = { examined: 0, raised: 0, cleared: 0 };
  const rows = await store.sqlAll<Candidate>(
    "select s.id, s.instance_id, s.item_price_state, s.item_price_amount, " +
      "s.item_price_currency, s.plan_mismatch_since, i.plan " +
      "from subscriptions s join instances i on i.id = s.instance_id " +
      "where s.ended_at is null and s.item_price_state is not null " +
      "and i.service_state <> 'deprovisioned' order by s.id",
  );
  for (const row of rows) {
    summary.examined++;
    const priced =
      row.item_price_state === "single" &&
      row.item_price_amount !== null &&
      row.item_price_currency !== null
        ? planForItemPrice({
            unitAmount: row.item_price_amount,
            currency: row.item_price_currency,
          })
        : null;
    const matches = priced?.providerProduct === row.plan;
    const source = `plan-price:${row.id}`;
    try {
      const outcome = await store.tx(async () => {
        if (matches) {
          await store.sqlRun(
            "update subscriptions set plan_mismatch_since = null " +
              "where id = $1 and plan_mismatch_since is not null",
            [row.id],
          );
          let cleared = false;
          for (const open of await store.openReasons(row.instance_id)) {
            if (open.source_op_id !== source) continue;
            await clearAttentionIn(store, row.instance_id, open.id, ACTOR);
            cleared = true;
          }
          return cleared ? "cleared" : null;
        }
        let since = row.plan_mismatch_since;
        if (since === null) {
          await store.sqlRun(
            "update subscriptions set plan_mismatch_since = $1 " +
              "where id = $2 and plan_mismatch_since is null",
            [now, row.id],
          );
          since = now;
        }
        if (now - since < PLAN_PRICE_GRACE_MS) return null;
        const raised = await raiseAttentionIn(store, {
          instanceId: row.instance_id,
          reasonClass: "operation_condition",
          sourceOpId: source,
          reason: REASON,
          severity: "warning",
          actor: ACTOR,
          detail:
            `plan ${row.plan}; price ${row.item_price_state}` +
            (row.item_price_state === "single"
              ? ` ${row.item_price_amount} ${row.item_price_currency}`
              : ""),
        });
        return raised ? "raised" : null;
      });
      if (outcome === "raised") summary.raised++;
      if (outcome === "cleared") summary.cleared++;
    } catch (err) {
      // The next pass compares again.
      report(
        `could not check the price of subscription ${row.id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return summary;
}
