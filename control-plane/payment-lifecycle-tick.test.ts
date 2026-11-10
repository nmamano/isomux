// The payment lifecycle on Postgres (task 6eb1e7d6): the lifecycle tick's
// payment arm, the work schedule that wakes it, the late payment that meets a
// deletion, and the race between the two. Dates are seeded; the pure rules are
// in payment-lifecycle.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import {
  LIFECYCLE_ASSET_GONE,
  PAYMENT_AFTER_DELETION,
  PAYMENT_DELETION_HELD,
  PAYMENT_LIFECYCLE_REASON,
  paymentOperationId,
  RETENTION_MS,
  GRACE_MS,
} from "./lifecycle.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";
import { requestResume, resumeOperationId } from "./resume.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";
import {
  ensureAccount,
  insertSubscription,
  type SubscriptionRow,
} from "./stripe/billing-store.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";
import { applyEvent } from "./stripe/reconcile.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const DAY = 24 * 60 * 60 * 1000;
const EP = "dun-evt_9";
/** Power-off well after the effective date: the plain 14-day case. */
const P = Date.parse("2027-03-01T10:00:00Z");
const SENT = P + 60_000;
const NAMED = P + RETENTION_MS;
/** The latest of the three instants (power-off + 14 d, named, sent + 14 d). */
const DUE = SENT + RETENTION_MS;

const NOTICE = paymentOperationId("payment_notice", EP);
const CANCEL = paymentOperationId("cancel_asset", EP);
const DNS = paymentOperationId("remove_dns", EP);

function clock(start: number) {
  const state = { t: start };
  return { now: () => state.t, set: (t: number) => (state.t = t) };
}

/** A box that dunning powered off at P: the shape the payment arm owns. */
async function seed(
  store: Store,
  over: {
    status?: string;
    endedAt?: number | null;
    cancellationReason?: string | null;
  } = {},
): Promise<void> {
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "suspended",
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
  await store.enqueue({
    id: suspensionOperationId(EP),
    instance_id: "inst-1",
    kind: "power_off",
    status: "succeeded",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: {
      reason: "dunning",
      subscription: "sub_1",
      episode: EP,
      poweredOff: true,
      poweredOffAt: P,
    },
  });
  await store.tx(async () => {
    const account = await ensureAccount(store, {
      id: "acct-1",
      email: "owner@example.test",
    });
    await insertSubscription(store, {
      id: "sub_1",
      account_id: account.id,
      instance_id: "inst-1",
      stripe_customer_id: "cus_1",
      status: over.status ?? "unpaid",
      current_period_end: P - 20 * DAY,
      cancel_at_period_end: 0,
      ended_at: over.endedAt ?? null,
      canceled_at: over.endedAt ?? null,
      cancellation_reason: over.cancellationReason ?? null,
      discount_percent_off: null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: 0,
      latest_invoice_id: null,
      payment_failures: 4,
      exhaustion_observed_at: P - 1000,
      coupon_grace_until: null,
      episode_id: EP,
      episode_state: "suspension_requested",
      last_event_id: null,
      last_event_created: null,
    });
  });
}

/** Insert an operation in a given state, with its evidence. */
async function put(
  store: Store,
  id: string,
  kind: string,
  status: "pending" | "succeeded" | "failed",
  evidence: object,
): Promise<void> {
  await store.enqueue({
    id,
    instance_id: "inst-1",
    kind,
    status,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence,
  });
}

const noticeEvidence = (sentAt?: number) => ({
  reason: PAYMENT_LIFECYCLE_REASON,
  subscription: "sub_1",
  episode: EP,
  deletesAt: NAMED,
  ...(sentAt === undefined ? {} : { sentAt }),
});

/** Complete an operation the way a leased tick would. */
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

async function setAssetState(store: Store, state: string): Promise<void> {
  const asset = (await store.getAsset("asset-1"))!;
  await store.casAsset(asset.id, asset.version, {
    asset_state: state as never,
  });
}

async function opIds(store: Store): Promise<string[]> {
  return (await store.operationsFor("inst-1")).map((o) => o.id).sort();
}

/** Every attention row with this key, open or cleared. */
async function everRaised(store: Store, key: string): Promise<number> {
  return (await store.sqlGet<{ n: number }>(
    "select count(*)::int as n from attention_reasons where instance_id = 'inst-1' and source_op_id = $1",
    [key],
  ))!.n;
}

async function openKeys(store: Store): Promise<string[]> {
  return (await store.openReasons("inst-1")).map((r) => r.source_op_id).sort();
}

async function auditActions(store: Store): Promise<string[]> {
  return (
    await store.sqlAll<{ action: string; target: string }>(
      "select action, target from audit_events where instance_id = 'inst-1' order by seq",
    )
  ).map((r) => `${r.action}:${r.target}`);
}

async function schedule(store: Store, now: number) {
  return store.workSchedule(now, GRACE_MS, RETENTION_MS, {
    // No provider and no liveness: their own due times would hide the payment
    // arm's in nextDueAt.
    providerConfigured: false,
    provisioningConfigured: true,
    checkoutConfigured: true,
    cadenceConfigured: true,
    livenessConfigured: false,
    staleProvisioningMs: 30 * 60_000,
    staleProvisioningReason: "stalled",
  });
}

describe("the lifecycle tick's payment arm", () => {
  test("mail first, deletion at the date, then the data end with no asset-gone alarm", async () => {
    const c = clock(P + 60_000);
    const store = await openTestStore(c.now);
    await seed(store);

    const first = await lifecycleTick(store, c.now());
    expect(first.failed).toBe(0);
    expect(await opIds(store)).toEqual(
      [NOTICE, suspensionOperationId(EP)].sort(),
    );
    const mail = (await store.getOperation(NOTICE))!;
    expect(mail.kind).toBe("payment_notice");
    expect(mail.status).toBe("pending");
    expect(JSON.parse(mail.evidence)).toMatchObject({
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
      deletesAt: NAMED,
    });
    expect(await auditActions(store)).toContain(
      `lifecycle_payment_notice:${NOTICE}`,
    );

    // Idempotent: a second pass opens nothing.
    const again = await lifecycleTick(store, c.now());
    expect(again.opened).toBe(0);

    await succeed(store, NOTICE, noticeEvidence(SENT));
    c.set(DUE - 1);
    await lifecycleTick(store, c.now());
    expect(await store.getOperation(CANCEL)).toBeNull();
    expect(await store.getOperation(DNS)).toBeNull();

    c.set(DUE);
    const due = await lifecycleTick(store, c.now());
    expect(due.failed).toBe(0);
    expect((await store.getOperation(CANCEL))?.kind).toBe("cancel_asset");
    expect((await store.getOperation(DNS))?.kind).toBe("remove_dns");
    expect(await auditActions(store)).toContain(
      `lifecycle_cancel_asset:${CANCEL}`,
    );
    expect((await lifecycleTick(store, c.now())).opened).toBe(0);

    await succeed(store, CANCEL, {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    await succeed(store, DNS, {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    await setAssetState(store, "cancelled");
    c.set(DUE + 20 * DAY);
    const end = await lifecycleTick(store, c.now());
    expect(end.failed).toBe(0);
    expect((await store.getInstance("inst-1"))?.service_state).toBe(
      "deprovisioned",
    );
    expect(await auditActions(store)).toContain("data_end:inst-1");
    expect(await everRaised(store, LIFECYCLE_ASSET_GONE)).toBe(0);
  });

  test("a subscription Stripe ended for non-payment reaches its data end with no asset-gone alarm", async () => {
    // ended_at is set, so the cancellation scan also reads this row; the payment
    // arm must record the end first (design D3).
    const c = clock(DUE + 30 * DAY);
    const store = await openTestStore(c.now);
    await seed(store, {
      status: "canceled",
      endedAt: P + 2 * DAY,
      cancellationReason: "payment_failed",
    });
    await put(
      store,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );
    await put(store, CANCEL, "cancel_asset", "succeeded", {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    await put(store, DNS, "remove_dns", "succeeded", {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    await setAssetState(store, "cancelled");

    const summary = await lifecycleTick(store, c.now());
    expect(summary.failed).toBe(0);
    expect((await store.getInstance("inst-1"))?.service_state).toBe(
      "deprovisioned",
    );
    expect(await everRaised(store, LIFECYCLE_ASSET_GONE)).toBe(0);
  });

  test("a mail that failed holds the deletion and raises one row, which clears when the mail is sent", async () => {
    const c = clock(DUE + 5 * DAY);
    const store = await openTestStore(c.now);
    await seed(store);
    await put(store, NOTICE, "payment_notice", "failed", noticeEvidence());

    await lifecycleTick(store, c.now());
    await lifecycleTick(store, c.now());
    expect(await store.getOperation(CANCEL)).toBeNull();
    expect(await openKeys(store)).toEqual([PAYMENT_DELETION_HELD]);

    // An operator re-runs the mail and it goes out now: 14 days from now.
    await succeed(store, NOTICE, noticeEvidence(c.now()));
    await lifecycleTick(store, c.now());
    expect(await openKeys(store)).toEqual([]);
    expect(await store.getOperation(CANCEL)).toBeNull();
  });
});

describe("the work schedule wakes the payment arm and then goes idle", () => {
  test("for the mail, at the date, and not in between", async () => {
    const c = clock(P + 60_000);
    const store = await openTestStore(c.now);
    await seed(store);

    // A proven power-off with no mail yet: the pass that opens it is due.
    expect((await schedule(store, c.now())).cadenceDue).toBe(true);
    await lifecycleTick(store, c.now());
    await succeed(store, NOTICE, noticeEvidence(SENT));

    c.set(P + 2 * DAY);
    const between = await schedule(store, c.now());
    expect(between.tickDue).toBe(false);
    expect(between.cadenceDue).toBe(false);
    expect(between.nextDueAt).toBe(DUE);

    expect((await schedule(store, DUE - 1)).cadenceDue).toBe(false);
    expect((await schedule(store, DUE)).cadenceDue).toBe(true);

    c.set(DUE);
    await lifecycleTick(store, c.now());
    await succeed(store, CANCEL, {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    await succeed(store, DNS, {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    // The provider schedules the cancel at its term end; nothing to do until
    // it reports the asset gone.
    await setAssetState(store, "cancel_scheduled");
    expect((await schedule(store, DUE + DAY)).cadenceDue).toBe(false);
  });

  test("a held deletion is due once, to raise its row, and then idle", async () => {
    const c = clock(DUE + DAY);
    const store = await openTestStore(c.now);
    await seed(store);
    await put(store, NOTICE, "payment_notice", "failed", noticeEvidence());

    expect((await schedule(store, c.now())).cadenceDue).toBe(true);
    await lifecycleTick(store, c.now());
    expect(await openKeys(store)).toEqual([PAYMENT_DELETION_HELD]);
    expect((await schedule(store, c.now())).cadenceDue).toBe(false);
  });
});

describe("a payment inside the window resumes; after the deletion started it is a refund", () => {
  async function unpaidThenPaid(store: Store): Promise<SubscriptionRow> {
    await store.sqlRun(
      "update subscriptions set status = 'active', version = version + 1 where id = 'sub_1'",
    );
    return (await store.sqlGet<SubscriptionRow>(
      "select * from subscriptions where id = 'sub_1'",
    ))!;
  }

  test("after the mail and before the deletion, the same box comes back", async () => {
    const store = await openTestStore(() => P + 5 * DAY);
    await seed(store);
    await put(
      store,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );
    const sub = await unpaidThenPaid(store);
    const outcome = await store.tx(() =>
      requestResume(store, sub, P + 5 * DAY),
    );
    expect(outcome).toEqual({ ok: true, operationId: resumeOperationId(EP) });
  });

  test("once a deletion row exists, the resume is refused", async () => {
    const store = await openTestStore(() => DUE + 1);
    await seed(store);
    await put(
      store,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );
    await put(store, CANCEL, "cancel_asset", "pending", {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    const sub = await unpaidThenPaid(store);
    const outcome = await store.tx(() => requestResume(store, sub, DUE + 1));
    expect(outcome).toEqual({ ok: false, code: "deletion_started" });
    expect(await store.getOperation(resumeOperationId(EP))).toBeNull();
  });

  test("a recovery event after the deletion started raises one refund row and powers nothing on", async () => {
    const now = DUE + 2 * DAY;
    const store = await openTestStore(() => now);
    await seed(store);
    await put(
      store,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );
    await put(store, CANCEL, "cancel_asset", "succeeded", {
      reason: PAYMENT_LIFECYCLE_REASON,
      episode: EP,
    });
    const recovered = (eventId: string) => ({
      eventId,
      eventType: "customer.subscription.updated",
      eventCreated: now,
      subscription: {
        id: "sub_1",
        customerId: "cus_1",
        status: "active",
        currentPeriodEnd: now + 30 * DAY,
        cancelAtPeriodEnd: false,
        endedAt: null,
        canceledAt: null,
        cancellationReason: null,
        discount: null,
        latestInvoiceId: null,
        metadata: {},
        livemode: false,
      },
      now,
    });
    await store.tx(() => applyEvent(store, recovered("evt_paid_1")));
    expect(await store.getOperation(resumeOperationId(EP))).toBeNull();
    const rows = (await store.openReasons("inst-1")).filter(
      (r) => r.source_op_id === PAYMENT_AFTER_DELETION,
    );
    expect(rows.map((r) => r.severity)).toEqual(["critical"]);
  });

  test("a payment after the data end is recorded also raises the refund row", async () => {
    // The usual late payment: weeks after the deletion, when the office is
    // already deprovisioned and no longer suspended.
    const now = DUE + 60 * DAY;
    const store = await openTestStore(() => now);
    await seed(store);
    await put(
      store,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );
    for (const [id, kind] of [
      [CANCEL, "cancel_asset"],
      [DNS, "remove_dns"],
    ] as const) {
      await put(store, id, kind, "succeeded", {
        reason: PAYMENT_LIFECYCLE_REASON,
        episode: EP,
      });
    }
    await setAssetState(store, "cancelled");
    await lifecycleTick(store, now);
    // The enabling condition: the data end is recorded.
    expect((await store.getInstance("inst-1"))?.service_state).toBe(
      "deprovisioned",
    );
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt_paid_late",
        eventType: "customer.subscription.updated",
        eventCreated: now,
        subscription: {
          id: "sub_1",
          customerId: "cus_1",
          status: "active",
          currentPeriodEnd: now + 30 * DAY,
          cancelAtPeriodEnd: false,
          endedAt: null,
          canceledAt: null,
          cancellationReason: null,
          discount: null,
          latestInvoiceId: null,
          metadata: {},
          livemode: false,
        },
        now,
      }),
    );
    expect(await store.getOperation(resumeOperationId(EP))).toBeNull();
    const rows = (await store.openReasons("inst-1")).filter(
      (r) => r.source_op_id === PAYMENT_AFTER_DELETION,
    );
    expect(rows.map((r) => r.severity)).toEqual(["critical"]);
  });
});

describe("the race: a payment that lands while the deletion is being decided", () => {
  test("the box is powered on or deleted, never both", async () => {
    // The webhook writes the subscription and opens the resume in one
    // transaction (reconcile.applyEvent). While it is open, the tick decides.
    // The tick must wait for it (design D1), and then see the payment.
    const c = clock(DUE + 1);
    const dsn = await testDsn();
    const hook = await openTestStoreOn(dsn, c.now);
    const ticker = await openTestStoreOn(dsn, c.now);
    const watch = await openTestStoreOn(dsn, c.now);
    await seed(hook);
    await put(
      hook,
      NOTICE,
      "payment_notice",
      "succeeded",
      noticeEvidence(SENT),
    );

    let ready: (pid: number) => void = () => {};
    const hookPid = new Promise<number>((r) => (ready = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const webhook = hook.tx(async () => {
      await hook.sqlRun(
        "update subscriptions set status = 'active', version = version + 1 where id = 'sub_1'",
      );
      const sub = (await hook.sqlGet<SubscriptionRow>(
        "select * from subscriptions where id = 'sub_1'",
      ))!;
      const asked = await requestResume(hook, sub, c.now());
      ready(
        (await hook.sqlGet<{ pid: number }>("select pg_backend_pid() as pid"))!
          .pid,
      );
      await gate;
      return asked;
    });
    const pid = await hookPid;

    let tickDone = false;
    const ticking = lifecycleTick(ticker, c.now()).finally(() => {
      tickDone = true;
    });
    // Wait until the tick either finished or is blocked by the webhook.
    let blocked = false;
    const until = Date.now() + 5_000;
    while (!tickDone && !blocked && Date.now() < until) {
      blocked =
        (await watch.sqlGet<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
          [pid],
        ))!.n > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 20));
    }
    release();
    const asked = await webhook;
    await ticking;

    expect({
      poweredOn: (await watch.getOperation(resumeOperationId(EP))) !== null,
      deleted: (await watch.getOperation(CANCEL)) !== null,
    }).toEqual({ poweredOn: true, deleted: false });
    // The enabling conditions: the payment was decided first, and the tick
    // really ran while it was open.
    expect(asked.ok).toBe(true);
    expect(blocked).toBe(true);
  }, 20_000);
});
