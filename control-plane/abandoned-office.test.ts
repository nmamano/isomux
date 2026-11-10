// The abandoned-office sweep (task 03eef464): a reservation nobody paid whose
// Checkout is over ends its office, writes one audit row and leaves the name
// free; a Checkout that can still be paid, or a paid office, is left alone; and
// the work schedule wakes exactly when the sweep has work.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sweepAbandonedOffices } from "./abandoned-office.ts";
import {
  PROVISIONING_STALL_MS,
  PROVISIONING_STALL_REASON,
} from "./provisioning-stall.ts";
import { UNPAID_OPENING_HOLD_MS } from "./reservation-hold.ts";
import {
  accountForDevSignIn,
  advanceExpiredOrdinaryCheckout,
  recordOrdinaryCheckoutSession,
  recordTerminalOrdinarySession,
  reservationByName,
  reserveOffice,
} from "./signup.ts";
import { insertSubscription } from "./stripe/billing-store.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const DAY_MS = 86_400_000;
const NAME = "abandoned";

/** A reserved office, as the signup makes it: 'opening', no session, the
 * instance 'provisioning', no subscription and no operation. */
async function reserved() {
  let now = 1_700_000_000_000;
  const store = await openTestStore(() => now);
  const account = await accountForDevSignIn(store, "buyer@example.com");
  const signup = await reserveOffice(store, {
    accountId: account.id,
    officeName: NAME,
    plan: "office",
  });
  if (!signup.ok) throw new Error(signup.reason);
  const reservation = signup.reservation;
  const instanceId = reservation.instance_id;
  const f = {
    store,
    account,
    reservation,
    instanceId,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    /** A session recorded, then Stripe's expiry confirmed a day later. */
    expire: async () => {
      expect(
        await recordOrdinaryCheckoutSession(store, reservation, {
          id: "cs-abandoned",
          expiresAt: now + DAY_MS,
        }),
      ).toBe(true);
      now += DAY_MS;
      expect(
        await recordTerminalOrdinarySession(
          store,
          reservation.id,
          "cs-abandoned",
        ),
      ).toBe(true);
    },
    subscribe: (status: string) =>
      store.tx(() =>
        insertSubscription(store, {
          id: "sub-buyer",
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
    state: async () => (await store.getInstance(instanceId))?.service_state,
    /** This office's audit rows of one action. */
    audits: async (action: string) =>
      (await store.auditEvents()).filter(
        (a) => a.action === action && a.instance_id === instanceId,
      ),
  };
  return f;
}

type Fixture = Awaited<ReturnType<typeof reserved>>;

// Only the cadence class: the provider, provisioning, checkout-poll and
// liveness classes are off, so cadenceDue and nextDueAt speak for the cadence
// sweeps. The stall arms stay on, as in production; an unpaid office never
// wakes them (provisioning-stall.test.ts).
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

async function wake(store: Store) {
  const s = await schedule(store);
  return { cadenceDue: s.cadenceDue, nextDueAt: s.nextDueAt };
}

/** The office the sweep ended: deprovisioned, with exactly one audit row that
 * names it, its office name and the reservation. */
async function expectEnded(f: Fixture) {
  expect(await f.state()).toBe("deprovisioned");
  const rows = await f.audits("abandon_office");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ instance_id: f.instanceId, target: NAME });
  expect(JSON.parse(rows[0]!.detail ?? "{}")).toMatchObject({
    reservation: f.reservation.id,
  });
}

async function expectUntouched(f: Fixture) {
  expect(await f.state()).toBe("provisioning");
  expect(await f.audits("abandon_office")).toHaveLength(0);
}

describe("an expired, never-paid checkout", () => {
  test("ends its office once, and the schedule wakes for it until then", async () => {
    const f = await reserved();
    await f.expire();
    await expectUntouched(f);
    // Due at once: the expiry is already recorded, as in today's production
    // row, so no expiry hook would ever reach it.
    expect(await wake(f.store)).toEqual({ cadenceDue: true, nextDueAt: null });

    expect(await sweepAbandonedOffices(f.store)).toEqual({
      ended: 1,
      failed: 0,
    });
    await expectEnded(f);
    expect(await wake(f.store)).toEqual({ cadenceDue: false, nextDueAt: null });

    // Idempotent: nothing left to end, and no second audit row.
    expect(await sweepAbandonedOffices(f.store)).toEqual({
      ended: 0,
      failed: 0,
    });
    await expectEnded(f);
  });

  test("frees the name: a new signup takes it over, and the release does not fail on the ended office", async () => {
    const f = await reserved();
    await f.expire();
    expect((await sweepAbandonedOffices(f.store)).ended).toBe(1);
    const before = (await f.store.getInstance(f.instanceId))!.version;

    const other = await accountForDevSignIn(f.store, "next@example.com");
    const next = await reserveOffice(f.store, {
      accountId: other.id,
      officeName: NAME,
      plan: "office",
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.reused).toBe(false);
    expect(next.reservation.account_id).toBe(other.id);
    expect(next.reservation.instance_id).not.toBe(f.instanceId);
    expect(
      (await f.store.getInstance(next.reservation.instance_id))?.service_state,
    ).toBe("provisioning");
    // The old office stays ended, is not written again, and the takeover
    // still records the name moving to another account.
    const old = (await f.store.getInstance(f.instanceId))!;
    expect(old.service_state).toBe("deprovisioned");
    expect(old.version).toBe(before);
    const released = await f.audits("release_office");
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      instance_id: f.instanceId,
      target: NAME,
    });
    expect(await f.audits("abandon_office")).toHaveLength(1);
  });
});

describe("a candidate that fails", () => {
  test("rolls back alone, is reported with its reason, and the next one still ends", async () => {
    const f = await reserved();
    await f.expire();
    // A second abandoned office, created later, so the sweep reaches it second.
    const other = await accountForDevSignIn(f.store, "second@example.com");
    const second = await reserveOffice(f.store, {
      accountId: other.id,
      officeName: "second",
      plan: "office",
    });
    if (!second.ok) throw new Error(second.reason);
    f.advance(UNPAID_OPENING_HOLD_MS);
    const secondId = second.reservation.instance_id;

    // The audit write of the FIRST office fails, after its CAS ran in the
    // same transaction.
    const append = f.store.appendAudit.bind(f.store);
    let calls = 0;
    const spy = spyOn(f.store, "appendAudit").mockImplementation((ev) => {
      calls++;
      if (calls === 1) throw new Error("audit write refused");
      return append(ev);
    });
    const lines: string[] = [];
    let summary;
    try {
      summary = await sweepAbandonedOffices(f.store, (line) =>
        lines.push(line),
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(summary).toEqual({ ended: 1, failed: 1 });
    // No office is ended without its audit row: the failed one rolled back.
    await expectUntouched(f);
    expect((await f.store.getInstance(secondId))?.service_state).toBe(
      "deprovisioned",
    );
    // The operator learns which office failed and why, not only a count.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(NAME);
    expect(lines[0]).toContain("audit write refused");

    // The next pass ends it.
    expect(await sweepAbandonedOffices(f.store, () => {})).toEqual({
      ended: 1,
      failed: 0,
    });
    await expectEnded(f);
  });
});

describe("a reservation that never recorded a session", () => {
  // A legacy null checkout_state reads as 'opening' (checkoutOverSql).
  test.each([["opening" as const], [null]])(
    "checkout_state %p: is due when its hold ends, and ends its office then",
    async (checkoutState) => {
      const f = await reserved();
      if (checkoutState === null) {
        await f.store.sqlRun(
          "update name_reservations set checkout_state = null where id = $1",
          [f.reservation.id],
        );
      }
      const row = (await reservationByName(f.store, NAME))!;
      expect(row.checkout_state ?? null).toBe(checkoutState);
      const due = row.updated_at + UNPAID_OPENING_HOLD_MS;

      f.advance(UNPAID_OPENING_HOLD_MS - 1);
      expect(await wake(f.store)).toEqual({
        cadenceDue: false,
        nextDueAt: due,
      });
      expect(await sweepAbandonedOffices(f.store)).toEqual({
        ended: 0,
        failed: 0,
      });
      await expectUntouched(f);

      // The due time the schedule named is the instant the sweep ends it.
      f.advance(1);
      expect(f.now()).toBe(due);
      expect(await wake(f.store)).toEqual({ cadenceDue: true, nextDueAt: due });
      expect(await sweepAbandonedOffices(f.store)).toEqual({
        ended: 1,
        failed: 0,
      });
      await expectEnded(f);
      expect(await wake(f.store)).toEqual({
        cadenceDue: false,
        nextDueAt: null,
      });
    },
  );
});

describe("an office that can still be paid, or was paid, is left alone", () => {
  // Each case runs well past the hold, so only the rule under test keeps the
  // office. `quiet` cases also check the schedule: a paid or payable office
  // owes the sweep no wake and no due time. A case with an active
  // subscription or an operation wakes other classes, so it checks the sweep
  // alone.
  const cases: {
    name: string;
    setUp: (f: Fixture) => Promise<void>;
    quiet: boolean;
  }[] = [
    {
      name: "a recorded session Stripe has not confirmed over",
      setUp: async (f) => {
        expect(
          await recordOrdinaryCheckoutSession(f.store, f.reservation, {
            id: "cs-open",
            expiresAt: f.now() + DAY_MS,
          }),
        ).toBe(true);
      },
      quiet: true,
    },
    {
      name: "an expired Checkout with an incomplete subscription",
      setUp: async (f) => {
        await f.expire();
        await f.subscribe("incomplete");
      },
      quiet: true,
    },
    {
      name: "no recorded session, with an incomplete subscription",
      setUp: async (f) => {
        await f.subscribe("incomplete");
      },
      quiet: true,
    },
    {
      name: "an expired Checkout with an active subscription",
      setUp: async (f) => {
        await f.expire();
        await f.subscribe("active");
      },
      quiet: false,
    },
    {
      name: "an expired Checkout with a create operation",
      setUp: async (f) => {
        await f.expire();
        await f.store.enqueue({
          id: "op-create",
          instance_id: f.instanceId,
          kind: "create_instance",
          inactivity_deadline_at: f.now() + 1,
          absolute_deadline_at: f.now() + 2,
        });
      },
      quiet: false,
    },
  ];

  test.each(cases)("$name", async ({ setUp, quiet }) => {
    const f = await reserved();
    await setUp(f);
    f.advance(UNPAID_OPENING_HOLD_MS + DAY_MS);
    if (quiet) {
      expect(await wake(f.store)).toEqual({
        cadenceDue: false,
        nextDueAt: null,
      });
    }
    expect(await sweepAbandonedOffices(f.store)).toEqual({
      ended: 0,
      failed: 0,
    });
    await expectUntouched(f);
  });
});

/** The transaction id `store.tx` holds, and a check that another connection
 * waits on it: a row lock waiter waits on the holder's transaction id. */
async function holderXid(store: Store): Promise<string> {
  const row = await store.sqlGet<{ x: string }>(
    "select pg_current_xact_id()::text as x",
  );
  return row!.x;
}

async function waitForWaiter(
  store: Store,
  xid: string,
  settled: () => boolean,
): Promise<boolean> {
  // A contender that settles first did not wait: stop at once, so a failing
  // contender reports its own error rather than the holder's timeout.
  for (let i = 0; i < 200 && !settled(); i++) {
    const row = await store.sqlGet<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'transactionid' " +
        "and not granted and transactionid::text = $1",
      [xid],
    );
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** Run `hold` in a transaction that keeps the reservation row locked, start
 * `contender` while it is held, prove the contender is BLOCKED on that lock,
 * then commit and return what the contender got. */
async function race<T>(
  f: Fixture,
  hold: () => Promise<void>,
  contender: () => Promise<T>,
): Promise<{ blocked: boolean; result: T }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let xid!: string;
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const holder = f.store.tx(async () => {
    await f.store.sqlRun(
      "select id from name_reservations where id = $1 for update",
      [f.reservation.id],
    );
    await hold();
    xid = await holderXid(f.store);
    ready();
    await released;
  });
  await isReady;
  let done = false;
  const contending = contender().finally(() => {
    done = true;
  });
  // Handled here so an early rejection is not reported as unhandled while
  // the holder still runs; the await below reports it.
  contending.catch(() => {});
  let blocked = false;
  try {
    blocked = await waitForWaiter(f.store, xid, () => done);
  } finally {
    release();
    await holder;
  }
  return { blocked, result: await contending };
}

describe("the sweep and the web's expired -> opening advance serialize on the reservation", () => {
  test("an ended office's Checkout is not re-armed", async () => {
    const f = await reserved();
    await f.expire();
    const instance = (await f.store.getInstance(f.instanceId))!;
    expect(
      await f.store.casInstance(instance.id, instance.version, {
        service_state: "deprovisioned",
      }),
    ).not.toBeNull();

    expect(
      await advanceExpiredOrdinaryCheckout(f.store, f.reservation.id),
    ).toBeNull();
    expect(await reservationByName(f.store, NAME)).toMatchObject({
      checkout_state: "expired",
      checkout_generation: 1,
    });
  });

  // A row whose session was never recorded goes straight to the session
  // record: the office the sweep ended does not get a payable session.
  test("an ended office does not record a new session", async () => {
    const f = await reserved();
    const instance = (await f.store.getInstance(f.instanceId))!;
    expect(
      await f.store.casInstance(instance.id, instance.version, {
        service_state: "deprovisioned",
      }),
    ).not.toBeNull();

    expect(
      await recordOrdinaryCheckoutSession(f.store, f.reservation, {
        id: "cs-late",
        expiresAt: f.now() + DAY_MS,
      }),
    ).toBe(false);
    expect(await reservationByName(f.store, NAME)).toMatchObject({
      checkout_state: "opening",
      checkout_session_id: null,
    });
  });

  // The order where the sweep holds the lock: it ends the office and commits
  // while the advance waits. Under READ COMMITTED, an advance that decides in
  // the statement that waited still sees the office as provisioning.
  test("an advance that waited on the sweep sees the office it ended", async () => {
    const f = await reserved();
    await f.expire();
    const { blocked, result } = await race(
      f,
      async () => {
        const instance = (await f.store.getInstance(f.instanceId))!;
        expect(
          await f.store.casInstance(instance.id, instance.version, {
            service_state: "deprovisioned",
          }),
        ).not.toBeNull();
      },
      () => advanceExpiredOrdinaryCheckout(f.store, f.reservation.id),
    );
    expect(blocked).toBe(true);
    expect(result).toBeNull();
    expect(await reservationByName(f.store, NAME)).toMatchObject({
      checkout_state: "expired",
      checkout_generation: 1,
    });
  });

  // The other order: the web advances the row to a fresh 'opening' while the
  // sweep waits. The sweep must decide on the row as it is after the lock.
  test("a sweep that waited on the advance leaves the re-armed office alone", async () => {
    const f = await reserved();
    await f.expire();
    const { blocked, result } = await race(
      f,
      async () => {
        await f.store.sqlRun(
          "update name_reservations set checkout_generation = checkout_generation + 1, " +
            "checkout_session_id = null, checkout_expires_at = null, " +
            "checkout_state = 'opening', checkout_next_check_at = null, " +
            "updated_at = $1, version = version + 1 where id = $2",
          [f.now(), f.reservation.id],
        );
      },
      () => sweepAbandonedOffices(f.store),
    );
    expect(blocked).toBe(true);
    expect(result).toEqual({ ended: 0, failed: 0 });
    await expectUntouched(f);
  });
});
