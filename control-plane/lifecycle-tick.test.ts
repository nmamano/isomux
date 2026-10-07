// The cancellation timeline walked end to end on SEEDED DATES. No clock moves
// here except the one the test hands the store.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addUtcMonth,
  assetGoneAction,
  CUSTOMER_CANCELLATION_REASON,
  GONE_STATES,
  GRACE_MS,
  LIFECYCLE_ASSET_GONE,
  LIFECYCLE_REASON,
  lifecycleOperationId,
  phaseAt,
  PROMISE_AT_RISK,
  PROMISE_BROKEN,
  RETENTION_MS,
} from "./lifecycle.ts";
import { lifecycleTick, resolveBrokenPromise } from "./lifecycle-tick.ts";
import { raiseAttentionIn } from "./attention.ts";
import { CERTIFICATE_CONTACT_REASON } from "./certificate-credentials.ts";
import { LIVENESS_REASON } from "./liveness-watch.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import { RemoteBudget, Ticker } from "./tick.ts";
import { removeDnsHandler } from "./deprovision.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { powerOffHandler } from "./stripe/suspension.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

const ENDED = Date.parse("2027-01-31T09:00:00Z");
const GRACE_END = ENDED + GRACE_MS; // 2027-02-07T09:00:00Z

async function tempStore(now: () => number): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-lifetick-"));
  temps.push(dir);
  return await openTestStore(now);
}

async function pending(store: Store, now: number): Promise<boolean> {
  const schedule = await store.workSchedule(now, GRACE_MS, RETENTION_MS, {
    providerConfigured: true,
    provisioningConfigured: true,
    checkoutConfigured: true,
    cadenceConfigured: true,
    livenessConfigured: false,
    staleProvisioningMs: 30 * 60_000,
    staleProvisioningReason: "stalled",
  });
  return schedule.tickDue || schedule.cadenceDue;
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

async function setAssetState(
  store: Store,
  assetState: "active" | "cancelled" | "absent",
): Promise<void> {
  const asset = (await store.getAsset("asset-1"))!;
  await store.casAsset(asset.id, asset.version, { asset_state: assetState });
}

async function seedAssetGoneAttention(store: Store): Promise<void> {
  await store.tx(() =>
    raiseAttentionIn(store, {
      instanceId: "inst-1",
      reasonClass: "operation_condition",
      sourceOpId: LIFECYCLE_ASSET_GONE,
      reason: "pre-existing provider asset disappearance",
      severity: "critical",
    }),
  );
}

async function raiseLiveness(store: Store): Promise<void> {
  await store.tx(() =>
    raiseAttentionIn(store, {
      instanceId: "inst-1",
      reasonClass: "operation_condition",
      reason: LIVENESS_REASON,
      severity: "critical",
    }),
  );
  // The precondition every clear test depends on: the alarm is open before
  // the tick under test runs.
  expect(await openLivenessCount(store)).toBe(1);
}

async function openLivenessCount(store: Store): Promise<number> {
  return (await store.openReasons("inst-1")).filter(
    (row) => row.source_op_id === "" && row.reason === LIVENESS_REASON,
  ).length;
}

async function openAttentionKeys(store: Store): Promise<string[]> {
  return (await store.openReasons("inst-1"))
    .map((row) => row.source_op_id)
    .sort();
}

test("the wake probe sees lifecycle work before it creates an operation", async () => {
  const c = clock(GRACE_END);
  const store = await tempStore(c.now);
  await seed(store);
  const asset = (await store.getAsset("asset-1"))!;
  await store.casAsset(asset.id, asset.version, {
    next_reconcile_at: GRACE_END + 60_000,
  });
  expect(await store.operationsFor("inst-1")).toEqual([]);
  expect(await pending(store, c.now())).toBe(true);
});

test("the wake probe recognizes the lifecycle operation's real derived id", async () => {
  const c = clock(GRACE_END);
  const store = await tempStore(c.now);
  await seed(store);
  const asset = (await store.getAsset("asset-1"))!;
  await store.casAsset(asset.id, asset.version, {
    next_reconcile_at: GRACE_END + 60_000,
  });
  expect(await pending(store, c.now())).toBe(true);
  await lifecycleTick(store, c.now());
  const id = lifecycleOperationId("power_off", "sub_1", ENDED);
  await store.sqlRun("update operations set status = 'failed' where id = $1", [
    id,
  ]);
  expect(await pending(store, c.now())).toBe(false);
});

describe("the walk, on seeded dates", () => {
  test("the cancellation scan raises for each gone provider state", async () => {
    expect([...GONE_STATES].sort()).toEqual(["absent", "cancelled"]);
    for (const assetState of GONE_STATES) {
      const c = clock(ENDED - 1);
      const store = await tempStore(c.now);
      await seed(store, {
        endedAt: null,
        reason: CUSTOMER_CANCELLATION_REASON,
      });
      await setAssetState(store, assetState as "cancelled" | "absent");

      expect(await lifecycleTick(store, c.now())).toMatchObject({
        examined: 1,
        raised: 1,
        finished: 0,
      });
      expect(await openAttentionKeys(store)).toEqual([LIFECYCLE_ASSET_GONE]);
      expect((await store.getInstance("inst-1"))!.service_state).toBe("live");
      await store.close();
    }
  });

  test("a settled office clears a pre-existing asset disappearance", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await setAssetState(store, "absent");
    await seedAssetGoneAttention(store);
    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 1,
    });
    expect(await openAttentionKeys(store)).not.toContain(LIFECYCLE_ASSET_GONE);
    await store.close();
  });

  test("a present active asset clears a pre-existing disappearance", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await seedAssetGoneAttention(store);

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 1,
    });
    expect(await openAttentionKeys(store)).not.toContain(LIFECYCLE_ASSET_GONE);
    await store.close();
  });

  test("a missing asset row does not raise a disappearance", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await store.sqlRun("delete from provider_assets where id = 'asset-1'");

    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    expect(await openAttentionKeys(store)).not.toContain(LIFECYCLE_ASSET_GONE);
    await store.close();
  });

  test("stray lifecycle work and a gone asset raise both conditions", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await setAssetState(store, "absent");
    await store.enqueue({
      id: "op-stray-lifecycle",
      instance_id: "inst-1",
      kind: "power_off",
      inactivity_deadline_at: c.now() + 60_000,
      absolute_deadline_at: c.now() + 60_000,
      evidence: { reason: LIFECYCLE_REASON },
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    expect(await openAttentionKeys(store)).toEqual([
      LIFECYCLE_ASSET_GONE,
      "lifecycle-stray-rows",
    ]);
    await store.close();
  });

  test("the stray exit also clears a resolved asset disappearance", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await seedAssetGoneAttention(store);
    await store.enqueue({
      id: "op-stray-lifecycle",
      instance_id: "inst-1",
      kind: "power_off",
      inactivity_deadline_at: c.now() + 60_000,
      absolute_deadline_at: c.now() + 60_000,
      evidence: { reason: LIFECYCLE_REASON },
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 1,
      cleared: 1,
    });
    expect(await openAttentionKeys(store)).toEqual(["lifecycle-stray-rows"]);
    await store.close();
  });

  test("terminal completion clears the non-terminal disappearance", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await setAssetState(store, "absent");
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });

    await store.sqlRun(
      "update subscriptions set ended_at = $1, status = 'canceled' where id = 'sub_1'",
      [ENDED],
    );
    c.set(ENDED);
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      finished: 1,
      cleared: 1,
    });
    expect(await openAttentionKeys(store)).not.toContain(LIFECYCLE_ASSET_GONE);
    await store.close();
  });

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
    await store.tx(async () => {
      await raiseAttentionIn(store, {
        instanceId: "inst-1",
        reasonClass: "operation_condition",
        reason: LIVENESS_REASON,
        severity: "critical",
      });
      await raiseAttentionIn(store, {
        instanceId: "inst-1",
        reasonClass: "operation_condition",
        reason: CERTIFICATE_CONTACT_REASON,
        severity: "warning",
      });
    });
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, { asset_state: "cancelled" });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ finished: 1 });
    expect((await store.getInstance("inst-1"))!.service_state).toBe(
      "deprovisioned",
    );
    expect(await store.getInstance("inst-1")).toMatchObject({
      goal: "live",
      attention_state: "needs_operator",
      attention_reason: CERTIFICATE_CONTACT_REASON,
    });
    const open = await store.openReasons("inst-1");
    expect(open.map((reason) => reason.reason)).toEqual([
      CERTIFICATE_CONTACT_REASON,
    ]);
    expect(
      (await store.auditEvents()).filter((e) => e.action === "data_end"),
    ).toHaveLength(1);
    // Recorded once, not on every pass afterwards.
    expect(await lifecycleTick(store, c.now())).toMatchObject({ finished: 0 });
    // The data end asks for DNS removal under the id deprovision_due already
    // used, so the scheduled path keeps exactly one row.
    expect(
      (await store.operationsFor("inst-1")).filter(
        (op) => op.kind === "remove_dns",
      ),
    ).toHaveLength(1);
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

  test("a liveness alarm stays open while the provider asset is present", async () => {
    const c = clock(GRACE_END + RETENTION_MS);
    const store = await tempStore(c.now);
    await seed(store);
    await store.tx(() =>
      raiseAttentionIn(store, {
        instanceId: "inst-1",
        reasonClass: "operation_condition",
        reason: LIVENESS_REASON,
        severity: "critical",
      }),
    );

    await lifecycleTick(store, c.now());

    expect(await store.getInstance("inst-1")).toMatchObject({
      service_state: "live",
      attention_state: "needs_operator",
      attention_reason: LIVENESS_REASON,
    });
    expect(
      (await store.openReasons("inst-1")).map((row) => row.reason),
    ).toEqual([LIVENESS_REASON]);
    await store.close();
  });

  test("an asset that ends before deprovision_due still gets its DNS removed", async () => {
    // The early end: the provider asset is gone the day after the period end,
    // long before the day-14 deletion that would have opened remove_dns.
    const c = clock(ENDED + 86_400_000);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await setAssetState(store, "absent");
    await raiseLiveness(store);

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      opened: 1,
      finished: 1,
    });
    const removeDnsId = lifecycleOperationId("remove_dns", "sub_1", ENDED);
    expect(await store.getOperation(removeDnsId)).toMatchObject({
      kind: "remove_dns",
      status: "pending",
    });
    expect(await openLivenessCount(store)).toBe(0);

    // Every later pass sees the same ended phase and opens nothing more.
    c.set(ENDED + 30 * 86_400_000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    expect((await store.operationsFor("inst-1")).map((op) => op.id)).toEqual([
      removeDnsId,
    ]);
    await store.close();
  });

  test("an office that ended without DNS removal gets it, and its liveness clear, on the next pass", async () => {
    // The stored state the early end left behind before this fix: data end
    // recorded, no remove_dns row, the liveness alarm still open.
    const c = clock(ENDED + 3 * 86_400_000);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await setAssetState(store, "absent");
    await raiseLiveness(store);
    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      opened: 1,
      finished: 0,
    });
    expect(
      await store.getOperation(
        lifecycleOperationId("remove_dns", "sub_1", ENDED),
      ),
    ).toMatchObject({ kind: "remove_dns" });
    expect(await openLivenessCount(store)).toBe(0);
    expect(
      (await store.auditEvents()).filter((e) => e.action === "data_end"),
    ).toHaveLength(0);
    await store.close();
  });

  test("a deprovisioned office on a subscription that is not terminal clears liveness and opens nothing", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null });
    await setAssetState(store, "absent");
    await raiseLiveness(store);
    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ opened: 0 });
    expect(await openLivenessCount(store)).toBe(0);
    expect(await store.operationsFor("inst-1")).toEqual([]);
    await store.close();
  });

  test("the opened remove_dns runs on a deprovisioned office", async () => {
    const c = clock(ENDED + 86_400_000);
    const store = await tempStore(c.now);
    await seed(store, { policy: "launch" });
    await setAssetState(store, "absent");
    await lifecycleTick(store, c.now());
    expect((await store.getInstance("inst-1"))!.service_state).toBe(
      "deprovisioned",
    );

    const calls: string[] = [];
    const ticker = new Ticker({
      store,
      now: c.now,
      handlers: [
        removeDnsHandler({
          officeDns: {
            officeARecords: async () => [],
            replaceOfficeARecords: async () => {
              throw new Error("remove_dns must not write a record");
            },
            removeOfficeARecords: async (host) => {
              calls.push(host);
              return true;
            },
          },
        }),
      ],
    });
    await ticker.once();
    expect(calls).toEqual(["cp2.test.isomux.app"]);
    expect(
      await store.getOperation(
        lifecycleOperationId("remove_dns", "sub_1", ENDED),
      ),
    ).toMatchObject({ status: "succeeded" });
    await store.close();
  });

  test("a terminal cancellation with no asset row does not deprovision", async () => {
    const c = clock(GRACE_END + RETENTION_MS);
    const store = await tempStore(c.now);
    await seed(store);
    await store.sqlRun("delete from provider_assets where instance_id = $1", [
      "inst-1",
    ]);

    expect(await lifecycleTick(store, c.now())).toMatchObject({ finished: 0 });
    expect((await store.getInstance("inst-1"))!.service_state).toBe("live");
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
    await store.casAsset(asset.id, asset.version, {
      asset_state: "cancelled",
      next_reconcile_at: c.now() + 60_000,
    });
    expect(await pending(store, c.now())).toBe(true);

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
    // The DNS removal the data end opened is the only work left, and once it
    // concludes the loop has nothing due.
    expect(await pending(store, c.now())).toBe(true);
    await succeed(store, lifecycleOperationId("remove_dns", "sub_1", ENDED), {
      reason: LIFECYCLE_REASON,
      removed: true,
    });
    expect(await pending(store, c.now())).toBe(false);
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

describe("the never-cancelled scan", () => {
  async function seedNeverCancelled(store: Store): Promise<void> {
    await seed(store, { endedAt: null, reason: null });
  }

  async function assetGoneRows(store: Store) {
    return (
      await store.sqlAll<{ id: string; cleared_at: number | null }>(
        "select id, cleared_at from attention_reasons " +
          "where instance_id = 'inst-1' and source_op_id = $1 order by raised_at, id",
        [LIFECYCLE_ASSET_GONE],
      )
    ).map((r) => ({ id: r.id, open: r.cleared_at === null }));
  }

  test("a gone asset raises the cancellation arm's row, once, for each gone state", async () => {
    for (const assetState of GONE_STATES) {
      const c = clock(ENDED - 1);
      const store = await tempStore(c.now);
      await seedNeverCancelled(store);
      await setAssetState(store, assetState as "cancelled" | "absent");

      expect(await lifecycleTick(store, c.now())).toMatchObject({
        examined: 0,
        raised: 1,
        failed: 0,
      });
      expect(await lifecycleTick(store, c.now())).toMatchObject({
        raised: 0,
        cleared: 0,
      });
      const open = await store.openReasons("inst-1");
      expect(open).toHaveLength(1);
      // The same identity the cancellation arm raises, so the two paths share
      // one row.
      const instance = (await store.getInstance("inst-1"))!;
      const arm = assetGoneAction(
        instance,
        await store.assetForInstance("inst-1"),
      );
      expect(arm.kind).toBe("raise");
      expect(open[0].source_op_id).toBe(LIFECYCLE_ASSET_GONE);
      expect(open[0].reason).toBe(arm.kind === "raise" ? arm.reason : "");
      expect(open[0].severity).toBe("critical");
      expect(instance.service_state).toBe("live");
      expect(await store.operationsFor("inst-1")).toEqual([]);
      await store.close();
    }
  });

  test("a deprovisioned office raises nothing", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await setAssetState(store, "absent");
    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });

    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    expect(await store.openReasons("inst-1")).toEqual([]);
    await store.close();
  });

  test("an active asset raises nothing", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 0,
    });
    expect(await store.openReasons("inst-1")).toEqual([]);
    await store.close();
  });

  test("the asset coming back clears only that row; a later loss raises a new one", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await raiseLiveness(store);
    await setAssetState(store, "absent");
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });

    await setAssetState(store, "active");
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 1,
    });
    expect(await openAttentionKeys(store)).toEqual([""]);
    expect(await openLivenessCount(store)).toBe(1);
    expect(
      (await store.auditEvents()).filter(
        (e) => e.action === "clear_attention",
      ),
    ).toHaveLength(1);

    await setAssetState(store, "cancelled");
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    expect((await assetGoneRows(store)).map((r) => r.open)).toEqual([
      false,
      true,
    ]);
    await store.close();
  });

  test("deprovisioning clears the row", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await setAssetState(store, "absent");
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });

    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });
    expect(await lifecycleTick(store, c.now())).toMatchObject({ cleared: 1 });
    expect(await store.openReasons("inst-1")).toEqual([]);
    // Nothing reopens it while the office stays deprovisioned.
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      cleared: 0,
    });
    await store.close();
  });

  test("a cancellation marker hands the same row to the cancellation arm", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await setAssetState(store, "absent");
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    const [before] = await assetGoneRows(store);

    // Cancelled but not terminal: decideLifecycle now owns the subscription.
    await store.sqlRun(
      "update subscriptions set cancellation_reason = $1 where id = 'sub_1'",
      [CUSTOMER_CANCELLATION_REASON],
    );
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      examined: 1,
      raised: 0,
      cleared: 0,
    });
    expect(await assetGoneRows(store)).toEqual([before]);

    // And the arm clears the row the scan raised.
    await setAssetState(store, "active");
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      examined: 1,
      cleared: 1,
    });
    expect(await assetGoneRows(store)).toEqual([
      { id: before.id, open: false },
    ]);
    await store.close();
  });

  test("eligibility is re-read inside the transaction", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await setAssetState(store, "absent");
    // A webhook records a cancellation between the scan and the write.
    const tx = store.tx.bind(store);
    store.tx = (async (fn: () => Promise<unknown>) => {
      await store.sqlRun(
        "update subscriptions set cancellation_reason = $1 where id = 'sub_1'",
        [CUSTOMER_CANCELLATION_REASON],
      );
      return tx(fn);
    }) as Store["tx"];

    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 0,
      failed: 0,
    });
    expect(await store.openReasons("inst-1")).toEqual([]);
    await store.close();
  });

  test("a failing transaction is counted and reported", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seedNeverCancelled(store);
    await setAssetState(store, "absent");
    const lines: string[] = [];
    store.tx = async () => {
      throw new Error("transaction denied");
    };
    expect(
      await lifecycleTick(store, c.now(), (line) => lines.push(line)),
    ).toMatchObject({ raised: 0, failed: 1 });
    expect(lines).toEqual(["lifecycle sub_1 failed: transaction denied"]);
    await store.close();
  });
});

describe("the scheduler sees asset-gone work", () => {
  async function schedule(store: Store, now: number) {
    return store.workSchedule(now, GRACE_MS, RETENTION_MS, {
      providerConfigured: true,
      provisioningConfigured: true,
      checkoutConfigured: true,
      cadenceConfigured: true,
      livenessConfigured: false,
      staleProvisioningMs: 30 * 60_000,
      staleProvisioningReason: "stalled",
    });
  }

  /** What the drive loop does: run the cadence only when it is due. */
  async function drivenPass(store: Store, now: number) {
    const due = await schedule(store, now);
    return due.cadenceDue ? lifecycleTick(store, now) : null;
  }

  /** An office past startup: its next provider reconcile is in the future, so
   * nothing but the cadence can notice a change. */
  async function settled(store: Store, now: number) {
    const asset = (await store.getAsset("asset-1"))!;
    await store.casAsset(asset.id, asset.version, {
      next_reconcile_at: now + 3600_000,
    });
    expect(await schedule(store, now)).toMatchObject({
      tickDue: false,
      cadenceDue: false,
    });
  }

  for (const [label, endedAt, reason] of [
    ["a never-cancelled", null, null],
    ["a cancelled but not ended", null, CUSTOMER_CANCELLATION_REASON],
    // Ended, but not a customer cancellation: decideLifecycle's non-terminal
    // arm owns it, and a NULL reason must not drop it from the schedule.
    ["an ended, reasonless", ENDED, null],
  ] as const) {
    test(`${label} office: loss, recovery, and idle once handled`, async () => {
      const c = clock(ENDED + 1);
      const store = await tempStore(c.now);
      await seed(store, { endedAt, reason });
      const sub = (await store.sqlGet<{
        ended_at: number | null;
        cancellation_reason: string | null;
      }>("select ended_at, cancellation_reason from subscriptions"))!;
      expect([sub.ended_at, sub.cancellation_reason]).toEqual([
        endedAt,
        reason,
      ]);
      await settled(store, c.now());

      await setAssetState(store, "absent");
      expect(await schedule(store, c.now())).toMatchObject({
        tickDue: false,
        cadenceDue: true,
      });
      expect(await drivenPass(store, c.now())).toMatchObject({ raised: 1 });
      expect(await openAttentionKeys(store)).toEqual([LIFECYCLE_ASSET_GONE]);
      expect((await schedule(store, c.now())).cadenceDue).toBe(false);

      await setAssetState(store, "active");
      expect((await schedule(store, c.now())).cadenceDue).toBe(true);
      expect(await drivenPass(store, c.now())).toMatchObject({ cleared: 1 });
      expect(await openAttentionKeys(store)).toEqual([]);
      expect((await schedule(store, c.now())).cadenceDue).toBe(false);
      await store.close();
    });
  }

  test("an open row with the key but another sentence leaves the raise due", async () => {
    // raiseAttentionIn dedups on the whole identity, so the pass raises here,
    // and the schedule has to agree.
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: null });
    await settled(store, c.now());
    await setAssetState(store, "absent");
    await seedAssetGoneAttention(store);
    const instance = (await store.getInstance("inst-1"))!;
    const arm = assetGoneAction(
      instance,
      await store.assetForInstance("inst-1"),
    );
    const [other] = await store.openReasons("inst-1");
    expect(arm.kind).toBe("raise");
    expect(other.source_op_id).toBe(LIFECYCLE_ASSET_GONE);
    expect(other.reason).not.toBe(arm.kind === "raise" ? arm.reason : "");

    expect((await schedule(store, c.now())).cadenceDue).toBe(true);
    expect(await drivenPass(store, c.now())).toMatchObject({ raised: 1 });
    expect((await schedule(store, c.now())).cadenceDue).toBe(false);
    await store.close();
  });

  test("deprovisioning makes the clear due, and then it goes idle", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: null });
    await settled(store, c.now());
    await setAssetState(store, "absent");
    expect(await drivenPass(store, c.now())).toMatchObject({ raised: 1 });

    const instance = (await store.getInstance("inst-1"))!;
    await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });
    expect((await schedule(store, c.now())).cadenceDue).toBe(true);
    expect(await drivenPass(store, c.now())).toMatchObject({ cleared: 1 });
    expect((await schedule(store, c.now())).cadenceDue).toBe(false);
    await store.close();
  });

  test("a newer gone asset behind an active oldest one is not due", async () => {
    // assetForInstance reads the oldest asset, so the pass would do nothing:
    // being due here would spin the cadence for nothing.
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store, { endedAt: null, reason: null });
    await settled(store, c.now());
    c.set(ENDED);
    await store.createAsset({
      id: "asset-2",
      instance_id: "inst-1",
      provider: "contabo",
      provider_id: "203474836",
      intent_id: null,
      asset_state: "absent",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now() + 3600_000,
    });
    expect((await schedule(store, c.now())).cadenceDue).toBe(false);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 0 });
    await store.close();
  });
});

describe("resolving a broken promise", () => {
  /** A legacy cancellation whose asset ended before the promised date. */
  async function breakPromise(store: Store, c: ReturnType<typeof clock>) {
    await seed(store);
    const asset = (await store.assetForInstance("inst-1"))!;
    await store.casAsset(asset.id, asset.version, {
      asset_state: "cancelled",
      service_ends_at: "2027-02-01",
    });
    c.set(ENDED + 1000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({ raised: 1 });
    expect(await openAttentionKeys(store)).toEqual([PROMISE_BROKEN]);
  }

  test("a resolved broken promise stays resolved across ticks", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await breakPromise(store, c);
    const [broken] = await store.openReasons("inst-1");

    expect(await resolveBrokenPromise(store, "inst-1", "nil")).toBe(1);
    expect(await store.openReasons("inst-1")).toEqual([]);
    expect((await store.getInstance("inst-1"))!.attention_state).toBe("clear");
    const audit = (await store.auditEvents()).filter(
      (e) => e.action === "resolve_attention",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "nil",
      instance_id: "inst-1",
      target: broken.id,
      outcome: "succeeded",
    });

    for (const t of [ENDED + 2000, ENDED + 3000]) {
      c.set(t);
      expect(await lifecycleTick(store, c.now())).toMatchObject({
        raised: 0,
        failed: 0,
      });
    }
    expect(await store.openReasons("inst-1")).toEqual([]);
    await store.close();
  });

  test("a different promised date raises a new row", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await breakPromise(store, c);
    const [first] = await store.openReasons("inst-1");
    await resolveBrokenPromise(store, "inst-1", "nil");

    // Another anchor is another promise. The first one's DNS removal has
    // finished, so the new anchor's own remove_dns can open.
    await succeed(store, lifecycleOperationId("remove_dns", "sub_1", ENDED), {});
    await store.sqlRun("update subscriptions set ended_at = $1", [
      ENDED + 24 * 3600_000,
    ]);
    c.set(ENDED + 2000);
    expect(await lifecycleTick(store, c.now())).toMatchObject({
      raised: 1,
      failed: 0,
    });
    const open = await store.openReasons("inst-1");
    expect(open).toHaveLength(1);
    expect(open[0].source_op_id).toBe(PROMISE_BROKEN);
    expect(open[0].reason).not.toBe(first.reason);
    await store.close();
  });

  test("a resolve leaves every other reason open", async () => {
    const c = clock(ENDED);
    const store = await tempStore(c.now);
    await breakPromise(store, c);
    await raiseLiveness(store);
    await store.tx(() =>
      raiseAttentionIn(store, {
        instanceId: "inst-1",
        reasonClass: "operation_condition",
        sourceOpId: PROMISE_AT_RISK,
        reason: "unrelated at-risk row",
        severity: "warning",
      }),
    );

    expect(await resolveBrokenPromise(store, "inst-1", "nil")).toBe(1);
    expect(await openAttentionKeys(store)).toEqual(["", PROMISE_AT_RISK]);
    expect((await store.getInstance("inst-1"))!.attention_state).toBe(
      "needs_operator",
    );
    await store.close();
  });

  // The CLI never closes its store, so the process exits only after the pool's
  // idle timeout: about 11 s, measured 2026-10-07.
  test("the operator CLI resolves it and lists what stays open", async () => {
    const c = clock(ENDED);
    const dsn = await testDsn();
    const store = await openTestStoreOn(dsn, c.now);
    await breakPromise(store, c);
    await raiseLiveness(store);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-resolve-cli-"));
    temps.push(home);

    const cli = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "cli.ts"),
        "attention",
        "--resolve",
        "inst-1",
        "--by",
        "nil",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NODE_ENV: "test",
          CONTROL_PLANE_DB: dsn,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    // One line for the resolve, then the listing: only the liveness row.
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("1");
    expect(lines[0]).toContain("inst-1");
    expect(lines[1]).toContain(LIVENESS_REASON);
    expect(await openAttentionKeys(store)).toEqual([""]);
    expect(
      (await store.auditEvents()).filter(
        (e) => e.action === "resolve_attention" && e.actor === "nil",
      ),
    ).toHaveLength(1);
  }, 30_000);

  test("an office with no broken promise resolves nothing", async () => {
    const c = clock(ENDED - 1);
    const store = await tempStore(c.now);
    await seed(store);
    await raiseLiveness(store);
    expect(await resolveBrokenPromise(store, "inst-1", "nil")).toBe(0);
    expect(await openLivenessCount(store)).toBe(1);
    expect(
      (await store.auditEvents()).some((e) => e.action === "resolve_attention"),
    ).toBe(false);
    await store.close();
  });
});
