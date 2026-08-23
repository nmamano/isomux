// The coupon-lapse hold expiring: the only billing transition that is not a
// webhook, and the one place where "the calendar moved" must not be mistaken for
// "Stripe gave up".

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, type SqlArgs } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import {
  ensureAccount,
  getSubscription,
  insertSubscription,
  type SubscriptionRow,
} from "./billing-store.ts";
import { billingTick } from "./billing-tick.ts";
import { suspensionOperationId } from "./dunning.ts";

const NOW = 1_770_000_000_000;
const temps: string[] = [];

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-billing-tick-"));
  temps.push(dir);
  return await openTestStore(() => NOW);
}

async function seedInstance(store: Store, id = "inst-1"): Promise<string> {
  await store.createInstance({
    id,
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "handed_off",
    access_window_expires_at: null,
  });
  return id;
}

async function seedHold(
  store: Store,
  over: Partial<SubscriptionRow> = {},
): Promise<SubscriptionRow> {
  return await store.tx(async () => {
    await ensureAccount(store, { id: "acct-1", email: "a@example.com" });
    return await insertSubscription(store, {
      id: over.id ?? "sub_1",
      account_id: "acct-1",
      // `??` would swallow an explicit null, which is exactly the case one test
      // below is about.
      instance_id:
        "instance_id" in over ? (over.instance_id ?? null) : "inst-1",
      stripe_customer_id: "cus_1",
      status: over.status ?? "past_due",
      current_period_end: null,
      cancel_at_period_end: 0,
      ended_at: null,
      canceled_at: null,
      cancellation_reason: null,
      discount_percent_off: null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: 1,
      latest_invoice_id: "in_1",
      payment_failures: over.payment_failures ?? 2,
      exhaustion_observed_at: over.exhaustion_observed_at ?? null,
      coupon_grace_until: over.coupon_grace_until ?? NOW - 1,
      episode_id: over.episode_id ?? "dun-evt_1",
      episode_state: over.episode_state ?? "coupon_hold",
      last_event_id: null,
      last_event_created: null,
    });
  });
}

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

describe("an expired hold with exhaustion already observed", () => {
  test("requests suspension exactly once, and a second pass adds nothing", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 86_400_000 });

    const first = await billingTick(store, NOW);
    expect(first).toMatchObject({ examined: 1, suspensionsRequested: 1 });
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "suspension_requested",
    );
    const opId = suspensionOperationId("dun-evt_1");
    expect(await store.getOperation(opId)).not.toBeNull();

    // The row has left the hold state, so the second pass does not even see it.
    const second = await billingTick(store, NOW);
    expect(second.examined).toBe(0);
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toHaveLength(1);
  });

  test("the audit trail says what happened", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 10 });
    await billingTick(store, NOW);
    const actions = (await store.auditEvents()).map((e) => e.action);
    expect(actions).toContain("suspension_requested");
    expect(actions).toContain("coupon_hold_expired");
  });
});

describe("an expired hold with NO exhaustion evidence", () => {
  test("resumes the ordinary ladder and suspends nothing", async () => {
    // The 14 days running out is not evidence that Stripe stopped retrying.
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: null });

    const summary = await billingTick(store, NOW);
    expect(summary).toMatchObject({
      examined: 1,
      resumedToLadder: 1,
      suspensionsRequested: 0,
    });
    const row = (await getSubscription(store, "sub_1"))!;
    expect(row.episode_state).toBe("open");
    expect(row.coupon_grace_until).toBeNull();
    // Same episode id: the account has not started a NEW failure sequence, it has
    // only stopped being held back from the ordinary one.
    expect(row.episode_id).toBe("dun-evt_1");
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toEqual([]);
    expect((await store.openReasons("inst-1"))[0]?.reason).toContain(
      "ordinary dunning ladder",
    );
  });
});

describe("holds that should not be acted on", () => {
  test("one whose deadline has not passed is left alone", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { coupon_grace_until: NOW + 60_000 });
    expect((await billingTick(store, NOW)).examined).toBe(0);
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "coupon_hold",
    );
  });

  test("one that got paid closes without suspension", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, {
      status: "active",
      exhaustion_observed_at: NOW - 10,
    });
    const summary = await billingTick(store, NOW);
    expect(summary).toMatchObject({ closed: 1, suspensionsRequested: 0 });
    expect(await getSubscription(store, "sub_1")).toMatchObject({
      episode_state: "none",
      episode_id: null,
      coupon_grace_until: null,
    });
  });

  test("one a webhook moved out of the hold between select and transaction", async () => {
    // The row is selected outside the transaction, so the state is re-read inside
    // it; a webhook that closed the episode in the gap must win.
    const store = await tempStore();
    await seedInstance(store);
    const sub = await seedHold(store, { exhaustion_observed_at: NOW - 10 });
    const lines: string[] = [];
    // Simulate the race by moving the row AFTER the scan has read it. The seam
    // is the public SQL primitive now that the engine handle is private; the
    // ordering it produces is the same one the wrapped statement produced -
    // rows read, row moved, rows returned.
    const realHolds = store.sqlAll.bind(store);
    let moved = false;
    store.sqlAll = (async (sql: string, args?: unknown[]) => {
      const rows = await realHolds(sql, args as never);
      if (!moved && sql.includes("episode_state = 'coupon_hold'")) {
        moved = true;
        await store.tx(() =>
          store.sqlRun(
            "update subscriptions set episode_state = 'none', version = version + 1 where id = $1",
            [sub.id],
          ),
        );
      }
      return rows;
    }) as unknown as typeof store.sqlAll;

    let summary;
    try {
      summary = await billingTick(store, NOW, (l) => lines.push(l));
    } finally {
      store.sqlAll = realHolds;
    }
    expect(summary.suspensionsRequested).toBe(0);
    expect(lines.join("\n")).toContain("left its coupon-lapse hold");
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toEqual([]);
  });
});

describe("the row can change between the scan and the transaction", () => {
  /**
   * Move the row after the outer scan has read it, before the transaction opens.
   *
   * The scan runs with no transaction held, so a webhook can land in that gap. The
   * decision must come from the RE-READ row, not from the copy the scan returned.
   */
  function mutateAfterScan(
    store: Store,
    sql: string,
    args: unknown[] = [],
  ): () => void {
    const realAll = store.sqlAll.bind(store);
    let done = false;
    store.sqlAll = (async (text: string, a?: unknown[]) => {
      const rows = await realAll(text, a as never);
      if (done || !text.includes("episode_state = 'coupon_hold'")) return rows;
      done = true;
      await store.tx(() => store.sqlRun(sql, args as never));
      return rows;
    }) as unknown as typeof store.sqlAll;
    return () => {
      store.sqlAll = realAll;
    };
  }

  test("exhaustion arriving in the gap turns a resume into a SUSPENSION", async () => {
    // The dangerous direction: the scanned row said "no evidence, resume the
    // ordinary ladder", and a webhook recorded exhaustion a moment later. Acting on
    // the stale decision would leave an unpaid box running with the episode
    // reopened and nobody asking for a suspension.
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: null });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set exhaustion_observed_at = $1, version = version + 1 where id = $2",
      [NOW - 60_000, "sub_1"],
    );
    const summary = await billingTick(store, NOW);
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 1,
      resumedToLadder: 0,
    });
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "suspension_requested",
    );
    expect(
      await store.getOperation(suspensionOperationId("dun-evt_1")),
    ).not.toBeNull();
  });

  test("evidence withdrawn in the gap turns a suspension into a resume", async () => {
    // The other direction, for the same reason: whatever the fresh row says is what
    // gets acted on.
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 60_000 });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set exhaustion_observed_at = null, version = version + 1 where id = $1",
      ["sub_1"],
    );
    const summary = await billingTick(store, NOW);
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 0,
      resumedToLadder: 1,
    });
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe("open");
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toEqual([]);
  });

  test("a hold whose deadline moved out in the gap is left alone", async () => {
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 60_000 });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set coupon_grace_until = $1, version = version + 1 where id = $2",
      [NOW + 86_400_000, "sub_1"],
    );
    const lines: string[] = [];
    const summary = await billingTick(store, NOW, (l) => lines.push(l));
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 0,
      resumedToLadder: 0,
    });
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "coupon_hold",
    );
    expect(lines.join("\n")).toContain("has not expired");
  });
});

describe("nothing is counted or printed before it commits", () => {
  test("a failed COMMIT rolls the transition back and the summary claims nothing", async () => {
    // The counters and the report line used to be written inside the transaction, so
    // a commit that failed left a summary claiming a suspension that does not exist.
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 60_000 });

    // The COMMIT is issued through the same public primitive as every other
    // statement, which is what keeps this injection point reachable now that
    // the engine handle is private.
    const realRun = store.sqlRun.bind(store);
    let broken = true;
    store.sqlRun = async (sql: string, args?: SqlArgs) => {
      if (broken && sql.trim().toLowerCase() === "commit") {
        throw new Error("disk went away at commit time");
      }
      return realRun(sql, args);
    };

    const lines: string[] = [];
    let summary;
    try {
      summary = await billingTick(store, NOW, (l) => lines.push(l));
    } finally {
      broken = false;
      store.sqlRun = realRun;
    }

    expect(summary).toMatchObject({
      examined: 1,
      suspensionsRequested: 0,
      resumedToLadder: 0,
      closed: 0,
    });
    // The row and the operation are both gone with the rolled-back transaction.
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "coupon_hold",
    );
    expect(
      await store.getOperation(suspensionOperationId("dun-evt_1")),
    ).toBeNull();
    expect(lines.join("\n")).toContain("could not expire");
    // And the failure is REPORTED rather than passed over.
    expect(lines.join("\n")).toContain("disk went away");
  });

  test("a reporter that throws cannot undo or hide committed work", async () => {
    // The other side of the same coin: once the transition is durable, a broken
    // reporter must not turn it into an apparent failure.
    const store = await tempStore();
    await seedInstance(store);
    await seedHold(store, { exhaustion_observed_at: NOW - 60_000 });

    const summary = await billingTick(store, NOW, () => {
      throw new Error("the reporter is broken");
    });

    expect(summary.suspensionsRequested).toBe(1);
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "suspension_requested",
    );
    expect(
      await store.getOperation(suspensionOperationId("dun-evt_1")),
    ).not.toBeNull();
  });
});

describe("a hold on a subscription with no instance", () => {
  test("records the request instead of enqueueing anything", async () => {
    const store = await tempStore();
    await seedHold(store, {
      instance_id: null,
      exhaustion_observed_at: NOW - 10,
    });
    const summary = await billingTick(store, NOW);
    expect(summary).toMatchObject({ examined: 1, suspensionsRequested: 0 });
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "suspension_requested",
    );
    const audit = (await store.auditEvents()).map(
      (e) => `${e.action}:${e.outcome}`,
    );
    expect(audit).toContain("suspension_requested:failed");
  });
});
