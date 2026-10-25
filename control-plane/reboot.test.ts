// The restart, at the provider.

import { afterEach, describe, expect, test } from "bun:test";
import { rebootHandler } from "./reboot.ts";
import { type AssetRow } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";
import { RemoteTimeoutError } from "./ssh.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  ctx: HandlerContext;
  audits: string[];
  lines: string[];
}

async function bed(withAsset: boolean): Promise<Bed> {
  const store = await openTestStore();
  const instance = await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: Date.now() + 1_000,
  });
  let asset: AssetRow | null = null;
  if (withAsset) {
    asset = await store.createAsset({
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
  }
  const op = await store.enqueue({
    id: "op-reboot-1",
    instance_id: "inst-1",
    kind: "reboot",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: { via: "dashboard" },
  });
  const audits: string[] = [];
  const lines: string[] = [];
  return {
    audits,
    lines,
    ctx: {
      store,
      op,
      instance,
      asset,
      fence: { id: op.id, version: op.version, holder: "h" },
      budget: new RemoteBudget(Date.now() + 60_000, Date.now() + 300_000, () =>
        Date.now(),
      ),
      now: Date.now(),
      report: (l) => lines.push(l),
      audit: (action, outcome, detail) => {
        audits.push(`${action}:${outcome}${detail ? `:${detail}` : ""}`);
        return Promise.resolve();
      },
    },
  };
}

test("a restart reaches the provider and concludes on ITS answer", async () => {
  const asked: string[] = [];
  const b = await bed(true);
  const result = await rebootHandler({
    reboot: async (id) => {
      asked.push(id);
    },
  }).run(b.ctx);
  expect(asked).toEqual(["203474835"]);
  expect(result).toMatchObject({
    kind: "done",
    evidence: {
      rebooted: true,
      rebootedAt: expect.any(Number),
      providerId: "203474835",
    },
  });
  expect(b.audits).toEqual([
    "reboot:started:provider 203474835",
    "reboot:succeeded:provider 203474835",
  ]);
});

test("execution refuses a reboot after customer cancellation", async () => {
  const b = await bed(true);
  await b.ctx.store.tx(async () => {
    const account = await ensureAccount(b.ctx.store, {
      id: "acct-1",
      email: "cancelled@example.test",
    });
    await insertSubscription(b.ctx.store, {
      id: "sub-1",
      account_id: account.id,
      instance_id: b.ctx.instance.id,
      stripe_customer_id: "cus-1",
      status: "canceled",
      current_period_end: 1,
      cancel_at_period_end: 1,
      ended_at: 1,
      canceled_at: 0,
      cancellation_reason: "cancellation_requested",
      cancellation_policy: "launch",
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
  let calls = 0;
  const result = await rebootHandler({
    reboot: async () => void calls++,
  }).run(b.ctx);
  expect(result).toMatchObject({ kind: "fatal" });
  expect(calls).toBe(0);
});

test("execution permits a grandfathered reboot during serving grace", async () => {
  const b = await bed(true);
  await b.ctx.store.tx(async () => {
    const account = await ensureAccount(b.ctx.store, {
      id: "acct-1",
      email: "legacy@example.test",
    });
    await insertSubscription(b.ctx.store, {
      id: "sub-legacy",
      account_id: account.id,
      instance_id: b.ctx.instance.id,
      stripe_customer_id: "cus-legacy",
      status: "canceled",
      current_period_end: b.ctx.now,
      cancel_at_period_end: 1,
      ended_at: b.ctx.now,
      canceled_at: 0,
      cancellation_reason: "cancellation_requested",
      cancellation_policy: "legacy",
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
  let calls = 0;
  expect(
    await rebootHandler({ reboot: async () => void calls++ }).run(b.ctx),
  ).toMatchObject({ kind: "done" });
  expect(calls).toBe(1);
});

test("no provider asset is fatal, not a retry", async () => {
  const b = await bed(false);
  let called = false;
  const result = await rebootHandler({
    reboot: async () => {
      called = true;
    },
  }).run(b.ctx);
  // No amount of waiting gives this instance a box to restart.
  expect(result.kind).toBe("fatal");
  expect(called).toBe(false);
});

test("a throw is rethrown for the ticker, and audited as ambiguous", async () => {
  const b = await bed(true);
  const handler = rebootHandler({
    reboot: async () => {
      throw new RemoteTimeoutError("killed");
    },
  });
  // The ticker reads this flag to decide what a killed child means. A reboot
  // that timed out may well have been applied, and repeating it would restart
  // somebody's office a second time.
  expect(handler.timeoutIsRetryable).toBe(false);
  expect(handler.run(b.ctx)).rejects.toThrow("killed");
  // The call was ISSUED. "failed" would be a claim that nothing happened.
  expect(b.audits).toEqual([
    "reboot:started:provider 203474835",
    "reboot:ambiguous:killed",
  ]);
});

// The bed's reboot row is enqueued BEFORE the power_off below, so every case
// here is also a reboot opened while the office was live that runs after the
// suspension landed: the request fence cannot have seen it.
describe("a suspended office is not rebooted", () => {
  const EPISODE = "dun-evt_reboot";
  const dunning = {
    reason: "dunning",
    subscription: "sub-1",
    episode: EPISODE,
  };

  async function subscribe(
    b: Bed,
    over: Partial<{
      status: string;
      ended_at: number | null;
      cancellation_reason: string | null;
      cancellation_policy: "launch" | "legacy";
    }>,
  ): Promise<void> {
    await b.ctx.store.tx(async () => {
      const account = await ensureAccount(b.ctx.store, {
        id: "acct-1",
        email: "suspended@example.test",
      });
      await insertSubscription(b.ctx.store, {
        id: "sub-1",
        account_id: account.id,
        instance_id: b.ctx.instance.id,
        stripe_customer_id: "cus-1",
        status: over.status ?? "active",
        current_period_end: null,
        cancel_at_period_end: 0,
        ended_at: over.ended_at ?? null,
        canceled_at: null,
        cancellation_reason: over.cancellation_reason ?? null,
        ...(over.cancellation_policy
          ? { cancellation_policy: over.cancellation_policy }
          : {}),
        discount_percent_off: null,
        discount_coupon_id: null,
        discount_ends_at: null,
        ever_full_discount: 0,
        latest_invoice_id: null,
        payment_failures: 3,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
        episode_id: null,
        last_event_id: null,
        last_event_created: null,
      });
    });
  }

  /** What the ticker leaves after a power_off succeeds, and what dispatch
   * hands the handler: the instance row read after the lease. */
  async function setServiceState(b: Bed, state: "suspended" | "live") {
    const instance = await b.ctx.store.casInstance(
      b.ctx.instance.id,
      b.ctx.instance.version,
      { service_state: state },
    );
    expect(instance).not.toBeNull();
    b.ctx.instance = instance!;
  }

  async function poweredOff(b: Bed): Promise<void> {
    await b.ctx.store.enqueue({
      id: suspensionOperationId(EPISODE),
      instance_id: b.ctx.instance.id,
      kind: "power_off",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { ...dunning, poweredOffAt: b.ctx.now - 60_000 },
    });
    await setServiceState(b, "suspended");
  }

  async function run(b: Bed): Promise<{ result: unknown; calls: number }> {
    let calls = 0;
    const result = await rebootHandler({
      reboot: async () => void calls++,
    }).run(b.ctx);
    return { result, calls };
  }

  for (const billing of [
    { status: "past_due" },
    { status: "unpaid" },
    {
      status: "canceled",
      ended_at: 1,
      cancellation_reason: "payment_failed",
    },
  ]) {
    test(`a dunning suspension (${billing.status}${billing.cancellation_reason ? `, ${billing.cancellation_reason}` : ""}) is fatal and never reaches the provider`, async () => {
      const b = await bed(true);
      await subscribe(b, billing);
      await poweredOff(b);
      const { result, calls } = await run(b);
      expect(result).toMatchObject({ kind: "fatal" });
      expect(calls).toBe(0);
      expect(b.audits).toEqual([]);
    });
  }

  test("a customer who cancels during a dunning suspension is not rebooted in the grace", async () => {
    // Without the suspension this is the grandfathered serving grace, which
    // reboots (the test above).
    const b = await bed(true);
    await subscribe(b, {
      status: "canceled",
      ended_at: b.ctx.now,
      cancellation_reason: "cancellation_requested",
      cancellation_policy: "legacy",
    });
    await poweredOff(b);
    const { result, calls } = await run(b);
    expect(result).toMatchObject({ kind: "fatal" });
    expect(calls).toBe(0);
    expect(b.audits).toEqual([]);
  });

  test("an office resumed after payment reboots", async () => {
    const b = await bed(true);
    await subscribe(b, { status: "active" });
    await poweredOff(b);
    await b.ctx.store.enqueue({
      id: `op-power_on-${EPISODE}`,
      instance_id: b.ctx.instance.id,
      kind: "power_on",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { ...dunning, poweredOnAt: b.ctx.now },
    });
    await setServiceState(b, "live");
    const { result, calls } = await run(b);
    expect(result).toMatchObject({ kind: "done" });
    expect(calls).toBe(1);
  });
});
