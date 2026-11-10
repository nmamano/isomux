import { afterEach, describe, expect, test } from "bun:test";
import { raiseAttentionIn } from "./attention.ts";
import { Store } from "./store.ts";
import {
  PROVISIONING_STALL_MS,
  PROVISIONING_STALL_REASON,
  sweepProvisioningStalls,
} from "./provisioning-stall.ts";
import {
  accountForDevSignIn,
  recordOrdinaryCheckoutSession,
  recordTerminalOrdinarySession,
  reserveOffice,
} from "./signup.ts";
import { UNPAID_OPENING_HOLD_MS } from "./reservation-hold.ts";
import { insertSubscription } from "./stripe/billing-store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const DAY_MS = 86_400_000;

/** A reserved office, as the signup makes it: the instance is "provisioning"
 * from the reservation on, with no subscription and no operation. */
async function reserved() {
  let now = 1_700_000_000_000;
  const store = await openTestStore(() => now);
  const account = await accountForDevSignIn(store, "buyer@example.com");
  const signup = await reserveOffice(store, {
    accountId: account.id,
    officeName: "stalled",
    plan: "office",
  });
  if (!signup.ok) throw new Error(signup.reason);
  const instanceId = signup.reservation.instance_id;
  return {
    store,
    instanceId,
    reservation: signup.reservation,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    /** The subscription row reconciliation writes when Stripe reports one. */
    subscribe: (status: string, id = "sub-buyer") =>
      store.tx(() =>
        insertSubscription(store, {
          id,
          account_id: account.id,
          instance_id: instanceId,
          stripe_customer_id: "cus-buyer",
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
      ),
  };
}

// Only the stall arms: every other class is off, and no operation is open, so
// cadenceDue and nextDueAt speak for this sweep alone.
function schedule(store: Store) {
  return store.workSchedule(store.now(), 0, 0, {
    providerConfigured: false,
    provisioningConfigured: false,
    checkoutConfigured: false,
    cadenceConfigured: true,
    livenessConfigured: false,
    staleProvisioningMs: PROVISIONING_STALL_MS,
    staleProvisioningReason: PROVISIONING_STALL_REASON,
  });
}

/** The condition every case starts from: provisioning, and no operation. */
async function expectSilentProvisioning(store: Store, instanceId: string) {
  expect((await store.getInstance(instanceId))?.service_state).toBe(
    "provisioning",
  );
  expect(await store.operationsFor(instanceId)).toEqual([]);
}

describe("silent provisioning stalls", () => {
  test.each(["active", "trialing"])(
    "a paid office (%s) raises once 30 minutes after the payment, not the reservation, and any operation clears it",
    async (status) => {
      const f = await reserved();
      // The buyer pays well after reserving: the reservation alone is already
      // older than the stall window.
      f.advance(PROVISIONING_STALL_MS + 10 * 60_000);
      const paid = await f.subscribe(status);
      await expectSilentProvisioning(f.store, f.instanceId);
      expect(await sweepProvisioningStalls(f.store)).toBe(0);
      expect(await f.store.openReasons(f.instanceId)).toEqual([]);
      let s = await schedule(f.store);
      expect(s.cadenceDue).toBe(false);
      expect(s.nextDueAt).toBe(paid.created_at + PROVISIONING_STALL_MS);

      f.advance(PROVISIONING_STALL_MS - 1);
      expect((await schedule(f.store)).cadenceDue).toBe(false);
      expect(await sweepProvisioningStalls(f.store)).toBe(0);

      // The due time the schedule named is the instant the sweep raises.
      f.advance(1);
      expect(f.now()).toBe(paid.created_at + PROVISIONING_STALL_MS);
      await expectSilentProvisioning(f.store, f.instanceId);
      expect((await schedule(f.store)).cadenceDue).toBe(true);
      expect(await sweepProvisioningStalls(f.store)).toBe(1);
      const raised = await f.store.openReasons(f.instanceId);
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        source_op_id: "",
        reason: PROVISIONING_STALL_REASON,
        severity: "critical",
      });
      expect(await sweepProvisioningStalls(f.store)).toBe(0);
      s = await schedule(f.store);
      expect(s.cadenceDue).toBe(false);
      expect(s.nextDueAt).toBeNull();

      await f.store.enqueue({
        id: "op-ended",
        instance_id: f.instanceId,
        kind: "create_instance",
        inactivity_deadline_at: f.now() + 1,
        absolute_deadline_at: f.now() + 2,
      });
      await f.store.sqlRun(
        "update operations set status = 'failed' where id = 'op-ended'",
      );
      expect((await schedule(f.store)).cadenceDue).toBe(true);
      expect(await sweepProvisioningStalls(f.store)).toBe(1);
      expect(await f.store.openReasons(f.instanceId)).toEqual([]);
      expect((await f.store.getInstance(f.instanceId))?.attention_state).toBe(
        "clear",
      );
    },
  );

  // Each case is a buyer who never paid. The tail pays (or completes the
  // payment) and shows the same office does raise, so the silence above it is
  // the rule's, not the fixture's. `wake` is what the schedule owes the
  // abandoned-office sweep (task 03eef464), never the stall: an unpaid
  // reservation with no recorded session is due when its hold ends, one whose
  // Checkout expired is due now, and a subscription makes either paid.
  const unpaid: {
    name: string;
    setUp: (f: Awaited<ReturnType<typeof reserved>>) => Promise<void>;
    wake: (f: Awaited<ReturnType<typeof reserved>>) => {
      cadenceDue: boolean;
      nextDueAt: number | null;
    };
    pay: (f: Awaited<ReturnType<typeof reserved>>) => Promise<void>;
  }[] = [
    {
      name: "a reservation with no subscription",
      setUp: async () => {},
      wake: (f) => ({
        cadenceDue: false,
        nextDueAt: f.reservation.updated_at + UNPAID_OPENING_HOLD_MS,
      }),
      pay: async (f) => {
        await f.subscribe("active");
      },
    },
    {
      name: "a reservation whose Checkout expired unpaid",
      setUp: async (f) => {
        expect(
          await recordOrdinaryCheckoutSession(f.store, f.reservation, {
            id: "cs-abandoned",
            expiresAt: f.now() + DAY_MS,
          }),
        ).toBe(true);
        f.advance(DAY_MS);
        expect(
          await recordTerminalOrdinarySession(
            f.store,
            f.reservation.id,
            "cs-abandoned",
          ),
        ).toBe(true);
      },
      wake: () => ({ cadenceDue: true, nextDueAt: null }),
      pay: async (f) => {
        await f.subscribe("active");
      },
    },
    ...["incomplete", "incomplete_expired"].map((status) => ({
      name: `a first subscription left ${status}`,
      setUp: async (f: Awaited<ReturnType<typeof reserved>>) => {
        await f.subscribe(status);
      },
      wake: () => ({ cadenceDue: false, nextDueAt: null }),
      pay: async (f: Awaited<ReturnType<typeof reserved>>) => {
        await f.store.sqlRun(
          "update subscriptions set status = 'active' where id = 'sub-buyer'",
        );
      },
    })),
  ];

  test.each(unpaid)(
    "$name raises nothing, and wakes nothing for the stall",
    async ({ setUp, wake, pay }) => {
      const f = await reserved();
      await setUp(f);
      f.advance(DAY_MS + PROVISIONING_STALL_MS);
      await expectSilentProvisioning(f.store, f.instanceId);
      const s = await schedule(f.store);
      expect({ cadenceDue: s.cadenceDue, nextDueAt: s.nextDueAt }).toEqual(
        wake(f),
      );
      expect(await sweepProvisioningStalls(f.store)).toBe(0);
      expect(await f.store.openReasons(f.instanceId)).toEqual([]);
      expect((await f.store.getInstance(f.instanceId))?.attention_state).toBe(
        "clear",
      );

      await pay(f);
      f.advance(PROVISIONING_STALL_MS);
      expect((await schedule(f.store)).cadenceDue).toBe(true);
      expect(await sweepProvisioningStalls(f.store)).toBe(1);
      expect(await f.store.openReasons(f.instanceId)).toHaveLength(1);
    },
  );

  test("a stall raised on an unpaid reservation before the fix clears on the next sweep", async () => {
    const f = await reserved();
    f.advance(DAY_MS);
    // The production state: the old rule raised this for a buyer who never paid.
    expect(
      await f.store.tx(() =>
        raiseAttentionIn(f.store, {
          instanceId: f.instanceId,
          reasonClass: "operation_condition",
          reason: PROVISIONING_STALL_REASON,
          severity: "critical",
          actor: "provisioning-stall",
        }),
      ),
    ).toBe(true);
    expect((await f.store.getInstance(f.instanceId))?.attention_state).not.toBe(
      "clear",
    );
    await expectSilentProvisioning(f.store, f.instanceId);

    expect((await schedule(f.store)).cadenceDue).toBe(true);
    expect(await sweepProvisioningStalls(f.store)).toBe(1);
    expect(await f.store.openReasons(f.instanceId)).toEqual([]);
    expect((await f.store.getInstance(f.instanceId))?.attention_state).toBe(
      "clear",
    );
    const s = await schedule(f.store);
    expect(s.cadenceDue).toBe(false);
    // No stall time; only the abandoned-office sweep's, when the hold of a
    // reservation with no recorded session ends (task 03eef464).
    expect(s.nextDueAt).toBe(f.reservation.updated_at + UNPAID_OPENING_HOLD_MS);
  });
});
