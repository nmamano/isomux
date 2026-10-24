// Cancel and un-cancel: the durable key, the transaction that is NOT open
// during the call, and refusing to lie about either half.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CANCEL_REFUSAL_WORDS,
  requestCancel,
  requestUncancel,
} from "./cancel.ts";
import * as facade from "./web/lib/services.server.ts";
import { safeCustomerReason } from "./web/lib/customer-error.ts";
import { translatorFor } from "./web/lib/i18n/translate.ts";
import { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { StripeClient, type FetchLike } from "./stripe/client.ts";
import {
  ensureAccount,
  insertSubscription,
  type SubscriptionRow,
} from "./stripe/billing-store.ts";
import { reserveOffice } from "./signup.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

const NOW = Date.parse("2027-06-10T00:00:00Z");
const TEST_KEY = "sk_test_fixture_key_not_real";

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cancel-"));
  temps.push(dir);
  return await openTestStore(() => NOW);
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
  answers: (() =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>)[] = [
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
    const answer = await answers[Math.min(n++, answers.length - 1)]();
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return new StripeClient({
    key: TEST_KEY,
    mode: "test",
    fetchImpl,
    sleep: async () => {},
  });
}

describe("the durable key", () => {
  // A crash after the call must find the key it used, so the started row is
  // committed BEFORE the call, and no store transaction is held open across
  // it. Nothing here writes subscription state: the webhook still owns it.
  test("it is recorded BEFORE the call, and the wire carries that exact key", async () => {
    const calls: Call[] = [];
    const b = await bed();
    let startedBeforeCall = false;
    const outcome = await requestCancel(
      b.store,
      clientRecording(calls, b.store, [
        async () => {
          startedBeforeCall = (await b.store.auditEvents()).some(
            (e) =>
              e.action === "request_cancel" &&
              e.outcome === "started" &&
              e.detail === calls[0].idempotencyKey,
          );
          return {
            status: 200,
            body: { id: "sub_1", cancel_at_period_end: true },
          };
        },
      ]),
      {
        accountId: b.accountId,
        instanceId: b.instanceId,
      },
    );
    expect(outcome).toMatchObject({ ok: true, recorded: true });
    expect(calls).toHaveLength(1);
    expect(startedBeforeCall).toBe(true);
    expect(calls[0].storeInTransaction).toBe(false);
    expect(calls[0].body).toBe("cancel_at_period_end=true");
    const row = (await b.store.sqlGet<{ cancel_at_period_end: number }>(
      "select cancel_at_period_end from subscriptions where id = 'sub_1'",
    ))!;
    expect(row.cancel_at_period_end).toBe(0);
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
});

/** Move the cached flag the way a webhook would, so the next verb is legal. */
async function flip(store: Store, to: number): Promise<void> {
  await store.sqlRun(
    "update subscriptions set cancel_at_period_end = $1 where id = $2",
    [to, "sub_1"],
  );
}

describe("honest outcomes", () => {
  // An ambiguous transport says CHECK, not "it failed"; only a refusal Stripe
  // is sure about is recorded as failed.
  test.each([
    [500, {}, "stripe_ambiguous", "ambiguous"],
    [
      400,
      { error: { type: "invalid_request_error", message: "no" } },
      "stripe_unavailable",
      "failed",
    ],
  ])("HTTP %d is recorded honestly", async (status, body, code, recorded) => {
    const calls: Call[] = [];
    const b = await bed();
    const client = clientRecording(calls, b.store, [() => ({ status, body })]);
    const outcome = await requestCancel(b.store, client, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "transient", code });
    expect(
      (await b.store.auditEvents()).some(
        (e) => e.action === "request_cancel" && e.outcome === recorded,
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
      expect(outcome).toMatchObject({ ok: false, kind: "customer", code });
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
    expect(outcome).toMatchObject({
      ok: false,
      kind: "customer",
      code: "not_yours",
    });
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
    expect(outcome).toMatchObject({
      ok: false,
      kind: "customer",
      code: "no_subscription",
    });
    await b.store.close();
  });
});

// ---------------------------------------------- the office page's request
//
// The facade's cancel is what /api/cancel calls. A refusal the customer may
// read goes to the page with its code, so the page can word it. A Stripe
// failure is the facade's own translated sentence with a reference, carries no
// code, so the page cannot replace it, and is logged with who it happened to.

describe("the office page's cancel request", () => {
  const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realSetTimeout = globalThis.setTimeout;
  const opened: Store[] = [];

  afterEach(async () => {
    delete (globalThis as { [STORE_SLOT]?: unknown })[STORE_SLOT];
    globalThis.fetch = realFetch;
    console.error = realError;
    globalThis.setTimeout = realSetTimeout;
    delete process.env.CONTROL_PLANE_STRIPE_MODE;
    delete process.env.STRIPE_TEST_SECRET_KEY;
    for (const store of opened.splice(0)) await store.close();
  });

  async function viaFacade(
    over: Partial<SubscriptionRow>,
    stripeStatus: number,
  ) {
    const b = await bed(over);
    opened.push(b.store);
    (globalThis as { [STORE_SLOT]?: { opening?: Promise<Store> } })[
      STORE_SLOT
    ] = { opening: Promise.resolve(b.store) };
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = TEST_KEY;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      );
      return new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "refused" },
        }),
        {
          status: stripeStatus,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    // The facade's Stripe client backs off 0.5 s, then 1 s, between retries of
    // an ambiguous answer; run those at once so the test stays fast.
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        fn,
        ms !== undefined && ms >= 500 ? 0 : ms,
        ...args,
      )) as typeof setTimeout;
    const logged: string[] = [];
    console.error = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    try {
      const result = await facade.requestCancel(
        "es",
        b.accountId,
        b.instanceId,
      );
      return { ...b, result, calls, logged };
    } finally {
      console.error = realError;
      globalThis.setTimeout = realSetTimeout;
    }
  }

  test("a refusal the customer may read carries its code beside its sentence, and logs nothing", async () => {
    const b = await viaFacade({ cancel_at_period_end: 1 }, 400);
    expect(b.calls).toEqual([]);
    expect(b.result).toEqual({
      ok: false,
      code: "already_cancelled",
      reason: safeCustomerReason("es", CANCEL_REFUSAL_WORDS.already_cancelled, {
        accountId: b.accountId,
      }),
    });
    expect(b.logged.filter((l) => l.includes("customer-error"))).toEqual([]);
  });

  // Each Stripe failure picks its own sentence: an ambiguous one tells the
  // customer to check before retrying, because the change may have applied.
  for (const [label, stripeStatus, calls, key] of [
    ["a refusal Stripe is sure about", 400, 1, "errors.providerTransient"],
    ["an ambiguous Stripe answer", 500, 3, "errors.billingChangeAmbiguous"],
  ] as const) {
    test(`${label} is the facade's translated sentence with a reference, no code, and a log line with the account and instance`, async () => {
      const b = await viaFacade({}, stripeStatus);
      // Stripe was called, so this is the Stripe branch.
      expect(b.calls).toHaveLength(calls);
      expect(b.result.ok).toBe(false);
      if (b.result.ok) return;
      expect(Object.keys(b.result).sort()).toEqual(["ok", "reason"]);
      expect(b.result.reason).toStartWith(`${translatorFor("es").t(key)} `);
      const reference = /PAY-[0-9A-F]{10}/.exec(b.result.reason)?.[0];
      expect(reference).toBeDefined();
      const line = b.logged.find((l) => l.includes(reference!));
      expect(line).toBeDefined();
      expect(line).toContain(`account=${b.accountId}`);
      expect(line).toContain(`instance=${b.instanceId}`);
    });
  }
});
