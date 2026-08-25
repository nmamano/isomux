import { afterEach, describe, expect, test } from "bun:test";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import {
  createOperationId,
  startProvisioningIn,
  sweepProvisioningStarts,
} from "./provisioning-start.ts";
import { insertSubscription } from "./stripe/billing-store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { applyEvent } from "./stripe/reconcile.ts";
import { GRACE_MS, RETENTION_MS } from "./lifecycle.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

async function bed(status = "active") {
  const store = await openTestStore(() => 1_700_000_000_000);
  const account = await accountForDevSignIn(store, "paid@example.com");
  const signup = await reserveOffice(store, {
    accountId: account.id,
    officeName: "paid",
    plan: "office",
  });
  if (!signup.ok) throw new Error(signup.reason);
  const subscription = await store.tx(() =>
    insertSubscription(store, {
      id: "sub-paid",
      account_id: account.id,
      instance_id: signup.reservation.instance_id,
      stripe_customer_id: "cus-paid",
      status,
      current_period_end: null,
      cancel_at_period_end: 0,
      ended_at: null,
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
    }),
  );
  return { store, subscription, instanceId: signup.reservation.instance_id };
}

describe("automatic provisioning start", () => {
  test("a cp4-shaped placeholder without a subscription does not wake repair", async () => {
    const store = await openTestStore(() => 1_700_000_000_000);
    const account = await accountForDevSignIn(store, "cp4@example.com");
    const signup = await reserveOffice(store, {
      accountId: account.id,
      officeName: "cp4",
      plan: "office",
    });
    if (!signup.ok) throw new Error(signup.reason);
    expect(await store.operationsFor(signup.reservation.instance_id)).toEqual(
      [],
    );
    expect(
      await store.hasPendingWork(store.now(), GRACE_MS, RETENTION_MS),
    ).toBe(false);
  });

  test("the one-statement wake probe sees paid repair work and then becomes idle", async () => {
    const b = await bed();
    expect(
      await b.store.hasPendingWork(b.store.now(), GRACE_MS, RETENTION_MS),
    ).toBe(true);
    await b.store.tx(() => startProvisioningIn(b.store, b.subscription));
    await b.store.sqlRun("update operations set status='succeeded'");
    expect(
      await b.store.hasPendingWork(b.store.now(), GRACE_MS, RETENTION_MS),
    ).toBe(false);
  });

  test("a fetched paid Checkout event opens the create in its claim transaction", async () => {
    const b = await bed();
    await b.store.tx(() =>
      applyEvent(b.store, {
        eventId: "evt-paid",
        eventType: "checkout.session.completed",
        eventCreated: 1_700_000_000_000,
        now: 1_700_000_000_000,
        subscription: {
          id: "sub-paid",
          customerId: "cus-paid",
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          endedAt: null,
          canceledAt: null,
          cancellationReason: null,
          discount: null,
          latestInvoiceId: null,
          metadata: {},
          livemode: false,
        },
        session: {
          id: "cs-paid",
          subscriptionId: "sub-paid",
          customerId: "cus-paid",
          status: "complete",
          paymentStatus: "paid",
          paymentMethodCollection: "always",
          metadata: {},
          livemode: false,
        },
      }),
    );
    expect(
      await b.store.getOperation(createOperationId(b.instanceId)),
    ).not.toBeNull();
  });

  test("joins the signup instance to one run and opens one paid create", async () => {
    const b = await bed();
    const opened = await b.store.tx(() =>
      startProvisioningIn(b.store, b.subscription),
    );
    expect(opened).toBe(createOperationId(b.instanceId));
    expect((await b.store.getInstance(b.instanceId))?.run_id).toBe(
      `run-${b.instanceId.replace(/^inst-/, "")}`,
    );
    expect(
      (await b.store.operationsFor(b.instanceId)).map((op) => op.kind),
    ).toEqual(["create_instance"]);
  });

  test("a terminal create row permanently prevents a second create", async () => {
    const b = await bed();
    await b.store.tx(() => startProvisioningIn(b.store, b.subscription));
    await b.store.sqlRun("update operations set status='failed' where id=$1", [
      createOperationId(b.instanceId),
    ]);
    expect(await sweepProvisioningStarts(b.store, () => true)).toBe(0);
    expect(await b.store.operationsFor(b.instanceId)).toHaveLength(1);
  });

  test("the level-triggered sweep ignores an unpaid subscription", async () => {
    const b = await bed("incomplete");
    expect(await sweepProvisioningStarts(b.store, () => true)).toBe(0);
    expect(await b.store.operationsFor(b.instanceId)).toEqual([]);
  });

  test("a ticker missing either provider step leaves the one-shot eligible", async () => {
    const b = await bed();
    expect(
      await sweepProvisioningStarts(
        b.store,
        (kind) => kind === "create_instance",
      ),
    ).toBe(0);
    expect(await b.store.operationsFor(b.instanceId)).toEqual([]);
    expect((await b.store.getInstance(b.instanceId))?.run_id).toBeNull();
    expect(await sweepProvisioningStarts(b.store, () => true)).toBe(1);
  });
});
