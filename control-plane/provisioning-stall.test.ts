import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "./store.ts";
import {
  PROVISIONING_STALL_MS,
  PROVISIONING_STALL_REASON,
  sweepProvisioningStalls,
} from "./provisioning-stall.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

async function fixture() {
  let now = 1_000_000;
  const store = await openTestStore(() => now);
  await store.createInstance({
    id: "inst-stalled",
    run_id: null,
    name: "stalled.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: null,
  });
  return {
    store,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function schedule(store: Store, now: number) {
  return store.workSchedule(now, 0, 0, {
    providerConfigured: false,
    provisioningConfigured: false,
    checkoutConfigured: false,
    cadenceConfigured: true,
    livenessConfigured: false,
    staleProvisioningMs: PROVISIONING_STALL_MS,
    staleProvisioningReason: PROVISIONING_STALL_REASON,
  });
}

describe("silent provisioning stalls", () => {
  test("raise once after 30 minutes and clear when any operation exists", async () => {
    const f = await fixture();
    expect(await sweepProvisioningStalls(f.store)).toBe(0);
    expect((await f.store.getInstance("inst-stalled"))?.attention_state).toBe(
      "clear",
    );

    f.advance(PROVISIONING_STALL_MS + 1);
    expect((await schedule(f.store, f.now())).cadenceDue).toBe(true);
    expect(await sweepProvisioningStalls(f.store)).toBe(1);
    const raised = await f.store.openReasons("inst-stalled");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      source_op_id: "",
      reason: PROVISIONING_STALL_REASON,
      severity: "critical",
    });
    expect(await sweepProvisioningStalls(f.store)).toBe(0);
    expect((await schedule(f.store, f.now())).cadenceDue).toBe(false);

    await f.store.enqueue({
      id: "op-ended",
      instance_id: "inst-stalled",
      kind: "create_instance",
      inactivity_deadline_at: f.now() + 1,
      absolute_deadline_at: f.now() + 2,
    });
    await f.store.sqlRun(
      "update operations set status = 'failed' where id = 'op-ended'",
    );
    expect((await schedule(f.store, f.now())).cadenceDue).toBe(true);
    expect(await sweepProvisioningStalls(f.store)).toBe(1);
    expect(await f.store.openReasons("inst-stalled")).toEqual([]);
    expect((await f.store.getInstance("inst-stalled"))?.attention_state).toBe(
      "clear",
    );
  });
});
