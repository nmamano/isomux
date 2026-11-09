// The price-against-plan check (task 644649b3). A plan change is done by hand
// in two places (the Stripe price, then the provider's panel), and the
// provider poll writes instances.plan. This sweep tells an operator when a
// live subscription's item price and its office's plan still disagree after
// a grace period that covers the operator's lag between the two.

import { afterEach, describe, expect, test } from "bun:test";
import { PLAN_PRICE_GRACE_MS, sweepPlanPrices } from "./plan-price-check.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const T0 = Date.parse("2026-11-09T12:00:00Z");
const SOURCE = "plan-price:sub_1";

interface Price {
  state: "single" | "other" | null;
  amount?: number;
  currency?: string;
}

async function bed(opts: {
  plan?: string;
  price: Price;
  status?: string;
  endedAt?: number | null;
  serviceState?: string;
}) {
  const clock = { t: T0 };
  const store = await openTestStore(() => clock.t);
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp3.test.isomux.app",
    plan: opts.plan ?? "V153",
    region: "EU",
    service_state: (opts.serviceState ?? "live") as never,
    goal: "live",
    access_window_expires_at: null,
  });
  await store.tx(async () => {
    const account = await ensureAccount(store, {
      id: "acct-1",
      email: "a@b.test",
    });
    await insertSubscription(store, {
      id: "sub_1",
      account_id: account.id,
      instance_id: "inst-1",
      stripe_customer_id: "cus_1",
      status: opts.status ?? "active",
      current_period_end: T0 + 30 * 86_400_000,
      cancel_at_period_end: 0,
      ended_at: opts.endedAt ?? null,
      canceled_at: null,
      cancellation_reason: null,
      discount_percent_off: null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: 0,
      latest_invoice_id: null,
      payment_failures: 0,
      exhaustion_observed_at: null,
      coupon_grace_until: null,
      episode_id: null,
      last_event_id: null,
      last_event_created: null,
    });
  });
  // What reconciliation records from the fetched subscription.
  const setPrice = (p: Price) =>
    store.sqlRun(
      "update subscriptions set item_price_state = $1, item_price_amount = $2, " +
        "item_price_currency = $3 where id = 'sub_1'",
      [p.state, p.amount ?? null, p.currency ?? null],
    );
  await setPrice(opts.price);
  const at = async (t: number) => {
    clock.t = t;
    return sweepPlanPrices(store, t);
  };
  const open = async () =>
    (await store.openReasons("inst-1")).filter(
      (r) => r.source_op_id === SOURCE,
    );
  const since = async () =>
    (
      await store.sqlGet<{ plan_mismatch_since: number | string | null }>(
        "select plan_mismatch_since from subscriptions where id = 'sub_1'",
      )
    )?.plan_mismatch_since ?? null;
  const setPlan = (plan: string) =>
    store.sqlRun("update instances set plan = $1 where id = 'inst-1'", [plan]);
  return { store, clock, at, open, since, setPrice, setPlan };
}

const ENTRY_EUR: Price = { state: "single", amount: 800, currency: "eur" };
const POWER_EUR: Price = { state: "single", amount: 1700, currency: "eur" };

describe("a price that matches the plan", () => {
  test.each([
    ["Entry, EUR", "V153", ENTRY_EUR],
    ["Poweruser, EUR", "V155", POWER_EUR],
    ["Entry, USD", "V153", { state: "single", amount: 900, currency: "usd" }],
    [
      "Poweruser, USD",
      "V155",
      { state: "single", amount: 1900, currency: "usd" },
    ],
  ] as const)("%s raises nothing, ever", async (_label, plan, price) => {
    const b = await bed({ plan, price: price as Price });
    expect(await b.at(T0)).toMatchObject({ examined: 1, raised: 0 });
    expect(await b.at(T0 + PLAN_PRICE_GRACE_MS + 1)).toMatchObject({
      examined: 1,
      raised: 0,
    });
    expect(await b.since()).toBeNull();
    expect(await b.open()).toEqual([]);
  });
});

describe("a price that does not match the plan", () => {
  test("is held for the grace period, then raised once, with no price or plan in the reason", async () => {
    // Stripe moved to Poweruser; the box is still on Entry.
    const b = await bed({ plan: "V153", price: POWER_EUR });
    await b.at(T0);
    expect(Number(await b.since())).toBe(T0);
    expect(await b.open()).toEqual([]);

    // The grace counts from the first sweep that saw it, not from each sweep.
    await b.at(T0 + PLAN_PRICE_GRACE_MS - 1);
    expect(Number(await b.since())).toBe(T0);
    expect(await b.open()).toEqual([]);

    expect(await b.at(T0 + PLAN_PRICE_GRACE_MS)).toMatchObject({ raised: 1 });
    const raised = await b.open();
    expect(raised).toHaveLength(1);
    expect(raised[0].severity).toBe("warning");
    for (const leak of ["1700", "800", "V153", "V155", "EUR"]) {
      expect([leak, raised[0].reason.includes(leak)]).toEqual([leak, false]);
    }

    await b.at(T0 + PLAN_PRICE_GRACE_MS + 60_000);
    expect(await b.open()).toHaveLength(1);
  });

  test("clears when the plan catches up, and a later mismatch waits a full grace again", async () => {
    const b = await bed({ plan: "V153", price: POWER_EUR });
    await b.at(T0);
    await b.at(T0 + PLAN_PRICE_GRACE_MS);
    expect(await b.open()).toHaveLength(1);

    // The provider poll wrote the new plan (tick.ts syncPlan).
    await b.setPlan("V155");
    const t1 = T0 + PLAN_PRICE_GRACE_MS + 3_600_000;
    expect(await b.at(t1)).toMatchObject({ cleared: 1 });
    expect(await b.since()).toBeNull();
    expect(await b.open()).toEqual([]);

    // Moved back by hand on one side only.
    await b.setPrice(ENTRY_EUR);
    const t2 = t1 + 86_400_000;
    await b.at(t2);
    expect(Number(await b.since())).toBe(t2);
    await b.at(t2 + PLAN_PRICE_GRACE_MS - 1);
    expect(await b.open()).toEqual([]);
    await b.at(t2 + PLAN_PRICE_GRACE_MS);
    expect(await b.open()).toHaveLength(1);
  });

  test.each([
    [
      "a price that is no plan's",
      { state: "single", amount: 1000, currency: "usd" },
    ],
    // The EUR amount of Entry in dollars: the currency is part of the identity.
    [
      "another currency's amount",
      { state: "single", amount: 800, currency: "usd" },
    ],
    // The Poweruser item added beside the Entry one, instead of swapped in.
    ["not one priced item", { state: "other" }],
  ] as const)("%s counts as a mismatch", async (_label, price) => {
    const b = await bed({ plan: "V153", price: price as Price });
    await b.at(T0);
    expect(Number(await b.since())).toBe(T0);
    await b.at(T0 + PLAN_PRICE_GRACE_MS);
    expect(await b.open()).toHaveLength(1);
  });

  test("a past_due subscription is still checked", async () => {
    const b = await bed({ plan: "V153", price: POWER_EUR, status: "past_due" });
    await b.at(T0);
    await b.at(T0 + PLAN_PRICE_GRACE_MS);
    expect(await b.open()).toHaveLength(1);
  });
});

describe("what the sweep does not look at", () => {
  test.each([
    // Each would be a mismatch if it were examined.
    ["a price not recorded yet", { price: { state: null } as Price }],
    [
      "an ended subscription",
      { price: POWER_EUR, endedAt: T0 - 1000, status: "canceled" },
    ],
    [
      "a deprovisioned office",
      { price: POWER_EUR, serviceState: "deprovisioned" },
    ],
  ] as const)("%s", async (_label, opts) => {
    const b = await bed({ plan: "V153", ...opts });
    expect(await b.at(T0)).toMatchObject({ examined: 0, raised: 0 });
    await b.at(T0 + PLAN_PRICE_GRACE_MS);
    expect(await b.since()).toBeNull();
    expect(await b.open()).toEqual([]);
  });
});
