// The store's invariants: CAS, leases, the one-active index, and the attention
// summary. Every race here is fired the way a race actually happens - one
// pre-read, then two contenders using that same version, with no intervening
// read that would serialise them.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DATABASE_NAME,
  isUniqueViolation,
  redactConnectionDetails,
  Store,
  withGovernedOptions,
} from "./store.ts";
import {
  freshDsn,
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  seedRawSchema,
  testDsn,
} from "./testing/pg.ts";
import { acknowledgeAttention } from "./attention-ack.ts";
import { clearAttention, raiseAttention } from "./attention.ts";

const temps: string[] = [];

async function tempStore(now?: () => number): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-store-"));
  temps.push(dir);
  return await openTestStore(now);
}

async function seedInstance(store: Store, id = "inst-1"): Promise<string> {
  await store.createInstance({
    id,
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: null,
  });
  return id;
}

async function seedOp(store: Store, instance: string, kind = "run_installer") {
  return await store.enqueue({
    id: `op-${kind}-${Math.random().toString(36).slice(2)}`,
    instance_id: instance,
    kind,
    inactivity_deadline_at: store.now() + 60_000,
    absolute_deadline_at: store.now() + 600_000,
  });
}

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

describe("compare-and-swap", () => {
  test("a stale version loses and changes nothing", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const first = await store.casInstance(inst, 1, { service_state: "live" });
    expect(first?.service_state).toBe("live");
    // The loser holds the version it read BEFORE the winner wrote.
    const loser = await store.casInstance(inst, 1, {
      service_state: "suspended",
    });
    expect(loser).toBeNull();
    expect((await store.getInstance(inst))?.service_state).toBe("live");
  });

  test("an operation write is fenced by holder as well as version", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const leased = await store.tryLease(
      op.id,
      op.version,
      "holder-a",
      10_000,
      0,
    );
    expect(leased).not.toBeNull();
    // Right version, wrong holder: the lease moved, so this write must lose.
    const stale = await store.casOperation(
      { id: op.id, version: leased!.version, holder: "holder-b" },
      { status: "succeeded" },
    );
    expect(stale).toBeNull();
    expect((await store.getOperation(op.id))?.status).toBe("running");
  });
});

describe("leases", () => {
  test("only one of two contenders holding the same read can lease", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    // ONE pre-read, then both attempts from that same version. A second read
    // here would serialise the contenders and prove nothing.
    const seen = (await store.getOperation(op.id))!;
    const a = await store.tryLease(seen.id, seen.version, "a", 10_000, 0);
    const b = await store.tryLease(seen.id, seen.version, "b", 10_000, 0);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.getOperation(op.id))?.lease_holder).toBe("a");
  });

  test("a live lease is not adoptable, an expired one is", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "a", 10_000, 0))!;
    // now=5_000 is inside the lease: nobody else may take it.
    expect(
      await store.tryLease(held.id, held.version, "b", 20_000, 5_000),
    ).toBeNull();
    // now=10_001 is past it: a crashed holder's lease is adoptable.
    const adopted = await store.tryLease(
      held.id,
      held.version,
      "b",
      30_000,
      10_001,
    );
    expect(adopted?.lease_holder).toBe("b");
  });

  test("renewal requires the holder", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "a", 10_000, 0))!;
    expect(
      await store.renewLease(
        { id: op.id, version: held.version, holder: "b" },
        99,
      ),
    ).toBeNull();
    expect(
      await store.renewLease(
        { id: op.id, version: held.version, holder: "a" },
        99,
      ),
    ).not.toBeNull();
  });

  test("taking the lease moves a pending row to running, and leaves others alone", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await store.enqueue({
      id: "op-amb",
      instance_id: inst,
      kind: "create_instance",
      status: "ambiguous",
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    const held = await store.tryLease(op.id, op.version, "a", 10_000, 0);
    expect(held?.status).toBe("ambiguous");
  });
});

describe("one active operation per (instance, kind)", () => {
  test("a second active row is refused by the index, not by a check", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await seedOp(store, inst, "mint_invite");
    expect(seedOp(store, inst, "mint_invite")).rejects.toThrow();
  });

  test("a terminal row frees the slot, so a legitimate second one may open", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const first = await seedOp(store, inst, "mint_invite");
    // A LIVE lease: concluding an operation is a write, and an expired holder
    // has no authority to make one.
    const held = (await store.tryLease(
      first.id,
      first.version,
      "a",
      60_000,
      1_000,
    ))!;
    await store.casOperation(
      { id: first.id, version: held.version, holder: "a" },
      { status: "succeeded" },
    );
    await seedOp(store, inst, "mint_invite");
  });
});

describe("due selection", () => {
  test("skips leased rows and rows whose backoff has not elapsed", async () => {
    const store = await tempStore(() => 0);
    const inst = await seedInstance(store);
    const soon = await seedOp(store, inst, "verify_https");
    const later = await store.enqueue({
      id: "op-later",
      instance_id: inst,
      kind: "mint_invite",
      next_attempt_at: 10_000,
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    expect((await store.dueOperations(0, 10)).map((o) => o.id)).toEqual([
      soon.id,
    ]);
    await store.tryLease(soon.id, soon.version, "a", 60_000, 0);
    expect(await store.dueOperations(0, 10)).toHaveLength(0);
    expect((await store.dueOperations(20_000, 10)).map((o) => o.id)).toEqual([
      later.id,
    ]);
  });
});

describe("deadline flagging", () => {
  test("is a version CAS, and a second flagger loses", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const seen = (await store.getOperation(op.id))!;
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity"),
    ).not.toBeNull();
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity"),
    ).toBeNull();
  });

  test("flagging writes no status: a deadline flags, it never concludes", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    await store.flagDeadline(op.id, op.version, "inactivity");
    const after = (await store.getOperation(op.id))!;
    expect(after.status).toBe("pending");
    expect(after.inactivity_flagged).toBe(1);
    expect(after.absolute_flagged).toBe(0);
  });
});

/** Which Postgres backend answered. The evidence that two flows are on two
 * connections rather than two flows the engine happened to serialise. */
async function backendPid(store: Store): Promise<number> {
  const row = await store.sqlGet<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  return row!.pid;
}

/**
 * WHICH TRANSACTION this statement is inside, as Postgres understands it.
 *
 * Stronger than the backend pid, and the pair is what pins the routing: a pid
 * says which connection answered, and this says which transaction that
 * connection was in. Statements that drifted onto pooled connections would each
 * be their own autocommit transaction, and would report different ids - or
 * none, which is what an unwritten transaction reports.
 */
async function transactionId(store: Store): Promise<string | null> {
  const row = await store.sqlGet<{ xid: string | null }>(
    "select pg_current_xact_id_if_assigned()::text as xid",
  );
  return row?.xid ?? null;
}

describe("a failure inside a transaction, and who is allowed to recover from it", () => {
  test("a swallowed statement error cannot come back as a successful commit", async () => {
    // THE QUIET FAILURE CLASS. Postgres aborts the whole transaction on any
    // statement error and then answers COMMIT with the tag ROLLBACK - so a body
    // that caught the error and returned normally would be told its writes
    // landed when nothing did.
    const store = await tempStore();
    const inst = await seedInstance(store);
    let caught = "not thrown";

    const attempt = store.tx(async () => {
      await store.casInstance(inst, 1, { service_state: "live" });
      try {
        // A real constraint failure, NOT wrapped in `recoverable`.
        await store.createInstance({
          id: inst,
          run_id: null,
          name: "duplicate",
          plan: "V153",
          region: "EU",
          service_state: "provisioning",
          goal: "live",
          access_window_expires_at: null,
        });
      } catch {
        caught = "swallowed";
      }
      return "looks fine";
    });

    expect(attempt).rejects.toThrow(
      /could not commit|Nothing in it was written/,
    );
    expect(caught).toBe("swallowed");
    // The write from before the swallowed error is gone with the rest.
    expect((await store.getInstance(inst))?.service_state).toBe("provisioning");
  });

  test("recoverable keeps the transaction, the read-back, and the writes either side of it", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);

    const outcome = await store.tx(async () => {
      // Before.
      await store.casInstance(inst, 1, { service_state: "live" });
      let refused = "not attempted";
      try {
        await store.recoverable(() =>
          store.createInstance({
            id: inst,
            run_id: null,
            name: "duplicate",
            plan: "V153",
            region: "EU",
            service_state: "provisioning",
            goal: "live",
            access_window_expires_at: null,
          }),
        );
      } catch (err) {
        // The ORIGINAL error, not the savepoint's.
        expect(isUniqueViolation(err)).toBe(true);
        // And the transaction is usable: this read is the whole point.
        refused = (await store.getInstance(inst))!.service_state;
      }
      // After.
      await store.enqueue({
        id: "op-after",
        instance_id: inst,
        kind: "verify_https",
        inactivity_deadline_at: 1,
        absolute_deadline_at: 2,
      });
      return refused;
    });

    expect(outcome).toBe("live");
    expect((await store.getInstance(inst))?.service_state).toBe("live");
    expect(await store.getOperation("op-after")).not.toBeNull();
  });

  test("a check violation is not a uniqueness refusal, and takes the transaction with it", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);

    const attempt = store.tx(async () => {
      await store.casInstance(inst, 1, { service_state: "live" });
      try {
        await store.recoverable(() =>
          store.createInstance({
            id: "inst-check",
            run_id: null,
            name: "x",
            plan: "V153",
            region: "EU",
            service_state: "mostly-live" as never,
            goal: "live",
            access_window_expires_at: null,
          }),
        );
      } catch (err) {
        // Recoverable makes the transaction usable again; it does not decide
        // what is worth recovering from. This caller only forgives 23505.
        if (!isUniqueViolation(err)) throw err;
      }
      return "committed";
    });

    // The SQLSTATE rather than the engine's prose: the store's error boundary
    // does not forward a driver message (it can carry the role - see
    // redactConnectionDetails), and 23514 is the portable fact anyway, where
    // "check constraint" is wording a Postgres release may reword.
    expect(attempt).rejects.toThrow(/SQLSTATE 23514/);
    expect((await store.getInstance(inst))?.service_state).toBe("provisioning");
  });

  test("serial and nested recovery scopes do not release each other's savepoints", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const dup = (id: string) =>
      store.createInstance({
        id,
        run_id: null,
        name: "duplicate",
        plan: "V153",
        region: "EU",
        service_state: "provisioning",
        goal: "live",
        access_window_expires_at: null,
      });

    const seen = await store.tx(async () => {
      const order: string[] = [];
      // Serial: two scopes one after the other, both failing.
      for (const round of ["first", "second"]) {
        await store.recoverable(() => dup(`inst-${round}`));
        await store.recoverable(() => dup(inst)).catch(() => order.push(round));
      }
      // Nested: an outer scope that survives an inner one's failure.
      await store.recoverable(async () => {
        await store
          .recoverable(() => dup(inst))
          .catch(() => order.push("inner"));
        await dup("inst-outer");
        order.push("outer");
      });
      return order;
    });

    expect(seen).toEqual(["first", "second", "inner", "outer"]);
    // Everything that was supposed to be written is there, and the duplicates
    // are not.
    for (const id of ["inst-first", "inst-second", "inst-outer"]) {
      expect(await store.getInstance(id)).not.toBeNull();
    }
  });

  test("outside a transaction it is a passthrough", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    expect(
      await store.recoverable(() => store.getInstance(inst)),
    ).not.toBeNull();
    // A failure still surfaces unchanged; there is simply no transaction to
    // save.
    expect(
      store.recoverable(() =>
        store.sqlRun("insert into instances (id) values ('x')"),
      ),
    ).rejects.toThrow();
  });
});

describe("the connection settings are on the wire, not just in the config", () => {
  test("statement and idle-in-transaction bounds are what a fresh backend carries", async () => {
    const store = await tempStore();
    // Asked of the SERVER: a value that never left the pool's options object
    // would bound nothing.
    const setting = async (name: string): Promise<string | undefined> =>
      (
        await store.sqlGet<{ v: string }>("select current_setting($1) as v", [
          name,
        ])
      )?.v;
    expect(await setting("statement_timeout")).toBe("30s");
    expect(await setting("idle_in_transaction_session_timeout")).toBe("30s");
    // Durability, which the create latch rests on, is left alone.
    expect(await setting("synchronous_commit")).toBe("on");
  });

  test("a statement wedged behind a row lock is cancelled rather than waiting forever", async () => {
    // The bound's real job. A short timeout is set on the WAITING transaction's
    // own connection, so the mechanism is exercised without a 30-second test:
    // what is proven is that the engine cancels a blocked statement at the
    // configured instant, which is what the 30s setting buys in production.
    const dsn = await testDsn();
    const holder = await openTestStoreOn(dsn);
    const waiter = await openTestStoreOn(dsn);
    const inst = await seedInstance(holder);

    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Two gates, and the second one is load-bearing: the waiter must not start
    // until the holder's write has actually TAKEN the row lock. Without it the
    // waiter can get there first, write, and never block at all - which is a
    // test that passes on scheduling rather than on the setting it is about.
    let locked = () => {};
    const rowIsLocked = new Promise<void>((r) => {
      locked = r;
    });
    const held = holder.tx(async () => {
      await holder.casInstance(inst, 1, { service_state: "live" });
      locked();
      await gate;
      return "held";
    });
    await rowIsLocked;

    const blocked = await waiter
      .tx(async () => {
        await waiter.sqlRun("set local statement_timeout = '200ms'");
        // The row is locked by the transaction above, so this waits.
        return await waiter.casInstance(inst, 1, {
          service_state: "suspended",
        });
      })
      .then(
        () => "wrote",
        (err: unknown) => (err as { code?: string }).code,
      );

    release();
    expect(await held).toBe("held");
    // 57014 is query_canceled: the engine gave up on the wait, and the store
    // reported it rather than hanging the tick that issued it.
    expect(blocked).toBe("57014");
    expect((await holder.getInstance(inst))?.service_state).toBe("live");
  });

  test("closing twice is a no-op, so a finally and a teardown can both do it", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await store.close();
    // The engine handle used to throw here. A pool is closed by whoever gets
    // there first, and the second caller is not the one with a problem.
    await store.close();
    // And it really is closed.
    expect(store.getInstance("inst-1")).rejects.toThrow();
  });
});

describe("a transaction owns its connection", () => {
  /**
   * THE PROPERTY THE TRANSACTION BOUNDARY COMMENTS REST ON.
   *
   * Every "these statements commit together" in store.ts is a claim about the
   * wire, and it is only true if one body's statements cannot reach another
   * body's connection. Under the previous engine there was one connection and
   * the claim was kept by refusing concurrency outright: a second `tx` entered
   * while one was suspended threw. That refusal was a stopgap, and this is what
   * replaces it - the backend pids are read from inside the bodies, so the
   * evidence is the engine's own answer rather than our bookkeeping.
   */
  test("two overlapping transactions run on different backends, and each body stays on its own", async () => {
    const store = await tempStore();
    await seedInstance(store, "inst-a");
    await seedInstance(store, "inst-b");

    // A TURNSTILE, not a single barrier: after both transactions are open, the
    // bodies take strict turns, so only one statement is ever in flight. That is
    // what makes this decide the question. With statements routed to their own
    // checked-out clients, taking turns changes nothing - each body keeps its
    // connection whether or not it is the one running. With statements routed to
    // the POOL instead, the two checked-out clients are held and unusable, and
    // an idle pool connection is handed to whichever body asks next - so the
    // bodies end up sharing one, and their transaction identities collapse into
    // each other's.
    const gates = new Map<number, { wait: Promise<void>; open: () => void }>();
    const gate = (n: number) => {
      let g = gates.get(n);
      if (!g) {
        let open = () => {};
        const wait = new Promise<void>((r) => {
          open = r;
        });
        g = { wait, open };
        gates.set(n, g);
      }
      return g;
    };
    const seen: { a: number[]; b: number[] } = { a: [], b: [] };
    const xids: { a: (string | null)[]; b: (string | null)[] } = {
      a: [],
      b: [],
    };
    const observe = async (who: "a" | "b") => {
      seen[who].push(await backendPid(store));
      xids[who].push(await transactionId(store));
    };

    const a = store.tx(async () => {
      // A write, so this transaction has an identity to report.
      await store.casInstance("inst-a", 1, { goal: "installed" });
      await observe("a");
      gate(1).open();
      await gate(2).wait;
      await observe("a");
      gate(3).open();
      await gate(4).wait;
      await observe("a");
      return "a";
    });
    const b = store.tx(async () => {
      await gate(1).wait;
      await store.casInstance("inst-b", 1, { goal: "installed" });
      await observe("b");
      gate(2).open();
      await gate(3).wait;
      await observe("b");
      gate(4).open();
      return "b";
    });

    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    // Each body saw ONE backend from start to finish, across turns in which the
    // other body was the only one running...
    expect(new Set(seen.a).size).toBe(1);
    expect(new Set(seen.b).size).toBe(1);
    // ...and never the other's.
    expect(seen.a[0]).not.toBe(seen.b[0]);
    // And one transaction identity each, distinct: statements that had drifted
    // onto pool connections would report the other body's transaction, or none.
    expect(xids.a[0]).not.toBeNull();
    expect(xids.b[0]).not.toBeNull();
    expect(new Set(xids.a).size).toBe(1);
    expect(new Set(xids.b).size).toBe(1);
    expect(xids.a[0]).not.toBe(xids.b[0]);
    // Both wrote, and both writes survived: neither transaction was rolled into
    // the other's.
    expect((await store.getInstance("inst-a"))?.goal).toBe("installed");
    expect((await store.getInstance("inst-b"))?.goal).toBe("installed");
  });

  test("a transaction opened INSIDE one, across an await, is still refused", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    let inner = "not attempted";

    const outer = await store.tx(async () => {
      await store.casInstance(inst, 1, { goal: "installed" });
      try {
        await store.tx(async () => "should not get here");
        inner = "entered";
      } catch (err) {
        inner = (err as Error).message;
      }
      return "committed";
    });

    // Nesting is what widens somebody else's boundary, and it is refused
    // whether or not the body suspended first.
    expect(inner).toBe("nested transaction");
    expect(outer).toBe("committed");
    expect((await store.getInstance(inst))?.goal).toBe("installed");
  });

  test("a second store's statements never land on the first store's connection", async () => {
    // Two stores on ONE database, which is how the racing suites are written.
    const dsn = await testDsn();
    const first = await openTestStoreOn(dsn);
    const second = await openTestStoreOn(dsn);
    await seedInstance(first, "inst-1");

    let insidePid = 0;
    let outsidePid = 0;
    let otherStore = "not attempted";
    await first.tx(async () => {
      insidePid = await backendPid(first);
      // The other store is NOT in a transaction, and its statements go to its
      // own pool - the async context belongs to a store, not to the process.
      expect(second.inTransaction()).toBe(false);
      outsidePid = await backendPid(second);
      // And a transaction on a DIFFERENT store is not nesting: it is a second
      // database handle on a second connection, and it cannot widen this one's
      // boundary.
      otherStore = await second.tx(async () => "opened");
    });

    expect(insidePid).not.toBe(outsidePid);
    expect(otherStore).toBe("opened");
  });
});

describe("attention", () => {
  test("one reason cannot overwrite another, and the summary names the worst", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer passed its inactivity deadline",
      severity: "warning",
    });
    const row = (await store.getInstance(inst))!;
    expect(row.attention_state).toBe("needs_operator");
    expect(row.attention_reason).toBe("revocation failed");
    expect(await store.openReasons(inst)).toHaveLength(2);
  });

  test("clearing the installer reason leaves the revocation one open", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer stalled",
      severity: "warning",
    });
    const installer = (await store.openReasons(inst)).find(
      (r) => r.source_op_id === "op-install",
    )!;
    await clearAttention(store, inst, installer.id);
    expect((await store.openReasons(inst)).map((r) => r.reason)).toEqual([
      "revocation failed",
    ]);
    expect((await store.getInstance(inst))?.attention_state).toBe(
      "needs_operator",
    );
  });

  test("raising the same reason twice is idempotent", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const args = {
      instanceId: inst,
      reasonClass: "operation_condition" as const,
      sourceOpId: "op-1",
      reason: "same",
      severity: "warning" as const,
    };
    expect(await raiseAttention(store, args)).toBe(true);
    expect(await raiseAttention(store, args)).toBe(false);
    expect(await store.openReasons(inst)).toHaveLength(1);
  });

  test("acknowledging is NOT clearing", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "revocation failed",
      severity: "critical",
    });
    await acknowledgeAttention(store, inst, "nil");
    const row = (await store.getInstance(inst))!;
    expect(row.acknowledged_by).toBe("nil");
    // The condition has not gone away, so the instance still needs a human.
    expect(row.attention_state).toBe("needs_operator");
    expect(await store.openReasons(inst)).toHaveLength(1);
  });

  test("every raise and clear leaves an audit row", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "stalled",
      severity: "warning",
    });
    const [reason] = await store.openReasons(inst);
    await clearAttention(store, inst, reason.id);
    const actions = (await store.auditEvents()).map((e) => e.action);
    expect(actions).toContain("raise_attention");
    expect(actions).toContain("clear_attention");
  });

  test("the summary is a CAS: a caller working from a stale read loses", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const stale = (await store.getInstance(inst))!.version;
    // Somebody else moves the instance between our read and our write.
    await store.casInstance(inst, stale, { goal: "installed" });
    expect(
      store.tx(async () => await store.refreshAttentionSummary(inst, stale)),
    ).rejects.toThrow(/moved while its attention summary/);
    // And the winner's write is intact.
    expect((await store.getInstance(inst))?.goal).toBe("installed");
  });

  test("an audit row outside a transaction is refused", async () => {
    const store = await tempStore();
    expect(
      store.appendAudit({
        actor: "t",
        instance_id: null,
        action: "x",
        target: "y",
        outcome: "succeeded",
        detail: null,
      }),
    ).rejects.toThrow(/inside a transaction/);
  });
});

describe("portability rules", () => {
  test("no date types, no json columns, and no generated ids", async () => {
    const store = await tempStore();
    const columns = await store.sqlAll<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_identity: string;
      column_default: string | null;
    }>(
      "select table_name, column_name, data_type, is_identity, column_default " +
        "from information_schema.columns where table_schema = current_schema() " +
        "order by table_name, column_name",
    );
    expect(columns.length).toBeGreaterThan(50);
    const named = (c: (typeof columns)[number]) =>
      `${c.table_name}.${c.column_name} ${c.data_type}`;

    // Times are ms epochs, never a date type: a date column would be read back
    // as a Date object by the driver and compared against a number by every
    // caller in the codebase.
    expect(
      columns.filter((c) => /date|time/.test(c.data_type)).map(named),
    ).toEqual([]);
    // JSON travels as an already-serialised text parameter.
    expect(columns.filter((c) => /json/.test(c.data_type)).map(named)).toEqual(
      [],
    );
    // The audit id comes from a `sequences` row bumped in the same
    // transaction, not from anything the engine generates on its own.
    expect(
      columns
        .filter(
          (c) =>
            c.is_identity === "YES" || /nextval/.test(c.column_default ?? ""),
        )
        .map(named),
    ).toEqual([]);
  });

  test("every instant is a bigint, because a ms epoch does not fit an integer", async () => {
    const store = await tempStore();
    // `provider_assets.service_ends_at` is the provider's OWN string, carried
    // verbatim rather than parsed, so it is the one column with this shape that
    // is not one of our epochs.
    const notOurs = new Set(["provider_assets.service_ends_at"]);
    const instants = (
      await store.sqlAll<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        "select table_name, column_name, data_type from information_schema.columns " +
          "where table_schema = current_schema() " +
          "and (column_name like '%\\_at' or column_name like '%\\_until')",
      )
    ).filter((c) => !notOurs.has(`${c.table_name}.${c.column_name}`));
    expect(instants.length).toBeGreaterThan(20);
    expect(
      instants
        .filter((c) => c.data_type !== "bigint")
        .map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`),
    ).toEqual([]);
  });

  test("a written instant comes back as a NUMBER, not the driver's string", async () => {
    // The driver hands bigint back as a string unless it is told otherwise, and
    // a string timestamp would compare, sort and serialise without ever
    // complaining - it would simply be wrong everywhere a deadline is
    // evaluated. So the parser is pinned by a real round trip through a real
    // column rather than by reading the pool's configuration back.
    const written = Date.parse("2027-06-10T12:34:56.789Z");
    const store = await tempStore(() => written);
    const inst = await seedInstance(store);

    const row = (await store.getInstance(inst))!;
    expect(typeof row.created_at).toBe("number");
    expect(row.created_at).toBe(written);
    // And it is not a value an `integer` column could have held: this exact
    // schema answered 22003 before the columns became bigint.
    expect(written).toBeGreaterThan(2 ** 31);

    // Every other shape a time reaches us through: a returning clause, a
    // sequence bump, and a nullable column.
    const op = await store.enqueue({
      id: "op-bigint",
      instance_id: inst,
      kind: "verify_https",
      inactivity_deadline_at: written + 1,
      absolute_deadline_at: written + 2,
    });
    const leased = (await store.tryLease(
      op.id,
      op.version,
      "a",
      written + 3,
      written,
    ))!;
    expect(typeof leased.lease_until).toBe("number");
    expect(leased.lease_until).toBe(written + 3);
    expect(typeof leased.absolute_deadline_at).toBe("number");
    expect(
      (await store.getInstance(inst))?.access_window_expires_at,
    ).toBeNull();
    expect(typeof (await store.nextSeq("audit"))).toBe("number");
  });

  test("a uniqueness refusal is 23505, and a check refusal is not read as one", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await seedOp(store, inst, "mint_invite");

    // A REAL refusal from the partial unique index, not a hand-built error.
    const duplicate = await seedOp(store, inst, "mint_invite").then(
      () => null,
      (err: unknown) => err,
    );
    expect((duplicate as { code?: string }).code).toBe("23505");
    expect(isUniqueViolation(duplicate)).toBe(true);

    // A CHECK violation is a different SQLSTATE and must not be read as
    // "somebody already has it": that would turn a bug into a shrug.
    const bad = await store
      .createInstance({
        id: "inst-bad",
        run_id: null,
        name: "x",
        plan: "V153",
        region: "EU",
        service_state: "mostly-live" as never,
        goal: "live",
        access_window_expires_at: null,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect((bad as { code?: string }).code).toBe("23514");
    expect(isUniqueViolation(bad)).toBe(false);
  });

  test("audit ids come from a sequence, so they are ordered and portable", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await store.tx(async () => {
      await store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "a",
        target: "1",
        outcome: "succeeded",
        detail: null,
      });
      await store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "b",
        target: "2",
        outcome: "succeeded",
        detail: null,
      });
    });
    const seqs = (await store.auditEvents()).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("deadline flagging never CASes through a live lease", () => {
  test("a lease taken between selection and flagging wins", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    // The flagger read this row while it was free.
    const seen = (await store.getOperation(op.id))!;
    // A holder leases it in the gap, at the same version the flagger holds.
    const leased = await store.tryLease(
      seen.id,
      seen.version,
      "holder",
      60_000,
      1_000,
    );
    expect(leased).not.toBeNull();
    // Flagging must lose. Succeeding would bump the version out from under a
    // fence that is already at a remote seam.
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity", 1_000),
    ).toBeNull();
    // Even with the CURRENT version, the live lease still refuses it.
    expect(
      await store.flagDeadline(seen.id, leased!.version, "inactivity", 1_000),
    ).toBeNull();
    // Once the lease has expired it flags normally.
    expect(
      await store.flagDeadline(seen.id, leased!.version, "inactivity", 60_001),
    ).not.toBeNull();
  });
});

describe("finite state sets are enforced by the database", () => {
  test("an unknown asset state is rejected", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    expect(
      store.createAsset({
        id: "asset-bad",
        instance_id: inst,
        provider: "contabo",
        provider_id: "1",
        intent_id: null,
        asset_state: "probably-fine",
        ipv4: null,
        service_ends_at: null,
        host_key_fingerprint: null,
        next_reconcile_at: 0,
      }),
    ).rejects.toThrow(/SQLSTATE 23514/);
  });

  test("an unknown service state is rejected", async () => {
    const store = await tempStore();
    expect(
      store.createInstance({
        id: "inst-bad",
        run_id: null,
        name: "x",
        plan: "V153",
        region: "EU",
        service_state: "mostly-live" as never,
        goal: "live",
        access_window_expires_at: null,
      }),
    ).rejects.toThrow(/SQLSTATE 23514/);
  });
});

describe("a database from before this slice", () => {
  test("refuses to open, by name, instead of failing mid-run", async () => {
    const dsn = await freshDsn();
    // The shape slice 2 inherited: the tables exist, the new columns do not.
    await seedRawSchema(
      dsn,
      "create table attention_reasons (id text primary key, instance_id text, " +
        "source_op_id text, reason text, severity text, raised_at integer, " +
        "cleared_at integer, acknowledged_at integer, acknowledged_by text)",
    );
    expect(Store.open(dsn)).rejects.toThrow(/predates this version/);
  });

  test("every column slice 5 added is pinned, one at a time", async () => {
    // One database per column, each missing exactly that column, so the pin is
    // proven per name rather than by one table that happens to be old. A column
    // added to the schema and forgotten here opens cleanly and fails somewhere
    // in the middle of a cancellation instead.
    const SLICE_5: [string, string, string][] = [
      [
        "accounts",
        "is_operator",
        "create table accounts (id text primary key, email text, google_subject text, " +
          "stripe_customer_id text, version integer, created_at integer, updated_at integer)",
      ],
      ["subscriptions", "ended_at", subscriptionsWithout("ended_at")],
      ["subscriptions", "canceled_at", subscriptionsWithout("canceled_at")],
      [
        "subscriptions",
        "cancellation_reason",
        subscriptionsWithout("cancellation_reason"),
      ],
    ];
    for (const [table, column, ddl] of SLICE_5) {
      const dsn = await freshDsn();
      await seedRawSchema(dsn, ddl);
      expect([
        `${table}.${column}`,
        await (async () => {
          try {
            await Store.open(dsn);
            return "opened";
          } catch (err) {
            return (err as Error).message.includes(`${table} has no ${column}`)
              ? "refused by name"
              : (err as Error).message;
          }
        })(),
      ]).toEqual([`${table}.${column}`, "refused by name"]);
    }
  });
});

/** The subscriptions table with one column left out, and nothing else changed. */
function subscriptionsWithout(missing: string): string {
  const columns = [
    "id text primary key",
    "account_id text",
    "instance_id text",
    "stripe_customer_id text",
    "status text",
    "current_period_end integer",
    "cancel_at_period_end integer",
    "ended_at integer",
    "canceled_at integer",
    "cancellation_reason text",
    "episode_state text",
    "exhaustion_observed_at integer",
    "version integer",
    "created_at integer",
    "updated_at integer",
  ].filter((c) => !c.startsWith(`${missing} `));
  return `create table subscriptions (${columns.join(", ")})`;
}

describe("the access-window ceiling is a store invariant, not a convention", () => {
  test("casInstance refuses to write it, whatever the caller believes", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const row = (await store.getInstance(inst))!;
    expect(
      store.casInstance(inst, row.version, {
        access_window_expires_at: 123,
      } as never),
    ).rejects.toThrow(/written once/);
    // Nothing moved, not even the version.
    expect((await store.getInstance(inst))?.version).toBe(row.version);
  });

  test("it is settable at creation, and only there", async () => {
    const store = await tempStore();
    await store.createInstance({
      id: "inst-ceiling",
      run_id: null,
      name: "x",
      plan: "V153",
      region: "EU",
      service_state: "provisioning",
      goal: "live",
      access_window_expires_at: 999,
    });
    expect(
      (await store.getInstance("inst-ceiling"))?.access_window_expires_at,
    ).toBe(999);
  });
});

describe("the two fences: time bounds ACTING, the token bounds RECORDING", () => {
  test("an expired holder that nobody adopted may still record what it did", async () => {
    let t = 1_000;
    const store = await tempStore(() => t);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "A", 2_000, t))!;
    // Past the lease, and the row has not moved: no other holder has adopted,
    // no deadline flag has landed. A is still the only actor there has ever
    // been, and this write is the record of work done while it held the lease.
    // Refusing it would lose evidence without preventing anything.
    t = 2_001;
    expect(
      await store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).not.toBeNull();
  });

  test("the moment another holder adopts, the old result is refused", async () => {
    let t = 1_000;
    const store = await tempStore(() => t);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "A", 2_000, t))!;
    t = 2_001;
    // B adopts the expired lease. THAT is what ends A's authority to record.
    expect(
      await store.tryLease(op.id, held.version, "B", 62_000, t),
    ).not.toBeNull();
    expect(
      await store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
    expect((await store.getOperation(op.id))?.status).not.toBe("succeeded");
  });

  test("a row with no lease at all cannot be written through the fence", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    expect(
      await store.casOperation(
        { id: op.id, version: op.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
  });
});

// The two bounds this build states as guarantees, and the fact that a managed
// engine can silently decline to apply them. Measured 2026-08-11: the local
// Postgres honours the pg pool's startup fields and Neon's direct endpoint
// ignores them without an error, so the store now carries them in `options` and
// READS THEM BACK before it hands anybody a Store.
describe("the governed connection options", () => {
  afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

  function optionsOf(url: string): string {
    return new URL(withGovernedOptions(url)).searchParams.get("options") ?? "";
  }

  test("a DSN with no options gets both bounds", () => {
    const options = optionsOf("postgres://u:p@h:5432/db");
    expect(options).toContain("-c statement_timeout=30s");
    expect(options).toContain("-c idle_in_transaction_session_timeout=30s");
  });

  test("an unrelated option is preserved, and stays first", () => {
    const options = optionsOf(
      "postgres://u:p@h:5432/db?options=" +
        encodeURIComponent("-c search_path=cp_test_1"),
    );
    expect(options.startsWith("-c search_path=cp_test_1")).toBe(true);
    expect(options).toContain("-c statement_timeout=30s");
  });

  // AUTHORITATIVE, not a default: a caller who writes their own value into
  // CONTROL_PLANE_DB does not get it, because these two are the store's own
  // promise rather than something it offers.
  test("a conflicting value is removed rather than appended after", () => {
    const options = optionsOf(
      "postgres://u:p@h:5432/db?options=" +
        encodeURIComponent("-c statement_timeout=1ms"),
    );
    expect(options).not.toContain("1ms");
    expect(options.match(/statement_timeout/g)).toHaveLength(1);
  });

  test("duplicate and long-form conflicting values are all removed", () => {
    const options = optionsOf(
      "postgres://u:p@h:5432/db?options=" +
        encodeURIComponent(
          "-c statement_timeout=1ms --idle_in_transaction_session_timeout=2ms " +
            "-c statement_timeout=3ms -c search_path=keep",
        ),
    );
    expect(options).not.toContain("1ms");
    expect(options).not.toContain("2ms");
    expect(options).not.toContain("3ms");
    expect(options).toContain("-c search_path=keep");
    expect(options.match(/statement_timeout=/g)).toHaveLength(1);
    expect(options.match(/idle_in_transaction_session_timeout=/g)).toHaveLength(
      1,
    );
  });

  // The engine's own answer, through a real open. This is the test the whole
  // change exists for: it fails if the merge stops happening.
  test("both bounds are in effect on an opened store", async () => {
    const store = await openTestStore();
    const row = await store.sqlGet<{ s: string; i: string }>(
      "select current_setting('statement_timeout') as s, " +
        "current_setting('idle_in_transaction_session_timeout') as i",
    );
    expect(row?.s).toBe("30s");
    expect(row?.i).toBe("30s");
  });

  // The merge cannot be defeated by writing the option without a space, which
  // is a form Postgres accepts and a naive `-c ` split does not see.
  test("the joined -cname=value form is caught too", () => {
    const options = optionsOf(
      "postgres://u:p@h:5432/db?options=" +
        encodeURIComponent("-cstatement_timeout=1ms"),
    );
    expect(options).not.toContain("1ms");
    expect(options.match(/statement_timeout=/g)).toHaveLength(1);
  });

  // There is deliberately NO test that provokes the refusal from a DSN, and the
  // absence is the property: the merge strips every conflicting token, so no
  // connection string can reach the engine with the wrong bound. What the
  // refusal guards is an engine that ACCEPTS `options` and does not apply it -
  // measured on Neon's startup fields, 2026-08-11 - and no local Postgres can
  // be made to do that on demand. The mutation check for this pair is the test
  // above: make `withGovernedOptions` return its input unchanged, and "both
  // bounds are in effect on an opened store" fails.
});

describe("connection details on the error path", () => {
  afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

  const dsn =
    "postgres://therole:thepassword@ep-secret-endpoint.example.com:5432/thedb" +
    "?sslmode=verify-full&options=" +
    encodeURIComponent("-c search_path=cp_test_9");

  // The property is not "the message is scrubbed" - it is that the driver's
  // message is never copied. A test that only checked for known substrings
  // would pass for a design that forwards an unknown one.
  test("the driver's message is not carried at all", () => {
    const err = redactConnectionDetails(
      new Error("password authentication failed for user 'therole'"),
      dsn,
    );
    expect(err.message).not.toContain("password authentication failed");
    expect(err.message).not.toContain("therole");
    expect(err.message).toContain("could not be reached");
  });

  // Every component, INCLUDING the ones a length filter used to skip and the
  // host labels a whole-hostname check used to miss.
  test("no component reaches the output, whatever its length", () => {
    const short = "postgres://a:b@h.example.com:1/cd?sslmode=require";
    for (const leaked of ["a", "b", "cd", "1", "h.example.com", "h"]) {
      const err = redactConnectionDetails(
        new Error(`connect failed near ${leaked}`),
        short,
      );
      expect(err.message).not.toContain(`near ${leaked}`);
      expect(err.stack ?? "").not.toContain(`near ${leaked}`);
    }
  });

  // The stack is the back door: its first line is `Error: <driver message>`,
  // so a stack that merely passed the component check would carry the driver's
  // free text across a boundary whose whole claim is that it does not.
  test("the driver's free text does not survive on the stack either", () => {
    const original = new Error(
      'duplicate key value violates unique constraint "operations_pkey"',
    );
    original.stack =
      "Error: duplicate key value violates unique constraint\n" +
      "    at cleanFrame (/safe/frame.ts:1:1)";
    const err = redactConnectionDetails(original, dsn);
    for (const surface of [err.message, err.stack ?? ""]) {
      expect(surface).not.toContain("duplicate key value violates");
    }
    // And the debugging property the rebuild exists to keep: a clean call-site
    // frame is still there, under a header that is ours.
    expect(err.stack ?? "").toMatch(/^RedactedDatabaseError: /);
    expect(err.stack ?? "").toMatch(/\n\s+at\s/);
    expect((err.stack ?? "").split("\n")[0]).toBe(
      `RedactedDatabaseError: ${err.message}`,
    );
  });

  test("the endpoint id alone is a component, not only the whole host", () => {
    const err = redactConnectionDetails(
      new Error("could not connect to ep-secret-endpoint"),
      dsn,
    );
    expect(err.message).not.toContain("ep-secret-endpoint");
  });

  test("an options value and its tokens are components", () => {
    for (const leaked of ["-c search_path=cp_test_9", "cp_test_9"]) {
      const err = redactConnectionDetails(new Error(`bad ${leaked}`), dsn);
      expect(err.message).not.toContain(leaked);
    }
  });

  // A SQLSTATE keeps the structured fields, which are literals of ours - so a
  // unique violation is still diagnosable without the engine's prose.
  test("a statement error keeps its SQLSTATE and its own structured fields", () => {
    const err = redactConnectionDetails(
      Object.assign(
        new Error("duplicate key value violates unique constraint"),
        {
          code: "23505",
          constraint: "operations_pkey",
          table: "operations",
          schema: "cp_test_9",
          detail: "Key (id)=(op-1) already exists.",
        },
      ),
      dsn,
    );
    expect(err.message).toContain("SQLSTATE 23505");
    expect(err.message).toContain("constraint=operations_pkey");
    expect(err.message).toContain("table=operations");
    // `schema` can be the search_path out of `options`, and `detail`
    // interpolates values - neither is on the allowlist.
    expect(err.message).not.toContain("cp_test_9");
    expect(err.message).not.toContain("op-1");
  });

  // A cause is how a redacted message comes back one layer down, through any
  // logger that walks the chain.
  test("no cause is carried", () => {
    const original = new Error("password authentication failed for therole");
    const err = redactConnectionDetails(original, dsn) as Error & {
      cause?: unknown;
    };
    expect(err.cause).toBeUndefined();
  });

  test("the driver's code survives, because it is what a reader needs", () => {
    const original = Object.assign(new Error("nope"), { code: "28P01" });
    expect(
      (redactConnectionDetails(original, dsn) as { code?: string }).code,
    ).toBe("28P01");
  });

  test("describe() names the variable, never the value", async () => {
    const store = await openTestStore();
    expect(store.describe()).toBe(DATABASE_NAME);
    expect(store.describe()).not.toContain("postgres");
    expect(store.describe()).not.toContain("5433");
  });
});
