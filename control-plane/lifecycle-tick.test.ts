// The cancellation timeline walked end to end on SEEDED DATES. No clock moves
// here except the one the test hands the store.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addUtcMonth,
  CUSTOMER_CANCELLATION_REASON,
  GRACE_MS,
  LIFECYCLE_REASON,
  lifecycleOperationId,
  phaseAt,
  PROMISE_AT_RISK,
  PROMISE_BROKEN,
} from "./lifecycle.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";
import { Store } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";
import { RemoteBudget } from "./tick.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { powerOffHandler } from "./stripe/suspension.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ENDED = Date.parse("2027-01-31T09:00:00Z");
const GRACE_END = ENDED + GRACE_MS; // 2027-02-07T09:00:00Z

async function tempStore(now: () => number): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-lifetick-"));
  temps.push(dir);
  return await openTestStore(now);
}

function clock(start: number) {
  const state = { t: start };
  return { now: () => state.t, set: (t: number) => (state.t = t) };
}

async function seed(
  store: Store,
  over: {
    endedAt?: number | null;
    reason?: string | null;
    policy?: "legacy" | "launch";
  } = {},
): Promise<void> {
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: null,
  });
  await store.createAsset({
    id: "asset-1",
    instance_id: "inst-1",
    provider: "contabo",
    provider_id: "203474835",
    intent_id: null,
    asset_state: "active",
    ipv4: "169.58.97.2",
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: 0,
  });
  await store.tx(async () => {
    const account = await ensureAccount(store, {
      id: "acct-1",
      email: "a@b.test",
    });
    await insertSubscription(store, {
      id: "sub_1",
      account_id: account.id,
      instance_id: "inst-1",
      stripe_customer_id: "cus_1",
      status: over.endedAt === undefined ? "canceled" : "active",
      current_period_end: ENDED,
      cancel_at_period_end: 1,
      ended_at: over.endedAt === undefined ? ENDED : over.endedAt,
      canceled_at: Date.parse("2027-01-10T00:00:00Z"),
      cancellation_reason:
        over.reason === undefined ? CUSTOMER_CANCELLATION_REASON : over.reason,
      cancellation_policy: over.policy ?? "legacy",
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
}

/** Complete an operation the way a leased tick would, evidence and all. Written
 * with SQL rather than through casOperation because that setter fences on a
 * lease holder, and standing up a lease here would test the ticker rather than
 * the timeline. */
async function succeed(
  store: Store,
  id: string,
  evidence: object,
): Promise<void> {
  await store.sqlRun(
    "update operations set status = 'succeeded', evidence = $1, evidence_at = $2, " +
      "version = version + 1 where id = $3",
    [JSON.stringify(evidence), store.now(), id],
  );
}

describe("the walk, on seeded dates", () => {
  test("an unknown policy fails closed to the longer legacy timeline", () => {
    expect(
      phaseAt(
        {
          endedAt: ENDED,
          cancellationReason: CUSTOMER_CANCELLATION_REASON,
          poweredOffAt: null,
          repoweredAt: null,
          cancellationPolicy: null,
          assetGone: false,
        },
        ENDED,
      ),
    ).toMatchObject({ phase: "grace", graceEnd: GRACE_END });
  });

  test("launch powers off at period end and waits for proven suspension before day-14 deletion", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch", endedAt: null });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    await store.sqlRun(
      "update subscriptions set ended_at = $1, status = 'canceled' where id = 'sub_1'",
      [ENDED],
    );
    c.set(ENDED);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    const powerOffId = lifecycleOperationId("power_off", "sub_1", ENDED);

    c.set(ENDED + 14 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    expect(
      await store.getOperation(
        lifecycleOperationId("cancel_asset", "sub_1", ENDED),
      ),
    ).toBeNull();

    await succeed(store, powerOffId, {
      reason: LIFECYCLE_REASON,
      poweredOffAt: ENDED + 30_000,
    });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 2 });
    await store.close();
  });

  test("opening cancellation power-off fails a pending reboot atomically", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await store.enqueue({
      id: "op-reboot-pending",
      instance_id: "inst-1",
      kind: "reboot",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { via: "dashboard" },
    });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    expect((await store.getOperation("op-reboot-pending"))?.status).toBe(
      "failed",
    );
    await store.close();
  });

  test("a reboot after suspension opens one corrective power-off and holds deletion", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await lifecycleTick(store, c.now());
    await succeed(store, lifecycleOperationId("power_off", "sub_1", ENDED), {
      reason: LIFECYCLE_REASON,
      poweredOffAt: ENDED + 1,
    });
    await store.enqueue({
      id: "op-reboot-late",
      instance_id: "inst-1",
      kind: "reboot",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { via: "dashboard" },
    });
    await succeed(store, "op-reboot-late", {
      via: "dashboard",
      rebooted: true,
      rebootedAt: ENDED + 2,
    });
    c.set(ENDED + 14 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    const ops = await store.operationsFor("inst-1");
    const corrective = ops.find(
      (op) => op.kind === "power_off" && op.id.includes("corrective"),
    )!;
    expect(JSON.parse(corrective.evidence).reason).toBe(LIFECYCLE_REASON);
    expect(ops.some((op) => op.kind === "cancel_asset")).toBe(false);
    expect((await store.openReasons("inst-1"))[0].severity).toBe("critical");

    await succeed(store, corrective.id, {
      reason: LIFECYCLE_REASON,
      correctiveFor: "op-reboot-late",
      poweredOffAt: ENDED + 3,
    });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 2 });
    await store.close();
  });

  test("one correction answers all pre-change reboots that it observed", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await lifecycleTick(store, c.now());
    await succeed(store, lifecycleOperationId("power_off", "sub_1", ENDED), {
      reason: LIFECYCLE_REASON,
      poweredOffAt: ENDED + 1,
    });
    await store.enqueue({
      id: "op-reboot-old",
      instance_id: "inst-1",
      kind: "reboot",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: {},
    });
    await succeed(store, "op-reboot-old", { rebooted: true });
    for (const id of ["op-reboot-old-2", "op-reboot-old-3"]) {
      await store.enqueue({
        id,
        instance_id: "inst-1",
        kind: "reboot",
        inactivity_deadline_at: 0,
        absolute_deadline_at: 0,
        evidence: {},
      });
      await succeed(store, id, { rebooted: true });
    }
    c.set(ENDED + 14 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    const correction = (await store.operationsFor("inst-1")).find(
      (op) => op.kind === "power_off" && op.id.includes("corrective"),
    )!;
    expect(JSON.parse(correction.evidence).answeredReboots).toEqual([
      "op-reboot-old",
      "op-reboot-old-2",
      "op-reboot-old-3",
    ]);
    expect(await store.openReasons("inst-1")).toHaveLength(1);
    expect(
      (await store.operationsFor("inst-1")).some(
        (op) => op.kind === "cancel_asset",
      ),
    ).toBe(false);
    c.set(c.now() + 1);
    const result = await powerOffHandler({ powerOff: async () => {} }).run({
      store,
      op: correction,
      instance: (await store.getInstance("inst-1"))!,
      asset: await store.assetForInstance("inst-1"),
      fence: { id: correction.id, version: correction.version, holder: "test" },
      budget: new RemoteBudget(c.now() + 60_000, c.now() + 300_000, c.now),
      now: c.now(),
      report: () => {},
      audit: async () => {},
    });
    if (result.kind !== "done") throw new Error("corrective power-off failed");
    if (!result.evidence || typeof result.evidence !== "object") {
      throw new Error("corrective power-off returned no evidence");
    }
    await succeed(store, correction.id, result.evidence);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 2 });
    expect(
      (await store.operationsFor("inst-1")).filter(
        (op) => op.kind === "power_off" && op.id.includes("corrective"),
      ),
    ).toHaveLength(1);
    await store.close();
  });
  test("grace -> power_off -> suspended -> deprovision -> data end", async () => {
    const c = clock(ENDED + 1000);
    const store = await tempStore(c.now);
    await seed(store);

    // Inside the grace week the office KEEPS SERVING and nothing is opened.
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      examined: 1,
      opened: 0,
      phases: { grace: 1 },
    });

    // The instant grace ends, exactly one operation.
    c.set(GRACE_END);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    const powerOffId = lifecycleOperationId("power_off", "sub_1", ENDED);
    expect((await store.getOperation(powerOffId))!.kind).toBe("power_off");
    // A second pass before it completes opens nothing: the derived id is the
    // arbiter, not the one-active index, which stops holding once a row is
    // terminal.
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });

    // The provisioner powers it off and records WHEN.
    const poweredOffAt = GRACE_END + 30_000;
    c.set(poweredOffAt);
    await succeed(store, powerOffId, {
      reason: LIFECYCLE_REASON,
      poweredOff: true,
      poweredOffAt,
    });

    // A calendar month of retention: 7 Feb + 1 month = 7 Mar, not +30 days.
    const retentionEnd = addUtcMonth(poweredOffAt);
    expect(new Date(retentionEnd).toISOString()).toBe(
      "2027-03-07T09:00:30.000Z",
    );
    c.set(retentionEnd - 1);
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      opened: 0,
      phases: { suspended: 1 },
    });

    // At the deadline BOTH open, and neither waits for the other.
    c.set(retentionEnd);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 2 });
    expect(
      await store.getOperation(
        lifecycleOperationId("cancel_asset", "sub_1", ENDED),
      ),
    ).not.toBeNull();
    expect(
      await store.getOperation(
        lifecycleOperationId("remove_dns", "sub_1", ENDED),
      ),
    ).not.toBeNull();
    // Still not deprovisioned: our deadline is a request, not a deletion.
    expect((await store.getInstance("inst-1"))!.service_state).not.toBe(
      "deprovisioned",
    );

    // Provider truth is what ends it.
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, { asset_state: "cancelled" });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ finished: 1 });
    expect((await store.getInstance("inst-1"))!.service_state).toBe(
      "deprovisioned",
    );
    expect(
      (await store.auditEvents()).filter((e) => e.action === "data_end"),
    ).toHaveLength(1);
    // Recorded once, not on every pass afterwards.
    expect(await lifecycleTick(store, c.now())).toMatchObject({ finished: 0 });
    await store.close();
  });

  test("a dunning cancellation is left entirely alone", async () => {
    const c = clock(GRACE_END + 86_400_000);
    const store = await tempStore(c.now);
    await seed(store, { reason: "payment_failed" });
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      examined: 1,
      opened: 0,
      finished: 0,
    });
    await store.close();
  });

  test("cancel, un-cancel, re-cancel in ONE period opens nothing and keeps one id", async () => {
    // Measured 2026-08-10: the period end does not move across the three, so a
    // period-derived id would be identical each time. Anchoring on ended_at
    // means there is no id at all until the subscription is terminal.
    const c = clock(Date.parse("2027-01-20T00:00:00Z"));
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: null });

    const set = async (cape: number, reason: string | null) =>
      await store.sqlRun(
        "update subscriptions set cancel_at_period_end = $1, cancellation_reason = $2 where id = 'sub_1'",
        [cape, reason],
      );

    await set(1, CUSTOMER_CANCELLATION_REASON);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    await set(0, null);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    await set(1, CUSTOMER_CANCELLATION_REASON);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    expect(await store.operationsFor("inst-1")).toHaveLength(0);

    // Now it actually ends. One power_off, at the grace boundary, and its id is
    // the one the anchor computes.
    await store.sqlRun(
      "update subscriptions set ended_at = $1, status = 'canceled' where id = 'sub_1'",
      [ENDED],
    );
    c.set(GRACE_END);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 1 });
    const ops = await store.operationsFor("inst-1");
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe(lifecycleOperationId("power_off", "sub_1", ENDED));
    await store.close();
  });

  test("lifecycle rows on a subscription that is not terminal raise a person", async () => {
    const c = clock(Date.parse("2027-01-20T00:00:00Z"));
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: CUSTOMER_CANCELLATION_REASON });
    await store.enqueue({
      id: lifecycleOperationId("power_off", "sub_1", ENDED),
      instance_id: "inst-1",
      kind: "power_off",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { reason: LIFECYCLE_REASON },
    });
    const summary = await lifecycleTick(store, c.now());
    expect(summary).toMatchObject({ raised: 1, opened: 0 });
    const open = await store.openReasons("inst-1");
    expect(open[0].severity).toBe("critical");
    expect(open[0].reason).toContain("is not terminal");
    await store.close();
  });

  test("a provider term ending before the retention deadline raises, and changes nothing else", async () => {
    const c = clock(GRACE_END);
    const store = await tempStore(c.now);
    await seed(store);
    await lifecycleTick(store, c.now());
    const powerOffId = lifecycleOperationId("power_off", "sub_1", ENDED);
    const poweredOffAt = GRACE_END;
    await succeed(store, powerOffId, {
      reason: LIFECYCLE_REASON,
      poweredOffAt,
    });
    // The provider's term lapses two weeks inside the retention month.
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, {
      service_ends_at: "2027-02-20",
    });

    c.set(poweredOffAt + 1000);
    const summary = await lifecycleTick(store, c.now());
    expect(summary).toMatchObject({ raised: 1, opened: 0, finished: 0 });
    const open = await store.openReasons("inst-1");
    expect(open[0].severity).toBe("critical");
    expect(open[0].reason).toContain("BEFORE the retention deadline");
    // The promise is NOT shortened: deprovision is still due on OUR date.
    expect((await store.getInstance("inst-1"))!.service_state).not.toBe(
      "deprovisioned",
    );
    await store.close();
  });

  test("an asset that goes early records the data end AND raises the break", async () => {
    const c = clock(ENDED + 86_400_000);
    const store = await tempStore(c.now);
    await seed(store);
    // The provider ends the asset during the grace week, weeks before the
    // deadline the customer was promised.
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, { asset_state: "cancelled" });

    const summary = await lifecycleTick(store, c.now());
    expect(summary).toMatchObject({ finished: 1, raised: 1 });
    expect((await store.getInstance("inst-1"))!.service_state).toBe(
      "deprovisioned",
    );
    const open = await store.openReasons("inst-1");
    expect(open[0].severity).toBe("critical");
    expect(open[0].reason).toContain("BEFORE the");
    expect(
      (await store.auditEvents()).filter((e) => e.action === "data_end"),
    ).toHaveLength(1);
    await store.close();
  });

  test("a broken promise is ONE row and ONE audit, however many ticks run", async () => {
    const c = clock(ENDED + 86_400_000);
    const store = await tempStore(c.now);
    await seed(store);
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, { asset_state: "cancelled" });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    // Two more passes, days apart. A reason carrying the observation time would
    // open a fresh critical row each time.
    c.set(ENDED + 3 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    c.set(ENDED + 9 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });

    expect(await store.openReasons("inst-1")).toHaveLength(1);
    expect(
      (await store.auditEvents()).filter((e) => e.action === "raise_attention"),
    ).toHaveLength(1);
    await store.close();
  });

  test("a RENEWED term clears the risk; a broken promise is never cleared", async () => {
    const c = clock(ENDED + 1000);
    const store = await tempStore(c.now);
    await seed(store);
    const asset = (await store.assetForInstance("inst-1"))!;
    // Unsafe: the term lapses inside the promised month.
    await store.casAsset(asset.id, asset.version, {
      service_ends_at: "2027-02-20",
    });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    expect(await store.openReasons("inst-1")).toHaveLength(1);

    // Still unsafe: the same condition, not a second one.
    c.set(ENDED + 2000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    expect(await store.openReasons("inst-1")).toHaveLength(1);

    // Renewed, and now safe. The incident must go, with its audit - one that
    // survived the fix is indistinguishable from one nobody dealt with.
    const fresh = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(fresh.id, fresh.version, {
      service_ends_at: "2027-08-29",
    });
    c.set(ENDED + 3000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ cleared: 1 });
    expect(await store.openReasons("inst-1")).toHaveLength(0);
    expect(
      (await store.auditEvents()).some((e) => e.action === "clear_attention"),
    ).toBe(true);

    // And the irreversible one is NOT clearable: break the promise for real,
    // then keep ticking.
    const gone = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(gone.id, gone.version, {
      asset_state: "cancelled",
      service_ends_at: "2027-02-01",
    });
    c.set(ENDED + 4000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    c.set(ENDED + 5000);
    await lifecycleTick(store, c.now());
    expect(await store.openReasons("inst-1")).toHaveLength(1);
    await store.close();
  });

  test("PROMOTION: unsafe -> broken clears the risk and raises broken, in one tick", async () => {
    // No safe renewal in between. The at-risk row said "renew the term or the
    // promise breaks"; once it HAS broken, leaving that instruction on the ops
    // floor beside the incident that superseded it is the defect.
    const c = clock(ENDED + 1000);
    const store = await tempStore(c.now);
    await seed(store);
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, {
      service_ends_at: "2027-02-20",
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    c.set(ENDED + 2000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    expect(await store.openReasons("inst-1")).toHaveLength(1);
    expect((await store.openReasons("inst-1"))[0].source_op_id).toBe(
      PROMISE_AT_RISK,
    );

    // The term lapses for real, with the SAME early date.
    const fresh = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(fresh.id, fresh.version, { asset_state: "cancelled" });
    c.set(ENDED + 3000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 1,
      cleared: 1,
    });
    const open = await store.openReasons("inst-1");
    expect(open).toHaveLength(1);
    expect(open[0].source_op_id).toBe(PROMISE_BROKEN);

    // The PROMOTION's own audit row carries the dated evidence too, not only
    // the first raise: this is the record of what the term said at the moment
    // the promise actually broke.
    const promoted = (await store.auditEvents())
      .filter((e) => e.action === "raise_attention")
      .pop()!;
    expect(promoted.detail).toContain("service_ends_at=2027-02-20");
    expect(promoted.detail).toContain(
      `promisedUntil=${new Date(addUtcMonth(ENDED + GRACE_MS)).toISOString()}`,
    );
    expect(promoted.detail).toContain(
      `observed=${new Date(ENDED + 3000).toISOString()}`,
    );

    // And it settles: later ticks do nothing at all.
    c.set(ENDED + 4000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 0,
    });
    expect(await store.openReasons("inst-1")).toHaveLength(1);
    await store.close();
  });

  test("the DATED evidence survives a provider row that later moves", async () => {
    // The identity deliberately carries no date, so the incident would be
    // unreconstructable unless the instants are written somewhere append-only.
    const c = clock(ENDED + 1000);
    const store = await tempStore(c.now);
    await seed(store);
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, {
      service_ends_at: "2027-02-20",
    });
    await lifecycleTick(store, c.now());

    // The asset row moves afterwards - a renewal, or simply a later reconcile.
    const fresh = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(fresh.id, fresh.version, {
      service_ends_at: "2027-09-30",
    });

    const raised = (await store.auditEvents()).filter(
      (e) => e.action === "raise_attention",
    );
    expect(raised).toHaveLength(1);
    // BOTH exact instants, after the row that held one of them changed.
    expect(raised[0].detail).toContain("service_ends_at=2027-02-20");
    expect(raised[0].detail).toContain(
      `promisedUntil=${new Date(addUtcMonth(ENDED + GRACE_MS)).toISOString()}`,
    );
    expect(raised[0].detail).toContain(
      `observed=${new Date(ENDED + 1000).toISOString()}`,
    );
    // And none of it leaked into the dedup identity.
    expect((await store.openReasons("inst-1"))[0].reason).not.toContain(
      "2027-02-20",
    );
    await store.close();
  });

  test("an office with no ended_at is never even examined", async () => {
    const c = clock(GRACE_END);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: null });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ examined: 0 });
    await store.close();
  });

  test("a per-subscription transaction failure is counted and reported", async () => {
    const c = clock(GRACE_END);
    const store = await tempStore(c.now);
    await seed(store);
    const lines: string[] = [];
    store.tx = async () => {
      throw new Error("transaction denied");
    };
    const result = await lifecycleTick(store, c.now(), (line) =>
      lines.push(line),
    );
    expect(result.failed).toBe(1);
    expect(lines).toEqual(["lifecycle sub_1 failed: transaction denied"]);
    await store.close();
  });
});
