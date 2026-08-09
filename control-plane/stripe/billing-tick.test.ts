// The coupon-lapse hold expiring: the only billing transition that is not a
// webhook, and the one place where "the calendar moved" must not be mistaken for
// "Stripe gave up".

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
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

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-billing-tick-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), () => NOW);
}

function seedInstance(store: Store, id = "inst-1"): string {
  store.createInstance({
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

function seedHold(
  store: Store,
  over: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return store.tx(() => {
    ensureAccount(store, { id: "acct-1", email: "a@example.com" });
    return insertSubscription(store, {
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

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("an expired hold with exhaustion already observed", () => {
  test("requests suspension exactly once, and a second pass adds nothing", () => {
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 86_400_000 });

    const first = billingTick(store, NOW);
    expect(first).toMatchObject({ examined: 1, suspensionsRequested: 1 });
    expect(getSubscription(store, "sub_1")?.episode_state).toBe(
      "suspension_requested",
    );
    const opId = suspensionOperationId("dun-evt_1");
    expect(store.getOperation(opId)).not.toBeNull();

    // The row has left the hold state, so the second pass does not even see it.
    const second = billingTick(store, NOW);
    expect(second.examined).toBe(0);
    expect(
      store.operationsFor("inst-1").filter((o) => o.kind === "power_off"),
    ).toHaveLength(1);
  });

  test("the audit trail says what happened", () => {
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 10 });
    billingTick(store, NOW);
    const actions = store.auditEvents().map((e) => e.action);
    expect(actions).toContain("suspension_requested");
    expect(actions).toContain("coupon_hold_expired");
  });
});

describe("an expired hold with NO exhaustion evidence", () => {
  test("resumes the ordinary ladder and suspends nothing", () => {
    // The 14 days running out is not evidence that Stripe stopped retrying.
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: null });

    const summary = billingTick(store, NOW);
    expect(summary).toMatchObject({
      examined: 1,
      resumedToLadder: 1,
      suspensionsRequested: 0,
    });
    const row = getSubscription(store, "sub_1")!;
    expect(row.episode_state).toBe("open");
    expect(row.coupon_grace_until).toBeNull();
    // Same episode id: the account has not started a NEW failure sequence, it has
    // only stopped being held back from the ordinary one.
    expect(row.episode_id).toBe("dun-evt_1");
    expect(
      store.operationsFor("inst-1").filter((o) => o.kind === "power_off"),
    ).toEqual([]);
    expect(store.openReasons("inst-1")[0]?.reason).toContain(
      "ordinary dunning ladder",
    );
  });
});

describe("holds that should not be acted on", () => {
  test("one whose deadline has not passed is left alone", () => {
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { coupon_grace_until: NOW + 60_000 });
    expect(billingTick(store, NOW).examined).toBe(0);
    expect(getSubscription(store, "sub_1")?.episode_state).toBe("coupon_hold");
  });

  test("one that got paid closes without suspension", () => {
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { status: "active", exhaustion_observed_at: NOW - 10 });
    const summary = billingTick(store, NOW);
    expect(summary).toMatchObject({ closed: 1, suspensionsRequested: 0 });
    expect(getSubscription(store, "sub_1")).toMatchObject({
      episode_state: "none",
      episode_id: null,
      coupon_grace_until: null,
    });
  });

  test("one a webhook moved out of the hold between select and transaction", () => {
    // The row is selected outside the transaction, so the state is re-read inside
    // it; a webhook that closed the episode in the gap must win.
    const store = tempStore();
    seedInstance(store);
    const sub = seedHold(store, { exhaustion_observed_at: NOW - 10 });
    const lines: string[] = [];
    // Simulate the race by moving the row after the select the tick will do.
    const realHolds = store.db.query.bind(store.db);
    let moved = false;
    store.db.query = ((sql: string) => {
      const q = realHolds(sql);
      if (!moved && sql.includes("episode_state = 'coupon_hold'")) {
        const wrapped = {
          ...q,
          all: (...args: unknown[]) => {
            const rows = (q as { all: (...a: unknown[]) => unknown[] }).all(
              ...args,
            );
            moved = true;
            store.tx(() =>
              store.db.run(
                "update subscriptions set episode_state = 'none', version = version + 1 where id = ?",
                [sub.id],
              ),
            );
            return rows;
          },
        };
        return wrapped;
      }
      return q;
    }) as typeof store.db.query;

    const summary = billingTick(store, NOW, (l) => lines.push(l));
    store.db.query = realHolds;
    expect(summary.suspensionsRequested).toBe(0);
    expect(lines.join("\n")).toContain("left its coupon-lapse hold");
    expect(
      store.operationsFor("inst-1").filter((o) => o.kind === "power_off"),
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
    const realQuery = store.db.query.bind(store.db);
    let done = false;
    store.db.query = ((text: string) => {
      const q = realQuery(text);
      if (done || !text.includes("episode_state = 'coupon_hold'")) return q;
      return {
        ...q,
        all: (...a: unknown[]) => {
          const rows = (q as { all: (...x: unknown[]) => unknown[] }).all(...a);
          done = true;
          store.tx(() => store.db.run(sql, args as never));
          return rows;
        },
      };
    }) as typeof store.db.query;
    return () => {
      store.db.query = realQuery;
    };
  }

  test("exhaustion arriving in the gap turns a resume into a SUSPENSION", () => {
    // The dangerous direction: the scanned row said "no evidence, resume the
    // ordinary ladder", and a webhook recorded exhaustion a moment later. Acting on
    // the stale decision would leave an unpaid box running with the episode
    // reopened and nobody asking for a suspension.
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: null });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set exhaustion_observed_at = ?, version = version + 1 where id = ?",
      [NOW - 60_000, "sub_1"],
    );
    const summary = billingTick(store, NOW);
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 1,
      resumedToLadder: 0,
    });
    expect(getSubscription(store, "sub_1")?.episode_state).toBe(
      "suspension_requested",
    );
    expect(
      store.getOperation(suspensionOperationId("dun-evt_1")),
    ).not.toBeNull();
  });

  test("evidence withdrawn in the gap turns a suspension into a resume", () => {
    // The other direction, for the same reason: whatever the fresh row says is what
    // gets acted on.
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 60_000 });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set exhaustion_observed_at = null, version = version + 1 where id = ?",
      ["sub_1"],
    );
    const summary = billingTick(store, NOW);
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 0,
      resumedToLadder: 1,
    });
    expect(getSubscription(store, "sub_1")?.episode_state).toBe("open");
    expect(
      store.operationsFor("inst-1").filter((o) => o.kind === "power_off"),
    ).toEqual([]);
  });

  test("a hold whose deadline moved out in the gap is left alone", () => {
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 60_000 });
    const restore = mutateAfterScan(
      store,
      "update subscriptions set coupon_grace_until = ?, version = version + 1 where id = ?",
      [NOW + 86_400_000, "sub_1"],
    );
    const lines: string[] = [];
    const summary = billingTick(store, NOW, (l) => lines.push(l));
    restore();

    expect(summary).toMatchObject({
      suspensionsRequested: 0,
      resumedToLadder: 0,
    });
    expect(getSubscription(store, "sub_1")?.episode_state).toBe("coupon_hold");
    expect(lines.join("\n")).toContain("has not expired");
  });
});

describe("nothing is counted or printed before it commits", () => {
  test("a failed COMMIT rolls the transition back and the summary claims nothing", () => {
    // The counters and the report line used to be written inside the transaction, so
    // a commit that failed left a summary claiming a suspension that does not exist.
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 60_000 });

    const realRun = store.db.run.bind(store.db);
    let broken = true;
    store.db.run = (sql: string, ...rest: never[]) => {
      if (broken && sql.trim().toLowerCase() === "commit") {
        throw new Error("disk went away at commit time");
      }
      return realRun(sql, ...rest);
    };

    const lines: string[] = [];
    const summary = billingTick(store, NOW, (l) => lines.push(l));
    broken = false;
    store.db.run = realRun;

    expect(summary).toMatchObject({
      examined: 1,
      suspensionsRequested: 0,
      resumedToLadder: 0,
      closed: 0,
    });
    // The row and the operation are both gone with the rolled-back transaction.
    expect(getSubscription(store, "sub_1")?.episode_state).toBe("coupon_hold");
    expect(store.getOperation(suspensionOperationId("dun-evt_1"))).toBeNull();
    expect(lines.join("\n")).toContain("could not expire");
    // And the failure is REPORTED rather than passed over.
    expect(lines.join("\n")).toContain("disk went away");
  });

  test("a reporter that throws cannot undo or hide committed work", () => {
    // The other side of the same coin: once the transition is durable, a broken
    // reporter must not turn it into an apparent failure.
    const store = tempStore();
    seedInstance(store);
    seedHold(store, { exhaustion_observed_at: NOW - 60_000 });

    const summary = billingTick(store, NOW, () => {
      throw new Error("the reporter is broken");
    });

    expect(summary.suspensionsRequested).toBe(1);
    expect(getSubscription(store, "sub_1")?.episode_state).toBe(
      "suspension_requested",
    );
    expect(
      store.getOperation(suspensionOperationId("dun-evt_1")),
    ).not.toBeNull();
  });
});

describe("a hold on a subscription with no instance", () => {
  test("records the request instead of enqueueing anything", () => {
    const store = tempStore();
    seedHold(store, { instance_id: null, exhaustion_observed_at: NOW - 10 });
    const summary = billingTick(store, NOW);
    expect(summary).toMatchObject({ examined: 1, suspensionsRequested: 0 });
    expect(getSubscription(store, "sub_1")?.episode_state).toBe(
      "suspension_requested",
    );
    const audit = store.auditEvents().map((e) => `${e.action}:${e.outcome}`);
    expect(audit).toContain("suspension_requested:failed");
  });
});
