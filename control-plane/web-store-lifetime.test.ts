// The web app's store lives as long as its process, and the cache that makes
// that true has two failure modes worth pinning.
//
// Opening is not a connect: it proves the governed bounds and checks the
// catalog, and the version that also ran the schema statements measured
// 2026-08-10 against the local Postgres at a median 62.6ms (20 runs) where the
// read the request came for is 1.3ms - so opening one per request was about
// 54ms of repeated schema work per page. The facade caches it instead, and this
// file asserts the two properties that make the cache safe rather than merely
// fast:
//
// - it caches the PROMISE, so two cold requests arriving together join one open
//   rather than each building a pool (the second of which would be leaked, and
//   with it its connections);
// - it EVICTS a failed open, so a database that was briefly unreachable costs a
//   request rather than the process.
//
// Both are observed through the engine rather than through the module's own
// bookkeeping: the test counts the backends the app's connections actually
// occupy, because "how many pools did we build" is exactly the question a
// cached handle answers wrongly while looking correct from the inside.

import { afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { TEST_DATABASE_URL, releaseTestStores, testDsn } from "./testing/pg.ts";
import { Store } from "./store.ts";
import {
  officeForAccount,
  officeRouteForAccount,
  progressForAccount,
} from "./web/lib/services.server.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";

/** The same symbol the facade caches on. Reached here, and nowhere else, so the
 * facade's export list stays the fixed list the boundary test pins. */
const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");

/** How the app's own connections are told apart from this file's. */
const APP = "cp_web_lifetime_app";

interface Cell {
  opening?: Promise<Store>;
}

function cell(): Cell {
  return ((globalThis as { [STORE_SLOT]?: Cell })[STORE_SLOT] ??= {});
}

/** A DSN the app's backends can be recognised by, on a database that has been
 * BOOTSTRAPPED.
 *
 * The facade opens a RUNTIME store, which reads a prepared database and refuses
 * to build one - the deployed web tier holds a role that is granted rows rather
 * than the schema, so a process that ran the schema statements could not be a
 * least-privileged one. This suite's schemas are recycled and wiped between
 * tests, which removes the audit seed along with everything else, so the
 * bootstrap that a deployment does once is done here explicitly. It runs
 * WITHOUT the application name, so it is not one of the backends this file
 * counts. */
async function appDsn(): Promise<string> {
  const dsn = await testDsn();
  await (await Store.open(dsn)).close();
  return `${dsn}&application_name=${APP}`;
}

const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });

/** How many backends the app is holding right now. Immediate, unlike the
 * cumulative statistics views. */
async function appBackends(): Promise<number> {
  const rows = await admin.query<{ n: string }>(
    "select count(*)::text as n from pg_stat_activity where application_name = $1",
    [APP],
  );
  return Number(rows.rows[0].n);
}

/**
 * The backend count once it stops moving.
 *
 * A closed pool's sockets disappear from the engine's view a moment after
 * `end()` resolves, so a bare read straight afterwards would fail on timing
 * rather than on the property. Polling is only allowed to make the EXPECTED
 * answer arrive sooner - a wrong count still ends up returned and asserted.
 */
async function backendsSettleTo(expected: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  let count = await appBackends();
  while (count !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    count = await appBackends();
  }
  return count;
}

/** Empty the cache the way a fresh process would find it, and give the engine
 * its connections back so the next test counts only its own. */
async function resetSlot(): Promise<void> {
  const held = cell();
  const opening = held.opening;
  delete held.opening;
  if (!opening) return;
  try {
    await (await opening).close();
  } catch {
    // An open that failed has nothing to close, which is the case one of the
    // tests below deliberately creates.
  }
}

afterEach(async () => {
  await resetSlot();
  delete process.env.CONTROL_PLANE_DB;
  await releaseTestStores();
});

describe("the web app's store outlives the request", () => {
  test("two cold requests join ONE open, not one pool each", async () => {
    process.env.CONTROL_PLANE_DB = await appDsn();
    expect(await appBackends()).toBe(0);

    // Fired together, from a cold cache: this is the shape a cached resolved
    // handle gets wrong, because both callers read the empty slot before
    // either has finished opening.
    const [a, b] = await Promise.all([
      progressForAccount("acct-nobody", "inst-nobody"),
      officeForAccount("acct-nobody"),
    ]);
    expect([a, b]).toEqual([null, null]);

    // The count while they run says nothing: one pool serving two concurrent
    // reads holds two connections, and so does a pool each. What tells them
    // apart is what survives CLOSING THE CACHED STORE. With one open there is
    // nothing else to hold a connection; with two, the loser was overwritten in
    // the slot before anyone could close it, and it goes on holding its
    // connection - and its schema check already ran a second time - until the
    // process dies.
    await resetSlot();
    expect(await backendsSettleTo(0)).toBe(0);
  });

  test("the store is reused rather than closed after a request", async () => {
    process.env.CONTROL_PLANE_DB = await appDsn();
    await progressForAccount("acct-nobody", "inst-nobody");
    const first = await cell().opening!;

    await progressForAccount("acct-nobody", "inst-nobody");
    const second = await cell().opening!;

    expect(second).toBe(first);
    // Still usable, which is the half a `finally { close() }` would break: a
    // closed pool answers the next request with an error rather than a row.
    expect(await progressForAccount("acct-nobody", "inst-nobody")).toBeNull();
    expect(await appBackends()).toBe(1);
  });

  test("a failed open is evicted, so the next request may succeed", async () => {
    // Refused rather than slow: what is under test is the eviction, not the
    // connect timeout.
    process.env.CONTROL_PLANE_DB = "postgres://isomux:isomux@127.0.0.1:1/nope";
    // Not awaited, matching the rest of the suite: awaiting an `expect().rejects`
    // trips `await-thenable` under the bun test types.
    expect(progressForAccount("acct-nobody", "inst-nobody")).rejects.toThrow();
    // The eviction is what the next line reads, so the rejection has to have
    // HAPPENED - the assertion above does not settle the promise for us.
    await progressForAccount("acct-nobody", "inst-nobody").catch(() => {});

    // A cached rejection would answer every later request with that same error,
    // forever, on a database that came back a second later.
    expect(cell().opening).toBeUndefined();

    process.env.CONTROL_PLANE_DB = await appDsn();
    expect(await progressForAccount("acct-nobody", "inst-nobody")).toBeNull();
  });
});

describe("office route authorization", () => {
  test("office routes resolve only through the signed-in account", async () => {
    const dsn = await appDsn();
    const seed = await Store.open(dsn);
    const owner = await accountForDevSignIn(seed, "route-owner@example.com");
    const stranger = await accountForDevSignIn(
      seed,
      "route-stranger@example.com",
    );
    const owned = await reserveOffice(seed, {
      accountId: owner.id,
      officeName: "route-owner",
      plan: "office",
    });
    const foreign = await reserveOffice(seed, {
      accountId: stranger.id,
      officeName: "route-stranger",
      plan: "office",
    });
    if (!owned.ok || !foreign.ok) throw new Error("could not seed routes");
    await seed.close();
    process.env.CONTROL_PLANE_DB = dsn;

    const office = await officeRouteForAccount(owner.id, "route-owner");
    expect(office).toEqual(
      expect.objectContaining({
        instanceId: owned.reservation.instance_id,
        officeName: "route-owner",
      }),
    );

    // Foreign names, internal ids and unknown values take the same null path.
    expect(
      await officeRouteForAccount(owner.id, foreign.reservation.name),
    ).toBeNull();
    expect(
      await officeRouteForAccount(owner.id, foreign.reservation.instance_id),
    ).toBeNull();
    expect(
      await officeRouteForAccount(owner.id, owned.reservation.instance_id),
    ).toBeNull();
    expect(
      await officeRouteForAccount(owner.id, "no-such-office-or-instance"),
    ).toBeNull();
  });
});
