import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  accountForDevSignIn,
  reserveOffice,
  type SignupSource,
} from "./signup.ts";
import {
  createOperationId,
  startProvisioningIn,
  sweepProvisioningStarts,
} from "./provisioning-start.ts";
import { insertSubscription } from "./stripe/billing-store.ts";
import {
  freshDsn,
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  TARGET_IS_LOCAL,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";
import { applyEvent, applyPolledCheckout } from "./stripe/reconcile.ts";
import { PROVISIONER_GRANTS } from "./roles.ts";
import { GRACE_MS, RETENTION_MS } from "./lifecycle.ts";
import { Store } from "./store.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

async function pending(store: Store): Promise<boolean> {
  const schedule = await store.workSchedule(
    store.now(),
    GRACE_MS,
    RETENTION_MS,
    {
      providerConfigured: true,
      provisioningConfigured: true,
      checkoutConfigured: true,
      cadenceConfigured: true,
      livenessConfigured: false,
      staleProvisioningMs: 30 * 60_000,
      staleProvisioningReason: "stalled",
    },
  );
  return schedule.tickDue || schedule.cadenceDue;
}

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
    expect(await pending(store)).toBe(false);
  });

  test("the one-statement wake probe sees paid repair work and then becomes idle", async () => {
    const b = await bed();
    expect(await pending(b.store)).toBe(true);
    await b.store.tx(() => startProvisioningIn(b.store, b.subscription));
    await b.store.sqlRun("update operations set status='succeeded'");
    expect(await pending(b.store)).toBe(false);
  });

  test("the schedule excludes paid repair whose permanent run id disagrees", async () => {
    const b = await bed();
    const instance = (await b.store.getInstance(b.instanceId))!;
    await b.store.casInstance(instance.id, instance.version, {
      run_id: "run-someone-else",
    });
    expect(await pending(b.store)).toBe(false);
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

// THE FIRST PAID CHECKOUT RECORD (task 8a12ba81): one row per office whose
// payment opened its create, carrying the signup source its reservation kept.
// Growth counts customers by source from it, so a payment seen twice must not
// count twice, a late settlement must count once, and the record must never
// cost a paying customer the create.

const T0 = 1_700_000_000_000;
const SOURCE: SignupSource = {
  utmSource: "newsletter",
  utmCampaign: "launch-week",
  referrerHost: "t.co",
  landingPath: "/blog/hosted",
};
const EMAIL = "buyer@example.com";
const OFFICE = "acme-source";

interface FirstPaidRow {
  subscription_id: string;
  instance_id: string;
  reservation_id: string;
  plan: string;
  coupon_id: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  referrer_host: string | null;
  landing_path: string | null;
  paid_at: string | number;
}

async function firstPaid(store: Store): Promise<FirstPaidRow[]> {
  return store.sqlAll<FirstPaidRow>(
    "select * from first_paid_checkouts order by subscription_id",
  );
}

/** A reservation with a pending Checkout session and a local subscription row
 * in `status`, on `store` (the owner). */
async function sourced(
  store: Store,
  opts: { status?: string; source?: SignupSource | null } = {},
) {
  const account = await accountForDevSignIn(store, EMAIL);
  const signup = await reserveOffice(store, {
    accountId: account.id,
    officeName: OFFICE,
    plan: "office",
    couponId: "launch100",
    source: opts.source === undefined ? SOURCE : opts.source,
  });
  if (!signup.ok) throw new Error(signup.reason);
  await store.sqlRun(
    "update name_reservations set checkout_session_id='cs-src', " +
      "checkout_state='pending' where id=$1",
    [signup.reservation.id],
  );
  const subscription = await store.tx(() =>
    insertSubscription(store, {
      id: "sub-src",
      account_id: account.id,
      instance_id: signup.reservation.instance_id,
      stripe_customer_id: "cus-src",
      status: opts.status ?? "active",
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
  return {
    subscription,
    reservation: signup.reservation,
    instanceId: signup.reservation.instance_id,
  };
}

function snapshots(status: string, paymentStatus: string) {
  return {
    subscription: {
      id: "sub-src",
      customerId: "cus-src",
      status,
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
      id: "cs-src",
      subscriptionId: "sub-src",
      customerId: "cus-src",
      status: "complete",
      paymentStatus,
      paymentMethodCollection: "always",
      metadata: {},
      livemode: false,
    },
  };
}

async function webhookCompleted(
  store: Store,
  eventId: string,
  paymentStatus = "paid",
  status = "active",
): Promise<void> {
  await store.tx(() =>
    applyEvent(store, {
      eventId,
      eventType: "checkout.session.completed",
      eventCreated: store.now(),
      now: store.now(),
      ...snapshots(status, paymentStatus),
    }),
  );
}

async function polledCompleted(
  store: Store,
  reservationId: string,
): Promise<void> {
  await store.tx(() =>
    applyPolledCheckout(store, {
      reservationId,
      now: store.now(),
      ...snapshots("active", "paid"),
    }),
  );
}

describe("the first paid checkout record", () => {
  test("a paid Checkout seen by the webhook, its retry and the poll gives one row with the reservation's source", async () => {
    let now = T0;
    const store = await openTestStore(() => now);
    const b = await sourced(store);
    await webhookCompleted(store, "evt-1");
    const paidAt = now;
    now += 60_000;
    await webhookCompleted(store, "evt-2");
    await polledCompleted(store, b.reservation.id);
    expect(await sweepProvisioningStarts(store, () => true)).toBe(0);

    const rows = await firstPaid(store);
    expect(rows).toHaveLength(1);
    expect({ ...rows[0], paid_at: Number(rows[0].paid_at) }).toEqual({
      subscription_id: "sub-src",
      instance_id: b.instanceId,
      reservation_id: b.reservation.id,
      plan: "office",
      coupon_id: "launch100",
      utm_source: "newsletter",
      utm_campaign: "launch-week",
      referrer_host: "t.co",
      landing_path: "/blog/hosted",
      paid_at: paidAt,
    });
  });

  test("the poll confirming first and the webhook after it also gives one row", async () => {
    const store = await openTestStore(() => T0);
    const b = await sourced(store);
    await polledCompleted(store, b.reservation.id);
    await webhookCompleted(store, "evt-1");
    expect((await firstPaid(store)).map((r) => r.subscription_id)).toEqual([
      "sub-src",
    ]);
  });

  test("a Checkout that completes unpaid records nothing until it settles, then the sweep records it once", async () => {
    let now = T0;
    const store = await openTestStore(() => now);
    const b = await sourced(store, { status: "incomplete" });
    await webhookCompleted(store, "evt-unpaid", "unpaid", "incomplete");
    // The enabling condition: nothing opened, so the record has nothing to
    // follow yet.
    expect(await store.operationsFor(b.instanceId)).toEqual([]);
    expect(await firstPaid(store)).toEqual([]);

    now += 3 * 24 * 60 * 60_000;
    await store.sqlRun(
      "update subscriptions set status='active' where id='sub-src'",
    );
    expect(await sweepProvisioningStarts(store, () => true)).toBe(1);
    expect(await sweepProvisioningStarts(store, () => true)).toBe(0);
    const rows = await firstPaid(store);
    expect(rows.map((r) => [r.subscription_id, r.utm_source])).toEqual([
      ["sub-src", "newsletter"],
    ]);
    expect(Number(rows[0].paid_at)).toBe(now);
  });

  test("a later subscription on the same office is not a second first payment", async () => {
    const store = await openTestStore(() => T0);
    const b = await sourced(store);
    await webhookCompleted(store, "evt-1");
    // A returning customer: the office already spent its create, and a new
    // subscription now points at it.
    await store.sqlRun(
      "update subscriptions set status='canceled' where id='sub-src'",
    );
    await store.tx(() =>
      insertSubscription(store, {
        ...b.subscription,
        id: "sub-again",
        status: "active",
      }),
    );
    await sweepProvisioningStarts(store, () => true);
    expect((await firstPaid(store)).map((r) => r.subscription_id)).toEqual([
      "sub-src",
    ]);
  });

  test("a record that cannot be written still opens the create, and its log line names no customer", async () => {
    // A FRESH schema: a recycled one is wiped of rows, not constraints, and
    // the refusing constraint below would silently fail every later record.
    const store = await openTestStoreOn(await freshDsn(), () => T0);
    const b = await sourced(store);
    await store.sqlRun(
      "alter table first_paid_checkouts add constraint refuse_every_row check (paid_at < 0)",
    );
    const logged: string[] = [];
    const real = {
      error: console.error,
      warn: console.warn,
      log: console.log,
    };
    const capture = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    try {
      await webhookCompleted(store, "evt-1");
    } finally {
      console.error = real.error;
      console.warn = real.warn;
      console.log = real.log;
    }
    expect(
      await store.getOperation(createOperationId(b.instanceId)),
    ).not.toBeNull();
    expect(await firstPaid(store)).toEqual([]);
    // Fail open, but not silently: a missing grant must show in the log.
    expect(logged.some((line) => line.includes("sub-src"))).toBe(true);
    for (const line of logged) {
      for (const secret of [EMAIL, OFFICE]) {
        expect([line, line.includes(secret)]).toEqual([line, false]);
      }
    }
  });
});

// THE ROLE THE WEBHOOK, THE POLL AND THE SWEEP RUN AS. The record fails open,
// so a grant the provisioner lacks would lose every row with no failing call:
// only a run as that role shows it. LOCAL ENGINE ONLY: it creates a login role.
const privileged = TARGET_IS_LOCAL ? describe : describe.skip;

privileged("the first paid checkout record as the provisioner's role", () => {
  const roleStores: Store[] = [];
  afterEach(async () => {
    for (const store of roleStores.splice(0)) await store.close();
  }, PG_TEST_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await dropLeastPrivilegedRoles();
  }, PG_TEST_HOOK_TIMEOUT_MS);

  test("the deployed matrix writes the row, and a signup with no source still counts", async () => {
    const dsn = await freshDsn();
    const owner = await openTestStoreOn(dsn, () => T0);
    const b = await sourced(owner, { source: null });
    const role = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn, grants: PROVISIONER_GRANTS }),
      () => T0,
    );
    roleStores.push(role);
    const current = await role.sqlGet<typeof b.subscription>(
      "select * from subscriptions where id='sub-src'",
    );
    if (!current) throw new Error("fixture");
    await role.tx(() => startProvisioningIn(role, current));
    expect(
      await owner.getOperation(createOperationId(b.instanceId)),
    ).not.toBeNull();
    const rows = await firstPaid(owner);
    expect(
      rows.map((r) => [
        r.subscription_id,
        r.utm_source,
        r.utm_campaign,
        r.referrer_host,
        r.landing_path,
      ]),
    ).toEqual([["sub-src", null, null, null, null]]);
  });
});
