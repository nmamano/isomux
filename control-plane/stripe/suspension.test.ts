// The suspension handler, against a stubbed provider. No real box is touched by
// anything in this slice, and nothing here reaches a provider API.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
import { RemoteBudget, Ticker, serviceStateAfter } from "../tick.ts";
import { DECLARED_UNIMPLEMENTED_KINDS, deadlinesFor } from "../operations.ts";
import { powerOffHandler } from "./suspension.ts";

const NOW = 1_770_000_000_000;
const temps: string[] = [];

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-suspend-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), () => NOW);
}

function seed(store: Store, withAsset = true): string {
  store.createInstance({
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
    store.tx(() =>
      store.createAsset({
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

function context(store: Store, opId: string) {
  const op = store.getOperation(opId)!;
  const leased = store.tryLease(
    opId,
    op.version,
    "holder-1",
    NOW + 300_000,
    NOW,
  )!;
  const audits: string[] = [];
  return {
    audits,
    ctx: {
      store,
      op: leased,
      instance: store.getInstance("inst-1")!,
      asset: store.assetForInstance("inst-1"),
      fence: { id: opId, version: leased.version, holder: "holder-1" },
      budget: new RemoteBudget(NOW + 60_000, NOW + 300_000, () => NOW),
      now: NOW,
      report: () => {},
      audit: (action: string, outcome: string, detail?: string) =>
        audits.push(`${action}:${outcome}${detail ? `:${detail}` : ""}`),
    },
  };
}

function enqueuePowerOff(store: Store, id = "op-power_off-dun-1") {
  const d = deadlinesFor("power_off");
  return store.enqueue({
    id,
    instance_id: "inst-1",
    kind: "power_off",
    inactivity_deadline_at: NOW + d.inactivityMs,
    absolute_deadline_at: NOW + d.absoluteMs,
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the operation model", () => {
  test("power_off has deadlines, so it can be enqueued at all", () => {
    expect(deadlinesFor("power_off")).toMatchObject({
      inactivityMs: 300_000,
      absoluteMs: 1_800_000,
    });
  });

  test("power_on is still declared unimplemented, on purpose", () => {
    // Suspension is this slice's boundary; RESUMING is a billing recovery
    // transition nobody has ruled on, and a silent no-op arm would look like work.
    expect(DECLARED_UNIMPLEMENTED_KINDS).toContain("power_on");
    expect(() => deadlinesFor("power_on")).toThrow(/does not drive it/);
  });

  test("a proven power-off moves the coarse service state to suspended", () => {
    expect(serviceStateAfter("power_off")).toBe("suspended");
    expect(serviceStateAfter("verify_https")).toBe("live");
    expect(serviceStateAfter("mint_invite")).toBeNull();
  });
});

describe("the handler", () => {
  test("calls the provider once and reports done", async () => {
    const store = tempStore();
    seed(store);
    enqueuePowerOff(store);
    const called: string[] = [];
    const handler = powerOffHandler({
      powerOff: async (providerId) => {
        called.push(providerId);
      },
    });
    const { ctx, audits } = context(store, "op-power_off-dun-1");
    const result = await handler.run(ctx);
    expect(called).toEqual(["203474835"]);
    expect(result).toMatchObject({ kind: "done" });
    expect(audits).toEqual([
      "power_off:started:provider 203474835",
      "power_off:succeeded:provider 203474835",
    ]);
  });

  test("an instance with no provider asset is fatal, not retried forever", async () => {
    const store = tempStore();
    seed(store, false);
    enqueuePowerOff(store);
    const handler = powerOffHandler({
      powerOff: async () => {
        throw new Error("must not be called");
      },
    });
    const { ctx } = context(store, "op-power_off-dun-1");
    expect(await handler.run(ctx)).toMatchObject({ kind: "fatal" });
  });

  test("a throw is rethrown for the ticker to classify, with an ambiguous audit row", async () => {
    // A power action is a mutation: a failed call proves nothing about whether the
    // provider applied it.
    const store = tempStore();
    seed(store);
    enqueuePowerOff(store);
    const handler = powerOffHandler({
      powerOff: async () => {
        throw new Error("provider API timed out");
      },
    });
    const { ctx, audits } = context(store, "op-power_off-dun-1");
    expect(handler.run(ctx)).rejects.toThrow(/timed out/);
    expect(audits.at(-1)).toContain("power_off:ambiguous");
    expect(handler.timeoutIsRetryable).toBeFalsy();
  });
});

describe("driven through a ticker", () => {
  test("a successful suspension marks the instance suspended", async () => {
    const store = tempStore();
    seed(store);
    enqueuePowerOff(store);
    const ticker = new Ticker({
      store,
      handlers: [powerOffHandler({ powerOff: async () => {} })],
      now: () => NOW,
    });
    const summary = await ticker.once();
    expect(summary.completed).toBe(1);
    expect(store.getOperation("op-power_off-dun-1")?.status).toBe("succeeded");
    expect(store.getInstance("inst-1")?.service_state).toBe("suspended");
  });

  test("with NO handler registered, the operation fails loudly and raises attention", async () => {
    // This is what a runnable command in this slice actually does: billing can
    // request a suspension, and nothing here may power a real box off.
    const store = tempStore();
    seed(store);
    enqueuePowerOff(store);
    const ticker = new Ticker({ store, handlers: [], now: () => NOW });
    await ticker.once();
    expect(store.getOperation("op-power_off-dun-1")?.status).toBe("failed");
    expect(store.getInstance("inst-1")?.attention_state).toBe("needs_operator");
    expect(store.openReasons("inst-1")[0]?.reason).toContain(
      "no handler registered",
    );
    expect(store.getInstance("inst-1")?.service_state).toBe("live");
  });
});
