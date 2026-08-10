// Cancel and un-cancel: the durable key, the transaction that is NOT open
// during the call, and refusing to lie about either half.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requestCancel, requestUncancel } from "./cancel.ts";
import { Store } from "./store.ts";
import { StripeClient, type FetchLike } from "./stripe/client.ts";
import {
  ensureAccount,
  insertSubscription,
  type SubscriptionRow,
} from "./stripe/billing-store.ts";
import { reserveOffice } from "./signup.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2027-06-10T00:00:00Z");
const TEST_KEY = "sk_test_fixture_key_not_real";

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cancel-"));
  temps.push(dir);
  return await Store.open(path.join(dir, "cp.db"), () => NOW);
}

interface Call {
  path: string;
  body: string;
  idempotencyKey: string;
  /** Sampled AT THE MOMENT OF THE CALL: a transaction open here would hold every
   * other writer for as long as Stripe takes to answer. */
  storeInTransaction: boolean;
}

async function bed(over: Partial<SubscriptionRow> = {}) {
  const store = await tempStore();
  const account = await store.tx(
    async () =>
      await ensureAccount(store, { id: "acct-1", email: "buyer@example.test" }),
  );
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "acme",
    plan: "office",
    couponId: null,
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  await store.tx(
    async () =>
      await insertSubscription(store, {
        id: "sub_1",
        account_id: account.id,
        instance_id: instanceId,
        stripe_customer_id: "cus_1",
        status: "active",
        current_period_end: Date.parse("2027-07-10T00:00:00Z"),
        cancel_at_period_end: 0,
        ended_at: null,
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
        ...over,
      }),
  );
  return { store, accountId: account.id, instanceId };
}

function clientRecording(
  calls: Call[],
  store: Store,
  answers: (() => { status: number; body: unknown })[] = [
    () => ({ status: 200, body: { id: "sub_1", cancel_at_period_end: true } }),
  ],
): StripeClient {
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      path: String(url),
      body: typeof init?.body === "string" ? init.body : "",
      idempotencyKey: String(
        (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "",
      ),
      storeInTransaction: store.inTransaction(),
    });
    const answer = answers[Math.min(n++, answers.length - 1)]();
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return new StripeClient({
    key: TEST_KEY,
    fetchImpl,
    sleep: async () => {},
  });
}

describe("the durable key", () => {
  test("it is recorded BEFORE the call, and the wire carries that exact key", async () => {
    const calls: Call[] = [];
    const b = await bed();
    const outcome = await requestCancel(
      b.store,
      clientRecording(calls, b.store),
      {
        accountId: b.accountId,
        instanceId: b.instanceId,
      },
    );
    expect(outcome).toMatchObject({ ok: true, recorded: true });
    expect(calls).toHaveLength(1);
    const started = (await b.store.auditEvents()).find(
      (e) => e.action === "request_cancel" && e.outcome === "started",
    )!;
    expect(started.detail).toBe(calls[0].idempotencyKey);
    expect(calls[0].body).toBe("cancel_at_period_end=true");
    await b.store.close();
  });

  test("NO STORE TRANSACTION IS OPEN while Stripe is being called", async () => {
    const calls: Call[] = [];
    const b = await bed();
    await requestCancel(b.store, clientRecording(calls, b.store), {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(calls[0].storeInTransaction).toBe(false);
    await b.store.close();
  });

  test("cancel, un-cancel, cancel again inside 24h use THREE distinct keys", async () => {
    // The hazard a fixed per-subscription key would create: Stripe replays a key
    // for 24 hours, so the third call would return the FIRST response and report
    // success while Stripe applied nothing.
    const calls: Call[] = [];
    const b = await bed();
    const client = clientRecording(calls, b.store);
    const req = { accountId: b.accountId, instanceId: b.instanceId };

    await requestCancel(b.store, client, req);
    await flip(b.store, 1);
    await requestUncancel(b.store, client, req);
    await flip(b.store, 0);
    await requestCancel(b.store, client, req);

    const keys = calls.map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).not.toBe(keys[0]);
    await b.store.close();
  });

  test("one logical request reuses its key across an ambiguous retry", async () => {
    const calls: Call[] = [];
    const b = await bed();
    // 500 then 200: the client's own retry loop, which is the ONLY same-key
    // retry this module claims.
    const client = clientRecording(calls, b.store, [
      () => ({ status: 500, body: { error: { message: "boom" } } }),
      () => ({ status: 200, body: { id: "sub_1" } }),
    ]);
    const outcome = await requestCancel(b.store, client, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
    await b.store.close();
  });
});

/** Move the cached flag the way a webhook would, so the next verb is legal. */
async function flip(store: Store, to: number): Promise<void> {
  await store.sqlRun(
    "update subscriptions set cancel_at_period_end = ? where id = ?",
    [to, "sub_1"],
  );
}

describe("honest outcomes", () => {
  test("an ambiguous transport says CHECK, not 'it failed'", async () => {
    const calls: Call[] = [];
    const b = await bed();
    const client = clientRecording(calls, b.store, [
      () => ({ status: 500, body: {} }),
    ]);
    const outcome = await requestCancel(b.store, client, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(outcome).toMatchObject({ ok: false, code: "stripe_ambiguous" });
    expect(
      (await b.store.auditEvents()).some(
        (e) => e.action === "request_cancel" && e.outcome === "ambiguous",
      ),
    ).toBe(true);
    await b.store.close();
  });

  test("a refusal Stripe is sure about is recorded as failed", async () => {
    const calls: Call[] = [];
    const b = await bed();
    const client = clientRecording(calls, b.store, [
      () => ({
        status: 400,
        body: { error: { type: "invalid_request_error", message: "no" } },
      }),
    ]);
    const outcome = await requestCancel(b.store, client, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(outcome).toMatchObject({ ok: false, code: "stripe_unavailable" });
    expect(
      (await b.store.auditEvents()).some(
        (e) => e.action === "request_cancel" && e.outcome === "failed",
      ),
    ).toBe(true);
    await b.store.close();
  });

  test("remote success plus a failed local write does NOT report failure", async () => {
    const calls: Call[] = [];
    const b = await bed();
    const client = clientRecording(calls, b.store, [
      () => ({ status: 200, body: { id: "sub_1" } }),
    ]);
    // Break the outcome write only, after the call has gone out.
    const realTx = b.store.tx.bind(b.store);
    let seen = 0;
    b.store.tx = ((fn: () => unknown) => {
      seen++;
      if (seen === 2) throw new Error("disk full");
      return realTx(fn as never);
    }) as unknown as typeof b.store.tx;

    const outcome = await requestCancel(b.store, client, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    // The change reached Stripe. Reporting a failure because OUR log write
    // failed would tell the customer nothing happened when something did.
    expect(outcome).toMatchObject({ ok: true, recorded: false });
    expect(calls).toHaveLength(1);
    b.store.tx = realTx;
    await b.store.close();
  });

  test("nothing here writes subscription state - the webhook still owns it", async () => {
    const calls: Call[] = [];
    const b = await bed();
    await requestCancel(b.store, clientRecording(calls, b.store), {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    const row = (await b.store.sqlGet<{ cancel_at_period_end: number }>(
      "select cancel_at_period_end from subscriptions where id = 'sub_1'",
    ))!;
    expect(row.cancel_at_period_end).toBe(0);
    await b.store.close();
  });
});

describe("refusals", () => {
  const cases: [
    string,
    Partial<SubscriptionRow>,
    "cancel" | "uncancel",
    string,
  ][] = [
    [
      "a subscription already scheduled to end",
      { cancel_at_period_end: 1 },
      "cancel",
      "already_cancelled",
    ],
    [
      "a subscription that is not scheduled to end",
      {},
      "uncancel",
      "not_cancelled",
    ],
    [
      "a subscription that has already ended",
      { ended_at: Date.parse("2027-06-01T00:00:00Z") },
      "cancel",
      "subscription_ended",
    ],
    [
      "reactivating one that has already ended",
      {
        ended_at: Date.parse("2027-06-01T00:00:00Z"),
        cancel_at_period_end: 1,
      },
      "uncancel",
      "subscription_ended",
    ],
  ];

  for (const [label, over, verb, code] of cases) {
    test(`${label} is refused as ${code}, without calling Stripe`, async () => {
      const calls: Call[] = [];
      const b = await bed(over);
      const client = clientRecording(calls, b.store);
      const req = { accountId: b.accountId, instanceId: b.instanceId };
      const outcome =
        verb === "cancel"
          ? await requestCancel(b.store, client, req)
          : await requestUncancel(b.store, client, req);
      expect(outcome).toMatchObject({ ok: false, code });
      expect(calls).toHaveLength(0);
      await b.store.close();
    });
  }

  test("another account's office is not found, and Stripe is never called", async () => {
    const calls: Call[] = [];
    const b = await bed();
    const outcome = await requestCancel(
      b.store,
      clientRecording(calls, b.store),
      {
        accountId: "acct-someone-else",
        instanceId: b.instanceId,
      },
    );
    expect(outcome).toMatchObject({ ok: false, code: "not_yours" });
    expect(calls).toHaveLength(0);
    await b.store.close();
  });

  test("an office with no subscription says so", async () => {
    const calls: Call[] = [];
    const b = await bed();
    await b.store.sqlRun("delete from subscriptions");
    const outcome = await requestCancel(
      b.store,
      clientRecording(calls, b.store),
      {
        accountId: b.accountId,
        instanceId: b.instanceId,
      },
    );
    expect(outcome).toMatchObject({ ok: false, code: "no_subscription" });
    await b.store.close();
  });
});
