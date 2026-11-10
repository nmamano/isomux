// The payment-suspension mail's handler (task 6eb1e7d6): one mail to the
// account, keyed by the operation id so a retry cannot deliver twice, naming
// the date the opener fixed, and none for a customer who paid in between.

import { afterEach, describe, expect, test } from "bun:test";
import {
  PAYMENT_LIFECYCLE_REASON,
  paymentOperationId,
  RETENTION_MS,
} from "./lifecycle.ts";
import {
  paymentNoticeHandler,
  requeuePaymentNotice,
  type PaymentNoticeMail,
} from "./payment-notice.ts";
import { suspensionOperationId } from "./stripe/dunning.ts";
import type { ServiceState, Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { ensureAccount, insertSubscription } from "./stripe/billing-store.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";
import { STOREFRONT_ORIGIN } from "./welcome-mail.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const DAY = 24 * 60 * 60 * 1000;
const EP = "dun-evt_9";
const P = Date.parse("2027-03-01T10:00:00Z");
const NOW = P + 60_000;
const OWNER = "owner@example.test";

async function bed(
  over: {
    serviceState?: ServiceState;
    status?: string;
    deletesAt?: number;
    /** The office's name on the dashboard (its route key); null for an
     * instance with no reservation. */
    officeName?: string | null;
  } = {},
): Promise<{ store: Store; ctx: HandlerContext }> {
  const store = await openTestStore(() => NOW);
  const instance = await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: over.serviceState ?? "suspended",
    goal: "live",
    access_window_expires_at: null,
  });
  const asset = await store.createAsset({
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
  if (over.officeName !== null)
    await store.sqlRun(
      "insert into name_reservations (name, id, account_id, instance_id, plan, " +
        "checkout_generation, checkout_state, version, created_at, updated_at) " +
        "values ($1, 'res-1', 'acct-1', 'inst-1', 'V153', 1, 'reconciled', 1, $2, $2)",
      [over.officeName ?? "cp2", P - 60 * DAY],
    );
  await store.tx(async () => {
    const account = await ensureAccount(store, { id: "acct-1", email: OWNER });
    await insertSubscription(store, {
      id: "sub_1",
      account_id: account.id,
      instance_id: "inst-1",
      stripe_customer_id: "cus_1",
      status: over.status ?? "unpaid",
      current_period_end: P - 20 * DAY,
      cancel_at_period_end: 0,
      ended_at: null,
      canceled_at: null,
      cancellation_reason: null,
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
  const op = await store.enqueue({
    id: paymentOperationId("payment_notice", EP),
    instance_id: "inst-1",
    kind: "payment_notice",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: {
      reason: PAYMENT_LIFECYCLE_REASON,
      subscription: "sub_1",
      episode: EP,
      deletesAt: over.deletesAt ?? P + RETENTION_MS,
    },
  });
  const ctx: HandlerContext = {
    store,
    op,
    instance,
    asset,
    fence: { id: op.id, version: op.version, holder: "h" },
    budget: new RemoteBudget(NOW + 60_000, NOW + 300_000, () => NOW),
    now: NOW,
    report: () => {},
    audit: () => Promise.resolve(),
  };
  return { store, ctx };
}

function recorder() {
  const sent: { mail: PaymentNoticeMail; key: string }[] = [];
  const handler = paymentNoticeHandler({
    send: async (mail, key) => {
      sent.push({ mail, key });
    },
  });
  return { sent, handler };
}

describe("the payment notice handler", () => {
  test("sends one mail to the account, keyed by the operation id, and records when", async () => {
    const b = await bed();
    const r = recorder();
    const result = await r.handler.run(b.ctx);
    expect(result.kind).toBe("done");
    expect(r.sent.length).toBe(1);
    expect(r.sent[0]!.key).toBe(b.ctx.op.id);
    expect(r.sent[0]!.mail.to).toBe(OWNER);
    const evidence = (result as { evidence: Record<string, unknown> }).evidence;
    // The deletion reads these back from the succeeded row (design D2).
    expect(evidence.sentAt).toBe(NOW);
    expect(evidence.deletesAt).toBe(P + RETENTION_MS);
    expect(evidence.reason).toBe(PAYMENT_LIFECYCLE_REASON);
    expect(evidence.episode).toBe(EP);
  });

  test("the mail names the date, and a retry sends the same mail", async () => {
    const first = await bed();
    const a = recorder();
    await a.handler.run(first.ctx);
    await a.handler.run(first.ctx);
    // Same key and same body: Resend refuses a reused key with another body.
    expect(a.sent.length).toBe(2);
    expect(a.sent[1]).toEqual(a.sent[0]!);
    await releaseTestStores();

    const later = await bed({ deletesAt: P + RETENTION_MS + DAY });
    const b = recorder();
    await b.handler.run(later.ctx);
    expect(b.sent[0]!.mail.text).not.toBe(a.sent[0]!.mail.text);
  });

  test("a retry later the same day sends the same mail", async () => {
    // Resend refuses a reused key with another body, so the body may not
    // depend on the minute the retry runs.
    const b = await bed();
    const r = recorder();
    await r.handler.run(b.ctx);
    await r.handler.run({ ...b.ctx, now: NOW + 30 * 60_000 });
    expect(r.sent.length).toBe(2);
    expect(r.sent[1]).toEqual(r.sent[0]!);
  });

  test("the mail links the office's page on the dashboard, where the card is updated", async () => {
    // The dashboard routes on the reserved name, not on the hostname.
    const b = await bed({ officeName: "cp2" });
    // The enabling condition: the two differ, so the link shows which one.
    expect(b.ctx.instance.name).not.toBe("cp2");
    const r = recorder();
    await r.handler.run(b.ctx);
    const links = r.sent[0]!.mail.text.match(/https:\/\/\S+/g) ?? [];
    expect(links.map((l) => l.replace(/[.,;:)]+$/, ""))).toContain(
      `${STOREFRONT_ORIGIN}/office/cp2`,
    );
  });

  test("an office with no reservation still gets its mail, with a link to the dashboard", async () => {
    const b = await bed({ officeName: null });
    const r = recorder();
    const result = await r.handler.run(b.ctx);
    expect(result.kind).toBe("done");
    expect(r.sent.length).toBe(1);
    const links = (r.sent[0]!.mail.text.match(/https:\/\/\S+/g) ?? []).map(
      (l) => l.replace(/[.,;:)]+$/, ""),
    );
    // The enabling condition: the mail has a link at all.
    expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      expect(link.startsWith(STOREFRONT_ORIGIN)).toBe(true);
    expect(links.some((l) => l.includes("/office/"))).toBe(false);
  });

  test("a mail that goes out late names a date at least 14 days away, and records it", async () => {
    // A Resend outage or a missing key held the mail for 20 days. The date the
    // opener fixed is now in the past; the customer must not read it.
    const b = await bed();
    const late = P + 20 * DAY;
    const r = recorder();
    const result = await r.handler.run({ ...b.ctx, now: late });
    expect(result.kind).toBe("done");
    const evidence = (result as { evidence: Record<string, unknown> }).evidence;
    // The deletion reads the named date back from this row (design D2).
    expect(evidence.deletesAt as number).toBeGreaterThanOrEqual(
      late + RETENTION_MS,
    );
    expect(evidence.sentAt).toBe(late);

    const onTime = recorder();
    await onTime.handler.run(b.ctx);
    expect(r.sent[0]!.mail.text).not.toBe(onTime.sent[0]!.mail.text);
  });

  test("a customer who paid in between gets no mail", async () => {
    for (const over of [
      { serviceState: "live" as ServiceState },
      { status: "active" },
      { status: "trialing" },
    ]) {
      const b = await bed(over);
      const r = recorder();
      const result = await r.handler.run(b.ctx);
      expect(result.kind).toBe("done");
      expect(r.sent.length).toBe(0);
      const evidence = (result as { evidence: Record<string, unknown> })
        .evidence;
      // No send instant: the deletion must never count this as a mail that
      // went out.
      expect(evidence.sentAt).toBeUndefined();
      await releaseTestStores();
    }
  });

  test("a failed send is thrown to the ticker, which may retry it", async () => {
    const b = await bed();
    const handler = paymentNoticeHandler({
      send: async () => {
        throw new Error("resend 503");
      },
    });
    expect(handler.timeoutIsRetryable).toBe(true);
    let thrown: unknown = null;
    try {
      await handler.run(b.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain(
      "resend 503",
    );
  });
});

describe("the operator's lever for a held deletion", () => {
  /** The bed plus the dunning power_off the lever reads the episode from, with
   * the mail in `status`. */
  async function held(status: "failed" | "succeeded" | "pending") {
    const b = await bed();
    await b.store.enqueue({
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
        poweredOffAt: P,
      },
    });
    if (status !== "pending") {
      // As the ticker leaves a fatal or done row: the opener's stamp kept.
      await b.store.sqlRun(
        "update operations set status = $1, version = version + 1 where id = $2",
        [status, b.ctx.op.id],
      );
    }
    return b;
  }

  test("a failed mail goes back in the queue and is then sent", async () => {
    const b = await held("failed");
    expect(await requeuePaymentNotice(b.store, "inst-1", "op-nil")).toBe(
      "requeued",
    );
    const row = (await b.store.getOperation(b.ctx.op.id))!;
    expect(row.status).toBe("pending");
    const r = recorder();
    const result = await r.handler.run({ ...b.ctx, op: row });
    expect(result.kind).toBe("done");
    expect(r.sent.length).toBe(1);
    const evidence = (result as { evidence: Record<string, unknown> }).evidence;
    expect(evidence.episode).toBe(EP);
    expect(evidence.deletesAt).toBe(P + RETENTION_MS);
    const audit = await b.store.sqlAll<{ action: string; actor: string }>(
      "select action, actor from audit_events where target = $1",
      [b.ctx.op.id],
    );
    expect(audit.some((a) => a.actor === "op-nil")).toBe(true);
  });

  test("a mail that is pending or was sent is left alone", async () => {
    for (const status of ["pending", "succeeded"] as const) {
      const b = await held(status);
      const before = (await b.store.getOperation(b.ctx.op.id))!;
      expect(await requeuePaymentNotice(b.store, "inst-1", "op-nil")).toBe(
        "not_failed",
      );
      const after = (await b.store.getOperation(b.ctx.op.id))!;
      expect(after.version).toBe(before.version);
      expect(after.status).toBe(status);
      await releaseTestStores();
    }
  });
});
