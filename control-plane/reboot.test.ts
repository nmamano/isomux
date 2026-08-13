// The restart, at the provider.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rebootHandler } from "./reboot.ts";
import { type AssetRow } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";
import { RemoteTimeoutError } from "./ssh.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";

const temps: string[] = [];

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Bed {
  ctx: HandlerContext;
  audits: string[];
  lines: string[];
}

async function bed(withAsset: boolean): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-reboot-"));
  temps.push(dir);
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
  expect(handler.run(b.ctx)).rejects.toThrow("killed");
  // The call was ISSUED. "failed" would be a claim that nothing happened.
  expect(b.audits).toEqual([
    "reboot:started:provider 203474835",
    "reboot:ambiguous:killed",
  ]);
});

test("a timeout is never retryable: a restart is a mutation", async () => {
  // The ticker reads this flag to decide what a killed child means. A reboot
  // that timed out may well have been applied, and repeating it would restart
  // somebody's office a second time.
  expect(rebootHandler({ reboot: async () => {} }).timeoutIsRetryable).toBe(
    false,
  );
});
