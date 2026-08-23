import { afterEach, describe, expect, test } from "bun:test";
import { CANCELLATION_POLICY_CUTOVER_KEY } from "../bootstrap.ts";
import { Store } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import {
  ensureAccount,
  getSubscription,
  insertSubscription,
} from "./billing-store.ts";
import { META_ACCOUNT, META_EMAIL, META_INSTANCE } from "./metadata.ts";
import { applyEvent } from "./reconcile.ts";
import type { SubscriptionSnapshot } from "./shapes.ts";

const CUTOVER = Date.parse("2026-08-13T00:00:00Z");

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

function snapshot(
  id: string,
  over: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    id,
    customerId: `cus-${id}`,
    status: "active",
    currentPeriodEnd: CUTOVER + 86_400_000,
    cancelAtPeriodEnd: false,
    endedAt: null,
    canceledAt: null,
    cancellationReason: null,
    discount: null,
    latestInvoiceId: null,
    metadata: {},
    livemode: false,
    ...over,
  };
}

async function markCutover(store: Store): Promise<void> {
  await store.sqlRun(
    "insert into schema_meta (key, value) values ($1, $2) " +
      "on conflict (key) do update set value = excluded.value",
    [CANCELLATION_POLICY_CUTOVER_KEY, String(CUTOVER)],
  );
}

describe("cancellation policy ownership", () => {
  test("the database arbitrates concurrent provider-ID adoption", async () => {
    const store = await openTestStore();
    for (const id of ["inst-a", "inst-b"]) {
      await store.createInstance({
        id,
        run_id: null,
        name: `${id}.test.isomux.app`,
        plan: "V153",
        region: "EU",
        service_state: "provisioning",
        goal: "live",
        access_window_expires_at: null,
      });
    }
    const results = await Promise.allSettled(
      ["inst-a", "inst-b"].map((id) =>
        store.tx(() =>
          store.createAsset({
            id: `asset-${id}`,
            instance_id: id,
            provider: "contabo",
            provider_id: "provider-shared",
            intent_id: id,
            asset_state: "active",
            ipv4: null,
            service_ends_at: null,
            host_key_fingerprint: null,
            next_reconcile_at: 0,
          }),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await store.close();
  });

  test("a pre-cutover cancellation first cached later is legacy", async () => {
    const store = await openTestStore();
    await markCutover(store);
    const sub = snapshot("sub-old", {
      cancelAtPeriodEnd: true,
      canceledAt: CUTOVER - 1,
      cancellationReason: "cancellation_requested",
    });
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt-old",
        eventType: "customer.subscription.updated",
        eventCreated: CUTOVER,
        subscription: sub,
        now: CUTOVER,
      }),
    );
    expect((await getSubscription(store, sub.id))?.cancellation_policy).toBe(
      "legacy",
    );
    await store.close();
  });

  test("un-cancel resets legacy so a future cancellation uses launch", async () => {
    const store = await openTestStore();
    await markCutover(store);
    const first = snapshot("sub-reset", {
      cancelAtPeriodEnd: true,
      canceledAt: CUTOVER - 1,
      cancellationReason: "cancellation_requested",
    });
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt-first",
        eventType: "customer.subscription.updated",
        eventCreated: CUTOVER,
        subscription: first,
        now: CUTOVER,
      }),
    );
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt-uncancel",
        eventType: "customer.subscription.updated",
        eventCreated: CUTOVER + 1,
        subscription: snapshot(first.id),
        now: CUTOVER + 1,
      }),
    );
    expect((await getSubscription(store, first.id))?.cancellation_policy).toBe(
      "launch",
    );
    await store.close();
  });

  test("prior cancellation blocks linkage even when the asset row is missing", async () => {
    const store = await openTestStore();
    await markCutover(store);
    await store.createInstance({
      id: "inst-retained",
      run_id: null,
      name: "retained.test.isomux.app",
      plan: "V153",
      region: "EU",
      service_state: "suspended",
      goal: "live",
      access_window_expires_at: null,
    });
    await store.tx(async () => {
      const account = await ensureAccount(store, {
        id: "acct-old",
        email: "old@example.test",
      });
      await insertSubscription(store, {
        id: "sub-old-owner",
        account_id: account.id,
        instance_id: "inst-retained",
        stripe_customer_id: "cus-old",
        status: "canceled",
        current_period_end: CUTOVER,
        cancel_at_period_end: 1,
        ended_at: CUTOVER,
        canceled_at: CUTOVER - 1,
        cancellation_reason: "cancellation_requested",
        cancellation_policy: "legacy",
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

    const incoming = snapshot("sub-new", {
      metadata: {
        [META_ACCOUNT]: "acct-new",
        [META_EMAIL]: "new@example.test",
        [META_INSTANCE]: "inst-retained",
      },
    });
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt-link",
        eventType: "customer.subscription.updated",
        eventCreated: CUTOVER + 2,
        subscription: incoming,
        now: CUTOVER + 2,
      }),
    );
    expect((await getSubscription(store, incoming.id))?.instance_id).toBeNull();
    expect(
      await store.sqlGet("select id from stripe_events where id = 'evt-link'"),
    ).not.toBeNull();
    const reasons = await store.openReasons("inst-retained");
    expect(reasons).toHaveLength(1);
    expect(reasons[0].reason).toContain("sub-new");
    await store.close();
  });
});
