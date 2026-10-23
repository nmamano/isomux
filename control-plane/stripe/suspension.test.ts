// The suspension handler, against a stubbed provider. No real box is touched by
// anything in this slice, and nothing here reaches a provider API.

import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import { RemoteBudget, Ticker } from "../tick.ts";
import { deadlinesFor } from "../operations.ts";
import { powerOffHandler } from "./suspension.ts";

const NOW = 1_770_000_000_000;

async function tempStore(): Promise<Store> {
  return await openTestStore(() => NOW);
}

async function seed(store: Store, withAsset = true): Promise<string> {
  await store.createInstance({
    id: "inst-1",
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "handed_off",
    access_window_expires_at: null,
  });
  if (withAsset) {
    await store.tx(
      async () =>
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
          next_reconcile_at: NOW + 60_000,
        }),
    );
  }
  return "inst-1";
}

async function context(store: Store, opId: string) {
  const op = (await store.getOperation(opId))!;
  const leased = (await store.tryLease(
    opId,
    op.version,
    "holder-1",
    NOW + 300_000,
    NOW,
  ))!;
  const audits: string[] = [];
  return {
    audits,
    ctx: {
      store,
      op: leased,
      instance: (await store.getInstance("inst-1"))!,
      asset: await store.assetForInstance("inst-1"),
      fence: { id: opId, version: leased.version, holder: "holder-1" },
      budget: new RemoteBudget(NOW + 60_000, NOW + 300_000, () => NOW),
      now: NOW,
      report: () => {},
      audit: (action: string, outcome: string, detail?: string) => {
        audits.push(`${action}:${outcome}${detail ? `:${detail}` : ""}`);
        return Promise.resolve();
      },
    },
  };
}

async function enqueuePowerOff(store: Store, id = "op-power_off-dun-1") {
  const d = deadlinesFor("power_off");
  return await store.enqueue({
    id,
    instance_id: "inst-1",
    kind: "power_off",
    inactivity_deadline_at: NOW + d.inactivityMs,
    absolute_deadline_at: NOW + d.absoluteMs,
  });
}

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

describe("the handler", () => {
  test("calls the provider once and reports done", async () => {
    const store = await tempStore();
    await seed(store);
    await enqueuePowerOff(store);
    const called: string[] = [];
    const handler = powerOffHandler({
      powerOff: async (providerId) => {
        called.push(providerId);
      },
    });
    const { ctx, audits } = await context(store, "op-power_off-dun-1");
    const result = await handler.run(ctx);
    expect(called).toEqual(["203474835"]);
    expect(result).toMatchObject({ kind: "done" });
    expect(audits).toEqual([
      "power_off:started:provider 203474835",
      "power_off:succeeded:provider 203474835",
    ]);
  });

  test("an instance with no provider asset is fatal, not retried forever", async () => {
    const store = await tempStore();
    await seed(store, false);
    await enqueuePowerOff(store);
    const handler = powerOffHandler({
      powerOff: async () => {
        throw new Error("must not be called");
      },
    });
    const { ctx } = await context(store, "op-power_off-dun-1");
    expect(await handler.run(ctx)).toMatchObject({ kind: "fatal" });
  });

  test("a throw is rethrown for the ticker to classify, with an ambiguous audit row", async () => {
    // A power action is a mutation: a failed call proves nothing about whether the
    // provider applied it.
    const store = await tempStore();
    await seed(store);
    await enqueuePowerOff(store);
    const handler = powerOffHandler({
      powerOff: async () => {
        throw new Error("provider API timed out");
      },
    });
    const { ctx, audits } = await context(store, "op-power_off-dun-1");
    expect(handler.run(ctx)).rejects.toThrow(/timed out/);
    expect(audits.at(-1)).toContain("power_off:ambiguous");
    expect(handler.timeoutIsRetryable).toBeFalsy();
  });
});

describe("driven through a ticker", () => {
  test("a successful suspension marks the instance suspended", async () => {
    const store = await tempStore();
    await seed(store);
    await enqueuePowerOff(store);
    const ticker = new Ticker({
      store,
      handlers: [powerOffHandler({ powerOff: async () => {} })],
      now: () => NOW,
    });
    const summary = await ticker.once();
    expect(summary.completed).toBe(1);
    expect((await store.getOperation("op-power_off-dun-1"))?.status).toBe(
      "succeeded",
    );
    expect((await store.getInstance("inst-1"))?.service_state).toBe(
      "suspended",
    );
  });

  test("with NO handler registered, the operation fails loudly and raises attention", async () => {
    // A roster with no provider registers no power_off handler, so billing can
    // request a suspension that nothing carries out.
    const store = await tempStore();
    await seed(store);
    await enqueuePowerOff(store);
    const ticker = new Ticker({ store, handlers: [], now: () => NOW });
    await ticker.once();
    expect((await store.getOperation("op-power_off-dun-1"))?.status).toBe(
      "failed",
    );
    expect((await store.getInstance("inst-1"))?.attention_state).toBe(
      "needs_operator",
    );
    expect((await store.openReasons("inst-1"))[0]?.reason).toContain(
      "no handler registered",
    );
    expect((await store.getInstance("inst-1"))?.service_state).toBe("live");
  });
});
