// Coming back from a dunning suspension - and, above all, not coming back from
// a cancellation.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIFECYCLE_REASON, lifecycleOperationId } from "./lifecycle.ts";
import { powerOnHandler, requestResume, resumeOperationId } from "./resume.ts";
import { Store, type ServiceState } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import {
  ensureAccount,
  insertSubscription,
  type SubscriptionRow,
} from "./stripe/billing-store.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";
import {
  RemoteBudget,
  serviceStateAfter,
  type HandlerContext,
} from "./tick.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

const NOW = Date.parse("2027-06-10T00:00:00Z");
const EPISODE = "dun-evt_1";

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-resume-"));
  temps.push(dir);
  return await openTestStore(() => NOW);
}

/** A suspended office with a succeeded DUNNING power_off, which is the only
 * shape a resume is ever about. */
async function seed(
  store: Store,
  over: {
    serviceState?: string;
    status?: string;
    endedAt?: number | null;
    suspensionReason?: string | null;
    extraOps?: { id: string; kind: string; evidence: unknown }[];
  } = {},
): Promise<SubscriptionRow> {
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: (over.serviceState ?? "suspended") as ServiceState,
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
  if (over.suspensionReason !== null) {
    await store.enqueue({
      id: suspensionOperationId(EPISODE),
      instance_id: "inst-1",
      kind: "power_off",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: {
        reason: over.suspensionReason ?? "dunning",
        episode: EPISODE,
        poweredOffAt: NOW - 86_400_000,
      },
    });
  }
  for (const extra of over.extraOps ?? []) {
    await store.enqueue({
      id: extra.id,
      instance_id: "inst-1",
      kind: extra.kind,
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: extra.evidence,
    });
  }
  return await store.tx(async () => {
    const account = await ensureAccount(store, {
      id: "acct-1",
      email: "a@b.test",
    });
    return await insertSubscription(store, {
      id: "sub_1",
      account_id: account.id,
      instance_id: "inst-1",
      stripe_customer_id: "cus_1",
      status: over.status ?? "active",
      current_period_end: null,
      cancel_at_period_end: 0,
      ended_at: over.endedAt ?? null,
      canceled_at: null,
      cancellation_reason: null,
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

describe("requestResume predicates", () => {
  test("a recovered dunning suspension is resumed, once", async () => {
    const store = await tempStore();
    const sub = await seed(store);
    const first = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(first).toEqual({
      ok: true,
      operationId: resumeOperationId(EPISODE),
    });
    const op = (await store.getOperation(resumeOperationId(EPISODE)))!;
    expect(op.kind).toBe("power_on");

    // The derived id is what makes a redelivered recovery event harmless: the
    // primary key refuses a second row permanently, terminal or not.
    const second = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(second).toEqual({ ok: false, code: "already_open" });
    await store.close();
  });

  test("A SECOND dunning episode gets its OWN resume", async () => {
    // The defect this pins: operationsFor returns oldest first, so taking the
    // first succeeded dunning power_off selected episode A - already paired with
    // op-power_on-A - and answered `already_open`. Episode B's box then stays
    // switched off while the customer is paying.
    const store = await tempStore();
    const sub = await seed(store);

    const firstResume = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(firstResume).toEqual({
      ok: true,
      operationId: resumeOperationId(EPISODE),
    });
    // Episode A's resume completes.
    await store.sqlRun(
      "update operations set status = 'succeeded' where id = $1",
      [resumeOperationId(EPISODE)],
    );

    // Later, episode B suspends the box again.
    const B = "dun-evt_2";
    await store.enqueue({
      id: suspensionOperationId(B),
      instance_id: "inst-1",
      kind: "power_off",
      status: "succeeded",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { reason: "dunning", episode: B, poweredOffAt: NOW - 1000 },
    });
    const inst = (await store.getInstance("inst-1"))!;
    await store.casInstance(inst.id, inst.version, {
      service_state: "suspended",
    });

    const secondResume = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(secondResume).toEqual({
      ok: true,
      operationId: resumeOperationId(B),
    });
    expect((await store.getOperation(resumeOperationId(B)))!.kind).toBe(
      "power_on",
    );
    await store.close();
  });

  test("a newest suspension that was ALREADY resumed does not resurrect an older one", async () => {
    // The trap in "skip anything already paired": it would step past the newest
    // episode and open a resume on a STALE one's authority. The honest answer
    // is that this function has nothing to act on.
    const store = await tempStore();
    const B = "dun-evt_2";
    const sub = await seed(store, {
      extraOps: [
        {
          id: suspensionOperationId(B),
          kind: "power_off",
          evidence: { reason: "dunning", episode: B, poweredOffAt: NOW - 500 },
        },
        {
          id: resumeOperationId(B),
          kind: "power_on",
          evidence: { reason: "dunning", episode: B },
        },
      ],
    });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "already_open",
    });
    // And emphatically NOT a resume of episode A.
    expect(await store.getOperation(resumeOperationId(EPISODE))).toBeNull();
    await store.close();
  });

  test("tied created_at cannot decide it: the recorded power-off instant does", async () => {
    // operations are ordered by created_at, timestamps tie at millisecond
    // resolution, and SQL promises nothing about the order of tied rows - so
    // reversing whatever order came back was a coin flip. The comparison is on
    // the instant the handler recorded on purpose.
    const store = await tempStore();
    const B = "dun-evt_2";
    const sub = await seed(store, {
      extraOps: [
        {
          // Inserted SECOND, so a plain array reversal would pick it, and it is
          // the OLDER suspension. Same created_at as episode A's row, because
          // the store clock is frozen for this test.
          id: suspensionOperationId(B),
          kind: "power_off",
          evidence: {
            reason: "dunning",
            episode: B,
            poweredOffAt: NOW - 90_000_000,
          },
        },
      ],
    });
    const rows = await store.operationsFor("inst-1");
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);
    // Episode A was powered off a day ago; B, despite being inserted later, is
    // stamped three weeks earlier. A is the suspension the box is in.
    const outcome = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(outcome).toEqual({
      ok: true,
      operationId: resumeOperationId(EPISODE),
    });
    await store.close();
  });

  test("with two UNPAIRED suspensions it takes the one the box is in", async () => {
    // Pairing alone does not order them: if episode A's resume never opened
    // (it failed, or the process died), both are unpaired and only the LATEST
    // describes the suspension the box is actually sitting in.
    const store = await tempStore();
    const B = "dun-evt_2";
    const sub = await seed(store, {
      extraOps: [
        {
          id: suspensionOperationId(B),
          kind: "power_off",
          evidence: { reason: "dunning", episode: B, poweredOffAt: NOW - 500 },
        },
      ],
    });
    const outcome = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(outcome).toEqual({ ok: true, operationId: resumeOperationId(B) });
    await store.close();
  });

  test("when every dunning suspension is already paired, there is nothing to do", async () => {
    const store = await tempStore();
    const sub = await seed(store);
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "already_open",
    });
    await store.close();
  });

  test("A CANCELLATION-RETENTION BOX IS NEVER RESUMED", async () => {
    // The failure this exists to prevent: a cancelled office inside its
    // retention month is `suspended` and has a succeeded power_off too, so a
    // resume that looked only at those would restart a server the customer
    // cancelled and hand back an office on its way to deletion.
    const store = await tempStore();
    const endedAt = Date.parse("2027-06-01T00:00:00Z");
    const sub = await seed(store, {
      extraOps: [
        {
          id: lifecycleOperationId("power_off", "sub_1", endedAt),
          kind: "power_off",
          evidence: { reason: LIFECYCLE_REASON, poweredOffAt: NOW - 1000 },
        },
      ],
    });
    const outcome = await store.tx(
      async () => await requestResume(store, sub, NOW),
    );
    expect(outcome).toEqual({ ok: false, code: "cancellation_in_progress" });
    expect(await store.getOperation(resumeOperationId(EPISODE))).toBeNull();
    await store.close();
  });

  test("a terminal subscription is refused from the other side too", async () => {
    const store = await tempStore();
    const sub = await seed(store, {
      endedAt: Date.parse("2027-06-01T00:00:00Z"),
    });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "cancellation_in_progress",
    });
    await store.close();
  });

  test("an office that is not suspended has nothing to resume", async () => {
    const store = await tempStore();
    const sub = await seed(store, { serviceState: "live" });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "not_suspended",
    });
    await store.close();
  });

  test("an unhealthy subscription is refused", async () => {
    const store = await tempStore();
    const sub = await seed(store, { status: "past_due" });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "not_healthy",
    });
    await store.close();
  });

  test("with no dunning suspension there is nothing to undo", async () => {
    const store = await tempStore();
    const sub = await seed(store, { suspensionReason: null });
    expect(
      await store.tx(async () => await requestResume(store, sub, NOW)),
    ).toEqual({
      ok: false,
      code: "no_dunning_suspension",
    });
    await store.close();
  });

  test("it refuses to run outside a transaction", async () => {
    const store = await tempStore();
    const sub = await seed(store);
    expect(requestResume(store, sub, NOW)).rejects.toThrow(
      /inside a transaction/,
    );
    await store.close();
  });
});

describe("the power_on handler", () => {
  async function bed(withAsset = true) {
    const store = await tempStore();
    const instance = await store.createInstance({
      id: "inst-1",
      run_id: null,
      name: "cp2.test.isomux.app",
      plan: "V153",
      region: "EU",
      service_state: "suspended",
      goal: "live",
      access_window_expires_at: null,
    });
    const asset = withAsset
      ? await store.createAsset({
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
        })
      : null;
    const op = await store.enqueue({
      id: resumeOperationId(EPISODE),
      instance_id: "inst-1",
      kind: "power_on",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
      evidence: { reason: "dunning", episode: EPISODE },
    });
    const audits: string[] = [];
    const ctx: HandlerContext = {
      store,
      op,
      instance,
      asset,
      fence: { id: op.id, version: op.version, holder: "h" },
      budget: new RemoteBudget(NOW + 60_000, NOW + 300_000, () => NOW),
      now: NOW,
      report: () => {},
      audit: (action, outcome) => {
        audits.push(`${action}:${outcome}`);
        return Promise.resolve();
      },
    };
    return { store, ctx, audits };
  }

  test("it concludes on the PROVIDER's answer and keeps the episode stamp", async () => {
    const asked: string[] = [];
    const b = await bed();
    const result = await powerOnHandler({
      powerOn: async (id) => {
        asked.push(id);
      },
    }).run(b.ctx);
    expect(result.kind).toBe("done");
    expect(asked).toEqual(["203474835"]);
    const evidence = (result as { evidence: Record<string, unknown> }).evidence;
    expect(evidence.poweredOn).toBe(true);
    expect(evidence.episode).toBe(EPISODE);
    expect(b.audits).toEqual(["power_on:started", "power_on:succeeded"]);
    await b.store.close();
  });

  test("a killed call is ambiguous, never a retry", async () => {
    const b = await bed();
    const handler = powerOnHandler({
      powerOn: async () => {
        throw new Error("timed out");
      },
    });
    expect(handler.timeoutIsRetryable).toBe(false);
    expect(handler.run(b.ctx)).rejects.toThrow("timed out");
    expect(b.audits).toEqual(["power_on:started", "power_on:ambiguous"]);
    await b.store.close();
  });

  test("no provider asset is fatal", async () => {
    const b = await bed(false);
    const result = await powerOnHandler({ powerOn: async () => {} }).run(b.ctx);
    expect(result.kind).toBe("fatal");
    await b.store.close();
  });

  test("a proven resume moves the coarse service state off suspended", async () => {
    // `suspended` is a claim about what WE did to the box; after a proven
    // power_on it is no longer true. Whether it ANSWERS is the liveness axis.
    expect(serviceStateAfter("power_on")).toBe("live");
    expect(serviceStateAfter("power_off")).toBe("suspended");
  });
});
