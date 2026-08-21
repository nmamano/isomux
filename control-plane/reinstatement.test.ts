import { afterEach, describe, expect, test } from "bun:test";
import {
  CUSTOMER_CANCELLATION_REASON,
  LIFECYCLE_REASON,
  RETENTION_MS,
  lifecycleOperationId,
  phaseAt,
} from "./lifecycle.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";
import {
  attemptById,
  checkReinstatementEligibility,
  prepareReinstatementCheckout,
  recordReinstatementCheckoutFailure,
  recordReinstatementSession,
} from "./reinstatement.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { applyEvent } from "./stripe/reconcile.ts";
import {
  ensureAccount,
  insertSubscription,
  type SubscriptionRow,
} from "./stripe/billing-store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";
import type { Store } from "./store.ts";
import {
  checkoutExpiryHandler,
  raiseRefundRequired,
} from "./reinstatement-operations.ts";
import { StripeClient } from "./stripe/client.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";
import { CANCELLATION_POLICY_CUTOVER_KEY } from "./bootstrap.ts";

afterEach(releaseTestStores);
const ENDED = Date.parse("2027-01-01T00:00:00Z");

function clock(at: number) {
  const value = { at };
  return { now: () => value.at, set: (next: number) => (value.at = next) };
}

async function fixture(at = ENDED + 1): Promise<{
  store: Store;
  c: ReturnType<typeof clock>;
  instanceId: string;
  reservation: Awaited<ReturnType<typeof reserveOffice>> & { ok: true };
}> {
  const c = clock(at);
  const store = await openTestStore(c.now);
  const account = await accountForDevSignIn(store, "same@example.test");
  const reservation = await reserveOffice(
    store,
    {
      accountId: account.id,
      officeName: `retained-${crypto.randomUUID().slice(0, 6)}`,
      plan: "office",
      customerSshKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEgL3jWq4j1K5POI3XiZmqha6w3qjVYf9w1c8S0nTest same@example.test",
    },
    { now: c.now },
  );
  if (!reservation.ok) throw new Error(reservation.reason);
  const instanceId = reservation.reservation.instance_id;
  const inst = (await store.getInstance(instanceId))!;
  await store.casInstance(inst.id, inst.version, {
    service_state: "suspended",
    customer_ssh_key_fingerprint: "SHA256:customer",
    ssh_login_user: "isomux",
  });
  const asset = (await store.assetForInstance(instanceId))!;
  await store.casAsset(asset.id, asset.version, {
    provider_id: "provider-retained",
    asset_state: "active",
  });
  await store.tx(async () => {
    const a = await ensureAccount(store, {
      id: account.id,
      email: account.email,
    });
    await store.sqlRun(
      "update accounts set stripe_customer_id='cus-same' where id=$1",
      [a.id],
    );
    await insertSubscription(store, {
      id: "sub-old",
      account_id: a.id,
      instance_id: instanceId,
      stripe_customer_id: "cus-same",
      status: "canceled",
      current_period_end: ENDED,
      cancel_at_period_end: 1,
      ended_at: ENDED,
      canceled_at: ENDED - 1,
      cancellation_reason: CUSTOMER_CANCELLATION_REASON,
      cancellation_policy: "launch",
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
  const powerOff = lifecycleOperationId("power_off", "sub-old", ENDED);
  await store.enqueue({
    id: powerOff,
    instance_id: instanceId,
    kind: "power_off",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: { reason: LIFECYCLE_REASON },
  });
  await store.sqlRun(
    "update operations set status='succeeded', evidence=$1 where id=$2",
    [
      JSON.stringify({ reason: LIFECYCLE_REASON, poweredOffAt: ENDED }),
      powerOff,
    ],
  );
  return { store, c, instanceId, reservation };
}

describe("retained-office reinstatement", () => {
  test("reinstatement selects the requested office when the account has two", async () => {
    const f = await fixture();
    const second = await reserveOffice(f.store, {
      accountId: f.reservation.account.id,
      officeName: `second-${crypto.randomUUID().slice(0, 6)}`,
      plan: "office",
    });
    if (!second.ok) throw new Error(second.reason);

    expect(
      await prepareReinstatementCheckout(
        f.store,
        f.reservation.account.id,
        second.reservation.instance_id,
        f.c.now(),
      ),
    ).toEqual({ ok: false, reason: "we could not find that subscription" });
  });

  test("the customer boundary and Stripe technical expiry are distinct", () => {
    expect(
      phaseAt(
        {
          endedAt: ENDED,
          cancellationReason: CUSTOMER_CANCELLATION_REASON,
          poweredOffAt: ENDED,
          assetGone: false,
          cancellationPolicy: "launch",
          reinstatement: {
            state: "pending",
            attemptId: "a",
            fenceExpiresAt: ENDED + RETENTION_MS,
            expiryProven: false,
          },
        },
        ENDED + RETENTION_MS,
      ).phase,
    ).toBe("checkout_expiry_due");
  });

  test("access proof is the fingerprint, never ssh_login_user", async () => {
    const f = await fixture();
    const inst = (await f.store.getInstance(f.instanceId))!;
    await f.store.casInstance(inst.id, inst.version, {
      customer_ssh_key_fingerprint: null,
      ssh_login_user: "isomux",
    });
    const closed = (await f.store.sqlGet<SubscriptionRow>(
      "select * from subscriptions where id='sub-old'",
    ))!;
    expect(
      await checkReinstatementEligibility(f.store, {
        reservation: f.reservation.reservation,
        closed,
        now: f.c.now(),
      }),
    ).toMatchObject({ ok: false, code: "no_customer_access" });
  });

  test("any deletion row and the exact boundary refuse before Checkout", async () => {
    const f = await fixture();
    const closed = (await f.store.sqlGet<SubscriptionRow>(
      "select * from subscriptions where id='sub-old'",
    ))!;
    f.c.set(ENDED + RETENTION_MS);
    expect(
      await checkReinstatementEligibility(f.store, {
        reservation: f.reservation.reservation,
        closed,
        now: f.c.now(),
      }),
    ).toMatchObject({ ok: false, code: "too_late" });
    f.c.set(ENDED + 1);
    await f.store.enqueue({
      id: "ever-existed",
      instance_id: f.instanceId,
      kind: "remove_dns",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    await f.store.sqlRun(
      "update operations set status='failed' where id='ever-existed'",
    );
    expect(
      await checkReinstatementEligibility(f.store, {
        reservation: f.reservation.reservation,
        closed,
        now: f.c.now(),
      }),
    ).toMatchObject({ ok: false, code: "deletion_started" });
  });

  test("attempt generations change only after fetched expiry", async () => {
    const f = await fixture();
    const first = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    expect(first).toMatchObject({ ok: true, generation: 1 });
    if (!first.ok) return;
    expect(first.stripeExpiresAt).toBe(f.c.now() + 30 * 60_000 + 5_000);
    await recordReinstatementSession(f.store, first, "cs_1");
    const replay = await prepareReinstatementCheckout(
      f.store,
      first.account.id,
      f.instanceId,
      f.c.now(),
    );
    expect(replay).toMatchObject({ ok: true, generation: 1 });
    await f.store.sqlRun(
      "update reinstatement_attempts set state='expired' where id=$1",
      [first.attemptId],
    );
    const replacement = await prepareReinstatementCheckout(
      f.store,
      first.account.id,
      f.instanceId,
      f.c.now(),
    );
    expect(replacement).toMatchObject({ ok: true, generation: 2 });
  });

  test("failed Checkout creation advances to a fresh durable generation", async () => {
    const f = await fixture();
    const first = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!first.ok) throw new Error(first.reason);
    expect(
      await recordReinstatementCheckoutFailure(
        f.store,
        first,
        "injected create refusal",
      ),
    ).toBe(true);
    f.c.set(f.c.now() + 1_000);
    const replacement = await prepareReinstatementCheckout(
      f.store,
      first.account.id,
      f.instanceId,
      f.c.now(),
    );
    expect(replacement).toMatchObject({ ok: true, generation: 2 });
    if (!replacement.ok) return;
    expect(replacement.stripeExpiresAt).toBeGreaterThan(first.stripeExpiresAt);
  });

  test("linkage wins before boundary: closure is visible and deletion does not open", async () => {
    const f = await fixture();
    const prepared = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await recordReinstatementSession(f.store, prepared, "cs_link");
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-link",
        eventType: "checkout.session.completed",
        eventCreated: f.c.now(),
        now: f.c.now(),
        subscription: {
          id: "sub-new",
          customerId: "cus-same",
          status: "active",
          currentPeriodEnd: ENDED + 60_000,
          cancelAtPeriodEnd: false,
          endedAt: null,
          canceledAt: null,
          cancellationReason: null,
          discount: null,
          latestInvoiceId: null,
          metadata: {
            isomux_account: prepared.account.id,
            isomux_email: prepared.account.email,
            isomux_instance: f.instanceId,
            isomux_reinstatement: prepared.attemptId,
          },
          livemode: false,
        },
      }),
    );
    f.c.set(ENDED + RETENTION_MS);
    await lifecycleTick(f.store, f.c.now());
    expect((await attemptById(f.store, prepared.attemptId))?.state).toBe(
      "accepted",
    );
    expect(
      await f.store.sqlGet<{ instance_id: string | null }>(
        "select instance_id from subscriptions where id='sub-new'",
      ),
    ).toEqual({ instance_id: f.instanceId });
    expect(
      (await f.store.operationsFor(f.instanceId)).some(
        (op) => op.kind === "power_on",
      ),
    ).toBe(true);
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-old-late",
        eventType: "customer.subscription.deleted",
        eventCreated: f.c.now(),
        now: f.c.now(),
        subscription: {
          id: "sub-old",
          customerId: "cus-same",
          status: "canceled",
          currentPeriodEnd: ENDED,
          cancelAtPeriodEnd: true,
          endedAt: ENDED,
          canceledAt: ENDED - 1,
          cancellationReason: CUSTOMER_CANCELLATION_REASON,
          discount: null,
          latestInvoiceId: null,
          metadata: {},
          livemode: false,
        },
      }),
    );
    expect((await f.store.getInstance(f.instanceId))?.subscription_state).toBe(
      "active",
    );
    expect(
      (await f.store.operationsFor(f.instanceId)).filter((op) =>
        ["cancel_asset", "remove_dns"].includes(op.kind),
      ),
    ).toHaveLength(0);
  });

  test("deletion gate wins first: later linkage cannot attach and raises refund attention", async () => {
    const f = await fixture();
    const prepared = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await recordReinstatementSession(f.store, prepared, "cs_late");
    f.c.set(ENDED + RETENTION_MS);
    await lifecycleTick(f.store, f.c.now());
    expect(
      (await f.store.operationsFor(f.instanceId)).some(
        (op) => op.kind === "expire_checkout",
      ),
    ).toBe(true);
    expect(
      (await f.store.operationsFor(f.instanceId)).some(
        (op) => op.kind === "cancel_asset",
      ),
    ).toBe(false);
    await f.store.sqlRun(
      "update reinstatement_attempts set state='expired' where id=$1",
      [prepared.attemptId],
    );
    await lifecycleTick(f.store, f.c.now());
    expect(
      (await f.store.operationsFor(f.instanceId)).some(
        (op) => op.kind === "cancel_asset",
      ),
    ).toBe(true);
    // The webhook transaction cannot half-link after the deletion transaction.
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-late",
        eventType: "checkout.session.completed",
        eventCreated: f.c.now(),
        now: f.c.now(),
        subscription: {
          id: "sub-late",
          customerId: "cus-same",
          status: "active",
          currentPeriodEnd: ENDED + 60_000,
          cancelAtPeriodEnd: false,
          endedAt: null,
          canceledAt: null,
          cancellationReason: null,
          discount: null,
          latestInvoiceId: null,
          metadata: {
            isomux_account: prepared.account.id,
            isomux_email: prepared.account.email,
            isomux_instance: f.instanceId,
            isomux_reinstatement: prepared.attemptId,
          },
          livemode: false,
        },
      }),
    );
    expect(
      await f.store.sqlGet<{ instance_id: string | null }>(
        "select instance_id from subscriptions where id='sub-late'",
      ),
    ).toEqual({ instance_id: null });
    expect(
      (await f.store.openReasons(f.instanceId)).some((r) =>
        r.reason.includes("refund or reconcile"),
      ),
    ).toBe(true);
  });

  test("incomplete subscription truth waits without false incidents, then active truth links and clears", async () => {
    const f = await fixture();
    const prepared = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await recordReinstatementSession(f.store, prepared, "cs_sca");
    const snapshot = {
      id: "sub-sca",
      customerId: "cus-same",
      currentPeriodEnd: ENDED + 60_000,
      cancelAtPeriodEnd: false,
      endedAt: null,
      canceledAt: null,
      cancellationReason: null,
      discount: null,
      latestInvoiceId: null,
      metadata: {
        isomux_account: prepared.account.id,
        isomux_email: prepared.account.email,
        isomux_instance: f.instanceId,
        isomux_reinstatement: prepared.attemptId,
      },
      livemode: false,
    };
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-sca-incomplete",
        eventType: "customer.subscription.created",
        eventCreated: f.c.now(),
        now: f.c.now(),
        subscription: { ...snapshot, status: "incomplete" },
      }),
    );
    expect(
      await f.store.sqlGet<{ instance_id: string | null }>(
        "select instance_id from subscriptions where id='sub-sca'",
      ),
    ).toEqual({ instance_id: null });
    expect(await f.store.openReasons(f.instanceId)).toHaveLength(0);

    const attempt = (await attemptById(f.store, prepared.attemptId))!;
    await f.store.tx(() =>
      raiseRefundRequired(f.store, attempt, "injected stale incident"),
    );
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-sca-active",
        eventType: "customer.subscription.updated",
        eventCreated: f.c.now() + 1,
        now: f.c.now() + 1,
        subscription: { ...snapshot, status: "active" },
      }),
    );
    expect(
      await f.store.sqlGet<{ instance_id: string | null }>(
        "select instance_id from subscriptions where id='sub-sca'",
      ),
    ).toEqual({ instance_id: f.instanceId });
    expect(await f.store.openReasons(f.instanceId)).toHaveLength(0);
  });

  test.each([
    ["paid", "refund or reconcile"],
    ["unpaid", "monitor and reconcile"],
    ["no_payment_required", "confirm and close"],
  ])(
    "completed Checkout records %s operator evidence",
    async (paymentStatus, words) => {
      const f = await fixture();
      const prepared = await prepareReinstatementCheckout(
        f.store,
        f.reservation.reservation.account_id,
        f.instanceId,
        f.c.now(),
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      await recordReinstatementSession(f.store, prepared, "cs_complete");
      const op = await f.store.enqueue({
        id: `op-checkout_expire-${prepared.attemptId}`,
        instance_id: f.instanceId,
        kind: "expire_checkout",
        inactivity_deadline_at: f.c.now() + 60_000,
        absolute_deadline_at: f.c.now() + 60_000,
        evidence: { attempt: prepared.attemptId },
      });
      const instance = (await f.store.getInstance(f.instanceId))!;
      const asset = (await f.store.assetForInstance(f.instanceId))!;
      const client = new StripeClient({
        key: "sk_test_abcdefghijklmnopqrstuvwxyz",
        mode: "test",
        attempts: 1,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "not open" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      });
      const ctx: HandlerContext = {
        store: f.store,
        op,
        instance,
        asset,
        fence: { id: op.id, version: op.version, holder: "test" },
        budget: new RemoteBudget(
          f.c.now() + 300_000,
          f.c.now() + 300_000,
          f.c.now,
        ),
        now: f.c.now(),
        report: () => {},
        audit: async () => {},
      };
      const result = await checkoutExpiryHandler({
        client,
        reader: {
          getCheckoutSession: async () => ({
            kind: "ok",
            object: {
              id: "cs_complete",
              subscriptionId: "sub-late",
              customerId: "cus-same",
              status: "complete",
              paymentStatus,
              paymentMethodCollection: "always",
              metadata: {},
              livemode: false,
            },
          }),
          getSubscription: async () => ({ kind: "absent" }),
          getInvoice: async () => ({ kind: "absent" }),
        },
      }).run(ctx);
      expect(result.kind).toBe("done");
      const reason = (await f.store.openReasons(f.instanceId))[0];
      expect(reason?.reason).toContain(words);
      const audits = await f.store.auditEvents();
      expect(
        audits.some((a) =>
          a.detail?.includes(`paymentStatus=${paymentStatus}`),
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["accepted expiry", true, "expired", "done"],
    ["fetched expiry", false, "expired", "done"],
    ["still open", false, "open", "retry"],
    ["unreadable truth", false, null, "retry"],
  ] as const)(
    "expiry operation handles %s without guessing",
    async (_label, expireAccepted, fetchedStatus, expectedKind) => {
      const f = await fixture();
      const prepared = await prepareReinstatementCheckout(
        f.store,
        f.reservation.reservation.account_id,
        f.instanceId,
        f.c.now(),
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      await recordReinstatementSession(f.store, prepared, "cs_expiry_shape");
      const op = await f.store.enqueue({
        id: `op-checkout_expire-${prepared.attemptId}`,
        instance_id: f.instanceId,
        kind: "expire_checkout",
        inactivity_deadline_at: f.c.now() + 60_000,
        absolute_deadline_at: f.c.now() + 60_000,
        evidence: { attempt: prepared.attemptId },
      });
      const client = new StripeClient({
        key: "sk_test_abcdefghijklmnopqrstuvwxyz",
        mode: "test",
        attempts: 1,
        fetchImpl: async () =>
          expireAccepted
            ? new Response(
                JSON.stringify({
                  status: "expired",
                  payment_status: "unpaid",
                }),
                { status: 200 },
              )
            : new Response(JSON.stringify({ error: { message: "not open" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
      });
      const result = await checkoutExpiryHandler({
        client,
        reader: {
          getCheckoutSession: async () =>
            fetchedStatus === null
              ? { kind: "unavailable", reason: "injected read failure" }
              : {
                  kind: "ok",
                  object: {
                    id: "cs_expiry_shape",
                    subscriptionId: null,
                    customerId: "cus-same",
                    status: fetchedStatus,
                    paymentStatus: "unpaid",
                    paymentMethodCollection: "always",
                    metadata: {},
                    livemode: false,
                  },
                },
          getSubscription: async () => ({ kind: "absent" }),
          getInvoice: async () => ({ kind: "absent" }),
        },
      }).run({
        store: f.store,
        op,
        instance: (await f.store.getInstance(f.instanceId))!,
        asset: (await f.store.assetForInstance(f.instanceId))!,
        fence: { id: op.id, version: op.version, holder: "test" },
        budget: new RemoteBudget(
          f.c.now() + 300_000,
          f.c.now() + 300_000,
          f.c.now,
        ),
        now: f.c.now(),
        report: () => {},
        audit: async () => {},
      });
      expect(result.kind).toBe(expectedKind);
      expect((await attemptById(f.store, prepared.attemptId))?.state).toBe(
        expectedKind === "done" ? "expired" : "pending",
      );
      expect((await f.store.openReasons(f.instanceId)).length).toBe(
        expectedKind === "retry" ? 1 : 0,
      );
    },
  );

  test("an attempt with no Checkout session resolves safely at the boundary", async () => {
    const f = await fixture();
    const prepared = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const op = await f.store.enqueue({
      id: `op-checkout_expire-${prepared.attemptId}`,
      instance_id: f.instanceId,
      kind: "expire_checkout",
      inactivity_deadline_at: f.c.now() + 60_000,
      absolute_deadline_at: f.c.now() + 60_000,
      evidence: { attempt: prepared.attemptId },
    });
    const client = new StripeClient({
      key: "sk_test_abcdefghijklmnopqrstuvwxyz",
      mode: "test",
      fetchImpl: async () => {
        throw new Error("Stripe must not be called without a session id");
      },
    });
    const result = await checkoutExpiryHandler({
      client,
      reader: {
        getCheckoutSession: async () => ({ kind: "absent" }),
        getSubscription: async () => ({ kind: "absent" }),
        getInvoice: async () => ({ kind: "absent" }),
      },
    }).run({
      store: f.store,
      op,
      instance: (await f.store.getInstance(f.instanceId))!,
      asset: (await f.store.assetForInstance(f.instanceId))!,
      fence: { id: op.id, version: op.version, holder: "test" },
      budget: new RemoteBudget(
        f.c.now() + 300_000,
        f.c.now() + 300_000,
        f.c.now,
      ),
      now: f.c.now(),
      report: () => {},
      audit: async () => {},
    });
    expect(result.kind).toBe("done");
    expect((await attemptById(f.store, prepared.attemptId))?.state).toBe(
      "expired",
    );
  });

  test("cancel -> reinstate -> cancel starts a fresh timeline with fresh ids", async () => {
    const f = await fixture();
    const prepared = await prepareReinstatementCheckout(
      f.store,
      f.reservation.reservation.account_id,
      f.instanceId,
      f.c.now(),
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await recordReinstatementSession(f.store, prepared, "cs_second_cancel");
    await f.store.sqlRun(
      "insert into schema_meta (key, value) values ($1, $2) on conflict (key) do update set value=excluded.value",
      [CANCELLATION_POLICY_CUTOVER_KEY, String(ENDED - 1)],
    );
    await f.store.tx(() =>
      applyEvent(f.store, {
        eventId: "evt-second-live",
        eventType: "checkout.session.completed",
        eventCreated: f.c.now(),
        now: f.c.now(),
        subscription: {
          id: "sub-second",
          customerId: "cus-same",
          status: "active",
          currentPeriodEnd: ENDED + 2 * RETENTION_MS,
          cancelAtPeriodEnd: false,
          endedAt: null,
          canceledAt: null,
          cancellationReason: null,
          discount: null,
          latestInvoiceId: null,
          metadata: {
            isomux_account: prepared.account.id,
            isomux_email: prepared.account.email,
            isomux_instance: f.instanceId,
            isomux_reinstatement: prepared.attemptId,
          },
          livemode: false,
        },
      }),
    );
    expect(
      await f.store.sqlGet<{ instance_id: string | null }>(
        "select instance_id from subscriptions where id='sub-second'",
      ),
    ).toEqual({ instance_id: f.instanceId });
    const secondEnd = ENDED + RETENTION_MS / 2;
    f.c.set(secondEnd);
    await f.store.sqlRun(
      "update subscriptions set status='canceled', ended_at=$1, cancellation_reason=$2 where id='sub-second'",
      [secondEnd, CUSTOMER_CANCELLATION_REASON],
    );
    // Provider truth for the second episode says the box is live again.
    const inst = (await f.store.getInstance(f.instanceId))!;
    await f.store.casInstance(inst.id, inst.version, { service_state: "live" });
    const secondTick = await lifecycleTick(f.store, f.c.now());
    expect(secondTick.opened).toBe(1);
    expect(
      (await f.store.operationsFor(f.instanceId)).some(
        (op) =>
          op.id === lifecycleOperationId("power_off", "sub-second", secondEnd),
      ),
    ).toBe(true);
  });
});
