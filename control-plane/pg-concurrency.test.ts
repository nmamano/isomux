// The races, run on genuinely concurrent Postgres connections.
//
// The suites that OWN these invariants live beside their subjects - the liveness
// claim in liveness-watch.test.ts, the lost successor in tick.test.ts, the stale
// fence in create-latch.test.ts, the name reservation in signup.test.ts - and
// they are unchanged. What they cannot say on their own is which connection each
// contender was on: under the previous engine there was exactly one, so "two
// contenders" meant two calls the engine had already serialised, and the
// invariant was never actually put under a concurrent writer.
//
// So this file re-runs the same four races with a BARRIER - both contenders
// inside their transactions before either does its work - and reads
// `pg_backend_pid()` from inside those transactions. The assertions are the same
// invariants; what is added is the evidence that two Postgres backends were
// racing when they held.
//
// The contenders are two STORES on one database, which is also why the evidence
// is structural rather than lucky: two stores are two pools, and two pools never
// share a connection. The pid reads are what make that visible in a failure
// message.

import { afterEach, describe, expect, test } from "bun:test";
import { deadlinesFor } from "./operations.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { ensureAccount } from "./stripe/billing-store.ts";
import { applyEvent, recordIgnoredEvent } from "./stripe/reconcile.ts";
import { isUniqueViolation, type SqlArgs, type Store } from "./store.ts";
import {
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const NOW = Date.parse("2027-06-10T00:00:00Z");

async function backendPid(store: Store): Promise<number> {
  return (await store.sqlGet<{ pid: number }>(
    "select pg_backend_pid() as pid",
  ))!.pid;
}

/** Two stores on one database: two pools, two connections, one set of rows. */
async function contenders(): Promise<{ a: Store; b: Store }> {
  const dsn = await testDsn();
  return {
    a: await openTestStoreOn(dsn, () => NOW),
    b: await openTestStoreOn(dsn, () => NOW),
  };
}

/**
 * Run `work` on both stores, each inside its own transaction, with neither
 * proceeding until both are open.
 *
 * The barrier is the point. Without it the first contender can finish before the
 * second starts, which is a sequence rather than a race, and a sequence says
 * nothing about what happens when two provisioners really do overlap.
 */
async function race<T>(
  a: Store,
  b: Store,
  work: (store: Store, index: number) => Promise<T>,
): Promise<{ results: PromiseSettledResult<T>[]; pids: number[] }> {
  let arrived = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const pids: number[] = [];
  const one = (store: Store, index: number): Promise<T> =>
    store.tx(async () => {
      // Read INSIDE the transaction, so it names the connection this
      // contender's work is actually on.
      pids.push(await backendPid(store));
      if (++arrived === 2) release();
      await gate;
      return work(store, index);
    });
  // SETTLED, not all: a contender the database refuses loses its whole
  // transaction, and swallowing that inside the body would be the very thing
  // the commit guard exists to catch.
  const results = await Promise.allSettled([one(a, 0), one(b, 1)]);
  return { results, pids };
}

/** The values of whichever contenders committed. */
function committed<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

async function seedInstance(store: Store): Promise<void> {
  await store.createInstance({
    id: "inst-1",
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: null,
  });
}

/** The smallest event that makes reconciliation create a subscription row. */
function subscriptionEvent(eventId: string) {
  return {
    eventId,
    eventType: "customer.subscription.updated",
    eventCreated: NOW,
    subscription: {
      id: "sub_race",
      customerId: "cus_race",
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
    now: NOW,
  };
}

describe("the races run on two backends", () => {
  test("overlapping liveness claims: one prober, so one outage is counted once", async () => {
    const { a, b } = await contenders();
    await seedInstance(a);
    await a.ensureLiveness("inst-1", NOW - 1);

    const { results, pids } = await race(a, b, (store) =>
      store.claimLiveness("inst-1", store === a ? "a" : "b", NOW + 60_000, NOW),
    );

    expect(new Set(pids).size).toBe(2);
    expect(committed(results).filter(Boolean)).toHaveLength(1);
  });

  test("the lost successor: two holders, and one operation row", async () => {
    const { a, b } = await contenders();
    await seedInstance(a);
    const deadlines = deadlinesFor("verify_https");

    // The partial unique index is the arbiter, as it is for the tick's
    // completion-and-successor transaction. Different ids on purpose: the same
    // id would be refused by the primary key instead, which is a different
    // rule.
    const { results, pids } = await race(a, b, (store) =>
      store.enqueue({
        id: `op-verify_https-${store === a ? "a" : "b"}`,
        instance_id: "inst-1",
        kind: "verify_https",
        inactivity_deadline_at: NOW + deadlines.inactivityMs,
        absolute_deadline_at: NOW + deadlines.absoluteMs,
      }),
    );

    expect(new Set(pids).size).toBe(2);
    // One transaction commits and the other is refused OUTRIGHT - the loser
    // does not get to keep the rest of its work.
    expect(committed(results)).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === "rejected" && isUniqueViolation(r.reason),
      ),
    ).toHaveLength(1);
    expect(
      (await a.operationsFor("inst-1")).filter(
        (o) => o.kind === "verify_https",
      ),
    ).toHaveLength(1);
  });

  test("the stale fence: two writers on one pre-read version", async () => {
    const { a, b } = await contenders();
    await seedInstance(a);
    const op = await a.enqueue({
      id: "op-fence",
      instance_id: "inst-1",
      kind: "run_installer",
      inactivity_deadline_at: NOW + 60_000,
      absolute_deadline_at: NOW + 600_000,
    });
    const leased = (await a.tryLease(op.id, op.version, "holder", 0, NOW))!;

    // ONE pre-read, then both writes from that same version - the shape a real
    // stale fence has.
    const { results, pids } = await race(a, b, (store) =>
      store.casOperation(
        { id: op.id, version: leased.version, holder: "holder" },
        { status: store === a ? "succeeded" : "failed" },
      ),
    );

    expect(new Set(pids).size).toBe(2);
    expect(committed(results).filter(Boolean)).toHaveLength(1);
  });

  test("racing name reservations: both inside the INSERT, one office, and the loser is told whose it is", async () => {
    const { a, b } = await contenders();
    const mine = await accountForDevSignIn(a, "a@example.com");
    const theirs = await accountForDevSignIn(a, "b@example.com");

    // `reserveOffice` owns its transaction, so the barrier goes AT THE
    // STATEMENT: each store's `sqlRun` holds the reservation INSERT until both
    // have arrived. Scheduling two calls with Promise.all only proves they were
    // started; this proves both transactions were open and at the deciding
    // statement at the same instant.
    let arrived = 0;
    let release = () => {};
    const both = new Promise<void>((r) => {
      release = r;
    });
    const pids: number[] = [];
    const restore: (() => void)[] = [];
    for (const store of [a, b]) {
      const real = store.sqlRun.bind(store);
      restore.push(() => {
        store.sqlRun = real;
      });
      store.sqlRun = async (sql: string, args?: SqlArgs) => {
        if (sql.includes("insert into name_reservations")) {
          // Read from inside this transaction's own frame, at the statement.
          pids.push(await backendPid(store));
          if (++arrived === 2) release();
          await both;
        }
        return real(sql, args);
      };
    }

    let results;
    try {
      results = await Promise.all(
        [a, b].map((store) =>
          reserveOffice(store, {
            accountId: store === a ? mine.id : theirs.id,
            officeName: "acme",
            plan: "office",
          }),
        ),
      );
    } finally {
      for (const undo of restore) undo();
    }

    // Both transactions really were at the INSERT together, on two backends.
    expect(pids).toHaveLength(2);
    expect(new Set(pids).size).toBe(2);
    // One office. The loser's REAL 23505 was recovered inside its own
    // transaction and read back, which is what lets it answer in words instead
    // of failing.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused?.ok === false && refused.reason).toBe('"acme" is taken');
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*)::int as n from name_reservations",
      ),
    ).toEqual({ n: 1 });
    expect(await a.listInstances()).toHaveLength(1);
  });
});

describe("the initialisers that promise a row EXISTS", () => {
  test("two first liveness probes both succeed, one row is made, and one claim wins", async () => {
    // Both find the row absent under read committed, and the primary key
    // decides. The previous engine's single writer hid this: the loser
    // re-evaluated its own `where not exists` after the winner committed and
    // quietly did nothing. Measured on the pre-fix tree: one call rejected with
    // 23505 instance_liveness_pkey.
    const { a, b } = await contenders();
    await seedInstance(a);

    const { results, pids } = await race(a, b, (store) =>
      store.ensureLiveness("inst-1", NOW - 1),
    );

    expect(new Set(pids).size).toBe(2);
    // BOTH succeed: "ensure" promises the row exists, not that this caller made
    // it.
    expect(committed(results)).toHaveLength(2);
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*)::int as n from instance_liveness",
      ),
    ).toEqual({ n: 1 });

    // And the row it left behind is a working one: exactly one of two probers
    // may claim it.
    const claims = await race(a, b, (store) =>
      store.claimLiveness("inst-1", store === a ? "a" : "b", NOW + 60_000, NOW),
    );
    expect(committed(claims.results).filter(Boolean)).toHaveLength(1);
  });

  test("two first accounts for one address both succeed, and both get the winner's row", async () => {
    // Same shape, and the same measured 23505 before the fix - on
    // accounts_email rather than the primary key, which is why the recovery
    // reads back BY ADDRESS.
    const { a, b } = await contenders();

    const { results, pids } = await race(a, b, (store) =>
      ensureAccount(store, {
        id: store === a ? "acct-a" : "acct-b",
        email: "same@example.com",
      }),
    );

    expect(new Set(pids).size).toBe(2);
    const rows = committed(results);
    expect(rows).toHaveLength(2);
    // One account, and both callers hold it - the loser was handed the winner's
    // row rather than its own id.
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(
      await a.sqlGet<{ n: number }>("select count(*)::int as n from accounts"),
    ).toEqual({ n: 1 });
  });

  test("a primary-key collision for a DIFFERENT address is not answered with somebody else's row", async () => {
    // The recovery is specific, not a blanket forgiveness of 23505.
    const store = (await contenders()).a;
    await store.tx(() =>
      ensureAccount(store, { id: "acct-1", email: "first@example.com" }),
    );
    expect(
      store.tx(() =>
        ensureAccount(store, { id: "acct-1", email: "second@example.com" }),
      ),
    ).rejects.toThrow();
  });
});

describe("the billing ledger's two insert races", () => {
  test("two deliveries of one ignorable event: one records, one answers duplicate", async () => {
    // The event id primary key is the dedupe, and the `eventSeen` read in front
    // of it cannot decide alone: both deliveries can find it unseen. Under the
    // previous engine the loser's read ran after the winner had committed and
    // returned "duplicate" - so that is what the loser answers here, rather
    // than failing a delivery with nothing left to do. The claim is the only
    // write in this transaction, which is what makes recovering to the prior
    // answer honest rather than a shortcut.
    const { a, b } = await contenders();

    const { results, pids } = await race(a, b, (store) =>
      recordIgnoredEvent(store, {
        eventId: "evt_race",
        eventType: "customer.updated",
        eventCreated: 1,
        note: "not ours",
      }),
    );

    expect(new Set(pids).size).toBe(2);
    expect(committed(results).sort()).toEqual(["duplicate", "recorded"]);
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*)::int as n from stripe_events",
      ),
    ).toEqual({ n: 1 });
  });

  test("two deliveries for one new subscription: one row, and both see it", async () => {
    // `ensureRow`'s "read, else insert" has the same shape, and the loser reads
    // the winner's row back instead of losing its whole delivery. Driven
    // through the real reconciliation entry point, so it is the shipped path
    // that is raced.
    const { a, b } = await contenders();
    const { results, pids } = await race(a, b, (store, i) =>
      applyEvent(store, subscriptionEvent(`evt_sub_${i}`)),
    );

    expect(new Set(pids).size).toBe(2);
    expect(committed(results)).toHaveLength(2);
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*)::int as n from subscriptions",
      ),
    ).toEqual({ n: 1 });
  });
});
